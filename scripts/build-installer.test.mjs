import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./build-installer.mjs", import.meta.url), "utf8");
// Strip comment lines so historical notes about the removed mechanism don't
// trip the assertions — only live code is checked.
const code = source
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

// Regression guard for the v0.3.4 release failure (run 39223578350).
//
// The pipeline used to serve a patched winCodeSign archive through a
// 127.0.0.1 HTTP server and point electron-builder at it via
// ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL. app-builder-lib
// 26.17.0 derives the toolset cache directory from that URL's
// basename, so "http://127.0.0.1:<port>" becomes a directory name
// containing a colon — invalid on Windows — and every toolset
// download (nsis, rcedit, …) fails with ENOENT during mkdir. Upstream
// has refactored this in master but not shipped a stable fix, so the
// guard stays until the cache path is provably host-agnostic.
test("build pipeline must not override electron-builder binary downloads", () => {
  assert.ok(
    !code.includes("ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL"),
    "build-installer.mjs must not set ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL (app-builder-lib 26.17.0 turns a host:port URL into an invalid Windows cache directory name)"
  );
  assert.ok(
    !code.includes("createServer"),
    "build-installer.mjs must not start a local override HTTP server"
  );
});

test("build pipeline no longer carries the winCodeSign override server machinery", () => {
  for (const symbol of [
    "ensurePatchedWinCodeSign",
    "startLocalOverrideServer",
    "cleanupWinCodeSignStubs"
  ]) {
    assert.ok(
      !code.includes(symbol),
      `build-installer.mjs still references removed override-server function ${symbol}`
    );
  }
});
