import dns from "node:dns";
import net from "node:net";
import { BrowserWindow, Menu, session, type MenuItem } from "electron";
import type { ContentProjectRepository } from "../content/content-project-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { ToolExecutionContext } from "./tool-runner";

export interface AwenPracticeWebCaptureInput {
  url: string;
  caption: string;
  operation?: PracticeWebOperation;
}

export type PracticeWebOperation =
  | { kind: "open" }
  | { kind: "search"; query: string }
  | { kind: "filter"; name: string; option: string }
  | { kind: "next_page" };

export interface AwenPracticeWebCaptureResult {
  title: string;
  url: string;
  observedAt: string;
  observation: string;
  assetUrl: string;
  screenshotMarkdown: string;
  screenshotSha256: string;
  operationSummary: string;
}

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], [0x0a000000, 0x0affffff], [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff], [0xa9fe0000, 0xa9feffff], [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff], [0xc0000000, 0xc00000ff], [0xc0000200, 0xc00002ff], [0xc0586300, 0xc05863ff],
  [0xc6120000, 0xc613ffff], [0xc6336400, 0xc63364ff], [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff]
];

function nonPublicAddressDescription(address: string): string {
  if (net.isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const value = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
    if (isRfc2544Address(address)) return "RFC 2544 基准测试专用网段 198.18.0.0/15";
    if (value >= 0x64400000 && value <= 0x647fffff) return "运营商级 NAT 专用网段 100.64.0.0/10";
    if (value >= 0x7f000000 && value <= 0x7fffffff) return "IPv4 回环地址段 127.0.0.0/8";
    if (value >= 0xa9fe0000 && value <= 0xa9feffff) return "IPv4 链路本地地址段 169.254.0.0/16";
    if (value >= 0x0a000000 && value <= 0x0affffff) return "IPv4 私有地址段 10.0.0.0/8";
    if (value >= 0xac100000 && value <= 0xac1fffff) return "IPv4 私有地址段 172.16.0.0/12";
    if (value >= 0xc0a80000 && value <= 0xc0a8ffff) return "IPv4 私有地址段 192.168.0.0/16";
  }
  return net.isIP(address) === 6 ? "本地或特殊用途 IPv6 地址段" : "本地或特殊用途 IPv4 地址段";
}

function isRfc2544Address(address: string): boolean {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  const value = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
  return value >= 0xc6120000 && value <= 0xc613ffff;
}

function describeBlockedPublicHost(hostname: string, addresses: Array<{ address: string }>): string {
  const ranges = [...new Set(addresses.map(({ address }) => nonPublicAddressDescription(address)))];
  const rangeDescription = ranges.length > 0 ? ranges.join("、") : "未返回可确认的公开地址";
  return `网页请求没有发送：${hostname} 在当前直连路线中解析到${rangeDescription}。文渡为避免访问本机或受限网络，已按安全策略拦截请求。请检查当前网络的 DNS、VPN 或代理路由后重试；如果只需要展示页面内容，请在浏览器中打开页面并把截图粘贴到文章。联网搜索摘要不能代替网页截图。`;
}

function isLocalOrSpecialHostname(hostname: string): boolean {
  return !hostname || !hostname.includes(".") || [
    ".localhost", ".local", ".internal", ".home.arpa", ".test", ".example", ".invalid", ".onion", ".lan"
  ].some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
}

export function isPrivateOrSpecialAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const value = (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
    return PRIVATE_IPV4_RANGES.some(([start, end]) => value >= start && value <= end);
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0];
    if (normalized === "::" || normalized === "::1") return true;
    const groups = expandIpv6(normalized);
    if (!groups) return true;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      const ipv4 = `${groups[6] >>> 8}.${groups[6] & 255}.${groups[7] >>> 8}.${groups[7] & 255}`;
      return isPrivateOrSpecialAddress(ipv4);
    }
    const first = groups[0];
    if (first < 0x2000 || first > 0x3fff) return true;
    if ((first === 0x2001 && groups[1] === 0x0db8) || first === 0x2002 || first === 0x3fff) return true;
    return false;
  }
  return true;
}

