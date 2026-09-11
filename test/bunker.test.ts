// The NIP-46 bunker: an app connects with the secret, asks for a
// signature, and the Worker gets it by asking the group's other devices
// over their own subscriptions on this relay.
import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { derive_shares_secret } from "@vbyte/frost/lib";
import { NIP46_KIND } from "../src/nip46.ts";
import { HTTP_AUTH_KIND, MANAGEMENT_CONTENT_TYPE } from "../src/nip98.ts";
import { signEvent, verifySignature, type NostrEvent } from "../src/nostr.ts";
import { signerStub } from "../src/signer-stub.ts";
import { nip44Decrypt } from "../src/wire.ts";
import { isolateStorage } from "./helpers/isolate.ts";
import { Client, handOverNonces, servePeer } from "./helpers/nip46.ts";
import { Peer, claim, fixture, type Fixture } from "./helpers/peer.ts";

isolateStorage();

async function claimed(): Promise<{ fx: Fixture; bunker: { pubkey: string; secret: string } }> {
  const fx = fixture();
  const res = await SELF.fetch("https://example.com/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: fx.groupStr, share: fx.shareStr }),
  });
  const body = (await res.json()) as { bunker: { pubkey: string; secret: string } };
  return { fx, bunker: body.bunker };
}

async function servingPeer(fx: Fixture, idx = 1): Promise<{ peer: Peer; served: ReturnType<typeof servePeer> }> {
  const peer = new Peer(fx.group, fx.shares[idx]!, fx.signerPubkey);
  await peer.connect();
  await handOverNonces(peer);
  return { peer, served: servePeer(peer) };
}

function manageHeader(fx: Fixture, body: string): string {
  const secret = derive_shares_secret(fx.shares.slice(0, fx.group.threshold));
  const event = signEvent(secret, {
    kind: HTTP_AUTH_KIND,
    tags: [["u", "https://example.com/"], ["method", "POST"], ["payload", bytesToHex(sha256(new TextEncoder().encode(body)))]],
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

async function manage(fx: Fixture, method: string, params: unknown[] = []): Promise<{ result?: unknown; error?: string }> {
  const body = JSON.stringify({ method, params });
  const res = await SELF.fetch(
    new Request("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": MANAGEMENT_CONTENT_TYPE, Authorization: manageHeader(fx, body), "CF-Connecting-IP": `10.1.${Math.floor(Math.random() * 250)}.1` },
      body,
    }),
  );
  return JSON.parse(new TextDecoder().decode(await res.arrayBuffer())) as { result?: unknown; error?: string };
}

describe("connect", () => {
  it("needs the secret once, then answers without it, and keeps the secret out of the status document", async () => {
    const { fx, bunker } = await claimed();
    expect(bunker.secret).toMatch(/^[0-9a-f]{64}$/);
    const status = await (await SELF.fetch("https://example.com/api/status")).text();
    expect(status).toContain(bunker.pubkey);
    expect(status).not.toContain(bunker.secret);

    const app = new Client(bunker.pubkey);
    await app.connect();
    const wrong = await app.call("connect", [bunker.pubkey, "not-the-secret"]);
    expect(wrong.response?.error).toMatch(/secret/);
    const before = await app.call("get_public_key", []);
    expect(before.response?.error).toMatch(/connect/);

    const right = await app.call("connect", [bunker.pubkey, bunker.secret, "sign_event:1,nip44_encrypt"]);
    expect(right.response).toEqual({ id: expect.any(String), result: bunker.secret });
    const pk = await app.call("get_public_key", []);
    expect(pk.response?.result).toBe(fx.group.group_pk.slice(2));
    expect((await app.call("ping", [])).response?.result).toBe("pong");
    // Reconnecting an app that is known needs no secret.
    expect((await app.call("connect", [bunker.pubkey])).response?.result).toBe("ack");

    const sessions = (await manage(fx, "listsessions")).result as Array<{ pubkey: string; policy: unknown }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ pubkey: app.pubkey, policy: { methods: { sign_event: true, nip44_encrypt: true }, kinds: { "1": true } } });
    app.close();
  });

  it("refuses a request that is not addressed to the bunker, or that no subscription could answer", async () => {
    const { bunker } = await claimed();
    const app = new Client(bunker.pubkey);
    app.conn = await (await import("./helpers/socket.ts")).connectRelay();
    const r = await app.call("ping", []);
    expect(r.ok[2]).toBe(false);
    expect(r.ok[3]).toMatch(/open a subscription/);
    app.close();
  });
});

