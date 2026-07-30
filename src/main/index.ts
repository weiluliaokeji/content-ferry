import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, type OpenDialogOptions } from "electron";
import { openDatabase, type AppDatabase } from "./db/database";
import { getDataDirectory } from "./config/paths";
import { createServer } from "./server/create-server";
import { BrowserVerificationRequiredError, type SearchResultItem } from "./ai/web-search";
import { ElectronCredentialVault } from "./security/credential-vault";
import { OpenAICodexProvider } from "./ai/openai-codex-provider";
import { LocalAssetStore } from "./content/local-asset-store";
import { dailyLogFilePath } from "./logging/daily-log-stream";
import {
  detectCodexBinary,
  inspectCodexStatus,
  loadAppSettings,
  markCodexBinaryMissing,
  markCodexLoginRequired,
  markCodexReady,
  markFirstRunCompleted,
  resolveDataDir,
  saveAppSettings
} from "./config/first-run";
import type { AppSettings as AppSettingsContract } from "../shared/contracts";

let mainWindow: BrowserWindow | undefined;
let zhuqueWindow: BrowserWindow | undefined;
let contentAnyWindow: BrowserWindow | undefined;
let researchBrowserWindow: BrowserWindow | undefined;
// Serializes every visible-browser research call so two overlapping searches
// can't loadURL over each other (which would mix up results or yank the window
// out from under a human mid-verification). gstack's Layer-3 handoff assumes a
// single, stable window for the user to complete — a queue preserves that.
let researchSearchChain: Promise<SearchResultItem[] | void> = Promise.resolve();
function enqueueResearchSearch(task: () => Promise<SearchResultItem[]>): Promise<SearchResultItem[]> {
  const next = researchSearchChain.then(task, task);
  researchSearchChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}
let wechatBackendWindow: BrowserWindow | undefined;
let wechatEditorWindow: BrowserWindow | undefined;
let wechatBackendAdvanceTask: Promise<void> | undefined;
type WechatBackendTarget = {
  accountId: string;
  title: string;
  declareOriginal: boolean;
  enableReward: boolean;
  collectionName: string;
};
let wechatBackendTarget: WechatBackendTarget | undefined;
let runtimeDatabase: AppDatabase | undefined;
let runtimeBootstrapPromise: Promise<void> | undefined;
let runtimeShutdown: (() => Promise<void>) | undefined;
let shutdownPromise: Promise<void> | undefined;
let runtimeInfoLogger: ((details: Record<string, unknown>, message: string) => void) | undefined;

function logWechatBrowserAssist(step: string, details: Record<string, unknown> = {}): void {
  runtimeInfoLogger?.({ scope: "wechat-browser-assist", step, ...details }, "微信浏览器辅助");
}

function saveObservedWechatCollections(accountId: string, names: unknown): void {
  if (!runtimeDatabase || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId) || !Array.isArray(names)) return;
  const uniqueNames = [...new Set(names
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter((name) => name.length > 0 && name.length <= 80))];
  if (uniqueNames.length === 0) return;
  try {
    const accountExists = runtimeDatabase.connection.prepare("SELECT 1 FROM media_accounts WHERE id = ? AND deleted_at IS NULL")
      .get(accountId);
    if (!accountExists) return;
    const now = new Date().toISOString();
    const insert = runtimeDatabase.connection.prepare(`INSERT INTO wechat_collections
      (account_id, name, wechat_collection_id, observed_at) VALUES (?, ?, NULL, ?)
      ON CONFLICT(account_id, name) DO UPDATE SET observed_at = excluded.observed_at`);
    const save = runtimeDatabase.connection.transaction((items: string[]) => {
      for (const name of items) insert.run(accountId, name, now);
    });
    save(uniqueNames);
    logWechatBrowserAssist("collections-observed", { accountId, count: uniqueNames.length });
  } catch (error) {
    logWechatBrowserAssist("collections-observation-save-failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function destroyAuxiliaryWindows(): void {
  for (const window of [zhuqueWindow, contentAnyWindow, wechatEditorWindow, wechatBackendWindow]) {
    if (window && !window.isDestroyed()) window.destroy();
  }
  zhuqueWindow = undefined;
  contentAnyWindow = undefined;
  wechatEditorWindow = undefined;
  wechatBackendWindow = undefined;
  wechatBackendAdvanceTask = undefined;
  wechatBackendTarget = undefined;
}

function shutdownAndExit(exitCode = 0): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    destroyAuxiliaryWindows();
    if (runtimeShutdown) await runtimeShutdown();
    app.exit(exitCode);
  })();
  return shutdownPromise;
}

function launchCodexOAuthWindow(binaryPath: string): Promise<number> {
  const escapedBinary = binaryPath.replace(/'/g, "''");
  const loginScript = [
    "$Host.UI.RawUI.WindowTitle = '文渡 - OpenAI Codex 登录'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$codexBinary = '${escapedBinary}'`,
    "Write-Host '文渡正在启动 OpenAI Codex OAuth 设备授权。' -ForegroundColor Cyan",
    "Write-Host '请按照下方提示打开网页并输入设备码；授权完成后回到文渡点击“重新检测”。'",
    "Write-Host ''",
    "& $codexBinary login --device-auth",
    "Write-Host ''",
    "if ($LASTEXITCODE -eq 0) { Write-Host 'OAuth 授权完成，可以返回文渡。' -ForegroundColor Green } else { Write-Host 'OAuth 授权未完成，请检查上方错误。' -ForegroundColor Red }",
    "Read-Host '按 Enter 关闭此窗口'"
  ].join("\r\n");
  const encodedLoginScript = Buffer.from(loginScript, "utf16le").toString("base64");
  const launcherScript = [
    `$process = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', '${encodedLoginScript}') -PassThru`,
    "$process.Id"
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", launcherScript],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`无法创建 Codex OAuth 授权窗口：${stderr.trim() || error.message}`));
          return;
        }
        const processId = Number.parseInt(stdout.trim(), 10);
        if (!Number.isFinite(processId) || processId <= 0) {
          reject(new Error("Windows 未返回 OAuth 授权窗口的进程 ID。"));
          return;
        }
        resolve(processId);
      }
    );
  });
}

type ZhuqueSegmentKind = "human" | "uncertain" | "ai";
type ZhuqueReport = {
  verdict: string;
  humanPercent: number | null;
  uncertainPercent: number | null;
  aiPercent: number | null;
  ratioSource: "official" | "segments";
  segments: Array<{ text: string; kind: ZhuqueSegmentKind }>;
};
type ZhuqueDetectionResponse = {
  status: "completed" | "needs_user";
  result?: string;
  report?: ZhuqueReport;
  message?: string;
};
type ContentAnyDetectionResponse = {
  status: "completed" | "needs_user";
  result?: string;
  reference?: { label: string; score: string | null; summary: string; detail: string };
  message?: string;
};

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: "文渡",
    icon: createWenduWindowIcon(),
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });
  mainWindow = window;

  // A renderer `beforeunload` guard is used while an article has unsaved
  // changes. Electron does not show Chromium's native confirmation UI for
  // BrowserWindow closes, so without this handler the title-bar close button
  // appears to do nothing. Convert it into an explicit desktop confirmation.
  window.webContents.on("will-prevent-unload", (event) => {
    if (window.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "文渡",
      message: "当前文章还有未保存的修改",
      detail: "关闭文渡会丢失这些修改。你可以返回编辑器先保存，或者放弃修改并退出。",
      buttons: ["返回保存", "放弃修改并退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice === 1) event.preventDefault();
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
    if (process.platform !== "darwin") void shutdownAndExit();
  });

  const devServerUrl = process.env.CONTENTFERRY_DEV_SERVER_URL;
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

function createWenduWindowIcon() {
  const iconName = process.platform === "win32" ? "wendu-icon.ico" : "wendu-icon.png";
  return nativeImage.createFromPath(path.join(app.getAppPath(), "assets", iconName));
}

async function registerAppSettingsIpcHandlers(): Promise<void> {
  ipcMain.handle("app:get-settings", async () => loadAppSettings());
  ipcMain.handle("app:update-settings", async (_event, patch: unknown) => {
    if (typeof patch !== "object" || patch === null) {
      throw new Error("设置更新参数无效。");
    }
    return saveAppSettings(patch as Partial<AppSettingsContract>);
  });
  ipcMain.handle("app:choose-data-dir", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "选择文渡的内容数据目录",
          properties: ["openDirectory", "createDirectory"]
        })
      : await dialog.showOpenDialog({
          title: "选择文渡的内容数据目录",
          properties: ["openDirectory", "createDirectory"]
        });
    if (result.canceled) return undefined;
    const chosen = result.filePaths[0];
    const resolved = resolveDataDir(chosen);
    if (!resolved.ok) {
      throw new Error(resolved.reason ?? "无法使用所选目录。");
    }
    return resolved.path;
  });
  ipcMain.handle("app:set-data-dir", async (_event, target: unknown) => {
    if (typeof target !== "string" || target.trim().length === 0) {
      throw new Error("数据目录路径无效。");
    }
    const resolved = resolveDataDir(target);
    if (!resolved.ok) {
      throw new Error(resolved.reason ?? "无法使用所选目录。");
    }
    return saveAppSettings({ dataDir: resolved.path });
  });
  ipcMain.handle("app:detect-codex", async () => {
    const status = await inspectCodexStatus();
    if (status.ok && status.binaryPath && status.authenticated) {
      markCodexReady(status.binaryPath);
    } else if (status.ok && status.binaryPath) {
      markCodexLoginRequired();
    } else {
      markCodexBinaryMissing();
    }
    return status;
  });
  ipcMain.handle("app:open-codex-login", async () => {
    const status = detectCodexBinary();
    if (!status.ok || !status.binaryPath) {
      markCodexBinaryMissing();
      return { ok: false, message: status.reason ?? "codex 二进制缺失" };
    }
    markCodexLoginRequired();
    const processId = await launchCodexOAuthWindow(status.binaryPath);
    return {
      ok: true,
      message: `已启动 OpenAI Codex OAuth 设备授权窗口（进程 ${processId}）。请按窗口提示完成授权，然后点击“重新检测”。`
    };
  });
  ipcMain.handle("app:complete-first-run", async (_event, target: unknown) => {
    if (typeof target !== "string" || target.trim().length === 0) {
      throw new Error("数据目录路径无效。");
    }
    const settings = markFirstRunCompleted(target);
    await ensureRuntimeBootstrapped(true);
    return settings;
  });
  ipcMain.handle("app:relaunch", async () => {
    app.relaunch();
    await shutdownAndExit();
  });
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  await registerAppSettingsIpcHandlers();
  const settings = loadAppSettings();
  if (!settings.firstRunCompleted) {
    // The first-run wizard uses only preload IPC and must be visible before
    // the local content service exists. Hiding this window made a clean
    // portable install appear briefly and then leave the user with no UI.
    await createMainWindow();
    return;
  }
  await ensureRuntimeBootstrapped(false);
}

function ensureRuntimeBootstrapped(reuseExistingWindow: boolean): Promise<void> {
  if (!runtimeBootstrapPromise) {
    runtimeBootstrapPromise = fullBootstrap(reuseExistingWindow).catch((error: unknown) => {
      runtimeBootstrapPromise = undefined;
      throw error;
    });
  }
  return runtimeBootstrapPromise;
}

