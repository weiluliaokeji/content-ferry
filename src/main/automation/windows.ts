import path from "node:path";
import { app, BrowserWindow, dialog, nativeImage, shell } from "electron";
import { state } from "./state";

// 窗口管理与应用退出逻辑（自 index.ts 拆分）

export function destroyAuxiliaryWindows(): void {
  for (const window of [state.zhuqueWindow, state.contentAnyWindow, state.wechatEditorWindow, state.wechatBackendWindow, state.juejinGrabWindow]) {
    if (window && !window.isDestroyed()) window.destroy();
  }
  state.zhuqueWindow = undefined;
  state.contentAnyWindow = undefined;
  state.wechatEditorWindow = undefined;
  state.wechatBackendWindow = undefined;
  state.juejinGrabWindow = undefined;
  state.wechatBackendAdvanceTask = undefined;
  state.wechatBackendTarget = undefined;
}

export function shutdownAndExit(exitCode = 0): Promise<void> {
  if (state.shutdownPromise) return state.shutdownPromise;
  state.shutdownPromise = (async () => {
    destroyAuxiliaryWindows();
    if (state.runtimeShutdown) await state.runtimeShutdown();
    app.exit(exitCode);
    // 兜底：若 app.exit() 因同步模态框等遗留消息循环未能真正终结进程，
    // 2 秒后强制结束，保证"关主窗 = 整组命令行必死"，不再卡住 concurrently。
    setTimeout(() => process.exit(exitCode), 2000).unref();
  })();
  return state.shutdownPromise;
}

export function createWenduWindowIcon() {
  const iconName = process.platform === "win32" ? "wendu-icon.ico" : "wendu-icon.png";
  return nativeImage.createFromPath(path.join(app.getAppPath(), "assets", iconName));
}

export async function createMainWindow(): Promise<void> {
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
  state.mainWindow = window;

  // A renderer `beforeunload` guard is used while an article has unsaved
  // changes. Electron does not show Chromium's native confirmation UI for
  // BrowserWindow closes, so without this handler the title-bar close button
  // appears to do nothing. Convert it into an explicit desktop confirmation.
  window.webContents.on("will-prevent-unload", (event) => {
    // 已经在退出流程中：直接放行关闭，绝不再弹同步模态框——否则会卡死原生关闭握手
    if (state.shutdownPromise) { event.preventDefault(); return; }
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

  window.webContents.setWindowOpenHandler(({ url }) => {
    // 渲染层 target="_blank" / window.open 的外部 http(s) 链接统一交给系统
    // 浏览器打开：应用内新建 BrowserWindow 缺少掘金等站点的登录态 Cookie，
    // 且草稿/文章页会被登录墙或 CSP 拦截成空白页。
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  window.on("closed", () => {
    if (state.mainWindow === window) state.mainWindow = undefined;
    if (process.platform !== "darwin") void shutdownAndExit();
  });

  const devServerUrl = process.env.CONTENTFERRY_DEV_SERVER_URL;
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}