describe("sign_event", () => {
  it("returns an event signed by the group key, made from this share and a connected device's", async () => {
    const { fx, bunker } = await claimed();
    const { peer, served } = await servingPeer(fx);
    const app = new Client(bunker.pubkey);
    await app.connect();
    await app.call("connect", [bunker.pubkey, bunker.secret]);

    const template = { kind: 1, content: "hello from the bunker", tags: [["t", "frostr"]], created_at: 1_800_000_000 };
    const { response } = await app.call("sign_event", [JSON.stringify(template)]);
    expect(response?.error).toBeUndefined();
    const signed = JSON.parse(response!.result!) as NostrEvent;
    expect(signed.pubkey).toBe(fx.group.group_pk.slice(2));
    expect(signed.kind).toBe(1);
    expect(signed.content).toBe(template.content);
    expect(signed.tags).toEqual(template.tags);
    expect(verifySignature(signed)).toBe(true);
    expect(served.served.map((m) => m.method)).toEqual(["sign"]);

    // The page's one-line record and the round's row are gone.
    const status = (await (await SELF.fetch("https://example.com/api/status")).json()) as { bunker: { lastRequest: { method: string; ok: boolean } } };
    expect(status.bunker.lastRequest).toMatchObject({ method: "sign_event", ok: true });
    served.stop();
    peer.close();
    app.close();
  });

  it("says which device is missing when the group cannot be reached, and honours the policy by kind", async () => {
    const { fx, bunker } = await claimed();
    const app = new Client(bunker.pubkey);
    await app.connect();
    await app.call("connect", [bunker.pubkey, bunker.secret]);
    const alone = await app.call("sign_event", [JSON.stringify({ kind: 1, content: "x" })]);
    expect(alone.response?.error).toMatch(/none of your other devices is connected/);

    const { peer, served } = await servingPeer(fx);
    expect((await manage(fx, "setbunkerpolicy", [{ methods: { sign_event: true, get_public_key: true }, kinds: { "1": true } }])).result).toBeDefined();
    const refused = await app.call("sign_event", [JSON.stringify({ kind: 7, content: "+" })]);
    expect(refused.response?.error).toMatch(/policy: sign_event for kind 7/);
    const okay = await app.call("sign_event", [JSON.stringify({ kind: 1, content: "fine" })]);
    expect(okay.response?.result).toBeDefined();
    expect((await app.call("nip44_encrypt", [app.pubkey, "x"])).response?.error).toMatch(/policy/);
    served.stop();
    peer.close();
    app.close();
  });

  it("times out a round nobody answers, through the alarm", async () => {
    const { fx, bunker } = await claimed();
    // A peer that is connected and has handed over nonces, but never answers.
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect();
    await handOverNonces(peer);
    const app = new Client(bunker.pubkey);
    await app.connect();
    await app.call("connect", [bunker.pubkey, bunker.secret]);
    const pending = app.call("sign_event", [JSON.stringify({ kind: 1, content: "x" })]);
    // Let the request go out, then fire the alarm the round scheduled.
    await new Promise((r) => setTimeout(r, 200));
    expect(await runDurableObjectAlarm(signerStub(env))).toBe(true);
    // The alarm fired before expiry, so the round is still open; a second
    // fire after expiry ends it. Simulated by moving the round's clock.
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(signerStub(env), (_i, state) => {
      state.storage.sql.exec("UPDATE pending SET expires_at = 0");
    });
    await runInDurableObject(signerStub(env), async (instance) => {
      await instance.alarm();
    });
    const { response } = await pending;
    expect(response?.error).toMatch(/did not answer in time/);
    peer.close();
    app.close();
  });
});

