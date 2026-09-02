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
 * 登录态校验：用 Cookie 去请求 51CTO 博客首页（SSR），检查响应 HTML 里的
 * 登录态标记。首页导航由服务端渲染，登录/未登录的标记直接写在初始 HTML 中：
 * - 已登录：右上角是 <li class="more user">（用户菜单，含「退出」）；
 * - 未登录：右上角是 <li class="logins">，含「登录 / 注册」入口。
 *
 * 注意：匿名首页也包含 头像 data-uid（文章作者，约 10 处）与内联 CSS 类名
 * login-out（约 1 处），因此 data-uid / login-out 不能作为正向判据，否则会
 * 把未登录 Cookie 误判为已登录。可靠的唯一正向标记是 class="more user"，
 * 唯一负向标记是 class="logins"。
 *
 * 为什么不用地址栏 URL：未登录时地址栏同样可以是 blog.51cto.com，纯域名判断
 * 会假阳性。为什么不用 fetch 发布页看 am-editor：发布页是 SPA，初始 HTML 是
 * 空壳、不含编辑器容器，导致“已登录却 verify 失败”。首页 SSR 标记最可靠。
 */
export function isFiftyoneCtoLoggedInHtml(html: string): boolean {
  if (!html) return false;
  const lower = html.toLowerCase();
  // 明确的未登录标记优先判失败（class="logins" 是未登录导航专属）。
  if (/class="logins"/.test(lower)) return false;
  // 已登录正向标记：仅认 <li class="more user">（其它标记在匿名页也会命中）。
  return /class="more user"/.test(lower);
}

/** 仅保留 51CTO 域（含子域）下的 Cookie，剔除抓取会话中混入的其它站点 Cookie。 */
export function filterFiftyoneCtoCookies(cookies: CookieEntry[]): CookieEntry[] {
  return cookies.filter((entry) => {
    const domain = entry.domain?.toLowerCase() ?? "";
    return domain === "51cto.com" || domain.endsWith(".51cto.com");
  });
}
