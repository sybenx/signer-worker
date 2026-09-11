// The one Durable Object. Phase 0 skeleton: enough to prove the FROST
// maths loads and runs inside a Durable Object on workerd. Grows into the
// share holder and the relay in Phases 1 and 2.
import { DurableObject } from "cloudflare:workers";
import {
  createPsigPkg,
  deriveSecretNonce,
  generateNoncePairs,
  getSessionCtx,
  verifyNonceCode,
  type DerivedPublicNonce,
  type GroupPackage,
  type MemberPublicNonce,
  type PartialSigPackage,
  type SharePackage,
  type SignSessionPackage,
} from "./frost.ts";

export class Signer extends DurableObject<Env> {
  // Phase 0 spike only: the signer side of one round, `iterations` times,
  // with wall-clock as measured from inside the isolate. Removed once the
  // real handlers exist (src/signer.ts Phase 2).
  spikeSign(
    group: GroupPackage,
    share: SharePackage,
    session: SignSessionPackage,
    ourNonce: MemberPublicNonce,
    iterations: number,
  ): { pkg: PartialSigPackage; elapsedMs: number; clockAdvanced: boolean } {
    const start = Date.now();
    let pkg: PartialSigPackage | null = null;
    for (let i = 0; i < iterations; i++) {
      if (!verifyNonceCode(share.seckey, ourNonce)) throw new Error("nonce code does not verify");
      const secret = deriveSecretNonce(share.seckey, ourNonce.code);
      const ctx = getSessionCtx(group, session);
      pkg = createPsigPkg(ctx, share, secret);
    }
    const end = Date.now();
    if (pkg === null) throw new Error("no iterations");
    return { pkg, elapsedMs: end - start, clockAdvanced: end !== start };
  }

  spikeNonces(share: SharePackage, count: number): { nonces: DerivedPublicNonce[]; elapsedMs: number } {
    const start = Date.now();
    const nonces = generateNoncePairs(share.seckey, count);
    return { nonces, elapsedMs: Date.now() - start };
  }
}
