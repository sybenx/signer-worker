// Per-peer policy, in igloo-server's shape (docs/PEER_POLICIES.md,
// src/util/peer-policy.ts): directional allow/deny attached to a peer
// pubkey, default allow/allow, persisted only when something is not the
// default. `allowReceive` is whether this signer accepts requests from
// the peer; `allowSend` is whether it would send to them, which matters
// from the NIP-46 release when this Worker initiates signing.
//
// igloo-server layers an environment baseline under runtime overrides.
// This Worker has one layer: what a NIP-98 call signed by the group key
// set. There is no PEER_POLICIES variable, so there is no precedence to
// explain.

export interface PeerPolicyRecord {
  pubkey: string;
  allowSend?: boolean;
  allowReceive?: boolean;
  label?: string;
  note?: string;
}

export interface PeerPolicy {
  allowSend: boolean;
  allowReceive: boolean;
}

export const DEFAULT_POLICY: PeerPolicy = { allowSend: true, allowReceive: true };

const MAX_TEXT = 200;

// igloo-server sanitizePeerPolicyEntries, for one entry: x-only lowercase
// pubkey, booleans as given, text trimmed and bounded. Null when the
// entry carries no non-default override -- "to remove a deny, delete the
// entry", so an all-default record is a removal.
export function sanitizePolicyRecord(raw: unknown): PeerPolicyRecord | null | "malformed" {
  if (typeof raw !== "object" || raw === null) return "malformed";
  const r = raw as Record<string, unknown>;
  if (typeof r.pubkey !== "string") return "malformed";
  let pubkey = r.pubkey.trim().toLowerCase();
  if (pubkey.length === 66 && (pubkey.startsWith("02") || pubkey.startsWith("03"))) pubkey = pubkey.slice(2);
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return "malformed";
  for (const key of ["allowSend", "allowReceive"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "boolean") return "malformed";
  }
  for (const key of ["label", "note"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string") return "malformed";
  }
  const out: PeerPolicyRecord = { pubkey };
  if (r.allowSend === false) out.allowSend = false;
  if (r.allowReceive === false) out.allowReceive = false;
  const label = typeof r.label === "string" ? r.label.trim().slice(0, MAX_TEXT) : "";
  const note = typeof r.note === "string" ? r.note.trim().slice(0, MAX_TEXT) : "";
  if (label) out.label = label;
  if (note) out.note = note;
  const hasOverride = out.allowSend === false || out.allowReceive === false || out.label !== undefined || out.note !== undefined;
  return hasOverride ? out : null;
}

export function policyOf(record: PeerPolicyRecord | null): PeerPolicy {
  return {
    allowSend: record?.allowSend !== false,
    allowReceive: record?.allowReceive !== false,
  };
}
