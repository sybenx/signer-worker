# The budget

Everything here runs on the Cloudflare Workers free tier, and the ceilings
are what shape the design. This file is the record of what was measured
before any product code was written (Phase 0) and is updated as each
phase pins a figure in the suite. Written in the shape of bothy's
CLAUDE.md "The budget" (github.com/sybenx/bothy), which is the sibling
project this one copies its conventions from.

## The ceilings

Checked against the live documentation on 2026-09-11. Verify again
before relying on a number here; they change between compatibility
dates.

| Ceiling | Free plan | Source |
|---|---|---|
| Worker CPU per HTTP request | **10 ms** | developers.cloudflare.com/workers/platform/limits/ |
| Worker CPU per cron trigger | 10 ms | same |
| Worker requests per day | 100,000 | same |
| Subrequests per request | 50 | same |
| Simultaneous outgoing connections per request | 6 | same |
| Durable Object CPU per request | **30 s** (default) | developers.cloudflare.com/durable-objects/platform/limits/ |
| Durable Object requests per day | 100,000 | developers.cloudflare.com/durable-objects/platform/pricing/ |
| Durable Object duration per day | 13,000 GB-s | same |
| SQLite rows read per day | 5,000,000 | same |
| SQLite rows written per day | **100,000** | same |
| SQLite stored data | 5 GB total | same |
| Inbound WebSocket messages | billed 20:1 against requests | same |
| Hibernating objects | no duration charge | same |

Two of these bind and the rest do not come close:

1. **Worker CPU, 10 ms.** This is the ceiling on the *Worker's* fetch
   handler, not on the Durable Object: a WebSocket message delivered
   through the hibernation API runs inside the object, under the 30 s
   ceiling. So every piece of FROST arithmetic lives in the object and the
   Worker does routing, one NIP-98 verification (≈1.1 ms, below) and the
   rate-limit check, nothing else. This is the same split bothy arrived
   at for the same reason.
2. **Rows written, 100,000 a day.** The only thing this Worker writes on
   a recurring basis is its nonce pool (below). Everything else — the
   share, the group, the peer policy, the claim — is written once.

Duration is not a concern: 13,000 GB-s at the 128 MB isolate ceiling is
about 28 hours of wall time a day, and a hibernating object with idle
sockets costs none of it. Storage is not a concern: the whole database is
a few kilobytes.

## What a partial sign costs

Measured 2026-09-11 on Apple silicon (arm64), Node v24.15.0 and workerd
1.20260911.1, with `@vbyte/frost` 1.1.5 driving the arithmetic and this
repository's own port of bifrost 2.0.2's `src/lib`
([src/frost.ts](../src/frost.ts)). Two measurements, because neither
alone is the number that matters:

- **workerd, wall clock, inside a Durable Object**
  ([test/spike.test.ts](../test/spike.test.ts)): the isolate's clock
  advances during a request in local workerd (`clockAdvanced: true`), so
  `Date.now()` around a loop is a real measurement rather than a frozen
  timestamp. 200 signer-side rounds took 428–469 ms across three runs:
  **≈2.2 ms per round**, where a round is verify the nonce code, derive
  the secret nonce, build the session context and produce the partial
  signature. 50 nonce pairs took 14 ms: **≈0.3 ms per nonce**.
- **Node, CPU time** ([scripts/bench.mjs](../scripts/bench.mjs),
  `process.cpuUsage()` over 500 iterations after 50 of warm-up): Node
  and workerd share V8, but workerd does not expose isolate CPU time to
  code running in it, so this is the only per-operation CPU figure
  available and it is a proxy. It reads roughly 2.5× the workerd wall
  clock, most likely because `cpuUsage` counts V8's background threads
  (compilation, GC) against the process.

| Operation (signer side unless marked) | Node CPU ms |
|---|---|
| verify nonce code (2 HMAC + 2 point multiplications) | 0.69 |
| derive secret nonce (2 HMAC) | 0.03 |
| session context (bind hashes, group signing context) | 4.48 |
| partial signature, given the context | 0.72 |
| **whole `/sign` handler** (all four above) | **5.77** |
| one nonce pair | 0.63 |
| 50 nonce pairs (one replenish) | 35.4 |
| ECDH share, one pubkey | 2.40 |
| schnorr verify of the inbound event | 1.14 |
| unwrap inbound (ECDH + NIP-44 decrypt) | 2.12 |
| wrap outbound (NIP-44 encrypt + ECDH + schnorr sign) | 4.70 |
| requester: verify one partial signature | 8.40 |
| requester: combine two partial signatures | 4.36 |

The whole inbound `/sign` path — verify the event's signature, unwrap,
handle, wrap the response — is **≈14 ms of Node CPU, ≈5–6 ms of workerd
wall clock**. Against the object's 30 s ceiling that is nothing. Against
the Worker's 10 ms it would be a coin flip, which is the measurement that
decides the architecture: **no FROST arithmetic and no NIP-44 in the
Worker, ever.** The Worker's most expensive step stays the single schnorr
verification of a NIP-98 management call, and a forged one is refused
before it.

