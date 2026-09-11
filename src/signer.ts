// The one Durable Object: holds the share, and is the relay for the
// group's traffic to it.
//
// Hibernation rules (CLAUDE.md "What it is"): acceptWebSocket, never
// server.accept(); no outbound connection from inside this class, ever;
// nothing kept only in instance memory that has to survive a wake. The
// per-connection state (address, subscriptions) rides in the WebSocket
// attachment; the pool, the policy and the share are in SQLite; the two
// rate-limit maps are memory on purpose (limits.ts).
import { DurableObject } from "cloudflare:workers";
import { credentialsFromParts, type Credentials } from "./credentials.ts";
import { buildEchoEvent } from "./echo.ts";
import {
  createEcdhPkg,
  createPsigPkg,
  getGroupId,
  getPubkey,
  getSessionCtx,
  memberByIdx,
  memberByPubkey,
  pubkeysMatch,
  verifySessionPkg,
  xOnly,
} from "./frost.ts";
import {
  IP_RATE_LIMIT_MAX_MESSAGES,
  IP_RATE_LIMIT_WINDOW_MS,
  MAX_CONN_STATE_BYTES,
  MAX_FRAME_BYTES,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  NONCE_POOL_SIZE,
  NONCE_REPLENISH_COUNT,
  PEER_RATE_LIMIT_MAX_REQUESTS,
  PEER_RATE_LIMIT_WINDOW_MS,
  maxNonceRowsPerDay,
} from "./limits.ts";
import {
  idMatchesContent,
  matchesFilter,
  nowSeconds,
  pTagValues,
  parseEventShape,
  parseFilter,
  verifySignature,
  type Filter,
  type NostrEvent,
} from "./nostr.ts";
import { ownerCredsConfigured, resolveOwnerCreds } from "./owner-creds.ts";
import { DEFAULT_POLICY, policyOf, sanitizePolicyRecord, type PeerPolicy, type PeerPolicyRecord } from "./policy.ts";
import {
  generateForPeer,
  incomingCount,
  nonceRowsToday,
  outgoingCount,
  poolStatus,
  shouldReplenish,
  storeIncoming,
  takeOutgoing,
} from "./pool.ts";
import { parseEcdhRequest, parseOnboardRequest, parsePingRequest, parseSignSession } from "./schema.ts";
import { RPC_KIND, acceptMessage, rejectMessage, unwrapRpc, wrapRpc, type RequestMessage, type RpcMessage } from "./wire.ts";

// --- Public shapes ---------------------------------------------------------

export interface GroupProfile {
  name?: string;
  picture?: string;
}

export interface PeerStatus {
  index: number;
  // x-only hex; diagnostics only on the page.
  pubkey: string;
  lastSeen: number | null;
  policy: PeerPolicy;
  label: string | null;
  nonces: { outgoing: number; incoming: number };
}

export interface LastSign {
  at: number;
  requesterIndex: number | null;
  ok: boolean;
  reason: string | null;
}

export interface SignerStatus {
  claimed: boolean;
  source?: "env" | "claim";
  group?: {
    name: string | null;
    picture: string | null;
    pubkey: string;
    id: string;
    threshold: number;
    members: number;
  };
  share?: { index: number; pubkey: string };
  claimedAt?: number;
  peers?: PeerStatus[];
  lastSign?: LastSign | null;
  nonceRows?: { today: number; cap: number | null };
}

export type ClaimResult =
  | { status: "claimed"; sharePubkey: string; echo: NostrEvent }
  | { status: "conflict" }
  | { status: "disabled" }
  | { status: "invalid"; reason: string };

export type ManageResult = { result: unknown } | { error: string };

// NIP-86 `supportedmethods` answers exactly this. One word, lower case,
// like NIP-86's own names.
export const MANAGEMENT_METHODS = ["supportedmethods", "listpeerpolicies", "setpeerpolicy", "removepeerpolicy"] as const;

// --- Storage -----------------------------------------------------------------

interface MetaRow extends Record<string, SqlStorageValue> {
  group_pkg: string | null;
  share_pkg: string | null;
  group_name: string | null;
  group_picture: string | null;
  claimed_at: number | null;
  host: string | null;
}

