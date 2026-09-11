// None of these are declared in wrangler.jsonc's `vars`: the Cloudflare
// deploy button prompts for every declared var with no notion of
// "optional", so a clean deploy must declare none (CLAUDE.md
// "Configuration"). Every field is read defensively (`env.X ?? fallback`).
// The generated Env type (worker-configuration.d.ts) never declares any of
// these, so this merges the optional fields onto the global `Env`.
//
// Same shape as bothy's src/env.d.ts (github.com/sybenx/bothy, MIT), which
// this file is adapted from.
interface Env {
  // Cloudflare's Rate Limiting binding, declared in wrangler.jsonc.
  // Optional because the docs do not say which plans the binding is
  // available on; src/index.ts calls it as `env.X?.limit(...)` and treats
  // an absent binding as "allowed".
  RATE_LIMIT_API?: RateLimit;
  // The no-claim alternative, mirroring bothy's OWNER_PUBKEY: the group
  // and share credentials as two bech32m strings separated by whitespace
  // or a comma, `bfgroup1... bfshare1...`. Set, it disables the pairing
  // page and the claim endpoint outright. Read by src/credentials.ts
  // resolveOwnerCreds; a value that does not decode is logged once and
  // read as unset, but the claim endpoint stays disabled either way,
  // since index.ts gates it on the variable being set rather than on it
  // decoding. It is the one piece of configuration that is a credential,
  // so it should be added with `wrangler secret put OWNER_CREDS` rather
  // than as a plain var -- a git-connected Worker may sync vars from
  // wrangler.jsonc on deploy and overwrite what was set in the dashboard.
  OWNER_CREDS?: string;
  // Host of the QRST bounce page named in the pairing QR
  // (QR_SECRET_TRANSFER.md 11.2a). Unset, the QR names this deployment's
  // own host, which serves the pairing page itself.
  BOUNCE_HOST?: string;
  // Daily cap on nonce rows written, a number or the exact string "off"
  // (src/limits.ts). See CLAUDE.md "The budget".
  MAX_NONCE_ROWS_PER_DAY?: string;
}
