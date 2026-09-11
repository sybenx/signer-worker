// The inbound NIP-01 subset: what this relay accepts, what it refuses,
// and the reason it gives. Every refusal names the boundary.
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { MAX_FRAME_BYTES, MAX_SUBSCRIPTIONS_PER_CONNECTION } from "../src/limits.ts";
import { signEvent } from "../src/nostr.ts";
import { RPC_KIND, requestMessage, wrapRpc } from "../src/wire.ts";
import { generateBurner } from "../src/qrst.ts";
import { isolateStorage } from "./helpers/isolate.ts";
import { Peer, claim, fixture } from "./helpers/peer.ts";
import { connectRelay } from "./helpers/socket.ts";

isolateStorage();

describe("REQ, EOSE, CLOSED, CLOSE", () => {
  it("answers a servable REQ with EOSE at once, since nothing is stored", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect(false);
    expect(await peer.subscribe("a")).toEqual(["EOSE", "a"]);
    // A REQ with no kinds and no authors is servable too.
    expect(await peer.subscribe("b", { "#p": [peer.pubkey] })).toEqual(["EOSE", "b"]);
    peer.conn.send(["CLOSE", "a"]);
    peer.close();
  });

  it("closes a REQ this relay could never serve, and says what it does serve", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect(false);
    const history = await peer.subscribe("h", { kinds: [1], limit: 10 });
    expect(history[0]).toBe("CLOSED");
    expect(history[2]).toMatch(/kind 20000 addressed to its own share/);
    expect(history[2]).toMatch(/nothing is stored/);
    const stranger = await peer.subscribe("s", { authors: [bytesToHex(randomBytes(32))], kinds: [RPC_KIND] });
    expect(stranger[0]).toBe("CLOSED");
    const byId = await peer.subscribe("i", { ids: [bytesToHex(randomBytes(32))] });
    expect(byId[0]).toBe("CLOSED");
    peer.close();
  });

  it("refuses malformed filters and empty REQs", async () => {
    const fx = fixture();
    await claim(fx);
    const conn = await connectRelay();
    conn.send(["REQ", "x", { kinds: ["one"] }]);
    expect((await conn.nextMessage())[2]).toMatch(/malformed filter/);
    conn.send(["REQ", "y"]);
    expect((await conn.nextMessage())[2]).toMatch(/at least one filter/);
    conn.send(["REQ", 5, {}]);
    expect((await conn.nextMessage())[0]).toBe("NOTICE");
    conn.close();
  });

  it("caps open subscriptions per connection", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect(false);
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) {
      expect((await peer.subscribe(`s${i}`))[0]).toBe("EOSE");
    }
    const over = await peer.subscribe("one-too-many");
    expect(over[0]).toBe("CLOSED");
    expect(over[2]).toMatch(/rate-limited/);
    // Re-using an open id replaces rather than counts.
    expect((await peer.subscribe("s0"))[0]).toBe("EOSE");
    peer.close();
  });
});

describe("EVENT refusals, cheapest first", () => {
  it("refuses every kind but 20000, before looking at anything else", async () => {
    const conn = await connectRelay();
    const note = signEvent(generateBurner().secretKey, { kind: 1, content: "hi" });
    conn.send(["EVENT", note]);
    expect(await conn.nextMessage()).toEqual(["OK", note.id, false, expect.stringMatching(/^restricted: this relay carries kind 20000/)]);
    conn.close();
  });

  it("refuses while nothing is held", async () => {
    const fx = fixture();
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect(false);
    const event = peer.wrap(requestMessage("ping", ["{}"]));
    peer.conn.send(["EVENT", event]);
    expect(await peer.conn.nextMessage()).toEqual(["OK", event.id, false, "restricted: no share is held here yet"]);
    peer.close();
  });

  it("refuses an event not p-tagged to the share, a non-member, and a blocked peer", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect();

    const elsewhere = wrapRpc(peer.share.seckey, requestMessage("ping", []), generateBurner().pubkey);
    peer.conn.send(["EVENT", elsewhere]);
    expect((await peer.conn.nextMessage())[3]).toMatch(/addressed to its own share/);

    const strangerKey = bytesToHex(schnorr.keygen().secretKey);
    const stranger = wrapRpc(strangerKey, requestMessage("ping", []), fx.signerPubkey);
    peer.conn.send(["EVENT", stranger]);
    expect((await peer.conn.nextMessage())[3]).toMatch(/only members of this group/);
    peer.close();
  });

  it("refuses a request whose answer would have nowhere to go, before verifying it", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect(false);
    const event = peer.wrap(requestMessage("ping", ["{}"]));
    peer.conn.send(["EVENT", event]);
    const reply = await peer.conn.nextMessage();
    expect(reply[2]).toBe(false);
    expect(reply[3]).toMatch(/open a subscription/);
    peer.close();
  });

  it("refuses a bad id, a bad signature, and content it cannot decrypt", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect();
    const good = peer.wrap(requestMessage("ping", ["{}"]));

    const tampered = { ...good, content: `${good.content}A` };
    peer.conn.send(["EVENT", tampered]);
    expect((await peer.conn.nextMessage())[3]).toMatch(/id does not match/);

    const badSig = { ...good, sig: (good.sig[0] === "0" ? "1" : "0") + good.sig.slice(1) };
    peer.conn.send(["EVENT", badSig]);
    expect((await peer.conn.nextMessage())[3]).toMatch(/signature verification failed/);

    // Encrypted to a third member, signed by this one: a valid event
    // p-tagged to us that we cannot read.
    const otherPk = fx.shares[2]!.seckey;
    const forOther = wrapRpc(peer.share.seckey, requestMessage("ping", []), bytesToHex(schnorr.getPublicKey(hexToBytes(otherPk))));
    const misaddressed = signEvent(peer.share.seckey, { kind: RPC_KIND, content: forOther.content, tags: [["p", fx.signerPubkey]] });
    peer.conn.send(["EVENT", misaddressed]);
    expect((await peer.conn.nextMessage())[3]).toMatch(/could not decrypt/);
    peer.close();
  });

  it("refuses a ping whose payload fails bifrost's schema, in the OK", async () => {
    const fx = fixture();
    await claim(fx);
    const peer = new Peer(fx.group, fx.shares[1]!, fx.signerPubkey);
    await peer.connect();
    const { ok } = await peer.request("ping", ["{}"]);
    expect(ok[2]).toBe(false);
    expect(ok[3]).toMatch(/ping payload failed validation/);
    peer.close();
  });

  it("refuses an oversized frame before parsing it, and answers garbage with a NOTICE", async () => {
    const conn = await connectRelay();
    conn.send(["EVENT", { content: "x".repeat(MAX_FRAME_BYTES + 1) }]);
    expect((await conn.nextMessage())[1]).toMatch(/frame larger than/);
    conn.send(["NOPE"]);
    expect((await conn.nextMessage())[1]).toMatch(/unknown message type/);
    conn.close();
  });
});
