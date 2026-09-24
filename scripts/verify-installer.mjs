#!/usr/bin/env node
// Verify the contents of an electron-builder output directory.
//
// Electron-builder always produces `release/win-unpacked/` (even when the
// primary target is the NSIS installer). We verify that directory directly
// and also use @electron/asar to peek inside app.asar, so the check works
// for `--dir`, portable and full NSIS builds alike.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { releaseDir: path.join(projectRoot, "release") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--release-dir" && argv[i + 1]) {
      args.releaseDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--unpacked-dir" && argv[i + 1]) {
      args.releaseDir = path.resolve(path.dirname(argv[i + 1]));
      args.explicitUnpacked = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const checks = [];
function pass(name, detail) {
  checks.push({ ok: true, name, detail });
}
function failCheck(name, detail) {
  checks.push({ ok: false, name, detail });
}

function locateUnpackedDir(releaseDir, explicit) {
  if (explicit && existsSync(explicit)) return explicit;
  const candidates = ["win-unpacked", "linux-unpacked", "mac-unpacked", "mac"];
  for (const candidate of candidates) {
    const full = path.join(releaseDir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

// L1 guard: the production startup assets (main window loadFile + preload, and
// the research stealth preload) MUST be resolved from app.getAppPath(), never
// from a __dirname-relative path that silently breaks when a file is moved
// between directories. The v0.2.2 white-flash regression came from exactly
// this: windows.ts was moved during a refactor and a `../../renderer/index.html`
// relative path no longer resolved, so loadFile threw ERR_FILE_NOT_FOUND and the
// app exited cleanly (code 1) with no window. `npm run dev` never caught it
// because dev injects CONTENTFERRY_DEV_SERVER_URL and takes the loadURL branch.
//
// This check scans the two source files that wire startup assets and fails if
// any of them regresses to a __dirname-relative path that goes up a directory,
// or drops the app.getAppPath() anchor. Same-directory __dirname usage (e.g.
// svg-rasterizer.ts) is intentionally NOT in scope — only startup assets are.
function checkStartupPathSafety() {
  const sourceFiles = [
    path.join(projectRoot, "src", "main", "automation", "windows.ts"),
    path.join(projectRoot, "src", "main", "automation", "research-automation.ts")
  ];
  // The exact broken literal that caused the v0.2.2 white-flash crash.
  const forbiddenLiteral = "../../renderer/index.html";
  // A __dirname path that goes UP a directory is depth-sensitive and is the
  // class of bug we guard against for startup assets.
  const upDirPattern = /path\.join\(\s*__dirname\s*,\s*["'][^"']*\.\./;
  for (const file of sourceFiles) {
    if (!existsSync(file)) {
      failCheck("startup path safety", `source file missing: ${path.relative(projectRoot, file)}`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const name = path.basename(file);
    if (text.includes(forbiddenLiteral)) {
      failCheck("startup path safety", `${name} still contains the broken literal ${forbiddenLiteral}`);
      continue;
    }
    if (upDirPattern.test(text)) {
      failCheck(
        "startup path safety",
        `${name} uses a __dirname-relative path that goes up a directory for a startup asset`
      );
      continue;
    }
    // Any file that wires a startup asset (loadFile / preload / stealth preload)
    // must anchor it on app.getAppPath().
    if (/loadFile\(|preload:|research-stealth-preload\.js/.test(text) && !text.includes("app.getAppPath()")) {
      failCheck("startup path safety", `${name} wires a startup asset without app.getAppPath()`);
      continue;
    }
    pass("startup path safety", `${name} resolves startup assets via app.getAppPath()`);
  }
}

async function main() {
  const { default: asar } = await import("@electron/asar");

  if (!existsSync(args.releaseDir)) {
    console.error(`\x1b[31m✘ release directory not found: ${args.releaseDir}\x1b[0m`);
    console.error("  Run `npm run pack` or `npm run dist:win` first.");
    process.exit(1);
  }

  console.log(`\x1b[36mVerifying artifacts in: ${args.releaseDir}\x1b[0m\n`);

  // Static guard against the startup-path regression class. Runs off the
  // source tree, so it is deterministic and needs no GUI — it is part of the
  // CI gate via `npm run dist:win` (which calls this script at step 7/7).
  checkStartupPathSafety();

  // List top-level artifacts.
  const topEntries = readdirSync(args.releaseDir, { withFileTypes: true });
  const installers = topEntries
    .filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name))
    .map((entry) => entry.name);
  if (installers.length > 0) {
    console.log("  Installers:");
    for (const name of installers) {
      const filePath = path.join(args.releaseDir, name);
      const size = statSync(filePath).size;
      const hash = createHash("sha256");
      hash.update(readFileSync(filePath));
      console.log(
        `    • ${name}  (${(size / 1024 / 1024).toFixed(2)} MB, sha256=${hash.digest("hex").slice(0, 16)}…)`
      );
    }
  } else {
    console.log("  \x1b[33m! No .exe installers found at the top of the release directory.\x1b[0m");
  }

  // Locate the unpacked directory.
  const unpacked = locateUnpackedDir(args.releaseDir, args.explicitUnpacked);
  if (!unpacked) {
    failCheck(
      "unpacked directory present",
      "Neither win-unpacked, linux-unpacked, mac-unpacked, nor mac was found. Did electron-builder finish?"
    );
  } else {
    pass("unpacked directory present", unpacked);
  }

  if (unpacked) {
    const resourcesDir = path.join(unpacked, "resources");
    const asarPath = path.join(resourcesDir, "app.asar");
    const asarUnpackedDir = path.join(resourcesDir, "app.asar.unpacked");
    const skillManifestPath = path.join(resourcesDir, "assets", "skills", "manifest.json");
    const userGuidePath = path.join(resourcesDir, "docs", "USER-GUIDE.md");

    if (existsSync(skillManifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(skillManifestPath, "utf8"));
        const missingSkills = (manifest.skills ?? []).filter((skill) =>
          !existsSync(path.join(resourcesDir, "assets", "skills", skill.id, "SKILL.md"))
        );
        if (manifest.schemaVersion === 1 && manifest.skills?.length > 0 && missingSkills.length === 0) {
          pass("built-in skill resources bundled", `${manifest.skills.length} skills`);
        } else {
          failCheck("built-in skill resources bundled", `invalid manifest or ${missingSkills.length} missing SKILL.md files`);
        }
      } catch (error) {
        failCheck("built-in skill resources bundled", String(error));
      }
    } else {
      failCheck("built-in skill resources bundled", `missing at ${skillManifestPath}`);
    }

    if (existsSync(userGuidePath) && statSync(userGuidePath).size > 0) {
      pass("standalone user guide bundled", userGuidePath);
    } else {
      failCheck("standalone user guide bundled", `missing or empty at ${userGuidePath}`);
    }

    if (!existsSync(asarPath)) {
      failCheck("app.asar exists", `missing at ${asarPath}`);
    } else {
      pass("app.asar exists", asarPath);

      // Peek into asar and confirm the application's package.json was bundled.
      try {
        const asarPackageJson = asar.extractFile(asarPath, "package.json");
        const parsed = JSON.parse(asarPackageJson.toString("utf8"));
        if (parsed.name === "contentferry") {
          pass("app.asar contains contentferry package.json", `version ${parsed.version}`);
        } else {
          failCheck("app.asar contains contentferry package.json", `found name=${parsed.name}`);
        }
      } catch (error) {
        failCheck("app.asar readable", String(error));
      }

      // 启动入口必须齐备，否则 Electron 只会「窗口白闪一下就没」，而构建与单测全绿：
      //   - 主进程入口 package.json#main（由 build.extraMetadata 覆盖）
      //   - 渲染入口 app.getAppPath()/dist/renderer/index.html（见 src/main/automation/windows.ts）
      try {
        const packagedPackage = JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
        const mainEntry = typeof packagedPackage.main === "string" ? packagedPackage.main : "";
        if (!mainEntry) throw new Error("packaged package.json has no main field");
        // @electron/asar expects paths in the host platform's format. On
        // Windows, package.json still uses forward slashes, while asar paths
        // are indexed with backslashes.
        const mainEntryPath = path.join(...mainEntry.split(/[\\/]+/));
        asar.extractFile(asarPath, mainEntryPath);
        asar.extractFile(asarPath, path.join("dist", "renderer", "index.html"));
        pass("startup entry files present", `${mainEntry} + dist/renderer/index.html`);
      } catch (error) {
        failCheck("startup entry files present", String(error));
      }

      // 主窗口 preload 同样由 tsconfig.main.json 固定编译到
      // dist/main/main/preload.js，且 windows.ts 已改用 app.getAppPath() 定位。
      // 单独校验，避免 preload 路径回归（v0.2.2 之前与 loadFile 同源的 __dirname
      // 深度坑：少写一层会让 preload 静默缺失，窗口创建失败）。
      try {
        asar.extractFile(asarPath, path.join("dist", "main", "main", "preload.js"));
        pass("main window preload bundled", "dist/main/main/preload.js");
      } catch (error) {
        failCheck("main window preload bundled", String(error));
      }

      // Electron loads this file through file://. Root-relative Vite assets
      // such as /assets/app.js resolve against the drive root and produce a
      // completely blank window even though packaging itself succeeds.
      try {
        const rendererHtml = asar.extractFile(asarPath, path.join("dist", "renderer", "index.html")).toString("utf8");
        const rootRelativeAsset = /(?:src|href)=["']\/(?!\/)/i.test(rendererHtml);
        if (rootRelativeAsset) {
          failCheck("renderer assets use file-safe relative URLs", "index.html contains a root-relative src/href");
        } else if (/\.\/assets\//i.test(rendererHtml)) {
          pass("renderer assets use file-safe relative URLs", "index.html uses ./assets/...");
        } else {
          failCheck("renderer assets use file-safe relative URLs", "no packaged renderer asset references found");
        }
      } catch (error) {
        failCheck("packaged renderer index readable", String(error));
      }
    }

    if (!existsSync(asarUnpackedDir)) {
      failCheck("app.asar.unpacked exists", `missing at ${asarUnpackedDir}`);
    } else {
      pass("app.asar.unpacked exists", asarUnpackedDir);

      // better-sqlite3 native module.
      const sqliteCandidates = [
        "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        "node_modules/better-sqlite3/bin/Release/better_sqlite3.node",
        "node_modules/better-sqlite3/lib/binding/Release/node-v127-win32-x64/better_sqlite3.node",
        "node_modules/better-sqlite3/lib/binding/Release/electron-v37-win32-x64/better_sqlite3.node"
      ];
      const sqliteHit = sqliteCandidates.find((rel) => existsSync(path.join(asarUnpackedDir, rel)));
      if (sqliteHit) {
        pass("better-sqlite3 native module unpacked", sqliteHit);
      } else {
        // Walk the unpacked tree for any better_sqlite3.node.
        const found = findFile(asarUnpackedDir, "better_sqlite3.node");
        if (found) pass("better-sqlite3 native module unpacked", path.relative(asarUnpackedDir, found));
        else failCheck("better-sqlite3 native module unpacked", "no better_sqlite3.node found under app.asar.unpacked");
      }

      // Codex native binary.
      const codexHit = findFile(asarUnpackedDir, "codex.exe");
      if (codexHit) {
        pass("codex.exe unpacked", path.relative(asarUnpackedDir, codexHit));
      } else {
        failCheck("codex.exe unpacked", "no codex.exe found under app.asar.unpacked");
      }
    }
  }

  // Summary.
  console.log("\n\x1b[36mSummary\x1b[0m");
  let allOk = true;
  for (const check of checks) {
    const symbol = check.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✘\x1b[0m";
    const detail = check.detail ? `  \x1b[90m${check.detail}\x1b[0m` : "";
    console.log(`  ${symbol} ${check.name}${detail}`);
    if (!check.ok) allOk = false;
  }

  if (!allOk) {
    console.error("\n\x1b[31m✘ Verification failed.\x1b[0m");
    process.exit(1);
  }
  console.log("\n\x1b[32m✔ All checks passed.\x1b[0m");
}

function findFile(rootDir, fileName) {
  if (!existsSync(rootDir)) return null;
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === fileName) {
        return full;
      }
    }
  }
  return null;
}

main().catch((error) => {
  console.error("\n\x1b[31m✘ Verification crashed.\x1b[0m");
  console.error(error);
  process.exit(1);
});
