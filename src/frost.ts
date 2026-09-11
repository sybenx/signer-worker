// The FROSTR maths, without the transport.
//
// Ported from @frostr/bifrost 2.0.2 src/lib (group.ts, session.ts,
// nonce.ts, sign.ts, ecdh.ts, package.ts, util.ts) and src/encoder
// (group.ts, share.ts), MIT, Christopher Scott, on top of the same
// @vbyte/frost the reference node uses. Every byte layout here -- group
// id, session id, bind hash, nonce derivation, bech32m packages -- is
// bifrost's, so a partial signature this Worker produces combines with
// the partial signatures bifrost nodes produce. Where bifrost's
// docs/PROTOCOL.md and its code disagree (the doc says little-endian
// integers; @vbyte/buff writes big-endian) this follows the code.
//
// Nothing here touches storage or a socket. The nonce POOL -- which codes
// have been handed to which peer, and which have been spent -- lives in
// the Durable Object's SQLite (src/signer.ts); this file only derives.
import { Buff } from "@vbyte/buff";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { bech32m } from "@scure/base";
import {
  combine_partial_sigs,
  create_ecdh_share,
  get_group_signing_ctx,
  sign_msg,
  verify_partial_sig,
} from "@vbyte/frost/lib";
import type { GroupSigningCtx } from "@vbyte/frost";

// --- Packages -----------------------------------------------------------

export interface MemberPackage {
  idx: number;
  // 33-byte compressed hex.
  pubkey: string;
}
export interface GroupPackage {
  members: MemberPackage[];
  // 33-byte compressed hex.
  group_pk: string;
  threshold: number;
}
export interface SharePackage {
  idx: number;
  // 32-byte hex.
  seckey: string;
}

// --- Nonces (bifrost src/lib/nonce.ts) ----------------------------------

export interface DerivedPublicNonce {
  binder_pn: string;
  hidden_pn: string;
  code: string;
}
export interface MemberPublicNonce extends DerivedPublicNonce {
  idx: number;
}
export interface SecretNoncePair {
  code: string;
  binder_sn: string;
  hidden_sn: string;
}

// --- Sessions (bifrost src/lib/session.ts, src/types/sign.ts) ------------

export type SighashVector = [sighash: string, ...tweaks: string[]];

export interface SignSessionTemplate {
  content: string | null;
  hashes: SighashVector[];
  members: number[];
  stamp: number;
  type: string;
}
export interface SignSessionPackage extends SignSessionTemplate {
  gid: string;
  sid: string;
  nonces?: MemberPublicNonce[];
  replenish?: DerivedPublicNonce[][];
}
export type PartialSigEntry = [sighash: string, psig: string];
export interface PartialSigPackage {
  idx: number;
  psigs: PartialSigEntry[];
  // 33-byte compressed hex.
  pubkey: string;
  sid: string;
  nonce_code?: string;
  replenish?: DerivedPublicNonce[];
}
export interface SignSessionContext {
  pubkeys: string[];
  session: SignSessionPackage;
  sigmap: Map<string, GroupSigningCtx>;
}
export type SignatureEntry = [sighash: string, pubkey: string, signature: string];

// --- ECDH (bifrost src/lib/ecdh.ts) --------------------------------------

export interface ECDHEntry {
  ecdh_pk: string;
  keyshare: string;
}
export interface ECDHPackage {
  idx: number;
  members: number[];
  entries: ECDHEntry[];
}

// --- Keys ----------------------------------------------------------------

// bifrost util/crypto.ts get_pubkey: G * sk, compressed; 'bip340' drops
// the parity byte.
export function getPubkey(seckeyHex: string, format: "ecdsa" | "bip340"): string {
  const compressed = bytesToHex(secp256k1.getPublicKey(hexToBytes(seckeyHex), true));
  return format === "ecdsa" ? compressed : compressed.slice(2);
}

// bifrost src/lib/util.ts normalize_pubkey / pubkeys_match.
export function xOnly(pubkeyHex: string): string {
  return pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
}

export function pubkeysMatch(a: string, b: string): boolean {
  try {
    return equalBytes(hexToBytes(xOnly(a)), hexToBytes(xOnly(b)));
  } catch {
    return false;
  }
}

export function memberByIdx(group: GroupPackage, idx: number): MemberPackage | null {
  return group.members.find((m) => m.idx === idx) ?? null;
}

export function memberByPubkey(group: GroupPackage, pubkey: string): MemberPackage | null {
  return group.members.find((m) => pubkeysMatch(m.pubkey, pubkey)) ?? null;
}

