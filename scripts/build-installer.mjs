#!/usr/bin/env node
// ContentFerry installer build pipeline.
//
// Orchestrates the seven steps from spec/04 §5:
//   1. Pre-flight checks (Node version, host OS, symlink permission)
//   2. Dependency lock (npm ci when node_modules is stale)
//   3. Type check (tsc --noEmit on both projects)
//   4. Unit tests (vitest, run under the Electron runtime)
//   5. Production build (tsc + vite)
//   6. Native module rebuild (better-sqlite3 for the target Electron)
//   7. Package (electron-builder, with extra files from the config in
//      package.json#build)
//
// Windows-specific background work (steps 0 and 6.5):
//
//   0. Start a local HTTP "override" server on 127.0.0.1. The server
//      serves a pre-patched copy of `winCodeSign-2.6.0.7z` (with the
//      macOS-only `darwin/` subfolder stripped out via 7-Zip's `d`
//      command) and proxies every other request through to GitHub. The
//      pipeline then points electron-builder at the local server via the
//      `ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL` env var, so
//      electron-builder downloads the patched archive instead of the
//      raw one. Because the patch happens once at startup (and is then
//      cached in `build/cache/`) there's no race condition with
//      electron-builder's own extract step.
//
//   6.5. Stop the override server, then sweep any leftover broken
//        `darwin/` folders inside cache subdirs (0-byte `*.dylib`
//        stubs from previous failed extracts) so the next build starts
//        from a clean state.
//
// Why a server (and not pre-extracting or upgrading 7-Zip):
//
//   The `winCodeSign-2.6.0.7z` archive contains macOS symlinks under
//   `darwin/10.12/lib/`. electron-builder passes `-snld` to 7-Zip
//   expecting those symlinks to be stored as plain files, but the
//   flag doesn't exist in any released 7-Zip (21.07, 23.01, 26.02 all
//   only document `-snl` and `-snh`). 7-Zip silently ignores `-snld`
//   and falls back to the default symlink-recreate behaviour, which
//   Windows refuses unless Developer Mode is enabled. The archive
//   rewrite sidesteps the whole issue: if `darwin/` isn't in the
//   archive, no symlink extraction is attempted, no Developer Mode is
//   needed, and the rest of the build runs as on macOS.
//
//   Pre-extracting doesn't work because electron-builder re-downloads
//   to a fresh hash subdir on every run, orphaning any pre-populated
//   cache. The override server sits in front of the download itself
//   and is unaffected by the cache key.
//
// See docs/BUILDING.md §7 for the full investigation timeline.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlink,
  writeFileSync
} from "node:fs";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import sevenZipBin from "7zip-bin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const wantDir = args.has("--dir");
const wantWin = args.has("--win") || process.platform === "win32";
const wantPortable = args.has("--portable");
const skipTests = args.has("--skip-tests");
const skipRebuild = args.has("--skip-rebuild");

const electronBuilderCli = path.join(
  projectRoot,
  "node_modules",
  "electron-builder",
  "cli.js"
);

