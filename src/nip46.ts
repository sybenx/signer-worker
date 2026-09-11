// NIP-46 (nips/46.md), the remote-signer protocol, in the parts a bunker
// needs and nothing else: parse a request, shape a response, encrypt the
// transport in whichever of NIP-44 or NIP-04 the client used, and decide
// what a policy allows. Policy is igloo-server's shape (src/db/nip46.ts
// Nip46Policy: `methods` and `kinds` as boolean maps, `kinds["*"]` for any
// kind) and its rule (src/nip46/service.ts shouldAutoApprove): a method is
// allowed when `methods[method]` is true, and `sign_event` additionally
// needs `kinds[kind]` or `kinds["*"]`. No approval queue exists here --
// there is no operator at a keyboard -- so what the policy does not allow
// is refused with a reason, and the policy is the whole of the decision.
import { isNip04Payload, nip04Decrypt, nip04Encrypt } from "./nip04.ts";
import { nip44Decrypt, nip44Encrypt, sharedSecret } from "./wire.ts";

// nips/46.md: "kind 24133".
export const NIP46_KIND = 24133;

export interface Nip46Request {
  id: string;
  method: string;
  params: string[];
}

export interface Nip46Policy {
  methods?: Record<string, boolean>;
  kinds?: Record<string, boolean>;
}

// The methods this bunker implements. `connect` and `ping` are not
// policy-gated: connect is how a session is made, and ping proves the
// relay is reachable.
export const NIP46_METHODS = [
  "connect",
  "ping",
  "get_public_key",
  "sign_event",
  "nip44_encrypt",
  "nip44_decrypt",
  "nip04_encrypt",
  "nip04_decrypt",
] as const;

// igloo-server's default (src/nip46/service.ts startInternal), with every
// kind allowed rather than none: igloo-server queues an unlisted kind for
// a person to approve, and there is nobody here to ask, so the default is
// "an app that holds the bunker secret may sign", which is what the
// secret means in NIP-46. Tighten it with setbunkerpolicy.
export const DEFAULT_BUNKER_POLICY: Nip46Policy = {
  methods: {
    get_public_key: true,
    sign_event: true,
    nip44_encrypt: true,
    nip44_decrypt: true,
    nip04_encrypt: false,
    nip04_decrypt: false,
  },
  kinds: { "*": true },
};

export type Scheme = "nip44" | "nip04";

// --- Requests and responses -------------------------------------------------

export function parseNip46Request(raw: unknown): Nip46Request | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.method !== "string") return null;
  if (r.params !== undefined && (!Array.isArray(r.params) || !r.params.every((p) => typeof p === "string"))) return null;
  return { id: r.id, method: r.method, params: (r.params as string[] | undefined) ?? [] };
}

export function responseJson(id: string, outcome: { result: string } | { error: string }): string {
  return JSON.stringify("result" in outcome ? { id, result: outcome.result } : { id, error: outcome.error });
}

// --- Transport ----------------------------------------------------------------

export function schemeOf(content: string): Scheme {
  return isNip04Payload(content) ? "nip04" : "nip44";
}

export function decryptTransport(secretKey: string, peerPubkey: string, content: string): { scheme: Scheme; plaintext: string } {
  const secret = sharedSecret(secretKey, peerPubkey);
  const scheme = schemeOf(content);
  return { scheme, plaintext: scheme === "nip04" ? nip04Decrypt(secret, content) : nip44Decrypt(secret, content) };
}

export function encryptTransport(secretKey: string, peerPubkey: string, plaintext: string, scheme: Scheme): string {
  const secret = sharedSecret(secretKey, peerPubkey);
  return scheme === "nip04" ? nip04Encrypt(secret, plaintext) : nip44Encrypt(secret, plaintext, "base64");
}

// --- Policy -------------------------------------------------------------------

function booleanMap(raw: unknown, keyOk: (k: string) => boolean): Record<string, boolean> | null | "malformed" {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "malformed";
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim();
    if (typeof v !== "boolean" || !key || !keyOk(key)) return "malformed";
    out[key] = v;
  }
  return out;
}

// igloo-server routes/nip46.ts parsePolicyPatch: methods are names, kinds
// are integers or "*".
export function parsePolicy(raw: unknown): Nip46Policy | "malformed" {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "malformed";
  const r = raw as Record<string, unknown>;
  const methods = booleanMap(r.methods, () => true);
  const kinds = booleanMap(r.kinds, (k) => k === "*" || /^\d+$/.test(k));
  if (methods === "malformed" || kinds === "malformed") return "malformed";
  const out: Nip46Policy = {};
  if (methods !== null) out.methods = methods;
  if (kinds !== null) out.kinds = kinds;
  return out;
}

// igloo-server normalizeRequestedPolicy on the `perms` string of a connect:
// "sign_event:1,sign_event:7,nip44_encrypt". Anything unparseable is
// ignored rather than refused; perms are the client's request, not the
// bunker's decision.
export function policyFromPerms(perms: string | undefined): Nip46Policy | null {
  if (!perms) return null;
  const methods: Record<string, boolean> = {};
  const kinds: Record<string, boolean> = {};
  for (const token of perms.split(",").map((t) => t.trim()).filter(Boolean)) {
    const [name, arg] = token.split(":");
    if (!name) continue;
    methods[name] = true;
    if (name === "sign_event" && arg && /^\d+$/.test(arg)) kinds[arg] = true;
  }
  const out: Nip46Policy = {};
  if (Object.keys(methods).length) out.methods = methods;
  if (Object.keys(kinds).length) out.kinds = kinds;
  return Object.keys(out).length ? out : null;
}

// One policy's verdict. `kind` matters only for sign_event.
export function policyAllows(policy: Nip46Policy, method: string, kind: number | null): boolean {
  if (!policy.methods?.[method]) return false;
  if (method !== "sign_event") return true;
  if (kind === null) return false;
  const kinds = policy.kinds ?? {};
  return kinds["*"] === true || kinds[String(kind)] === true;
}

// The bunker's policy always applies; a session's own policy, when the
// app asked for one at connect (perms) or the group set one, narrows it
// further -- for signing and encryption. Reading the key's public half is
// not a permission an app asks for, and every app does it right after
// connecting, so only the bunker's policy gates it.
export function allowed(bunker: Nip46Policy, session: Nip46Policy | null, method: string, kind: number | null): boolean {
  if (!policyAllows(bunker, method, kind)) return false;
  if (method === "get_public_key") return true;
  return session === null || policyAllows(session, method, kind);
}

// bunker://<bunker pubkey>?relay=<wss url>&secret=<hex>
export function bunkerUrl(bunkerPubkey: string, relayUrl: string, secret: string): string {
  const params = new URLSearchParams();
  params.set("relay", relayUrl);
  params.set("secret", secret);
  return `bunker://${bunkerPubkey}?${params.toString()}`;
}
