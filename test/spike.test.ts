// Phase 0's record: one bifrost partial sign on workerd, combined and
// verified by the requester side, and the isolate's clock behaviour. The
// numbers in docs/budget.md were taken through a Durable Object RPC at
// commit e39c5a7; the spike methods left the object when the real
// handlers arrived, and this now runs the same loop in the test isolate,
// which is the same runtime. Printed, not asserted: a timing is a record,
// not a conformance property.
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  combineSignaturePkgs,
  createPsigPkg,
  deriveSecretNonce,
  generateNoncePairs,
  getPubkey,
  getSessionCtx,
  verifyNonceCode,
  verifyPsigPkg,
  xOnly,
} from "../src/frost.ts";
import { verifySignature } from "../src/nostr.ts";
import { RPC_KIND, acceptMessage, requestMessage, unwrapRpc, wrapRpc } from "../src/wire.ts";
import { buildSession, generateDealerPackage } from "./helpers/group.ts";

const SIGNER_IDX = 1;

describe("phase 0 spike: partial sign on workerd", () => {
  const { group, shares } = generateDealerPackage(2, 3);
  const signerShare = shares[0]!;
  const requesterShare = shares[1]!;
  const sighash = bytesToHex(sha256(new TextEncoder().encode("hello frostr")));

  it("a partial signature made here combines to a valid BIP-340 signature", () => {
    const [signerNonce] = generateNoncePairs(signerShare.seckey, 1);
    const { session, ourSecret } = buildSession(group, requesterShare, SIGNER_IDX, signerNonce!, [[sighash]]);

    // The signer side, as src/signer.ts will run it.
    expect(verifyNonceCode(signerShare.seckey, signerNonce!)).toBe(true);
    const ctx = getSessionCtx(group, session);
    const theirs = createPsigPkg(ctx, signerShare, deriveSecretNonce(signerShare.seckey, signerNonce!.code));
    expect(verifyPsigPkg(ctx, theirs)).toBeNull();

    const ours = createPsigPkg(ctx, requesterShare, ourSecret);
    expect(verifyPsigPkg(ctx, ours)).toBeNull();

    const [entry] = combineSignaturePkgs(ctx, [theirs, ours]);
    const [signedHash, groupPk, signature] = entry!;
    expect(signedHash).toBe(sighash);
    expect(schnorr.verify(hexToBytes(signature), hexToBytes(sighash), hexToBytes(xOnly(groupPk)))).toBe(true);
  });

  it("reports the isolate's wall clock behaviour and a per-sign figure", () => {
    const [signerNonce] = generateNoncePairs(signerShare.seckey, 1);
    const { session } = buildSession(group, requesterShare, SIGNER_IDX, signerNonce!, [[sighash]]);
    const iterations = 200;
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      verifyNonceCode(signerShare.seckey, signerNonce!);
      createPsigPkg(getSessionCtx(group, session), signerShare, deriveSecretNonce(signerShare.seckey, signerNonce!.code));
    }
    const signMs = Date.now() - start;
    const nonceStart = Date.now();
    generateNoncePairs(signerShare.seckey, 50);
    const nonceMs = Date.now() - nonceStart;
    console.log(`[spike] ${iterations} partial signs: ${signMs}ms (clock advanced: ${signMs > 0}); 50 nonces: ${nonceMs}ms`);
  });

  it("wraps and unwraps a bifrost RPC message between two share keys", () => {
    const request = requestMessage("sign", [JSON.stringify({ hello: "world" })]);
    const signerPk = getPubkey(signerShare.seckey, "bip340");
    const requesterPk = getPubkey(requesterShare.seckey, "bip340");

    const event = wrapRpc(requesterShare.seckey, request, signerPk);
    expect(event.kind).toBe(RPC_KIND);
    expect(event.tags).toEqual([["p", signerPk]]);
    expect(event.pubkey).toBe(requesterPk);
    expect(verifySignature(event)).toBe(true);

    const unwrapped = unwrapRpc(signerShare.seckey, event);
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.message).toEqual(request);

    const reply = wrapRpc(signerShare.seckey, acceptMessage(request, { ok: 1 }), requesterPk);
    const back = unwrapRpc(requesterShare.seckey, reply);
    expect(back.ok && back.message.type === "accept" && back.message.id === request.id).toBe(true);

    const stranger = unwrapRpc(shares[2]!.seckey, event);
    expect(stranger.ok).toBe(false);
  });
});
