// QR Secret Transfer, Receiver side, with no DOM and no socket -- so the
// browser page (src/page/pair.ts) is glue, and this is what the suite
// tests. Section numbers refer to QR_SECRET_TRANSFER.md 1.4-draft in
// github.com/sybenx/nostr-key-management.
//
// This page is the Receiver of Flow A (7): it shows a QR, the phone that
// scans it is the Sender and speaks first. Profile `frost-share`
// (NKM 3.3): the payload is a bfgroup and a bfshare (src/credentials.ts).
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { computeEventId, isHex32, parseEventShape, signEvent, verifySignature, type NostrEvent } from "./nostr.ts";
import { nip44Decrypt, nip44Encrypt, sharedSecret } from "./wire.ts";
import { parseCredentialPair, type Credentials } from "./credentials.ts";

export const QRST_VERSION = 1;
export const PROFILE_FROST_SHARE = "frost-share";
// 2: session lifetime. 11.4: SLACK, normative.
export const SESSION_SECONDS = 600;
export const SLACK_SECONDS = 120;
// 13: at most three held candidates.
export const MAX_CANDIDATES = 3;

// 11.4: provisional kinds, checked free of collision 2026-09-02.
export const KIND_HELLO = 24401;
export const KIND_REQUEST = 24402;
export const KIND_NONCE = 24403;
export const KIND_REVEAL = 24404;
export const KIND_PAYLOAD = 24405;
export const KIND_ACK = 24406;
export const KIND_ABORT = 24407;
export const KIND_SEAL = 13;
export const KIND_GIFT_WRAP = 1059;

// --- Burners and npubs ----------------------------------------------------

export interface Burner {
  secretKey: string;
  pubkey: string;
}

export function generateBurner(): Burner {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKey: bytesToHex(secretKey), pubkey: bytesToHex(publicKey) };
}

export function npubEncode(pubkeyHex: string): string {
  return bech32.encode("npub", bech32.toWords(hexToBytes(pubkeyHex)), false);
}

export function npubDecode(npub: string): string | null {
  try {
    const { prefix, words } = bech32.decode(npub.toLowerCase() as `${string}1${string}`, false);
    if (prefix !== "npub") return null;
    const bytes = bech32.fromWords(words);
    return bytes.length === 32 ? bytesToHex(new Uint8Array(bytes)) : null;
  } catch {
    return null;
  }
}

// --- Pairing links (11.2, 12.3) -------------------------------------------

export interface OfferLink {
  // The bounce host (11.2a), with no scheme.
  host: string;
  npub: string;
  relays: string[];
  // REQUIRED for a web client (11.2).
  origin: string;
  profile?: string;
}

// https://<host>/pair#v=1&mode=offer&p=frost-share&npub=...&relay=...&origin=...
// Everything after `#`, so nothing reaches the host or its logs.
export function buildOfferLink(link: OfferLink): string {
  const params = new URLSearchParams();
  params.set("v", String(QRST_VERSION));
  params.set("mode", "offer");
  params.set("p", link.profile ?? PROFILE_FROST_SHARE);
  params.set("npub", link.npub);
  for (const relay of link.relays.slice(0, 4)) params.append("relay", relay);
  params.set("origin", link.origin);
  return `https://${link.host}/pair#${params.toString()}`;
}

// frost://<npub>?v=1&mode=offer&p=frost-share&relay=<wss>&secret=<hex>
// (12.3). The paste form; carries the returned-secret handshake.
export function buildFrostUri(link: OfferLink & { secret: string }): string {
  const params = new URLSearchParams();
  params.set("v", String(QRST_VERSION));
  params.set("mode", "offer");
  params.set("p", link.profile ?? PROFILE_FROST_SHARE);
  for (const relay of link.relays.slice(0, 4)) params.append("relay", relay);
  params.set("origin", link.origin);
  params.set("secret", link.secret);
  return `frost://${link.npub}?${params.toString()}`;
}

