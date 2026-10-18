import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("renderer reads via the existing preload bridge", async () => {
  const calls = [];
  globalThis.window = { contentFerry: { readArticle: async (id) => { calls.push(id); return "fixture article"; } } };
  try {
    const { readArticle } = await import("./article-reader.mjs");
    assert.equal(await readArticle("article-001"), "fixture article");
    assert.deepEqual(calls, ["article-001"]);
  } finally {
    delete globalThis.window;
  }
});

test("renderer contains no direct Node file access", () => {
  const source = readFileSync(new URL("./article-reader.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:node:|["'](?:fs|path|child_process)(?:\/|["']))/);
});
