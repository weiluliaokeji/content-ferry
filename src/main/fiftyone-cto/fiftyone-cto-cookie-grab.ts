/**
 * 51CTO cookie grabber.
 *
 * Opens a login BrowserWindow pointing at https://blog.51cto.com/ (contextIsolation
 * enabled, no script injection), watches session cookie changes, then builds the
 * Cookie string and verifies it by loading the authenticated publish page itself
 * (GET /blogger/publish). A 302 to the login page, or a response that does NOT
 * contain the am-editor container (editor-container / am-engine) means the cookie
 * is not a real session, so the grab will not report success.
 *
 * Unlike Juejin, 51CTO only needs the Cookie header for its publish and image-host
 * APIs; no extra aid/uuid fields are required.
 *
 */
import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import { state } from "../automation/state";
import { FiftyoneCtoChannelError } from "./fiftyone-cto-channel-error";
import { buildCookieString, hasLoginCandidate, isAuthenticatedFiftyoneCtoPublishPage, shouldRecordCookieGrabLoadError, type FiftyoneCtoGrabSnapshot } from "./fiftyone-cto-cookie-grab-utils";

const FIFTYONE_CTO_LOGIN_URL = "https://blog.51cto.com/";
const FIFTYONE_CTO_PUBLISH_PAGE_URL = "https://blog.51cto.com/blogger/publish?old=1&orig=first-publish";
/** 页面级 GET 用 UA（与 CTOClient 一致），不带 AJAX 头以免被当作接口请求拦截。 */
const FIFTYONE_CTO_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";
const COOKIE_SETTLE_MS = 800;
/** 同一 grabId 两次接口验证的最小间隔，避免 cookies changed 高频触发死循环。 */
const VERIFY_THROTTLE_MS = 5000;

type CookieChangedListener = (event: Electron.Event, cookie: Electron.Cookie, cause: string, removed: boolean) => void;

export class FiftyoneCtoCookieGrabber {
  private readonly snapshots = new Map<string, FiftyoneCtoGrabSnapshot>();
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pollTimers = new Map<string, ReturnType<typeof setInterval>>();
  private activeGrabId: string | undefined;

  /** Start a grab for an account. Reuses an active grab window for the same account. */
  start(accountId: string): string {
    const active = this.activeGrabId ? this.snapshots.get(this.activeGrabId) : undefined;
    if (active && active.accountId === accountId && (active.status === "waiting_login" || active.status === "grabbing")) {
      return active.grabId;
    }

    const grabId = randomUUID();
    const snapshot: FiftyoneCtoGrabSnapshot = { grabId, accountId, status: "waiting_login" };
    this.snapshots.set(grabId, snapshot);

    const window = new BrowserWindow({
      width: 1000,
      height: 720,
      parent: state.mainWindow ?? undefined,
      modal: false,
      autoHideMenuBar: true,
      title: "51CTO 登录",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    this.windows.set(grabId, window);
    state.fiftyoneCtoGrabWindow = window;
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
      this.clearPoll(grabId);
      if (state.fiftyoneCtoGrabWindow === window) state.fiftyoneCtoGrabWindow = undefined;
      const current = this.snapshots.get(grabId);
      if (current && current.status !== "success" && current.status !== "error") {
        this.snapshots.set(grabId, { ...current, status: "cancelled" });
      }
      if (this.activeGrabId === grabId) this.activeGrabId = undefined;
      state.runtimeInfoLogger?.({ grabId, status: "cancelled" }, "51cto cookie grab window closed");
    });

    state.runtimeInfoLogger?.({ grabId, status: "waiting_login" }, "51cto cookie grab window opened");
    // 兜底：若窗口打开时已经处于登录态（Cookie 在页面加载即存在，不会触发
    // cookies.changed 事件），在 dom-ready 时主动校验一次，避免“已登录却抓不到”。
    window.webContents.on("dom-ready", () => {
      void this.handleCookieChanged(grabId, window);
    });
    // 轮询兜底：即使 cookies.changed 不触发（部分登录流程只写 HttpOnly/跨域
    // cookie，或登录态在窗口打开即存在），也周期性检查并验证，确保能抓到。
    const pollTimer = setInterval(() => {
      if (!window.isDestroyed()) void this.handleCookieChanged(grabId, window);
    }, 1500);
    this.pollTimers.set(grabId, pollTimer);
    void window.loadURL(FIFTYONE_CTO_LOGIN_URL).catch((error: unknown) => {
      const current = this.snapshots.get(grabId);
      if (!current) return;
      // 51CTO 登录页会持续保活/重定向，loadURL 的 promise 在抓取成功后调用
      // window.close() 时才以 ERR_FAILED 被 reject。此时凭据已经抓取并验证成功，
      // 不能让这次延迟的 reject 覆盖成功的快照。仅当加载在抓到凭据之前就失败时记为 error。
      if (!shouldRecordCookieGrabLoadError(current.status)) return;
      this.snapshots.set(grabId, {
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "无法打开 51CTO 登录页。"
      });
      state.runtimeInfoLogger?.({ grabId, status: "error" }, "51cto cookie grab load failed");
    });

    return grabId;
  }

