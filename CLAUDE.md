# signer-worker

One FROSTR share, held by a Cloudflare Worker on the free tier, deployed in one click. For people who do not have a machine to run FROSTR-ORG/igloo-server on. A sibling of [bothy](https://github.com/sybenx/bothy), whose conventions this repository copies; separate from it because bothy's only reset is deleting the Worker, and a share must not die with a relay reset.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: `/api/status`, `/api/claim`, the WebSocket upgrade (refused until the signing release), everything else to the static `public/` page. Every route that reaches the Durable Object is rate limited per IP by Cloudflare's Rate Limiting binding before the Worker's own code runs; static assets are not.
- Exactly one Durable Object (`Signer`, [src/signer.ts](src/signer.ts)), addressed by `idFromName("signer")`. SQLite-backed. The share, the group, and (from the signing release) the nonce pool and the peer policy live here. **It stores no events.**
- The Durable Object never opens an outbound connection. A Worker cannot hold an outbound WebSocket across requests, so this is not a bifrost node connecting to relays: it is a relay for its own traffic. Peers list this Worker as one of their relays; it accepts inbound WebSockets, takes kind-20000 events `p`-tagged to its share pubkey, and publishes its responses on the requester's own subscription. The one outbound act in the whole design, the echo after pairing, is signed by the object and published by the browser that ran the pairing.
- **Every piece of FROST arithmetic runs inside the object**, never in the Worker's fetch handler. The Worker's CPU ceiling is 10 ms a request; the object's is 30 s. A whole inbound `/sign` round is about 14 ms of Node CPU. See [docs/budget.md](docs/budget.md).
- The wire format is `@frostr/bifrost` 2.0.2's ([src/wire.ts](src/wire.ts), [src/frost.ts](src/frost.ts)): kind 20000, NIP-44 v2 over the ECDH x-coordinate with bifrost's unpadded base64url, the `@vbyte/nostr-sdk` RPC envelope, HMAC-derived nonce codes. bifrost's own `docs/PROTOCOL.md` describes an older envelope; the code is what peers run. Three incompatible formats exist (1.x, 2.x, bifrost-rs) and the Igloo apps pin 1.x today; which is canonical is [FROSTR-ORG/bifrost#12](https://github.com/FROSTR-ORG/bifrost/issues/12), recorded in docs/budget.md "The stack question". The echo ([src/echo.ts](src/echo.ts)) is the ONE place the 1.x format is produced, because igloo-core 0.2.4 is what listens for it.
- **The share arrives by QR Secret Transfer, never by pasting.** The page ([public/index.html](public/index.html), script [src/page/pair.ts](src/page/pair.ts) bundled to `public/pair.js`) shows a QRST 11.2 link as a QR (`mode=offer`, `p=frost-share`, bounce host from `BOUNCE_HOST`), runs Flow A as the Receiver in the browser against three public relays ([src/qrst.ts](src/qrst.ts), no DOM, fully tested), and POSTs the verified pair to the object. The `frost-share` payload is a bfgroup and a bfshare ([src/credentials.ts](src/credentials.ts)); the P4 check is bifrost's `is_group_member`. The 12.3 light flow is the `frost://` form with a returned secret, offered under "Can't scan?". Multiple responders are held (at most three), one code shown at a time, the notice from 13 verbatim.
- **The claim is permanent** and gets exactly one confirmation naming the consequence. First valid pair in wins; no signature on the claim itself, because a share that is not a member of its group is refused and a share that is signs nothing alone. `OWNER_CREDS` is the no-claim alternative, mirroring bothy's `OWNER_PUBKEY`: set, it disables the claim endpoint and the pairing page. Environment outranks storage.
- The page shows outcomes, not mechanisms: the group's name and picture, that one share of N is held, peers reachable and the last signing result (from the signing release). "Share", "group", "relay", "bunker" are the words. Never a credential; bech32 strings and `wss://` only inside the Diagnostics panel.

## What it refuses to be

No storage of events (it is a relay for one group's live traffic and nothing else; no REQ is ever answered from history). No more than one share. No export of the share, ever, in any form (deleting the Worker deletes the share, and the README says so). No pasting a `bfshare` into a form: the only ways in are QRST and `OWNER_CREDS`. No outbound connection from the Durable Object. No key generation, no dealer, no rotation (those belong to the FROSTR apps). No multi-region, no D1, no KV. No NIP-05, no media. No management UI beyond the status page; policy changes are NIP-98-signed calls from a device holding the group key (signing release).

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block: a clean deploy must ask for nothing but a project name. See [src/env.d.ts](src/env.d.ts). `OWNER_CREDS` is a credential and should be a **secret** (`wrangler secret put`), for the reason bothy gives for its VAPID key: a git-connected Worker may sync plain vars from the config on deploy, and secrets are never synced. `MAX_NONCE_ROWS_PER_DAY` takes a number or the exact string `"off"` ([src/limits.ts](src/limits.ts) `resolveLimit`); it binds from the signing release.

Redeploying does not reset the share; deleting the Worker does.

[.github/workflows/sync.yml](.github/workflows/sync.yml) is bothy's updater with the repository name changed; its reasoning, the `git checkout HEAD -- wrangler.jsonc .github/` step, and the `?value=` badge that `npm run sync-badge` regenerates are all as documented in bothy's CLAUDE.md "Configuration". Edit `sync.yml`, then run the script, or the README hands new deployments an updater that no longer exists.

## The budget

Lives in [docs/budget.md](docs/budget.md): the free-tier ceilings with the date they were checked, the Phase 0 measurements (about 2.2 ms wall clock per signer-side round in workerd; 14 ms of Node CPU for a whole inbound sign), and the rows-written arithmetic for the nonce pool that `MAX_NONCE_ROWS_PER_DAY` caps. The two ceilings that bind: Worker CPU (10 ms, which is why arithmetic lives in the object) and rows written (100,000 a day, which the nonce pool is the only recurring spender of).

## Threat model

- **A breach of the Worker yields one share.** It signs nothing alone. The group's other devices can rotate it out.
- **A photographed QR yields nothing.** It carries a burner public key. The SAS is commit-then-reveal, the Sender releases only after typing the code shown on this page, and this page commits only the candidate whose code the Sender confirmed and only after the operator confirms the P5 rendering. A racing responder is held as a candidate and never aborts the session (QRST 13).
- **A hostile page is not stopped by the SAS** (QRST 15): the operator visiting their own Worker's page is trusting the code their own Cloudflare account serves. That is the same trust as deploying it.
- **Public pairing relays see** a subscription for one burner and wraps addressed to another, seconds apart. The burners are per-session and carry no identity.
- **The claim has no signature**, deliberately: a wrong claim holds a share that belongs to a group the claimant already had a share of, or is refused. The recovery for a stranger claiming first is deleting the Worker, which costs nothing because nothing was held.
- **Rate limits**: 60 requests a minute per IP on every path that wakes the object. The pairing page is static and never limited, so the page that says "refusing" always loads.

## Architecture map

- [src/index.ts](src/index.ts): routing, rate limit, status and claim handlers.
- [src/signer.ts](src/signer.ts): the Durable Object; schema; claim; status.
- [src/frost.ts](src/frost.ts): bifrost's maths, ported, on `@vbyte/frost`.
- [src/wire.ts](src/wire.ts): bifrost's transport (kind 20000, NIP-44, RPC envelope), ported, on noble.
- [src/qrst.ts](src/qrst.ts): QR Secret Transfer, Receiver side, pure.
- [src/credentials.ts](src/credentials.ts), [src/owner-creds.ts](src/owner-creds.ts): the frost-share payload and `OWNER_CREDS`.
- [src/echo.ts](src/echo.ts): the igloo-core-format echo.
- [src/nostr.ts](src/nostr.ts), [src/ip.ts](src/ip.ts), [src/limits.ts](src/limits.ts): from bothy.
- [src/page/pair.ts](src/page/pair.ts) → `public/pair.js` via `scripts/build-page.mjs`: the page's glue. The bundle is committed; `--check` catches drift.
- [public/pair.html](public/pair.html): the QRST 11.2a bounce page.

## Conventions

- TypeScript strict mode, no `any`. Imports carry `.ts` extensions so Node can run [scripts/bench.mjs](scripts/bench.mjs) against the same files.
- `@noble/*` and `@scure/base` for everything except the FROST arithmetic, which is `@vbyte/frost` (with `@vbyte/buff`), the library bifrost itself uses, so that every byte layout is bifrost's by construction rather than by re-derivation.
- Cheapest refusals first on every inbound path: kind, `p` tag, rate limit, policy, then signature, then decrypt.
- Comments explain why, especially anything hibernation-, budget- or spec-related, and cite the section number (QRST, NKM, bifrost file).
- Pin dependency versions.
- Commit directly to `main`; no branches, no pull requests. Every commit that changes behaviour bumps `package.json`'s `version`. Tags are annotated. Nothing is pushed without the human saying so in that session.
- Before a change lands, the checklist in [docs/principles.md](docs/principles.md) gets a "no" on every line.

## Commands

```bash
npm install
npm run dev
npm run test
npm run typecheck        # Worker and page, two tsconfigs
npm run build-page       # rebuild public/pair.js
node scripts/build-page.mjs --check
node scripts/bench.mjs   # Node CPU figures for docs/budget.md
node scripts/sender.mjs <pairing link> [--auto|--light]   # a scripted QRST Sender, for trying the page without a phone
npm run sync-badge
npm run deploy
```

## Testing

[test/qrst.test.ts](test/qrst.test.ts) drives the Receiver through Flow A with a scripted Sender ([test/helpers/sender.ts](test/helpers/sender.ts)): the full round, attribution, the session window, the commit check, P4 failure, multiple responders, and the light flow. [test/claim.test.ts](test/claim.test.ts) covers the claim over HTTP, the status document (asserting no credential string appears), and `OWNER_CREDS` by handing the Worker and the object a configured env. [test/spike.test.ts](test/spike.test.ts) is Phase 0's record: a partial signature made here combines into a valid BIP-340 signature, with the timing printed. Storage isolation is per file; `test/helpers/isolate.ts` resets between tests that claim.

## Release step

`package.json`'s `version` is the single source of truth, served on `/api/status` and shown in the page footer. Bump it whenever `main` moves past the last tag. Annotated tags only (`git tag -a`); verify with `git ls-remote --tags origin <tag>` after pushing.

## Attribution

MIT. See README.md "Attribution". Reference code was read to understand the protocol; the ports from bifrost and nostr-sdk are marked as such at the top of the files that carry them.
