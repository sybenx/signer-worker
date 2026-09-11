import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

// Storage isolation in this vitest plugin is per test FILE, not per test
// (developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
// The claim is permanent by design, so every test that claims needs a
// fresh object: call once per test file that writes.
export function isolateStorage(): void {
  afterEach(async () => {
    await reset();
  });
}
