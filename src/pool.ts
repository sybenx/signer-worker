// The nonce pool, as SQL. bifrost keeps its pool in two Maps
// (class/pool.ts); here it is one table, because the object hibernates
// between messages and a Map would be empty on every wake. Functions take
// the SqlStorage so the suite can measure what each one writes
// (test/budget.test.ts) -- the figures in docs/budget.md are pinned there.
//
// Two directions. `out`: codes this signer generated for a peer; the peer
// spends one by naming it in a sign request, and the row is deleted then
// (deletion is consumption, bifrost's rule). `in`: public nonces a peer
// handed this signer to use when IT initiates; unused until the NIP-46
// release, stored now so the pool is full when that release arrives.
import {
  deriveSecretNonce,
  generateNoncePair,
  isValidPublicNonce,
  verifyNonceCode,
  xOnly,
  type DerivedPublicNonce,
  type GroupPackage,
  type MemberPublicNonce,
  type SecretNoncePair,
} from "./frost.ts";
import { NONCE_CRITICAL_THRESHOLD, NONCE_MIN_THRESHOLD, NONCE_POOL_SIZE } from "./limits.ts";

// Rows written per nonce row inserted or deleted, as measured by
// test/budget.test.ts against SqlStorageCursor.rowsWritten. The table is
// WITHOUT ROWID with a composite primary key, so the table is its own
// index and there is no second entry to pay for.
export const NONCE_ROW_COST = 1;

export interface NoncePoolStatus {
  peer_idx: number;
  peer_pk: string;
  available: number;
  needs_fill: boolean;
  critical: boolean;
}

function day(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10);
}

function count(sql: SqlStorage, direction: "in" | "out", peerIdx: number): number {
  return Number(
    sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM nonces WHERE direction = ? AND peer_idx = ?", direction, peerIdx).one().n,
  );
}

export function outgoingCount(sql: SqlStorage, peerIdx: number): number {
  return count(sql, "out", peerIdx);
}

export function incomingCount(sql: SqlStorage, peerIdx: number): number {
  return count(sql, "in", peerIdx);
}

// Nonce rows written so far in this UTC day, against MAX_NONCE_ROWS_PER_DAY.
export function nonceRowsToday(sql: SqlStorage, nowSec: number): number {
  const row = sql.exec<{ nonce_rows: number }>("SELECT nonce_rows FROM counters WHERE day = ?", day(nowSec)).toArray()[0];
  return row ? Number(row.nonce_rows) : 0;
}

function chargeRows(sql: SqlStorage, nowSec: number, rows: number): void {
  if (rows <= 0) return;
  sql.exec(
    "INSERT INTO counters (day, nonce_rows) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET nonce_rows = nonce_rows + excluded.nonce_rows",
    day(nowSec),
    rows,
  );
}

// How many more nonce rows may be written today. Infinity when the cap is
// off. Generation is what this gates; a spend (deletion) is never refused
// for budget, because refusing it would refuse a signature the peer has
// every right to, over a row the day's allowance already agreed to.
function remainingToday(sql: SqlStorage, nowSec: number, cap: number | null): number {
  if (cap === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, cap - nonceRowsToday(sql, nowSec));
}

// bifrost should_send_nonces_to: fewer than min_threshold active codes for
// this peer.
export function shouldReplenish(sql: SqlStorage, peerIdx: number): boolean {
  return outgoingCount(sql, peerIdx) < NONCE_MIN_THRESHOLD;
}

// bifrost generate_for_peer: never past pool_size for the peer, and here
// never past the day's remaining allowance. Returns what was actually
// generated, which may be nothing.
export function generateForPeer(
  sql: SqlStorage,
  shareSecret: string,
  peerIdx: number,
  requested: number,
  nowSec: number,
  cap: number | null,
): DerivedPublicNonce[] {
  const slots = NONCE_POOL_SIZE - outgoingCount(sql, peerIdx);
  const affordable = Math.floor(remainingToday(sql, nowSec, cap) / NONCE_ROW_COST);
  const n = Math.min(requested, slots, affordable);
  if (n <= 0) return [];
  const out: DerivedPublicNonce[] = [];
  for (let i = 0; i < n; i++) {
    const nonce = generateNoncePair(shareSecret);
    sql.exec(
      "INSERT INTO nonces (direction, peer_idx, code, binder_pn, hidden_pn, created_at) VALUES ('out', ?, ?, ?, ?, ?)",
      peerIdx,
      nonce.code,
      nonce.binder_pn,
      nonce.hidden_pn,
      nowSec,
    );
    out.push(nonce);
  }
  chargeRows(sql, nowSec, n * NONCE_ROW_COST);
  return out;
}

