// OWNER_CREDS, read defensively (src/env.d.ts). Separate from
// credentials.ts because that file is also bundled into the page
// (src/page/pair.ts), which has no Env.
import { parseCredentialPair, type Credentials } from "./credentials.ts";

// A value that does not parse is logged once per isolate and read as
// unset -- the same state as no variable at all, which is the supported
// one. index.ts gates the claim endpoint on the variable being SET, not
// on it parsing, so a mistyped credential closes the claim door rather
// than opening it.
let warned = false;
export function resolveOwnerCreds(env: Env): Credentials | null {
  const raw = env.OWNER_CREDS;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = parseCredentialPair(raw);
  if (parsed.ok) return parsed.creds;
  if (!warned) {
    warned = true;
    console.error(`OWNER_CREDS is set but unusable (${parsed.reason}); treating it as unset`);
  }
  return null;
}

export function ownerCredsConfigured(env: Env): boolean {
  return env.OWNER_CREDS !== undefined && env.OWNER_CREDS.trim() !== "";
}
