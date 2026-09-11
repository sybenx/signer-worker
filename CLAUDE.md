# signer-worker

One FROSTR share, held by a Cloudflare Worker on the free tier, deployed in one click. For people who do not have a machine to run FROSTR-ORG/igloo-server on. A sibling of [bothy](https://github.com/sybenx/bothy), whose conventions this repository copies; separate from it because bothy's only reset is deleting the Worker, and a share must not die with a relay reset.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: the management POST on `Content-Type: application/nostr+json+rpc` (checked first, NIP-86's convention), `/api/status`, `/api/claim`, the WebSocket upgrade to the Durable Object, everything else to the static `public/` page. Every route that reaches the Durable Object is rate limited per IP by Cloudflare's Rate Limiting binding before the Worker's own code runs; static assets are not.
- Exactly one Durable Object (`Signer`, [src/signer.ts](src/signer.ts)), addressed by `idFromName("signer")`. SQLite-backed. The share, the group, the nonce pool ([src/pool.ts](src/pool.ts)), the peer policy and the one-line signing record live here. **It stores no events.**
- The Durable Object never opens an outbound connection. A Worker cannot hold an outbound WebSocket across requests, so this is not a bifrost node connecting to relays: it is a relay for its own traffic. Peers list this Worker as one of their relays; it accepts inbound WebSockets, takes kind-20000 events `p`-tagged to its share pubkey, and publishes its responses on the requester's own subscription. The one outbound act in the whole design, the echo after pairing, is signed by the object and published by the browser that ran the pairing.
- **Every piece of FROST arithmetic runs inside the object**, never in the Worker's fetch handler. The Worker's CPU ceiling is 10 ms a request; the object's is 30 s. A whole inbound `/sign` round is about 14 ms of Node CPU. See [docs/budget.md](docs/budget.md).
- The wire format is `@frostr/bifrost` 2.0.2's ([src/wire.ts](src/wire.ts), [src/frost.ts](src/frost.ts)): kind 20000, NIP-44 v2 over the ECDH x-coordinate with bifrost's unpadded base64url, the `@vbyte/nostr-sdk` RPC envelope, HMAC-derived nonce codes. bifrost's own `docs/PROTOCOL.md` describes an older envelope; the code is what peers run. Three incompatible formats exist (1.x, 2.x, bifrost-rs) and the Igloo apps pin 1.x today; which is canonical is [FROSTR-ORG/bifrost#12](https://github.com/FROSTR-ORG/bifrost/issues/12), recorded in docs/budget.md "The stack question". The echo ([src/echo.ts](src/echo.ts)) is the ONE place the 1.x format is produced, because igloo-core 0.2.4 is what listens for it.
- **The share arrives by QR Secret Transfer, never by pasting.** The page ([public/index.html](public/index.html), script [src/page/pair.ts](src/page/pair.ts) bundled to `public/pair.js`) shows a QRST 11.2 link as a QR (`mode=offer`, `p=frost-share`, bounce host from `BOUNCE_HOST`), runs Flow A as the Receiver in the browser against three public relays ([src/qrst.ts](src/qrst.ts), no DOM, fully tested), and POSTs the verified pair to the object. The `frost-share` payload is a bfgroup and a bfshare ([src/credentials.ts](src/credentials.ts)); the P4 check is bifrost's `is_group_member`. The 12.3 light flow is the `frost://` form with a returned secret, offered under "Can't scan?". Multiple responders are held (at most three), one code shown at a time, the notice from 13 verbatim.
- **The claim is permanent** and gets exactly one confirmation naming the consequence. First valid pair in wins; no signature on the claim itself, because a share that is not a member of its group is refused and a share that is signs nothing alone. `OWNER_CREDS` is the no-claim alternative, mirroring bothy's `OWNER_PUBKEY`: set, it disables the claim endpoint and the pairing page. Environment outranks storage.
- **The relay half** ([src/signer.ts](src/signer.ts) `handleEvent`, `handleReq`): `EVENT`, `REQ`, `CLOSE`, `EOSE`, `OK`, `CLOSED`, `NOTICE`, and nothing else. Every `REQ` gets `EOSE` at once (nothing stored) and stays open; a filter that could never match this share's own kind-20000 output is `CLOSED` with the reason. Every `EVENT` runs the refusal ladder in docs/budget.md order before signature and decrypt. Handlers ([src/signer.ts](src/signer.ts) `onPing`/`onSign`/`onEcdh`/`onOnboard`, echo inline) follow bifrost's `src/api/*.ts` signer side; validation is [src/schema.ts](src/schema.ts). A refusal travels in the `OK`, never silently and never as an RPC reject, except onboard, which bifrost itself rejects over RPC. A response is delivered to every open subscription on every connection that matches it, and a request whose answer could reach no subscription is refused before any arithmetic.
- **Peer policy** ([src/policy.ts](src/policy.ts)) is igloo-server's schema (`allowSend`, `allowReceive`, `label`, `note`; only non-defaults persisted; all-defaults is a removal), set only by the NIP-86-shaped management call authenticated by a NIP-98 event signed by the **group key** ([src/nip98.ts](src/nip98.ts), verified in the Worker before the object is woken). There is no environment baseline and so no precedence.
- **The bunker** ([src/bunker.ts](src/bunker.ts) pure, [src/nip46.ts](src/nip46.ts) protocol and policy, the rest in signer.ts): kind 24133 addressed to the bunker's own transport key runs the same refusal ladder, then NIP-46 `connect` (secret required once per app, `perms` become the session's policy), `ping`, `get_public_key`, `sign_event`, `nip44_*`, `nip04_*`. A sign or an encrypt is a ROUND this Worker initiates: it picks `threshold - 1` peers that are allowed (`allowSend`), present on this relay with a subscription that would carry the request, and (for signing) have handed over enough nonces; consumes one of each peer's nonces; writes the round to `pending`; delivers one kind-20000 request per peer on their subscriptions; collects their accepts in `handleEvent`'s response path; combines with its own part; verifies against the group key; answers the app. A round that nobody answers is ended by the alarm after 30 s with a plain-words error. Policy is igloo-server's `{methods, kinds}` with igloo's rule; the bunker's policy always applies, a session's narrows signing and encryption but never `get_public_key`. **The connect secret is never in `/api/status`**: it is returned once by the claim, shown once on the page, and otherwise only to `getbunker`. `nostrconnect://` is refused by construction: this relay opens no outbound connections.
- The page shows outcomes, not mechanisms: the group's name and picture, that one share of N is held, how many other devices reached it in the last hour, the last signing result in one line, how many apps are connected and what the last app asked. "Share", "group", "relay", "bunker" are the words. Never a credential; bech32 strings and `wss://` only inside the Diagnostics panel.