export function validatePublicWebUrl(rawUrl: string): URL {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("网页地址格式不正确。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("实践截图目前只允许打开公开 HTTPS 网页，不支持登录凭据或自定义端口。");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (isLocalOrSpecialHostname(hostname)) {
    throw new Error("为保护本机网络，实践网页必须是公开网站。");
  }
  if (net.isIP(hostname)) {
    if (isPrivateOrSpecialAddress(hostname)) throw new Error("为保护本机网络，不能打开本地或特殊用途 IP 地址。");
    return url;
  }
  return url;
}

export async function assertPublicWebRequestRoute(
  rawUrl: string,
  network: Pick<Electron.Session, "resolveHost" | "resolveProxy">,
  dnsServers: readonly string[] = dns.getServers()
): Promise<void> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("网页请求地址格式不正确。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("实践截图仅允许访问公开 HTTPS 网页。");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (isLocalOrSpecialHostname(hostname)) {
    throw new Error("为保护本机网络，实践网页必须是公开网站。");
  }
  if (net.isIP(hostname)) {
    if (isPrivateOrSpecialAddress(hostname)) throw new Error("为保护本机网络，不能访问本地或特殊用途 IP 地址。");
    return;
  }

  const proxyRoute = await network.resolveProxy(url.toString());
  const routes = proxyRoute.split(";").map((route) => route.trim()).filter(Boolean);
  const usesRemoteProxyWithoutDirectFallback = routes.length > 0 && routes.every((route) => !/^DIRECT$/iu.test(route));
  if (usesRemoteProxyWithoutDirectFallback) return;

  const { endpoints } = await network.resolveHost(hostname, { secureDnsPolicy: "allow", cacheUsage: "disallowed" });
  const systemFakeIpMode = dnsServers.some(isRfc2544Address);
  const hasUnsafeEndpoint = endpoints.some(({ address }) =>
    isPrivateOrSpecialAddress(address) && !(systemFakeIpMode && isRfc2544Address(address))
  );
  if (endpoints.length === 0 || hasUnsafeEndpoint) {
    throw new Error(describeBlockedPublicHost(hostname, endpoints.map(({ address }) => ({ address }))));
  }
}

export function validateLowRiskWebActionUrl(rawUrl: string, authorizedOrigin: string): URL {
  let candidate: URL;
  try { candidate = new URL(rawUrl); } catch { throw new Error("网页操作没有生成有效的站内地址。"); }
  if (candidate.protocol !== "https:" || candidate.origin !== authorizedOrigin) {
    throw new Error("网页操作只能留在本次授权的 HTTPS 站点内。");
  }
  const path = decodeURIComponent(candidate.pathname).toLowerCase();
  if (/(?:^|[\/_-])(logout|logoff|signout|delete|remove|destroy|purchase|checkout|payment|publish|submit|unsubscribe|follow|unfollow|comment|like|send|transfer|account|settings|subscribe)(?:$|[\/_-])/iu.test(path)) {
    throw new Error("该链接看起来可能会提交内容、改变账号或执行外部操作，文渡已停止。");
  }
  for (const [key, value] of candidate.searchParams) {
    if (/^(?:action|cmd|command|do|intent|method|operation|task|submit)$/iu.test(key) &&
        /(?:logout|delete|remove|destroy|purchase|checkout|pay|publish|submit|unsubscribe|follow|comment|like|send|transfer|subscribe)/iu.test(value)) {
      throw new Error("该筛选地址包含可能产生外部影响的操作，文渡已停止。");
    }
  }
  return candidate;
}

export function isAuthenticationChallenge(page: { title: string; text: string; url?: string; hasPasswordField?: boolean }): boolean {
  let authenticationPath = false;
  try { authenticationPath = /(?:^|\/)(?:login|log[_-]?in|signin|sign[_-]?in|authenticate|oauth|sso|captcha|challenge)(?:\/|$)/iu.test(new URL(page.url ?? "").pathname); }
  catch { /* URL-less historical/test snapshots use the visible page content below. */ }
  return authenticationPath || page.hasPasswordField === true || /captcha|verify you are human|unusual traffic|security check|sign in to continue|log in to continue|验证码|安全验证|请登录|登录后查看/i.test(`${page.title} ${page.text.slice(0, 1500)}`);
}