  /** Query the current snapshot of a grab. */
  getStatus(grabId: string): FiftyoneCtoGrabSnapshot | undefined {
    return this.snapshots.get(grabId);
  }

  private clearPoll(grabId: string): void {
    const poll = this.pollTimers.get(grabId);
    if (poll) clearInterval(poll);
    this.pollTimers.delete(grabId);
  }

  /** Destroy every grab window (used by destroyAuxiliaryWindows). */
  destroyAll(): void {
    for (const window of this.windows.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.windows.clear();
    this.snapshots.clear();
    this.settleTimers.clear();
    this.pollTimers.clear();
    this.activeGrabId = undefined;
  }

  private async handleCookieChanged(grabId: string, window: BrowserWindow): Promise<void> {
    const current = this.snapshots.get(grabId);
    if (!current || current.status !== "waiting_login" || window.isDestroyed()) return;
    const cookies = await window.webContents.session.cookies.get({});
    if (!hasLoginCandidate(cookies)) return;

    const existing = this.settleTimers.get(grabId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => void this.grab(grabId, window), COOKIE_SETTLE_MS);
    this.settleTimers.set(grabId, timer);
  }

  private async grab(grabId: string, window: BrowserWindow): Promise<void> {
    const current = this.snapshots.get(grabId);
    if (!current || current.status !== "waiting_login" || window.isDestroyed()) return;
    this.settleTimers.delete(grabId);

    const now = Date.now();
    if (current.lastVerifyAt && now - current.lastVerifyAt < VERIFY_THROTTLE_MS) return;

    this.snapshots.set(grabId, { ...current, status: "grabbing" });
    state.runtimeInfoLogger?.({ grabId, status: "grabbing" }, "51cto cookie grab capturing credentials");

    try {
      const cookies = await window.webContents.session.cookies.get({});
      const cookie = buildCookieString(cookies);
      if (!cookie) {
        this.snapshots.set(grabId, { ...current, status: "error", error: "未能从登录窗口读取到 Cookie。" });
        return;
      }

      const verified = await this.verify(cookie);
      const settled = this.snapshots.get(grabId);
      if (!settled || settled.status !== "grabbing" || window.isDestroyed()) return;

      if (!verified) {
        this.snapshots.set(grabId, {
          ...settled,
          status: "waiting_login",
          lastVerifyAt: now,
          error: "登录态验证未通过（接口未返回登录态），请确认窗口内确实已登录 51CTO。"
        });
        state.runtimeInfoLogger?.({ grabId, status: "waiting_login" }, "51cto cookie grab verification failed, waiting for login");
        return;
      }

      this.clearPoll(grabId);
      this.snapshots.set(grabId, {
        grabId,
        accountId: settled.accountId,
        status: "success",
        cookie,
        verified: true,
        lastVerifyAt: now
      });
      state.runtimeInfoLogger?.({ grabId, status: "success", verified: true }, "51cto cookie grab success");
      if (!window.isDestroyed()) window.close();
    } catch (error) {
      const settled = this.snapshots.get(grabId);
      if (!settled) return;
      this.clearPoll(grabId);
      this.snapshots.set(grabId, {
        ...settled,
        status: "error",
        error: error instanceof Error ? error.message : "抓取 51CTO 凭据失败。"
      });
      state.runtimeInfoLogger?.({ grabId, status: "error" }, "51cto cookie grab failed");
    }
  }

  private async verify(cookie: string): Promise<boolean> {
    if (!cookie) return false;
    try {
      // 直接用发布页本身做登录态校验：GET 发布页，已登录返回 200 + 编辑器页，
      // 未登录则 302 跳转登录页或返回带密码框的登录页 HTML。
      // 不再用 getUploadSign（图片上传签名，匿名即可返回 code:0），否则会出现
      // “verify 通过但发布时却说 Cookie 已过期”的假阳性。
      const response = await fetch(FIFTYONE_CTO_PUBLISH_PAGE_URL, {
        method: "GET",
        headers: { "User-Agent": FIFTYONE_CTO_PAGE_USER_AGENT, Cookie: cookie },
        redirect: "manual"
      });
      const location = response.headers.get("location") ?? undefined;
      const html = response.status === 200 ? await response.text() : "";
      const ok = isAuthenticatedFiftyoneCtoPublishPage({ status: response.status, location, html });
      if (!ok) {
        state.runtimeInfoLogger?.(
          { status: response.status, location: location?.slice(0, 120) },
          "51cto cookie grab verify: publish page indicates not authenticated"
        );
      }
      return ok;
    } catch (error) {
      state.runtimeInfoLogger?.(
        { error: error instanceof Error ? error.message : String(error) },
        "51cto cookie grab verify: exception"
      );
      return false;
    }
  }
}

export { FiftyoneCtoChannelError };
