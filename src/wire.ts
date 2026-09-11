// The bifrost 2.x transport, byte for byte, without bifrost's client.
//
// bifrost speaks to its peers through @vbyte/nostr-sdk's NostrNode: one
// kind-20000 event per message, `p`-tagged to the recipient, content
// encrypted with NIP-44 v2 under the ECDH x-coordinate of the two share
// keys, carrying a small JSON-RPC envelope. This file reproduces exactly
// that (ported from @vbyte/nostr-sdk 1.0.1 lib/rpc.js, lib/encrypt.js and
// crypto/ecc.js, MIT, Christopher Scott) so that a peer running bifrost
// cannot tell this Worker from another bifrost node.
//
// Two things here are deliberately NOT the NIP-44 standard, because
// bifrost's are not and interoperating with bifrost is the point:
//   - the payload is base64url without padding, where NIP-44 says base64;
//     decode accepts either, encode produces bifrost's;
//   - the shared secret is the raw ECDH x-coordinate (no hashing), which
//     is also what NIP-44's conversation key is derived from, so the
//     result is the same bytes -- noted so nobody "fixes" it.
//
// docs/PROTOCOL.md in bifrost describes an older envelope ({tag, data,
// env}) and ChaCha20-Poly1305; the code in 2.0.2 does what is written
// here, and the code is what peers run.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { equalBytes } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base64, base64urlnopad } from "@scure/base";
import { isHex32, signEvent, type NostrEvent } from "./nostr.ts";

// @vbyte/nostr-sdk class/node.js NODE_CONFIG: `rpc_kind: 20000`. bifrost's
// own const.ts names 20004 as MSG_EVENT but never passes it to the node,
// so 20000 is what is on the wire.
export const RPC_KIND = 20000;
// @vbyte/nostr-sdk const.js PROTOCOL_VERSION.
export const RPC_VERSION = 1;

export interface RequestMessage {
  type: "request";
  id: string;
  method: string;
  params: string[];
  peers: string[];
  version: number;
}
export interface AcceptMessage {
  type: "accept";
  id: string;
  data: unknown;
  status: true;
  version: number;
}
export interface RejectMessage {
  type: "reject";
  id: string;
  reason: string;
  status: false;
  version: number;
}
export type RpcMessage = RequestMessage | AcceptMessage | RejectMessage;

// crypto/ecc.js get_shared_secret: compressed ECDH, x-coordinate only.
// `peer` is 32-byte x-only or 33-byte compressed hex.
export function sharedSecret(seckeyHex: string, peerPubkeyHex: string): Uint8Array {
  const compressed = peerPubkeyHex.length === 66 ? peerPubkeyHex : `02${peerPubkeyHex}`;
  return secp256k1.getSharedSecret(hexToBytes(seckeyHex), hexToBytes(compressed), true).slice(1);
}

// --- NIP-44 v2 (nips/44.md), as @vbyte/nostr-sdk implements it ---------

const MIN_PLAINTEXT = 1;
const MAX_PLAINTEXT = 0xffff;

function conversationKey(secret: Uint8Array): Uint8Array {
  return extract(sha256, secret, new TextEncoder().encode("nip44-v2"));
}

function messageKeys(convoKey: Uint8Array, nonce: Uint8Array) {
  const keys = expand(sha256, convoKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

function paddedLength(len: number): number {
  if (!Number.isSafeInteger(len) || len < 1) throw new Error("expected positive integer");
  if (len <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const unpadded = new TextEncoder().encode(plaintext);
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT) throw new Error("invalid plaintext size");
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, len, false);
  return concatBytes(prefix, unpadded, new Uint8Array(paddedLength(len) - len));
}

function unpad(padded: Uint8Array): string {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0);
  const unpadded = padded.subarray(2, 2 + len);
  if (len < MIN_PLAINTEXT || len > MAX_PLAINTEXT || unpadded.length !== len || padded.length !== 2 + paddedLength(len)) {
    throw new Error("invalid padding");
  }
  return new TextDecoder().decode(unpadded);
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== 32) throw new Error("AAD must be 32 bytes");
  return hmac(sha256, key, concatBytes(aad, message));
}

