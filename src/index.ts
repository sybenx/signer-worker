// The Worker: routes, the per-IP rate limit, and nothing that costs CPU.
// Every path that reaches the Durable Object is rate limited before the
// Worker's own code runs; static assets are not (they are free).
// Adapted from bothy's src/index.ts (github.com/sybenx/bothy, MIT).
import pkg from "../package.json";
import { ownerCredsConfigured } from "./owner-creds.ts";
import { normalizeIp } from "./ip.ts";
import { HTTP_RATE_LIMIT_PERIOD_SECONDS } from "./limits.ts";
import { signerStub } from "./signer-stub.ts";

export { Signer } from "./signer.ts";

// Relays the pairing page uses to reach the phone during a transfer.
// The browser holds these connections, never the Worker. Three, so a
// single relay's outage or `auth-required` does not end a session
// (QR_SECRET_TRANSFER.md 11.5), and well-known ones, so a phone's own
// client is likely already connected to at least one.
export const PAIRING_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Returns a 429 to send back, or null to continue. An absent binding
// means "allowed", not "denied" (src/env.d.ts).
async function rateLimited(limiter: RateLimit | undefined, request: Request): Promise<Response | null> {
  if (limiter === undefined) return null;
  const key = normalizeIp(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return json(
    { error: "rate limited", retryAfterSeconds: HTTP_RATE_LIMIT_PERIOD_SECONDS },
    429,
  );
}

async function handleStatus(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;
  const status = await signerStub(env).getStatus();
  const url = new URL(request.url);
  const body: Record<string, unknown> = { version: pkg.version, ...status };
  if (!status.claimed) {
    // Everything the pairing page needs to show a QR. The claim endpoint
    // is closed when OWNER_CREDS is set, so the page must not offer to
    // pair; `pairing: null` is how it learns that.
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
  // Mirrors claim()'s own first check so a configured deployment refuses
  // without waking the object.
  if (ownerCredsConfigured(env)) return new Response("not found", { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "malformed request body" }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.group !== "string" || typeof b.share !== "string") {
    return json({ error: "expected group and share" }, 400);
  }
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") return handleStatus(request, env);
    if (url.pathname === "/api/claim") return handleClaim(request, env);
    if (url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    // Signing traffic (the WebSocket) arrives in the next release; until
    // then an upgrade is refused rather than half-answered.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return new Response("not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
