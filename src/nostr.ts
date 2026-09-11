// NIP-01 wire types and the event checks this Worker needs (nips/01.md
// "Events and signatures"). Just enough shape for one relay that stores
// nothing: an event id, a signature, a filter match. Adapted from bothy's
// src/nostr.ts and src/validate.ts (github.com/sybenx/bothy, MIT).
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagKey: `#${string}`]: unknown;
};

const HEX_32_RE = /^[0-9a-f]{64}$/;
const HEX_64_RE = /^[0-9a-f]{128}$/;

export function isHex32(value: unknown): value is string {
  return typeof value === "string" && HEX_32_RE.test(value);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// NIP-01 "To obtain the event.id": sha256 of the UTF-8 JSON-serialized
// [0, pubkey, created_at, kind, tags, content] array. JSON.stringify's
// default escaping already matches the spec's escape table.
export function computeEventId(event: Omit<NostrEvent, "id" | "sig">): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

export interface UnsignedEventInput {
  kind: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}

// Signs with a 32-byte secret key. The Worker signs exactly two things:
// its responses to peers (src/wire.ts, with the share's own key) and the
// one echo it sends after a claim.
export function signEvent(secretKeyHex: string, input: UnsignedEventInput): NostrEvent {
  const secretKey = hexToBytes(secretKeyHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const created_at = input.created_at ?? nowSeconds();
  const tags = input.tags ?? [];
  const content = input.content ?? "";
  const kind = input.kind;
  const id = computeEventId({ pubkey, created_at, kind, tags, content });
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

// Structural shape only -- id/signature validity is checked separately,
// so a refusal can say which of the three it was.
export function parseEventShape(raw: unknown): NostrEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (!isHex32(e.id)) return null;
  if (!isHex32(e.pubkey)) return null;
  if (typeof e.sig !== "string" || !HEX_64_RE.test(e.sig)) return null;
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at)) return null;
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind)) return null;
  if (typeof e.content !== "string") return null;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) {
    return null;
  }
  return {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags as string[][],
    content: e.content,
    sig: e.sig,
  };
}

export function idMatchesContent(event: NostrEvent): boolean {
  return computeEventId(event) === event.id;
}

// The CPU-expensive step on every inbound EVENT, and the reason every
// cheap refusal (kind, p-tag, policy, rate limit) runs ahead of it. See
// docs/budget.md for the measured figure.
export function verifySignature(event: NostrEvent): boolean {
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export function pTagValues(tags: string[][]): string[] {
  return tags.filter((t) => t[0] === "p" && t[1] !== undefined).map((t) => t[1] as string);
}

// NIP-01 filter matching, in full, for the one use it has here: deciding
// which of a connection's open subscriptions a freshly produced response
// belongs on. Prefix matching on ids/authors is not supported (NIP-01
// says MAY).
export function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (key.length !== 2 || key[0] !== "#" || !Array.isArray(values)) continue;
    const name = key[1] as string;
    const wanted = values as unknown[];
    const present = event.tags.some((t) => t[0] === name && t[1] !== undefined && wanted.includes(t[1]));
    if (!present) return false;
  }
  return true;
}

export function parseFilter(raw: unknown): Filter | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const out: Filter = {};
  const hexList = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every(isHex32) ? (v as string[]) : null;
  if (f.ids !== undefined) {
    const ids = hexList(f.ids);
    if (ids === null) return null;
    out.ids = ids;
  }
  if (f.authors !== undefined) {
    const authors = hexList(f.authors);
    if (authors === null) return null;
    out.authors = authors;
  }
  if (f.kinds !== undefined) {
    if (!Array.isArray(f.kinds) || !f.kinds.every((k) => typeof k === "number" && Number.isInteger(k))) return null;
    out.kinds = f.kinds as number[];
  }
  for (const name of ["since", "until", "limit"] as const) {
    const v = f[name];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
    out[name] = v;
  }
  for (const [key, value] of Object.entries(f)) {
    if (key.length !== 2 || key[0] !== "#") continue;
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
    out[key as `#${string}`] = value;
  }
  return out;
}
