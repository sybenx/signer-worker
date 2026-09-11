// NIP-04 (nips/04.md), the legacy encryption some NIP-46 clients still
// use for the transport: AES-256-CBC under the raw ECDH x-coordinate,
// `<base64 ciphertext>?iv=<base64 iv>`. Kept only so those clients can
// connect; NIP-44 is what this Worker prefers and what it answers in when
// the request came that way.
import { cbc } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

export function isNip04Payload(content: string): boolean {
  return content.includes("?iv=");
}

export function nip04Encrypt(sharedX: Uint8Array, plaintext: string, iv: Uint8Array = randomBytes(16)): string {
  const ciphertext = cbc(sharedX, iv).encrypt(new TextEncoder().encode(plaintext));
  return `${base64.encode(ciphertext)}?iv=${base64.encode(iv)}`;
}

export function nip04Decrypt(sharedX: Uint8Array, content: string): string {
  const at = content.indexOf("?iv=");
  if (at === -1) throw new Error("not a NIP-04 payload");
  const ciphertext = base64.decode(content.slice(0, at));
  const iv = base64.decode(content.slice(at + 4));
  if (iv.length !== 16) throw new Error("IV must be 16 bytes");
  return new TextDecoder().decode(cbc(sharedX, iv).decrypt(ciphertext));
}
