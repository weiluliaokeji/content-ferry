/**
 * Pure helpers for the 51CTO cookie grabber.
 *
 * Kept free of any Electron import so the module can be unit-tested under the
 * plain Vitest process (ELECTRON_RUN_AS_NODE mode does not expose the Electron
 * module API, only the executable path string).
 */

/** 51CTO 登录窗口抓取状态。 */
export type FiftyoneCtoGrabStatus = "waiting_login" | "grabbing" | "success" | "cancelled" | "error";

/** 抓取任务快照（HTTP status 路由的返回值）。 */
export interface FiftyoneCtoGrabSnapshot {
  grabId: string;
  accountId: string;
  status: FiftyoneCtoGrabStatus;
  cookie?: string;
  verified?: boolean;
  error?: string;
  /** 最近一次接口验证时间戳（毫秒），用于节流避免高频重复验证。 */
  lastVerifyAt?: number;
}

export interface CookieEntry {
  name: string;
  value: string;
  domain?: string;
}

/** 登录候选判定：存在 51cto 域下任一非空会话类 Cookie 即触发验证。 */
export function hasLoginCandidate(cookies: CookieEntry[]): boolean {
  return cookies.some((entry) => {
    const domain = entry.domain?.toLowerCase() ?? "";
    return domain.includes("51cto") && Boolean(entry.value);
  });
}

/** Cookie 拼接：name=value 以 "; " 连接，过滤空 name/空 value。 */
export function buildCookieString(cookies: CookieEntry[]): string {
  return cookies
    .filter((entry) => entry.name && entry.value)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
}

/**
 * loadURL 的 promise 在登录页保活/重定向场景下会延迟 reject（窗口关闭后才到达）。
 * 只有当抓取还停在初始 waiting_login（即加载在抓到凭据之前就失败）时才应记为 error，
 * 否则会覆盖已经成功的抓取结果。
 */
export function shouldRecordCookieGrabLoadError(status: FiftyoneCtoGrabStatus): boolean {
  return status === "waiting_login";
}

/**
 * 登录态校验：用抓取窗口当前的真实地址栏 URL 判断——而不是脱离窗口去 fetch
 * 一个固定页面再猜 HTML 标记。窗口本身是真实浏览器，用户已在其中登录，
 * 登录成功后地址栏必然停在 blog.51cto.com 域（写作/个人中心等），绝不会停在
 * passport 登录域。这是最直接的“已登录”证据。
 *
 * 为什么不用 fetch 发布页看标记：51CTO 的编辑器页与登录页都是 SPA，初始 HTML
 * 不含 am-editor 容器或密码框，且我们硬编码的发布页 URL 实际返回的不是编辑器
 * 页，导致两次“已登录却 verify 失败”的假阴性。地址栏 URL 由浏览器导航真实决定，
 * 不受 SPA 初始 HTML 影响，远比解析页面标记可靠。
 */
export function isFiftyoneCtoLoggedInPage(url: string): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    // passport 登录域（含 passport.51cto.com / login.51cto.com 等）→ 未登录
    if (/passport\.51cto\.com$|login\.51cto\.com$/.test(host)) return false;
    // 已登录：停在 51CTO 博客域（blog.51cto.com 或 *.blog.51cto.com）
    return host.endsWith("blog.51cto.com") || host === "51cto.com";
  } catch {
    return false;
  }
}