export function isAllowedManualHandoverNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    if (isLocalOrSpecialHostname(hostname)) return false;
    return net.isIP(hostname) === 0 || !isPrivateOrSpecialAddress(hostname);
  } catch { return false; }
}

export function canOpenManualHandoverPopup(rawUrl: string, manualHandover: boolean): boolean {
  return manualHandover && isAllowedManualHandoverNavigation(rawUrl);
}

export function isAuthenticationPost(rawUrl: string): boolean {
  if (!isAllowedManualHandoverNavigation(rawUrl)) return false;
  const url = new URL(rawUrl);
  if (/(?:^|[\/_-])(?:logout|logoff|signout|delete|remove|destroy|purchase|checkout|payment|publish|submit|unsubscribe|follow|comment|like|send|transfer)(?:$|[\/_-])/iu.test(url.pathname)) return false;
  if (Array.from(url.searchParams).some(([key, value]) => /^(?:action|cmd|command|do|intent|method|operation|task|submit)$/iu.test(key) &&
    /(?:logout|delete|remove|destroy|purchase|checkout|pay|publish|submit|unsubscribe|follow|comment|like|send|transfer)/iu.test(value))) return false;
  return /(?:^|\/)(?:login|log[_-]?in|sign[_-]?in|authenticate|oauth\/token|sso\/callback|captcha\/verify|challenge\/verify|verify-captcha)(?:\/|$)/iu.test(url.pathname);
}

export class AwenPracticeWebCapture {
  constructor(private readonly contentSources: ContentSourceService, private readonly contentProjects: ContentProjectRepository) {}