A replenish of 50 nonces at ≈14 ms wall clock is also fine inside the
object. It would not be fine in the Worker.

## Rows written: the nonce pool

The pool is the one recurring write. Per bifrost 2.0.2's protocol
(docs/PROTOCOL.md "Nonce Pool Management"), a signer hands each peer a
package of derivation codes, keeps only the codes it handed out, and
deletes a code when the peer spends it in a signing session. Defaults,
bifrost's own ([src/limits.ts](../src/limits.ts)): pool size 100 per
peer, replenish 50 when the outgoing pool for that peer falls under 20.

Every figure below is asserted by [test/budget.test.ts](../test/budget.test.ts)
against a real `SqlStorageCursor.rowsWritten`, so the test is the record
and a change that moves one fails rather than drifting. `nonces` is a
`WITHOUT ROWID` table whose composite primary key is its only index, so
one nonce row is **one row written** (`pool.ts NONCE_ROW_COST`), not the
two a rowid table with a separate unique index would cost. Each pool call
also lands its total in the day's `counters` row: one more row per call,
not per nonce.

```
one nonce handed out      1 row
one nonce spent           1 row   (the delete)
one replenish of 50      51 rows  (50 + the counter)
one sign                  2 rows  (the spend + the counter)   + 1 for last_sign
one onboard (full pool) 101 rows
```

Bounds, for a group whose peers all keep this Worker as one of their
relays:

- Steady state, every sign consumes one nonce and the pool is topped up
  as it drains: about **4 rows per signature** (a spend, its counter, a
  fiftieth of a replenish, and `last_sign`). 100,000 rows is 25,000
  signatures a day, which no phone will ask for.
- The failure mode is a peer that drains its pool without signing, or
  onboards again and again: each ping that finds the outgoing pool under
  20 is a 51-row replenish, each onboard 101 rows. A peer doing that
  every second would spend the day's budget in about half an hour.
  `MAX_NONCE_ROWS_PER_DAY` (default 50,000, a number or the exact string
  `"off"`) is the cap: past it, the Worker still answers pings and still
  signs against nonces already issued, but hands out no new ones until
  00:00 UTC. Half the daily budget, so the other half is always there for
  signing. A spend is never refused for budget: refusing it would refuse a
  signature the peer has every right to, over a row the day's allowance
  already agreed to when the nonce was issued.
- The pool is capped at 100 per peer in both directions regardless of what
  the peer's `pool_status` claims (bifrost's `generate_for_peer` enforces
  the same), so a single ping can never request more than one replenish's
  worth, and a peer cannot fill this Worker's incoming pool past 100.
- A peer's `last_seen` is refreshed at most once in five minutes, so a
  peer pinging every second costs 288 rows a day, not 86,400.

A bunker round (a NIP-46 `sign_event` or encrypt) writes one `pending` row
when it opens, one update per part that arrives before the last, one
delete when it closes, one `bunker` update for the page's record, and one
nonce spend per peer asked: for a 2-of-3 group, **about 5 rows per app
request**, and an alarm write when the round is the first in flight.

The claim writes a handful of rows once. Peer policy changes write one row
each, by a NIP-98-signed management call, so they are the group's to
spend. The per-IP and per-peer rate limits are in memory, never in SQLite,
for the same reason bothy's is: a best-effort abuse mitigation is not
worth a row per message.

## What a WebSocket message costs

Every inbound message is one twentieth of a request against the daily
100,000 — 2,000,000 messages a day, which is not a bound worth designing
around. What *is* worth designing around is that a message must be
refused before it costs CPU: the inbound path
([src/signer.ts](../src/signer.ts) `handleEvent`) checks frame size, the
per-IP window (50 in 10 s), kind, whether a share is held, the `p` tag,
group membership, the per-peer window (120 a minute by pubkey), the peer
policy, and whether any open subscription could carry the answer, and
only then verifies the signature and decrypts. A stranger's event costs a
JSON parse and a handful of comparisons; a member's malformed request
costs one schnorr verify and one decrypt before the schema refuses it.
[test/relay.test.ts](../test/relay.test.ts) asserts the order by the
reason each refusal gives.

## The stack question

bifrost has three wire formats in the wild, and they do not
interoperate. This Worker implements the one in `@frostr/bifrost` 2.0.2
(the current npm release and `main`):

| Stack | Envelope | Encryption | Nonces |
|---|---|---|---|
| `@frostr/bifrost` 1.0.x | `[tag, id, data]` via `@cmdcode/nostr-p2p`, e.g. `"/sign/req"` | AES-256-GCM, `?iv=` suffix | static, in the packages |
| `@frostr/bifrost` 2.0.2 | `{type:"request", method, params, id, peers, version}` via `@vbyte/nostr-sdk`, kind 20000 | NIP-44 v2 over the ECDH x-coordinate, base64url unpadded | derivation codes, HMAC `bifrost/nonce/{binder,hidden}/v1` |
| `bifrost-rs` | `BridgeEnvelope {request_id, sent_at, payload}`, kind 20000 | NIP-44 v2 | derivation codes |

