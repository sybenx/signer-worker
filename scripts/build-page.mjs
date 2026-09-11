#!/usr/bin/env node
// Bundles the page script (src/page/pair.ts) into public/pair.js.
//
// The bundle is COMMITTED. Workers static assets are served as files and
// the "Deploy to Cloudflare" button runs `wrangler deploy` and nothing
// else, so a build step that only exists on a developer's machine would
// leave every downstream copy without a page. Two copies of anything
// drift, so, like scripts/sync-badge.mjs, this script has a --check mode
// that fails when the committed bundle does not match the source.
//
//   node scripts/build-page.mjs           # write public/pair.js
//   node scripts/build-page.mjs --check   # exit 1 if it is stale
//
// esbuild is here already as wrangler's own bundler; no new dependency.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const OUT = "public/pair.js";

const result = await build({
  entryPoints: ["src/page/pair.ts"],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  minify: false,
  write: !process.argv.includes("--check"),
  outfile: OUT,
  legalComments: "inline",
  banner: { js: "// Built from src/page/pair.ts by scripts/build-page.mjs. Do not edit; run `npm run build-page`." },
});

if (process.argv.includes("--check")) {
  const fresh = result.outputFiles?.[0]?.text ?? "";
  let committed = "";
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    // missing counts as stale
  }
  if (fresh === committed) {
    console.log(`${OUT} is in sync with src/page/pair.ts.`);
    process.exit(0);
  }
  console.error(`${OUT} is stale: it does not match src/page/pair.ts. Run \`npm run build-page\`.`);
  process.exit(1);
}
console.log(`${OUT} written.`);