// `meta` is one row, ever. `nonces` is the pool (src/pool.ts). `peers` is
// when each was last heard from, written at most once in five minutes per
// peer so a chatty peer costs a bounded number of rows a day.
// `peer_policies` is igloo-server's schema. `counters` is the day's
// nonce-row spend. `last_sign` is the one line the page shows. WITHOUT
// ROWID where the primary key is the only index, so a row is one row
// written, not two (test/budget.test.ts pins this).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  group_pkg     TEXT,
  share_pkg     TEXT,
  group_name    TEXT,
  group_picture TEXT,
  claimed_at    INTEGER,
  host          TEXT
);
INSERT OR IGNORE INTO meta (id) VALUES (1);
CREATE TABLE IF NOT EXISTS nonces (
  direction  TEXT    NOT NULL,
  peer_idx   INTEGER NOT NULL,
  code       TEXT    NOT NULL,
  binder_pn  TEXT    NOT NULL,
  hidden_pn  TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (direction, peer_idx, code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS peers (
  idx       INTEGER PRIMARY KEY,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_policies (
  pubkey        TEXT PRIMARY KEY,
  allow_send    INTEGER,
  allow_receive INTEGER,
  label         TEXT,
  note          TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS counters (
  day        TEXT PRIMARY KEY,
  nonce_rows INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS last_sign (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  at            INTEGER,
  requester_idx INTEGER,
  ok            INTEGER,
  reason        TEXT
);
INSERT OR IGNORE INTO last_sign (id) VALUES (1);
`;

const MAX_NAME_LENGTH = 100;
const MAX_PICTURE_LENGTH = 500;
// A peer's last_seen is refreshed at most this often.
const PEER_SEEN_INTERVAL_SECONDS = 300;

function sanitizeProfile(raw: unknown): GroupProfile {
  const out: GroupProfile = {};
  if (typeof raw !== "object" || raw === null) return out;
  const p = raw as Record<string, unknown>;
  if (typeof p.name === "string" && p.name.trim() !== "") out.name = p.name.trim().slice(0, MAX_NAME_LENGTH);
  if (typeof p.picture === "string" && p.picture.length <= MAX_PICTURE_LENGTH) {
    try {
      const url = new URL(p.picture);
      if (url.protocol === "https:") out.picture = url.href;
    } catch {
      // not a URL; dropped
    }
  }
  return out;
}

function sanitizePubkey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p = raw.trim().toLowerCase();
  if (p.length === 66 && (p.startsWith("02") || p.startsWith("03"))) p = p.slice(2);
  return /^[0-9a-f]{64}$/.test(p) ? p : null;
}

// --- Connections ---------------------------------------------------------------

// Per-connection state, in the WebSocket attachment so it survives
// hibernation. `subs` is what makes a response deliverable: a response
// goes to every open subscription, on any connection, whose filters it
// matches, and nowhere else.
interface ConnState {
  ip: string;
  subs: Record<string, Filter[]>;
}

function getState(ws: WebSocket): ConnState {
  return (ws.deserializeAttachment() as ConnState | null) ?? { ip: "unknown", subs: {} };
}

function setState(ws: WebSocket, state: ConnState): void {
  ws.serializeAttachment(state);
}

function stateFits(state: ConnState): boolean {
  return new TextEncoder().encode(JSON.stringify(state)).length <= MAX_CONN_STATE_BYTES;
}

function send(ws: WebSocket, message: unknown[]): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // A closing socket takes nothing; the close handler follows.
  }
}

function ok(ws: WebSocket, id: string, accepted: boolean, message: string): void {
  send(ws, ["OK", id, accepted, message]);
}

// RFC 6455 7.4.1: codes the runtime reports but no endpoint may send.
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);
const NORMAL_CLOSURE = 1000;

const PING_PONG = new WebSocketRequestResponsePair("ping", "pong");

const ONLY_OWN_TRAFFIC = `restricted: this relay carries kind ${RPC_KIND} addressed to its own share and nothing else`;

interface Window {
  start: number;
  count: number;
}

// What a handler decides: an RPC accept, an RPC reject (only onboard uses
// one, as bifrost does), a refusal that travels in the NIP-01 OK and
// nowhere else, or nothing (unknown method).
type HandlerOutcome = { accept: unknown } | { reject: string } | { refuse: string } | null;

// --- The object ------------------------------------------------------------------

export class Signer extends DurableObject<Env> {
  private readonly sql: SqlStorage = this.ctx.storage.sql;
  // Decoded credentials, keyed on the exact text they were decoded from,
  // so a change in the environment or a reset of storage can never be
  // answered from a stale decode.
  private cache: { key: string; creds: Credentials } | null = null;
  // Best-effort throttles; memory on purpose (limits.ts).
  private readonly ipWindows = new Map<string, Window>();
  private readonly peerWindows = new Map<string, Window>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every wake from hibernation: CREATE IF NOT EXISTS and two
    // no-op INSERTs, nothing that reads the pool.
    this.sql.exec(SCHEMA);
    ctx.setWebSocketAutoResponse(PING_PONG);
  }

  // --- Credentials ---------------------------------------------------------

  private meta(): MetaRow {
    return this.sql
      .exec<MetaRow>("SELECT group_pkg, share_pkg, group_name, group_picture, claimed_at, host FROM meta WHERE id = 1")
      .one();
  }

  // Environment outranks storage, mirroring bothy's OWNER_PUBKEY.
  private credentials(): Credentials | null {
    if (ownerCredsConfigured(this.env)) {
      const key = `env:${this.env.OWNER_CREDS}`;
      if (this.cache?.key === key) return this.cache.creds;
      const fromEnv = resolveOwnerCreds(this.env);
      if (fromEnv === null) return null;
      this.cache = { key, creds: fromEnv };
      return fromEnv;
    }
    const row = this.meta();
    if (row.group_pkg === null || row.share_pkg === null) return null;
    const key = `row:${row.group_pkg}:${row.share_pkg}`;
    if (this.cache?.key === key) return this.cache.creds;
    const parsed = credentialsFromParts(row.group_pkg, row.share_pkg);
    if (!parsed.ok) {
      console.error(`stored credentials do not parse: ${parsed.reason}`);
      return null;
    }
    this.cache = { key, creds: parsed.creds };
    return parsed.creds;
  }

  // --- Claim and status (RPC from the Worker) -------------------------------

  // The permanent action. First valid pair in wins. No signature on the
  // claim itself: the P4 check (share belongs to group) is what a claim
  // has to pass, and a share signs nothing alone. Single-threaded, so the
  // check-then-write is atomic; index.ts pre-checks only to refuse
  // cheaply.
  claim(groupStr: string, shareStr: string, profile: unknown, host: string): ClaimResult {
    if (ownerCredsConfigured(this.env)) return { status: "disabled" };
    if (this.meta().group_pkg !== null) return { status: "conflict" };
    const parsed = credentialsFromParts(groupStr, shareStr);
    if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
    const clean = sanitizeProfile(profile);
    this.sql.exec(
      "UPDATE meta SET group_pkg = ?, share_pkg = ?, group_name = ?, group_picture = ?, claimed_at = ?, host = ? WHERE id = 1",
      parsed.creds.groupStr,
      parsed.creds.shareStr,
      clean.name ?? null,
      clean.picture ?? null,
      nowSeconds(),
      host,
    );
    return {
      status: "claimed",
      sharePubkey: getPubkey(parsed.creds.share.seckey, "bip340"),
      // Signed here, published by the browser that ran the pairing.
      echo: buildEchoEvent(parsed.creds.share.seckey),
    };
  }

  getStatus(): SignerStatus {
    const creds = this.credentials();
    if (creds === null) return { claimed: false };
    const row = this.meta();
    const fromEnv = ownerCredsConfigured(this.env);
    const now = nowSeconds();
    const seen = new Map<number, number>();
    for (const p of this.sql.exec<{ idx: number; last_seen: number }>("SELECT idx, last_seen FROM peers").toArray()) {
      seen.set(Number(p.idx), Number(p.last_seen));
    }
    const peers: PeerStatus[] = creds.group.members
      .filter((m) => m.idx !== creds.share.idx)
      .sort((a, b) => a.idx - b.idx)
      .map((m) => {
        const record = this.policyRecord(xOnly(m.pubkey));
        return {
          index: m.idx,
          pubkey: xOnly(m.pubkey),
          lastSeen: seen.get(m.idx) ?? null,
          policy: policyOf(record),
          label: record?.label ?? null,
          nonces: { outgoing: outgoingCount(this.sql, m.idx), incoming: incomingCount(this.sql, m.idx) },
        };
      });
    const ls = this.sql
      .exec<{ at: number | null; requester_idx: number | null; ok: number | null; reason: string | null }>(
        "SELECT at, requester_idx, ok, reason FROM last_sign WHERE id = 1",
      )
      .one();
    const status: SignerStatus = {
      claimed: true,
      source: fromEnv ? "env" : "claim",
      group: {
        name: fromEnv ? null : row.group_name,
        picture: fromEnv ? null : row.group_picture,
        pubkey: xOnly(creds.group.group_pk),
        id: getGroupId(creds.group),
        threshold: creds.group.threshold,
        members: creds.group.members.length,
      },
      share: { index: creds.share.idx, pubkey: getPubkey(creds.share.seckey, "bip340") },
      peers,
      lastSign:
        ls.at === null
          ? null
          : {
              at: Number(ls.at),
              requesterIndex: ls.requester_idx === null ? null : Number(ls.requester_idx),
              ok: ls.ok === 1,
              reason: ls.reason,
            },
      nonceRows: { today: nonceRowsToday(this.sql, now), cap: maxNonceRowsPerDay(this.env) },
    };
    if (!fromEnv && row.claimed_at !== null) status.claimedAt = row.claimed_at;
    return status;
  }

  // --- Peer policy (RPC from the Worker, after NIP-98 by the group key) -----

  private policyRecord(pubkey: string): PeerPolicyRecord | null {
    const row = this.sql
      .exec<{ allow_send: number | null; allow_receive: number | null; label: string | null; note: string | null }>(
        "SELECT allow_send, allow_receive, label, note FROM peer_policies WHERE pubkey = ?",
        pubkey,
      )
      .toArray()[0];
    if (!row) return null;
    const out: PeerPolicyRecord = { pubkey };
    if (row.allow_send === 0) out.allowSend = false;
    if (row.allow_receive === 0) out.allowReceive = false;
    if (row.label) out.label = row.label;
    if (row.note) out.note = row.note;
    return out;
  }

  private policyFor(pubkey: string): PeerPolicy {
    return policyOf(this.policyRecord(pubkey));
  }

  // NIP-86 shape: {result} or {error}. Every answer states what is now in
  // force for the peer it touched.
  manage(method: unknown, params: unknown[]): ManageResult {
    const creds = this.credentials();
    if (creds === null) return { error: "no share is held here yet" };
    switch (method) {
      case "supportedmethods":
        return { result: [...MANAGEMENT_METHODS] };
      case "listpeerpolicies": {
        const rows = this.sql.exec<{ pubkey: string }>("SELECT pubkey FROM peer_policies ORDER BY pubkey").toArray();
        return { result: rows.map((r) => this.policyRecord(r.pubkey)).filter((r) => r !== null) };
      }
      case "setpeerpolicy": {
        const record = sanitizePolicyRecord(params[0]);
        if (record === "malformed") {
          return { error: "expected {pubkey, allowSend?, allowReceive?, label?, note?} with a 64-char hex pubkey and booleans" };
        }
        const pubkey = record?.pubkey ?? sanitizePubkey((params[0] as { pubkey?: unknown }).pubkey);
        if (pubkey === null) return { error: "expected a 64-char hex pubkey" };
        if (memberByPubkey(creds.group, pubkey) === null) return { error: "that pubkey is not a member of this group" };
        if (pubkeysMatch(pubkey, getPubkey(creds.share.seckey, "bip340"))) return { error: "that is this signer's own share" };
        if (record === null) {
          // All defaults: igloo-server persists nothing, so this is a removal.
          this.sql.exec("DELETE FROM peer_policies WHERE pubkey = ?", pubkey);
          return { result: { pubkey, ...DEFAULT_POLICY } };
        }
        this.sql.exec(
          "INSERT INTO peer_policies (pubkey, allow_send, allow_receive, label, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pubkey) DO UPDATE SET allow_send = excluded.allow_send, allow_receive = excluded.allow_receive, label = excluded.label, note = excluded.note",
          pubkey,
          record.allowSend === false ? 0 : 1,
          record.allowReceive === false ? 0 : 1,
          record.label ?? null,
          record.note ?? null,
        );
        return {
          result: {
            pubkey,
            ...policyOf(record),
            ...(record.label ? { label: record.label } : {}),
            ...(record.note ? { note: record.note } : {}),
          },
        };
      }
      case "removepeerpolicy": {
        const pubkey = sanitizePubkey(params[0]);
        if (pubkey === null) return { error: "expected a 64-char hex pubkey" };
        this.sql.exec("DELETE FROM peer_policies WHERE pubkey = ?", pubkey);
        return { result: { pubkey, ...DEFAULT_POLICY } };
      }
      default:
        return { error: `unknown method; supportedmethods lists ${MANAGEMENT_METHODS.join(", ")}` };
    }
  }

  // --- The relay: connections ------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // acceptWebSocket (not server.accept()) is what makes this connection
    // hibernatable. accept() would pin the object in memory and bill its
    // duration for the connection's entire lifetime.
    this.ctx.acceptWebSocket(server);
    setState(server, { ip: request.headers.get("CF-Connecting-IP") ?? "unknown", subs: {} });
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    // Size before parse: a frame is refused before it costs a JSON.parse.
    if (message.length > MAX_FRAME_BYTES) {
      send(ws, ["NOTICE", `error: frame larger than ${MAX_FRAME_BYTES} bytes`]);
      return;
    }
    if (this.limited(this.ipWindows, getState(ws).ip, IP_RATE_LIMIT_WINDOW_MS, IP_RATE_LIMIT_MAX_MESSAGES)) {
      this.refuseRateLimited(ws, message);
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      send(ws, ["NOTICE", "error: could not parse message"]);
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      send(ws, ["NOTICE", "error: malformed message"]);
      return;
    }
    switch (frame[0]) {
      case "EVENT":
        this.handleEvent(ws, frame[1]);
        return;
      case "REQ":
        this.handleReq(ws, frame);
        return;
      case "CLOSE":
        this.handleClose(ws, frame[1]);
        return;
      default:
        send(ws, ["NOTICE", `error: unknown message type ${frame[0]}`]);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(RESERVED_CLOSE_CODES.has(code) ? NORMAL_CLOSURE : code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close();
  }

  private limited(windows: Map<string, Window>, key: string, windowMs: number, max: number): boolean {
    const now = Date.now();
    const entry = windows.get(key);
    if (!entry || now - entry.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > max;
  }

  // A throttled EVENT still gets a per-event verdict, so a client waiting
  // on OK is not left waiting forever (bothy's lesson).
  private refuseRateLimited(ws: WebSocket, message: string): void {
    let frame: unknown = null;
    try {
      frame = JSON.parse(message);
    } catch {
      // fall through to the NOTICE
    }
    if (Array.isArray(frame) && frame[0] === "EVENT") {
      const event = parseEventShape(frame[1]);
      if (event) {
        ok(ws, event.id, false, "rate-limited: slow down");
        return;
      }
    }
    send(ws, ["NOTICE", "rate-limited: slow down"]);
  }

  // --- REQ / CLOSE ------------------------------------------------------------

  // Nothing is stored, so every REQ is answered with EOSE at once and kept
  // open for what this signer produces from now on. A filter that could
  // never match that is closed with the reason, so a client asking this
  // relay for history learns what it is instead.
  private handleReq(ws: WebSocket, frame: unknown[]): void {
    const subId = frame[1];
    if (typeof subId !== "string") {
      send(ws, ["NOTICE", "error: malformed REQ"]);
      return;
    }
    const state = getState(ws);
    if (!(subId in state.subs) && Object.keys(state.subs).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      send(ws, ["CLOSED", subId, `rate-limited: at most ${MAX_SUBSCRIPTIONS_PER_CONNECTION} open subscriptions per connection`]);
      return;
    }
    const filters: Filter[] = [];
    for (const raw of frame.slice(2)) {
      const filter = parseFilter(raw);
      if (filter === null) {
        send(ws, ["CLOSED", subId, "invalid: malformed filter"]);
        return;
      }
      filters.push(filter);
    }
    if (filters.length === 0) {
      send(ws, ["CLOSED", subId, "invalid: a REQ needs at least one filter"]);
      return;
    }
    const creds = this.credentials();
    const sharePub = creds === null ? null : getPubkey(creds.share.seckey, "bip340");
    const servable = filters.some((f) => {
      if (f.kinds && !f.kinds.includes(RPC_KIND)) return false;
      if (sharePub !== null && f.authors && !f.authors.includes(sharePub)) return false;
      if (f.ids) return false;
      return true;
    });
    if (!servable) {
      send(ws, ["CLOSED", subId, `${ONLY_OWN_TRAFFIC}; nothing is stored, so there is no history to serve`]);
      return;
    }
    const next: ConnState = { ...state, subs: { ...state.subs, [subId]: filters } };
    if (!stateFits(next)) {
      send(ws, ["CLOSED", subId, "invalid: this connection's subscriptions would exceed what the relay keeps per connection"]);
      return;
    }
    setState(ws, next);
    send(ws, ["EOSE", subId]);
  }

  private handleClose(ws: WebSocket, subId: unknown): void {
    if (typeof subId !== "string") return;
    const state = getState(ws);
    delete state.subs[subId];
    setState(ws, state);
  }

  // --- EVENT --------------------------------------------------------------------

  // Cheapest refusals first, every one of them before the signature is
  // checked and long before anything is decrypted (docs/budget.md "What a
  // WebSocket message costs").
  private handleEvent(ws: WebSocket, raw: unknown): void {
    const event = parseEventShape(raw);
    if (!event) {
      send(ws, ["NOTICE", "error: malformed event"]);
      return;
    }
    if (event.kind !== RPC_KIND) {
      ok(ws, event.id, false, ONLY_OWN_TRAFFIC);
      return;
    }
    const creds = this.credentials();
    if (creds === null) {
      ok(ws, event.id, false, "restricted: no share is held here yet");
      return;
    }
    const sharePub = getPubkey(creds.share.seckey, "bip340");
    if (!pTagValues(event.tags).includes(sharePub)) {
      ok(ws, event.id, false, ONLY_OWN_TRAFFIC);
      return;
    }
    const member = memberByPubkey(creds.group, event.pubkey);
    if (member === null) {
      ok(ws, event.id, false, "restricted: only members of this group may speak to this share");
      return;
    }
    if (this.limited(this.peerWindows, event.pubkey, PEER_RATE_LIMIT_WINDOW_MS, PEER_RATE_LIMIT_MAX_REQUESTS)) {
      ok(ws, event.id, false, "rate-limited: slow down");
      return;
    }
    if (!this.policyFor(event.pubkey).allowReceive) {
      ok(ws, event.id, false, "blocked: this share does not take requests from that peer");
      return;
    }
    // Before any arithmetic: is there anywhere for the answer to go? A
    // reply is an event from this share, p-tagged to the requester, and
    // it is delivered only to open subscriptions that match it.
    const reply: NostrEvent = {
      id: "",
      pubkey: sharePub,
      created_at: nowSeconds(),
      kind: RPC_KIND,
      tags: [["p", event.pubkey]],
      content: "",
      sig: "",
    };
    if (this.subscribersFor(reply).length === 0) {
      ok(ws, event.id, false, "restricted: open a subscription that includes this share's events first, so the answer has somewhere to go");
      return;
    }
    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }
    const unwrapped = unwrapRpc(creds.share.seckey, event);
    if (!unwrapped.ok) {
      ok(ws, event.id, false, `invalid: ${unwrapped.reason}`);
      return;
    }
    const message = unwrapped.message;
    if (message.type !== "request") {
      // An accept or reject addressed to this share: nothing asked for it
      // in this release. Taken, so the sender's client sees no error.
      ok(ws, event.id, true, "");
      return;
    }
    const outcome = this.dispatch(creds, member.idx, event.pubkey, message);
    if (outcome !== null && "refuse" in outcome) {
      ok(ws, event.id, false, outcome.refuse);
      return;
    }
    ok(ws, event.id, true, "");
    this.touchPeer(member.idx);
    if (outcome === null) return;
    const response: RpcMessage = "accept" in outcome ? acceptMessage(message, outcome.accept) : rejectMessage(message, outcome.reject);
    this.deliver(wrapRpc(creds.share.seckey, response, event.pubkey));
  }

  // Every open subscription on every connection whose filters match.
  private subscribersFor(event: NostrEvent): Array<{ ws: WebSocket; subId: string }> {
    const out: Array<{ ws: WebSocket; subId: string }> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const state = getState(ws);
      for (const [subId, filters] of Object.entries(state.subs)) {
        if (filters.some((f) => matchesFilter(event, f))) out.push({ ws, subId });
      }
    }
    return out;
  }

  private deliver(event: NostrEvent): void {
    for (const { ws, subId } of this.subscribersFor(event)) send(ws, ["EVENT", subId, event]);
  }

  private touchPeer(idx: number): void {
    const now = nowSeconds();
    const row = this.sql.exec<{ last_seen: number }>("SELECT last_seen FROM peers WHERE idx = ?", idx).toArray()[0];
    if (!row) {
      this.sql.exec("INSERT INTO peers (idx, last_seen) VALUES (?, ?)", idx, now);
    } else if (now - Number(row.last_seen) >= PEER_SEEN_INTERVAL_SECONDS) {
      this.sql.exec("UPDATE peers SET last_seen = ? WHERE idx = ?", now, idx);
    }
  }

  private recordSign(requesterIdx: number | null, okay: boolean, reason: string | null): void {
    this.sql.exec(
      "UPDATE last_sign SET at = ?, requester_idx = ?, ok = ?, reason = ? WHERE id = 1",
      nowSeconds(),
      requesterIdx,
      okay ? 1 : 0,
      reason,
    );
  }

  // --- Handlers (bifrost src/api/*.ts, signer side) ----------------------------

  private dispatch(creds: Credentials, peerIdx: number, peerPubkey: string, request: RequestMessage): HandlerOutcome {
    switch (request.method) {
      case "ping":
        return this.onPing(creds, peerIdx, peerPubkey, request);
      case "sign":
        return this.onSign(creds, peerIdx, request);
      case "ecdh":
        return this.onEcdh(creds, request);
      case "echo":
        return { accept: request.params[0] ?? "" };
      case "onboard":
        return this.onOnboard(creds, request);
      default:
        // bifrost ignores a method it does not know; so does this. The
        // event itself was fine, so the OK is not the place to say so.
        return null;
    }
  }

  // api/ping.ts ping_handler_api: store what they sent, answer with the
  // policy that applies to them and a fresh package if their pool of this
  // signer's nonces is low.
  private onPing(creds: Credentials, peerIdx: number, peerPubkey: string, request: RequestMessage): HandlerOutcome {
    const ping = parsePingRequest(request.params[0]);
    if (ping === null) return { refuse: "invalid: ping payload failed validation" };
    const now = nowSeconds();
    const cap = maxNonceRowsPerDay(this.env);
    if (ping.nonces && ping.nonces.length > 0) storeIncoming(this.sql, peerIdx, ping.nonces, now, cap);
    const policy = this.policyFor(peerPubkey);
    const response: Record<string, unknown> = {
      policy: { send: policy.allowSend, recv: policy.allowReceive },
      pool_status: poolStatus(this.sql, creds.group, creds.share.idx),
    };
    if (shouldReplenish(this.sql, peerIdx)) {
      const nonces = generateForPeer(this.sql, creds.share.seckey, peerIdx, NONCE_REPLENISH_COUNT, now, cap);
      if (nonces.length > 0) response.nonces = nonces;
    }
    return { accept: response };
  }

  // api/sign.ts sign_handler_api. Every check bifrost's PROTOCOL.md lists
  // under "Sign Request Validation", then the nonce is spent, then the
  // partial signature is made. A refusal travels in the OK (never
  // silently) and never as an RPC reject, which bifrost does not send for
  // sign.
  private onSign(creds: Credentials, peerIdx: number, request: RequestMessage): HandlerOutcome {
    const session = parseSignSession(request.params[0]);
    if (session === null) return this.refuseSign(peerIdx, "invalid: sign session failed validation");
    const { group, share } = creds;
    if (!verifySessionPkg(group, session)) {
      return this.refuseSign(peerIdx, "invalid: session id or group id does not match this group");
    }
    if (!session.members.includes(share.idx)) return this.refuseSign(peerIdx, "invalid: this share is not among the session's members");
    if (!session.members.includes(peerIdx)) return this.refuseSign(peerIdx, "invalid: the requester is not among the session's members");
    if (new Set(session.members).size !== session.members.length) return this.refuseSign(peerIdx, "invalid: duplicate member index");
    if (session.members.length < group.threshold) {
      return this.refuseSign(peerIdx, `invalid: ${session.members.length} members is under the threshold of ${group.threshold}`);
    }
    for (const idx of session.members) {
      if (memberByIdx(group, idx) === null) return this.refuseSign(peerIdx, `invalid: member ${idx} is not in this group`);
      if (!session.nonces?.some((n) => n.idx === idx)) return this.refuseSign(peerIdx, `invalid: no nonce for member ${idx}`);
    }
    const ours = session.nonces?.find((n) => n.idx === share.idx);
    if (!ours) return this.refuseSign(peerIdx, "invalid: no nonce for this share");
    const now = nowSeconds();
    const secret = takeOutgoing(this.sql, share.seckey, peerIdx, ours, now);
    if (secret === null) {
      return this.refuseSign(peerIdx, "invalid: that nonce was not issued to you by this share, or was already spent");
    }
    let pkg;
    try {
      pkg = createPsigPkg(getSessionCtx(group, session), share, secret);
    } catch (err) {
      return this.refuseSign(peerIdx, `invalid: ${err instanceof Error ? err.message : "could not sign"}`);
    }
    if (shouldReplenish(this.sql, peerIdx)) {
      const nonces = generateForPeer(this.sql, share.seckey, peerIdx, NONCE_REPLENISH_COUNT, now, maxNonceRowsPerDay(this.env));
      if (nonces.length > 0) pkg.replenish = nonces;
    }
    this.recordSign(peerIdx, true, null);
    return { accept: pkg };
  }

  private refuseSign(peerIdx: number, reason: string): HandlerOutcome {
    this.recordSign(peerIdx, false, reason);
    return { refuse: reason };
  }

  // api/ecdh.ts ecdh_handler_api.
  private onEcdh(creds: Credentials, request: RequestMessage): HandlerOutcome {
    const req = parseEcdhRequest(request.params[0]);
    if (req === null) return { refuse: "invalid: ecdh payload failed validation" };
    const { group, share } = creds;
    if (!req.members.includes(share.idx)) return { refuse: "invalid: this share is not among the members" };
    if (req.members.length < group.threshold) {
      return { refuse: `invalid: ${req.members.length} members is under the threshold of ${group.threshold}` };
    }
    if (req.members.some((idx) => memberByIdx(group, idx) === null)) return { refuse: "invalid: a member index is not in this group" };
    try {
      return { accept: createEcdhPkg(req.members, req.ecdhPks, share) };
    } catch {
      return { refuse: "invalid: a target public key is not a point on the curve" };
    }
  }

  // api/onboard.ts onboard_handler_api: the requester must be the member
  // it says it is; it gets the group and a full pool. This is the one
  // handler bifrost answers with an RPC reject, so it is answered that way
  // here.
  private onOnboard(creds: Credentials, request: RequestMessage): HandlerOutcome {
    const req = parseOnboardRequest(request.params[0]);
    if (req === null) return { reject: "invalid onboard request format" };
    const member = memberByIdx(creds.group, req.idx);
    if (member === null || !pubkeysMatch(member.pubkey, req.sharePk)) return { reject: "requester not a valid group member" };
    const nonces = generateForPeer(this.sql, creds.share.seckey, req.idx, NONCE_POOL_SIZE, nowSeconds(), maxNonceRowsPerDay(this.env));
    return { accept: { group: creds.group, nonces } };
  }
}