`igloo-core` 0.2.4 and `igloo-server` pin `@frostr/bifrost` `^1.0.6` /
`^1.0.7`, so those apps speak the 1.x format, and bifrost's own
MIGRATION.md says "all peers must upgrade together". `bifrost-rs`'s
README says it maintains "no legacy compatibility layer". The question
of which stack is canonical was put to the maintainers as an issue on
FROSTR-ORG/bifrost. The thread has never been answered. Their code
has.

### The answer, read off the shipping apps (2026-09-11)

FROSTR-ORG pushed eight repositories on 2026-07-05 under the name
FROSTR V2: `igloo-pwa` 0.2.0, `igloo-chrome` 0.3.0, `igloo-home` 0.2.0,
`igloo-shell`, `igloo-shared` 0.1.0, `igloo-ui`, `igloo-paper`,
`frostr-infra`. **None of them depends on `@frostr/bifrost`.** Their
dependency lists are `igloo-shared` plus `nostr-tools`; the protocol
itself lives in `igloo-shared`, which ships
`public/wasm/bifrost_bridge_wasm_bg.wasm` and
`bifrost_profile_wasm_bg.wasm` -- the `bifrost-bridge-wasm` and
`bifrost-profile-wasm` crates of `bifrost-rs`, compiled. The TypeScript
bifrost this Worker ports from has not moved since 2026-02-16.

So the canonical format for anything shipping today is `bifrost-rs`'s,
and this Worker does not speak it. The 2.x decision above was right on
the evidence available when it was made and is wrong now.

### Measured, not read

`bifrost_bridge_wasm` exposes a whole signer node (`WasmBridgeRuntime`)
that consumes inbound events and emits outbound ones without a network
of its own, so the shipping implementation can be driven directly as a
counterparty. `scripts/interop.mjs` does that and prints the deltas
below; every line of this is what the WASM did, not what its source
appears to say. Re-run it before trusting any of it.

What already interoperates, unchanged:

- kind 20000, `p`-tagged to the recipient's x-only share pubkey;
- NIP-44 v2 over the raw ECDH x-coordinate with the `nip44-v2` HKDF
  salt. This Worker's `nip44Decrypt` reads a real `bifrost-rs` message
  on the first attempt, and its decoder already accepts either base64
  alphabet.

What does not:

| | this Worker (bifrost 2.0.2) | bifrost-rs |
|---|---|---|
| base64 on encode | base64url, unpadded | `STANDARD_NO_PAD` |
| envelope | `{type:"request", id, method, params[], peers[], version}` | `{request_id, sent_at, payload:{type, data}}` |
| payload | JSON strings in `params` | a typed object; `type` is the PascalCase variant (`PingRequest`, `SignRequest`, ...) |
| `group_pk` | 33-byte compressed | 32-byte x-only |
| group package | no name field | carries `group_name` |
| integers in identifiers | big-endian | little-endian |
| session `type` | `type` | `kind` |
| nonce commitments | one per member | one per (member, sighash), carrying `hash_index` |
| ping | carries nothing | advertises the sender's nonces and its policy profile |

The group id is the clearest single case, because both sides hash the
same thing in the same order -- `sha256(group_pk || threshold[4] ||
member pubkeys sorted by idx)` -- and still disagree. Substituting the
x-only key and a little-endian threshold reproduces the WASM's answer
exactly, which is what `scripts/interop.mjs` asserts in passing. Two
byte-level choices, and every session id underneath them moves.

### What the port costs

Not the arithmetic: both sides run FROST over secp256k1 with taproot
tweaking, and `src/frost.ts` keeps its shape. The cost is in three
places, and the third is the one that reaches this document:

1. `src/wire.ts` and `src/schema.ts`: the envelope, the nine payload
   variants, the encode-side base64.
2. `src/frost.ts` and `src/signer.ts`: the identifier byte layouts, the
   field renames, `hash_index` on every nonce commitment, and a ping
   that advertises.
3. `src/pool.ts`, and the arithmetic above in this file. This Worker
   stores a 32-byte code per nonce and re-derives the secret with
   HMAC-SHA256 at signing time, which is the whole reason the pool is
   affordable against a 100,000-row day. `bifrost-rs` holds
   `frost::round1::SigningNonces` in its pool and treats the code as an
   identifier rather than a seed. Peers only ever see the public
   points, so the derivation trick can survive -- but one commitment
   per (member, sighash) instead of one per member changes what a
   signature costs in rows, and every figure in "Nonce pool" has to be
   recomputed before `MAX_NONCE_ROWS_PER_DAY`'s default means anything
   again.

That is a major version, and it is larger than a transport change.

### Issue

- Opened 2026-09-11: https://github.com/FROSTR-ORG/bifrost/issues/12
- Answer in the thread: none, as of 2026-09-11. If one ever arrives and
  contradicts what the shipping code does, the code wins and this
  section says why.