// bifrost src/lib/group.ts is_group_member.
export function isGroupMember(group: GroupPackage, share: SharePackage): boolean {
  const pubkey = getPubkey(share.seckey, "ecdsa");
  return group.members.some((m) => m.idx === share.idx && m.pubkey === pubkey);
}

// --- Identifiers ---------------------------------------------------------

function digest(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

// bifrost src/lib/group.ts get_group_id:
//   sha256(group_pk || threshold[4] || member_pubkey[33]... sorted by idx)
export function getGroupId(group: GroupPackage): string {
  const sorted = [...group.members].sort((a, b) => a.idx - b.idx);
  return digest(
    Buff.join([Buff.hex(group.group_pk), Buff.num(group.threshold, 4), ...sorted.map((m) => Buff.hex(m.pubkey))]),
  );
}

// bifrost src/lib/session.ts get_session_id:
//   sha256(gid || members[4]... || hashes... || content (hex, or 0x00) || type (utf8) || stamp[4])
// `content` is treated as hex by bifrost (Buff.bytes) and so is here; a
// session whose content is not hex fails to hash, which is a refusal.
export function getSessionId(gid: string, template: SignSessionTemplate): string {
  const members = template.members.map((idx) => Buff.num(idx, 4));
  const hashes = template.hashes.map((vec) => Buff.join(vec));
  const content = Buff.bytes(template.content ?? "00");
  const type = Buff.str(template.type);
  const stamp = Buff.num(template.stamp, 4);
  return digest(Buff.join([Buff.hex(gid), ...members, ...hashes, content, type, stamp]));
}

// bifrost src/lib/session.ts verify_session_pkg.
export function verifySessionPkg(group: GroupPackage, session: SignSessionPackage): boolean {
  try {
    const gid = getGroupId(group);
    return session.gid === gid && session.sid === getSessionId(gid, session);
  } catch {
    return false;
  }
}

// --- Nonce derivation ----------------------------------------------------

// bifrost src/lib/nonce.ts, domain separators verbatim.
const DOMAIN_BINDER = "bifrost/nonce/binder/v1";
const DOMAIN_HIDDEN = "bifrost/nonce/hidden/v1";

// HMAC-SHA256(share_secret, code || domain).
function deriveNonceSecret(shareSecret: string, code: string, domain: string): string {
  return bytesToHex(hmac(sha256, hexToBytes(shareSecret), Buff.join([Buff.hex(code), Buff.str(domain)])));
}

export function deriveSecretNonce(shareSecret: string, code: string): SecretNoncePair {
  return {
    code,
    binder_sn: deriveNonceSecret(shareSecret, code, DOMAIN_BINDER),
    hidden_sn: deriveNonceSecret(shareSecret, code, DOMAIN_HIDDEN),
  };
}

export function publicNonceFor(secret: SecretNoncePair): DerivedPublicNonce {
  return {
    binder_pn: getPubkey(secret.binder_sn, "ecdsa"),
    hidden_pn: getPubkey(secret.hidden_sn, "ecdsa"),
    code: secret.code,
  };
}

// A fresh random code and the public points it derives to. Only the code
// is ever stored (src/signer.ts); the secrets are re-derived at signing.
export function generateNoncePair(shareSecret: string): DerivedPublicNonce {
  return publicNonceFor(deriveSecretNonce(shareSecret, bytesToHex(randomBytes(32))));
}

export function generateNoncePairs(shareSecret: string, count: number): DerivedPublicNonce[] {
  const out: DerivedPublicNonce[] = [];
  for (let i = 0; i < count; i++) out.push(generateNoncePair(shareSecret));
  return out;
}

const HEX_33_RE = /^0[23][0-9a-f]{64}$/;
const HEX_32_RE = /^[0-9a-f]{64}$/;

// bifrost validate_public_nonce: shape only. The curve check happens when
// @vbyte/frost lifts the points during signing.
export function isValidPublicNonce(nonce: unknown): nonce is DerivedPublicNonce {
  if (typeof nonce !== "object" || nonce === null) return false;
  const n = nonce as Record<string, unknown>;
  return (
    typeof n.binder_pn === "string" && HEX_33_RE.test(n.binder_pn) &&
    typeof n.hidden_pn === "string" && HEX_33_RE.test(n.hidden_pn) &&
    typeof n.code === "string" && HEX_32_RE.test(n.code)
  );
}

// bifrost verify_nonce_code: the requester sent back a code claiming
// these public points; re-derive and compare in constant time.
export function verifyNonceCode(shareSecret: string, nonce: DerivedPublicNonce): boolean {
  try {
    const derived = publicNonceFor(deriveSecretNonce(shareSecret, nonce.code));
    return (
      equalBytes(hexToBytes(derived.binder_pn), hexToBytes(nonce.binder_pn)) &&
      equalBytes(hexToBytes(derived.hidden_pn), hexToBytes(nonce.hidden_pn))
    );
  } catch {
    return false;
  }
}

// --- Session context -----------------------------------------------------

interface SighashCommit {
  idx: number;
  pubkey: string;
  binder_pn: string;
  hidden_pn: string;
  sid: string;
  sighash: string;
  bind_hash: string;
}

// bifrost create_session_commits: one commit per (member, sighash), with
// bind_hash = sha256(sid || idx[4] || sighash).
function sessionCommits(group: GroupPackage, session: SignSessionPackage): SighashCommit[] {
  const commits: SighashCommit[] = [];
  for (const idx of session.members) {
    const member = memberByIdx(group, idx);
    if (member === null) throw new Error(`member package not found for idx: ${idx}`);
    const nonce = session.nonces?.find((n) => n.idx === idx);
    if (!nonce) throw new Error(`no nonce found for member ${idx} in session`);
    for (const vec of session.hashes) {
      const sighash = vec[0];
      const bind_hash = digest(Buff.join([Buff.hex(session.sid), Buff.num(idx, 4), Buff.hex(sighash)]));
      commits.push({
        idx,
        pubkey: member.pubkey,
        binder_pn: nonce.binder_pn,
        hidden_pn: nonce.hidden_pn,
        sid: session.sid,
        sighash,
        bind_hash,
      });
    }
  }
  return commits;
}

// bifrost get_session_ctx.
export function getSessionCtx(group: GroupPackage, session: SignSessionPackage): SignSessionContext {
  if (!session.nonces || session.nonces.length === 0) {
    throw new Error("session must include nonces for dynamic nonce signing");
  }
  const pubkeys = group.members.map((m) => m.pubkey);
  const commits = sessionCommits(group, session);
  const sigmap = new Map<string, GroupSigningCtx>();
  for (const vec of session.hashes) {
    const [sighash, ...tweaks] = vec;
    const forHash = commits.filter((c) => c.sighash === sighash);
    sigmap.set(sighash, get_group_signing_ctx(group.group_pk, forHash, sighash, tweaks));
  }
  return { pubkeys, session, sigmap };
}

// --- Partial signatures (bifrost src/lib/sign.ts) ------------------------

export function createPsigPkg(ctx: SignSessionContext, share: SharePackage, nonce: SecretNoncePair): PartialSigPackage {
  const pubkey = getPubkey(share.seckey, "ecdsa");
  const psigs = ctx.session.hashes.map((vec): PartialSigEntry => {
    const sighash = vec[0];
    const sigctx = ctx.sigmap.get(sighash);
    if (!sigctx) throw new Error(`context not found for sighash: ${sighash}`);
    const { psig } = sign_msg(
      sigctx,
      { idx: share.idx, seckey: share.seckey },
      { idx: share.idx, binder_sn: nonce.binder_sn, hidden_sn: nonce.hidden_sn },
    );
    return [sighash, psig];
  });
  return { idx: share.idx, psigs, pubkey, sid: ctx.session.sid, nonce_code: nonce.code };
}

// Returns null when the package verifies, else the reason. Used by the
// suite, and by the requester side this Worker grows into (NIP-46).
export function verifyPsigPkg(ctx: SignSessionContext, pkg: PartialSigPackage): string | null {
  if (pkg.sid !== ctx.session.sid) return "session id mismatch";
  if (!ctx.pubkeys.includes(pkg.pubkey)) return "pubkey not found in group";
  for (const [sighash, sigctx] of ctx.sigmap.entries()) {
    const entry = pkg.psigs.find((e) => e[0] === sighash);
    if (entry === undefined) return `partial signature entry not found for sighash: ${sighash}`;
    const pnonce = sigctx.pnonces.find((n) => n.idx === pkg.idx);
    if (pnonce === undefined) return `commit package not found for psig idx: ${pkg.idx}`;
    if (!verify_partial_sig(sigctx, pnonce, pkg.pubkey, entry[1])) return "partial signature invalid";
  }
  return null;
}

export function combineSignaturePkgs(ctx: SignSessionContext, pkgs: PartialSigPackage[]): SignatureEntry[] {
  const count = ctx.session.members.length;
  const records = pkgs.flatMap(({ idx, psigs, pubkey }) =>
    psigs.map(([sighash, psig]) => ({ sighash, idx, pubkey, psig })),
  );
  const sigs: SignatureEntry[] = [];
  for (const [sighash, sigctx] of ctx.sigmap.entries()) {
    const psigs = records.filter((r) => r.sighash === sighash);
    if (psigs.length !== count) throw new Error(`missing partial signatures for sighash: ${sighash}`);
    sigs.push([sighash, sigctx.group_pk, combine_partial_sigs(sigctx, psigs)]);
  }
  return sigs;
}

// --- ECDH ----------------------------------------------------------------

// bifrost create_batched_ecdh_pkg.
export function createEcdhPkg(members: number[], ecdhPks: string[], share: SharePackage): ECDHPackage {
  const entries = ecdhPks.map((ecdh_pk): ECDHEntry => ({
    ecdh_pk,
    keyshare: create_ecdh_share(members, share, ecdh_pk).pubkey,
  }));
  return { idx: share.idx, members, entries };
}

// --- bech32m packages (bifrost src/encoder) ------------------------------

export const PREFIX_SHARE = "bfshare";
export const PREFIX_GROUP = "bfgroup";

const MEMBER_DATA_SIZE = 4 + 33;
// v1 groups carried two static public nonces per member.
const LEGACY_COMMIT_SIZE = 4 + 33 + 33 + 33;
const SHARE_DATA_SIZE = 4 + 32;
// v1 shares carried two static secret nonces.
const LEGACY_SHARE_SIZE = 4 + 32 + 32 + 32;

function toBech32m(data: Uint8Array, prefix: string): string {
  return bech32m.encode(prefix, bech32m.toWords(data), false);
}

function fromBech32m(str: string, prefix: string): Uint8Array | null {
  try {
    const decoded = bech32m.decode(str as `${string}1${string}`, false);
    if (decoded.prefix !== prefix) return null;
    return new Uint8Array(bech32m.fromWords(decoded.words));
  } catch {
    return null;
  }
}

function readU32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, false);
}

