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
// may hold at most 2 KiB
// (developers.cloudflare.com/durable-objects/api/state/#serializeattachment,
// checked 2026-09-11: "up to 2,048 bytes"). Checked before storing
// rather than discovered by serializeAttachment throwing.
export const MAX_CONN_STATE_BYTES = 2048;

// Concurrent subscriptions one connection may hold. A bifrost node keeps
// exactly one; a handful covers a client that reconnects untidily.
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 4;

export function secondsUntilUtcMidnight(nowMs: number): number {
  const next = new Date(nowMs);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - nowMs) / 1000));
}
