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

/** 登录态校验：GET 发布页的响应是否代表“已登录的发布编辑器页”（而非登录页）。 */
export interface FiftyoneCtoPublishPageCheck {
  /** HTTP 状态码（redirect:"manual" 下可能见到 3xx）。 */
  status: number;
  /** 重定向目标（仅 3xx 时有意义）。 */
  location?: string;
  /** 响应体 HTML。 */
  html: string;
}

/**
 * 判定 51CTO 发布页响应是否为“已登录状态”：
 * - 任何 3xx 重定向（通常跳 passport 登录页）→ 判失败；
 * - 非 200 → 判失败；
 * - 已登录的发布编辑器页由服务端渲染，一定含 am-editor 编辑器容器
 *   （am-engine / editor-container）。未登录返回的是登录页，不含该标记。
 *
 * 早期方案检测“是否含 <input type="password">”会假阳性：51CTO 的登录页密码框
 * 由前端 JS 渲染，初始 HTML 里没有密码框，导致匿名 Cookie 也被判为已登录，
 * 后续发布才暴露“Cookie 已过期/非 JSON 响应”。因此改用正向标记——只有真正
 * 渲染出编辑器容器才视为已登录。
 *
 * 注意：不要再用 getUploadSign（图片上传签名，匿名即可返回 code:0）做校验，
 * 那同样会让未真正登录的 Cookie 通过验证。
 */
export function isAuthenticatedFiftyoneCtoPublishPage(check: FiftyoneCtoPublishPageCheck): boolean {
  if (check.status >= 300 && check.status < 400) return false;
  if (check.status !== 200) return false;
  const html = check.html.toLowerCase();
  return /am-engine|editor-container/.test(html);
}
