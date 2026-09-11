import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // No OWNER_CREDS here: the suite exercises the claim path over the
      // wire, and a real deploy stays unclaimed by default. The one file
      // about OWNER_CREDS passes its own env to the functions that read it.
      miniflare: { bindings: {} },
    }),
  ],
  test: {
    // Only this repo's own suite. .ref/ holds six cloned reference repos,
    // each carrying its own test/ directory, and an unqualified glob would
    // run every one of them against this tree's wrangler config.
    include: ["test/**/*.test.ts"],
  },
});