  async capture(input: AwenPracticeWebCaptureInput, context: ToolExecutionContext): Promise<AwenPracticeWebCaptureResult> {
    if (!context.workflowId || !context.projectId) throw new Error("网页截图需要关联当前文章的实践任务。");
    const url = validatePublicWebUrl(input.url);
    if (context.target !== url.origin) throw new Error("网页授权目标与实际访问站点不一致，请让阿文重新提交该网页目标。");
    const project = this.contentProjects.require(context.projectId);
    if (!project.sourceRelativePath) throw new Error("当前文章还没有可保存素材的文章路径，无法把截图写入文章。");

    const partition = `awen-practice-${context.workflowId.replace(/[^a-z0-9-]/giu, "")}`;
    let manualHandover = false;
    const browserSession = session.fromPartition(partition, { cache: false });
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.on("will-download", (_event, item) => item.cancel());
    let networkBlockReason: string | undefined;
    browserSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
      const safeMethod = details.method === "GET" || details.method === "HEAD";
      const humanAuthPost = manualHandover && details.method === "POST" && isAuthenticationPost(details.url);
      if ((!safeMethod && !humanAuthPost) || !details.url.startsWith("https://")) {
        networkBlockReason = "网页请求使用了未授权的方法或非 HTTPS 地址，文渡已拦截。";
        callback({ cancel: true });
        return;
      }
      void assertPublicWebRequestRoute(details.url, browserSession).then(
        () => callback({ cancel: false }),
        (error: unknown) => {
          networkBlockReason ??= error instanceof Error ? error.message : "无法确认网页请求的网络目标，文渡已拦截。";
          callback({ cancel: true });
        }
      );
    });

    const window = new BrowserWindow({
      width: 1180,
      height: 820,
      show: true,
      title: `文渡 · 阿文验证 · ${url.hostname}`,
      autoHideMenuBar: false,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    });
    const authPopups = new Set<BrowserWindow>();
    const setManualHandover = (enabled: boolean) => {
      manualHandover = enabled;
      if (!enabled) {
        for (const popup of authPopups) if (!popup.isDestroyed()) popup.destroy();
        authPopups.clear();
      }
    };
    const popupOptions = {
      width: 900,
      height: 720,
      show: true,
      autoHideMenuBar: false,
      webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
    };
    const registerAuthPopup = (popup: BrowserWindow, depth: number): void => {
      if (popup.webContents.session !== browserSession) {
        popup.destroy();
        return;
      }
      authPopups.add(popup);
      popup.once("closed", () => authPopups.delete(popup));
      popup.webContents.setWindowOpenHandler(({ url: popupUrl }) =>
        depth < 2 && canOpenManualHandoverPopup(popupUrl, manualHandover)
          ? { action: "allow", overrideBrowserWindowOptions: popupOptions }
          : { action: "deny" }
      );
      const restrictPopupNavigation = (_event: Electron.Event, navigationUrl: string) => {
        if (!canOpenManualHandoverPopup(navigationUrl, manualHandover)) _event.preventDefault();
      };
      popup.webContents.on("will-navigate", restrictPopupNavigation);
      popup.webContents.on("will-redirect", restrictPopupNavigation);
      popup.webContents.on("did-create-window", (nestedPopup) => registerAuthPopup(nestedPopup, depth + 1));
    };
    let resumeManualPage: (() => void) | undefined;
    let resumeReadOnlyItem: MenuItem | undefined;
    const menu = Menu.buildFromTemplate([{ label: "网页实践", submenu: [
      { label: "若页面要求登录或验证码，请在此窗口手动处理。", enabled: false },
      { type: "separator" },
      { label: "我已完成并返回原网站，继续只读验证", enabled: false, click: () => resumeManualPage?.() }
    ] }]);
    resumeReadOnlyItem = menu.items[0]?.submenu?.items[2];
    window.setMenu(menu);
    window.webContents.setWindowOpenHandler(({ url: popupUrl }) =>
      canOpenManualHandoverPopup(popupUrl, manualHandover)
        ? { action: "allow", overrideBrowserWindowOptions: popupOptions }
        : { action: "deny" }
    );
    window.webContents.on("did-create-window", (popup) => registerAuthPopup(popup, 1));
    window.webContents.on("will-navigate", (event, navigationUrl) => {
      try {
        const next = new URL(navigationUrl);
        if (!isAllowedManualHandoverNavigation(navigationUrl) || (!manualHandover && next.origin !== url.origin)) event.preventDefault();
      } catch { event.preventDefault(); }
    });
    window.webContents.on("will-redirect", (event, navigationUrl) => {
      try {
        const next = new URL(navigationUrl);
        if (!isAllowedManualHandoverNavigation(navigationUrl) || (!manualHandover && next.origin !== url.origin)) event.preventDefault();
      } catch { event.preventDefault(); }
    });
    const abortCapture = () => { if (!window.isDestroyed()) window.destroy(); };
    context.signal?.addEventListener("abort", abortCapture, { once: true });

    try {
      if (context.signal?.aborted) throw new Error("网页实践已取消。");
      let loadTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          window.loadURL(url.toString()),
          new Promise<never>((_resolve, reject) => { loadTimeout = setTimeout(() => reject(new Error("打开网页超时；未保存截图。")), 30_000); })
        ]);
      } catch (error) {
        if (networkBlockReason) throw new Error(networkBlockReason);
        throw error;
      } finally { if (loadTimeout) clearTimeout(loadTimeout); }
      if (context.signal?.aborted) throw new Error("网页实践已取消。");
      let page = await readCurrentPage(window);
      if (new URL(page.url).origin !== url.origin) throw new Error("页面跳转到了未授权的网站，文渡已停止本次读取。");
      if (isAuthenticationChallenge(page)) {
        await waitForManualHandover(window, url.origin, resumeReadOnlyItem, context.signal, setManualHandover, (resume) => { resumeManualPage = resume; });
        manualHandover = false;
        page = await readCurrentPage(window);
        if (new URL(page.url).origin !== url.origin) throw new Error("手动处理后请先返回本次授权的网站，再继续只读验证。");
        assertPublicReadablePage(page);
      }
      const operation = input.operation ?? { kind: "open" as const };
      const operationSummary = summarizeOperation(operation);
      if (operation.kind !== "open") {
        const proposedUrl = await readLowRiskOperationUrl(window, operation);
        const nextUrl = validateLowRiskWebActionUrl(proposedUrl, url.origin);
        if (context.signal?.aborted) throw new Error("网页实践已取消。");
        try { await window.loadURL(nextUrl.toString()); }
        catch (error) { if (networkBlockReason) throw new Error(networkBlockReason); throw error; }
        if (context.signal?.aborted) throw new Error("网页实践已取消。");
        page = await readCurrentPage(window);
        if (new URL(page.url).origin !== url.origin) throw new Error("网页操作跳转到了未授权的网站，文渡已停止本次读取。");
        if (isAuthenticationChallenge(page)) {
          await waitForManualHandover(window, url.origin, resumeReadOnlyItem, context.signal, setManualHandover, (resume) => { resumeManualPage = resume; });
          manualHandover = false;
          page = await readCurrentPage(window);
          if (new URL(page.url).origin !== url.origin) throw new Error("手动处理后请先返回本次授权的网站，再继续只读验证。");
          assertPublicReadablePage(page);
        }
      }
      const image = await window.webContents.capturePage();
      const png = image.toPNG();
      if (png.length === 0 || png.length > 15 * 1024 * 1024) throw new Error("网页截图为空或超过文章图片大小限制，没有保存截图。");
      const capturedAt = new Date().toISOString();
      const saved = this.contentSources.saveArticlePracticeCapture(project.workspaceId, project.sourceRelativePath, png.toString("base64"), {
        title: page.title || url.hostname,
        sourceUrl: page.url,
        capturedAt,
        conditions: `公开 HTTPS 页面；${shareableOperationSummary(operation)}；常规读取仅允许 GET/HEAD；用户人工处理登录期间只放行认证路径 POST，恢复后仅在原授权站点只读访问；阻止危险提交路径和非公开网络地址。随文来源网址已省略查询参数与片段。`
      });
      return {
        title: page.title || url.hostname,
        url: page.url,
        observedAt: capturedAt,
        observation: page.text,
        assetUrl: saved.assetUrl,
        screenshotMarkdown: `![${sanitizeMarkdownAlt(input.caption || page.title || "网页实践截图")}](${saved.assetUrl})`,
        screenshotSha256: saved.sha256,
        operationSummary
      };
    } finally {
      context.signal?.removeEventListener("abort", abortCapture);
      setManualHandover(false);
      if (!window.isDestroyed()) window.destroy();
      await browserSession.clearStorageData().catch(() => undefined);
    }
  }
}

