// A bifrost-shaped peer: holds one share of the same group, connects to
// the signer as its relay the way @vbyte/nostr-sdk's NostrNode does
// (one subscription on `authors: [every member], kinds: [20000]`), and
// speaks the 2.x RPC envelope through src/wire.ts. What a real bifrost
// node would do on the wire, without bifrost.
import { SELF } from "cloudflare:test";
import { encodeGroupPackage, encodeSharePackage, getPubkey, xOnly, type GroupPackage, type SharePackage } from "../../src/frost.ts";
import type { NostrEvent } from "../../src/nostr.ts";
import { RPC_KIND, requestMessage, unwrapRpc, wrapRpc, type RequestMessage, type RpcMessage } from "../../src/wire.ts";
import { generateDealerPackage, type DealerPackage } from "./group.ts";
import { connectRelay, type Frame, type RelayConn } from "./socket.ts";

export interface Fixture extends DealerPackage {
  // The share the Worker holds (index 1) and its strings.
  signerShare: SharePackage;
  groupStr: string;
  shareStr: string;
  signerPubkey: string;
}

export function fixture(threshold = 2, count = 3): Fixture {
  const dealer = generateDealerPackage(threshold, count);
  const signerShare = dealer.shares[0]!;
  return {
    ...dealer,
    signerShare,
    groupStr: encodeGroupPackage(dealer.group),
    shareStr: encodeSharePackage(signerShare),
    signerPubkey: getPubkey(signerShare.seckey, "bip340"),
  };
}

// Claims over HTTP, as the page does.
export async function claim(fx: Fixture, profile?: { name?: string; picture?: string }): Promise<void> {
  const res = await SELF.fetch("https://example.com/api/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: fx.groupStr, share: fx.shareStr, profile }),
  });
  if (res.status !== 200) throw new Error(`claim failed: ${res.status} ${await res.text()}`);
}

export class Peer {
  readonly pubkey: string;
  conn!: RelayConn;
  private readonly seen = new Set<string>();

  constructor(
    readonly group: GroupPackage,
    readonly share: SharePackage,
    readonly signerPubkey: string,
    readonly ip?: string,
  ) {
    this.pubkey = getPubkey(share.seckey, "bip340");
  }

  async connect(subscribe = true): Promise<void> {
    this.conn = await connectRelay(this.ip);
    if (subscribe) {
      const eose = await this.subscribe("node");
      if (eose[0] !== "EOSE") throw new Error(`expected EOSE, got ${JSON.stringify(eose)}`);
    }
  }

  // NostrNode._subscribe's filter.
  subscribe(subId: string, filter?: Record<string, unknown>): Promise<Frame> {
    this.conn.send([
      "REQ",
      subId,
      filter ?? { authors: this.group.members.map((m) => xOnly(m.pubkey)), kinds: [RPC_KIND] },
    ]);
    return this.conn.nextMessage();
  }

  wrap(message: RpcMessage): NostrEvent {
    return wrapRpc(this.share.seckey, message, this.signerPubkey);
  }

  // Sends a request and returns the OK plus, if the OK accepted it, the
  // decrypted response delivered on the subscription.
  async request(
    method: string,
    params: string[],
  ): Promise<{ ok: [string, string, boolean, string]; request: RequestMessage; response: RpcMessage | null }> {
    const request = requestMessage(method, params);
    const event = this.wrap(request);
    this.conn.send(["EVENT", event]);
    const ok = (await this.conn.nextMessage()) as [string, string, boolean, string];
    if (ok[0] !== "OK" || ok[1] !== event.id) throw new Error(`expected OK for ${event.id}, got ${JSON.stringify(ok)}`);
    if (!ok[2]) return { ok, request, response: null };
    const response = await this.awaitResponse(request.id);
    return { ok, request, response };
  }

  // The next EVENT frame whose payload is a response to `id`; null on
  // timeout, which is itself an assertion in some tests.
  async awaitResponse(id: string, timeoutMs = 1500): Promise<RpcMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let frame: Frame;
      try {
        frame = await this.conn.nextMessage(deadline - Date.now());
      } catch {
        return null;
      }
      if (frame[0] !== "EVENT") continue;
      const event = frame[2] as NostrEvent;
      if (this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      const unwrapped = unwrapRpc(this.share.seckey, event);
      if (!unwrapped.ok) continue;
      if (unwrapped.message.id === id) return unwrapped.message;
    }
    return null;
  }

  close(): void {
    this.conn.close();
  }
}