async function fullBootstrap(reuseExistingWindow: boolean): Promise<void> {
  const appSettings: AppSettingsContract = loadAppSettings();
  // The data directory is sourced from app-settings.json once the wizard
  // has run; before that we still rely on getDataDirectory() which respects
  // CONTENTFERRY_DATA_DIR for development overrides.
  const dataDirectory = appSettings.dataDir && appSettings.dataDir.length > 0
    ? appSettings.dataDir
    : getDataDirectory();
  const logDirectory = path.join(dataDirectory, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFilePath = dailyLogFilePath(logDirectory);
  const database = openDatabase(dataDirectory);
  runtimeDatabase = database;
  const modelProvider = new OpenAICodexProvider(path.join(dataDirectory, "ai-sandbox"));
  const assetStore = new LocalAssetStore(path.join(dataDirectory, "content-assets"));
  const server = await createServer(
    new Date().toISOString(),
    database,
    new ElectronCredentialVault(safeStorage),
    modelProvider,
    assetStore,
    logFilePath,
    path.join(dataDirectory, "skills"),
    searchWithVisibleResearchBrowser,
    confirmCsdnBrowserPublish
  );
  runtimeInfoLogger = (details, message) => server.log.info(details, message);
  let runtimeClosed = false;
  runtimeShutdown = async () => {
    if (runtimeClosed) return;
    runtimeClosed = true;
    try {
      await Promise.race([
        server.close(),
        delay(3_000).then(() => { throw new Error("本地服务在 3 秒内未能完全关闭。"); })
      ]);
    } catch (error) {
      console.warn("ContentFerry local service shutdown warning", error);
    }
    try {
      database.close();
    } catch (error) {
      console.warn("ContentFerry database shutdown warning", error);
    }
    runtimeInfoLogger = undefined;
    if (runtimeDatabase === database) runtimeDatabase = undefined;
  };

  ipcMain.handle("contentferry:select-directory", async () => {
    const options: OpenDialogOptions = {
      title: "选择 VitePress 的 docs 文章库文件夹",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("contentferry:select-image", async () => {
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, {
      title: "选择文章封面",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }]
    }) : await dialog.showOpenDialog({
      title: "选择文章封面",
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }]
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const filePath = result.filePaths[0];
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > 15 * 1024 * 1024) throw new Error("封面图片必须小于 15 MB。");
    const extension = path.extname(filePath).toLowerCase();
    const mimeType = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[extension];
    if (!mimeType) throw new Error("不支持这种图片格式。");
    return { fileName: path.basename(filePath), mimeType, base64: bytes.toString("base64") };
  });
  ipcMain.handle("contentferry:open-zhuque", async () => {
    const window = await getOrCreateZhuqueWindow();
    window.show();
    window.focus();
  });
  ipcMain.handle("contentferry:open-wechat-backend", async (_event, target?: { accountId?: unknown; title?: unknown; declareOriginal?: unknown; enableReward?: unknown; collectionName?: unknown }) => {
    const window = await getOrCreateWechatBackendWindow();
    window.show();
    window.focus();
    const requestedTitle = typeof target?.title === "string" ? target.title.trim() : "";
    if (requestedTitle) {
      const accountId = typeof target?.accountId === "string" ? target.accountId.trim() : "";
      wechatBackendTarget = {
        accountId: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId) ? accountId : "",
        title: requestedTitle.slice(0, 200),
        declareOriginal: target?.declareOriginal === true,
        enableReward: target?.enableReward === true,
        collectionName: typeof target?.collectionName === "string" ? target.collectionName.trim().slice(0, 80) : ""
      };
      logWechatBrowserAssist("requested", {
        title: wechatBackendTarget.title,
        accountId: wechatBackendTarget.accountId || undefined,
        declareOriginal: wechatBackendTarget.declareOriginal,
        enableReward: wechatBackendTarget.enableReward,
        hasCollection: Boolean(wechatBackendTarget.collectionName)
      });
      // A deliberate reopen starts a fresh browser-assist run. Session storage
      // is still used across the internal WeChat page navigations that follow.
      await window.webContents.executeJavaScript("sessionStorage.removeItem('contentferry-wechat-draft-target'); window.__contentFerryWechatDraftTarget = undefined;", true);
    } else {
      wechatBackendTarget = undefined;
      await window.webContents.executeJavaScript("sessionStorage.removeItem('contentferry-wechat-draft-target'); window.__contentFerryWechatDraftTarget = undefined;", true);
    }
    await driveWechatBackendToDrafts(window, wechatBackendTarget);
  });
  ipcMain.handle("contentferry:open-csdn-publisher", async (_event, jobId?: unknown) => {
    if (typeof jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(jobId)) throw new Error("缺少有效的 CSDN 发布任务标识。");
    logCsdnBrowserAssist("requested", { jobId });
    await driveCsdnBrowserPublish(jobId);
  });
  ipcMain.handle("contentferry:open-contentany", async () => {
    const window = await getOrCreateContentAnyWindow();
    window.show();
    window.focus();
  });
  ipcMain.handle("contentferry:open-user-guide", async () => {
    const userGuidePath = app.isPackaged
      ? path.join(process.resourcesPath, "docs", "USER-GUIDE.md")
      : path.join(app.getAppPath(), "docs", "USER-GUIDE.md");
    if (!fs.existsSync(userGuidePath)) throw new Error("安装包中缺少完整使用说明。");
    const error = await shell.openPath(userGuidePath);
    if (error) throw new Error(`无法打开完整使用说明：${error}`);
  });
  ipcMain.handle("contentferry:show-log-file", async (_event, requestedDate: unknown) => {
    const date = typeof requestedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? new Date(`${requestedDate}T12:00:00`) : new Date();
    const selectedLogFilePath = dailyLogFilePath(logDirectory, date);
    if (fs.existsSync(selectedLogFilePath)) {
      shell.showItemInFolder(selectedLogFilePath);
      return;
    }
    await shell.openPath(logDirectory);
  });
  ipcMain.handle("contentferry:run-zhuque", async (_event, markdown: unknown) => {
    if (typeof markdown !== "string" || markdown.length === 0 || markdown.length > 100_000) {
      throw new Error("待检测正文为空或过长。");
    }
    return runZhuqueDetection(markdown);
  });
  ipcMain.handle("contentferry:run-contentany", async (_event, markdown: unknown) => {
    if (typeof markdown !== "string" || markdown.length === 0 || markdown.length > 100_000) {
      throw new Error("待检测正文为空或过长。");
    }
    return runContentAnyDetection(markdown);
  });

  if (!reuseExistingWindow || !mainWindow || mainWindow.isDestroyed()) {
    await createMainWindow();
  }

}

app.whenReady().then(bootstrap).catch((error: unknown) => {
  console.error("ContentFerry failed to start", error);
  void shutdownAndExit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") void shutdownAndExit();
});

app.on("before-quit", (event) => {
  if (!shutdownPromise && runtimeShutdown) {
    event.preventDefault();
    void shutdownAndExit();
  }
});

async function getOrCreateZhuqueWindow(): Promise<BrowserWindow> {
  if (zhuqueWindow && !zhuqueWindow.isDestroyed()) return zhuqueWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · 腾讯朱雀自动检测",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-zhuque"
    }
  });
  zhuqueWindow = window;
  window.on("closed", () => { if (zhuqueWindow === window) zhuqueWindow = undefined; });
  await window.loadURL("https://matrix.tencent.com/ai-detect/ai_gen_txt/");
  await delay(1200);
  return window;
}