export interface ParsedPairing {
  version: number;
  mode: "offer" | "request";
  profile: string;
  npub: string;
  pubkey: string;
  relays: string[];
  origin?: string;
  secret?: string;
}

// Both forms. Null for unknown `v`, missing `mode`, missing `p`, or a
// burner whose checksum fails (11.2, 12.1).
export function parsePairingUri(uri: string): ParsedPairing | null {
  let params: URLSearchParams;
  let npub: string | null = null;
  const text = uri.trim();
  if (text.startsWith("frost://")) {
    const rest = text.slice("frost://".length);
    const q = rest.indexOf("?");
    npub = q === -1 ? rest : rest.slice(0, q);
    params = new URLSearchParams(q === -1 ? "" : rest.slice(q + 1));
  } else {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    npub = params.get("npub");
  }
  if (params.get("v") !== String(QRST_VERSION)) return null;
  const mode = params.get("mode");
  if (mode !== "offer" && mode !== "request") return null;
  const profile = params.get("p");
  if (!profile || !/^[a-z0-9-]{1,24}$/.test(profile)) return null;
  if (!npub) return null;
  const pubkey = npubDecode(npub);
  if (pubkey === null) return null;
  const relays = params.getAll("relay").filter((r) => /^wss?:\/\//.test(r)).slice(0, 4);
  const out: ParsedPairing = { version: QRST_VERSION, mode, profile, npub, pubkey, relays };
  const origin = params.get("origin");
  if (origin) out.origin = origin;
  const secret = params.get("secret");
  if (secret && /^[0-9a-f]{64}$/.test(secret)) out.secret = secret;
  return out;
}

// --- Commit and SAS (6) ----------------------------------------------------

const enc = new TextEncoder();

// commit = SHA-256("qrst-commit" || v || C.pub || nonce_C), v as one byte.
export function commitHash(version: number, contactingPub: string, nonceC: string): string {
  return bytesToHex(
    sha256(concatBytes(enc.encode("qrst-commit"), new Uint8Array([version]), hexToBytes(contactingPub), hexToBytes(nonceC))),
  );
}

// code = SHA-256("qrst-sas" || v || len(p) || p || SND.pub || RCV.pub || nonce_S || nonce_R)
// digits = (code[0..5] as u40 BE) mod 100_000, zero-padded to 5.
export function sasDigits(
  version: number,
  profile: string,
  sndPub: string,
  rcvPub: string,
  nonceS: string,
  nonceR: string,
): string {
  const p = enc.encode(profile);
  const code = sha256(
    concatBytes(
      enc.encode("qrst-sas"),
      new Uint8Array([version]),
      new Uint8Array([p.length]),
      p,
      hexToBytes(sndPub),
      hexToBytes(rcvPub),
      hexToBytes(nonceS),
      hexToBytes(nonceR),
    ),
  );
  let u40 = 0n;
  for (let i = 0; i < 5; i++) u40 = (u40 << 8n) | BigInt(code[i] as number);
  return String(u40 % 100_000n).padStart(5, "0");
}

// --- Gift wraps (11.4) -----------------------------------------------------

export interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

function conversationSecret(secretKey: string, peerPub: string): Uint8Array {
  return sharedSecret(secretKey, peerPub);
}

// Seal (kind 13, signed by the sender's burner, NIP-44 to the recipient)
// inside a wrap (kind 1059, random one-time key, `p` the recipient,
// true current time, NIP-40 expiration at now + 600). Standard NIP-44
// base64 on both layers.
export function wrapRumor(
  senderSecret: string,
  recipientPub: string,
  rumor: { kind: number; tags?: string[][]; content?: string },
  nowSec: number,
): NostrEvent {
  const senderPub = bytesToHex(schnorr.getPublicKey(hexToBytes(senderSecret)));
  const unsigned = {
    pubkey: senderPub,
    created_at: nowSec,
    kind: rumor.kind,
    tags: rumor.tags ?? [],
    content: rumor.content ?? "",
  };
  const full: Rumor = { ...unsigned, id: computeEventId(unsigned) };
  const seal = signEvent(senderSecret, {
    kind: KIND_SEAL,
    content: nip44Encrypt(conversationSecret(senderSecret, recipientPub), JSON.stringify(full), "base64"),
    created_at: nowSec,
  });
  const wrapKey = bytesToHex(schnorr.keygen().secretKey);
  return signEvent(wrapKey, {
    kind: KIND_GIFT_WRAP,
    tags: [
      ["p", recipientPub],
      ["expiration", String(nowSec + SESSION_SECONDS)],
    ],
    content: nip44Encrypt(conversationSecret(wrapKey, recipientPub), JSON.stringify(seal), "base64"),
    created_at: nowSec,
  });
}

export type Unwrapped = { ok: true; rumor: Rumor; sender: string } | { ok: false; reason: string };

// Attribution (11.4, T5): the rumor's pubkey must equal the key that
// signed the seal. The wrap's own signature is checked too, cheaply,
// though it proves nothing about who sent it.
export function unwrapGiftWrap(recipientSecret: string, wrap: NostrEvent): Unwrapped {
  if (wrap.kind !== KIND_GIFT_WRAP) return { ok: false, reason: "not a gift wrap" };
  if (!verifySignature(wrap)) return { ok: false, reason: "wrap signature invalid" };
  let seal: NostrEvent | null;
  try {
    seal = parseEventShape(JSON.parse(nip44Decrypt(conversationSecret(recipientSecret, wrap.pubkey), wrap.content)));
  } catch {
    return { ok: false, reason: "wrap does not decrypt" };
  }
  if (seal === null || seal.kind !== KIND_SEAL) return { ok: false, reason: "seal malformed" };
  if (!verifySignature(seal)) return { ok: false, reason: "seal signature invalid" };
  let rumorRaw: unknown;
  try {
    rumorRaw = JSON.parse(nip44Decrypt(conversationSecret(recipientSecret, seal.pubkey), seal.content));
  } catch {
    return { ok: false, reason: "seal does not decrypt" };
  }
  const rumor = parseRumor(rumorRaw);
  if (rumor === null) return { ok: false, reason: "rumor malformed" };
  if (rumor.pubkey !== seal.pubkey) return { ok: false, reason: "rumor not attributed to the sealing burner" };
  return { ok: true, rumor, sender: seal.pubkey };
}

function parseRumor(raw: unknown): Rumor | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isHex32(r.pubkey)) return null;
  if (typeof r.created_at !== "number" || !Number.isInteger(r.created_at)) return null;
  if (typeof r.kind !== "number" || !Number.isInteger(r.kind)) return null;
  if (typeof r.content !== "string") return null;
  if (!Array.isArray(r.tags) || !r.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) return null;
  const tags = r.tags as string[][];
  const id = typeof r.id === "string" ? r.id : computeEventId({ pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags, content: r.content });
  return { id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags, content: r.content };
}

