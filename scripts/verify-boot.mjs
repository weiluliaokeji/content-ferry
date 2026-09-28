#!/usr/bin/env node
// Headless boot smoke test for the packaged application.
//
// Why this exists
// ---------------
// `npm run dev` (scripts/dev-desktop.mjs) injects CONTENTFERRY_DEV_SERVER_URL,
// so the main window takes the `loadURL` branch and the production `loadFile`
// path is NEVER executed in development. That is exactly how the v0.2.2
// white-flash regression shipped: a wrong relative path made loadFile throw
// ERR_FILE_NOT_FOUND, the app exited cleanly with code 1, and no window ever
// appeared — while every dev/test/CI check stayed green.
//
// This script launches the ACTUAL built executable headlessly and waits for an
// explicit marker emitted only after bootstrap succeeds. Process liveness alone
// is not enough: a startup error dialog can leave Electron alive indefinitely.
//
// Usage
// -----
//   node scripts/verify-boot.mjs [--release-dir <dir>]
//
// If no built executable is found, it prints SKIP and exits 0 — so running it
// locally without a build is a harmless no-op. Inside `npm run dist:win` an
// executable is always produced, so the gate actually runs there.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const PROBE_MS = 20_000;

function parseArgs(argv) {
  const args = { releaseDir: path.join(projectRoot, "release") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--release-dir" && argv[i + 1]) {
      args.releaseDir = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

// Prefer the unpacked executable so the verifier can control its user-data
// directory and observe startup consistently. It contains the exact app.asar
// shipped in the portable executable; fall back to the portable exe if absent.
function findExecutable(releaseDir) {
  if (!existsSync(releaseDir)) return null;
  let entries;
  try {
    entries = readdirSync(releaseDir);
  } catch {
    return null;
  }
  const unpackedExe = path.join(releaseDir, "win-unpacked", "文渡.exe");
  if (existsSync(unpackedExe)) return unpackedExe;
  const portable = entries.find((name) => /^文渡-Portable-.*\.exe$/i.test(name));
  if (portable) return path.join(releaseDir, portable);
  return null;
}

async function waitForBootReady(child, markerPath, deadline) {
  return new Promise((resolve) => {
    const tick = () => {
      if (existsSync(markerPath)) {
        resolve({ ready: true, exited: false, code: null });
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve({ ready: false, exited: true, code: child.exitCode });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ ready: false, exited: false, code: null });
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function main() {
  const { releaseDir } = parseArgs(process.argv.slice(2));
  const exe = findExecutable(releaseDir);

  if (!exe) {
    console.log(`\x1b[33m! No built executable found in ${releaseDir}.\x1b[0m`);
    console.log("  SKIP boot smoke test — run `npm run dist:portable` first, or rely on CI.");
    process.exit(0);
  }

  console.log(`\x1b[36mBoot smoke test: ${exe}\x1b[0m`);
  console.log("  Launching headless, waiting up to 20s for bootstrap to finish…");

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), "cf-boot-"));
  const markerPath = path.join(userDataDir, "boot-ready");
  let spawnError = null;
  const child = spawn(
    exe,
    [
      `--user-data-dir=${userDataDir}`,
      "--no-sandbox",
      "--headless",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ],
    {
      cwd: path.dirname(exe),
      stdio: "ignore",
      env: { ...process.env, CONTENTFERRY_BOOT_PROBE_FILE: markerPath }
    }
  );
  child.on("error", (err) => {
    spawnError = err;
  });

  const { ready, exited, code } = await waitForBootReady(child, markerPath, Date.now() + PROBE_MS);

  // Always clean up the launched process and its temp profile, regardless of
  // outcome. On Windows a GUI process may ignore SIGTERM, so also force-kill
  // by PID. Guard on child.pid: when spawn itself failed there is no process.
  if (!exited && child.pid) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      spawn("taskkill", ["/F", "/PID", String(child.pid), "/T"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Three outcomes:
  //   1. spawnError — the OS could not launch the executable at all (missing
  //      runtime, file locked, or a headless CI host without a display). That
  //      is an ENVIRONMENT limitation, not a code defect, so it is a warning
  //      that does NOT block the build. The regression we actually guard
  //      against (white-flash startup crash) is case 2 below.
  //   2. process exited or never emitted the marker — bootstrap failed or got
  //      stuck (including an error dialog). This is a hard gate failure.
  //   3. explicit bootstrap marker — database, services, and main window load
  //      completed. Pass.
  if (spawnError) {
    console.warn(
      `\x1b[33m! Boot smoke test SKIPPED — executable could not be launched: ${spawnError.message}\x1b[0m`
    );
    console.warn("  This is an environment limitation (no display / missing runtime / locked");
    console.warn("  file), not a code defect. Verify on a machine with a display or rely on CI.");
    process.exit(0);
  }
  if (!ready) {
    console.error(
      `\x1b[31m✘ Boot smoke test failed: startup did not complete (process ${exited ? `exited with code ${code ?? "signal"}` : "timed out"})\x1b[0m`
    );
    console.error("  The packaged app did not report successful startup. Check the database");
    console.error("  migration, startup logs, and main window loadFile / preload wiring.");
    process.exit(1);
  }
  console.log(
    "\x1b[32m✔ Boot smoke test passed: explicit startup-complete marker received\x1b[0m"
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("\n\x1b[31m✘ Boot smoke test crashed.\x1b[0m");
  console.error(error);
  process.exit(1);
});