async function runZhuqueDetection(markdown: string): Promise<ZhuqueDetectionResponse> {
  const window = await getOrCreateZhuqueWindow();
  window.show();
  window.focus();

  const filled = await window.webContents.executeJavaScript(`(async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 100 && rect.height > 30 && style.display !== "none" && style.visibility !== "hidden";
    };
    let candidates = [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(visible);
    if (candidates.length === 0) {
      document.querySelector(".clear-btn")?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      candidates = [...document.querySelectorAll("textarea, [contenteditable='true']")].filter(visible);
    }
    const editor = document.querySelector(".txt-input textarea") || candidates.sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0];
    if (!editor) return { ok: false, reason: "未找到正文输入区域" };
    const previousResult = (document.querySelector(".txt-segment-box")?.textContent || "").trim();
    const value = ${JSON.stringify(markdown)};
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, value);
    } else {
      editor.focus();
      editor.textContent = value;
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    window.__contentFerryChartLabels = [];
    window.__contentFerryNetworkPayloads = [];
    window.__contentFerryDetectionStartedAt = Date.now();
    if (!window.__contentFerryNetworkPatched) {
      window.__contentFerryNetworkPatched = true;
      const recordPayload = (url, body) => {
        try {
          const text = String(body || "");
          if (text && text.length <= 2_000_000) {
            window.__contentFerryNetworkPayloads.push({ url: String(url || ""), body: text, capturedAt: Date.now() });
          }
        } catch {}
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        response.clone().text().then((body) => recordPayload(args[0]?.url || args[0], body)).catch(() => {});
        return response;
      };
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this.__contentFerryUrl = url;
        return originalOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener("load", () => {
          if (typeof this.responseText === "string") recordPayload(this.__contentFerryUrl, this.responseText);
        }, { once: true });
        return originalSend.apply(this, args);
      };
    }
    if (!window.__contentFerryCanvasPatched) {
      window.__contentFerryCanvasPatched = true;
      const originalFillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...rest) {
        try {
          const value = String(text).trim();
          if (/^\\d+(?:\\.\\d+)?\\s*%$/.test(value)) {
            window.__contentFerryChartLabels.push({
              text: value,
              x,
              y,
              width: this.canvas.width,
              height: this.canvas.height,
              capturedAt: Date.now()
            });
          }
        } catch {}
        return originalFillText.call(this, text, x, y, ...rest);
      };
    }
    const buttons = [...document.querySelectorAll("button, [role='button']")].filter(visible);
    const detect = document.querySelector(".submit-btn") || buttons.find((button) => /开始检测|立即检测|检测|detect now/i.test((button.textContent || "").trim()));
    if (!detect) return { ok: false, reason: "未找到检测按钮" };
    detect.click();
    return { ok: true, previousResult };
  })()`, true) as { ok: boolean; reason?: string; previousResult?: string };

  if (!filled.ok) {
    window.focus();
    return { status: "needs_user", message: `${filled.reason ?? "网页结构发生变化"}。请在已打开的朱雀窗口中完成操作，然后回到文渡重试。` };
  }

  await delay(3500);
  let incompleteReportAttempts = 0;
  for (let attempt = 0; attempt < 58 && !window.isDestroyed(); attempt += 1) {
    await delay(2000);
    const report = await window.webContents.executeJavaScript(`(() => {
      const text = document.body?.innerText || "";
      const resultBox = document.querySelector(".txt-segment-box");
      const resultText = (resultBox?.textContent || "").trim();
      const previousResult = ${JSON.stringify(filled.previousResult ?? "")};
      if (!resultText || resultText === previousResult) return null;

      const segmentSelector = ".txt-segmentType-danger, .txt-segmentType-warning, .txt-segmentType-success";
      const segments = [...document.querySelectorAll(segmentSelector)]
        .filter((segment) => !segment.querySelector(segmentSelector))
        .map((segment) => {
          const value = (segment.textContent || "").trim();
          const kind = segment.classList.contains("txt-segmentType-success")
            ? "human"
            : segment.classList.contains("txt-segmentType-warning") ? "uncertain" : "ai";
          return { text: value, kind };
        })
        .filter((segment) => segment.text.length > 0)
        .slice(0, 500);

      let humanPercent = null;
      let uncertainPercent = null;
      let aiPercent = null;
      let ratioSource = "official";
      const percent = (value) => {
        const number = Number.parseFloat(String(value).replace("%", ""));
        return Number.isFinite(number) ? number : null;
      };
      const normalizeTriple = (values) => {
        if (!Array.isArray(values) || values.length !== 3 || values.some((value) => !Number.isFinite(value) || value < 0)) return null;
        const total = values.reduce((sum, value) => sum + value, 0);
        if (total >= .995 && total <= 1.005) return values.map((value) => value * 100);
        if (total >= 99.5 && total <= 100.5) return values;
        return null;
      };
      const applyTriple = (values) => {
        const normalized = normalizeTriple(values);
        if (!normalized) return false;
        humanPercent = normalized[0];
        uncertainPercent = normalized[1];
        aiPercent = normalized[2];
        return true;
      };
      const featureKind = (name) => {
        const normalized = String(name || "").toLowerCase().replace(/[\\s_-]+/g, "");
        if (/疑似|suspect|uncertain|maybe/.test(normalized)) return "uncertain";
        if (/人工|人类|human|manual/.test(normalized)) return "human";
        if (/ai特征|ai生成|aigc|machine|artificial/.test(normalized)) return "ai";
        return null;
      };
      const findNamedTriple = (root) => {
        const found = {};
        const visit = (value, depth = 0) => {
          if (depth > 12 || value == null || Object.keys(found).length === 3) return;
          if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
            return;
          }
          if (typeof value !== "object") return;
          const entries = Object.entries(value);
          const nameEntry = entries.find(([key]) => /name|label|type|feature|category|title/i.test(key));
          const numberEntry = entries.find(([key, item]) => /value|percent|percentage|ratio|score|rate/i.test(key) && Number.isFinite(Number(item)));
          if (nameEntry && numberEntry) {
            const kind = featureKind(nameEntry[1]);
            if (kind) found[kind] = Number(numberEntry[1]);
          }
          for (const [key, item] of entries) {
            const kind = featureKind(key);
            if (kind && Number.isFinite(Number(item))) found[kind] = Number(item);
            else visit(item, depth + 1);
          }
        };
        visit(root);
        return found.human != null && found.uncertain != null && found.ai != null
          ? normalizeTriple([found.human, found.uncertain, found.ai])
          : null;
      };

      const startedAt = window.__contentFerryDetectionStartedAt || 0;
      for (const payload of (window.__contentFerryNetworkPayloads || []).filter((item) => item.capturedAt >= startedAt).reverse()) {
        try {
          const triple = findNamedTriple(JSON.parse(payload.body));
          if (triple && applyTriple(triple)) break;
        } catch {}
      }

      const chartElements = [...document.querySelectorAll("[_echarts_instance_]")];
      for (const chartElement of chartElements) {
        if (humanPercent !== null && uncertainPercent !== null && aiPercent !== null) break;
        try {
          let echartsApi = window.echarts;
          if (!echartsApi?.getInstanceByDom) {
            for (const key of Object.getOwnPropertyNames(window)) {
              try {
                const candidate = window[key];
                if (candidate?.getInstanceByDom && candidate?.getInstanceById) {
                  echartsApi = candidate;
                  break;
                }
              } catch {}
            }
          }
          const instance = echartsApi?.getInstanceByDom?.(chartElement);
          const data = instance?.getOption?.()?.series?.flatMap((series) => series.data || []) || [];
          for (const item of data) {
            const name = String(item?.name || "");
            const value = percent(item?.value);
            if (value === null) continue;
            if (/人工特征|人类特征/.test(name)) humanPercent = value;
            else if (/疑似/.test(name)) uncertainPercent = value;
            else if (/AI特征|AI生成/.test(name)) aiPercent = value;
          }
        } catch {}
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const svgCandidates = [...document.querySelectorAll("svg")]
          .map((svg) => [...svg.querySelectorAll("text")]
            .map((node) => (node.textContent || "").trim())
            .filter((value) => /^\\d+(?:\\.\\d+)?\\s*%$/.test(value))
            .map((value) => percent(value)))
          .filter((values) => values.length >= 3);
        let svgTriple = null;
        for (const values of svgCandidates) {
          for (let index = 0; index <= values.length - 3; index += 1) {
            const candidate = normalizeTriple(values.slice(index, index + 3));
            if (candidate) {
              svgTriple = candidate;
              break;
            }
          }
          if (svgTriple) break;
        }
        if (svgTriple) applyTriple(svgTriple);
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const reportCandidates = [...document.querySelectorAll("div, section")]
          .filter((element) => {
            const value = element.textContent || "";
            return value.includes("人工特征") && value.includes("疑似AI") && value.includes("AI特征") && /\\d+(?:\\.\\d+)?\\s*%/.test(value);
          })
          .sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);
        for (const candidate of reportCandidates) {
          const values = [...candidate.querySelectorAll("*")]
            .filter((element) => element.children.length === 0)
            .map((element) => (element.textContent || "").trim())
            .filter((value) => /^\\d+(?:\\.\\d+)?\\s*%$/.test(value))
            .map((value) => percent(value));
          for (let index = 0; index <= values.length - 3; index += 1) {
            if (applyTriple(values.slice(index, index + 3))) break;
          }
          if (humanPercent !== null && uncertainPercent !== null && aiPercent !== null) break;
        }
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const captured = (window.__contentFerryChartLabels || [])
          .filter((item) => item.capturedAt >= startedAt && item.width >= 180 && item.height >= 150)
          .map((item) => ({ ...item, value: percent(item.text) }))
          .filter((item) => item.value !== null);
        const byCanvas = new Map();
        for (const item of captured) {
          const key = item.width + "x" + item.height;
          const values = byCanvas.get(key) || [];
          values.push(item);
          byCanvas.set(key, values);
        }
        const labelGroups = [...byCanvas.values()].flatMap((items) => {
          const groups = [];
          for (let index = items.length - 3; index >= 0; index -= 1) {
            const candidate = items.slice(index, index + 3);
            const total = candidate.reduce((sum, item) => sum + item.value, 0);
            if (total >= 99.5 && total <= 100.5) {
              groups.push(candidate);
              break;
            }
          }
          return groups;
        });
        const officialLabels = labelGroups
          .sort((left, right) => right[0].width * right[0].height - left[0].width * left[0].height)[0];
        if (officialLabels) {
          applyTriple(officialLabels.map((item) => item.value));
        }
      }

      if (humanPercent === null || uncertainPercent === null || aiPercent === null) {
        const characterCounts = { human: 0, uncertain: 0, ai: 0 };
        for (const segment of segments) {
          characterCounts[segment.kind] += Array.from(segment.text.replace(/\\s+/g, "")).length;
        }
        const totalCharacters = characterCounts.human + characterCounts.uncertain + characterCounts.ai;
        if (totalCharacters > 0) {
          humanPercent = characterCounts.human / totalCharacters * 100;
          uncertainPercent = characterCounts.uncertain / totalCharacters * 100;
          aiPercent = characterCounts.ai / totalCharacters * 100;
          ratioSource = "segments";
        }
      }

      const chartRoot = chartElements[0] || [...document.querySelectorAll("svg")].find((svg) => /\\d+(?:\\.\\d+)?\\s*%/.test(svg.textContent || ""));
      let reportRoot = chartRoot;
      for (let depth = 0; reportRoot && depth < 7; depth += 1) {
        const value = reportRoot.innerText || reportRoot.textContent || "";
        if (value.includes("人工特征") && value.includes("疑似AI") && value.includes("AI特征")) break;
        reportRoot = reportRoot.parentElement;
      }
      const reportLines = (reportRoot?.innerText || reportRoot?.textContent || "").split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const verdict = reportLines.find((line) => /人工创作特征|AI创作特征/.test(line) && /较强|较弱|明显|一般/.test(line))
        || reportLines.find((line) => /人工创作特征|AI创作特征/.test(line))
        || "腾讯朱雀检测已完成";
      return { verdict, humanPercent, uncertainPercent, aiPercent, ratioSource, segments };
    })()`, true) as ZhuqueReport | null;
    if (report && report.humanPercent !== null && report.uncertainPercent !== null && report.aiPercent !== null) {
      const formatPercent = (value: number | null) => value === null ? "未读取" : `${value.toFixed(2)}%`;
      const result = [
        report.verdict,
        `人工特征 ${formatPercent(report.humanPercent)} · 疑似 AI ${formatPercent(report.uncertainPercent)} · AI 特征 ${formatPercent(report.aiPercent)}${report.ratioSource === "segments" ? "（按已识别分段字数计算）" : ""}`,
        `已读取 ${report.segments.length} 个分段，原始朱雀结果窗口已保留。`
      ].join("\n");
      if (!window.isDestroyed()) {
        window.show();
        window.focus();
      }
      return { status: "completed", result, report };
    }
    if (report) {
      incompleteReportAttempts += 1;
      if (incompleteReportAttempts >= 8) {
        if (!window.isDestroyed()) {
          window.show();
          window.focus();
        }
        return {
          status: "needs_user",
          message: "朱雀正文分段已经生成，但图表的三项官方比例仍未能读取。原始结果窗口已保留，请核对页面后再次点击检测。"
        };
      }
    }
  }

  if (!window.isDestroyed()) window.focus();
  return { status: "needs_user", message: "自动填充和检测已经执行，但未能可靠读取结果。请在已打开的朱雀窗口中检查是否需要登录、验证码或其他确认。" };
}

async function getOrCreateWechatBackendWindow(): Promise<BrowserWindow> {
  if (wechatBackendWindow && !wechatBackendWindow.isDestroyed()) return wechatBackendWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · 微信公众号后台",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-wechat"
    }
  });
  wechatBackendWindow = window;
  window.on("closed", () => { if (wechatBackendWindow === window) { wechatBackendWindow = undefined; wechatBackendTarget = undefined; } });
  window.webContents.on("did-create-window", (childWindow) => {
    wechatEditorWindow = childWindow;
    logWechatBrowserAssist("editor-window-created", {
      url: childWindow.webContents.getURL(),
      hasTarget: Boolean(wechatBackendTarget)
    });
    childWindow.setMenuBarVisibility(false);
    childWindow.setMinimumSize(1100, 720);
    childWindow.maximize();
    childWindow.once("ready-to-show", () => {
      if (!childWindow.isDestroyed()) {
        childWindow.maximize();
        childWindow.show();
        childWindow.focus();
      }
    });
    childWindow.on("closed", () => {
      if (wechatEditorWindow === childWindow) wechatEditorWindow = undefined;
    });
    childWindow.webContents.on("did-finish-load", () => {
      logWechatBrowserAssist("editor-window-loaded", { url: childWindow.webContents.getURL() });
      void driveWechatEditorSettings(childWindow, wechatBackendTarget);
    });
    childWindow.webContents.on("dom-ready", () => {
      logWechatBrowserAssist("editor-window-dom-ready", { url: childWindow.webContents.getURL() });
      void driveWechatEditorSettings(childWindow, wechatBackendTarget);
    });
    childWindow.webContents.on("console-message", (_event, _level, message) => {
      const prefix = "__contentferry_wechat_collections__:";
      if (!message.startsWith(prefix)) return;
      try {
        const payload = JSON.parse(message.slice(prefix.length)) as { accountId?: unknown; names?: unknown };
        if (typeof payload.accountId === "string") saveObservedWechatCollections(payload.accountId, payload.names);
      } catch (error) {
        logWechatBrowserAssist("collections-observation-invalid", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    childWindow.show();
    childWindow.focus();
  });
  window.webContents.on("did-finish-load", () => { void driveWechatBackendToDrafts(window, wechatBackendTarget); });
  await window.loadURL("https://mp.weixin.qq.com/");
  return window;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSDN 受控浏览器发布（FR-15.3）：登录预检、表单填充、用户最终确认后单次提交、远端回读。
// 与微信一致，状态落库全部在 create-server 路由；这里只驱动可见浏览器并回写结果。
// ─────────────────────────────────────────────────────────────────────────────
const CSDN_API_BASE = "http://127.0.0.1:4317";
const CSDN_EDITOR_URL = "https://editor.csdn.net/md/";
let csdnWindow: BrowserWindow | undefined;

function logCsdnBrowserAssist(step: string, details: Record<string, unknown> = {}): void {
  runtimeInfoLogger?.({ scope: "csdn-browser-assist", step, ...details }, "CSDN 浏览器辅助");
}

async function getOrCreateCsdnWindow(): Promise<BrowserWindow> {
  if (csdnWindow && !csdnWindow.isDestroyed()) return csdnWindow;
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: true,
    title: "文渡 · CSDN 编辑器",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 账号隔离且持久：登录态在本机会话中保留，符合 FR-15.3 的“持久且账号隔离的可见浏览器会话”。
      partition: "persist:contentferry-csdn"
    }
  });
  csdnWindow = window;
  window.on("closed", () => { if (csdnWindow === window) csdnWindow = undefined; });
  await window.loadURL(CSDN_EDITOR_URL);
  return window;
}

function showCsdnAssistStatus(window: BrowserWindow, lines: string[]): void {
  if (window.isDestroyed()) return;
  const text = lines.join("\n");
  const safe = JSON.stringify(text);
  void window.webContents.executeJavaScript(`(function(){
    var panel = document.getElementById('contentferry-csdn-assist-status');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'contentferry-csdn-assist-status';
      panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;white-space:pre-line;cursor:move;user-select:none;';
      document.body.appendChild(panel);
      var dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      panel.addEventListener('mousedown', function(e){ dragging = true; var r = panel.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top; panel.style.left = sl + 'px'; panel.style.top = st + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; e.preventDefault(); });
      document.addEventListener('mousemove', function(e){ if(!dragging) return; var nl = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth)); var nt = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight)); panel.style.left = nl + 'px'; panel.style.top = nt + 'px'; });
      document.addEventListener('mouseup', function(){ dragging = false; });
    }
    panel.textContent = ${safe};
  })()`).catch(() => undefined);
}

async function waitForCsdnEditor(window: BrowserWindow, timeoutMs = 15_000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (window.isDestroyed()) return false;
    const ready = await window.webContents.executeJavaScript(`(function(){
      return document.readyState === 'complete' && (document.querySelector('input.title, #title, input[placeholder*="标题"]') || document.querySelector('.CodeMirror') || document.querySelector('[contenteditable="true"]')) != null;
    })()`).catch(() => false);
    if (ready) return true;
    await delay(400);
  }
  return false;
}

