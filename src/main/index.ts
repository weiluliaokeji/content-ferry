import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, type OpenDialogOptions } from "electron";
import { openDatabase } from "./db/database";
import { getDataDirectory } from "./config/paths";
import { createServer } from "./server/create-server";
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
let wechatBackendWindow: BrowserWindow | undefined;
let runtimeBootstrapPromise: Promise<void> | undefined;
let runtimeShutdown: (() => Promise<void>) | undefined;
let shutdownPromise: Promise<void> | undefined;

function destroyAuxiliaryWindows(): void {
  for (const window of [zhuqueWindow, contentAnyWindow, wechatBackendWindow]) {
    if (window && !window.isDestroyed()) window.destroy();
  }
  zhuqueWindow = undefined;
  contentAnyWindow = undefined;
  wechatBackendWindow = undefined;
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
  const modelProvider = new OpenAICodexProvider(path.join(dataDirectory, "ai-sandbox"));
  const assetStore = new LocalAssetStore(path.join(dataDirectory, "content-assets"));
  const server = await createServer(
    new Date().toISOString(),
    database,
    new ElectronCredentialVault(safeStorage),
    modelProvider,
    assetStore,
    logFilePath,
    path.join(dataDirectory, "skills")
  );
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
  ipcMain.handle("contentferry:open-wechat-backend", async () => {
    const window = await getOrCreateWechatBackendWindow();
    window.show();
    window.focus();
    await driveWechatBackendToDrafts(window);
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
  window.on("closed", () => { if (wechatBackendWindow === window) wechatBackendWindow = undefined; });
  window.webContents.on("did-finish-load", () => { void driveWechatBackendToDrafts(window); });
  await window.loadURL("https://mp.weixin.qq.com/");
  return window;
}

async function driveWechatBackendToDrafts(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;
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
    const isDraftsPage = () => /\\/cgi-bin\\/appmsg|action=(?:list|list_ex).*appmsg/i.test(location.href);
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
    const tick = () => {
      if (isDraftsPage()) return;
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
