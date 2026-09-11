// The generated Env types SIGNER as an untyped namespace; this is the one
// place the cast to the class happens, so RPC calls typecheck everywhere
// else. Same shape as bothy's src/relay-stub.ts.
import type { Signer } from "./signer.ts";

export function signerStub(env: Env): DurableObjectStub<Signer> {
  return env.SIGNER.get(env.SIGNER.idFromName("signer")) as DurableObjectStub<Signer>;
}
