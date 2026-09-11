// The Worker: routes, the per-IP rate limit, one NIP-98 verification, and
// nothing that costs CPU beyond that. Every path that reaches the Durable
// Object is rate limited before the Worker's own code runs; static assets
// are not (they are free). Adapted from bothy's src/index.ts
// (github.com/sybenx/bothy, MIT).
import pkg from "../package.json";
import { normalizeIp } from "./ip.ts";
import { HTTP_RATE_LIMIT_PERIOD_SECONDS } from "./limits.ts";
import { MANAGEMENT_CONTENT_TYPE, groupSignerReason, verifyNip98 } from "./nip98.ts";
import { ownerCredsConfigured } from "./owner-creds.ts";
import { PAIRING_RELAYS } from "./qrst.ts";
import { signerStub } from "./signer-stub.ts";

// The entry module exports the handler and the Durable Object class and
// NOTHING ELSE: workerd refuses to start a Worker whose entry module has
// a named export that is not a handler ("Incorrect type for map entry").
// The vitest harness does not enforce this, so test/exports.test.ts does.
export { Signer } from "./signer.ts";

function json(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
}

// Returns a 429 to send back, or null to continue. An absent binding
// means "allowed", not "denied" (src/env.d.ts).
async function rateLimited(limiter: RateLimit | undefined, request: Request): Promise<Response | null> {
  if (limiter === undefined) return null;
  const key = normalizeIp(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return new Response(JSON.stringify({ error: "rate limited", retryAfterSeconds: HTTP_RATE_LIMIT_PERIOD_SECONDS }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(HTTP_RATE_LIMIT_PERIOD_SECONDS) },
  });
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;
  const status = await signerStub(env).getStatus();
  const url = new URL(request.url);
  const body: Record<string, unknown> = { version: pkg.version, ...status };
  if (!status.claimed) {
    // What the pairing page needs to show a QR; `null` tells it not to
    // offer pairing, because OWNER_CREDS closed the claim endpoint.
    body.pairing = ownerCredsConfigured(env)
      ? null
      : { bounceHost: env.BOUNCE_HOST ?? url.host, relays: PAIRING_RELAYS, origin: url.origin };
  }
  return json(body);
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;
  if (ownerCredsConfigured(env)) return new Response("not found", { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "malformed request body" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.group !== "string" || typeof b.share !== "string") return json({ error: "expected group and share" }, 400);
  const result = await signerStub(env).claim(b.group, b.share, b.profile, new URL(request.url).host);
  switch (result.status) {
    case "disabled":
      return new Response("not found", { status: 404 });
    case "invalid":
      return json({ error: result.reason }, 400);
    case "conflict":
      return json({ error: "a share is already held here" }, 409);
    case "claimed":
      return json({ sharePubkey: result.sharePubkey, echo: result.echo });
  }
}

// The management call: NIP-86's shape, authenticated by a NIP-98 event
// signed by the GROUP key -- which means the group's devices produced a
// threshold signature to make it. Verified here, in the Worker, before
// the object is woken: a forged call costs one schnorr verify and no
// Durable Object request.
async function handleManagement(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;
  // Bytes as sent: the payload tag binds exactly these.
  const body = new Uint8Array(await request.arrayBuffer());
  const auth = verifyNip98(request, body, Math.floor(Date.now() / 1000));
  if (!auth.ok) return json({ error: auth.reason }, 401, MANAGEMENT_CONTENT_TYPE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "request body is not valid JSON" }, 200, MANAGEMENT_CONTENT_TYPE);
  }
  const call = parsed as { method?: unknown; params?: unknown } | null;
  const params = Array.isArray(call?.params) ? (call.params as unknown[]) : [];
  const stub = signerStub(env);
  const status = await stub.getStatus();
  const denial = groupSignerReason(auth.pubkey, status.group?.pubkey ?? null);
  if (denial !== null) return json({ error: denial }, 401, MANAGEMENT_CONTENT_TYPE);
  return json(await stub.manage(call?.method, params), 200, MANAGEMENT_CONTENT_TYPE);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && (request.headers.get("Content-Type") ?? "").includes(MANAGEMENT_CONTENT_TYPE)) {
      return handleManagement(request, env);
    }
    if (url.pathname === "/api/status") return handleStatus(request, env);
    if (url.pathname === "/api/claim") return handleClaim(request, env);
    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const limited = await rateLimited(env.RATE_LIMIT_API, request);
      if (limited !== null) return limited;
      return signerStub(env).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
