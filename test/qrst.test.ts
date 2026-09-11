// QR Secret Transfer, Receiver side (src/qrst.ts), driven by a scripted
// Sender (test/helpers/sender.ts). Section numbers refer to
// QR_SECRET_TRANSFER.md 1.4-draft.
import { describe, expect, it } from "vitest";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import {
  KIND_ACK,
  KIND_GIFT_WRAP,
  KIND_NONCE,
  MAX_CANDIDATES,
  MULTIPLE_RESPONDER_NOTICE,
  QRST_VERSION,
  ReceiverSession,
  SESSION_SECONDS,
  SLACK_SECONDS,
  buildFrostUri,
  buildOfferLink,
  commitHash,
  generateBurner,
  npubDecode,
  npubEncode,
  parsePairingUri,
  sasDigits,
  unwrapGiftWrap,
  wrapRumor,
  type ReceiverAction,
} from "../src/qrst.ts";
import { encodeGroupPackage, encodeSharePackage } from "../src/frost.ts";
import { generateDealerPackage } from "./helpers/group.ts";
import { Sender } from "./helpers/sender.ts";

const T0 = 1_800_000_000;

function payloadFor(shareIdx = 0): { content: string; groupStr: string; shareStr: string } {
  const { group, shares } = generateDealerPackage(2, 3);
  const groupStr = encodeGroupPackage(group);
  const shareStr = encodeSharePackage(shares[shareIdx]!);
  return { content: JSON.stringify({ group: groupStr, share: shareStr }), groupStr, shareStr };
}

function publishedTo(actions: ReceiverAction[], sender: Sender): void {
  for (const a of actions) if (a.type === "publish" && a.to === sender.burner.pubkey) sender.receive(a.event);
}

describe("pairing links (11.2, 12.3)", () => {
  const burner = generateBurner();
  const link = { host: "example.workers.dev", npub: npubEncode(burner.pubkey), relays: ["wss://a.example", "wss://b.example"], origin: "https://example.workers.dev" };

  it("puts every parameter in the fragment of an https link", () => {
    const uri = buildOfferLink(link);
    const url = new URL(uri);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    const parsed = parsePairingUri(uri);
    expect(parsed).toMatchObject({ version: 1, mode: "offer", profile: "frost-share", pubkey: burner.pubkey, relays: link.relays, origin: link.origin });
    expect(parsed?.secret).toBeUndefined();
  });

  it("round-trips the frost:// form with its secret", () => {
    const secret = bytesToHex(randomBytes(32));
    const parsed = parsePairingUri(buildFrostUri({ ...link, secret }));
    expect(parsed).toMatchObject({ mode: "offer", pubkey: burner.pubkey, secret });
  });

  it("rejects unknown v, missing mode, missing p, and a bad npub checksum", () => {
    expect(parsePairingUri("https://h/pair#v=2&mode=offer&p=frost-share&npub=" + link.npub)).toBeNull();
    expect(parsePairingUri("https://h/pair#v=1&p=frost-share&npub=" + link.npub)).toBeNull();
    expect(parsePairingUri("https://h/pair#v=1&mode=offer&npub=" + link.npub)).toBeNull();
    const bad = link.npub.slice(0, -1) + (link.npub.endsWith("q") ? "p" : "q");
    expect(parsePairingUri("https://h/pair#v=1&mode=offer&p=frost-share&npub=" + bad)).toBeNull();
  });

  it("encodes and decodes npubs", () => {
    expect(npubDecode(npubEncode(burner.pubkey))).toBe(burner.pubkey);
    expect(npubDecode("nsec1" + npubEncode(burner.pubkey).slice(5))).toBeNull();
  });
});