export function encodeGroupPackage(group: GroupPackage): string {
  const members = group.members.map((m) => Buff.join([Buff.num(m.idx, 4), Buff.hex(m.pubkey)]));
  return toBech32m(Buff.join([Buff.hex(group.group_pk), Buff.num(group.threshold, 4), ...members]), PREFIX_GROUP);
}

// Accepts the current 37-byte member layout and the legacy 103-byte
// commit layout (nonces discarded), as bifrost does. Null for anything
// else -- a decode failure here is a refusal, never an exception.
export function decodeGroupPackage(str: string): GroupPackage | null {
  const data = fromBech32m(str.trim(), PREFIX_GROUP);
  if (data === null || data.length < 37) return null;
  const group_pk = bytesToHex(data.subarray(0, 33));
  const threshold = readU32(data, 33);
  const rest = data.subarray(37);
  let stride: number;
  if (rest.length % MEMBER_DATA_SIZE === 0 && rest.length % LEGACY_COMMIT_SIZE !== 0) stride = MEMBER_DATA_SIZE;
  else if (rest.length % LEGACY_COMMIT_SIZE === 0) stride = LEGACY_COMMIT_SIZE;
  else return null;
  const members: MemberPackage[] = [];
  for (let off = 0; off < rest.length; off += stride) {
    members.push({ idx: readU32(rest, off), pubkey: bytesToHex(rest.subarray(off + 4, off + 37)) });
  }
  if (members.length === 0 || threshold < 1 || threshold > members.length) return null;
  if (!HEX_33_RE.test(group_pk) || !members.every((m) => HEX_33_RE.test(m.pubkey))) return null;
  return { members, group_pk, threshold };
}

export function encodeSharePackage(share: SharePackage): string {
  return toBech32m(Buff.join([Buff.num(share.idx, 4), Buff.hex(share.seckey)]), PREFIX_SHARE);
}

export function decodeSharePackage(str: string): SharePackage | null {
  const data = fromBech32m(str.trim(), PREFIX_SHARE);
  if (data === null) return null;
  if (data.length !== SHARE_DATA_SIZE && data.length !== LEGACY_SHARE_SIZE) return null;
  const idx = readU32(data, 0);
  const seckey = bytesToHex(data.subarray(4, 36));
  if (idx < 1) return null;
  try {
    // A scalar outside the field is not a share.
    secp256k1.getPublicKey(hexToBytes(seckey), true);
  } catch {
    return null;
  }
  return { idx, seckey };
}
