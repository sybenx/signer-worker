// The one Durable Object: holds the share, and is the relay for the
// group's traffic to it. Phase 1: hold. Phase 2 adds the inbound NIP-01
// subset and the handlers.
//
// Hibernation rules (CLAUDE.md "What it is"): acceptWebSocket, never
// server.accept(); no outbound connection from inside this class, ever;
// nothing kept only in instance memory that has to survive a wake.
import { DurableObject } from "cloudflare:workers";
import { credentialsFromParts, type Credentials } from "./credentials.ts";
import { ownerCredsConfigured, resolveOwnerCreds } from "./owner-creds.ts";
import { buildEchoEvent } from "./echo.ts";
import { getGroupId, getPubkey, xOnly } from "./frost.ts";
import type { NostrEvent } from "./nostr.ts";

// The group's kind-0, as the pairing page saw it when the claim was
// made. Rendered on the page; never used for anything else.
export interface GroupProfile {
  name?: string;
  picture?: string;
}

export interface SignerStatus {
  claimed: boolean;
  // Where the credentials came from: the environment (OWNER_CREDS) or
  // the claim. Shown as an outcome on the page ("held since ..."), and
  // read by index.ts to decide what the claim endpoint answers.
  source?: "env" | "claim";
  group?: {
    name: string | null;
    picture: string | null;
    // x-only hex; diagnostics only on the page.
    pubkey: string;
    id: string;
    threshold: number;
    members: number;
  };
  share?: {
    index: number;
    // x-only hex; diagnostics only on the page.
    pubkey: string;
  };
  claimedAt?: number;
}

export type ClaimResult =
  | { status: "claimed"; sharePubkey: string; echo: NostrEvent }
  | { status: "conflict" }
  | { status: "disabled" }
  | { status: "invalid"; reason: string };

interface MetaRow extends Record<string, SqlStorageValue> {
  group_pkg: string | null;
  share_pkg: string | null;
  group_name: string | null;
  group_picture: string | null;
  claimed_at: number | null;
  host: string | null;
}

// One row, ever. The bech32m strings are stored as accepted -- what the
// claim verified is what is held, and re-encoding would be a second
// source of truth.
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
`;

const MAX_NAME_LENGTH = 100;
const MAX_PICTURE_LENGTH = 500;

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

export class Signer extends DurableObject<Env> {
  private readonly sql: SqlStorage = this.ctx.storage.sql;
  // Instance cache of the decoded credentials, keyed on the exact text
  // it was decoded from, so a change in the environment or a reset of
  // storage can never be answered from a stale decode. The row read that
  // recomputes the key is one indexed read; the decode it saves is a
  // point multiplication per message on the signing path.
  private cache: { key: string; creds: Credentials } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every wake from hibernation, so it must stay cheap: one
    // CREATE IF NOT EXISTS and one no-op INSERT.
    this.sql.exec(SCHEMA);
  }

  private meta(): MetaRow {
    return this.sql.exec<MetaRow>("SELECT group_pkg, share_pkg, group_name, group_picture, claimed_at, host FROM meta WHERE id = 1").one();
  }

  // Environment outranks storage, mirroring bothy's OWNER_PUBKEY: an
  // operator who set OWNER_CREDS decided at deploy time, and nothing a
  // claim did before or after changes that.
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
    // A stored pair that no longer parses would mean the decoder changed
    // under it; that is a bug to see in logs, not a silent "unclaimed".
    if (!parsed.ok) {
      console.error(`stored credentials do not parse: ${parsed.reason}`);
      return null;
    }
    this.cache = { key, creds: parsed.creds };
    return parsed.creds;
  }

  // The permanent action. First valid pair in wins; there is no second,
  // and no signature is required on the claim itself -- the P4 check
  // (share belongs to group) is what a claim has to pass, and a wrong
  // claim can sign nothing because the share signs nothing alone. The
  // Durable Object is single-threaded, so the check-then-write here is
  // what makes the claim atomic; index.ts pre-checks only to refuse
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
      Math.floor(Date.now() / 1000),
      host,
    );
    return {
      status: "claimed",
      sharePubkey: getPubkey(parsed.creds.share.seckey, "bip340"),
      // Signed here, published by the browser that ran the pairing: this
      // object never opens an outbound connection.
      echo: buildEchoEvent(parsed.creds.share.seckey),
    };
  }

  getStatus(): SignerStatus {
    const creds = this.credentials();
    if (creds === null) return { claimed: false };
    const row = this.meta();
    const fromEnv = ownerCredsConfigured(this.env);
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
    };
    if (!fromEnv && row.claimed_at !== null) status.claimedAt = row.claimed_at;
    return status;
  }
}
