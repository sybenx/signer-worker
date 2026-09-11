// Validation of what peers send, by hand, mirroring bifrost 2.0.2's zod
// schemas (src/schema/*.ts) field for field. No zod here: the Worker
// carries no schema library, and every message it accepts has a handful
// of fields whose shapes are fixed by the protocol.
import { isValidPublicNonce, type DerivedPublicNonce, type MemberPublicNonce, type SighashVector, type SignSessionPackage } from "./frost.ts";

const HEX_RE = /^[0-9a-fA-F]*$/;
function isHex(v: unknown, bytes?: number): v is string {
  return typeof v === "string" && HEX_RE.test(v) && v.length % 2 === 0 && (bytes === undefined || v.length === bytes * 2);
}
function isUint(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

// --- Ping (schema/peer.ts ping_req) --------------------------------------

export interface PingRequest {
  version: number;
  nonces?: DerivedPublicNonce[];
}

// bifrost api/ping.ts parse_ping_request: the legacy string "ping" and
// the empty string read as version 1; pool_status is accepted and
// ignored, since what a peer says about its pools does not change what
// this signer hands it.
export function parsePingRequest(param: string | undefined): PingRequest | null {
  const data = param ?? "";
  if (data === "ping" || data === "") return { version: 1 };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const p = json as Record<string, unknown>;
  if (!isUint(p.version)) return null;
  const out: PingRequest = { version: p.version };
  if (p.nonces !== undefined) {
    if (!Array.isArray(p.nonces) || !p.nonces.every(isValidPublicNonce)) return null;
    out.nonces = p.nonces as DerivedPublicNonce[];
  }
  return out;
}

// --- Sign (schema/sign.ts session) ----------------------------------------

const MAX_SIGN_BATCH = 100;

function isSighashVector(v: unknown): v is SighashVector {
  return Array.isArray(v) && v.length >= 1 && v.every((h) => isHex(h, 32));
}

function isMemberNonce(v: unknown): v is MemberPublicNonce {
  return isValidPublicNonce(v) && isUint((v as { idx?: unknown }).idx);
}

export function parseSignSession(param: string | undefined): SignSessionPackage | null {
  if (param === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(param);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const s = json as Record<string, unknown>;
  if (!(s.content === null || typeof s.content === "string")) return null;
  if (!Array.isArray(s.hashes) || s.hashes.length === 0 || s.hashes.length > MAX_SIGN_BATCH || !s.hashes.every(isSighashVector)) return null;
  if (!Array.isArray(s.members) || s.members.length === 0 || !s.members.every(isUint)) return null;
  if (!isUint(s.stamp) || typeof s.type !== "string") return null;
  if (!isHex(s.gid, 32) || !isHex(s.sid, 32)) return null;
  const out: SignSessionPackage = {
    content: s.content,
    hashes: s.hashes as SighashVector[],
    members: s.members as number[],
    stamp: s.stamp,
    type: s.type,
    gid: s.gid,
    sid: s.sid,
  };
  if (s.nonces !== undefined) {
    if (!Array.isArray(s.nonces) || !s.nonces.every(isMemberNonce)) return null;
    out.nonces = s.nonces as MemberPublicNonce[];
  }
  if (s.replenish !== undefined) {
    if (!Array.isArray(s.replenish) || !s.replenish.every((pkg) => Array.isArray(pkg) && pkg.every(isValidPublicNonce))) return null;
    out.replenish = s.replenish as DerivedPublicNonce[][];
  }
  return out;
}

// --- ECDH (schema/package.ts ecdh) ----------------------------------------

const MAX_ECDH_BATCH = 100;

export interface EcdhRequest {
  idx: number;
  members: number[];
  ecdhPks: string[];
}

// The requester sends its own ECDHPackage (bifrost api/ecdh.ts
// create_ecdh_request passes self_pkg); the handler reads `members` and
// each entry's `ecdh_pk`, and never the requester's keyshare.
export function parseEcdhRequest(param: string | undefined): EcdhRequest | null {
  if (param === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(param);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const e = json as Record<string, unknown>;
  if (!isUint(e.idx)) return null;
  if (!Array.isArray(e.members) || e.members.length === 0 || !e.members.every(isUint)) return null;
  if (!Array.isArray(e.entries) || e.entries.length === 0 || e.entries.length > MAX_ECDH_BATCH) return null;
  const ecdhPks: string[] = [];
  for (const entry of e.entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const pk = (entry as { ecdh_pk?: unknown }).ecdh_pk;
    if (!isHex(pk) || (pk.length !== 64 && pk.length !== 66)) return null;
    ecdhPks.push(pk);
  }
  return { idx: e.idx, members: e.members as number[], ecdhPks };
}

// --- Onboard (schema/onboard.ts onboard_req) ------------------------------

export interface OnboardRequest {
  sharePk: string;
  idx: number;
}

// bifrost's schema says hex33 but its requester sends the signer's
// BIP-340 (32-byte) pubkey; both are accepted here and compared x-only.
export function parseOnboardRequest(param: string | undefined): OnboardRequest | null {
  if (param === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(param);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (!isHex(o.share_pk) || (o.share_pk.length !== 64 && o.share_pk.length !== 66)) return null;
  if (!isUint(o.idx)) return null;
  return { sharePk: o.share_pk, idx: o.idx };
}
