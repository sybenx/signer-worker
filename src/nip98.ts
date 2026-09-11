// NIP-98 HTTP Auth (nips/98.md), as NIP-86 requires it: `payload` tag
// mandatory. Runs in the Worker, never inside the Durable Object --
// schnorr verification is the CPU-expensive step and there is no reason
// to spend a Durable Object wake on a request that may turn out to be
// forged. The object only ever sees a management call that already passed
// this gate. From bothy's src/nip98.ts (github.com/sybenx/bothy, MIT),
// with the second half rewritten: here the signer must be the GROUP key,
// which means the call was itself a threshold signature by the group's
// devices.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { idMatchesContent, parseEventShape, verifySignature } from "./nostr.ts";

// nips/98.md: "kind 27235... referencing RFC 7235".
export const HTTP_AUTH_KIND = 27235;

// nips/98.md: created_at must be "within a reasonable time window
// (suggestion 60 seconds)". Taken as the suggestion, both directions.
export const HTTP_AUTH_MAX_DRIFT_SECONDS = 60;

export type Nip98Result = { ok: true; pubkey: string } | { ok: false; reason: string };

function tagValue(tags: string[][], name: string): string | null {
  return tags.find((t) => t[0] === name)?.[1] ?? null;
}

// Two URLs that differ only in the ways `new URL()` canonicalizes away
// address the same request.
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

// nips/98.md: "base64 encoded... using the Authorization HTTP header
// with the Nostr scheme".
function decodeAuthHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^Nostr\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

export const UNCLAIMED_REASON = "no share is held here yet, so there is no group key to manage it with";
export const WRONG_SIGNER_REASON = "Authorization event is not signed by the group key";

// Verifies the request carries a well-formed, correctly signed NIP-98
// event over this exact method, URL and body, and returns the signer.
// Checks run cheapest first; the schnorr verify is last.
export function verifyNip98(request: Request, body: Uint8Array, nowSec: number): Nip98Result {
  const json = decodeAuthHeader(request.headers.get("Authorization"));
  if (json === null) {
    return { ok: false, reason: "missing or malformed Authorization header (expected: Nostr <base64-event>)" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "Authorization event is not valid JSON" };
  }
  const event = parseEventShape(raw);
  if (event === null) return { ok: false, reason: "Authorization event is not a well-formed nostr event" };
  if (event.kind !== HTTP_AUTH_KIND) {
    return { ok: false, reason: `Authorization event must be kind ${HTTP_AUTH_KIND}, got ${event.kind}` };
  }
  if (Math.abs(nowSec - event.created_at) > HTTP_AUTH_MAX_DRIFT_SECONDS) {
    return { ok: false, reason: `Authorization event created_at is outside the ${HTTP_AUTH_MAX_DRIFT_SECONDS}s window` };
  }
  const u = tagValue(event.tags, "u");
  if (u === null || !sameUrl(u, request.url)) {
    return { ok: false, reason: `Authorization event 'u' tag must be the request URL (${request.url})` };
  }
  const method = tagValue(event.tags, "method");
  if (method === null || method.toUpperCase() !== request.method.toUpperCase()) {
    return { ok: false, reason: `Authorization event 'method' tag must be ${request.method}` };
  }
  const payload = tagValue(event.tags, "payload");
  if (payload === null) {
    return { ok: false, reason: "Authorization event is missing the 'payload' tag, which NIP-86 requires" };
  }
  if (payload.toLowerCase() !== bytesToHex(sha256(body))) {
    return { ok: false, reason: "Authorization event 'payload' tag is not the SHA256 of the request body" };
  }
  if (!idMatchesContent(event)) return { ok: false, reason: "Authorization event id does not match its content" };
  if (!verifySignature(event)) return { ok: false, reason: "Authorization event signature is invalid" };
  return { ok: true, pubkey: event.pubkey };
}

// The second half: given a verified signer and the group's x-only pubkey
// as the object reported it (null while nothing is held), the reason this
// caller is refused, or null when they are the group.
export function groupSignerReason(signer: string, groupPubkey: string | null): string | null {
  if (groupPubkey === null) return UNCLAIMED_REASON;
  if (signer !== groupPubkey) return WRONG_SIGNER_REASON;
  return null;
}
