#!/usr/bin/env node
// CPU cost of the signer-side operations, measured in Node with
// process.cpuUsage(), because workerd does not expose isolate CPU time to
// code running in it. Node and workerd share V8, so this is a proxy for
// the 10ms-per-request ceiling docs/budget.md is written against, and
// it is labelled as one there. Run: node scripts/bench.mjs
//
// Deliberately plain .mjs and dependency-free beyond the Worker's own
// modules: a repo chore, outside tsconfig's include, deployed nowhere.
import { create_dealer_set } from "@vbyte/frost/lib";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import {
  combineSignaturePkgs, createEcdhPkg, createPsigPkg, deriveSecretNonce, generateNoncePairs,
  getGroupId, getPubkey, getSessionCtx, getSessionId, publicNonceFor, verifyNonceCode, verifyPsigPkg, xOnly,
} from "../src/frost.ts";
import { acceptMessage, requestMessage, unwrapRpc, wrapRpc } from "../src/wire.ts";
import { signEvent, verifySignature } from "../src/nostr.ts";

function cpuMs(fn, iterations) {
  for (let i = 0; i < 50; i++) fn(); // warm the JIT
  const start = process.cpuUsage();
  for (let i = 0; i < iterations; i++) fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000 / iterations;
}

const set = create_dealer_set(2, 3);
const shares = set.shares.map((s) => ({ idx: s.idx, seckey: s.seckey }));
const group = {
  members: shares.map((s) => ({ idx: s.idx, pubkey: getPubkey(s.seckey, "ecdsa") })),
  group_pk: set.group_pk,
  threshold: 2,
};
const signer = shares[0];
const requester = shares[1];
const sighash = bytesToHex(sha256(new TextEncoder().encode("bench")));

const [signerNonce] = generateNoncePairs(signer.seckey, 1);
const ourSecret = deriveSecretNonce(requester.seckey, bytesToHex(randomBytes(32)));
const template = { content: null, hashes: [[sighash]], members: [1, 2], stamp: Math.floor(Date.now() / 1000), type: "message" };
const gid = getGroupId(group);
const session = { ...template, gid, sid: getSessionId(gid, template), nonces: [{ ...signerNonce, idx: 1 }, { ...publicNonceFor(ourSecret), idx: 2 }] };
const ourNonce = { ...signerNonce, idx: 1 };

const N = 500;
const rows = [];
rows.push(["verify nonce code (2 HMAC + 2 pubkey)", cpuMs(() => verifyNonceCode(signer.seckey, ourNonce), N)]);
rows.push(["derive secret nonce (2 HMAC)", cpuMs(() => deriveSecretNonce(signer.seckey, ourNonce.code), N)]);
rows.push(["session context (bind hashes, group ctx)", cpuMs(() => getSessionCtx(group, session), N)]);
const ctx = getSessionCtx(group, session);
const secret = deriveSecretNonce(signer.seckey, ourNonce.code);
rows.push(["partial signature, given context", cpuMs(() => createPsigPkg(ctx, signer, secret), N)]);
rows.push(["whole /sign handler (verify code + derive + ctx + psig)", cpuMs(() => {
  verifyNonceCode(signer.seckey, ourNonce);
  createPsigPkg(getSessionCtx(group, session), signer, deriveSecretNonce(signer.seckey, ourNonce.code));
}, N)]);
rows.push(["one nonce pair (2 HMAC + 2 pubkey)", cpuMs(() => generateNoncePairs(signer.seckey, 1), N)]);
rows.push(["50 nonce pairs (one replenish)", cpuMs(() => generateNoncePairs(signer.seckey, 50), 20)]);
rows.push(["ecdh share, one pubkey", cpuMs(() => createEcdhPkg([1, 2], [getPubkey(requester.seckey, "ecdsa")], signer), N)]);
const req = requestMessage("sign", [JSON.stringify(session)]);
const reqEvent = wrapRpc(requester.seckey, req, getPubkey(signer.seckey, "bip340"));
rows.push(["schnorr verify inbound event", cpuMs(() => verifySignature(reqEvent), N)]);
rows.push(["unwrap inbound (ECDH + NIP-44 decrypt)", cpuMs(() => unwrapRpc(signer.seckey, reqEvent), N)]);
const pkg = createPsigPkg(ctx, signer, secret);
rows.push(["wrap outbound (NIP-44 encrypt + ECDH + schnorr sign)", cpuMs(() => wrapRpc(signer.seckey, acceptMessage(req, pkg), getPubkey(requester.seckey, "bip340")), N)]);
rows.push(["requester: verify psig", cpuMs(() => verifyPsigPkg(ctx, pkg), N)]);
const ours = createPsigPkg(ctx, requester, ourSecret);
rows.push(["requester: combine two psigs", cpuMs(() => combineSignaturePkgs(ctx, [pkg, ours]), N)]);

const [entry] = combineSignaturePkgs(ctx, [pkg, ours]);
const valid = schnorr.verify(hexToBytes(entry[2]), hexToBytes(sighash), hexToBytes(xOnly(entry[1])));
console.log(`node ${process.version}, ${process.arch}; final signature valid: ${valid}\n`);
console.log("| Operation | CPU ms (mean) |");
console.log("|---|---|");
for (const [name, ms] of rows) console.log(`| ${name} | ${ms.toFixed(2)} |`);
