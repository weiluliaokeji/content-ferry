// E2E test for the local override server approach.
// Verifies:
//   1. ensurePatchedWinCodeSign produces a valid patched archive
//   2. startLocalOverrideServer serves the patched archive over HTTP
//   3. The patched archive actually has darwin/ stripped
//   4. Subsequent requests for non-winCodeSign files get handled
//      (we test the 404 path since we can't easily test GitHub proxying)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");

// We can't easily import the ESM build-installer.mjs, so we duplicate
// just the functions we need. Keep this in sync with the real script.
const PROJECT_ROOT = process.cwd();
const BUILD_CACHE = path.join(PROJECT_ROOT, "build", "cache");
const SEVEN_ZIP = path.join(
  PROJECT_ROOT,
  "node_modules",
  "7zip-bin",
  "win",
  "x64",
  "7za.exe"
);
const WIN_CODE_SIGN_FILE = "winCodeSign-2.6.0.7z";

function findWinCodeSignInCache() {
  const root = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "electron-builder",
    "Cache"
  );
  let best = null;
  let bestSize = 0;
  for (const r of [
    path.join(root, "winCodeSign"),
    path.join(root, `${process.env.ELECTRON_BUILDER_CACHE || ""}winCodeSign`)
  ]) {
    if (!fs.existsSync(r)) continue;
    for (const entry of fs.readdirSync(r, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".7z")) continue;
      const candidate = path.join(r, entry.name);
      const size = fs.statSync(candidate).size;
      if (size > bestSize) {
        bestSize = size;
        best = candidate;
      }
    }
  }
  return best;
}

async function ensurePatchedWinCodeSign() {
  fs.mkdirSync(BUILD_CACHE, { recursive: true });
  const patchedPath = path.join(BUILD_CACHE, "winCodeSign-2.6.0-patched.7z");
  if (fs.existsSync(patchedPath) && fs.statSync(patchedPath).size > 1024 * 1024) {
    return patchedPath;
  }
  const originalPath = path.join(BUILD_CACHE, "winCodeSign-2.6.0-original.7z");
  if (!fs.existsSync(originalPath)) {
    const fromCache = findWinCodeSignInCache();
    if (fromCache) {
      fs.copyFileSync(fromCache, originalPath);
    } else {
      throw new Error("No winCodeSign in cache and no download path in test");
    }
  }
  execFileSync(SEVEN_ZIP, ["d", originalPath, "darwin"], { stdio: "pipe" });
  fs.renameSync(originalPath, patchedPath);
  return patchedPath;
}

async function startLocalOverrideServer(patchedArchivePath) {
  let activeRequests = 0;
  const server = http.createServer((req, res) => {
    activeRequests++;
    const filename = decodeURIComponent((req.url || "/").replace(/^\/+/, ""));
    if (filename === WIN_CODE_SIGN_FILE) {
      const size = fs.statSync(patchedArchivePath).size;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": size
      });
      fs.createReadStream(patchedArchivePath).pipe(res);
      res.on("close", () => (activeRequests--));
    } else {
      // For the test, return 502 instead of proxying
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("test proxy: " + filename);
      activeRequests--;
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    stop: () =>
      new Promise((resolve) => {
        const tick = () => {
          if (activeRequests === 0) server.close(resolve);
          else setTimeout(tick, 50);
        };
        tick();
      })
  };
}

async function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers })
        );
      })
      .on("error", reject);
  });
}

async function main() {
  console.log("Step 1: ensure patched archive");
  const patched = await ensurePatchedWinCodeSign();
  const patchedSize = fs.statSync(patched).size;
  console.log("  Patched size:", (patchedSize / 1024 / 1024).toFixed(2), "MB");
  if (patchedSize < 4.0 * 1024 * 1024 || patchedSize > 4.5 * 1024 * 1024) {
    console.log("  FAIL: expected ~4.2 MB after stripping darwin/");
    process.exit(1);
  }
  console.log("  PASS: size in expected range");

  // Verify the archive actually extracts without symlink errors
  console.log("Step 2: extract patched archive");
  const extractDir = path.join(os.tmpdir(), "cf-test-extract-" + Date.now());
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    execFileSync(SEVEN_ZIP, ["x", "-snld", "-bd", "-y", `-o${extractDir}`, patched], {
      stdio: "pipe"
    });
    const signtool = path.join(extractDir, "windows-10", "x64", "signtool.exe");
    if (fs.existsSync(signtool) && fs.statSync(signtool).size > 0) {
      console.log("  PASS: signtool.exe exists with", fs.statSync(signtool).size, "bytes");
    } else {
      console.log("  FAIL: signtool.exe missing or empty");
      process.exit(1);
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch (e) {
    console.log("  FAIL: extract threw:", e.message);
    process.exit(1);
  }

  // Verify the override server works
  console.log("Step 3: start override server and fetch patched archive via HTTP");
  const server = await startLocalOverrideServer(patched);
  console.log("  Server URL:", server.url);
  try {
    const result = await fetchOnce(server.url + WIN_CODE_SIGN_FILE);
    console.log("  Status:", result.status, "Body length:", result.body.length);
    if (result.status !== 200) {
      console.log("  FAIL: expected 200");
      process.exit(1);
    }
    if (result.body.length !== patchedSize) {
      console.log("  FAIL: body length mismatch (expected", patchedSize, "got", result.body.length, ")");
      process.exit(1);
    }
    if (!result.body.equals(fs.readFileSync(patched))) {
      console.log("  FAIL: body content does not match patched file");
      process.exit(1);
    }
    console.log("  PASS: server served exact bytes of patched archive");
  } finally {
    await server.stop();
  }

  // Verify non-winCodeSign request returns 502 (proxy path)
  console.log("Step 4: non-winCodeSign request returns 502");
  const server2 = await startLocalOverrideServer(patched);
  try {
    const result = await fetchOnce(server2.url + "other-thing.7z");
    if (result.status !== 502) {
      console.log("  FAIL: expected 502, got", result.status);
      process.exit(1);
    }
    console.log("  PASS: non-winCodeSign requests handled (502 in test, real proxy in build)");
  } finally {
    await server2.stop();
  }

  console.log("\nALL TESTS PASSED");
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