describe("nip44_encrypt and nip44_decrypt", () => {
  it("encrypt to a third party under the whole key's ECDH, and decrypt it back", async () => {
    const { fx, bunker } = await claimed();
    const { peer, served } = await servingPeer(fx);
    const app = new Client(bunker.pubkey);
    await app.connect();
    await app.call("connect", [bunker.pubkey, bunker.secret]);

    const third = bytesToHex(schnorr.keygen().secretKey);
    const thirdPub = bytesToHex(schnorr.getPublicKey(hexToBytes(third)));
    const { response } = await app.call("nip44_encrypt", [thirdPub, "a message for the third party"]);
    expect(response?.error).toBeUndefined();
    const ciphertext = response!.result!;

    // The third party decrypts with a plain ECDH against the group key.
    const shared = secp256k1.getSharedSecret(hexToBytes(third), hexToBytes(`02${fx.group.group_pk.slice(2)}`), true).slice(1);
    expect(nip44Decrypt(shared, ciphertext)).toBe("a message for the third party");

    const back = await app.call("nip44_decrypt", [thirdPub, ciphertext]);
    expect(back.response?.result).toBe("a message for the third party");
    expect(served.served.map((m) => m.method)).toEqual(["ecdh", "ecdh"]);
    served.stop();
    peer.close();
    app.close();
  });
});

describe("management of the bunker", () => {
  it("shows and rotates the secret, revokes a session, and reports through status", async () => {
    const { fx, bunker } = await claimed();
    const shown = (await manage(fx, "getbunker")).result as { pubkey: string; secret: string };
    expect(shown).toMatchObject({ pubkey: bunker.pubkey, secret: bunker.secret });

    const app = new Client(bunker.pubkey);
    await app.connect();
    await app.call("connect", [bunker.pubkey, bunker.secret]);
    const rotated = (await manage(fx, "rotatebunkersecret")).result as { secret: string };
    expect(rotated.secret).not.toBe(bunker.secret);
    // Still connected after rotation.
    expect((await app.call("ping", [])).response?.result).toBe("pong");
    expect((await app.call("get_public_key", [])).response?.result).toBeDefined();

    expect((await manage(fx, "revokesession", [app.pubkey])).result).toEqual({ pubkey: app.pubkey, connected: false });
    expect((await app.call("get_public_key", [])).response?.error).toMatch(/connect/);
    // The old secret no longer connects; the new one does.
    expect((await app.call("connect", [bunker.pubkey, bunker.secret])).response?.error).toMatch(/secret/);
    expect((await app.call("connect", [bunker.pubkey, rotated.secret])).response?.result).toBe(rotated.secret);

    expect((await manage(fx, "setsessionpolicy", [app.pubkey, { methods: { nip44_encrypt: false } }])).result).toBeDefined();
    expect((await app.call("nip44_encrypt", [app.pubkey, "x"])).response?.error).toMatch(/policy/);
    // The key's public half is never behind a session's own policy.
    expect((await app.call("get_public_key", [])).response?.result).toBeDefined();
    expect((await manage(fx, "setsessionpolicy", ["ab".repeat(32), null])).error).toMatch(/no app/);
    app.close();
  });

  it("keeps the relay's REQ gate open to app subscriptions and bunker events", async () => {
    const { bunker } = await claimed();
    const app = new Client(bunker.pubkey);
    await app.connect();
    app.conn.send(["REQ", "b", { authors: [bunker.pubkey], kinds: [NIP46_KIND] }]);
    expect((await app.conn.nextMessage())[0]).toBe("EOSE");
    app.close();
  });
});
