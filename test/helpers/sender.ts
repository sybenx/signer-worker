// A QRST Sender (Flow A: the phone that scanned the QR), just enough of
// one to drive the Receiver in src/qrst.ts through every step. Section
// numbers refer to QR_SECRET_TRANSFER.md.
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import {
  KIND_ABORT,
  KIND_HELLO,
  KIND_PAYLOAD,
  KIND_REVEAL,
  QRST_VERSION,
  commitHash,
  generateBurner,
  sasDigits,
  unwrapGiftWrap,
  wrapRumor,
  type Burner,
} from "../../src/qrst.ts";
import type { NostrEvent } from "../../src/nostr.ts";

export class Sender {
  readonly burner: Burner = generateBurner();
  readonly nonceS = bytesToHex(randomBytes(32));
  nonceR: string | null = null;

  constructor(
    readonly receiverPub: string,
    readonly profile = "frost-share",
  ) {}

  // 7 step 6. `secret` echoes the frost:// token's secret (12.3).
  hello(nowSec: number, secret?: string): NostrEvent {
    const tags = [["commit", commitHash(QRST_VERSION, this.burner.pubkey, this.nonceS)]];
    if (secret !== undefined) tags.push(["secret", secret]);
    return wrapRumor(this.burner.secretKey, this.receiverPub, { kind: KIND_HELLO, tags }, nowSec);
  }

  // 7 step 9.
  receive(wrap: NostrEvent): void {
    const u = unwrapGiftWrap(this.burner.secretKey, wrap);
    if (!u.ok) throw new Error(u.reason);
    const nonce = u.rumor.tags.find((t) => t[0] === "nonce")?.[1];
    if (nonce) this.nonceR = nonce;
  }

  // 7 step 10.
  reveal(nowSec: number): NostrEvent {
    return wrapRumor(this.burner.secretKey, this.receiverPub, { kind: KIND_REVEAL, tags: [["nonce", this.nonceS]] }, nowSec);
  }

  // 7 step 11: the code this side derives and compares against the
  // Receiver's screen.
  digits(): string {
    if (this.nonceR === null) throw new Error("no NONCE yet");
    return sasDigits(QRST_VERSION, this.profile, this.burner.pubkey, this.receiverPub, this.nonceS, this.nonceR);
  }

  // 7 step 14.
  payload(content: string, nowSec: number): NostrEvent {
    return wrapRumor(this.burner.secretKey, this.receiverPub, { kind: KIND_PAYLOAD, content }, nowSec);
  }

  abort(nowSec: number): NostrEvent {
    return wrapRumor(this.burner.secretKey, this.receiverPub, { kind: KIND_ABORT }, nowSec);
  }
}
