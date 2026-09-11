// The echo Igloo listens for after a share is imported elsewhere.
//
// igloo-core 0.2.4 (src/echo.ts awaitShareEcho / startListeningForAllEchoes)
// runs a bifrost 1.x node on the share and resolves when a message with
// `tag === "/echo/req"` arrives whose data is the string "echo" or an
// even-length hex challenge. That node speaks @cmdcode/nostr-p2p 2.0.11:
// kind 20004, `p`-tagged to the recipient, content AES-256-GCM under the
// ECDH x-coordinate with a 24-byte IV, `<ciphertext b64url>?iv=<iv b64url>`,
// plaintext `JSON.stringify([tag, id, data])`. igloo-server's
// broadcastCredentialEcho (src/node/manager.ts) publishes exactly this,
// to the share's own pubkey.
//
// So this file speaks 1.x on purpose, and only here: it is a one-shot
// courtesy to the device that handed the share over, sent once after the
// claim, and it is the ONLY place this Worker produces the 1.x format.
// Signing traffic is 2.x (src/wire.ts). When FROSTR-ORG/bifrost#12 is
// answered, this file either goes or becomes the rule; see docs/budget.md
// "The stack question".
import { gcm } from "@noble/ciphers/aes.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { base64urlnopad } from "@scure/base";
import { getPubkey } from "./frost.ts";
import { signEvent, type NostrEvent } from "./nostr.ts";
import { sharedSecret } from "./wire.ts";

export const LEGACY_RPC_KIND = 20004;
export const ECHO_TAG = "/echo/req";

// Signed by the share key, addressed to the share key: only a holder of
// this same share can read it, and that is the device being told.
export function buildEchoEvent(shareSecret: string, challengeHex: string = bytesToHex(randomBytes(16))): NostrEvent {
  const selfPub = getPubkey(shareSecret, "bip340");
  const secret = sharedSecret(shareSecret, selfPub);
  const iv = randomBytes(24);
  const id = bytesToHex(randomBytes(16));
  const plaintext = new TextEncoder().encode(JSON.stringify([ECHO_TAG, id, challengeHex]));
  const ciphertext = gcm(secret, iv).encrypt(plaintext);
  const content = `${base64urlnopad.encode(ciphertext)}?iv=${base64urlnopad.encode(iv)}`;
  return signEvent(shareSecret, { kind: LEGACY_RPC_KIND, tags: [["p", selfPub]], content });
}

// The inverse, for the suite: proves the event decrypts to the envelope
// igloo-core matches on.
export function readEchoEvent(shareSecret: string, event: NostrEvent): [tag: string, id: string, data: string] | null {
  try {
    const [ct, iv] = event.content.split("?iv=");
    if (ct === undefined || iv === undefined) return null;
    const secret = sharedSecret(shareSecret, event.pubkey);
    const plaintext = gcm(secret, base64urlnopad.decode(iv)).decrypt(base64urlnopad.decode(ct));
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((x) => typeof x === "string")) return null;
    return parsed as [string, string, string];
  } catch {
    return null;
  }
}
