// The five handlers, driven by a bifrost-shaped peer over the relay.
import { describe, expect, it } from "vitest";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { create_ecdh_share, derive_ecdh_secret, derive_shares_secret } from "@vbyte/frost/lib";
import {
  combineSignaturePkgs,
  createPsigPkg,
  generateNoncePairs,
  getPubkey,
  getSessionCtx,
  verifyPsigPkg,
  xOnly,
  type DerivedPublicNonce,
  type PartialSigPackage,
} from "../src/frost.ts";
import { NONCE_POOL_SIZE, NONCE_REPLENISH_COUNT } from "../src/limits.ts";
import { buildSession } from "./helpers/group.ts";
import { isolateStorage } from "./helpers/isolate.ts";
import { Peer, claim, fixture, type Fixture } from "./helpers/peer.ts";

isolateStorage();

interface PingResponse {
  policy: { send: boolean; recv: boolean };
  pool_status: Array<{ peer_idx: number; available: number }>;
  nonces?: DerivedPublicNonce[];
}

async function pingFor(peer: Peer): Promise<PingResponse> {
  const { ok, response } = await peer.request("ping", [JSON.stringify({ version: 2 })]);
  expect(ok[2]).toBe(true);
  expect(response?.type).toBe("accept");
  return (response as { data: PingResponse }).data;
}

async function connected(fx: Fixture, shareIdx = 1): Promise<Peer> {
  const peer = new Peer(fx.group, fx.shares[shareIdx]!, fx.signerPubkey);
  await peer.connect();
  return peer;
}

describe("/ping", () => {
  it("answers with the peer's policy, pool status, and a first package of nonces", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const first = await pingFor(peer);
    expect(first.policy).toEqual({ send: true, recv: true });
    expect(first.pool_status.map((s) => s.peer_idx).sort()).toEqual([2, 3]);
    expect(first.nonces).toHaveLength(NONCE_REPLENISH_COUNT);
    // The legacy "ping" string is a version-1 ping.
    const legacy = await peer.request("ping", ["ping"]);
    expect(legacy.response?.type).toBe("accept");
    // A second ping finds the pool full enough and hands out nothing.
    const second = await pingFor(peer);
    expect(second.nonces).toBeUndefined();
    peer.close();
  });

  it("stores the nonces a peer hands over, capped at the pool size, and reports them", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const theirs = generateNoncePairs(peer.share.seckey, NONCE_POOL_SIZE + 10);
    await pingFor(peer);
    const after = await peer.request("ping", [JSON.stringify({ version: 2, nonces: theirs })]);
    const data = (after.response as { data: PingResponse }).data;
    const mine = data.pool_status.find((s) => s.peer_idx === peer.share.idx);
    expect(mine?.available).toBe(NONCE_POOL_SIZE);
    peer.close();
  });
});

describe("/sign", () => {
  it("produces a partial signature that combines into a valid group signature, and spends the nonce", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const { nonces } = await pingFor(peer);
    const sighash = bytesToHex(sha256(new TextEncoder().encode("sign me")));
    const { session, ourSecret } = buildSession(fx.group, peer.share, fx.signerShare.idx, nonces![0]!, [[sighash]]);

    const { ok, response } = await peer.request("sign", [JSON.stringify(session)]);
    expect(ok).toEqual(["OK", expect.any(String), true, ""]);
    expect(response?.type).toBe("accept");
    const pkg = (response as { data: PartialSigPackage }).data;
    expect(pkg.idx).toBe(fx.signerShare.idx);
    expect(pkg.sid).toBe(session.sid);
    expect(pkg.nonce_code).toBe(nonces![0]!.code);

    const ctx = getSessionCtx(fx.group, session);
    expect(verifyPsigPkg(ctx, pkg)).toBeNull();
    const ours = createPsigPkg(ctx, peer.share, ourSecret);
    const [entry] = combineSignaturePkgs(ctx, [pkg, ours]);
    expect(schnorr.verify(hexToBytes(entry![2]), hexToBytes(sighash), hexToBytes(xOnly(fx.group.group_pk)))).toBe(true);

    // The same nonce again: spent, refused, and the refusal names it.
    const again = await peer.request("sign", [JSON.stringify(session)]);
    expect(again.ok[2]).toBe(false);
    expect(again.ok[3]).toMatch(/already spent/);
    peer.close();
  });

  it("refuses a nonce this share never issued, a session for another group, and a session it is not part of", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    await pingFor(peer);
    const sighash = bytesToHex(sha256(new TextEncoder().encode("x")));

    const forged = { binder_pn: getPubkey(bytesToHex(schnorr.keygen().secretKey), "ecdsa"), hidden_pn: getPubkey(bytesToHex(schnorr.keygen().secretKey), "ecdsa"), code: bytesToHex(schnorr.keygen().secretKey) };
    const { session: bad } = buildSession(fx.group, peer.share, fx.signerShare.idx, forged, [[sighash]]);
    const r1 = await peer.request("sign", [JSON.stringify(bad)]);
    expect(r1.ok[3]).toMatch(/not issued to you/);

    const other = fixture();
    const { session: foreign } = buildSession(other.group, peer.share, fx.signerShare.idx, forged, [[sighash]]);
    const r2 = await peer.request("sign", [JSON.stringify(foreign)]);
    expect(r2.ok[3]).toMatch(/does not match this group/);

    const { session: without } = buildSession(fx.group, peer.share, 3, forged, [[sighash]]);
    const r3 = await peer.request("sign", [JSON.stringify(without)]);
    expect(r3.ok[3]).toMatch(/not among the session's members/);

    const r4 = await peer.request("sign", ["not json"]);
    expect(r4.ok[3]).toMatch(/failed validation/);
    peer.close();
  });

  it("replenishes the requester's pool from the sign response once it runs low", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const { nonces } = await pingFor(peer);
    // Spend down to under the threshold.
    let replenished: DerivedPublicNonce[] | undefined;
    for (let i = 0; i < 31; i++) {
      const sighash = bytesToHex(sha256(new TextEncoder().encode(`m${i}`)));
      const { session } = buildSession(fx.group, peer.share, fx.signerShare.idx, nonces![i]!, [[sighash]]);
      const { response } = await peer.request("sign", [JSON.stringify(session)]);
      const pkg = (response as { data: PartialSigPackage }).data;
      if (pkg.replenish) replenished = pkg.replenish;
    }
    expect(replenished).toHaveLength(NONCE_REPLENISH_COUNT);
    peer.close();
  });
});

