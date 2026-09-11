// The page's script. Bundled by scripts/build-page.mjs into
// public/pair.js, which is committed, because the Worker's assets are
// served as files and the deploy button runs no build of its own.
//
// Two states. Unclaimed: run QR Secret Transfer Flow A as the Receiver
// (src/qrst.ts) against the pairing relays, in this browser, and POST the
// verified pair to /api/claim. Claimed: show what the share holder is
// doing. Words: "share", "group", "relay". Never a credential; bech32
// strings and wss:// only inside the diagnostics panel.
import qrcode from "qrcode-generator";
import {
  KIND_GIFT_WRAP,
  ReceiverSession,
  SESSION_SECONDS,
  buildFrostUri,
  buildOfferLink,
  generateBurner,
  npubEncode,
  randomSecretHex,
  type ReceiverAction,
} from "../qrst.ts";
import { parseEventShape, type NostrEvent } from "../nostr.ts";
import type { Credentials } from "../credentials.ts";
import { xOnly } from "../frost.ts";

interface Status {
  version: string;
  claimed: boolean;
  source?: "env" | "claim";
  group?: { name: string | null; picture: string | null; pubkey: string; id: string; threshold: number; members: number };
  share?: { index: number; pubkey: string };
  claimedAt?: number;
  pairing?: { bounceHost: string; relays: string[]; origin: string } | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// --- Relays: the browser's side of the transport --------------------------

class RelayPool {
  private sockets = new Map<string, WebSocket>();
  private outbox: NostrEvent[] = [];
  private closed = false;
  private readonly seen = new Set<string>();
  onEvent: ((e: NostrEvent) => void) | null = null;
  onProfile: ((e: NostrEvent) => void) | null = null;
  readyCount = 0;

  constructor(
    private readonly urls: string[],
    private readonly filter: Record<string, unknown>,
  ) {}

  start(): void {
    for (const url of this.urls) this.connect(url, 0);
  }

  // 11.3: keep re-attempting an unreachable relay for the life of the
  // session, with a capped backoff.
  private connect(url: string, attempt: number): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.retry(url, attempt);
      return;
    }
    this.sockets.set(url, ws);
    ws.onopen = () => {
      ws.send(JSON.stringify(["REQ", "qrst", this.filter]));
      // 11.5: republish the session outbox on every open.
      for (const e of this.outbox) ws.send(JSON.stringify(["EVENT", e]));
    };
    ws.onmessage = (m) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      if (frame[0] === "EOSE" && frame[1] === "qrst") {
        this.readyCount++;
      } else if (frame[0] === "EVENT") {
        const ev = parseEventShape(frame[2]);
        if (!ev || this.seen.has(ev.id)) return;
        this.seen.add(ev.id);
        if (frame[1] === "qrst" && ev.kind === KIND_GIFT_WRAP) this.onEvent?.(ev);
        else if (frame[1] === "profile" && ev.kind === 0) this.onProfile?.(ev);
      } else if (frame[0] === "AUTH") {
        // 11.5: a relay demanding NIP-42 gets the burner, never a
        // long-lived key. Not implemented in this release: the other two
        // relays carry the session.
      }
    };
    ws.onclose = () => {
      this.sockets.delete(url);
      this.retry(url, attempt + 1);
    };
    ws.onerror = () => ws.close();
  }

  private retry(url: string, attempt: number): void {
    if (this.closed) return;
    setTimeout(() => this.connect(url, attempt), Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
  }

  publish(event: NostrEvent): void {
    this.outbox.push(event);
    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["EVENT", event]));
    }
  }

  // Best-effort kind-0 lookup for the P5 rendering.
  requestProfile(pubkey: string): void {
    const req = JSON.stringify(["REQ", "profile", { kinds: [0], authors: [pubkey], limit: 1 }]);
    for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.send(req);
  }

  close(): void {
    this.closed = true;
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    this.outbox = [];
  }
}

// --- Rendering -------------------------------------------------------------

function show(id: string, visible: boolean): void {
  $(id).hidden = !visible;
}

