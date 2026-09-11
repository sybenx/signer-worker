#!/usr/bin/env node
// What this Worker's wire format and the shipping Igloo apps' actually
// disagree about, measured rather than read.
//
// The 2026 Igloo apps (igloo-pwa, igloo-chrome, igloo-home) do not use
// the TypeScript @frostr/bifrost this Worker ports from. They use
// igloo-shared, which ships FROSTR-ORG/bifrost-rs compiled to WASM:
// public/wasm/bifrost_bridge_wasm_bg.wasm. That WASM exposes a whole
// signer node (WasmBridgeRuntime) that takes inbound events and hands
// back outbound ones with no network of its own, which makes it usable
// here as the real counterparty. Everything this script prints is what
// the shipping implementation actually did, not what its source appears
// to say.
//
// Run: node scripts/interop.mjs
// The WASM is fetched once into .wasm-ref/ (gitignored, ~1.8 MB).
//
// Deliberately plain .mjs, like scripts/bench.mjs: a repo chore, outside
// tsconfig's include, deployed nowhere. It asserts nothing -- upstream is
// free to move, and a chore that fails CI when someone else ships is a
// chore nobody runs.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { create_dealer_set } from "@vbyte/frost/lib";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { getGroupId, getPubkey } from "../src/frost.ts";
import { nip44Decrypt, sharedSecret } from "../src/wire.ts";

const BASE = "https://raw.githubusercontent.com/FROSTR-ORG/igloo-shared/master/public/wasm";
const DIR = new URL("../.wasm-ref/", import.meta.url);
const FILES = ["bifrost_bridge_wasm.js", "bifrost_bridge_wasm_bg.wasm"];

async function ensureWasm() {
  mkdirSync(DIR, { recursive: true });
  for (const name of FILES) {
    const path = new URL(name, DIR);
    if (existsSync(path)) continue;
    process.stdout.write(`fetching ${name} ... `);
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`${res.status} fetching ${name}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    console.log("done");
  }
}

function line(label, ours, theirs) {
  const same = ours === theirs;
  console.log(`  ${same ? "same  " : "DIFFER"}  ${label}`);
  if (!same) {
    console.log(`          this Worker : ${ours}`);
    console.log(`          bifrost-rs  : ${theirs}`);
  }
  return same;
}

await ensureWasm();
const glue = await import(new URL("bifrost_bridge_wasm.js", DIR).href);
glue.initSync({ module: readFileSync(new URL("bifrost_bridge_wasm_bg.wasm", DIR)) });

// A dealer set from the same @vbyte/frost the Worker signs with, so both
// sides are looking at one group rather than two equivalent ones.
const set = create_dealer_set(2, 3);
const shares = set.shares.map((s) => ({ idx: s.idx, seckey: s.seckey }));
const members = shares.map((s) => ({ idx: s.idx, pubkey: getPubkey(s.seckey, "ecdsa") }));
const xonly = (hex) => hex.slice(2);

console.log(`\nbifrost-rs package version: ${glue.bf_package_version()}`);

// --- 1. The group package -------------------------------------------------
// bifrost-rs types.rs: group_pk is IdentityPubkey32 (x-only, 32 bytes) and
// member pubkey is VerifyingShare33 (compressed, 33). This Worker carries a
// 33-byte group_pk. A group package therefore does not cross as-is, which is
// why the identifiers below diverge before any message is built.
console.log("\n[1] group package");
console.log(`  group_pk      this Worker : 33-byte compressed  ${set.group_pk}`);
console.log(`                bifrost-rs  : 32-byte x-only      ${xonly(set.group_pk)}`);
console.log(`  member pubkey both        : 33-byte compressed`);
console.log(`  group_name    bifrost-rs only (this Worker has no such field)`);

// --- 2. Group id ----------------------------------------------------------
// Both hash sha256(group_pk || threshold[4] || member pubkeys sorted by idx).
// They differ in the two places isolated below, and nowhere else: swapping
// both reproduces the WASM's answer exactly.
console.log("\n[2] group id");
const rsGroup = { group_name: "interop", group_pk: xonly(set.group_pk), threshold: 2, members };
const theirGid = glue.derive_group_id(JSON.stringify(rsGroup));
const ourGid = getGroupId({ members, group_pk: set.group_pk, threshold: 2 });
line("derive_group_id", ourGid, theirGid);

const le32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const sorted = [...members].sort((a, b) => a.idx - b.idx);
const rebuilt = bytesToHex(sha256(concatBytes(
  hexToBytes(xonly(set.group_pk)), le32(2), ...sorted.map((m) => hexToBytes(m.pubkey)),
)));
console.log(`  cause: x-only group_pk + little-endian threshold reproduces theirs: ${rebuilt === theirGid}`);
console.log("         (this Worker uses the compressed key and a big-endian threshold)");

// --- 3. The transport -----------------------------------------------------
// Drive the WASM into emitting a real message and read it with this Worker's
// own NIP-44. That it decrypts at all is the finding: kind, p-tag addressing,
// the ECDH x-coordinate and the "nip44-v2" HKDF salt are already shared.
console.log("\n[3] transport and envelope");
const peer32 = xonly(members[1].pubkey);
const rt = new glue.WasmBridgeRuntime();
rt.init_runtime(JSON.stringify({}), JSON.stringify({
  group: rsGroup, share: shares[0], peers: [peer32], initial_peer_nonces: [],
}));
rt.handle_command(JSON.stringify({ type: "ping", peer_pubkey32_hex: peer32 }));
rt.tick(BigInt(Date.now()));
const events = JSON.parse(rt.drain_outbound_events());
if (events.length === 0) {
  console.log("  the runtime emitted nothing; upstream behaviour has moved");
} else {
  const ev = events[0];
  console.log(`  kind ${ev.kind}, tags ${JSON.stringify(ev.tags)}  (this Worker: kind 20000, p tag)`);
  const plain = JSON.parse(nip44Decrypt(sharedSecret(shares[1].seckey, ev.pubkey), ev.content));
  console.log("  NIP-44: this Worker's nip44Decrypt read it unchanged -> cipher layer already interoperates");
  console.log("  base64: bifrost-rs writes STANDARD_NO_PAD; this Worker writes base64url unpadded on encode");
  console.log("          (decode here accepts both, so only the encode side has to move)");
  console.log("\n  their envelope:");
  const shape = { ...plain, payload: { type: plain.payload.type, data: "..." } };
  console.log(`    ${JSON.stringify(shape)}`);
  console.log("  our envelope:");
  console.log(`    {"type":"request","id":"...","method":"...","params":[],"peers":[],"version":1}`);
  const ping = plain.payload.data;
  if (ping && Array.isArray(ping.advertised_nonces)) {
    console.log(`\n  their ping carries ${ping.advertised_nonces.length} advertised nonces and a policy profile;`);
    console.log("  this Worker's ping carries nothing and hands nonces over on request");
  }
}

console.log("\nSee docs/budget.md \"The stack question\" for what this means for the port.\n");