// `encoding` picks the outer text form: bifrost's base64url without
// padding for peer traffic (src/signer.ts), or NIP-44's own base64 for
// the QRST gift wraps (src/qrst.ts), which speak to clients that follow
// the NIP as written.
export function nip44Encrypt(
  secret: Uint8Array,
  plaintext: string,
  encoding: "base64url" | "base64" = "base64url",
  nonce: Uint8Array = randomBytes(32),
): string {
  const keys = messageKeys(conversationKey(secret), nonce);
  const ciphertext = chacha20(keys.chachaKey, keys.chachaNonce, pad(plaintext));
  const mac = hmacAad(keys.hmacKey, ciphertext, nonce);
  const bytes = concatBytes(new Uint8Array([2]), nonce, ciphertext, mac);
  return encoding === "base64" ? base64.encode(bytes) : base64urlnopad.encode(bytes);
}

function decodePayload(payload: string): Uint8Array {
  if (payload.length < 130 || payload.length > 87472) throw new Error("invalid payload length");
  if (payload[0] === "#") throw new Error("unknown encryption version");
  // bifrost writes base64url without padding; a standard NIP-44 peer
  // writes base64 with it. Accept both, since the bytes underneath are
  // the same format.
  try {
    return base64urlnopad.decode(payload);
  } catch {
    return base64.decode(payload);
  }
}

export function nip44Decrypt(secret: Uint8Array, payload: string): string {
  const data = decodePayload(payload);
  if (data.length < 99 || data.length > 65603) throw new Error("invalid data length");
  if (data[0] !== 2) throw new Error("unknown encryption version");
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, -32);
  const mac = data.subarray(-32);
  const keys = messageKeys(conversationKey(secret), nonce);
  if (!equalBytes(hmacAad(keys.hmacKey, ciphertext, nonce), mac)) throw new Error("invalid MAC");
  return unpad(chacha20(keys.chachaKey, keys.chachaNonce, ciphertext));
}

// --- RPC envelope -------------------------------------------------------

// lib/util.js generate_label(32): 32 random bytes, base64url unpadded.
export function messageId(): string {
  return base64urlnopad.encode(randomBytes(32));
}

export function requestMessage(method: string, params: string[], id: string = messageId()): RequestMessage {
  return { id, method, params, peers: [], type: "request", version: RPC_VERSION };
}

export function acceptMessage(request: RequestMessage, data: unknown): AcceptMessage {
  return { id: request.id, data, status: true, type: "accept", version: RPC_VERSION };
}

export function rejectMessage(request: RequestMessage, reason: string): RejectMessage {
  return { id: request.id, reason, status: false, type: "reject", version: RPC_VERSION };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

// schema/rpc.js message_payload, by hand.
export function parseRpcMessage(raw: unknown): RpcMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.version !== "number") return null;
  switch (m.type) {
    case "request":
      if (typeof m.method !== "string" || !isStringArray(m.params) || !isStringArray(m.peers)) return null;
      return { type: "request", id: m.id, method: m.method, params: m.params, peers: m.peers, version: m.version };
    case "accept":
      if (m.status !== true || m.data === undefined) return null;
      return { type: "accept", id: m.id, data: m.data, status: true, version: m.version };
    case "reject":
      if (m.status !== false || typeof m.reason !== "string") return null;
      return { type: "reject", id: m.id, reason: m.reason, status: false, version: m.version };
    default:
      return null;
  }
}

// lib/rpc.js wrap_rpc_message: encrypt to the peer, p-tag them, sign with
// our own share key. `peerPubkey` is 32-byte x-only hex.
export function wrapRpc(seckeyHex: string, message: RpcMessage, peerPubkey: string): NostrEvent {
  const content = nip44Encrypt(sharedSecret(seckeyHex, peerPubkey), JSON.stringify(message));
  return signEvent(seckeyHex, { kind: RPC_KIND, content, tags: [["p", peerPubkey]] });
}

export type Unwrapped = { ok: true; message: RpcMessage } | { ok: false; reason: string };

// lib/rpc.js unwrap_rpc_message. The event's own signature is the
// caller's business (nostr.ts verifySignature) -- this decrypts and
// parses, and a failed MAC is the whole answer to "was this for me".
export function unwrapRpc(seckeyHex: string, event: NostrEvent): Unwrapped {
  if (!isHex32(event.pubkey)) return { ok: false, reason: "malformed sender" };
  let plaintext: string;
  try {
    plaintext = nip44Decrypt(sharedSecret(seckeyHex, event.pubkey), event.content);
  } catch (err) {
    return { ok: false, reason: `could not decrypt: ${err instanceof Error ? err.message : String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    return { ok: false, reason: "payload is not JSON" };
  }
  const message = parseRpcMessage(json);
  if (message === null) return { ok: false, reason: "payload is not an RPC message" };
  return { ok: true, message };
}

export function bytesToHexString(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