describe("/ecdh", () => {
  it("returns a share that combines with the requester's into the ECDH secret", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const target = getPubkey(bytesToHex(schnorr.keygen().secretKey), "ecdsa");
    const members = [fx.signerShare.idx, peer.share.idx];
    const mine = create_ecdh_share(members, peer.share, target);
    const request = { idx: peer.share.idx, members, entries: [{ ecdh_pk: target, keyshare: mine.pubkey }] };
    const { ok, response } = await peer.request("ecdh", [JSON.stringify(request)]);
    expect(ok[2]).toBe(true);
    const data = (response as { data: { idx: number; members: number[]; entries: Array<{ ecdh_pk: string; keyshare: string }> } }).data;
    expect(data.idx).toBe(fx.signerShare.idx);
    expect(data.entries[0]!.ecdh_pk).toBe(target);
    const secret = derive_ecdh_secret([{ idx: mine.idx, pubkey: mine.pubkey }, { idx: data.idx, pubkey: data.entries[0]!.keyshare }]);
    // Against the whole key, which no single party holds: the group
    // secret (reconstructed here from a threshold of shares) times the
    // target point is what a plain ECDH would have produced.
    const groupSecret = derive_shares_secret(fx.shares.slice(0, fx.group.threshold));
    const expected = secp256k1.Point.fromHex(target).multiply(BigInt(`0x${groupSecret}`)).toHex(true);
    expect(secret).toBe(expected);

    const under = await peer.request("ecdh", [JSON.stringify({ ...request, members: [fx.signerShare.idx] })]);
    expect(under.ok[3]).toMatch(/under the threshold/);
    peer.close();
  });
});

describe("/echo and /onboard", () => {
  it("echoes the challenge back to the member that sent it", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const { response } = await peer.request("echo", ["deadbeef"]);
    expect(response).toMatchObject({ type: "accept", data: "deadbeef" });
    peer.close();
  });

  it("onboards a member with the group and a full pool, and rejects an impostor", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const { response } = await peer.request("onboard", [JSON.stringify({ share_pk: peer.pubkey, idx: peer.share.idx })]);
    expect(response?.type).toBe("accept");
    const data = (response as { data: { group: unknown; nonces: DerivedPublicNonce[] } }).data;
    expect(data.group).toEqual(fx.group);
    expect(data.nonces).toHaveLength(NONCE_POOL_SIZE);

    const impostor = await peer.request("onboard", [JSON.stringify({ share_pk: peer.pubkey, idx: 3 })]);
    expect(impostor.response).toMatchObject({ type: "reject", reason: "requester not a valid group member" });
    peer.close();
  });

  it("ignores a method it does not know, accepting the event", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = await connected(fx);
    const { ok, response } = await peer.request("dance", []);
    expect(ok[2]).toBe(true);
    expect(response).toBeNull();
    peer.close();
  });
});
