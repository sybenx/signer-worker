// The claim: one permanent action, over HTTP, plus the OWNER_CREDS
// alternative that disables it. Never a credential in a response.
import { SELF, createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { readEchoEvent, LEGACY_RPC_KIND } from "../src/echo.ts";
import { encodeGroupPackage, encodeSharePackage, getPubkey } from "../src/frost.ts";
import { verifySignature, type NostrEvent } from "../src/nostr.ts";
import { signerStub } from "../src/signer-stub.ts";
import { generateDealerPackage } from "./helpers/group.ts";
import { isolateStorage } from "./helpers/isolate.ts";

isolateStorage();

function fixture() {
  const { group, shares } = generateDealerPackage(2, 3);
  return { group, share: shares[0]!, groupStr: encodeGroupPackage(group), shareStr: encodeSharePackage(shares[0]!) };
}

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/claim", () => {
  it("holds a share the first time, answers with the share's pubkey and an echo, and never again", async () => {
    const { share, groupStr, shareStr } = fixture();
    const res = await post("/api/claim", { group: groupStr, share: shareStr, profile: { name: "Alice", picture: "https://example.com/a.png" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sharePubkey: string; echo: NostrEvent };
    expect(body.sharePubkey).toBe(getPubkey(share.seckey, "bip340"));

    // The echo igloo-core listens for: kind 20004, self-addressed, and
    // decrypts to ["/echo/req", id, challenge].
    expect(body.echo.kind).toBe(LEGACY_RPC_KIND);
    expect(body.echo.pubkey).toBe(body.sharePubkey);
    expect(body.echo.tags).toEqual([["p", body.sharePubkey]]);
    expect(verifySignature(body.echo)).toBe(true);
    const envelope = readEchoEvent(share.seckey, body.echo);
    expect(envelope?.[0]).toBe("/echo/req");
    expect(envelope?.[2]).toMatch(/^[0-9a-f]+$/);

    const again = await post("/api/claim", { group: groupStr, share: shareStr });
    expect(again.status).toBe(409);
    const other = fixture();
    expect((await post("/api/claim", { group: other.groupStr, share: other.shareStr })).status).toBe(409);
  });

  it("refuses a share that does not belong to the group, naming the check", async () => {
    const a = fixture();
    const b = fixture();
    const res = await post("/api/claim", { group: a.groupStr, share: b.shareStr });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/does not belong/);
    // Nothing was held.
    const status = (await (await SELF.fetch("https://example.com/api/status")).json()) as { claimed: boolean };
    expect(status.claimed).toBe(false);
  });

  it("refuses malformed input before reaching anything", async () => {
    expect((await post("/api/claim", "not json")).status).toBe(400);
    expect((await post("/api/claim", { group: 1 })).status).toBe(400);
    expect((await post("/api/claim", { group: "bfgroup1zzz", share: "bfshare1zzz" })).status).toBe(400);
    expect((await SELF.fetch("https://example.com/api/claim")).status).toBe(405);
  });
});

describe("GET /api/status", () => {
  it("offers pairing while unclaimed, then shows the group and never a credential", async () => {
    const before = (await (await SELF.fetch("https://example.com/api/status")).json()) as Record<string, unknown>;
    expect(before.claimed).toBe(false);
    expect(before.pairing).toMatchObject({ bounceHost: "example.com", origin: "https://example.com" });
    expect((before.pairing as { relays: string[] }).relays.length).toBeGreaterThan(0);

    const { group, share, groupStr, shareStr } = fixture();
    await post("/api/claim", { group: groupStr, share: shareStr, profile: { name: "Alice" } });

    const res = await SELF.fetch("https://example.com/api/status");
    const text = await res.text();
    expect(text).not.toContain("bfshare1");
    expect(text).not.toContain("bfgroup1");
    expect(text).not.toContain(share.seckey);
    const status = JSON.parse(text) as Record<string, unknown>;
    expect(status.claimed).toBe(true);
    expect(status.source).toBe("claim");
    expect(status.pairing).toBeUndefined();
    expect(status.group).toMatchObject({ name: "Alice", picture: null, threshold: 2, members: 3, pubkey: group.group_pk.slice(2) });
    expect(status.share).toEqual({ index: 1, pubkey: getPubkey(share.seckey, "bip340") });
    expect(typeof status.claimedAt).toBe("number");
    expect(typeof status.version).toBe("string");
  });
});

describe("OWNER_CREDS", () => {
  it("disables the claim endpoint, hides pairing, and the object reads the environment", async () => {
    const { groupStr, shareStr, share } = fixture();
    const configured = { ...env, OWNER_CREDS: `${groupStr} ${shareStr}` } as Env;

    const ctx = createExecutionContext();
    const claim = await worker.fetch(
      new Request("https://example.com/api/claim", { method: "POST", body: JSON.stringify({ group: groupStr, share: shareStr }) }),
      configured,
    );
    await waitOnExecutionContext(ctx);
    expect(claim.status).toBe(404);

    const status = await worker.fetch(new Request("https://example.com/api/status"), configured);
    const body = (await status.json()) as Record<string, unknown>;
    // The Worker passed the configured env to itself, but the object was
    // constructed with the test env, so its own view is exercised directly.
    expect(body.pairing).toBeNull();

    await runInDurableObject(signerStub(env), (instance) => {
      (instance as unknown as { env: Env }).env = configured;
      const s = instance.getStatus();
      expect(s.claimed).toBe(true);
      expect(s.source).toBe("env");
      expect(s.share?.pubkey).toBe(getPubkey(share.seckey, "bip340"));
      expect(s.group?.name).toBeNull();
      expect(instance.claim(groupStr, shareStr, undefined, "example.com")).toEqual({ status: "disabled" });
    });
  });

  it("treats a value that does not decode as unset for holding, but still closes the claim door", async () => {
    const configured = { ...env, OWNER_CREDS: "bfgroup1nonsense bfshare1nonsense" } as Env;
    const claim = await worker.fetch(
      new Request("https://example.com/api/claim", { method: "POST", body: "{}" }),
      configured,
    );
    expect(claim.status).toBe(404);
    await runInDurableObject(signerStub(env), (instance) => {
      (instance as unknown as { env: Env }).env = configured;
      expect(instance.getStatus().claimed).toBe(false);
    });
  });
});