function tagValue(tags: string[][], name: string): string | null {
  return tags.find((t) => t[0] === name)?.[1] ?? null;
}

// --- The Receiver's session (7, 9.4, 12.3, 13) -----------------------------

export interface ReceiverConfig {
  burner: Burner;
  // Unix seconds at which the QR was shown.
  startedAt: number;
  profile?: string;
  // 12.3: set when the frost:// form was offered, so a HELLO echoing it
  // is verified without a code.
  secret?: string;
}

export interface Candidate {
  // SND.pub, the sending burner.
  sender: string;
  commit: string;
  nonceR: string;
  nonceS?: string;
  digits?: string;
  // 12.3 returned-secret handshake matched.
  verifiedBySecret: boolean;
  // Held, never committed by this class (7 step 15).
  payload?: string;
  // Set when the operator moved past this candidate or its P4 failed.
  discarded: boolean;
  firstSeen: number;
}

export type ReceiverAction =
  | { type: "publish"; to: string; event: NostrEvent }
  // 7 step 12: display this candidate's code.
  | { type: "code"; sender: string; digits: string }
  // 12.3: no code to show; wait for the payload.
  | { type: "verified"; sender: string }
  // 7 step 15: a payload is held for this sender.
  | { type: "payload"; sender: string }
  // 13: the soft notice, verbatim.
  | { type: "notice"; text: string }
  | { type: "abort"; sender: string };

