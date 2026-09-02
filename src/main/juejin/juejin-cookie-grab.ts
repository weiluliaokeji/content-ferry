/**
 * Juejin cookie grabber.
 *
 * Opens a login BrowserWindow pointing at https://juejin.cn/ (contextIsolation
 * enabled, no script injection), watches session cookie changes to detect the
 * login state (sessionid / passport_csrf_token), then builds the Cookie string,
 * resolves AID (default 2608) and UUID (localStorage first, cookie fallback),
 * and verifies the credentials against a signature-free Juejin API.
 */
import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { state } from "../automation/state";
import { JuejinApiError, JuejinClient } from "./juejin-client";
import {
  DEFAULT_JUJIN_AID,
  buildCookieString,
  hasLoginCandidate,
  mapVerifyResult,
  resolveUuid,
  shouldRecordCookieGrabLoadError,
  type CookieEntry,
  type JuejinGrabSnapshot,
  type JuejinGrabStatus
} from "./cookie-grab-utils";

const JUJIN_LOGIN_URL = "https://juejin.cn/";
const COOKIE_SETTLE_MS = 800;
/** 同一 grabId 两次接口验证的最小间隔，避免 cookies changed 高频触发死循环。 */
const VERIFY_THROTTLE_MS = 5000;

type CookieChangedListener = (event: Electron.Event, cookie: Electron.Cookie, cause: string, removed: boolean) => void;

export class JuejinCookieGrabber {
  private readonly snapshots = new Map<string, JuejinGrabSnapshot>();
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeGrabId: string | undefined;

