// The rows-written baseline for the nonce pool (docs/budget.md "Rows
// written: the nonce pool"), pinned against SqlStorageCursor.rowsWritten
// on the real table, and the daily cap. Also the hibernation property:
// the object survives eviction with its sockets and their subscriptions.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MAX_NONCE_ROWS_PER_DAY, NONCE_POOL_SIZE, NONCE_REPLENISH_COUNT, maxNonceRowsPerDay } from "../src/limits.ts";
import { NONCE_ROW_COST, generateForPeer, nonceRowsToday, outgoingCount, storeIncoming, takeOutgoing } from "../src/pool.ts";
import { signerStub } from "../src/signer-stub.ts";
import { generateNoncePairs } from "../src/frost.ts";
import { buildSession } from "./helpers/group.ts";
import { isolateStorage } from "./helpers/isolate.ts";
import { Peer, claim, fixture } from "./helpers/peer.ts";
import type { Signer } from "../src/signer.ts";

isolateStorage();

// Sums SqlStorageCursor.rowsWritten across every statement `fn` issues
// (bothy's helper). INSERT/DELETE cursors carry a final rowsWritten
// immediately.
function measureRowsWritten(sql: SqlStorage, fn: (sql: SqlStorage) => void): number {
  let total = 0;
  const proxy = new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return (query: string, ...bindings: unknown[]) => {
          const cursor = target.exec(query, ...bindings);
          total += cursor.rowsWritten;
          return cursor;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as SqlStorage;
  fn(proxy);
  return total;
}

const NOW = 1_800_000_000;

describe("rows written by the nonce pool", () => {
  it("costs NONCE_ROW_COST per nonce handed out, plus one counter row per call", async () => {
    const fx = fixture();
    await claim(fx);
    await runInDurableObject(signerStub(env), (_instance: Signer, state) => {
      const one = measureRowsWritten(state.storage.sql, (sql) => {
        expect(generateForPeer(sql, fx.signerShare.seckey, 2, 1, NOW, null)).toHaveLength(1);
      });
      // The nonce row and the counters row.
      expect(one).toBe(NONCE_ROW_COST + 1);
      const fifty = measureRowsWritten(state.storage.sql, (sql) => {
        expect(generateForPeer(sql, fx.signerShare.seckey, 3, NONCE_REPLENISH_COUNT, NOW, null)).toHaveLength(NONCE_REPLENISH_COUNT);
      });
      expect(fifty).toBe(NONCE_REPLENISH_COUNT * NONCE_ROW_COST + 1);
      expect(nonceRowsToday(state.storage.sql, NOW)).toBe((1 + NONCE_REPLENISH_COUNT) * NONCE_ROW_COST);
    });
  });

  it("costs NONCE_ROW_COST to spend one, plus the counter row, and the code is gone afterwards", async () => {
    const fx = fixture();
    await claim(fx);
    await runInDurableObject(signerStub(env), (_instance: Signer, state) => {
      const sql = state.storage.sql;
      const [nonce] = generateForPeer(sql, fx.signerShare.seckey, 2, 1, NOW, null);
      const spend = measureRowsWritten(sql, (s) => {
        expect(takeOutgoing(s, fx.signerShare.seckey, 2, { ...nonce!, idx: 1 }, NOW)).not.toBeNull();
      });
      expect(spend).toBe(NONCE_ROW_COST + 1);
      expect(outgoingCount(sql, 2)).toBe(0);
      expect(takeOutgoing(sql, fx.signerShare.seckey, 2, { ...nonce!, idx: 1 }, NOW)).toBeNull();
      // A code issued to peer 2 cannot be spent by peer 3.
      const [other] = generateForPeer(sql, fx.signerShare.seckey, 2, 1, NOW, null);
      expect(takeOutgoing(sql, fx.signerShare.seckey, 3, { ...other!, idx: 1 }, NOW)).toBeNull();
      expect(outgoingCount(sql, 2)).toBe(1);
    });
  });

  it("never exceeds the pool size per peer, and dedupes incoming by code", async () => {
    const fx = fixture();
    await claim(fx);
    await runInDurableObject(signerStub(env), (_instance: Signer, state) => {
      const sql = state.storage.sql;
      expect(generateForPeer(sql, fx.signerShare.seckey, 2, NONCE_POOL_SIZE + 50, NOW, null)).toHaveLength(NONCE_POOL_SIZE);
      expect(generateForPeer(sql, fx.signerShare.seckey, 2, 1, NOW, null)).toHaveLength(0);
      const theirs = generateNoncePairs(fx.shares[1]!.seckey, 10);
      expect(storeIncoming(sql, 2, theirs, NOW, null)).toBe(10);
      expect(storeIncoming(sql, 2, theirs, NOW, null)).toBe(0);
    });
  });

  it("stops handing out nonces at the daily cap, and the cap is the default unless the env says otherwise", async () => {
    const fx = fixture();
    await claim(fx);
    expect(maxNonceRowsPerDay({} as Env)).toBe(MAX_NONCE_ROWS_PER_DAY);
    expect(maxNonceRowsPerDay({ MAX_NONCE_ROWS_PER_DAY: "off" } as Env)).toBeNull();
    expect(maxNonceRowsPerDay({ MAX_NONCE_ROWS_PER_DAY: "nonsense" } as Env)).toBe(MAX_NONCE_ROWS_PER_DAY);
    expect(maxNonceRowsPerDay({ MAX_NONCE_ROWS_PER_DAY: "10" } as Env)).toBe(10);
    await runInDurableObject(signerStub(env), (_instance: Signer, state) => {
      const sql = state.storage.sql;
      const cap = 30 * NONCE_ROW_COST;
      expect(generateForPeer(sql, fx.signerShare.seckey, 2, NONCE_REPLENISH_COUNT, NOW, cap)).toHaveLength(30);
      expect(generateForPeer(sql, fx.signerShare.seckey, 3, NONCE_REPLENISH_COUNT, NOW, cap)).toHaveLength(0);
      // A spend is never refused for budget.
      const [nonce] = sql.exec<{ code: string; binder_pn: string; hidden_pn: string }>("SELECT code, binder_pn, hidden_pn FROM nonces WHERE peer_idx = 2 LIMIT 1").toArray();
      expect(takeOutgoing(sql, fx.signerShare.seckey, 2, { ...nonce!, idx: 1 }, NOW)).not.toBeNull();
      // Tomorrow, the allowance is back.
      expect(generateForPeer(sql, fx.signerShare.seckey, 3, 5, NOW + 86_400, cap)).toHaveLength(5);
    });
  });
});

describe("hibernation", () => {
  it("survives eviction with the socket and its subscription intact, and still signs", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect();
    const first = await peer.request("ping", [JSON.stringify({ version: 2 })]);
    const nonces = (first.response as { data: { nonces: Array<{ code: string; binder_pn: string; hidden_pn: string }> } }).data.nonces;

    await runInDurableObject(signerStub(env), (_instance: Signer, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
    });
    // Default eviction hibernates rather than closes accepted sockets.
    await evictDurableObject(signerStub(env));
    await runInDurableObject(signerStub(env), (_instance: Signer, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
    });

    // The subscription came back from the attachment: a response after
    // the wake still has somewhere to go, and the pool came back from
    // SQLite: the nonce handed out before the wake still spends.
    const sighash = bytesToHex(sha256(new TextEncoder().encode("after wake")));
    const { session } = buildSession(fx.group, peer.share, fx.signerShare.idx, nonces[0]!, [[sighash]]);
    const { ok, response } = await peer.request("sign", [JSON.stringify(session)]);
    expect(ok[2]).toBe(true);
    expect(response?.type).toBe("accept");
    peer.close();
  });
});