// bifrost derive_secret_for_signing + mark_spent, in one step: the code
// must be one this signer handed to this peer, it must derive to the
// public points the request claims, and it is deleted before the secret
// is returned -- so a second request naming the same code finds nothing,
// whatever happens to the first.
export function takeOutgoing(
  sql: SqlStorage,
  shareSecret: string,
  peerIdx: number,
  nonce: MemberPublicNonce,
  nowSec: number,
): SecretNoncePair | null {
  const row = sql
    .exec<{ binder_pn: string; hidden_pn: string }>(
      "SELECT binder_pn, hidden_pn FROM nonces WHERE direction = 'out' AND peer_idx = ? AND code = ?",
      peerIdx,
      nonce.code,
    )
    .toArray()[0];
  if (!row) return null;
  if (row.binder_pn !== nonce.binder_pn || row.hidden_pn !== nonce.hidden_pn) return null;
  if (!verifyNonceCode(shareSecret, nonce)) return null;
  sql.exec("DELETE FROM nonces WHERE direction = 'out' AND peer_idx = ? AND code = ?", peerIdx, nonce.code);
  chargeRows(sql, nowSec, NONCE_ROW_COST);
  return deriveSecretNonce(shareSecret, nonce.code);
}

// bifrost store_incoming: validated, deduplicated by code, and here capped
// at pool_size per peer and by the day's allowance. Returns how many were
// stored.
export function storeIncoming(
  sql: SqlStorage,
  peerIdx: number,
  nonces: DerivedPublicNonce[],
  nowSec: number,
  cap: number | null,
): number {
  const slots = NONCE_POOL_SIZE - incomingCount(sql, peerIdx);
  const affordable = Math.floor(remainingToday(sql, nowSec, cap) / NONCE_ROW_COST);
  let budget = Math.min(slots, affordable);
  let stored = 0;
  for (const nonce of nonces) {
    if (budget <= 0) break;
    if (!isValidPublicNonce(nonce)) continue;
    const cursor = sql.exec(
      "INSERT OR IGNORE INTO nonces (direction, peer_idx, code, binder_pn, hidden_pn, created_at) VALUES ('in', ?, ?, ?, ?, ?)",
      peerIdx,
      nonce.code,
      nonce.binder_pn,
      nonce.hidden_pn,
      nowSec,
    );
    if (cursor.rowsWritten > 0) {
      stored++;
      budget--;
    }
  }
  chargeRows(sql, nowSec, stored * NONCE_ROW_COST);
  return stored;
}

// bifrost consume_incoming: one of the nonces a peer handed this signer,
// taken (deleted) for a session this signer initiates. Null when the
// peer has handed over nothing usable.
export function consumeIncoming(sql: SqlStorage, peerIdx: number, nowSec: number): MemberPublicNonce | null {
  const row = sql
    .exec<{ code: string; binder_pn: string; hidden_pn: string }>(
      "SELECT code, binder_pn, hidden_pn FROM nonces WHERE direction = 'in' AND peer_idx = ? ORDER BY created_at LIMIT 1",
      peerIdx,
    )
    .toArray()[0];
  if (!row) return null;
  sql.exec("DELETE FROM nonces WHERE direction = 'in' AND peer_idx = ? AND code = ?", peerIdx, row.code);
  chargeRows(sql, nowSec, NONCE_ROW_COST);
  return { idx: peerIdx, code: row.code, binder_pn: row.binder_pn, hidden_pn: row.hidden_pn };
}

// bifrost can_sign: enough of the peer's nonces in hand to initiate.
export function canInitiateWith(sql: SqlStorage, peerIdx: number): boolean {
  return incomingCount(sql, peerIdx) > NONCE_CRITICAL_THRESHOLD;
}

// bifrost get_pool_status: what this signer holds FROM each peer.
export function poolStatus(sql: SqlStorage, group: GroupPackage, ourIdx: number): NoncePoolStatus[] {
  const out: NoncePoolStatus[] = [];
  for (const member of group.members) {
    if (member.idx === ourIdx) continue;
    const available = incomingCount(sql, member.idx);
    out.push({
      peer_idx: member.idx,
      peer_pk: xOnly(member.pubkey),
      available,
      needs_fill: available < NONCE_MIN_THRESHOLD,
      critical: available <= NONCE_CRITICAL_THRESHOLD,
    });
  }
  return out;
}