  /** Start a grab for an account. Reuses an active grab window for the same account. */
  start(accountId: string): string {
    const active = this.activeGrabId ? this.snapshots.get(this.activeGrabId) : undefined;
    if (
      active &&
      active.accountId === accountId &&
      (active.status === "waiting_login" || active.status === "grabbing")
    ) {
      return active.grabId;
    }

    const grabId = randomUUID();
    const snapshot: JuejinGrabSnapshot = { grabId, accountId, status: "waiting_login" };
    this.snapshots.set(grabId, snapshot);

    const window = new BrowserWindow({
      width: 1000,
      height: 720,
      parent: state.mainWindow ?? undefined,
      modal: false,
      autoHideMenuBar: true,
      title: "掘金登录",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    this.windows.set(grabId, window);
    state.juejinGrabWindow = window;
    this.activeGrabId = grabId;

    const session = window.webContents.session;
    const cookieListener: CookieChangedListener = () => {
      void this.handleCookieChanged(grabId, window);
    };
    session.cookies.on("changed", cookieListener);
    window.on("closed", () => {
      session.cookies.removeListener("changed", cookieListener);
      this.windows.delete(grabId);
      const timer = this.settleTimers.get(grabId);
      if (timer) clearTimeout(timer);
      this.settleTimers.delete(grabId);
      if (state.juejinGrabWindow === window) state.juejinGrabWindow = undefined;
      const current = this.snapshots.get(grabId);
      if (current && current.status !== "success" && current.status !== "error") {
        this.snapshots.set(grabId, { ...current, status: "cancelled" });
      }
      if (this.activeGrabId === grabId) this.activeGrabId = undefined;
      state.runtimeInfoLogger?.({ grabId, status: "cancelled" }, "juejin cookie grab window closed");
    });

    state.runtimeInfoLogger?.({ grabId, status: "waiting_login" }, "juejin cookie grab window opened");
    void window.loadURL(JUJIN_LOGIN_URL).catch((error: unknown) => {
      const current = this.snapshots.get(grabId);
      if (!current) return;
      // 与 51CTO 同理：登录页保活/重定向会让 loadURL 的 promise 延迟 reject，
      // 抓取成功并关闭窗口后才到达。仅当加载在抓到凭据之前就失败时记为 error。
      if (!shouldRecordCookieGrabLoadError(current.status)) return;
      this.snapshots.set(grabId, {
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "无法打开掘金登录页。"
      });
      state.runtimeInfoLogger?.({ grabId, status: "error" }, "juejin cookie grab load failed");
    });

    return grabId;
  }

  /** Query the current snapshot of a grab. */
  getStatus(grabId: string): JuejinGrabSnapshot | undefined {
    return this.snapshots.get(grabId);
  }

  /** Destroy every grab window (used by destroyAuxiliaryWindows). */
  destroyAll(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
    this.snapshots.clear();
    this.activeGrabId = undefined;
  }

  private async handleCookieChanged(grabId: string, window: BrowserWindow): Promise<void> {
    const current = this.snapshots.get(grabId);
    if (!current || current.status !== "waiting_login" || window.isDestroyed()) return;
    const cookies = await window.webContents.session.cookies.get({});
    if (!hasLoginCandidate(cookies)) return;

    // Debounce: wait for the cookie set to settle before capturing.
    const existing = this.settleTimers.get(grabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.grab(grabId, window), COOKIE_SETTLE_MS);
    this.settleTimers.set(grabId, timer);
  }

  private async grab(grabId: string, window: BrowserWindow): Promise<void> {
    const current = this.snapshots.get(grabId);
    if (!current || current.status !== "waiting_login" || window.isDestroyed()) return;
    this.settleTimers.delete(grabId);

    // Throttle: do not re-verify within VERIFY_THROTTLE_MS of the last attempt.
    // This prevents a cookies-changed storm from looping the grab flow while
    // the user is still logging in.
    const now = Date.now();
    if (current.lastVerifyAt && now - current.lastVerifyAt < VERIFY_THROTTLE_MS) return;

    this.snapshots.set(grabId, { ...current, status: "grabbing" });
    state.runtimeInfoLogger?.({ grabId, status: "grabbing" }, "juejin cookie grab capturing credentials");

    try {
      const cookies = await window.webContents.session.cookies.get({});
      const cookie = buildCookieString(cookies);
      if (!cookie) {
        this.snapshots.set(grabId, { ...current, status: "error", error: "未能从登录窗口读取到 Cookie。" });
        return;
      }
      let localStorageUuid = "";
      try {
        const raw = await window.webContents.executeJavaScript("localStorage.getItem('uuid')");
        localStorageUuid = typeof raw === "string" ? raw : "";
      } catch {
        localStorageUuid = "";
      }
      const uuid = resolveUuid(localStorageUuid, cookies);
      const aid = DEFAULT_JUJIN_AID;

      // The only source of truth for "logged in" is the signature-free API
      // call. Anonymous cookies (passport_csrf_token / sessionid planted
      // before login) must NOT be treated as a successful login.
      const verified = await this.verify(cookie, aid, uuid);
      const settled = this.snapshots.get(grabId);
      if (!settled || settled.status !== "grabbing" || window.isDestroyed()) return;

      if (!verified) {
        // Not logged in yet: go back to waiting_login, keep the window open
        // and let the next cookie change re-trigger the grab (throttled).
        this.snapshots.set(grabId, {
          ...settled,
          status: "waiting_login",
          lastVerifyAt: now,
          error: undefined
        });
        state.runtimeInfoLogger?.({ grabId, status: "waiting_login" }, "juejin cookie grab verification failed, waiting for login");
        return;
      }

      this.snapshots.set(grabId, {
        grabId,
        accountId: settled.accountId,
        status: "success",
        cookie,
        aid,
        uuid,
        verified: true,
        lastVerifyAt: now
      });
      state.runtimeInfoLogger?.({ grabId, status: "success", verified: true }, "juejin cookie grab success");
      if (!window.isDestroyed()) window.close();
    } catch (error) {
      const settled = this.snapshots.get(grabId);
      if (!settled) return;
      this.snapshots.set(grabId, {
        ...settled,
        status: "error",
        error: error instanceof Error ? error.message : "抓取掘金凭据失败。"
      });
      state.runtimeInfoLogger?.({ grabId, status: "error" }, "juejin cookie grab failed");
    }
  }

  private async verify(cookie: string, aid: string, uuid: string): Promise<boolean> {
    if (!cookie) return false;
    try {
      const client = new JuejinClient(cookie, aid, uuid, fetch);
      await client.listByUser(1, 1);
      return mapVerifyResult(0);
    } catch (error) {
      if (error instanceof JuejinApiError) return mapVerifyResult(error.errNo);
      return false;
    }
  }
}

export type { JuejinGrabStatus, JuejinGrabSnapshot };