async function persistCsdnFill(jobId: string, body: unknown): Promise<void> {
  try {
    await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}/fill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    logCsdnBrowserAssist("fill-persist-failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function driveCsdnBrowserPublish(jobId: string): Promise<void> {
  let window: BrowserWindow;
  try {
    window = await getOrCreateCsdnWindow();
  } catch (error) {
    logCsdnBrowserAssist("window-create-failed", { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  window.show();
  window.focus();
  let draft: { title: string; markdown: string; author: string; digest: string };
  try {
    const response = await fetch(`${CSDN_API_BASE}/api/integrations/csdn/jobs/${jobId}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { draft: { title: string; markdown: string; author: string; digest: string } };
    draft = payload.draft;
  } catch (error) {
    logCsdnBrowserAssist("fetch-draft-failed", { error: error instanceof Error ? error.message : String(error) });
    showCsdnAssistStatus(window, ["无法读取 CSDN 渠道稿内容，请稍后重试或刷新页面。"]);
    return;
  }

  const ready = await waitForCsdnEditor(window);
  if (!ready) {
    logCsdnBrowserAssist("editor-not-ready", {});
    showCsdnAssistStatus(window, ["CSDN 编辑器加载超时。", "请确认浏览器已打开 CSDN 编辑器；若未登录请先登录，再重新发起。"]);
    return;
  }

  // 登录预检：未登录时 CSDN 会跳转 passport 或显示登录入口。
  const loginState = await window.webContents.executeJavaScript(`(function(){
    var u = (location.href || '').toLowerCase();
    if (u.indexOf('passport.csdn.net') >= 0 || /\\/login/.test(u)) return 'login';
    var loginEl = document.querySelector('a[href*="passport"], .login_box, #csdn-login, [class*="loginBtn"], [class*="login-btn"]');
    if (loginEl && /登录/.test(loginEl.textContent || '')) return 'login';
    return 'ok';
  })()`).catch(() => "ok");
  if (loginState === "login") {
    logCsdnBrowserAssist("needs-login", {});
    await persistCsdnFill(jobId, { verifiedFields: [], state: "needs_login", reason: "CSDN 编辑器未登录，请先在浏览器登录后再发起发布。" });
    showCsdnAssistStatus(window, ["CSDN 编辑器尚未登录。", "请在打开的浏览器中登录 CSDN，然后回到文渡重新点击“在浏览器中完成发布”。"]);
    return;
  }

  // 填充标题与正文（Markdown）。CSDN 编辑器为 CodeMirror；若取不到实例则退回 execCommand/粘贴兜底。
  const fillArgs = JSON.stringify({ title: draft.title, markdown: draft.markdown });
  const fill = await window.webContents.executeJavaScript(`(function(args){
    var title = args.title, markdown = args.markdown;
    var result = { title: false, content: false };
    function setValue(el, value){
      try {
        var proto = Object.getPrototypeOf(el);
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }
      } catch (e) { el.value = value; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    var titleEl = document.querySelector('input.title') || document.querySelector('input[placeholder*="标题"]') || document.querySelector('#title');
    if (titleEl) { setValue(titleEl, title); result.title = (titleEl.value || '').length > 0; }
    var cm = document.querySelector('.CodeMirror');
    if (cm && cm.CodeMirror) { cm.CodeMirror.setValue(markdown); result.content = (cm.CodeMirror.getValue() || '').length > 0; }
    else {
      var ed = document.querySelector('[contenteditable="true"]') || document.querySelector('.editor');
      if (ed) { ed.focus(); try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, markdown); } catch (e) {} result.content = (ed.innerText || '').length > 0; }
    }
    return result;
  })(${fillArgs})`, false).catch((error: unknown) => {
    logCsdnBrowserAssist("fill-execute-failed", { error: error instanceof Error ? error.message : String(error) });
    return { title: false, content: false };
  });

  const verifiedFields: string[] = [];
  if (fill.title) verifiedFields.push("title");
  if (fill.content) verifiedFields.push("content");
  logCsdnBrowserAssist("filled", { title: fill.title, content: fill.content });

  if (!fill.title || !fill.content) {
    await persistCsdnFill(jobId, {
      verifiedFields,
      state: fill.title || fill.content ? "needs_user" : "failed_before_submit",
      reason: "未能可靠填充标题或正文；请在浏览器中手动补齐，再回到文渡点击“我已在 CSDN 发布”。"
    });
    showCsdnAssistStatus(window, [
      "已打开 CSDN 编辑器，但标题或正文未能自动填充。",
      "请在浏览器中手动补齐内容；确认无误后，回到文渡点击“我已在 CSDN 发布”。"
    ]);
    return;
  }

  await persistCsdnFill(jobId, { verifiedFields: ["title", "content"], state: "ready_for_final_confirmation" });
  showCsdnAssistStatus(window, [
    "已填充标题与正文。",
    "请在浏览器中核对内容、摘要、标签与封面。",
    "确认无误后，回到文渡点击“我已在 CSDN 发布”，文渡会点击 CSDN 的“发布文章”并读取回执。"
  ]);
}

async function confirmCsdnBrowserPublish(jobId: string): Promise<{ remoteUrl: string | null; remoteContentId: string | null } | null> {
  const window = csdnWindow;
  if (!window || window.isDestroyed()) {
    logCsdnBrowserAssist("confirm-window-missing", { jobId });
    return null;
  }
  window.show();
  window.focus();
  showCsdnAssistStatus(window, ["正在点击 CSDN 的“发布文章”按钮……", "若页面要求二次确认，请在浏览器中完成。"]);
  const clicked = await window.webContents.executeJavaScript(`(function(){
    var buttons = Array.prototype.slice.call(document.querySelectorAll('button, .btn, a.btn'));
    var target = buttons.find(function(b){ return /发布文章|发布$/.test((b.textContent || '').trim()); });
    if (!target) return false;
    target.click();
    return true;
  })()`).catch(() => false);
  if (!clicked) {
    logCsdnBrowserAssist("publish-button-not-found", { jobId });
    showCsdnAssistStatus(window, ["未找到 CSDN 的“发布文章”按钮。", "请在浏览器中手动点击发布；发布成功后回到文渡点击“我已在 CSDN 发布”。"]);
    return null;
  }

  // 等待发布完成并读取文章链接（CSDN 成功后会弹出含 blog.csdn.net 详情链接的提示）。
  const startedAt = Date.now();
  let remoteUrl: string | null = null;
  while (Date.now() - startedAt < 20_000) {
    if (window.isDestroyed()) return null;
    const found = await window.webContents.executeJavaScript(`(function(){
      var u = location.href || '';
      var detailsMatch = u.match(/blog\\.csdn\\.net\\/[^\\/]+\\/article\\/details\\/(\\d+)/);
      if (detailsMatch) return location.href;
      var links = Array.prototype.slice.call(document.querySelectorAll('a[href*="article/details/"]'));
      for (var i = 0; i < links.length; i++) {
        var href = links[i].href || '';
        if (/article\\/details\\/\\d+/.test(href)) return href;
      }
      return '';
    })()`).catch(() => "");
    if (found) { remoteUrl = found; break; }
    await delay(800);
  }

  if (!remoteUrl) {
    logCsdnBrowserAssist("receipt-not-read", { jobId });
    showCsdnAssistStatus(window, ["已尝试点击发布，但未能自动读取 CSDN 文章链接。", "请在浏览器确认发布结果；如已发布，可人工校正并粘贴链接。"]);
    return null;
  }
  const contentIdMatch = /article\/details\/(\d+)/.exec(remoteUrl);
  const remoteContentId = contentIdMatch ? contentIdMatch[1] : null;
  logCsdnBrowserAssist("receipt-read", { remoteUrl, remoteContentId });
  showCsdnAssistStatus(window, ["已在 CSDN 发布，已回写文章链接：", remoteUrl]);
  return { remoteUrl, remoteContentId };
}

async function driveWechatEditorSettings(window: BrowserWindow, target?: WechatBackendTarget): Promise<void> {
  if (window.isDestroyed() || !target) {
    logWechatBrowserAssist("editor-driver-skipped", {
      windowDestroyed: window.isDestroyed(),
      hasTarget: Boolean(target)
    });
    return;
  }
  logWechatBrowserAssist("editor-driver-started", {
    url: window.webContents.getURL(),
    declareOriginal: target.declareOriginal,
    enableReward: target.enableReward,
    hasCollection: Boolean(target.collectionName)
  });
  const editorTarget = {
    ...target,
    title: "",
    draftOpened: true,
    settingsScrolled: false
  };
  try {
    await window.webContents.executeJavaScript(`(() => {
      const incomingTarget = ${JSON.stringify(editorTarget)};
      window.__contentFerryWechatDraftTarget = incomingTarget;
      try {
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(incomingTarget));
      } catch {}
      if (window.__contentFerryWechatEditorDriver) return;
      window.__contentFerryWechatEditorDriver = true;

      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
      };
      const normalizedText = (element) => (element?.textContent || "").replace(/\\s+/g, "").trim();
      const clickableNodes = () => [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span")]
        .filter(visible);
      const clickVisibleDialogConfirm = (keywords) => {
        const candidates = clickableNodes()
          .filter((node) => normalizedText(node) === "确定")
          .map((node) => node.closest("a, button, [role='button']") || node)
          .filter((node) => {
            if (node instanceof HTMLButtonElement && node.disabled) return false;
            if (node.getAttribute("aria-disabled") === "true") return false;
            const dialog = node.closest(
              ".weui-desktop-dialog, .weui-desktop-dialog__wrp, .weui-desktop-popover, [role='dialog'], [class*='dialog' i], [class*='modal' i]"
            );
            if (!dialog || !visible(dialog)) return false;
            const dialogText = normalizedText(dialog);
            return keywords.some((keyword) => dialogText.includes(keyword));
          });
        const uniqueCandidates = [...new Set(candidates)];
        if (uniqueCandidates.length !== 1) return false;
        const confirm = uniqueCandidates[0];
        confirm.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        confirm.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        confirm.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      };
      const prepareOriginalDialog = () => {
        // The dialog title also contains a nested help popover. Its textContent
        // therefore includes the hidden help copy and is not exactly “原创”.
        // The editor box is a stable, unique anchor in the actual in-page modal.
        const originalEditor = document.getElementById("js_original_edit_box");
        const dialog = originalEditor?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return { status: "missing" };
        const textOriginal = dialog.querySelector(
          "#js_original_edit_box input.js_original_type_radio[value='0']"
        );
        if (textOriginal instanceof HTMLInputElement && !textOriginal.checked) {
          textOriginal.click();
        }
        const authorInput = [...dialog.querySelectorAll("#js_original_edit_box input.js_author")]
          .find((input) => visible(input));
        const author = authorInput instanceof HTMLInputElement ? authorInput.value.trim() : "";
        const agreement = dialog.querySelector(".original_agreement input.weui-desktop-form__checkbox");
        if (agreement instanceof HTMLInputElement && !agreement.checked) {
          agreement.click();
        }
        const ready = textOriginal instanceof HTMLInputElement
          && textOriginal.checked
          && author.length > 0
          && author.length <= 8
          && agreement instanceof HTMLInputElement
          && agreement.checked;
        return {
          status: ready ? "ready" : "incomplete",
          authorLength: author.length,
          typeSelected: textOriginal instanceof HTMLInputElement && textOriginal.checked,
          agreementChecked: agreement instanceof HTMLInputElement && agreement.checked
        };
      };
      const prepareRewardDialog = () => {
        // Keep the anchor inside the in-page modal. Unlike a title lookup, this
        // survives WeChat adding icon/help nodes around the dialog heading.
        const rewardBody = document.querySelector(".reward-setting-dialog__body");
        const dialog = rewardBody?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return { status: "missing" };

        const rewardAuthor = dialog.querySelector("input.weui-desktop-form__radio[value='1']");
        if (rewardAuthor instanceof HTMLInputElement && !rewardAuthor.checked) rewardAuthor.click();

        const accountInput = dialog.querySelector("input.weui-desktop-form__input[placeholder*='赞赏账户']");
        const recentAccounts = [...dialog.querySelectorAll(".recent-select > div")].filter(visible);
        if (accountInput instanceof HTMLInputElement && !accountInput.value.trim() && recentAccounts.length === 1) {
          recentAccounts[0].click();
        }

        const agreement = dialog.querySelector(".agreement-check-btn__wrp input.weui-desktop-form__checkbox");
        if (agreement instanceof HTMLInputElement && !agreement.checked) agreement.click();

        const accountSelected = accountInput instanceof HTMLInputElement && accountInput.value.trim().length > 0;
        const ready = rewardAuthor instanceof HTMLInputElement
          && rewardAuthor.checked
          && accountSelected
          && agreement instanceof HTMLInputElement
          && agreement.checked;
        return {
          status: ready ? "ready" : "incomplete",
          accountSelected,
          recentAccountCount: recentAccounts.length,
          agreementChecked: agreement instanceof HTMLInputElement && agreement.checked
        };
      };
      const prepareCollectionDialog = (collectionName, queryStage) => {
        const setting = document.querySelector(".weui-desktop-dialog .setting-con");
        const dialog = setting?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return { status: "missing" };
        const input = dialog.querySelector(".setting-select input.weui-desktop-form__input");
        if (!(input instanceof HTMLInputElement)) return { status: "missing-input" };
        const reportOptions = () => {
          const optionsContainer = dialog.querySelector(".select-opts-con");
          // WeChat renders collection records into select-opt-li nodes before
          // the menu opens. Its parent may still be display:none, so DOM
          // visibility is not a validity test for those data records.
          const optionNodes = optionsContainer?.querySelectorAll("li.select-opt-li") || [];
          const names = [...optionNodes]
            .map((node) => (node.textContent || "").replace(/\\s+/g, " ").trim())
            .filter((name) => name.length > 0 && name.length <= 80);
          const uniqueNames = [...new Set(names)];
          if (incomingTarget.accountId && uniqueNames.length > 0) {
            console.info("__contentferry_wechat_collections__:" + JSON.stringify({
              accountId: incomingTarget.accountId,
              names: uniqueNames
            }));
          }
          return uniqueNames;
        };
        if (queryStage !== "options-opened") {
          input.focus();
          input.click();
          // Do not type the requested name until the picker has had a chance
          // to render its unfiltered list. Otherwise WeChat only exposes the
          // one filtered result and the per-account cache can never become a
          // useful list of existing collections.
          window.setTimeout(reportOptions, 350);
          return { status: "options-opening" };
        }
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, collectionName);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: collectionName }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter" }));
        const wanted = String(collectionName).replace(/\\s+/g, "");
        const optionCandidates = [...dialog.querySelectorAll(".select-opts-con li.select-opt-li")]
          .filter((node) => normalizedText(node) === wanted);
        const options = [...new Set(optionCandidates.map((node) =>
          node.closest("[role='option'], li, button, a, [class*='select-opt'], [class*='select-item']") || node
        ))];
        if (options.length === 1) {
          options[0].click();
          return { status: "selected" };
        }
        return { status: options.length > 1 ? "ambiguous" : "waiting-option" };
      };
      const clickCollectionConfirm = () => {
        const setting = document.querySelector(".weui-desktop-dialog .setting-con");
        const dialog = setting?.closest(".weui-desktop-dialog");
        if (!dialog || !visible(dialog)) return false;
        const confirms = [...dialog.querySelectorAll("button.weui-desktop-btn_primary")]
          .filter(visible)
          .filter((button) => normalizedText(button) === "确认")
          .filter((button) => !(button instanceof HTMLButtonElement) || !button.disabled);
        if (confirms.length !== 1) return false;
        confirms[0].click();
        return true;
      };
      const persist = (value) => {
        window.__contentFerryWechatDraftTarget = value;
        try {
          sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(value));
        } catch {}
      };
      const showAssistStatus = (lines) => {
        let panel = document.getElementById("contentferry-wechat-assist-status");
        if (!panel) {
          panel = document.createElement("div");
          panel.id = "contentferry-wechat-assist-status";
          panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;white-space:pre-line;cursor:move;user-select:none;";
          document.body.appendChild(panel);
          let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
          panel.addEventListener("mousedown", (e) => {
            dragging = true;
            const r = panel.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
            panel.style.left = sl + "px"; panel.style.top = st + "px";
            panel.style.right = "auto"; panel.style.bottom = "auto";
            e.preventDefault();
          });
          document.addEventListener("mousemove", (e) => {
            if (!dragging) return;
            const nl = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth));
            const nt = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight));
            panel.style.left = nl + "px"; panel.style.top = nt + "px";
          });
          document.addEventListener("mouseup", () => { dragging = false; });
        }
        panel.textContent = lines.join("\\n");
      };
      const scrollToSettings = () => {
        const target = window.__contentFerryWechatDraftTarget;
        const settingsShortcut = [...document.querySelectorAll(
          ".js_fold.fold_tips_scrolltop .tool_bar__fold-btn, .fold_tips_scrolltop a[data-type='1']"
        )].find((element) => normalizedText(element) === "文章设置");
        if (settingsShortcut && !target?.settingsShortcutClicked) {
          settingsShortcut.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          target.settingsShortcutClicked = true;
          persist(target);
          return "shortcut";
        }

        const editor = document.querySelector(".appmsg_editor, .appmsg_editor_inner, #appmsg_content");
        const settingsArea = document.querySelector("#article_setting_area");
        const settingsAnchor = document.querySelector("#js_original_box")
          || document.querySelector("#article_setting_area2")
          || document.querySelector("#js_article_tags_area");
        if (!editor || !settingsArea || !settingsAnchor) return "waiting";

        const scrollContainers = [];
        let parent = settingsAnchor.parentElement;
        while (parent) {
          const style = getComputedStyle(parent);
          const canScroll = parent.scrollHeight > parent.clientHeight + 8
            && /(auto|scroll|overlay)/i.test(style.overflowY + style.overflow);
          if (canScroll) scrollContainers.push(parent);
          parent = parent.parentElement;
        }
        const rootScroller = document.scrollingElement;
        if (rootScroller && !scrollContainers.includes(rootScroller)) scrollContainers.push(rootScroller);

        settingsAnchor.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
        for (const container of scrollContainers) {
          const anchorRect = settingsAnchor.getBoundingClientRect();
          const containerRect = container === rootScroller
            ? { top: 0, height: window.innerHeight }
            : container.getBoundingClientRect();
          const topPadding = container === rootScroller ? 72 : 24;
          const desiredTop = container.scrollTop + anchorRect.top - containerRect.top - topPadding;
          container.scrollTop = Math.max(0, Math.min(
            container.scrollHeight - container.clientHeight,
            desiredTop
          ));
          container.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        window.scrollTo({
          top: Math.max(0, window.scrollY + settingsAnchor.getBoundingClientRect().top - 72),
          behavior: "auto"
        });
        settingsAnchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        return "ready";
      };
      const applyRequestedSettings = () => {
        const target = window.__contentFerryWechatDraftTarget;
        if (!target?.draftOpened) return;
        const requested = target.declareOriginal || target.enableReward || Boolean(target.collectionName);
        if (!requested) {
          showAssistStatus([
            "已打开目标草稿，但这条草稿任务没有保存原创、赞赏或合集设置。",
            "文渡不会在未获得明确设置时自动操作。请重新设置并同步草稿后再试。"
          ]);
          return;
        }
        if (!target.settingsScrolled) {
          const navigationResult = scrollToSettings();
          if (navigationResult === "waiting") {
            showAssistStatus(["已打开目标草稿，正在等待微信编辑器设置区加载……"]);
            return;
          }
          if (navigationResult === "shortcut") {
            showAssistStatus(["已点击微信编辑器的“文章设置”。", "正在等待页面定位到原创、赞赏和合集区域……"]);
            window.setTimeout(applyRequestedSettings, 500);
            return;
          }
          target.settingsScrolled = true;
          persist(target);
          showAssistStatus(["已定位到文章设置区域。", "正在处理原创、赞赏和合集设置……"]);
          window.setTimeout(applyRequestedSettings, 500);
          return;
        }

        const notes = ["文渡已打开目标草稿。"];
        if (target.declareOriginal) {
          const originalOpen = document.querySelector("#js_original_open");
          if (originalOpen && visible(originalOpen)) {
            target.originalResult = "already";
            notes.push("原创：微信页面已显示为已声明。");
          } else if (!target.originalDialogOpened) {
            const originalEntry = document.querySelector("#js_original .js_original_apply.js_edit_ori");
            if (originalEntry) {
              originalEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
              originalEntry.click();
              target.originalDialogOpened = true;
              notes.push("原创：已打开声明设置，请确认微信要求的信息。");
            } else {
              notes.push("原创：尚未找到声明入口，请在微信页面确认。");
            }
          } else if (!target.originalConfirmClicked) {
            const originalDialog = prepareOriginalDialog();
            if (originalDialog.status === "ready" && clickVisibleDialogConfirm(["原创"])) {
              target.originalConfirmClicked = true;
              notes.push("原创：已选择文字原创、勾选协议并自动确认，正在等待微信保存结果。");
            } else if (originalDialog.status === "incomplete") {
              notes.push(originalDialog.authorLength === 0
                ? "原创：请填写作者，文渡已选择文字原创并勾选协议。"
                : originalDialog.authorLength > 8
                  ? "原创：作者超过微信要求的 8 个字，请修改后继续。"
                  : "原创：正在等待微信更新表单状态……");
            } else {
              notes.push("原创：正在等待原创设置弹窗加载……");
            }
          } else {
            notes.push("原创：声明设置已打开；如“确定”不可用，请补充微信要求的信息。");
          }
        }
        if (target.declareOriginal && target.originalResult !== "already") {
          persist(target);
          showAssistStatus(notes);
          return;
        }

        if (target.enableReward) {
          const rewardArea = document.querySelector("#js_reward_setting_area");
          const rewardCheckbox = rewardArea?.querySelector(".js_reward_setting_checkbox");
          if (rewardCheckbox instanceof HTMLInputElement && rewardCheckbox.checked) {
            target.rewardResult = "already";
            notes.push("赞赏：微信页面已显示为开启。");
          } else if (rewardArea && visible(rewardArea) && !target.rewardDialogOpened) {
            const rewardEntry = rewardArea.querySelector(".js_reward_open");
            if (rewardEntry) {
              rewardEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
              rewardEntry.click();
              target.rewardDialogOpened = true;
              notes.push("赞赏：已打开设置，请选择赞赏账户。");
            }
          } else if (target.rewardDialogOpened && !target.rewardConfirmClicked) {
            const rewardDialog = prepareRewardDialog();
            if (rewardDialog.status === "ready" && clickVisibleDialogConfirm(["赞赏"])) {
              target.rewardConfirmClicked = true;
              notes.push("赞赏：已选择赞赏作者、账户并勾选协议，正在自动确认。");
            } else if (rewardDialog.status === "incomplete") {
              notes.push(rewardDialog.recentAccountCount === 0
                ? "赞赏：请先选择或搜索赞赏账户，文渡已选择赞赏作者并勾选协议。"
                : rewardDialog.recentAccountCount > 1
                  ? "赞赏：有多个最近使用账户，请手工选择后继续。"
                  : "赞赏：正在等待微信更新账户选择状态……");
            } else {
              notes.push("赞赏：正在等待赞赏设置弹窗加载……");
            }
          } else {
            notes.push("赞赏：需先完成原创声明，或等待微信开放入口。");
          }
        }
        if (target.enableReward && target.rewardResult !== "already") {
          persist(target);
          showAssistStatus(notes);
          return;
        }

        if (target.collectionName) {
          if (!target.collectionDialogOpened) {
            const collectionEntry = document.querySelector("#js_article_tags_area .js_article_tags_label");
            if (collectionEntry) {
              collectionEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
              collectionEntry.click();
              target.collectionDialogOpened = true;
            }
          }
          if (!target.collectionSelectionClicked) {
            const collection = prepareCollectionDialog(target.collectionName, target.collectionQueryStage);
            if (collection.status === "options-opening") {
              target.collectionQueryStage = "options-opened";
              notes.push("鍚堥泦锛氭鍦ㄨ鍙栧井淇″悎闆嗗垪琛紝绋嶅悗灏嗚嚜鍔ㄥ尮閰嶅悕绉般€?");
            } else if (collection.status === "filtering") {
              target.collectionQueryApplied = true;
              notes.push("合集：已输入名称，正在等待微信筛选结果。");
            } else if (collection.status === "selected") {
              target.collectionSelectionClicked = true;
            } else if (collection.status === "ambiguous") {
              notes.push("合集：匹配到多个同名项，请在微信弹窗中手工选择。");
            } else if (collection.status === "waiting-option") {
              notes.push("合集：微信尚未返回匹配项，请稍候或手工选择。");
            } else {
              notes.push("合集：正在等待合集选择弹窗加载。");
            }
          }
          if (target.collectionSelectionClicked && !target.collectionConfirmClicked
            && clickCollectionConfirm()) {
            target.collectionConfirmClicked = true;
            target.collectionResult = "selected";
          }
          notes.push(target.collectionResult === "selected"
            ? "合集：已选择「" + target.collectionName + "」。"
            : "合集：请确认选择「" + target.collectionName + "」。");
        }
        notes.push("请最后预览内容，并由你在微信后台点击发布。");
        persist(target);
        showAssistStatus(notes);
      };
      const tick = () => applyRequestedSettings();
      window.setTimeout(tick, 400);
      window.setInterval(tick, 1000);
      new MutationObserver(() => window.setTimeout(tick, 80))
        .observe(document.documentElement, { childList: true, subtree: true });
    })()`, true);
    const diagnostics = await window.webContents.executeJavaScript(`(() => {
      const target = window.__contentFerryWechatDraftTarget;
      const shortcut = document.querySelector(".js_fold.fold_tips_scrolltop .tool_bar__fold-btn, .fold_tips_scrolltop a[data-type='1']");
      const settingsArea = document.querySelector("#article_setting_area");
      const originalArea = document.querySelector("#js_original_box");
      return {
        url: location.href,
        title: document.title,
        requestedSettings: Boolean(target?.declareOriginal || target?.enableReward || target?.collectionName),
        declareOriginal: target?.declareOriginal === true,
        enableReward: target?.enableReward === true,
        hasCollection: Boolean(target?.collectionName),
        shortcutFound: Boolean(shortcut),
        shortcutText: (shortcut?.textContent || "").replace(/\\s+/g, "").slice(0, 80),
        settingsAreaFound: Boolean(settingsArea),
        originalAreaFound: Boolean(originalArea),
        scrollY: Math.round(window.scrollY),
        documentScrollTop: Math.round(document.scrollingElement?.scrollTop || 0)
      };
    })()`, true) as Record<string, unknown>;
    logWechatBrowserAssist("editor-dom-diagnostics", diagnostics);
  } catch (error) {
    // 微信编辑页可能仍处于导航中；dom-ready / did-finish-load 会再次触发。
    logWechatBrowserAssist("editor-driver-injection-failed", {
      url: window.isDestroyed() ? "" : window.webContents.getURL(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function driveWechatBackendToDrafts(window: BrowserWindow, target?: WechatBackendTarget): Promise<void> {
  if (window.isDestroyed()) return;
  if (target !== undefined) {
    await window.webContents.executeJavaScript(`(() => {
      const fallback = ${JSON.stringify(target)};
      try {
        const saved = sessionStorage.getItem("contentferry-wechat-draft-target");
        window.__contentFerryWechatDraftTarget = saved ? JSON.parse(saved) : fallback;
      } catch { window.__contentFerryWechatDraftTarget = fallback; }
    })()`, true);
  }
  await window.webContents.executeJavaScript(`(() => {
    if (window.__contentFerryWechatDraftDriver) return;
    window.__contentFerryWechatDraftDriver = true;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
    };
    const normalizedText = (element) => (element.textContent || "").replace(/\\s+/g, "").trim();
    const clickableNodes = () => [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span")].filter(visible);
    const findText = (patterns) => clickableNodes().find((item) => patterns.some((pattern) => pattern.test(normalizedText(item))));
    const clickText = (patterns) => {
      const node = findText(patterns);
      if (!node) return false;
      // 微信后台的侧栏在不同版本中可能把可点击行为绑定在 span、div、a 或 li 上。
      // 优先选择真实可交互祖先；没有时直接触发当前文字节点，避免只点到无行为的容器。
      const target = node.closest("a, button, [role='button'], [role='link']") || node;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    };
    let contentManagementOpened = false;
    const isDraftsPage = () => {
      if (/\\/cgi-bin\\/appmsg|action=(?:list|list_ex).*appmsg/i.test(location.href)) return true;
      return [...document.querySelectorAll("h1, h2, h3, [class*='page_title' i], [class*='main_hd' i]")]
        .filter(visible)
        .some((node) => /^草稿箱(?:\\(\\d+\\))?$/.test(normalizedText(node)));
    };
    const isExpanded = (node) => {
      const target = node.closest("a, button, [role='button'], [role='link'], li") || node;
      const classes = String(target.className || "") + " " + String(target.parentElement?.className || "");
      return target.getAttribute("aria-expanded") === "true" || /active|selected|current|open|expanded/i.test(classes);
    };
    const openDrafts = () => {
      // 已展开的微信菜单通常带有草稿箱的真实链接。直接使用该链接能避开不同
      // 后台版本对二级菜单 click 事件和数量徽标的差异。
      const directLink = [...document.querySelectorAll("a[href]")].find((item) => {
        const href = item.getAttribute("href") || "";
        return /草稿箱/.test(normalizedText(item)) && href && !/^javascript:/i.test(href);
      });
      if (directLink) {
        location.assign(directLink.href);
        return true;
      }
      return clickText([/^草稿箱.*$/, /^草稿.*$/]);
    };
    const openTargetDraft = () => {
      const draftTarget = window.__contentFerryWechatDraftTarget;
      const title = String(draftTarget?.title || "").replace(/\\s+/g, "").trim();
      if (!title) return false;
      const shortenedTitle = (value) => value.replace(/(?:…|\.\.\.)$/, "");
      const titleMatches = (value) => value === title || (shortenedTitle(value).length >= 12 && title.startsWith(shortenedTitle(value))) || (value.includes(title) && value.length <= title.length + 32);
      const exactTitleLinks = [...document.querySelectorAll("a.weui-desktop-publish__cover__title")]
        .filter(visible).filter((item) => titleMatches(normalizedText(item)) || titleMatches(String(item.getAttribute("title") || "").replace(/\s+/g, "").trim()));
      const titleNodes = exactTitleLinks.length > 0 ? exactTitleLinks : [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span, div, p, h1, h2, h3")]
        .filter(visible).filter((item) => {
          const value = normalizedText(item);
          return titleMatches(value) || titleMatches(String(item.getAttribute("title") || "").replace(/\s+/g, "").trim());
        });
      const findDraftCard = (item) => {
        const titleLink = item.closest("a.weui-desktop-publish__cover__title") || item.closest("a") || item;
        const exactCard = titleLink.closest(".weui-desktop-card__inner");
        if (exactCard) return exactCard;
        const ancestors = [];
        let current = titleLink.parentElement;
        for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
          ancestors.push(current);
          current = current.parentElement;
        }
        const withActions = ancestors.find((node) => node.querySelector(
          "[class*='action' i], [class*='operate' i], [class*='toolbar' i], [class*='tool_bar' i], button, [role='button']"
        ));
        if (withActions) return withActions;
        return ancestors.find((node) => /(?:^|\\s)weui-desktop-(?:card|publish)(?:\\s|$)|publish__(?:item|card)/i.test(String(node.className || "")))
          || ancestors.find((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width > 280 && rect.height > 100;
          })
          || titleLink.parentElement;
      };
      const cards = [...new Set(titleNodes.map(findDraftCard).filter(Boolean))];
      if (cards.length !== 1) {
        showAssistStatus(["已进入微信草稿箱，但未能唯一识别目标草稿。", "请确认标题没有重复，或手动打开目标草稿后继续。"]);
        return false;
      }
      const card = cards[0];
      card.scrollIntoView({ block: "center", inline: "nearest" });
      const exactEditWrapper = [...card.querySelectorAll(".weui-desktop-card__action .weui-desktop-tooltip__wrp")]
        .find((wrapper) => normalizedText(wrapper.querySelector(".weui-desktop-tooltip") || wrapper) === "编辑");
      const exactEdit = exactEditWrapper?.querySelector("a.weui-desktop-icon-btn");
      if (exactEdit) {
        exactEdit.click();
        window.__contentFerryWechatDraftTarget = { ...draftTarget, title: "", draftOpened: true };
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(window.__contentFerryWechatDraftTarget));
        return true;
      }
      card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
      card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      card.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
      const editCandidates = [...card.querySelectorAll("button, a, [role='button'], [role='link'], [title], [aria-label], i, span, div")]
        .filter(visible)
        .filter((item) => {
          const description = [item.textContent, item.getAttribute("title"), item.getAttribute("aria-label"), item.getAttribute("data-tooltip"), item.getAttribute("data-title"), item.className]
            .filter((value) => typeof value === "string").join(" ");
          return /编辑/.test(description) || /(?:^|[-_])edit(?:[-_]|$)/i.test(String(item.className || ""));
        })
        .map((item) => item.closest("a, button, [role='button'], [role='link']") || item);
      const editButtons = [...new Set(editCandidates)];
      if (editButtons.length !== 1) {
        showAssistStatus(["已定位目标草稿并展开操作按钮。", "未能可靠识别“编辑”按钮，请点击该草稿卡片右上方的编辑图标后继续。"]);
        return false;
      }
      const edit = editButtons[0];
      edit.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      edit.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      edit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      window.__contentFerryWechatDraftTarget = { ...draftTarget, title: "", draftOpened: true };
      sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(window.__contentFerryWechatDraftTarget));
      return true;
    };
    const showAssistStatus = (lines) => {
      let panel = document.getElementById("contentferry-wechat-assist-status");
      if (!panel) {
        panel = document.createElement("div");
        panel.id = "contentferry-wechat-assist-status";
        panel.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:360px;padding:12px 14px;background:rgba(23,32,51,.82);color:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font-size:13px;line-height:1.6;cursor:move;user-select:none;";
        document.body.appendChild(panel);
        let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
        panel.addEventListener("mousedown", (e) => {
          dragging = true;
          const r = panel.getBoundingClientRect();
          sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
          panel.style.left = sl + "px"; panel.style.top = st + "px";
          panel.style.right = "auto"; panel.style.bottom = "auto";
          e.preventDefault();
        });
        document.addEventListener("mousemove", (e) => {
          if (!dragging) return;
          const nl = Math.max(0, Math.min(sl + e.clientX - sx, window.innerWidth - panel.offsetWidth));
          const nt = Math.max(0, Math.min(st + e.clientY - sy, window.innerHeight - panel.offsetHeight));
          panel.style.left = nl + "px"; panel.style.top = nt + "px";
        });
        document.addEventListener("mouseup", () => { dragging = false; });
      }
      panel.textContent = lines.join("\\n");
    };
    const applyRequestedSettings = () => {
      const target = window.__contentFerryWechatDraftTarget;
      if (!target?.draftOpened) return;
      const requestedWechatSettings = target.declareOriginal || target.enableReward || Boolean(target.collectionName);
      if (requestedWechatSettings && !target.settingsScrolled) {
        const settingsShortcut = [...document.querySelectorAll(
          ".js_fold.fold_tips_scrolltop .tool_bar__fold-btn, .fold_tips_scrolltop a[data-type='1']"
        )].find((element) => normalizedText(element) === "文章设置");
        if (settingsShortcut && !target.settingsShortcutClicked) {
          settingsShortcut.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          settingsShortcut.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          target.settingsShortcutClicked = true;
          sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
          showAssistStatus(["已点击微信编辑器的“文章设置”。", "正在等待页面定位到原创、赞赏和合集区域……"]);
          window.setTimeout(applyRequestedSettings, 500);
          return;
        }
        const settingsAnchor = document.querySelector("#js_original_box, #article_setting_area2, #js_article_tags_area");
        const editor = document.querySelector(".appmsg_editor");
        if (!settingsAnchor || !editor) {
          showAssistStatus(["已打开目标草稿，正在等待微信编辑器设置区加载……"]);
          return;
        }
        const scrollParents = [];
        let parent = settingsAnchor.parentElement;
        while (parent && parent !== document.body) {
          if (parent.scrollHeight > parent.clientHeight + 24) scrollParents.push(parent);
          parent = parent.parentElement;
        }
        settingsAnchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        for (const scrollParent of scrollParents) {
          const anchorRect = settingsAnchor.getBoundingClientRect();
          const parentRect = scrollParent.getBoundingClientRect();
          const nextTop = scrollParent.scrollTop + anchorRect.top - parentRect.top - Math.max(24, scrollParent.clientHeight / 3);
          scrollParent.scrollTop = Math.max(0, Math.min(scrollParent.scrollHeight - scrollParent.clientHeight, nextTop));
          scrollParent.dispatchEvent(new Event("scroll", { bubbles: true }));
        }
        if (document.scrollingElement) {
          settingsAnchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
        }
        target.settingsScrolled = true;
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
        showAssistStatus(["已打开目标草稿并定位到发布设置区。", "正在处理原创、赞赏和合集设置……"]);
        window.setTimeout(applyRequestedSettings, 500);
        return;
      }
      const notes = ["文渡已定位到目标草稿。"];
      if (target.declareOriginal) {
        const originalOpen = document.querySelector("#js_original_open");
        if (originalOpen && visible(originalOpen)) {
          target.originalResult = "already";
          notes.push("原创：微信页面已显示为已声明。");
        } else if (!target.originalDialogOpened) {
          const originalEntry = document.querySelector("#js_original .js_original_apply.js_edit_ori");
          if (originalEntry) {
            originalEntry.click();
            target.originalDialogOpened = true;
            notes.push("原创：已打开声明设置，正在等待微信确认窗口。");
          } else {
            notes.push("原创：尚未找到声明入口，请在微信页面确认。");
          }
        } else {
          notes.push("原创：声明设置已打开，请确认微信要求的原创信息。");
        }
      }
      if (target.declareOriginal && target.originalResult !== "already") {
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
        showAssistStatus(notes);
        return;
      }
      if (target.enableReward) {
        const rewardArea = document.querySelector("#js_reward_setting_area");
        const rewardCheckbox = rewardArea?.querySelector(".js_reward_setting_checkbox");
        if (rewardCheckbox instanceof HTMLInputElement && rewardCheckbox.checked) {
          target.rewardResult = "already";
          notes.push("赞赏：微信页面已显示为开启。");
        } else if (rewardArea && visible(rewardArea) && !target.rewardDialogOpened) {
          const rewardEntry = rewardArea.querySelector(".js_reward_open");
          if (rewardEntry) {
            rewardEntry.click();
            target.rewardDialogOpened = true;
            notes.push("赞赏：已打开设置，正在等待选择赞赏账户。");
          }
        } else {
          notes.push("赞赏：需要先完成原创声明，或由微信开放赞赏入口。");
        }
      }
      if (target.enableReward && target.rewardResult !== "already") {
        sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
        showAssistStatus(notes);
        return;
      }
      if (target.collectionName) {
        if (!target.collectionDialogOpened) {
          const collectionEntry = document.querySelector("#js_article_tags_area .js_article_tags_label");
          if (collectionEntry) {
            collectionEntry.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
            collectionEntry.click();
            target.collectionDialogOpened = true;
          }
        }
        const collectionMatches = [...new Set(clickableNodes()
          .filter((node) => normalizedText(node) === String(target.collectionName).replace(/\\s+/g, ""))
          .map((node) => node.closest("a, button, [role='button'], [role='link']") || node))];
        if (collectionMatches.length === 1) {
          const node = collectionMatches[0];
          node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          target.collectionResult = "selected";
        }
        notes.push(target.collectionResult === "selected" ? "合集：已选择「" + target.collectionName + "」。" : "合集：请确认选择「" + target.collectionName + "」。");
      }
      notes.push("请最后预览内容，并由你在微信后台点击发布。");
      sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(target));
      showAssistStatus(notes);
    };
    const tick = () => {
      if (isDraftsPage()) {
        if (!window.__contentFerryWechatDraftTarget?.draftOpened) openTargetDraft();
        else applyRequestedSettings();
        return;
      }
      applyRequestedSettings();
      // Prefer the concrete draft-box link whenever it is already present in
      // the DOM. This avoids toggling an expanded menu back to the collapsed
      // state when WeChat changes the active/expanded class names.
      if (openDrafts()) return;
      const contentManagement = findText([/^内容管理$/, /^内容管理(?:[▶▾▼])?$/]);
      if (!contentManagement) return;
      if (!contentManagementOpened && contentManagement && !isExpanded(contentManagement)) {
        contentManagementOpened = clickText([/^内容管理$/, /^内容管理(?:[▶▾▼])?$/]);
        window.setTimeout(tick, 500);
        return;
      }
      contentManagementOpened = true;
      if (openDrafts()) return;
    };
    // 微信登录成功后可能不触发完整页面刷新，因此同时监听 DOM 变化。
    window.setTimeout(tick, 1200);
    window.setInterval(tick, 1200);
    new MutationObserver(() => window.setTimeout(tick, 80)).observe(document.documentElement, { childList: true, subtree: true });
  })()`, true);
  if (target) void advanceWechatDraftEditing(window);
}

async function advanceWechatDraftEditing(window: BrowserWindow): Promise<void> {
  if (wechatBackendAdvanceTask) {
    void wechatBackendAdvanceTask.finally(() => {
      if (wechatBackendTarget && !window.isDestroyed()) void advanceWechatDraftEditing(window);
    });
    return wechatBackendAdvanceTask;
  }
  wechatBackendAdvanceTask = (async () => {
    try {
      for (let attempt = 0; attempt < 40 && !window.isDestroyed(); attempt += 1) {
        const action = await window.webContents.executeJavaScript(`(() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 4 && rect.height > 4 && style.display !== "none" && style.visibility !== "hidden";
          };
          const target = (() => {
            try { return JSON.parse(sessionStorage.getItem("contentferry-wechat-draft-target") || "null"); }
            catch { return window.__contentFerryWechatDraftTarget || null; }
          })();
          if (!target?.title || target.draftOpened) return { kind: "done" };
          const title = String(target.title).replace(/\\s+/g, "").trim();
          const text = (element) => (element.textContent || "").replace(/\\s+/g, "").trim();
          const shortenedTitle = (value) => value.replace(/(?:…|\.\.\.)$/, "");
          const titleMatches = (value) => value === title || (shortenedTitle(value).length >= 12 && title.startsWith(shortenedTitle(value))) || (value.includes(title) && value.length <= title.length + 32);
          const exactTitleLinks = [...document.querySelectorAll("a.weui-desktop-publish__cover__title")]
            .filter(visible).filter((node) => titleMatches(text(node)) || titleMatches(String(node.getAttribute("title") || "").replace(/\s+/g, "").trim()));
          const titleNodes = exactTitleLinks.length > 0 ? exactTitleLinks : [...document.querySelectorAll("a, button, [role='button'], [role='link'], li, span, div, p, h1, h2, h3")]
            .filter(visible).filter((node) => {
              const value = text(node);
              return titleMatches(value) || titleMatches(String(node.getAttribute("title") || "").replace(/\s+/g, "").trim());
            });
          const findDraftCard = (node) => {
            const titleLink = node.closest("a.weui-desktop-publish__cover__title") || node.closest("a") || node;
            const exactCard = titleLink.closest(".weui-desktop-card__inner");
            if (exactCard) return exactCard;
            const ancestors = [];
            let current = titleLink.parentElement;
            for (let depth = 0; current && current !== document.body && depth < 10; depth += 1) {
              ancestors.push(current);
              current = current.parentElement;
            }
            const withActions = ancestors.find((ancestor) => ancestor.querySelector(
              "[class*='action' i], [class*='operate' i], [class*='toolbar' i], [class*='tool_bar' i], button, [role='button']"
            ));
            if (withActions) return withActions;
            return ancestors.find((ancestor) => /(?:^|\\s)weui-desktop-(?:card|publish)(?:\\s|$)|publish__(?:item|card)/i.test(String(ancestor.className || "")))
              || ancestors.find((ancestor) => {
                const rect = ancestor.getBoundingClientRect();
                return rect.width > 280 && rect.height > 100;
              })
              || titleLink.parentElement;
          };
          const cards = [...new Set(titleNodes.map(findDraftCard).filter(Boolean))];
          if (cards.length !== 1) return { kind: "waiting" };
          const card = cards[0];
          card.scrollIntoView({ block: "center", inline: "nearest" });
          const exactEditWrapper = [...card.querySelectorAll(".weui-desktop-card__action .weui-desktop-tooltip__wrp")]
            .find((wrapper) => text(wrapper.querySelector(".weui-desktop-tooltip") || wrapper) === "编辑");
          const exactEdit = exactEditWrapper?.querySelector("a.weui-desktop-icon-btn");
          if (exactEdit) {
            exactEdit.click();
            const nextTarget = { ...target, title: "", draftOpened: true };
            window.__contentFerryWechatDraftTarget = nextTarget;
            sessionStorage.setItem("contentferry-wechat-draft-target", JSON.stringify(nextTarget));
            return { kind: "done" };
          }
          const cardRect = card.getBoundingClientRect();
          const editButtons = [...new Set([...card.querySelectorAll("button, a, [role='button'], [role='link'], [title], [aria-label], [data-tooltip], [data-title], i, span, div")]
            .filter(visible)
            .filter((node) => {
              const description = [node.textContent, node.getAttribute("title"), node.getAttribute("aria-label"), node.getAttribute("data-tooltip"), node.getAttribute("data-title"), node.className]
                .filter((value) => typeof value === "string").join(" ");
              return /编辑/.test(description) || /(?:^|[-_])edit(?:[-_]|$)/i.test(String(node.className || ""));
            })
            .map((node) => node.closest("a, button, [role='button'], [role='link']") || node))];
          if (editButtons.length !== 1) return { kind: "hover", x: cardRect.left + cardRect.width / 2, y: cardRect.top + cardRect.height / 2 };
          const editRect = editButtons[0].getBoundingClientRect();
          return { kind: "edit", x: editRect.left + editRect.width / 2, y: editRect.top + editRect.height / 2 };
        })()`, true) as { kind: "done" | "waiting" | "hover" | "edit"; x?: number; y?: number };
        if (action.kind === "done") return;
        if ((action.kind === "hover" || action.kind === "edit") && action.x != null && action.y != null) {
          const x = Math.round(action.x);
          const y = Math.round(action.y);
          window.webContents.sendInputEvent({ type: "mouseMove", x, y });
          if (action.kind === "edit") {
            await delay(180);
            window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
            window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
            return;
          }
        }
        await delay(500);
      }
    } catch (error) {
      console.warn("Wechat draft editor navigation warning", error);
    } finally {
      wechatBackendAdvanceTask = undefined;
    }
  })();
  return wechatBackendAdvanceTask;
}

async function getOrCreateContentAnyWindow(): Promise<BrowserWindow> {
  if (contentAnyWindow && !contentAnyWindow.isDestroyed()) return contentAnyWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: true,
    title: "文渡 · ContentAny AI 检测",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-contentany"
    }
  });
  contentAnyWindow = window;
  window.on("closed", () => { if (contentAnyWindow === window) contentAnyWindow = undefined; });
  await window.loadURL("https://cn.aifoxs.com/ai-detect");
  await delay(1500);
  return window;
}

async function getOrCreateResearchBrowserWindow(): Promise<BrowserWindow> {
  if (researchBrowserWindow && !researchBrowserWindow.isDestroyed()) return researchBrowserWindow;
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    title: "文渡 · 联网检索协助",
    icon: createWenduWindowIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:contentferry-research"
    }
  });
  researchBrowserWindow = window;
  window.on("closed", () => { if (researchBrowserWindow === window) researchBrowserWindow = undefined; });
  // Inject gstack's Layer-C stealth into the page's MAIN world. A plain preload
  // runs in Electron's isolated world under contextIsolation, so its patches on
  // navigator.webdriver/window.chrome would be invisible to the page — a silent
  // no-op. CDP addScriptToEvaluateOnNewDocument runs in the main world (exactly
  // like Playwright's addInitScript), so DuckDuckGo's own JS sees the masked
  // tells. Stealth is best-effort: any failure degrades to a visible window.
  await installResearchStealth(window);
  // Apply the global research proxy to this session partition too, so the
  // visible-browser fallback routes through the same proxy as the fetch layer.
  await applyResearchProxy(window);
  return window;
}

/**
 * Port of gstack's "consistency-first" anti-detection into the page main world.
 * Reads the compiled `research-stealth-preload.js` (same source of truth as the
 * old preload) and registers it as a CDP init script on the window's debugger.
 */
async function installResearchStealth(window: BrowserWindow): Promise<void> {
  const stealthSourcePath = path.join(__dirname, "research-stealth-preload.js");
  if (!fs.existsSync(stealthSourcePath)) return;
  let source: string;
  try {
    source = fs.readFileSync(stealthSourcePath, "utf8");
  } catch {
    return;
  }
  const dbg = window.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
    await dbg.sendCommand("Page.enable");
    await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source });
  } catch {
    /* stealth is best-effort; never block research over it */
  }
}

/** Point the research session partition at the global research proxy (or clear
 * it). Mirrors the proxy used by the fetch-based providers so both channels
 * behave identically. A blank/invalid value falls back to a direct connection. */
async function applyResearchProxy(window: BrowserWindow): Promise<void> {
  const proxy = loadAppSettings().researchProxyUrl?.trim() ?? "";
  try {
    const researchSession = session.fromPartition("persist:contentferry-research");
    if (proxy) {
      const parsed = new URL(proxy);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "socks5:") {
        console.warn(`[contentferry] 检索代理协议不支持，已忽略并直连：${proxy}`);
        await researchSession.setProxy({ proxyRules: "" });
        return;
      }
      await researchSession.setProxy({ proxyRules: proxy });
    } else {
      await researchSession.setProxy({ proxyRules: "" });
    }
  } catch {
    /* proxy misconfiguration must not block research */
  }
}

const RESEARCH_RENDER_TIMEOUT_MS = 12_000;
const RESEARCH_POLL_INTERVAL_MS = 400;

/** Read the current rendered results from the research window. DuckDuckGo's
 * result links are wrapped in `uddg=` redirectors; we decode them back to the
 * final source URL so citations, material cards and audit trails stay clean. */
async function readResearchOutcome(window: BrowserWindow, sliceLimit: number): Promise<{ blocked: boolean; links: SearchResultItem[] }> {
  return window.webContents.executeJavaScript(`(() => {
    const decodeDdg = (href) => {
      try {
        const m = /[?&]uddg=([^&]+)/.exec(href);
        if (m) {
          const b = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
          const bin = atob(b);
          return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
        }
        const u = /[?&]url=([^&]+)/.exec(href);
        if (u) return decodeURIComponent(u[1]);
      } catch (e) {}
      return href;
    };
    const text = (document.body && document.body.innerText || "").replace(/\\s+/g, " ").trim();
    const blocked = /captcha|verify you are human|unusual traffic|anomaly|机器人|人机验证|安全验证/i.test(text);
    const links = [...document.querySelectorAll("a.result__a")].map((node) => ({
      title: (node.textContent || "").replace(/\\s+/g, " ").trim(),
      url: decodeDdg(node.href),
      snippet: (node.closest(".result")?.querySelector(".result__snippet")?.textContent || "").replace(/\\s+/g, " ").trim()
    })).filter((item) => /^https?:\\/\\//.test(item.url) && item.title);
    return { blocked: blocked, links: links.slice(0, ${sliceLimit}) };
  })()`, true) as Promise<{ blocked: boolean; links: SearchResultItem[] }>;
}

/** Wait for the page to actually render results instead of a blind fixed delay.
 * A slow network no longer produces a false "0 links" misread that would burn
 * every retry and wrongly escalate to a human-verification window. */
async function waitForResearchResults(window: BrowserWindow, sliceLimit: number, timeoutMs: number): Promise<{ blocked: boolean; links: SearchResultItem[] }> {
  const deadline = Date.now() + timeoutMs;
  let outcome = await readResearchOutcome(window, sliceLimit);
  while (!outcome.blocked && outcome.links.length === 0 && Date.now() < deadline) {
    await delay(RESEARCH_POLL_INTERVAL_MS);
    if (window.isDestroyed()) return outcome;
    outcome = await readResearchOutcome(window, sliceLimit);
  }
  return outcome;
}

async function searchWithVisibleResearchBrowser(query: string, limit: number): Promise<SearchResultItem[]> {
  return enqueueResearchSearch(async () => {
    const window = await getOrCreateResearchBrowserWindow();
    const sliceLimit = Math.max(1, Math.min(limit, 10));
    // Layer 2 (lightweight auto-bypass): the window stays hidden and we retry a
    // few times before escalating to a human. Stealth (gstack Layer C, injected
    // into the main world via CDP) masks automation tells on every load, so most
    // blocks clear on the first pass.
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await window.loadURL(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=cn-zh`);
      const outcome = await waitForResearchResults(window, sliceLimit, RESEARCH_RENDER_TIMEOUT_MS);
      if (!outcome.blocked && outcome.links.length > 0) {
        // Success — keep the window out of the user's way.
        if (window.isVisible()) window.hide();
        return outcome.links;
      }
      if (outcome.blocked) break; // real block — stop retrying, go to human handoff
    }
    // Layer 3 (human handoff): automated bypass is exhausted. Surface the window
    // and hand control to the user. The persistent partition (Layer 4) keeps any
    // verification valid, so a retry after the user completes it usually succeeds
    // silently on the next pass.
    window.show();
    window.focus();
    throw new BrowserVerificationRequiredError();
  });
}