async function readCurrentPage(window: BrowserWindow): Promise<{ title: string; url: string; text: string; hasPasswordField: boolean }> {
  return await window.webContents.executeJavaScript(`(() => ({ title: document.title.slice(0, 300), url: location.href, text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 8000), hasPasswordField: Array.from(document.querySelectorAll('input[type="password"]')).some((input) => !input.disabled && input.getClientRects().length && getComputedStyle(input).visibility !== "hidden") }))()`, true) as { title: string; url: string; text: string; hasPasswordField: boolean };
}

function assertPublicReadablePage(page: { title: string; text: string; hasPasswordField?: boolean }): void {
  if (isAuthenticationChallenge(page)) throw new Error("登录或验证码处理后页面仍显示验证要求；文渡没有读取页面内容。请完成验证或停止本次实践。");
}

async function waitForManualHandover(
  window: BrowserWindow,
  authorizedOrigin: string,
  resumeItem: MenuItem | undefined,
  signal: AbortSignal | undefined,
  setManualHandover: (enabled: boolean) => void,
  setResumeHandler: (resume: (() => void) | undefined) => void
): Promise<void> {
  if (!resumeItem || window.isDestroyed()) throw new Error("无法打开网页人工接管入口。");
  setManualHandover(true);
  resumeItem.enabled = true;
  window.setTitle("文渡 · 请手动完成登录或验证码，然后返回原网站并从“网页实践”菜单继续");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error("网页实践已取消。"));
    const onClosed = () => reject(new Error("网页窗口已关闭，登录接管没有完成。"));
    const onResume = () => {
      if (window.isDestroyed()) return onClosed();
      let current: URL;
      try { current = new URL(window.webContents.getURL()); }
      catch { window.setTitle("请返回本次授权的网站后，再从“网页实践”菜单继续"); return; }
      if (current.origin !== authorizedOrigin) {
        window.setTitle("请返回本次授权的网站后，再从“网页实践”菜单继续");
        return;
      }
      if (current.protocol !== "https:") return;
      setManualHandover(false);
      resumeItem.enabled = false;
      window.setTitle(`文渡 · 阿文验证 · ${current.hostname}（只读）`);
      setResumeHandler(undefined);
      signal?.removeEventListener("abort", onAbort);
      window.removeListener("closed", onClosed);
      resolve();
    };
    setResumeHandler(onResume);
    signal?.addEventListener("abort", onAbort, { once: true });
    window.once("closed", onClosed);
    if (signal?.aborted) onAbort();
  });
}