describe("commit and SAS (6)", () => {
  it("both sides derive the same five digits, and a wrong nonce changes them", () => {
    const snd = generateBurner();
    const rcv = generateBurner();
    const nonceS = bytesToHex(randomBytes(32));
    const nonceR = bytesToHex(randomBytes(32));
    const a = sasDigits(QRST_VERSION, "frost-share", snd.pubkey, rcv.pubkey, nonceS, nonceR);
    expect(a).toMatch(/^\d{5}$/);
    expect(sasDigits(QRST_VERSION, "frost-share", snd.pubkey, rcv.pubkey, nonceS, nonceR)).toBe(a);
    expect(sasDigits(QRST_VERSION, "frost-share", snd.pubkey, rcv.pubkey, nonceS, bytesToHex(randomBytes(32)))).not.toBe(a);
    expect(sasDigits(QRST_VERSION, "nostr-nsec", snd.pubkey, rcv.pubkey, nonceS, nonceR)).not.toBe(a);
    expect(commitHash(QRST_VERSION, snd.pubkey, nonceS)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gift wraps (11.4)", () => {
  it("wraps a rumor the recipient alone can unwrap, attributed to the sealing burner", () => {
    const snd = generateBurner();
    const rcv = generateBurner();
    const wrap = wrapRumor(snd.secretKey, rcv.pubkey, { kind: KIND_NONCE, tags: [["nonce", "ab"]] }, T0);
    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(wrap.pubkey).not.toBe(snd.pubkey);
    expect(wrap.tags).toContainEqual(["p", rcv.pubkey]);
    expect(wrap.tags).toContainEqual(["expiration", String(T0 + SESSION_SECONDS)]);
    expect(wrap.created_at).toBe(T0);
    const u = unwrapGiftWrap(rcv.secretKey, wrap);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.sender).toBe(snd.pubkey);
    expect(u.rumor.kind).toBe(KIND_NONCE);
    expect(u.rumor.pubkey).toBe(snd.pubkey);
    expect(unwrapGiftWrap(generateBurner().secretKey, wrap).ok).toBe(false);
  });
});

describe("Flow A, this page as Receiver (7)", () => {
  it("runs HELLO, NONCE, REVEAL, code, PAYLOAD, acceptance, ACK", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    expect(session.subscriptionFilter()).toEqual({ kinds: [KIND_GIFT_WRAP], "#p": [burner.pubkey], since: T0 - SLACK_SECONDS });

    const sender = new Sender(burner.pubkey);
    const afterHello = session.handleEvent(sender.hello(T0 + 5), T0 + 5);
    expect(afterHello.map((a) => a.type)).toEqual(["publish"]);
    publishedTo(afterHello, sender);
    expect(sender.nonceR).not.toBeNull();

    const afterReveal = session.handleEvent(sender.reveal(T0 + 6), T0 + 6);
    expect(afterReveal).toEqual([{ type: "code", sender: sender.burner.pubkey, digits: sender.digits() }]);

    const { content, groupStr, shareStr } = payloadFor();
    const afterPayload = session.handleEvent(sender.payload(content, T0 + 20), T0 + 20);
    expect(afterPayload).toEqual([{ type: "payload", sender: sender.burner.pubkey }]);

    const inspected = session.inspect(sender.burner.pubkey);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.creds.groupStr).toBe(groupStr);
    expect(inspected.creds.shareStr).toBe(shareStr);

    const ack = session.ack(sender.burner.pubkey, T0 + 30);
    const u = unwrapGiftWrap(sender.burner.secretKey, ack);
    expect(u.ok && u.rumor.kind === KIND_ACK).toBe(true);
    // 7 step 17: zeroized.
    expect(session.candidates()).toHaveLength(0);
    expect(burner.secretKey).toBe("0".repeat(64));
    expect(session.handleEvent(sender.hello(T0 + 31), T0 + 31)).toEqual([]);
  });

  it("refuses to accept a payload before the code exchange completed", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    const sender = new Sender(burner.pubkey);
    publishedTo(session.handleEvent(sender.hello(T0), T0), sender);
    session.handleEvent(sender.payload(payloadFor().content, T0 + 1), T0 + 1);
    const r = session.inspect(sender.burner.pubkey);
    expect(r.ok).toBe(false);
  });

  it("discards a REVEAL whose commit does not open", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    const sender = new Sender(burner.pubkey);
    publishedTo(session.handleEvent(sender.hello(T0), T0), sender);
    const liar = wrapRumor(sender.burner.secretKey, burner.pubkey, { kind: 24404, tags: [["nonce", bytesToHex(randomBytes(32))]] }, T0 + 1);
    expect(session.handleEvent(liar, T0 + 1)).toEqual([]);
    expect(session.active()).toBeNull();
  });

  it("discards a rumor outside the session window entirely, and dedupes by event id", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    const sender = new Sender(burner.pubkey);
    const early = sender.hello(T0 - SLACK_SECONDS - 1);
    expect(session.handleEvent(early, T0)).toEqual([]);
    expect(session.candidates()).toHaveLength(0);
    const late = sender.hello(T0 + SESSION_SECONDS + SLACK_SECONDS + 1);
    expect(session.handleEvent(late, T0)).toEqual([]);
    const ok = sender.hello(T0 + 1);
    expect(session.handleEvent(ok, T0 + 1)).toHaveLength(1);
    expect(session.handleEvent(ok, T0 + 1)).toEqual([]);
  });

  it("discards a payload that fails the P4 check and advances (13)", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    const sender = new Sender(burner.pubkey);
    publishedTo(session.handleEvent(sender.hello(T0), T0), sender);
    session.handleEvent(sender.reveal(T0), T0);
    // A share from a different group.
    const { groupStr } = payloadFor();
    const { shareStr } = payloadFor();
    session.handleEvent(sender.payload(JSON.stringify({ group: groupStr, share: shareStr }), T0), T0);
    const r = session.inspect(sender.burner.pubkey);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/does not belong/);
    expect(session.candidate(sender.burner.pubkey)?.discarded).toBe(true);
    expect(session.active()).toBeNull();
  });

  it("accepts the two-string form of the payload as well as JSON", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    const sender = new Sender(burner.pubkey);
    publishedTo(session.handleEvent(sender.hello(T0), T0), sender);
    session.handleEvent(sender.reveal(T0), T0);
    const { groupStr, shareStr } = payloadFor();
    session.handleEvent(sender.payload(`${shareStr}\n${groupStr}`, T0), T0);
    expect(session.inspect(sender.burner.pubkey).ok).toBe(true);
  });
});

