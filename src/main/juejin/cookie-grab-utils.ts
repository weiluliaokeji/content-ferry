/**
 * Pure helpers for the Juejin cookie grabber.
 *
 * Kept free of any Electron import so the module can be unit-tested under the
 * plain Vitest process (ELECTRON_RUN_AS_NODE mode does not expose the Electron
 * module API, only the executable path string).
 */

/** 掘金 AID 默认值。 */
export const DEFAULT_JUJIN_AID = "2608";

export interface CookieEntry {
  name: string;
  value: string;
}

/** 掘金登录窗口抓取状态。 */
export type JuejinGrabStatus = "waiting_login" | "grabbing" | "success" | "cancelled" | "error";

/** 抓取任务快照（HTTP status 路由的返回值）。 */
export interface JuejinGrabSnapshot {
  grabId: string;
  accountId: string;
  status: JuejinGrabStatus;
  cookie?: string;
  aid?: string;
  uuid?: string;
  verified?: boolean;
  error?: string;
  /** 最近一次接口验证时间戳（毫秒），用于节流避免高频重复验证。 */
  lastVerifyAt?: number;
}

/**
 * 登录候选判定：存在 sessionid 或 passport_csrf_token 仅表示"可能是登录态"。
 * 未登录时掘金也会种匿名 passport_csrf_token / sessionid，因此本函数只是
 * 触发抓取流程的候选条件，**真正判定登录成功以接口验证 err_no === 0 为准**。
 */
export function hasLoginCandidate(cookies: CookieEntry[]): boolean {
  return cookies.some(
    (entry) =>
      entry.name.includes("sessionid") ||
      entry.name.includes("passport_csrf_token")
  );
}

/** Cookie 拼接：name=value 以 "; " 连接，过滤空 name/空 value。 */
export function buildCookieString(cookies: CookieEntry[]): string {
  return cookies
    .filter((entry) => entry.name && entry.value)
    .map((entry) => `${entry.name}=${entry.value}`)
    .join("; ");
}

/** 从 Cookie 中提取 UUID 兜底候选（优先 uuid 键，其次 sessionid 的提取值）。 */
export function extractUuidFromCookie(cookies: CookieEntry[]): string {
  const byName = new Map(cookies.map((entry) => [entry.name, entry.value]));
  return byName.get("uuid") ?? byName.get("sessionid") ?? "";
}

/** UUID 解析：localStorage 优先，Cookie 兜底，全空返回空串。 */
export function resolveUuid(localStorageUuid: string | null | undefined, cookies: CookieEntry[]): string {
  if (localStorageUuid && localStorageUuid.trim()) return localStorageUuid.trim();
  return extractUuidFromCookie(cookies).trim();
}

/** 验证结果映射：err_no === 0 视为有效。 */
export function mapVerifyResult(errNo: number | string | null | undefined): boolean {
  if (errNo === null || errNo === undefined) return false;
  return Number(errNo) === 0;
}