async function runContentAnyDetection(markdown: string): Promise<ContentAnyDetectionResponse> {
  const window = await getOrCreateContentAnyWindow();
  window.show();
  window.focus();
  const filled = await window.webContents.executeJavaScript(`(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 120 && rect.height > 30 && style.display !== "none" && style.visibility !== "hidden";
    };
    const editor = [...document.querySelectorAll("textarea, [contenteditable='true']")]
      .filter(visible)
      .sort((left, right) => right.getBoundingClientRect().width * right.getBoundingClientRect().height - left.getBoundingClientRect().width * left.getBoundingClientRect().height)[0];
    if (!editor) return { ok: false, reason: "未找到 ContentAny 正文输入区" };
    const value = ${JSON.stringify(markdown)};
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(editor, value);
    } else {
      editor.textContent = value;
    }
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
    const button = [...document.querySelectorAll("button, [role='button']")].find((item) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return /AI指数检测|AI.*检测/i.test((item.textContent || "").replace(/\\s+/g, "").trim()) && rect.width > 30 && rect.height > 20 && style.display !== "none" && style.visibility !== "hidden";
    });
    if (!button) return { ok: false, reason: "未找到 ContentAny 的 AI 指数检测按钮" };
    button.click();
    return { ok: true };
  })()`, true) as { ok: boolean; reason?: string };
  if (!filled.ok) return { status: "needs_user", message: `${filled.reason ?? "ContentAny 页面结构发生变化"}。请在已打开的 ContentAny 窗口中登录或完成必要操作后重试。` };
  await delay(3500);
  for (let attempt = 0; attempt < 30 && !window.isDestroyed(); attempt += 1) {
    const result = await window.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 20 && rect.height > 12 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isReportText = (value) => /AI\\s*(?:指数|检测|内容|特征)|检测(?:结果|报告)|原创(?:度|指数)|疑似\\s*AI|人工(?:创作|特征)/i.test(value);
      const pageText = (document.body?.innerText || "").replace(/\s+/g, " ");
      // ContentAny first renders the full page shell and “检测中” placeholders.
      // Only read results once those placeholders have disappeared.
      if (/检测中|正在生成报告|汇总多维度分析结果|检测结果统计中/.test(pageText)) return null;
      const referenceNodes = [...document.querySelectorAll("*")].filter((node) => {
        if (!(node instanceof HTMLElement) || !visible(node)) return false;
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        return /^参考(?:\s|$)/.test(text) && text.length < 1200 && (/%|概率|人工|AIGC|AI/.test(text));
      }).map((node) => (node.innerText || "").replace(/\s+/g, " ").trim());
      const referenceText = referenceNodes.sort((left, right) => left.length - right.length)[0] ?? "";
      const tables = [...document.querySelectorAll("table")].filter(visible).map((table) => (table.innerText || "").trim()).filter(isReportText);
      const reportNodes = [...document.querySelectorAll("[class*='result' i], [class*='report' i], [class*='detect' i], [class*='score' i], [class*='index' i], [class*='segment' i], [id*='result' i], [id*='report' i]")]
        .filter(visible)
        .map((node) => (node.innerText || "").trim())
        .filter((value) => value.length > 0 && value.length < 12000 && isReportText(value));
      const candidates = [...reportNodes, ...tables];
      const best = candidates.sort((left, right) => right.length - left.length)[0];
      // The product surface deliberately shows the detector's concise
      // “参考” conclusion, not a copied page shell or marketing content.
      if (!referenceText) return null;
      const lines = referenceText.split(/\n|(?<=%)\s+/).map((line) => line.trim()).filter(Boolean);
      const score = lines.find((line) => /^\d+(?:\.\d+)?%$/.test(line)) ?? referenceText.match(/\d+(?:\.\d+)?\s*%/)?.[0] ?? null;
      const summary = lines.find((line) => /概率|偏人工|偏\s*AI|仅供参考/.test(line)) ?? "检测完成，可结合分段结果查看。";
      return {
        result: referenceText.slice(0, 12000),
        reference: { label: "参考", score, summary, detail: referenceText }
      };
    })()`, true) as { result: string; reference: { label: string; score: string | null; summary: string; detail: string } | null } | null;
    if (result) return { status: "completed", result: result.result, ...(result.reference ? { reference: result.reference } : {}) };
    await delay(1500);
  }
  window.focus();
  return { status: "needs_user", message: "ContentAny 已打开并提交检测，但暂时未能读取报告。请检查页面是否需要登录或验证码，完成后再次点击检测。" };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