describe("multiple responders (13)", () => {
  it("keeps the first responder active, holds at most three, shows one code at a time, and notices once", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0 });
    const senders = [0, 1, 2, 3].map(() => new Sender(burner.pubkey));
    const first = session.handleEvent(senders[0]!.hello(T0), T0);
    expect(first.some((a) => a.type === "notice")).toBe(false);
    const second = session.handleEvent(senders[1]!.hello(T0), T0);
    expect(second).toContainEqual({ type: "notice", text: MULTIPLE_RESPONDER_NOTICE });
    const third = session.handleEvent(senders[2]!.hello(T0), T0);
    expect(third.some((a) => a.type === "notice")).toBe(false);
    expect(session.handleEvent(senders[3]!.hello(T0), T0)).toEqual([]);
    expect(session.candidates()).toHaveLength(MAX_CANDIDATES);
    for (const s of senders.slice(0, 3)) publishedTo([...first, ...second, ...third], s);

    // The second responder's REVEAL derives a code but does not display it.
    expect(session.handleEvent(senders[1]!.reveal(T0), T0)).toEqual([]);
    expect(session.handleEvent(senders[0]!.reveal(T0), T0)).toEqual([{ type: "code", sender: senders[0]!.burner.pubkey, digits: senders[0]!.digits() }]);

    // No match: advance shows the next held candidate's code.
    expect(session.advance()).toEqual([{ type: "code", sender: senders[1]!.burner.pubkey, digits: senders[1]!.digits() }]);
    expect(session.active()?.sender).toBe(senders[1]!.burner.pubkey);
    // A later responder never aborts the session.
    expect(session.handleEvent(senders[2]!.abort(T0), T0)).toEqual([{ type: "abort", sender: senders[2]!.burner.pubkey }]);
    expect(session.active()?.sender).toBe(senders[1]!.burner.pubkey);
  });
});

describe("the light flow (12.3)", () => {
  it("verifies a HELLO that echoes the token's secret without showing a code", () => {
    const burner = generateBurner();
    const secret = bytesToHex(randomBytes(32));
    const session = new ReceiverSession({ burner, startedAt: T0, secret });
    const sender = new Sender(burner.pubkey);
    const actions = session.handleEvent(sender.hello(T0, secret), T0);
    expect(actions.map((a) => a.type)).toEqual(["publish", "verified"]);
    publishedTo(actions, sender);
    expect(session.handleEvent(sender.reveal(T0), T0)).toEqual([]);
    session.handleEvent(sender.payload(payloadFor().content, T0), T0);
    expect(session.inspect(sender.burner.pubkey).ok).toBe(true);
  });

  it("treats a wrong secret as an ordinary responder that must show a code", () => {
    const burner = generateBurner();
    const session = new ReceiverSession({ burner, startedAt: T0, secret: bytesToHex(randomBytes(32)) });
    const sender = new Sender(burner.pubkey);
    const actions = session.handleEvent(sender.hello(T0, bytesToHex(randomBytes(32))), T0);
    expect(actions.map((a) => a.type)).toEqual(["publish"]);
    publishedTo(actions, sender);
    expect(session.handleEvent(sender.reveal(T0), T0)[0]?.type).toBe("code");
  });
});
