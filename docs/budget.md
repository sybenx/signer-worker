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
deletes a code when the peer spends it in a signing session. Defaults:
pool size 100 per peer, replenish 50 when the outgoing pool for that peer
falls under 20, refuse under 5.

Each code is one row in `nonces` (peer_idx, code, binder_pn, hidden_pn),
and the row carries one index (peer_idx, code) for the lookup the sign
handler does, so:

```
one nonce handed out    2 rows written   (row + index entry)
one nonce spent         2 rows written   (delete is a write, row + index)
one replenish (50)    100 rows written
```

Bounds, for a group of `P` peers that each keep this Worker as one of
their relays:

- A steady state where every sign consumes one nonce and the pool is
  topped up during ping costs **4 rows per signature** (2 to hand out, 2
  to spend). 100,000 rows is 25,000 signatures a day, which no phone will
  ask for.
- The failure mode is a peer that pings without ever signing, or a peer
  that drops its pool and asks again: each ping that finds the outgoing
  pool under 20 triggers a 100-row replenish. A peer pinging every second
  with an empty pool would spend the day's budget in under 17 minutes.
  `MAX_NONCE_ROWS_PER_DAY` ([src/limits.ts](../src/limits.ts), default
  50,000, a number or the exact string `"off"`) is the cap: past it, the
  Worker still answers pings but hands out no nonces until 00:00 UTC, and
  says so in the ping response. Half the daily budget, so the other half
  is always there for signing against nonces already issued.
- The pool is capped at 100 per peer regardless of what the peer's
  `pool_status` claims (bifrost's `generate_for_peer` enforces the same),
  so a single ping can never request more than one replenish's worth.

The claim writes a handful of rows once. Peer policy changes write one
row each, by a NIP-98-signed management call, so they are the owner's to
spend. The per-peer rate limit is in memory, never in SQLite, for the
same reason bothy's is: a best-effort abuse mitigation is not worth a
row per message.

## What a WebSocket message costs

Every inbound message is one twentieth of a request against the daily
100,000 — 2,000,000 messages a day, which is not a bound worth designing
around. What *is* worth designing around is that a message must be
refused before it costs CPU: the inbound path checks kind, then the `p`
tag, then the per-peer rate limit, then the peer policy, and only then
verifies the signature and decrypts. A stranger's event costs a JSON
parse and three comparisons.

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
`^1.0.7`, so the deployed Igloo apps speak the 1.x format today, and
bifrost's own MIGRATION.md says "all peers must upgrade together".
`bifrost-rs`'s README says it maintains "no legacy compatibility layer".
The question of which stack is canonical was put to the maintainers as
an issue on FROSTR-ORG/bifrost; the link and the answer are recorded at
the end of this file. Until it is answered, the 2.x format is the
decision, because it is what the reference library ships and its
protocol document is the one this design was drawn from.

### Issue

- Opened 2026-09-11: https://github.com/FROSTR-ORG/bifrost/issues/12
- Answer: not yet received. When it arrives, record it here and, if it
  changes the format, the change is a major version of this Worker.