// winCodeSign version that ships with electron-builder 25.1.8.
const WIN_CODE_SIGN_VERSION = "2.6.0";
const WIN_CODE_SIGN_DIR = `winCodeSign-${WIN_CODE_SIGN_VERSION}`;
const WIN_CODE_SIGN_FILE = `${WIN_CODE_SIGN_DIR}.7z`;
const WIN_CODE_SIGN_GITHUB_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${WIN_CODE_SIGN_DIR}/${WIN_CODE_SIGN_FILE}`;

function header(title) {
  const line = "═".repeat(72);
  console.log(`\n\x1b[36m${line}\x1b[0m`);
  console.log(`\x1b[36m  ${title}\x1b[0m`);
  console.log(`\x1b[36m${line}\x1b[0m`);
}

function info(label, value) {
  console.log(`  \x1b[90m${label}:\x1b[0m ${value}`);
}

function step(title) {
  console.log(`\n\x1b[33m▶ ${title}\x1b[0m`);
}

function ok(message) {
  console.log(`  \x1b[32m✔ ${message}\x1b[0m`);
}

function fail(message) {
  console.error(`  \x1b[31m✘ ${message}\x1b[0m`);
}

function run(label, command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    step(`${label}: ${command} ${commandArgs.join(" ")}`);
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
      ...options
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        fail(`${label} exited via signal ${signal}`);
        reject(new Error(`${label} killed by ${signal}`));
        return;
      }
      if (code !== 0) {
        fail(`${label} exited with code ${code}`);
        reject(new Error(`${label} failed (code ${code})`));
        return;
      }
      ok(`${label} succeeded`);
      resolve();
    });
  });
}

function npmExec(script, extraArgs = []) {
  const npmCliFromEnv = process.env.npm_execpath;
  if (npmCliFromEnv && existsSync(npmCliFromEnv)) {
    return run(`npm run ${script}`, process.execPath, [
      npmCliFromEnv,
      "run",
      script,
      ...extraArgs
    ]);
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(`npm run ${script}`, npmCommand, ["run", script, ...extraArgs], {
    shell: process.platform === "win32"
  });
}

function nodeExec(scriptPath, extraArgs = []) {
  return run(scriptPath, process.execPath, [scriptPath, ...extraArgs]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function preflight() {
  header("Pre-flight");
  info("Node", `${process.version} (${process.platform} ${process.arch})`);
  info("Project root", projectRoot);
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 20) {
    fail("ContentFerry requires Node 20 or newer for the build pipeline.");
    process.exit(1);
  }
  if (process.platform !== "win32") {
    console.log(
      "  \x1b[33m! Building on a non-Windows host. electron-builder will skip Windows code signing and may download extra runtime files.\x1b[0m"
    );
  }
  if (!existsSync(path.join(projectRoot, "package-lock.json"))) {
    fail("package-lock.json is missing. Run `npm install` once to generate it.");
    process.exit(1);
  }
  if (!existsSync(electronBuilderCli)) {
    fail(
      "electron-builder is not installed. Run `npm install` to install devDependencies, then re-run this script."
    );
    process.exit(1);
  }
  ok("Pre-flight checks passed");
}

async function asyncPreflight() {
  if (process.platform === "win32") {
    const canSymlink = await checkSymlinkPermission();
    if (!canSymlink) {
      console.log(
        "  \x1b[33m! 当前 Windows 用户没有创建符号链接的权限（未开启「开发人员模式」）。\x1b[0m"
      );
      console.log(
        "  \x1b[33m  流水线会启动本地 HTTP「归档覆写」服务，把下载源指向已剔除 darwin/ 的 winCodeSign 包，从而绕开符号链接问题。\x1b[0m"
      );
      console.log(
        "  \x1b[33m  无需任何系统设置；如想从源头解决，可：设置 → 隐私和安全 → 开发者选项 → 开发人员模式 (开)。\x1b[0m"
      );
    } else {
      ok("Symbolic link permission available");
    }
  }
}

function electronBuilderCacheRoots() {
  // electron-builder honours the ELECTRON_BUILDER_CACHE env var as a prefix
  // inside the cache root. Return both the prefixed and unprefixed shapes
  // so the cache sweep works regardless of how the user has configured
  // their environment.
  const root = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "electron-builder",
    "Cache"
  );
  const prefix = process.env.ELECTRON_BUILDER_CACHE ?? "";
  return [
    path.join(root, `${prefix}winCodeSign`),
    path.join(root, "winCodeSign")
  ];
}

async function checkSymlinkPermission() {
  const testDir = path.join(
    os.tmpdir(),
    `cf-symlink-${process.pid}-${Date.now()}`
  );
  try {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(path.join(testDir, "target"), "ok", "utf8");
    await fsSymlink(path.join(testDir, "target"), path.join(testDir, "link"));
    rmSync(path.join(testDir, "link"), { force: true });
    rmSync(testDir, { recursive: true, force: true });
    return true;
  } catch {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return false;
  }
}

async function fsSymlink(target, link) {
  const flags = process.platform === "win32" ? "junction" : "dir";
  await new Promise((resolve, reject) => {
    symlink(target, link, flags, (error) =>
      error ? reject(error) : resolve()
    );
  });
}

async function runSync(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: projectRoot,
      stdio: options.stdio ?? "inherit",
      shell: false,
      ...options
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function findWinCodeSignInCache() {
  // Look for an unpatched winCodeSign .7z in the electron-builder cache.
  // Any of the existing files will do — they're all the same archive
  // (electron-builder just renames them by URL hash). We pick the
  // largest one so we know we have the complete file.
  let best = null;
  let bestSize = 0;
  for (const root of electronBuilderCacheRoots()) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".7z")) continue;
      const candidate = path.join(root, entry.name);
      const size = statSync(candidate).size;
      if (size > bestSize) {
        bestSize = size;
        best = candidate;
      }
    }
  }
  return best;
}

function downloadFile(url, destination, label) {
  return new Promise((resolve, reject) => {
    step(`  · ${label}`);
    const makeRequest = (targetUrl, redirectsLeft) => {
      const request = httpsRequest(
        targetUrl,
        { headers: { "user-agent": "contentferry-build", accept: "*/*" } },
        (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume();
            if (redirectsLeft <= 0) {
              reject(new Error(`Too many redirects downloading ${url}`));
              return;
            }
            const next = new URL(response.headers.location, targetUrl).toString();
            makeRequest(next, redirectsLeft - 1);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
            return;
          }
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const buffer = Buffer.concat(chunks);
            writeFileSync(destination, buffer);
            resolve(buffer.length);
          });
          response.on("error", reject);
        }
      );
      request.on("error", reject);
      request.end();
    };
    makeRequest(url, 5);
  });
}

/**
 * Ensure a patched copy of `winCodeSign-2.6.0.7z` is available in
 * `build/cache/`. The patched file has its `darwin/` subfolder
 * (containing the macOS symlinks that crash 7-Zip on Windows without
 * Developer Mode) removed via 7-Zip's own `d` command. The original
 * unpatched archive is sourced from the electron-builder cache if
 * present, otherwise downloaded fresh from GitHub. The patched result
 * is cached on disk so subsequent builds skip the ~7 s re-archive.
 */
async function ensurePatchedWinCodeSign() {
  const cacheDir = path.join(projectRoot, "build", "cache");
  mkdirSync(cacheDir, { recursive: true });
  const patchedPath = path.join(cacheDir, "winCodeSign-2.6.0-patched.7z");

  if (existsSync(patchedPath) && statSync(patchedPath).size > 1024 * 1024) {
    ok(
      `Using cached patched winCodeSign archive (${(
        statSync(patchedPath).size /
        1024 /
        1024
      ).toFixed(2)} MB)`
    );
    return patchedPath;
  }

  const originalPath = path.join(cacheDir, "winCodeSign-2.6.0-original.7z");
  if (!existsSync(originalPath)) {
    const fromCache = findWinCodeSignInCache();
    if (fromCache) {
      step(`Copying winCodeSign archive from electron-builder cache`);
      copyFileSync(fromCache, originalPath);
      info("Source", `${path.basename(fromCache)} (${(statSync(originalPath).size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      const bytes = await downloadFile(
        WIN_CODE_SIGN_GITHUB_URL,
        originalPath,
        `Downloading winCodeSign from GitHub`
      );
      info("Downloaded", `${(bytes / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  // 7-Zip's `d` (delete) command rewrites the archive in place via a
  // temp file + atomic rename. With LZMA2 compression this takes ~7 s
  // for a 5.6 MB archive. The output is significantly smaller because
  // the entire darwin/ subfolder (about 1.2 MB of compressed symlinks)
  // is gone.
  step("Patching winCodeSign archive (stripping darwin/ symlinks)");
  const before = statSync(originalPath).size;
  await runSync(sevenZipBin.path7za, ["d", originalPath, "darwin"], {
    stdio: "pipe"
  });
  const after = statSync(originalPath).size;
  if (after >= before) {
    throw new Error(
      `7-Zip 'd' did not shrink the archive (${before} -> ${after} bytes). ` +
        `The archive may be in an unexpected format.`
    );
  }
  renameSync(originalPath, patchedPath);
  ok(
    `Patched winCodeSign archive ready (${(before / 1024 / 1024).toFixed(
      2
    )} -> ${(after / 1024 / 1024).toFixed(2)} MB; darwin/ removed)`
  );
  return patchedPath;
}

/**
 * Start a tiny HTTP server on 127.0.0.1 that:
 *   - serves the patched winCodeSign archive for `/winCodeSign-2.6.0.7z`
 *   - proxies every other request through to the real GitHub release
 *     server so other electron-builder downloads still work.
 *
 * Returns the override URL and a stop() that drains in-flight requests
 * and closes the listener. Caller must invoke stop() after the build
 * finishes (success or failure).
 */
async function startLocalOverrideServer(patchedArchivePath) {
  if (process.platform !== "win32") {
    return { url: null, stop: async () => {} };
  }

  let activeRequests = 0;
  let totalServed = 0;
  let totalProxied = 0;

  const server = createServer((req, res) => {
    activeRequests += 1;
    // Parse the raw request target instead of URL(), because app-builder may
    // request paths like `//nsis-resources-3.4.1.7z`, which URL() interprets as
    // a protocol-relative URL and collapses the pathname to "/".
    const rawUrl = req.url || "/";
    const pathOnly = rawUrl.split("?", 1)[0] || "/";
    const requestPath = decodeURIComponent(pathOnly.replace(/^\/+/, ""));
    const filename = path.posix.basename(requestPath);
    const isWinCodeSign = filename === WIN_CODE_SIGN_FILE;

    if (isWinCodeSign) {
      const size = statSync(patchedArchivePath).size;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": size
      });
      const stream = createReadStream(patchedArchivePath);
      stream.pipe(res);
      stream.on("end", () => {
        activeRequests -= 1;
        totalServed += 1;
      });
      stream.on("error", (err) => {
        try {
          res.writeHead(500);
          res.end(`Stream error: ${err.message}`);
        } catch {
          /* response may already be closed */
        }
        activeRequests -= 1;
      });
      console.log(
        `  \x1b[36mℹ︎ Override server: serving patched winCodeSign (${(
          size /
          1024 /
          1024
        ).toFixed(2)} MB)\x1b[0m`
      );
      return;
    }

    // app-builder asks the override server only for the archive filename
    // (for example `/nsis-resources-3.4.1.7z`), while GitHub's binary
    // releases require the release tag as a separate path segment. The old
    // proxy forwarded that filename directly after `/download/`, producing
    // `/download/nsis-resources-3.4.1.7z` and a GitHub 404. Archive names
    // conventionally match their tag, so derive it here. Keep an incoming
    // nested path intact for any future artifact that already supplies one.
    const releaseTag = requestPath.includes("/")
      ? path.posix.dirname(requestPath)
      : filename.replace(/\.7z$/i, "");
    const target = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${releaseTag}/${filename}`;
    const proxyHeaders = { ...req.headers };
    delete proxyHeaders.host;
    const proxyReq = httpsRequest(
      target,
      {
        method: req.method,
        headers: {
          ...proxyHeaders,
          "user-agent": "contentferry-build"
        }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on("end", () => {
          activeRequests -= 1;
          totalProxied += 1;
        });
      }
    );
    proxyReq.on("error", (err) => {
      try {
        res.writeHead(502);
        res.end(`Proxy error: ${err.message}`);
      } catch {
        /* response may already be closed */
      }
      activeRequests -= 1;
    });
    req.pipe(proxyReq);
    console.log(
      `  \x1b[90mℹ︎ Override server: proxying ${requestPath} to GitHub\x1b[0m`
    );
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  return {
    url,
    stop: async () => {
      // Drain in-flight requests (with a 10 s cap) so a half-finished
      // download doesn't get aborted mid-stream by the listener closing.
      const start = Date.now();
      while (activeRequests > 0 && Date.now() - start < 10000) {
        await sleep(100);
      }
      await new Promise((resolve) => server.close(resolve));
      if (totalServed > 0 || totalProxied > 0) {
        console.log(
          `  \x1b[36mℹ︎ Override server stopped (served ${totalServed} patched, proxied ${totalProxied}).\x1b[0m`
        );
      }
    }
  };
}

function cleanupWinCodeSignStubs() {
  // Walk every winCodeSign cache subdirectory and, if it contains a
  // `darwin/` folder with 0-byte symlink stubs left over from a
  // previous failed extraction, delete the broken `darwin/` so the
  // cache looks valid. This is a no-op when the cache is already clean.
  // With the override server in place the cache should never get a
  // broken darwin/ again, but cleaning up old damage keeps the next
  // debug session from being misleading.
  let cleaned = 0;
  for (const root of electronBuilderCacheRoots()) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      console.log(`  \x1b[33m! Skipping ${root}: ${error.message}\x1b[0m`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const hashDir = path.join(root, entry.name);
      const darwinDir = path.join(hashDir, "darwin");
      if (!existsSync(darwinDir)) continue;
      const symlinkStubs = [
        path.join(darwinDir, "10.12", "lib", "libcrypto.dylib"),
        path.join(darwinDir, "10.12", "lib", "libssl.dylib")
      ];
      const hasStub = symlinkStubs.some((stub) => {
        try {
          return statSync(stub).size === 0;
        } catch {
          return false;
        }
      });
      if (!hasStub) continue;
      try {
        rmSync(darwinDir, { recursive: true, force: true });
        cleaned++;
        ok(`Cleaned broken darwin/ from ${entry.name}`);
      } catch (error) {
        console.log(
          `  \x1b[33m! Could not remove ${darwinDir}: ${error.message}\x1b[0m`
        );
      }
    }
  }
  if (cleaned === 0) {
    ok("winCodeSign cache is clean (no broken darwin/ stubs)");
  } else {
    console.log(
      `  \x1b[33m! Removed broken darwin/ from ${cleaned} cache subdir(s).\x1b[0m`
    );
  }
}

async function main() {
  preflight();
  await asyncPreflight();

  header("Pipeline");

  // 0) On Windows, prepare a patched copy of winCodeSign and start a
  //    local HTTP server that electron-builder will use as the download
  //    origin for that one file. Everything else proxies through to
  //    GitHub. This sidesteps electron-builder's broken `-snld` flag
  //    invocation: with `darwin/` already gone from the archive, the
  //    extract step has no symlinks to recreate, so the build no
  //    longer depends on Windows Developer Mode.
  let stopOverride = async () => {};
  if (process.platform === "win32") {
    const patchedArchive = await ensurePatchedWinCodeSign();
    const override = await startLocalOverrideServer(patchedArchive);
    if (override.url) {
      process.env.ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL = override.url;
      stopOverride = override.stop;
      console.log(
        `  \x1b[36mℹ︎ electron-builder will fetch winCodeSign from ${override.url}\x1b[0m`
      );
    }
  }

  // 1) Install if node_modules looks stale.
  step("1/7  Lock dependencies");
  const nmPath = path.join(projectRoot, "node_modules");
  if (!existsSync(nmPath)) {
    await run("npm install", "npm", ["install", "--no-audit", "--no-fund"]);
  } else {
    ok("node_modules already present, skipping npm ci");
  }

  // 2) Type check.
  await npmExec("typecheck");

  // 3) Tests (optional).
  if (!skipTests) {
    await npmExec("test");
  } else {
    console.log("  \x1b[33m! --skip-tests set, skipping vitest\x1b[0m");
  }

  // 4) Production build.
  await npmExec("build");

  // 5) Native module rebuild.
  if (!skipRebuild) {
    await npmExec("rebuild:native");
  } else {
    console.log("  \x1b[33m! --skip-rebuild set, skipping better-sqlite3 rebuild\x1b[0m");
  }

  // 6) Package.
  step("6/7  Package with electron-builder");
  const builderArgs = [];
  if (wantDir) builderArgs.push("--dir");
  if (wantPortable) builderArgs.push("--x64");
  if (wantWin) builderArgs.push("--win");
  // Always force x64 for the first public build per spec/04 §2.
  if (!builderArgs.includes("--x64")) builderArgs.push("--x64");
  // Don't auto-publish anywhere.
  builderArgs.push("--publish", "never");
  // The config lives in package.json#build.
  await run("electron-builder", process.execPath, [electronBuilderCli, ...builderArgs]);

  // 6.5) Stop the override server and sweep any cache subdirs that
  //      still have broken darwin/ folders from older builds.
  await stopOverride();
  if (process.platform === "win32" && (wantWin || wantPortable)) {
    cleanupWinCodeSignStubs();
  }

  // 7) Post-verify.
  step("7/7  Verify installer contents");
  await nodeExec(path.join(projectRoot, "scripts", "verify-installer.mjs"), [
    "--release-dir",
    path.join(projectRoot, "release")
  ]);

  header("Report");
  const releaseDir = path.join(projectRoot, "release");
  if (existsSync(releaseDir)) {
    const { readdirSync } = await import("node:fs");
    const artifacts = readdirSync(releaseDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() && /\.(exe|dmg|AppImage|deb|rpm|zip|blockmap|yml)$/i.test(entry.name)
      )
      .map((entry) => entry.name);
    for (const name of artifacts) {
      const filePath = path.join(releaseDir, name);
      const stats = statSync(filePath);
      const hash = createHash("sha256");
      hash.update(readFileSync(filePath));
      info(
        name,
        `${(stats.size / 1024 / 1024).toFixed(2)} MB  sha256=${hash
          .digest("hex")
          .slice(0, 16)}…`
      );
    }
  }
  info("Host platform", `${process.platform}/${process.arch}`);
  info(
    "Target platform",
    wantDir
      ? "unpacked dir"
      : wantPortable
      ? "portable exe"
      : "NSIS installer + portable exe"
  );
  ok("Done. Artifacts in release/");
}

main()
  .catch(async (error) => {
    console.error("\n\x1b[31mBuild pipeline failed.\x1b[0m");
    console.error(error);
    process.exit(1);
  });

// Avoid "httpRequest" unused-import warning if Node version differs.
void httpRequest;