function renderQr(text: string): void {
  // Error correction M and no overlay (11.2b: an overlay would require H).
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function profileFromEvent(ev: NostrEvent): { name?: string; picture?: string } {
  try {
    const c = JSON.parse(ev.content) as Record<string, unknown>;
    const out: { name?: string; picture?: string } = {};
    const name = typeof c.display_name === "string" && c.display_name.trim() ? c.display_name : c.name;
    if (typeof name === "string" && name.trim()) out.name = name.trim();
    if (typeof c.picture === "string") out.picture = c.picture;
    return out;
  } catch {
    return {};
  }
}

function renderClaimed(status: Status): void {
  show("claimed-view", true);
  const g = status.group!;
  const s = status.share!;
  $("group-name").textContent = g.name ?? "Your group";
  const img = $<HTMLImageElement>("group-picture");
  if (g.picture) {
    img.src = g.picture;
    img.hidden = false;
  }
  $("holding").textContent = `Holding share ${s.index} of ${g.members}. Any ${g.threshold} shares sign together; this one signs nothing alone.`;
  $("peers").textContent = "Signing arrives in the next release; this share is held and waiting.";
  $("last-sign").textContent = "No signing yet.";
  $("diag-group-npub").textContent = npubEncode(g.pubkey);
  $("diag-share-npub").textContent = npubEncode(s.pubkey);
  $("diag-relay").textContent = location.origin.replace(/^http/, "ws") + "/";
  $("diag-source").textContent = status.source === "env" ? "set in the environment (OWNER_CREDS)" : "received by pairing";
  show("diagnostics", true);
}

// --- Pairing ---------------------------------------------------------------

function runPairing(status: Status): void {
  const pairing = status.pairing!;
  show("unclaimed-view", true);
  const startedAt = nowSec();
  const burner = generateBurner();
  const secret = randomSecretHex();
  const session = new ReceiverSession({ burner, startedAt, secret });
  const link = { host: pairing.bounceHost, npub: npubEncode(burner.pubkey), relays: pairing.relays, origin: pairing.origin };
  renderQr(buildOfferLink(link));
  $<HTMLInputElement>("frost-uri").value = buildFrostUri({ ...link, secret });

  const pool = new RelayPool(pairing.relays, session.subscriptionFilter());
  let confirmedSender: string | null = null;
  let creds: Credentials | null = null;
  let armed = false;
  let groupProfile: { name?: string; picture?: string } = {};

  const setStep = (text: string) => {
    $("step").textContent = text;
  };

  // 11.3: the probe is advisory. Show transfer UI regardless; say so if
  // nothing answered in three seconds.
  setTimeout(() => {
    if (pool.readyCount === 0) setStep("Still reaching the relays. Scanning works as soon as one answers.");
  }, 3000);

  const expiry = setTimeout(() => {
    setStep("Nothing arrived in ten minutes. Reload to show a fresh code.");
    pool.close();
    session.zeroize();
    show("qr-block", false);
  }, SESSION_SECONDS * 1000);

  function apply(actions: ReceiverAction[]): void {
    for (const a of actions) {
      switch (a.type) {
        case "publish":
          pool.publish(a.event);
          break;
        case "code":
          show("code-block", true);
          $("code").textContent = a.digits;
          setStep("Type this code on your other device.");
          break;
        case "verified":
          setStep("Your other device is connected. Waiting for it to send the share.");
          break;
        case "notice":
          $("notice").textContent = a.text;
          show("notice", true);
          break;
        case "payload":
          maybeOffer(a.sender);
          break;
        case "abort":
          setStep("Your other device stopped. Scan again to start over.");
          break;
      }
    }
  }

  // 7 step 16 / 9.4: the active candidate's payload, P4-checked, rendered
  // per P5, with one confirmation.
  function maybeOffer(sender: string): void {
    const active = session.active();
    if (active === null || active.sender !== sender) return;
    const result = session.inspect(sender);
    if (!result.ok) {
      if (session.candidate(sender)?.discarded) {
        // P4 failed: advance (13).
        setStep("What arrived was not a share of a group. Waiting for another device.");
        apply(session.advance());
      }
      return;
    }
    creds = result.creds;
    confirmedSender = sender;
    show("code-block", false);
    show("qr-block", false);
    show("confirm-block", true);
    const groupPk = xOnly(creds.group.group_pk);
    pool.requestProfile(groupPk);
    $("confirm-who").textContent = `A share of a key with ${creds.group.members.length} shares, any ${creds.group.threshold} of which sign together.`;
    $("confirm-note").textContent =
      "This device will hold one share, not the key. It cannot sign alone, and it cannot sign at all until your other devices list it as a relay.";
  }

  pool.onProfile = (ev) => {
    if (creds === null) return;
    if (ev.pubkey !== xOnly(creds.group.group_pk)) return;
    groupProfile = profileFromEvent(ev);
    if (groupProfile.name) $("confirm-who").textContent = `A share of ${groupProfile.name}'s key.`;
    if (groupProfile.picture) {
      const img = $<HTMLImageElement>("confirm-picture");
      img.src = groupProfile.picture;
      img.hidden = false;
    }
  };

  pool.onEvent = (ev) => apply(session.handleEvent(ev, nowSec()));
  pool.start();

  $("advance").addEventListener("click", () => {
    setStep("Waiting for another device.");
    show("code-block", false);
    apply(session.advance());
  });

  // One confirmation, naming the consequence. The first press shows it;
  // the second commits. Same treatment bothy gives its claim.
  $("confirm").addEventListener("click", async () => {
    if (creds === null || confirmedSender === null) return;
    const button = $<HTMLButtonElement>("confirm");
    if (!armed) {
      armed = true;
      $("confirm-consequence").textContent =
        "Once held, the share stays with this Worker until the Worker is deleted. There is no undo, and no second share can be held here.";
      show("confirm-consequence", true);
      button.textContent = "Yes, hold it here";
      return;
    }
    button.disabled = true;
    const res = await fetch("/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: creds.groupStr, share: creds.shareStr, profile: groupProfile }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      $("error").textContent = body.error ?? `could not hold the share (${res.status})`;
      button.disabled = false;
      return;
    }
    const { echo } = (await res.json()) as { echo: NostrEvent };
    // 7 step 17: ACK to the sender, then the echo that tells the device
    // that handed the share over that it has arrived. Both published by
    // this browser; the Worker never opens a connection.
    pool.publish(session.ack(confirmedSender, nowSec()));
    pool.publish(echo);
    clearTimeout(expiry);
    creds = null;
    setTimeout(() => {
      pool.close();
      location.reload();
    }, 1500);
    setStep("Held. Reloading.");
  });

  $("decline").addEventListener("click", () => {
    session.zeroize();
    pool.close();
    creds = null;
    clearTimeout(expiry);
    show("confirm-block", false);
    setStep("Nothing was kept. Reload to start again.");
  });

  $("copy-uri").addEventListener("click", () => {
    void navigator.clipboard.writeText($<HTMLInputElement>("frost-uri").value);
  });
}

async function main(): Promise<void> {
  const res = await fetch("/api/status");
  const status = (await res.json()) as Status;
  $("version").textContent = `signer-worker v${status.version}`;
  if (status.claimed) {
    renderClaimed(status);
  } else if (status.pairing) {
    runPairing(status);
  } else {
    show("configured-view", true);
  }
}

void main();
