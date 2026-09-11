#!/usr/bin/env node
// A scripted QRST Sender for trying the pairing page end to end without
// a phone: it does what a FROSTR app does after scanning the QR.
//
//   node scripts/sender.mjs "<frost:// or https:// pairing link>" [--light|--auto]
//
// Generates a fresh 2-of-3 group, speaks Flow A over the relays named in
// the link (HELLO, NONCE, REVEAL), prints the five-digit code it derived
// so you can compare it with the page, then sends share 1 as the payload
// and waits for the ACK. With --light it echoes the link's secret in the
// HELLO instead (QRST 12.3) and sends the payload as soon as the NONCE
// arrives. With --auto it prints the code and sends the payload two
// seconds later without waiting for Enter, for unattended runs.
// Development tool; deployed nowhere.
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { create_dealer_set } from "@vbyte/frost/lib";
import { encodeGroupPackage, encodeSharePackage, getPubkey } from "../src/frost.ts";
import {
  KIND_ACK, KIND_HELLO, KIND_NONCE, KIND_PAYLOAD, KIND_REVEAL, QRST_VERSION,
  commitHash, generateBurner, parsePairingUri, sasDigits, unwrapGiftWrap, wrapRumor,
} from "../src/qrst.ts";

const [, , link, flag] = process.argv;
if (!link) {
  console.error("usage: node scripts/sender.mjs <pairing link> [--light]");
  process.exit(2);
}
const light = flag === "--light";
const auto = flag === "--auto";
const parsed = parsePairingUri(link);
if (!parsed || parsed.mode !== "offer") {
  console.error("not an offer link");
  process.exit(2);
}
if (light && !parsed.secret) {
  console.error("--light needs a frost:// link carrying a secret");
  process.exit(2);
}

const receiverPub = parsed.pubkey;
const burner = generateBurner();
const nonceS = bytesToHex(randomBytes(32));
const now = () => Math.floor(Date.now() / 1000);

const set = create_dealer_set(2, 3);
const shares = set.shares.map((s) => ({ idx: s.idx, seckey: s.seckey }));
const group = { members: shares.map((s) => ({ idx: s.idx, pubkey: getPubkey(s.seckey, "ecdsa") })), group_pk: set.group_pk, threshold: 2 };
const payload = JSON.stringify({ group: encodeGroupPackage(group), share: encodeSharePackage(shares[0]) });
console.log(`group pubkey (x-only): ${set.group_pk.slice(2)}`);

const sockets = [];
const seen = new Set();
let nonceR = null;
let payloadSent = false;

function publish(event) {
  for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(["EVENT", event]));
}

function sendPayload() {
  if (payloadSent) return;
  payloadSent = true;
  console.log("sending payload (share 1 of a fresh 2-of-3 group)");
  publish(wrapRumor(burner.secretKey, receiverPub, { kind: KIND_PAYLOAD, content: payload }, now()));
}

function onWrap(ev) {
  if (seen.has(ev.id)) return;
  seen.add(ev.id);
  const u = unwrapGiftWrap(burner.secretKey, ev);
  if (!u.ok || u.sender !== receiverPub) return;
  if (u.rumor.kind === KIND_NONCE && nonceR === null) {
    nonceR = u.rumor.tags.find((t) => t[0] === "nonce")?.[1] ?? null;
    console.log("NONCE received");
    publish(wrapRumor(burner.secretKey, receiverPub, { kind: KIND_REVEAL, tags: [["nonce", nonceS]] }, now()));
    if (light) {
      sendPayload();
    } else {
      const digits = sasDigits(QRST_VERSION, parsed.profile, burner.pubkey, receiverPub, nonceS, nonceR);
      console.log(`\n  code on the page should read: ${digits}\n`);
      if (auto) {
        setTimeout(sendPayload, 2000);
      } else {
        console.log("press Enter once it matches, to send the share (Ctrl-C if it does not)");
        process.stdin.once("data", () => sendPayload());
      }
    }
  } else if (u.rumor.kind === KIND_ACK) {
    console.log("ACK received: the page holds the share. Done.");
    for (const ws of sockets) ws.close();
    process.exit(0);
  }
}

const hello = wrapRumor(
  burner.secretKey,
  receiverPub,
  { kind: KIND_HELLO, tags: [["commit", commitHash(QRST_VERSION, burner.pubkey, nonceS)], ...(light ? [["secret", parsed.secret]] : [])] },
  now(),
);

for (const url of parsed.relays) {
  const ws = new WebSocket(url);
  sockets.push(ws);
  ws.onopen = () => {
    ws.send(JSON.stringify(["REQ", "s", { kinds: [1059], "#p": [burner.pubkey], since: now() - 120 }]));
    ws.send(JSON.stringify(["EVENT", hello]));
    console.log(`connected ${url}, HELLO sent`);
  };
  ws.onmessage = (m) => {
    try {
      const f = JSON.parse(String(m.data));
      if (f[0] === "EVENT" && f[2]?.kind === 1059) onWrap(f[2]);
      if (f[0] === "OK" && f[2] === false) console.log(`${url} refused: ${f[3]}`);
    } catch {}
  };
  ws.onerror = () => console.log(`${url}: error`);
}
setTimeout(() => {
  console.log("no ACK within ten minutes; giving up");
  process.exit(1);
}, 600_000);