async function readLowRiskOperationUrl(window: BrowserWindow, operation: Exclude<PracticeWebOperation, { kind: "open" }>): Promise<string> {
  const serialized = JSON.stringify(operation);
  const result = await window.webContents.executeJavaScript(`(() => {
    const op = ${serialized};
    const visible = (element) => Boolean(element && !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
    const sameOriginUrl = (value) => { const next = new URL(value || location.href, location.href); if (next.origin !== location.origin || next.protocol !== "https:") throw new Error("当前页面没有可安全使用的站内操作入口。"); return next; };
    const formUrl = (form) => {
      if (form && String(form.getAttribute("method") || "get").toLowerCase() !== "get") throw new Error("该页面的表单不是只读 GET 查询，文渡没有提交。");
      return sameOriginUrl(form?.getAttribute("action") || location.href);
    };
    if (op.kind === "search") {
      const input = Array.from(document.querySelectorAll("input[type=search], input[name]"))
        .find((element) => visible(element) && (element.type === "search" || /^(q|query|search|keyword|keywords)$/i.test(element.name)));
      if (!input || !input.name) throw new Error("没有找到公开的站内搜索框。");
      const next = formUrl(input.form);
      next.searchParams.set(input.name, op.query);
      return next.href;
    }
    if (op.kind === "filter") {
      const normalized = (value) => String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const select = Array.from(document.querySelectorAll("select[name]"))
        .find((element) => visible(element) && (normalized(element.name) === normalized(op.name) || normalized(element.getAttribute("aria-label")) === normalized(op.name) || Array.from(element.labels || []).some((label) => normalized(label.innerText) === normalized(op.name))));
      if (!select) throw new Error("没有找到名称匹配的公开筛选项。");
      const option = Array.from(select.options).find((item) => normalized(item.label || item.textContent) === normalized(op.option));
      if (!option || !select.name) throw new Error("筛选选项不存在，文渡没有更改页面。");
      const next = formUrl(select.form);
      next.searchParams.set(select.name, option.value);
      return next.href;
    }
    if (op.kind === "next_page") {
      const links = Array.from(document.querySelectorAll("a[href]"));
      const link = links.find((element) => {
        const label = (element.innerText || element.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().toLowerCase();
        return visible(element) && (element.rel.split(/\\s+/).includes("next") || ["next", "next page", "下一页", "下一頁", "›", "»"].includes(label));
      });
      if (!link) throw new Error("当前页面没有找到明确标记的下一页链接。");
      return sameOriginUrl(link.href).href;
    }
    throw new Error("不支持此网页操作。");
  })()`, true) as unknown;
  if (typeof result !== "string") throw new Error("网页没有返回安全的站内操作地址。");
  return result;
}

function summarizeOperation(operation: PracticeWebOperation): string {
  switch (operation.kind) {
    case "open": return "只读打开页面";
    case "search": return "执行站内搜索";
    case "filter": return "使用页面公开的筛选项";
    case "next_page": return "打开下一页";
  }
}

export function shareableOperationSummary(operation: PracticeWebOperation): string {
  switch (operation.kind) {
    case "open": return "只读打开页面";
    case "search": return "执行站内搜索（不随文章记录搜索词）";
    case "filter": return "使用页面公开的筛选项（不随文章记录筛选值）";
    case "next_page": return "打开下一页";
  }
}

function sanitizeMarkdownAlt(value: string): string {
  return value.replace(/[\[\]\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 100) || "网页实践截图";
}

function expandIpv6(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseHalf = (value: string) => value ? value.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || halves.length === 1 && missing !== 0 || halves.length === 2 && missing < 1) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}
