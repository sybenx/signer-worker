// Peer policy, set only by a NIP-98 call signed by the group key, and
// what a blocked peer sees.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { derive_shares_secret } from "@vbyte/frost/lib";
import { HTTP_AUTH_KIND, MANAGEMENT_CONTENT_TYPE } from "../src/nip98.ts";
import { signEvent } from "../src/nostr.ts";
import { MANAGEMENT_METHODS } from "../src/signer.ts";
import { isolateStorage } from "./helpers/isolate.ts";
import { Peer, claim, fixture, type Fixture } from "./helpers/peer.ts";

isolateStorage();

const URL_ = "https://example.com/";

// The group's own secret, reconstructed from a threshold of shares -- the
// thing no single device holds, and the thing a real deployment produces
// a threshold signature with instead. Signing plainly with it here is
// indistinguishable on the wire.
function groupSecret(fx: Fixture): string {
  return derive_shares_secret(fx.shares.slice(0, fx.group.threshold));
}

function authHeader(secret: string, body: string, opts: { url?: string; createdAt?: number } = {}): string {
  const event = signEvent(secret, {
    kind: HTTP_AUTH_KIND,
    tags: [
      ["u", opts.url ?? URL_],
      ["method", "POST"],
      ["payload", bytesToHex(sha256(new TextEncoder().encode(body)))],
    ],
    ...(opts.createdAt === undefined ? {} : { created_at: opts.createdAt }),
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

async function manage(secret: string | null, method: string, params: unknown[] = []): Promise<{ status: number; result?: unknown; error?: string }> {
  const body = JSON.stringify({ method, params });
  const headers: Record<string, string> = { "Content-Type": MANAGEMENT_CONTENT_TYPE, "CF-Connecting-IP": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (secret !== null) headers.Authorization = authHeader(secret, body);
  const res = await SELF.fetch(new Request(URL_, { method: "POST", headers, body }));
  const text = new TextDecoder().decode(await res.arrayBuffer());
  return { status: res.status, ...(JSON.parse(text) as { result?: unknown; error?: string }) };
}

describe("management by the group key", () => {
  it("lists its methods and sets, reads back, and removes a peer policy", async () => {
    const fx = fixture();
    await claim(fx);
    const secret = groupSecret(fx);
    const peerPk = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey).pubkey;

    const methods = await manage(secret, "supportedmethods");
    expect(methods.result).toEqual([...MANAGEMENT_METHODS]);

    const set = await manage(secret, "setpeerpolicy", [{ pubkey: peerPk, allowReceive: false, label: "laptop" }]);
    expect(set.status).toBe(200);
    expect(set.result).toEqual({ pubkey: peerPk, allowSend: true, allowReceive: false, label: "laptop" });

    const list = await manage(secret, "listpeerpolicies");
    expect(list.result).toEqual([{ pubkey: peerPk, allowReceive: false, label: "laptop" }]);

    // All defaults persists nothing: a removal.
    const reset = await manage(secret, "setpeerpolicy", [{ pubkey: peerPk, allowReceive: true }]);
    expect(reset.result).toEqual({ pubkey: peerPk, allowSend: true, allowReceive: true });
    expect((await manage(secret, "listpeerpolicies")).result).toEqual([]);

    await manage(secret, "setpeerpolicy", [{ pubkey: peerPk, allowSend: false }]);
    const removed = await manage(secret, "removepeerpolicy", [peerPk]);
    expect(removed.result).toEqual({ pubkey: peerPk, allowSend: true, allowReceive: true });
  });

  it("refuses a non-member pubkey, its own share, a malformed record, and an unknown method", async () => {
    const fx = fixture();
    await claim(fx);
    const secret = groupSecret(fx);
    expect((await manage(secret, "setpeerpolicy", [{ pubkey: "ab".repeat(32), allowReceive: false }])).error).toMatch(/not a member/);
    expect((await manage(secret, "setpeerpolicy", [{ pubkey: fx.signerPubkey, allowReceive: false }])).error).toMatch(/own share/);
    expect((await manage(secret, "setpeerpolicy", [{ pubkey: "nope" }])).error).toMatch(/64-char hex/);
    expect((await manage(secret, "setpeerpolicy", [{ pubkey: fx.signerPubkey, allowReceive: "no" }])).error).toMatch(/booleans/);
    expect((await manage(secret, "changerelayname", ["x"])).error).toMatch(/supportedmethods lists/);
  });

  it("refuses a call signed by a member's share key, an unsigned call, and a call before a claim", async () => {
    const fx = fixture();
    const before = await manage(groupSecret(fx), "supportedmethods");
    expect(before.status).toBe(401);
    expect(before.error).toMatch(/no share is held here yet/);

    await claim(fx);
    const member = await manage(fx.shares[1]!.seckey, "supportedmethods");
    expect(member.status).toBe(401);
    expect(member.error).toMatch(/not signed by the group key/);

    const unsigned = await manage(null, "supportedmethods");
    expect(unsigned.status).toBe(401);
    expect(unsigned.error).toMatch(/Authorization header/);

    const stale = JSON.stringify({ method: "supportedmethods", params: [] });
    const res = await SELF.fetch(
      new Request(URL_, {
        method: "POST",
        headers: { "Content-Type": MANAGEMENT_CONTENT_TYPE, Authorization: authHeader(groupSecret(fx), stale, { createdAt: Math.floor(Date.now() / 1000) - 600 }) },
        body: stale,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("a peer with allowReceive false is refused on the wire with the reason, and readmitted when the policy goes", async () => {
    const fx = fixture();
    await claim(fx);
    const secret = groupSecret(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect();
    await manage(secret, "setpeerpolicy", [{ pubkey: peer.pubkey, allowReceive: false }]);
    const blocked = await peer.request("ping", [JSON.stringify({ version: 2 })]);
    expect(blocked.ok[2]).toBe(false);
    expect(blocked.ok[3]).toMatch(/^blocked: /);

    // allowSend false is reported in the ping response's policy, and
    // does not refuse the request.
    await manage(secret, "setpeerpolicy", [{ pubkey: peer.pubkey, allowSend: false }]);
    const allowed = await peer.request("ping", [JSON.stringify({ version: 2 })]);
    expect(allowed.ok[2]).toBe(true);
    expect((allowed.response as { data: { policy: unknown } }).data.policy).toEqual({ send: false, recv: true });

    // The status document shows what is in force, and never the reason
    // in more words than that.
    const status = (await (await SELF.fetch("https://example.com/api/status")).json()) as { peers: Array<{ pubkey: string; policy: unknown }> };
    expect(status.peers.find((p) => p.pubkey === peer.pubkey)?.policy).toEqual({ allowSend: false, allowReceive: true });
    peer.close();
  });
});
