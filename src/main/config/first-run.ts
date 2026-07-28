// First-run configuration for ContentFerry.
//
// Owns the small JSON file that lives next to Electron's `userData` directory
// and records:
//   - the user's chosen data directory
//   - whether the first-run wizard has been completed
//   - the AI / Codex initialisation status
//   - the absolute path of the bundled `codex.exe`, when detected
//
// The file is intentionally separate from the SQLite database because the
// database lives inside the data directory, which is the very thing the
// wizard is asking the user to choose. Putting the marker file in `userData`
// also keeps it across uninstalls (per spec/04 §2 "升级不得覆盖…"),
// and electron-builder's `deleteAppDataOnUninstall` is set to false in
// package.json#build.nsis, so the JSON is preserved.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { app } from "electron";
import type { AppSettings, CodexStatus } from "../../shared/contracts";

const SCHEMA_VERSION = 1 as const;
const SETTINGS_FILE_NAME = "app-settings.json";
const SETTINGS_TMP_NAME = "app-settings.json.tmp";
const SENTINEL_FILE_NAME = ".contentferry-sentinel";

function settingsFilePath(): string {
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

function defaultSettings(): AppSettings {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    dataDir: path.join(app.getPath("userData"), "data"),
    firstRunCompleted: false,
    aiInitStatus: "not_initialized",
    codexBinaryPath: null,
    auditAiCalls: false,
    createdAt: now,
    updatedAt: now
  };
}

function isAppSettings(value: unknown): value is AppSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.dataDir === "string" &&
    typeof candidate.firstRunCompleted === "boolean" &&
    typeof candidate.aiInitStatus === "string" &&
    (typeof candidate.codexBinaryPath === "string" || candidate.codexBinaryPath === null) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

export function loadAppSettings(): AppSettings {
  const filePath = settingsFilePath();
  if (!fs.existsSync(filePath)) {
    const settings = defaultSettings();
    writeAppSettings(settings);
    return settings;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isAppSettings(parsed)) {
      // Backfill any new fields defensively so older settings files keep
      // working after a schema bump.
      return { ...defaultSettings(), ...parsed };
    }
  } catch (error) {
    console.warn("[contentferry] app-settings.json could not be parsed, rewriting defaults", error);
  }
  const settings = defaultSettings();
  writeAppSettings(settings);
  return settings;
}

export function writeAppSettings(next: AppSettings): void {
  const filePath = settingsFilePath();
  const tmpPath = path.join(path.dirname(filePath), SETTINGS_TMP_NAME);
  const payload = JSON.stringify(next, null, 2);
  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadAppSettings();
  const next: AppSettings = {
    ...current,
    ...patch,
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString()
  };
  writeAppSettings(next);
  return next;
}

export function resolveDataDir(candidate: string): {
  ok: boolean;
  path: string;
  reason?: string;
} {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return { ok: false, path: "", reason: "数据目录不能为空。" };
  }
  const resolved = path.resolve(candidate);
  try {
    fs.mkdirSync(resolved, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      path: resolved,
      reason: `无法创建数据目录：${(error as Error).message}`
    };
  }
  try {
    fs.accessSync(resolved, fs.constants.W_OK | fs.constants.R_OK);
  } catch {
    return { ok: false, path: resolved, reason: "数据目录不可读写，请选择其他位置。" };
  }
  // Drop a sentinel file so the next launch can recognise this directory as
  // a ContentFerry data directory.
  try {
    fs.writeFileSync(path.join(resolved, SENTINEL_FILE_NAME), new Date().toISOString(), "utf8");
  } catch {
    // Sentinel is best-effort; a read-only mount may forbid it but still
    // permit the SQLite database to open.
  }
  return { ok: true, path: resolved };
}

function codexCandidatePaths(): string[] {
  const paths: string[] = [];
  // 1. Inside the unpacked asar: app.asar.unpacked/node_modules/@openai/codex-win32-x64/...
  //    The unpacked path is reachable as `<resourcesPath>/app.asar.unpacked/...`.
  // 2. In dev, modules live at <projectRoot>/node_modules/@openai/codex-win32-x64/...
  const platformTriple = "x86_64-pc-windows-msvc";
  const exeName = "codex.exe";
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, "app.asar.unpacked");
    paths.push(
      path.join(
        unpacked,
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        platformTriple,
        "bin",
        exeName
      )
    );
    // npm may place the platform package below @openai/codex when the
    // application is packaged, even though it is hoisted to @openai in the
    // development tree. electron-builder preserves that nested layout.
    paths.push(
      path.join(
        unpacked,
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        platformTriple,
        "bin",
        exeName
      )
    );
    paths.push(
      path.join(
        unpacked,
        "node_modules",
        "@openai",
        "codex-sdk",
        "node_modules",
        "@openai",
        "codex",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        platformTriple,
        "bin",
        exeName
      )
    );
  }
  paths.push(
    path.join(
      app.getAppPath(),
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      platformTriple,
      "bin",
      exeName
    )
  );
  // Fallback to the dev tree, which is where app.getAppPath() points when
  // running `electron .` from the project root.
  paths.push(
    path.join(
      projectRootNodeModules(),
      "@openai",
      "codex-win32-x64",
      "vendor",
      platformTriple,
      "bin",
      exeName
    )
  );
  return paths;
}

function projectRootNodeModules(): string {
  // In dev (electron .) app.getAppPath() points to the project root, so
  // node_modules/ is right next to it. In production we may not reach this
  // branch, but listing it keeps the function exhaustive.
  return path.join(app.getAppPath(), "node_modules");
}

export function detectCodexBinary(): CodexStatus {
  for (const candidate of codexCandidatePaths()) {
    if (fs.existsSync(candidate)) {
      return { ok: true, binaryPath: candidate, authenticated: false };
    }
  }
  return {
    ok: false,
    binaryPath: null,
    authenticated: false,
    reason: "当前未启用 OpenAI Codex。你可以稍后配置 Codex，或改用 OpenAI API、OpenRouter、GitHub Copilot 等模型连接；这不影响进入文渡。"
  };
}

export async function inspectCodexStatus(): Promise<CodexStatus> {
  const detected = detectCodexBinary();
  if (!detected.ok || !detected.binaryPath) return detected;
  return new Promise((resolve) => {
    execFile(detected.binaryPath!, ["login", "status"], { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      if (!error && /logged in/i.test(output)) {
        const method = /using\s+(.+)/i.exec(output)?.[1]?.trim();
        resolve({ ...detected, authenticated: true, authMethod: method || "ChatGPT" });
        return;
      }
      resolve({
        ...detected,
        authenticated: false,
        reason: "Codex 运行组件已找到，但尚未完成 ChatGPT OAuth 登录。你可以现在授权，也可以跳过，稍后再配置。"
      });
    });
  });
}

export function markCodexLoginRequired(): AppSettings {
  return saveAppSettings({ aiInitStatus: "login_required" });
}

export function markCodexReady(binaryPath: string): AppSettings {
  return saveAppSettings({ aiInitStatus: "ready", codexBinaryPath: binaryPath });
}

export function markCodexBinaryMissing(): AppSettings {
  return saveAppSettings({ aiInitStatus: "binary_missing" });
}

export function markFirstRunCompleted(dataDir: string): AppSettings {
  const resolved = resolveDataDir(dataDir);
  if (!resolved.ok) {
    throw new Error(resolved.reason ?? "无法保存数据目录。");
  }
  return saveAppSettings({ firstRunCompleted: true, dataDir: resolved.path });
}
