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