## What it refuses to be

No storage of events (it is a relay for one group's live traffic and nothing else; no REQ is ever answered from history). No more than one share. No export of the share, ever, in any form (deleting the Worker deletes the share, and the README says so). No pasting a `bfshare` into a form: the only ways in are QRST and `OWNER_CREDS`. No outbound connection from the Durable Object. No key generation, no dealer, no rotation (those belong to the FROSTR apps). No multi-region, no D1, no KV. No NIP-05, no media. No management UI beyond the status page; policy changes are NIP-98-signed calls by the group key. No `nostrconnect://` (it would need an outbound connection). No approval queue for app requests: policy decides, or the request is refused with the reason. No caching of threshold ECDH results: a shared secret at rest is as sensitive as the share.

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block: a clean deploy must ask for nothing but a project name. See [src/env.d.ts](src/env.d.ts). `OWNER_CREDS` is a credential and should be a **secret** (`wrangler secret put`), for the reason bothy gives for its VAPID key: a git-connected Worker may sync plain vars from the config on deploy, and secrets are never synced. `MAX_NONCE_ROWS_PER_DAY` takes a number or the exact string `"off"` ([src/limits.ts](src/limits.ts) `resolveLimit`), default 50,000, and gates nonce generation only, never a spend.

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
- **The bunker secret is a credential for the key.** Anyone holding the bunker link can sign as the group, within the bunker's policy, until the secret is rotated. That is NIP-46's model and the README says so in those words. The secret therefore never appears in the unauthenticated status document; it is returned once by the claim and otherwise only to the group-key-signed `getbunker`.
- **Rate limits**: 60 requests a minute per IP on every HTTP path and the WebSocket upgrade; inside the object, 50 messages in 10 s per IP and 120 requests a minute per peer pubkey, both in memory. The pairing page is static and never limited, so the page that says "refusing" always loads.
- **A member is trusted to be a member, not to be right.** Every request from a member is validated against bifrost's schema and the group (session id recomputed, members checked, nonce code proven to derive to the claimed points) before a nonce is spent; a nonce is spent (deleted) before the partial signature is made, so a repeat of the same request finds nothing. Echo is answered for members only, where bifrost answers anyone: an echo costs a decrypt and an encrypt, and a stranger should not be able to buy that.

## Architecture map

- [src/index.ts](src/index.ts): routing, rate limit, status and claim handlers.
- [src/signer.ts](src/signer.ts): the Durable Object; schema; claim; status; the relay; the handlers; management.
- [src/pool.ts](src/pool.ts): the nonce pool as SQL, measured by test/budget.test.ts.
- [src/policy.ts](src/policy.ts), [src/schema.ts](src/schema.ts), [src/nip98.ts](src/nip98.ts): peer policy, request validation, management auth.
- [src/nip46.ts](src/nip46.ts), [src/nip04.ts](src/nip04.ts), [src/bunker.ts](src/bunker.ts): the bunker's protocol, its legacy transport, and its rounds.
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

[test/qrst.test.ts](test/qrst.test.ts) drives the Receiver through Flow A with a scripted Sender ([test/helpers/sender.ts](test/helpers/sender.ts)): the full round, attribution, the session window, the commit check, P4 failure, multiple responders, and the light flow. [test/claim.test.ts](test/claim.test.ts) covers the claim over HTTP, the status document (asserting no credential string appears), and `OWNER_CREDS` by handing the Worker and the object a configured env. [test/relay.test.ts](test/relay.test.ts) asserts the NIP-01 subset and the refusal ladder by the reason each refusal gives. [test/handlers.test.ts](test/handlers.test.ts) drives the five handlers through a bifrost-shaped peer ([test/helpers/peer.ts](test/helpers/peer.ts)): a partial signature that combines into a valid group signature, a spent nonce refused, a threshold ECDH equal to the whole key's, onboard, echo. [test/manage.test.ts](test/manage.test.ts) covers the management call signed by the reconstructed group key and what a blocked peer sees. [test/budget.test.ts](test/budget.test.ts) pins rows written per nonce against `rowsWritten`, the daily cap, and that the object survives eviction with its sockets, subscriptions and pool intact. [test/bunker.test.ts](test/bunker.test.ts) runs an app ([test/helpers/nip46.ts](test/helpers/nip46.ts) `Client`) against the bunker with a peer that answers rounds the way a bifrost node would (`servePeer`): connect with and without the secret, a signed event that verifies against the group key, a threshold NIP-44 ciphertext the third party decrypts with a plain ECDH, policy by kind, the missing-device message, the alarm timeout, secret rotation and session revocation, and that the secret never appears in the status document. [test/spike.test.ts](test/spike.test.ts) is Phase 0's record. Storage isolation is per file; `test/helpers/isolate.ts` resets between tests that claim.

## Release step

`package.json`'s `version` is the single source of truth, served on `/api/status` and shown in the page footer. Bump it whenever `main` moves past the last tag. Annotated tags only (`git tag -a`); verify with `git ls-remote --tags origin <tag>` after pushing.

## Attribution

MIT. See README.md "Attribution". Reference code was read to understand the protocol; the ports from bifrost and nostr-sdk are marked as such at the top of the files that carry them.
