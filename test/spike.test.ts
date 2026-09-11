// Phase 0: one bifrost partial sign on workerd, through a Durable Object,
// combined and verified by the requester side. Also asks the isolate
// whether its clock advances during a request, because the figure in
// docs/budget.md depends on the answer. See docs/budget.md.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  combineSignaturePkgs,
  createPsigPkg,
  generateNoncePairs,
  getSessionCtx,
  verifyPsigPkg,
  xOnly,
  type PartialSigPackage,
} from "../src/frost.ts";
import { buildSession, generateDealerPackage } from "./helpers/group.ts";
import { RPC_KIND, acceptMessage, requestMessage, unwrapRpc, wrapRpc } from "../src/wire.ts";
import { getPubkey } from "../src/frost.ts";
import { verifySignature } from "../src/nostr.ts";
import { signerStub } from "../src/signer-stub.ts";

const SIGNER_IDX = 1;

describe("phase 0 spike: partial sign on workerd", () => {
  const { group, shares } = generateDealerPackage(2, 3);
  const signerShare = shares[0]!;
  const requesterShare = shares[1]!;
  const sighash = bytesToHex(sha256(new TextEncoder().encode("hello frostr")));

  it("a Durable Object produces a partial signature that combines to a valid BIP-340 signature", async () => {
    const stub = signerStub(env);

    // The signer hands the requester a nonce during ping (its outgoing
    // pool); the requester spends it in the session.
    const [signerNonce] = generateNoncePairs(signerShare.seckey, 1);
    const { session, ourSecret } = buildSession(group, requesterShare, SIGNER_IDX, signerNonce!, [[sighash]]);

    const result = await stub.spikeSign(group, signerShare, session, { ...signerNonce!, idx: SIGNER_IDX }, 1);

    // The RPC boundary widens the tuple types to string[][]; the bytes
    // are the package the object built.
    const theirs = result.pkg as PartialSigPackage;
    const ctx = getSessionCtx(group, session);
    expect(verifyPsigPkg(ctx, theirs)).toBeNull();

    const ours = createPsigPkg(ctx, requesterShare, ourSecret);
    expect(verifyPsigPkg(ctx, ours)).toBeNull();

    const [entry] = combineSignaturePkgs(ctx, [theirs, ours]);
    expect(entry).toBeDefined();
    const [signedHash, groupPk, signature] = entry!;
    expect(signedHash).toBe(sighash);
    expect(schnorr.verify(hexToBytes(signature), hexToBytes(sighash), hexToBytes(xOnly(groupPk)))).toBe(true);
  });

  it("reports the isolate's wall clock behaviour and a per-sign figure", async () => {
    const stub = signerStub(env);
    const [signerNonce] = generateNoncePairs(signerShare.seckey, 1);
    const { session } = buildSession(group, requesterShare, SIGNER_IDX, signerNonce!, [[sighash]]);

    const iterations = 200;
    const outer = Date.now();
    const result = await stub.spikeSign(group, signerShare, session, { ...signerNonce!, idx: SIGNER_IDX }, iterations);
    const outerMs = Date.now() - outer;
    const nonces = await stub.spikeNonces(signerShare, 50);
    expect(nonces.nonces).toHaveLength(50);

    // Printed rather than asserted: a timing is a record, not a
    // conformance property. docs/budget.md carries the numbers.
    console.log(
      `[spike] ${iterations} partial signs inside DO: ${result.elapsedMs}ms (clock advanced: ${result.clockAdvanced}); ` +
        `round trip from test: ${outerMs}ms; 50 nonces inside DO: ${nonces.elapsedMs}ms`,
    );
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

    // A third party cannot read it.
    const stranger = unwrapRpc(shares[2]!.seckey, event);
    expect(stranger.ok).toBe(false);
  });
});
