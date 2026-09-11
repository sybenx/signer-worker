// Two more actors for the bunker tests: a peer that ANSWERS rounds the
// Worker initiates, the way a bifrost node on a phone would, and a NIP-46
// client app.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  createEcdhPkg,
  createPsigPkg,
  deriveSecretNonce,
  generateNoncePairs,
  getSessionCtx,
  type DerivedPublicNonce,
} from "../../src/frost.ts";
import { NIP46_KIND, decryptTransport, encryptTransport, type Scheme } from "../../src/nip46.ts";
import { signEvent, type NostrEvent } from "../../src/nostr.ts";
import { parseEcdhRequest, parseSignSession } from "../../src/schema.ts";
import { acceptMessage, unwrapRpc, type RequestMessage } from "../../src/wire.ts";
import type { Peer } from "./peer.ts";
import { connectRelay, type Frame, type RelayConn } from "./socket.ts";

// Hands the Worker `count` of this peer's nonces (bifrost's ping with a
// package) so the Worker can initiate toward it; the codes derive from the
// peer's own share, so nothing needs remembering.
export async function handOverNonces(peer: Peer, count = 20): Promise<DerivedPublicNonce[]> {
  const nonces = generateNoncePairs(peer.share.seckey, count);
  const { ok } = await peer.request("ping", [JSON.stringify({ version: 2, nonces })]);
  if (!ok[2]) throw new Error(`ping refused: ${ok[3]}`);
  return nonces;
}

// Answers sign and ecdh requests addressed to this peer until stopped.
// Returns what it served, for assertions.
export function servePeer(peer: Peer): { served: RequestMessage[]; stop: () => void } {
  const served: RequestMessage[] = [];
  let running = true;
  void (async () => {
    while (running) {
      let frame: Frame;
      try {
        frame = await peer.conn.nextMessage(500);
      } catch {
        continue;
      }
      if (frame[0] !== "EVENT") continue;
      const event = frame[2] as NostrEvent;
      const unwrapped = unwrapRpc(peer.share.seckey, event);
      if (!unwrapped.ok || unwrapped.message.type !== "request") continue;
      const request = unwrapped.message;
      served.push(request);
      if (request.method === "sign") {
        const session = parseSignSession(request.params[0]);
        if (!session) continue;
        const ours = session.nonces?.find((n) => n.idx === peer.share.idx);
        if (!ours) continue;
        const pkg = createPsigPkg(getSessionCtx(peer.group, session), peer.share, deriveSecretNonce(peer.share.seckey, ours.code));
        peer.conn.send(["EVENT", peer.wrap(acceptMessage(request, pkg))]);
      } else if (request.method === "ecdh") {
        const req = parseEcdhRequest(request.params[0]);
        if (!req) continue;
        peer.conn.send(["EVENT", peer.wrap(acceptMessage(request, createEcdhPkg(req.members, req.ecdhPks, peer.share)))]);
      }
    }
  })();
  return { served, stop: () => (running = false) };
}

// A nostr app speaking NIP-46 to the bunker over this relay.
export class Client {
  readonly secretKey = bytesToHex(schnorr.keygen().secretKey);
  readonly pubkey = bytesToHex(schnorr.getPublicKey(hexToBytes(this.secretKey)));
  conn!: RelayConn;

  constructor(
    readonly bunkerPubkey: string,
    readonly scheme: Scheme = "nip44",
  ) {}

  async connect(): Promise<void> {
    this.conn = await connectRelay();
    this.conn.send(["REQ", "app", { kinds: [NIP46_KIND], "#p": [this.pubkey] }]);
    const eose = await this.conn.nextMessage();
    if (eose[0] !== "EOSE") throw new Error(`expected EOSE, got ${JSON.stringify(eose)}`);
  }

  async call(method: string, params: string[], timeoutMs = 4000): Promise<{ ok: [string, string, boolean, string]; response: { id: string; result?: string; error?: string } | null }> {
    const id = bytesToHex(schnorr.keygen().secretKey).slice(0, 16);
    const content = encryptTransport(this.secretKey, this.bunkerPubkey, JSON.stringify({ id, method, params }), this.scheme);
    const event = signEvent(this.secretKey, { kind: NIP46_KIND, tags: [["p", this.bunkerPubkey]], content });
    this.conn.send(["EVENT", event]);
    const ok = (await this.conn.nextMessage()) as [string, string, boolean, string];
    if (ok[0] !== "OK") throw new Error(`expected OK, got ${JSON.stringify(ok)}`);
    if (!ok[2]) return { ok, response: null };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let frame: Frame;
      try {
        frame = await this.conn.nextMessage(deadline - Date.now());
      } catch {
        return { ok, response: null };
      }
      if (frame[0] !== "EVENT") continue;
      const ev = frame[2] as NostrEvent;
      if (ev.kind !== NIP46_KIND) continue;
      const { plaintext } = decryptTransport(this.secretKey, ev.pubkey, ev.content);
      const parsed = JSON.parse(plaintext) as { id: string; result?: string; error?: string };
      if (parsed.id === id) return { ok, response: parsed };
    }
    return { ok, response: null };
  }

  close(): void {
    this.conn.close();
  }
}
