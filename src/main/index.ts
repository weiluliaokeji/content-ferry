import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { app, dialog, ipcMain, Menu, safeStorage, shell, type OpenDialogOptions } from "electron";
import { openDatabase } from "./db/database";
import { AccountRepository } from "./accounts/account-repository";
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
import { state } from "./automation/state";
import { delay } from "./automation/delay";
import { createMainWindow, shutdownAndExit } from "./automation/windows";
import { getOrCreateZhuqueWindow, runZhuqueDetection } from "./automation/zhuque-detection";
import { getOrCreateContentAnyWindow, runContentAnyDetection } from "./automation/content-any-detection";
import { searchWithVisibleResearchBrowser } from "./automation/research-automation";
import { confirmCsdnBrowserPublish, driveCsdnBrowserPublish, logCsdnBrowserAssist } from "./automation/csdn-automation";
import { driveWechatBackendToDrafts, getOrCreateWechatBackendWindow, logWechatBrowserAssist } from "./automation/wechat-automation";
import { readCnblogsPersonalOptions } from "./automation/cnblogs-options-automation";
import { readFiftyoneCtoCategories } from "./fiftyone-cto/fiftyone-cto-category-automation";

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


async function registerAppSettingsIpcHandlers(): Promise<void> {
  ipcMain.handle("app:get-settings", async () => loadAppSettings());
  ipcMain.handle("app:update-settings", async (_event, patch: unknown) => {
    if (typeof patch !== "object" || patch === null) {
      throw new Error("设置更新参数无效。");
    }
    return saveAppSettings(patch as Partial<AppSettingsContract>);
  });
  ipcMain.handle("app:choose-data-dir", async () => {
    const result = state.mainWindow
      ? await dialog.showOpenDialog(state.mainWindow, {
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
  if (!state.runtimeBootstrapPromise) {
    state.runtimeBootstrapPromise = fullBootstrap(reuseExistingWindow).catch((error: unknown) => {
      state.runtimeBootstrapPromise = undefined;
      throw error;
    });
  }
  return state.runtimeBootstrapPromise;
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
  state.runtimeDatabase = database;
  const modelProvider = new OpenAICodexProvider(path.join(dataDirectory, "ai-sandbox"));
  const assetStore = new LocalAssetStore(path.join(dataDirectory, "content-assets"));
  const vault = new ElectronCredentialVault(safeStorage);
  const server = await createServer(
    new Date().toISOString(),
    database,
    vault,
    modelProvider,
    assetStore,
    logFilePath,
    path.join(dataDirectory, "skills"),
    searchWithVisibleResearchBrowser,
    confirmCsdnBrowserPublish
  );
  state.runtimeInfoLogger = (details, message) => server.log.info(details, message);
  const accountRepository = new AccountRepository(database.connection);
  let runtimeClosed = false;
  state.runtimeShutdown = async () => {
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
    state.runtimeInfoLogger = undefined;
    if (state.runtimeDatabase === database) state.runtimeDatabase = undefined;
  };

  ipcMain.handle("contentferry:select-directory", async () => {
    const options: OpenDialogOptions = {
      title: "选择 VitePress 的 docs 文章库文件夹",
      properties: ["openDirectory", "createDirectory"]
    };
    const result = state.mainWindow ? await dialog.showOpenDialog(state.mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("contentferry:select-image", async () => {
    const result = state.mainWindow ? await dialog.showOpenDialog(state.mainWindow, {
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
      state.wechatBackendTarget = {
        accountId: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId) ? accountId : "",
        title: requestedTitle.slice(0, 200),
        declareOriginal: target?.declareOriginal === true,
        enableReward: target?.enableReward === true,
        collectionName: typeof target?.collectionName === "string" ? target.collectionName.trim().slice(0, 80) : ""
      };
      logWechatBrowserAssist("requested", {
        title: state.wechatBackendTarget.title,
        accountId: state.wechatBackendTarget.accountId || undefined,
        declareOriginal: state.wechatBackendTarget.declareOriginal,
        enableReward: state.wechatBackendTarget.enableReward,
        hasCollection: Boolean(state.wechatBackendTarget.collectionName)
      });
      // A deliberate reopen starts a fresh browser-assist run. Session storage
      // is still used across the internal WeChat page navigations that follow.
      await window.webContents.executeJavaScript("sessionStorage.removeItem('contentferry-wechat-draft-target'); window.__contentFerryWechatDraftTarget = undefined;", true);
    } else {
      state.wechatBackendTarget = undefined;
      await window.webContents.executeJavaScript("sessionStorage.removeItem('contentferry-wechat-draft-target'); window.__contentFerryWechatDraftTarget = undefined;", true);
    }
    await driveWechatBackendToDrafts(window, state.wechatBackendTarget);
  });
  ipcMain.handle("contentferry:open-csdn-publisher", async (_event, jobId?: unknown) => {
    if (typeof jobId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(jobId)) throw new Error("缺少有效的 CSDN 发布任务标识。");
    logCsdnBrowserAssist("requested", { jobId });
    await driveCsdnBrowserPublish(jobId);
  });
  ipcMain.handle("contentferry:read-cnblogs-personal-options", async (_event, accountId?: unknown) => {
    const options = await readCnblogsPersonalOptions();
    // 读取成功后按账号持久化，弹窗再次打开时直接复用，无需重复抓取。
    if (typeof accountId === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId)) {
      try {
        accountRepository.saveCnblogsOptions(accountId, options.categories, options.tags);
      } catch (error) {
        state.runtimeInfoLogger?.({ accountId, error: error instanceof Error ? error.message : String(error) }, "保存博客园个人分类/Tag 失败");
      }
    }
    return options;
  });
  ipcMain.handle("contentferry:read-fiftyone-cto-categories", async (_event, accountId?: unknown) => {
    if (typeof accountId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(accountId)) throw new Error("缺少有效的 51CTO 账号标识。");
    const account = accountRepository.requireAccount(accountId);
    if (account.platform !== "51cto") throw new Error("该账号不是 51CTO 账号。");
    const categories = await readFiftyoneCtoCategories(account, accountRepository, vault);
    // 抓取成功后按账号持久化，弹窗再次打开时直接复用，无需重复抓取。
    try {
      accountRepository.saveFiftyoneCtoOptions(accountId, categories.pidOptions, categories.cateOptions);
    } catch (error) {
      state.runtimeInfoLogger?.({ accountId, error: error instanceof Error ? error.message : String(error) }, "保存 51CTO 分类选项失败");
    }
    // 连同抓取时的页面 DOM 调试结构一起返回，便于前端在选项为空时展示，供校准选择器。
    return { pidOptions: categories.pidOptions, cateOptions: categories.cateOptions, debug: categories.debug };
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

  if (!reuseExistingWindow || !state.mainWindow || state.mainWindow.isDestroyed()) {
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
  if (!state.shutdownPromise && state.runtimeShutdown) {
    event.preventDefault();
    void shutdownAndExit();
  }
});