export const MULTIPLE_RESPONDER_NOTICE =
  "Another device also responded to this code. If that wasn't you, someone nearby may have scanned it. Nothing was shared with them.";

export class ReceiverSession {
  readonly burner: Burner;
  readonly startedAt: number;
  readonly profile: string;
  readonly secret: string | undefined;
  private readonly seenIds = new Set<string>();
  private readonly held: Candidate[] = [];
  private noticed = false;
  private zeroized = false;

  constructor(config: ReceiverConfig) {
    this.burner = config.burner;
    this.startedAt = config.startedAt;
    this.profile = config.profile ?? PROFILE_FROST_SHARE;
    this.secret = config.secret;
  }

  // 11.5: the subscription the page opens on every relay.
  subscriptionFilter(): Record<string, unknown> {
    return { kinds: [KIND_GIFT_WRAP], "#p": [this.burner.pubkey], since: this.startedAt - SLACK_SECONDS };
  }

  expired(nowSec: number): boolean {
    return nowSec > this.startedAt + SESSION_SECONDS;
  }

  candidates(): readonly Candidate[] {
    return this.held;
  }

  // The active candidate: the first responder still standing (13).
  active(): Candidate | null {
    return this.held.find((c) => !c.discarded) ?? null;
  }

  candidate(sender: string): Candidate | null {
    return this.held.find((c) => c.sender === sender) ?? null;
  }

  // 11.4: the rumor's own timestamp against the session window, widened
  // by SLACK at each end. Outside it, the message is discarded entirely.
  private inWindow(createdAt: number): boolean {
    return createdAt >= this.startedAt - SLACK_SECONDS && createdAt <= this.startedAt + SESSION_SECONDS + SLACK_SECONDS;
  }

  handleEvent(wrap: NostrEvent, nowSec: number): ReceiverAction[] {
    if (this.zeroized) return [];
    if (this.seenIds.has(wrap.id)) return [];
    this.seenIds.add(wrap.id);
    const unwrapped = unwrapGiftWrap(this.burner.secretKey, wrap);
    if (!unwrapped.ok) return [];
    const { rumor, sender } = unwrapped;
    if (!this.inWindow(rumor.created_at)) return [];
    if (sender === this.burner.pubkey) return [];

    switch (rumor.kind) {
      case KIND_HELLO:
        return this.onHello(rumor, sender, nowSec);
      case KIND_REVEAL:
        return this.onReveal(rumor, sender);
      case KIND_PAYLOAD:
        return this.onPayload(rumor, sender);
      case KIND_ABORT: {
        const c = this.candidate(sender);
        if (c === null || c.discarded) return [];
        c.discarded = true;
        return [{ type: "abort", sender }];
      }
      default:
        // 11.4: unknown tags are ignored; unknown kinds too.
        return [];
    }
  }

  private onHello(rumor: Rumor, sender: string, nowSec: number): ReceiverAction[] {
    const commit = tagValue(rumor.tags, "commit");
    if (commit === null || !isHex32(commit)) return [];
    // Retransmission from the same burner is not a new responder (13).
    if (this.candidate(sender) !== null) return [];
    const actions: ReceiverAction[] = [];
    if (this.held.length >= MAX_CANDIDATES) return [];
    if (this.held.length > 0 && !this.noticed) {
      this.noticed = true;
      actions.push({ type: "notice", text: MULTIPLE_RESPONDER_NOTICE });
    }
    const echoed = tagValue(rumor.tags, "secret");
    const verifiedBySecret = this.secret !== undefined && echoed !== null && constantTimeEqualHex(echoed, this.secret);
    const candidate: Candidate = {
      sender,
      commit,
      nonceR: bytesToHex(randomBytes(32)),
      verifiedBySecret,
      discarded: false,
      firstSeen: nowSec,
    };
    this.held.push(candidate);
    // 7 step 8: NONCE to the sender, always -- a light-flow sender may
    // still complete the commit exchange, and a code is harmless to
    // derive.
    actions.push({
      type: "publish",
      to: sender,
      event: wrapRumor(this.burner.secretKey, sender, { kind: KIND_NONCE, tags: [["nonce", candidate.nonceR]] }, nowSec),
    });
    if (verifiedBySecret && this.active()?.sender === sender) actions.push({ type: "verified", sender });
    return actions;
  }

