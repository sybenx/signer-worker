// workerd refuses to start a Worker whose entry module carries a named
// export that is not a handler or a Durable Object class ("Incorrect type
// for map entry ..."). The vitest harness does not enforce that, and a
// constant exported from src/index.ts once took `wrangler dev` down while
// every test passed. This pins the export surface.
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";

describe("entry module", () => {
  it("exports the handler and the Durable Object class, and nothing else", () => {
    expect(Object.keys(entry).sort()).toEqual(["Signer", "default"]);
    expect(typeof entry.default.fetch).toBe("function");
    expect(typeof entry.Signer).toBe("function");
  });
});
