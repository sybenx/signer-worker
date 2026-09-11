// Caps, and the one shape they all take. Adapted from bothy's src/limits.ts
// (github.com/sybenx/bothy, MIT): each env-overridable cap accepts a
// positive number or the exact string "off", and nothing else removes it.

// The exact string that turns a cap off. Only this one value, because
// removing a safety cap must be a deliberate, spelled-out act, never
// something any truthy value does by accident. A malformed or empty
// value falls back to the default rather than resolving to "no limit" --
// a typo in the Cloudflare dashboard should cost you the override, not
// the cap.
const DISABLE_VALUE = "off";

// Null means the cap is disabled; callers skip the check entirely rather
// than comparing against Infinity.
export function resolveLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (raw === DISABLE_VALUE) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Rows the nonce pool may write in one UTC day, against the free tier's
// 100,000. Half, so the other half is always there for signing against
// nonces already issued. See docs/budget.md "Rows written: the nonce pool".
export const MAX_NONCE_ROWS_PER_DAY = 50_000;

export function maxNonceRowsPerDay(env: Env): number | null {
  return resolveLimit(env.MAX_NONCE_ROWS_PER_DAY, MAX_NONCE_ROWS_PER_DAY);
}

// Matches the `period` in wrangler.jsonc's ratelimits block; used only
// to fill Retry-After.
export const HTTP_RATE_LIMIT_PERIOD_SECONDS = 60;

// A WebSocket attachment (the hibernation API's per-connection state)
// may hold at most 16,384 bytes serialized
// (developers.cloudflare.com/durable-objects/best-practices/websockets/,
// checked 2026-09-11). Checked before storing rather than discovered by
// serializeAttachment throwing, and set below the ceiling, as bothy does,
// so what else the state carries (the address) cannot push a REQ that
// passed over the edge.
export const MAX_CONN_STATE_BYTES = 15 * 1024;

// Frames larger than this are refused before JSON.parse. A bifrost sign
// request for a 100-hash batch with three members' nonces is under 30 KB;
// nothing legitimate approaches this.
export const MAX_FRAME_BYTES = 64 * 1024;

// Per-IP message throttle inside the object (bothy's figures), in memory,
// never in SQLite: a best-effort abuse mitigation is not worth a row per
// message, and resetting on hibernation is fine.
export const IP_RATE_LIMIT_WINDOW_MS = 10_000;
export const IP_RATE_LIMIT_MAX_MESSAGES = 50;

// Per-peer request throttle, by pubkey, so a peer cannot get a second
// allowance by changing address. A bifrost node batches its signing into
// one request per 100 ms, so a busy bunker can legitimately ask several
// times a second for a moment; two a second sustained is far above any
// real client and, at ~6 ms of object CPU per sign, still under a second
// of CPU a minute (docs/budget.md).
export const PEER_RATE_LIMIT_WINDOW_MS = 60_000;
export const PEER_RATE_LIMIT_MAX_REQUESTS = 120;

// Nonce pool figures, bifrost's own (src/const.ts): pool size per peer,
// the level under which a peer is handed more, how many, and the level
// under which bifrost refuses to initiate. This Worker initiates nothing
// in this release, so the critical threshold is recorded for the NIP-46
// release and unused here.
export const NONCE_POOL_SIZE = 100;
export const NONCE_MIN_THRESHOLD = 20;
export const NONCE_REPLENISH_COUNT = 50;
export const NONCE_CRITICAL_THRESHOLD = 5;

// Concurrent subscriptions one connection may hold. A bifrost node keeps
// exactly one; a handful covers a client that reconnects untidily.
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 4;

export function secondsUntilUtcMidnight(nowMs: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - nowMs) / 1000));
}