  private onReveal(rumor: Rumor, sender: string): ReceiverAction[] {
    const c = this.candidate(sender);
    if (c === null || c.discarded || c.nonceS !== undefined) return [];
    const nonceS = tagValue(rumor.tags, "nonce");
    if (nonceS === null || !isHex32(nonceS)) return [];
    // 7 step 12: verify the commit. A mismatch is not a responder at all.
    if (commitHash(QRST_VERSION, sender, nonceS) !== c.commit) {
      c.discarded = true;
      return [];
    }
    c.nonceS = nonceS;
    c.digits = sasDigits(QRST_VERSION, this.profile, sender, this.burner.pubkey, nonceS, c.nonceR);
    if (c.verifiedBySecret) return [];
    // Display is lazy (13): only the active candidate's code is shown.
    return this.active()?.sender === sender ? [{ type: "code", sender, digits: c.digits }] : [];
  }

  private onPayload(rumor: Rumor, sender: string): ReceiverAction[] {
    const c = this.candidate(sender);
    if (c === null || c.discarded || c.payload !== undefined) return [];
    // 7 step 15: hold, keyed by the sending burner. Never commit here.
    c.payload = rumor.content;
    return [{ type: "payload", sender }];
  }

  // 9.2 / 13: the value the Sender obtained matched none of ours, or the
  // operator says this is not their device. Moves the display on.
  advance(): ReceiverAction[] {
    const current = this.active();
    if (current === null) return [];
    current.discarded = true;
    const next = this.active();
    if (next === null) return [];
    if (next.verifiedBySecret) return [{ type: "verified", sender: next.sender }];
    if (next.digits !== undefined) return [{ type: "code", sender: next.sender, digits: next.digits }];
    return [];
  }

  // 7 step 16: the candidate the Sender confirmed, P4-checked. Null when
  // nothing is held for it or the check fails (the candidate is then
  // discarded, 13).
  inspect(sender: string): { ok: true; creds: Credentials } | { ok: false; reason: string } {
    const c = this.candidate(sender);
    if (c === null || c.discarded) return { ok: false, reason: "no such responder" };
    if (c.payload === undefined) return { ok: false, reason: "nothing received from this device yet" };
    if (!c.verifiedBySecret && c.digits === undefined) return { ok: false, reason: "this device has not completed pairing" };
    const parsed = parseCredentialPair(c.payload);
    if (!parsed.ok) {
      c.discarded = true;
      return parsed;
    }
    return parsed;
  }

  // 7 step 17: after the payload is committed elsewhere. The ACK to the
  // confirmed sender, then everything held is gone.
  ack(sender: string, nowSec: number): NostrEvent {
    const event = wrapRumor(this.burner.secretKey, sender, { kind: KIND_ACK }, nowSec);
    this.zeroize();
    return event;
  }

  // Declined, or over: burner and every held payload are wiped.
  zeroize(): void {
    this.zeroized = true;
    for (const c of this.held) {
      delete c.payload;
      delete c.nonceS;
      delete c.digits;
    }
    this.held.length = 0;
    (this.burner as { secretKey: string }).secretKey = "0".repeat(64);
  }
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomSecretHex(): string {
  return bytesToHex(randomBytes(32));
}
