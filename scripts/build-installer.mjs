#!/usr/bin/env node
// ContentFerry installer build pipeline.
//
// Orchestrates the seven steps from spec/04 §5:
//   1. Pre-flight checks (Node version, host OS, symlink permission)
//   2. Dependency lock (npm ci when node_modules is stale)
//   3. Type check (tsc --noEmit on both projects)
//   4. Native module rebuild (better-sqlite3 for the target Electron)
//   5. Unit tests (vitest, run under the Electron runtime)
//   6. Production build (tsc + vite)
//   7. Package (electron-builder, with extra files from the config in
//      package.json#build)
//   7.5 Headless boot smoke test — launches the packaged exe to exercise the
//       production loadFile path that `npm run dev` never runs (v0.2.2 fix)
//
// Historical note — the winCodeSign "override server" (removed in 0.3.5):
//
//   electron-builder ≤25 passed a nonexistent `-snld` flag to 7-Zip, so
//   extracting `winCodeSign-2.6.0.7z` on Windows without Developer Mode
//   failed on the macOS `darwin/` symlinks. The pipeline used to strip
//   `darwin/` from a local copy and serve it over a 127.0.0.1 HTTP
//   override (`ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL`).
//
//   electron-builder 26 dropped the `-snld` invocation and its
//   winCodeSign path no longer reads that env var — but app-builder-lib
//   26.17.0 derives the toolset cache directory from the override URL's
//   basename, so a `127.0.0.1:<port>` URL becomes a directory name
//   containing a colon, which Windows rejects: every toolset download
//   (nsis, rcedit, …) then fails with ENOENT (v0.3.4 release run
//   39223578350). The override server was removed; all toolsets now
//   download straight from GitHub. See docs/BUILDING.md §7.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlink,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    if (canSymlink) {
      ok("Symbolic link permission available");
    } else {
      console.log(
        "  \x1b[33m! 当前 Windows 用户没有创建符号链接的权限（未开启「开发人员模式」）。electron-builder 26 已不再传递失效的 -snld 参数，正常情况下不影响打包。\x1b[0m"
      );
    }
  }
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

async function main() {
  preflight();
  await asyncPreflight();

  header("Pipeline");

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

  // 3) Tests use Electron's Node ABI, so rebuild before loading SQLite.
  if (!skipRebuild) {
    await npmExec("rebuild:native");
  } else {
    console.log("  \x1b[33m! --skip-rebuild set, skipping better-sqlite3 rebuild\x1b[0m");
  }

  // 4) Tests (optional).
  if (!skipTests) {
    // Native modules were rebuilt in the previous step; avoid rebuilding a second time inside npm test.
    await npmExec("test:electron");
  } else {
    console.log("  \x1b[33m! --skip-tests set, skipping vitest\x1b[0m");
  }

  // 5) Production build.
  await npmExec("build");
  const version = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;
  const builtAt = new Date().toISOString();
  const buildStamp = builtAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const buildId = `${version}-${buildStamp}`;
  process.env.CONTENTFERRY_BUILD_STAMP = buildStamp;
  writeFileSync(path.join(projectRoot, "dist", "build-info.json"), JSON.stringify({ version, buildId, builtAt }, null, 2) + "\n");

  // 6) Package.
  step("6/7  Package with electron-builder");
  const builderArgs = [];
  if (wantDir) builderArgs.push("--dir");
  if (wantWin) {
    builderArgs.push("--win");
    // `--portable` is an argument to this wrapper, not electron-builder.
    // Pass the actual target after `--win`; otherwise electron-builder falls
    // back to package.json#build.win.target and builds both NSIS and portable.
    if (wantPortable) builderArgs.push("portable");
  }
  // Always force x64 for the first public build per spec/04 §2.
  if (!builderArgs.includes("--x64")) builderArgs.push("--x64");
  // Don't auto-publish anywhere.
  builderArgs.push("--publish", "never");
  // The config lives in package.json#build.
  await run("electron-builder", process.execPath, [electronBuilderCli, ...builderArgs]);

  // 7) Post-verify.
  step("7/7  Verify installer contents");
  await nodeExec(path.join(projectRoot, "scripts", "verify-installer.mjs"), [
    "--release-dir",
    path.join(projectRoot, "release")
  ]);

  // 7.5) Headless boot smoke test. `npm run dev` never exercises the
  //      production loadFile path, so this is the only automated gate that
  //      catches a white-flash startup crash before the tag is published.
  step("7.5/8  Headless boot smoke test");
  await nodeExec(path.join(projectRoot, "scripts", "verify-boot.mjs"), [
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
          entry.isFile() &&
          (entry.name === "builder-debug.yml" ||
            (entry.name.includes(`-${buildId}.`) &&
              /\.(exe|dmg|AppImage|deb|rpm|zip|blockmap|yml)$/i.test(entry.name) &&
              (!wantPortable || !entry.name.startsWith("文渡-Setup-"))))
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
    info("Report scope", `build ${buildId} artifacts for this target; older files remain in release/`);
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
