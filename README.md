# signer-worker

[![Release](https://img.shields.io/github/v/tag/sybenx/signer-worker?style=for-the-badge)](../../tags)

One share of your FROSTR key, held by a Cloudflare Worker on the free tier, deployed in one click.

FROSTR splits a nostr key into shares. Any two of three (or whatever threshold you chose) sign together; one share signs nothing alone. Most people keep their shares on a phone and a laptop, and the third somewhere that is always on. This is the somewhere: a Worker in your own Cloudflare account, with nothing to run at home and no server to rent.

**Requires a Cloudflare account** (free, no card) **and a GitHub account** (also free). Cloudflare puts a copy of the code in your Git account and deploys from there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sybenx/signer-worker)

If you have already deployed, see "Keeping it updated" below for the one file that keeps your copy in step with this one automatically.

## Setup

1. Click **Deploy to Cloudflare**. You'll be prompted to create a free Cloudflare account if you don't have one.
2. On **Set up your application**, pick your GitHub account from the **Git account** dropdown. Cloudflare creates a repo there holding your copy. Leave **Create private Git repository** unchecked unless you have a reason; public repos get free GitHub Actions minutes, which the updater uses. Click **Deploy**.
3. The build takes about 30 seconds. **Refresh the page** when it finishes. A **Visit** button appears at the top right; that's your Worker.
4. Open that URL. It shows a QR code. In your FROSTR app, choose to send a share to another device and scan it. A five-digit code appears on this page; type it into the app. The page then names the group the share belongs to and asks you to confirm. This step is one-time and permanent; see "What it holds" below.
5. In the app, add this Worker's relay address to the group's relay list. The address is shown on the page under **Diagnostics**.

No dashboard configuration is required.

## Keeping it updated

The deploy button copies this repo into your GitHub account as an independent repo, not a fork, so nothing pulls in upstream changes on its own, and the copy arrives without the workflow that would. The badge below is that workflow: commit the file it hands you and your Worker updates itself from then on.

[![Turn on auto-update](https://img.shields.io/badge/Turn%20on%20auto--update-555555?style=flat-square)](../../new/main?filename=.github/workflows/sync.yml&value=name%3A%20Sync%20from%20upstream%0A%0Aon%3A%0A%20%20%23%20Weekly%2C%20which%20is%20what%20makes%20committing%20this%20file%20the%20whole%20of%20turning%0A%20%20%23%20auto-update%20on%3A%20there%20is%20no%20second%20switch%20to%20find%20and%20nothing%20to%20come%0A%20%20%23%20back%20and%20click.%20Monday%20morning%20UTC%2C%20at%20a%20minute%20nowhere%20near%20the%20top%0A%20%20%23%20of%20the%20hour%20--%20GitHub%20runs%20scheduled%20jobs%20on%20a%20shared%20queue%20and%20delays%0A%20%20%23%20the%20ones%20piled%20onto%20%3A00%20%28docs.github.com%2Factions%2Freference%2Fworkflows-and-actions%2Fevents-that-trigger-workflows%2C%0A%20%20%23%20checked%202026-08-31%29.%0A%20%20%23%0A%20%20%23%20A%20run%20against%20an%20unchanged%20upstream%20pushes%20nothing%20and%20redeploys%0A%20%20%23%20nothing%20%28see%20%22Commit%20and%20push%22%20below%29%2C%20so%20the%20cost%20of%20the%20cadence%20is%0A%20%20%23%20roughly%20a%20minute%20of%20Actions%20time%20a%20week%2C%20free%20on%20public%20repos.%0A%20%20%23%0A%20%20%23%20Worth%20knowing%3A%20GitHub%20disables%20scheduled%20workflows%20in%20a%20repository%0A%20%20%23%20with%2060%20days%20of%20no%20activity%20and%20emails%20the%20owner%2C%20so%20a%20relay%20left%0A%20%20%23%20entirely%20alone%20can%20stop%20checking.%20A%20sync%20that%20lands%20a%20commit%20is%0A%20%20%23%20itself%20activity%2C%20so%20this%20only%20bites%20when%20upstream%20has%20also%20been%0A%20%20%23%20quiet%20--%20and%20re-enabling%20is%20one%20button%20on%20the%20Actions%20tab.%0A%20%20schedule%3A%0A%20%20%20%20-%20cron%3A%20%2223%206%20%2A%20%2A%201%22%0A%0A%20%20%23%20Kept%20beside%20the%20schedule%2C%20not%20replaced%20by%20it%3A%20this%20is%20the%20%22check%20now%22%0A%20%20%23%20button%20for%20someone%20who%20has%20just%20read%20about%20a%20fix%20and%20does%20not%20want%20to%0A%20%20%23%20wait%20until%20Monday.%0A%20%20workflow_dispatch%3A%0A%0Apermissions%3A%0A%20%20contents%3A%20write%0A%0Ajobs%3A%0A%20%20sync%3A%0A%20%20%20%20runs-on%3A%20ubuntu-latest%0A%20%20%20%20%23%20The%20%22Deploy%20to%20Cloudflare%22%20button%20clones%20this%20repo%20into%20the%20user%27s%20account%20as%20an%0A%20%20%20%20%23%20independent%20repo%2C%20not%20a%20GitHub%20fork%2C%20so%20this%20workflow%20ships%20inside%20every%20downstream%0A%20%20%20%20%23%20copy%20too.%20Guard%20so%20it%20no-ops%20when%20it%20runs%20in%20the%20upstream%20repo%20itself.%0A%20%20%20%20if%3A%20github.repository%20%21%3D%20%27sybenx%2Fsigner-worker%27%0A%20%20%20%20steps%3A%0A%20%20%20%20%20%20-%20name%3A%20Checkout%0A%20%20%20%20%20%20%20%20uses%3A%20actions%2Fcheckout%40v6%0A%20%20%20%20%20%20%20%20with%3A%0A%20%20%20%20%20%20%20%20%20%20fetch-depth%3A%200%0A%0A%20%20%20%20%20%20-%20name%3A%20Configure%20git%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.name%20%22github-actions%5Bbot%5D%22%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.email%20%22github-actions%5Bbot%5D%40users.noreply.github.com%22%0A%0A%20%20%20%20%20%20-%20name%3A%20Fetch%20upstream%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20remote%20add%20upstream%20https%3A%2F%2Fgithub.com%2Fsybenx%2Fsigner-worker.git%0A%20%20%20%20%20%20%20%20%20%20git%20fetch%20upstream%20main%0A%0A%20%20%20%20%20%20-%20name%3A%20Pull%20in%20upstream%20files%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20upstream%2Fmain%20--%20.%0A%0A%20%20%20%20%20%20-%20name%3A%20Restore%20local%20config%0A%20%20%20%20%20%20%20%20%23%20wrangler.jsonc%20is%20the%20file%20a%20downstream%20copy%20may%20have%20edited%20%28its%20Worker%20name%2C%20a%20rate-limit%20namespace%20id%29%2C%0A%20%20%20%20%20%20%20%20%23%20and%20.github%2F%20holds%20this%20workflow%20itself%20%E2%80%94%20neither%20must%20ever%20be%20overwritten%20by%20upstream.%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20HEAD%20--%20wrangler.jsonc%20.github%2F%0A%0A%20%20%20%20%20%20-%20name%3A%20Stage%20deletions%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20diff%20--diff-filter%3DD%20--name-only%20HEAD%20upstream%2Fmain%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20grep%20-v%20%27%5E%5C.github%2F%27%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20xargs%20-r%20git%20rm%20--%0A%0A%20%20%20%20%20%20-%20name%3A%20Commit%20and%20push%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20if%20git%20diff%20--quiet%20%26%26%20git%20diff%20--cached%20--quiet%3B%20then%0A%20%20%20%20%20%20%20%20%20%20%20%20echo%20%22Already%20up%20to%20date%20with%20upstream.%22%0A%20%20%20%20%20%20%20%20%20%20%20%20exit%200%0A%20%20%20%20%20%20%20%20%20%20fi%0A%20%20%20%20%20%20%20%20%20%20git%20add%20-A%0A%20%20%20%20%20%20%20%20%20%20git%20commit%20-m%20%22Sync%20from%20upstream%20%28sybenx%2Fsigner-worker%29%22%0A%20%20%20%20%20%20%20%20%20%20git%20push%20origin%20HEAD%3A%24%7B%7B%20github.ref_name%20%7D%7D%0A)

That link opens GitHub's "new file" page in your copy with the workflow already filled in. Commit it. It checks this repo every Monday and, when there is something new, pulls it in and redeploys. **Actions** → **Sync from upstream** → **Run workflow** checks now.

## What it holds

This Worker holds **one share, not the key**. A share cannot sign anything by itself, and it cannot sign at all until your other devices list this Worker among the group's relays. Someone who broke into the Worker would leave with something that is useless without another share.

**Deleting the Worker deletes the share.** There is no export and no recovery: the share lives in the Worker's storage and nowhere else. If you delete the Worker, make a new share for a new Worker from a device that still holds one. This is also why this is a separate project from [bothy](https://github.com/sybenx/bothy), a relay on the same platform: bothy's only reset is deleting the Worker, and a share must not die with a relay reset.

The pairing is permanent. Once a share is held here, no second share can be held, and the pairing page is gone. To hold a different share, deploy a fresh Worker.

The QR code never carries the share. It carries a one-time address the page is listening at; the share travels encrypted from your app to this page, and the code you type is what proves the app is talking to this page and not to someone who photographed it. Before anything is kept, the page names the group and asks.

## What it does today

Holds a share. Signing with it, which is what the share is for, arrives in the next release; until then the relay address under Diagnostics is shown so you can add it to your group ahead of time, and connections to it are refused. This README will say when that changes.

## Configuration

The deploy button only asks for a project name. Everything else is an optional variable you can add later in the Cloudflare dashboard (**Workers & Pages → your worker → Settings → Variables**) if you want it:

| Var | Purpose |
|---|---|
| `OWNER_CREDS` | Hold a share set at deploy time instead of pairing: the group and share strings from your FROSTR app, separated by a space (`bfgroup1... bfshare1...`). Disables the pairing page and the claim endpoint. Add it as a **secret**, not a plain variable: a Worker connected to a Git repo may sync plain variables from the repo on deploy. |
| `BOUNCE_HOST` | Host named in the pairing QR for a phone whose camera opens a browser instead of a FROSTR app. Defaults to this Worker's own host, which serves that page itself. |
| `MAX_NONCE_ROWS_PER_DAY` | Reserved for the signing release. Documented there. |

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a plain variable you added in the dashboard. Secrets are never synced.

## HTTP endpoints

- `GET /api/status`: whether a share is held, the group's name and picture, the share's index, the threshold and member count, and while nothing is held, what the pairing page needs. Never a credential.
- `POST /api/claim`: the pairing page's one call; body `{ group, share, profile? }`. Refuses anything but a share that belongs to its group, refuses a second claim, and answers 404 when `OWNER_CREDS` is set.
- `GET /pair`: the page a phone's camera lands on if it opened a browser rather than a FROSTR app. Static; it reads the link and hands it back as text.

Every endpoint that reaches storage is rate limited per IP at 60 requests a minute. Over the limit you get a `429` with a `Retry-After`. The page itself is a static file and is never rate limited.

## What this is not

Not a relay for anything but its own group's traffic; not a key backup; not a place to hold more than one share; not a wallet. It stores no events and serves no history. The list of decisions is in `CLAUDE.md` "What it refuses to be".

## Attribution

Conventions, the deploy and update flow, the rate-limit shape, the IP normaliser and the NIP-98 verifier come from [bothy](https://github.com/sybenx/bothy) (MIT). The FROST arithmetic is [@vbyte/frost](https://www.npmjs.com/package/@vbyte/frost), driven by a port of the protocol layer of [FROSTR-ORG/bifrost](https://github.com/FROSTR-ORG/bifrost) 2.0.2 (MIT, Christopher Scott), whose wire format this Worker speaks byte for byte; the transport is ported from [@vbyte/nostr-sdk](https://www.npmjs.com/package/@vbyte/nostr-sdk) 1.0.1 (MIT). The echo sent after pairing follows [FROSTR-ORG/igloo-core](https://github.com/FROSTR-ORG/igloo-core). The pairing flow implements the QR Secret Transfer specification in [sybenx/nostr-key-management](https://github.com/sybenx/nostr-key-management). QR codes are drawn by [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT). Which of bifrost's wire formats is the one to build against is an open question, [FROSTR-ORG/bifrost#12](https://github.com/FROSTR-ORG/bifrost/issues/12).

## Development

```bash
npm install
npm run dev          # wrangler dev, local DO with SQLite
npm run test         # vitest under workerd: QRST conformance, claim, the Phase 0 spike
npm run typecheck
npm run build-page   # rebuild public/pair.js after editing src/page/
npm run deploy       # wrangler deploy
```

See `CLAUDE.md` for architecture, the free-tier budget this project is built against (`docs/budget.md`), and the working conventions.

## License

MIT.
