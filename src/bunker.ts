// The bunker half of the object: what NIP-46 asks for, turned into rounds
// this Worker initiates toward the group's other devices over their own
// subscriptions, and back into a NIP-46 answer when the parts arrive.
//
// Pure with respect to storage and sockets: every function takes what it
// needs and returns what should happen. src/signer.ts owns the SQL rows
// and the delivery. That keeps the arithmetic of "combine these partial
// signatures into a signed event" testable without a WebSocket.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import type { Credentials } from "./credentials.ts";
import {
  combineEcdhPkgs,
  combineSignaturePkgs,
  createEcdhPkg,
  createPsigPkg,
  deriveSecretNonce,
  getGroupId,
  getSessionCtx,
  getSessionId,
  publicNonceFor,
  verifyPsigPkg,
  xOnly,
  type ECDHPackage,
  type MemberPublicNonce,
  type PartialSigPackage,
  type SignSessionPackage,
} from "./frost.ts";
import { computeEventId, type NostrEvent } from "./nostr.ts";
import { nip04Decrypt, nip04Encrypt } from "./nip04.ts";
import { nip44Decrypt, nip44Encrypt } from "./wire.ts";

// How long a round waits for the other devices before the app is told
// nothing answered. bifrost's own request timeout is 15 s; a phone that
// has to wake its radio can take a few of those.
export const ROUND_SECONDS = 30;

// One round in flight: what was asked, by whom, and what has come back.
// Stored as JSON in `pending` so it survives hibernation between the
// request going out and the parts coming in.
export interface SignRound {
  kind: "sign";
  session: SignSessionPackage;
  // This share's own nonce code for the round; the secret is re-derived.
  ourCode: string;
  // The event to finish, without id and sig.
  template: Omit<NostrEvent, "id" | "sig">;
  eventId: string;
  responses: PartialSigPackage[];
}

export interface EcdhRound {
  kind: "ecdh";
  members: number[];
  // 33-byte compressed hex, the third party.
  target: string;
  op: "nip44_encrypt" | "nip44_decrypt" | "nip04_encrypt" | "nip04_decrypt";
  text: string;
  responses: ECDHPackage[];
}

export type Round = SignRound | EcdhRound;

export interface PendingRound {
  // The RPC request id shared by every peer's copy of the request.
  id: string;
  clientPubkey: string;
  clientRequestId: string;
  scheme: "nip44" | "nip04";
  expiresAt: number;
  round: Round;
}

// nips/46.md sign_event: the app sends an event with kind, content, tags
// and maybe created_at; the signer sets pubkey, id and sig.
export function normalizeTemplate(raw: unknown, groupPubkey: string, nowSec: number): Omit<NostrEvent, "id" | "sig"> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const kind = Number(t.kind);
  if (!Number.isInteger(kind) || kind < 0) return null;
  const created_at = typeof t.created_at === "number" && Number.isInteger(t.created_at) ? t.created_at : nowSec;
  const content = typeof t.content === "string" ? t.content : "";
  const tags = Array.isArray(t.tags)
    ? t.tags.filter((tag): tag is unknown[] => Array.isArray(tag)).map((tag) => tag.map((v) => String(v ?? "")))
    : [];
  return { pubkey: groupPubkey, kind, created_at, content, tags };
}

// bifrost api/sign.ts collect_nonces_for_session + create_session_pkg,
// requester side: the peers' nonces were consumed by the caller, ours is
// fresh, members are every participant sorted.
export function buildSignRound(
  creds: Credentials,
  peerNonces: MemberPublicNonce[],
  template: Omit<NostrEvent, "id" | "sig">,
  nowSec: number,
): SignRound {
  const ourCode = bytesToHex(randomBytes(32));
  const ours: MemberPublicNonce = { ...publicNonceFor(deriveSecretNonce(creds.share.seckey, ourCode)), idx: creds.share.idx };
  const eventId = computeEventId(template);
  const members = [...peerNonces.map((n) => n.idx), creds.share.idx].sort((a, b) => a - b);
  const base = { content: null, hashes: [[eventId] as [string]], members, stamp: nowSec, type: "message" };
  const gid = getGroupId(creds.group);
  const sid = getSessionId(gid, base);
  return { kind: "sign", session: { ...base, gid, sid, nonces: [...peerNonces, ours] }, ourCode, template, eventId, responses: [] };
}

// A peer's partial signature, checked against the round before it counts.
export function acceptPsig(creds: Credentials, round: SignRound, pkg: PartialSigPackage): string | null {
  if (round.responses.some((r) => r.idx === pkg.idx)) return "duplicate response";
  if (!round.session.members.includes(pkg.idx)) return "response from a member outside the round";
  const ctx = getSessionCtx(creds.group, round.session);
  const reason = verifyPsigPkg(ctx, pkg);
  if (reason !== null) return reason;
  round.responses.push(pkg);
  return null;
}

export function signRoundComplete(round: SignRound): boolean {
  return round.responses.length >= round.session.members.length - 1;
}

// bifrost finalize_sign_response, plus the event assembly NIP-46 wants.
// Throws if the combined signature does not verify, which would mean a
// peer's part was for a different message than it claimed.
export function finishSignRound(creds: Credentials, round: SignRound): NostrEvent {
  const ctx = getSessionCtx(creds.group, round.session);
  const ours = createPsigPkg(ctx, creds.share, deriveSecretNonce(creds.share.seckey, round.ourCode));
  const [entry] = combineSignaturePkgs(ctx, [...round.responses, ours]);
  if (!entry) throw new Error("no signature produced");
  const [, , sig] = entry;
  const groupX = xOnly(creds.group.group_pk);
  if (!schnorr.verify(hexToBytes(sig), hexToBytes(round.eventId), hexToBytes(groupX))) {
    throw new Error("combined signature does not verify against the group key");
  }
  return { ...round.template, id: round.eventId, sig };
}

export function acceptEcdh(round: EcdhRound, pkg: ECDHPackage): string | null {
  if (round.responses.some((r) => r.idx === pkg.idx)) return "duplicate response";
  if (!round.members.includes(pkg.idx)) return "response from a member outside the round";
  if (!pkg.entries.some((e) => e.ecdh_pk === round.target)) return "response is for a different key";
  round.responses.push(pkg);
  return null;
}

export function ecdhRoundComplete(round: EcdhRound): boolean {
  return round.responses.length >= round.members.length - 1;
}

// bifrost ecdh_batch_request_api's tail: our own share, the peers',
// combined into the shared point; then the NIP-44 or NIP-04 operation the
// app asked for, under that point's x-coordinate, exactly as igloo-server
// derives it (routes/crypto-utils.ts deriveNip44ConversationKey).
export function finishEcdhRound(creds: Credentials, round: EcdhRound): string {
  const ours = createEcdhPkg(round.members, [round.target], creds.share);
  const point = combineEcdhPkgs([ours, ...round.responses], round.target);
  const sharedX = hexToBytes(point).slice(1);
  switch (round.op) {
    case "nip44_encrypt":
      return nip44Encrypt(sharedX, round.text, "base64");
    case "nip44_decrypt":
      return nip44Decrypt(sharedX, round.text);
    case "nip04_encrypt":
      return nip04Encrypt(sharedX, round.text);
    case "nip04_decrypt":
      return nip04Decrypt(sharedX, round.text);
  }
}
