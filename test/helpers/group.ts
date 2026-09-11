// Test fixtures: a fresh dealer-generated group, and the requester side
// of a signing round, built from the same @vbyte/frost the Worker uses.
// bifrost's own keygen (test/keygen.ts) does the same thing through
// lib/package.ts generate_dealer_package.
import { create_dealer_set } from "@vbyte/frost/lib";
import {
  createPsigPkg,
  deriveSecretNonce,
  getGroupId,
  getPubkey,
  getSessionId,
  publicNonceFor,
  type DerivedPublicNonce,
  type GroupPackage,
  type MemberPublicNonce,
  type SecretNoncePair,
  type SharePackage,
  type SighashVector,
  type SignSessionPackage,
} from "../../src/frost.ts";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

export interface DealerPackage {
  group: GroupPackage;
  shares: SharePackage[];
}

export function generateDealerPackage(threshold: number, count: number): DealerPackage {
  const set = create_dealer_set(threshold, count);
  const shares: SharePackage[] = set.shares.map((s) => ({ idx: s.idx, seckey: s.seckey }));
  const members = shares.map((s) => ({ idx: s.idx, pubkey: getPubkey(s.seckey, "ecdsa") }));
  return { group: { members, group_pk: set.group_pk, threshold: set.vss_commits.length }, shares };
}

// The requester's half of bifrost api/sign.ts: consume one nonce the
// signer previously handed us, generate our own, and build the session
// package exactly as create_session_pkg would.
export function buildSession(
  group: GroupPackage,
  requester: SharePackage,
  signerIdx: number,
  signerNonce: DerivedPublicNonce,
  hashes: SighashVector[],
  options: { content?: string | null; stamp?: number; type?: string } = {},
): { session: SignSessionPackage; ourSecret: SecretNoncePair } {
  const ourSecret = deriveSecretNonce(requester.seckey, bytesToHex(randomBytes(32)));
  const ours = publicNonceFor(ourSecret);
  const nonces: MemberPublicNonce[] = [
    { ...signerNonce, idx: signerIdx },
    { ...ours, idx: requester.idx },
  ];
  const template = {
    content: options.content ?? null,
    hashes,
    members: [signerIdx, requester.idx].sort((a, b) => a - b),
    stamp: options.stamp ?? Math.floor(Date.now() / 1000),
    type: options.type ?? "message",
  };
  const gid = getGroupId(group);
  const sid = getSessionId(gid, template);
  return { session: { ...template, gid, sid, nonces }, ourSecret };
}

export { createPsigPkg };
