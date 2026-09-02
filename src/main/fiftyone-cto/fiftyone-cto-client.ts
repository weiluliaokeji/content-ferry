import { FiftyoneCtoCredentialsError } from "./fiftyone-cto-channel-error";

type FetchLike = typeof fetch;

export interface FiftyoneCtoPublishResult {
  status: number;
  blogId?: string;
  url?: string;
  msg?: string;
}

export interface FiftyoneCtoPublishInput {
  title: string;
  contentHtml: string;
  tags: string;
  blogType: "1" | "2" | "3";
  pid: string;
  cateId: string;
  /** 文章摘要（来自草稿 digest）。51CTO 摘要字段为 abstract。 */
  abstract?: string;
}

export class CTOClient {
  static readonly PUBLISH_URL = "https://blog.51cto.com/blogger/publish";
  static readonly PAGE_URL = "https://blog.51cto.com/blogger/publish?old=1&orig=first-publish";

  private readonly baseHeaders: Record<string, string>;
  /**
   * 发布页 GET 响应下发的当次 `_csrf` cookie。
   * Yii2 要求 POST 的 `_csrf` 参数必须与请求里的 `_csrf` cookie 完全一致，否则
   * 直接返回 404「文章不存在或已删除」页（与不存在的路由同款），被误判成登录失效。
   * 存储的 Cookie 串里的 `_csrf` 来自更早的抓取会话，与本次 GET 取到的 csrf-token
   * 不一致，因此必须用当次 GET 下发的 `_csrf` cookie 覆盖后再 POST。
   */
  private freshCsrfCookie: string | undefined;

  constructor(private readonly cookie: string, private readonly fetcher: FetchLike = fetch) {
    this.baseHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
      Cookie: cookie
    };
  }

  /** 从发布页抓取 CSRF token、pid（一级栏目）、cate_id（二级/授权分类），并记下当次 _csrf cookie。 */
  async fetchConfig(): Promise<{ csrfToken: string; pid: string; cateId: string }> {
    const result = { csrfToken: "", pid: "", cateId: "" };
    const req = new Request(CTOClient.PAGE_URL, { headers: this.baseHeaders });
    const resp = await this.fetcher(req);
    const html = await resp.text();

    const csrf = /<meta\s+name="csrf-token"\s+content="([^"]+)"/.exec(html);
    if (csrf) result.csrfToken = csrf[1];

    // 取当次 GET 下发的 _csrf cookie（与上面的 csrf-token meta 同源），用于 POST 时覆盖旧 cookie。
    this.freshCsrfCookie = extractSetCookieValue(resp.headers, "_csrf");

    const pid = /pid:\s*'(\d+)'/.exec(html);
    if (pid) result.pid = pid[1];

    const cate = /cate_id:\s*'(\d+)'/.exec(html);
    if (cate) result.cateId = cate[1];

    // 兜底值（来自参考实现）
    if (!result.pid) result.pid = "176";
    if (!result.cateId) result.cateId = "200";
    return result;
  }

  async post(input: FiftyoneCtoPublishInput): Promise<FiftyoneCtoPublishResult> {
    const config = await this.fetchConfig();
    if (!config.csrfToken) {
      throw new FiftyoneCtoCredentialsError("无法获取 51CTO CSRF token，请检查 Cookie 是否有效。");
    }

    const pid = input.pid || config.pid;
    const cateId = input.cateId || config.cateId;

    const body = new URLSearchParams({
      title: input.title,
      content: input.contentHtml,
      pid,
      cate_id: cateId,
      tag: input.tags,
      abstract: input.abstract ?? "",
      blog_type: input.blogType,
      copy_code: "1",
      is_old: "0",
      check: "0",
      _csrf: config.csrfToken
    });

    // Yii2 要求 _csrf 参数与 _csrf cookie 一致：用当次 GET 下发的 _csrf 覆盖存储串里的旧值。
    const cookieHeader = mergeCsrfCookie(this.cookie, this.freshCsrfCookie);

    const headers: Record<string, string> = {
      ...this.baseHeaders,
      Cookie: cookieHeader,
      accept: "application/json, text/javascript, */*; q=0.01",
      "accept-language": "zh-CN,zh;q=0.9",
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      origin: "https://blog.51cto.com",
      referer: CTOClient.PAGE_URL,
      "x-requested-with": "XMLHttpRequest"
    };

    const resp = await this.fetcher(CTOClient.PUBLISH_URL, {
      method: "POST",
      headers,
      body: body.toString()
    });
    const text = await resp.text();
    let parsed: { status?: number; msg?: string; data?: { blog_id?: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      // 发布接口返回了 HTML（通常是登录页）而非 JSON：说明 Cookie 没有通过
      // 登录态校验。用更准确文案替代含糊的“可能已过期”，便于定位。
      // 仅匹配真正的登录/鉴权页标记，避免误命中发布接口返回的 404「文章不存在」页
      // （该页内联脚本含 login.js、退出按钮含 login-out 类，裸 login 正则会误判为登录页）。
      const looksLikeLoginPage =
        /<!DOCTYPE|<html/i.test(text) &&
        /passport|请登录|登录后|未登录|账号登录|登录 51CTO|立即登录|去登录/i.test(text);
      if (looksLikeLoginPage) {
        throw new FiftyoneCtoCredentialsError("51CTO 返回的是登录页，Cookie 无效或未登录。请重新在账号管理获取最新 Cookie 后重试。");
      }
      throw new FiftyoneCtoCredentialsError(`51CTO 返回非 JSON 响应，可能 Cookie 已过期：${text.slice(0, 200)}`);
    }
    if (parsed.status === 1 && parsed.data?.blog_id) {
      return { status: 1, blogId: parsed.data.blog_id, url: `https://blog.51cto.com/${parsed.data.blog_id}` };
    }
    throw new FiftyoneCtoCredentialsError(parsed.msg || `51CTO 发布失败（status=${parsed.status ?? "未知"}）。`);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 将 Markdown 转为 51CTO 兼容的 HTML，并包裹进 am-editor 的 editor-container 结构。
 * 图片已是 data URI 或公网 URL，这里只做语法转换。
 */
export function mdToHtml51(md: string): string {
  const lines = md.split(/\r?\n/);
  const html: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const flushList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  const inline = (text: string): string =>
    text
      .replace(/!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_m, alt: string, url: string) => `<img src="${url}" alt="${alt}">`)
      .replace(/\[([^\]]+)]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code class="language-${codeLang}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        inCode = false;
        codeBuf = [];
        codeLang = "";
        continue;
      }
      inCode = true;
      codeLang = line.slice(3).trim();
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    flushList();
    if (!line.trim()) continue;

    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.+)$/.exec(line))) {
      const level = m[1].length;
      html.push(`<h${level}>${inline(m[2])}</h${level}>`);
      continue;
    }
    if (/^[-*_]{3,}$/.test(line.trim())) {
      html.push("<hr>");
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      html.push(`<blockquote>${inline(m[1])}</blockquote>`);
      continue;
    }
    if ((m = /^[-*+]\s+(.+)$/.exec(line))) {
      if (listType !== "ul") {
        flushList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = /^\d+\.\s+(.+)$/.exec(line))) {
      if (listType !== "ol") {
        flushList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    html.push(`<p>${inline(line)}</p>`);
  }
  flushList();

  return `<div class="editor-container container am-engine" id="container" data-element="root">\n${html.join("\n")}\n</div>`;
}

/** 从响应 set-cookie 头里取指定 cookie 的值（多行 set-cookie 时逐行匹配）。 */
function extractSetCookieValue(headers: Headers, name: string): string | undefined {
  const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const fallback = headers.get("set-cookie");
  if (fallback && lines.length === 0) lines.push(fallback);
  const lower = name.toLowerCase();
  for (const line of lines) {
    const m = new RegExp(`(?:^|;\\s*)${escapeRegExp(lower)}=([^;]+)`, "i").exec(line);
    if (m) return m[1].trim();
  }
  return undefined;
}

/**
 * 用当次 GET 下发的 _csrf cookie 覆盖存储 Cookie 串里的旧 _csrf。
 * Yii2 CSRF 校验要求 POST 的 _csrf 参数与请求中的 _csrf cookie 完全一致，
 * 而存储串里的 _csrf 来自更早的抓取会话（与本次 csrf-token 不同），必须替换。
 */
function mergeCsrfCookie(originalCookie: string, freshCsrf: string | undefined): string {
  const parts: string[] = [];
  for (const raw of originalCookie.split(";")) {
    const piece = raw.trim();
    if (!piece) continue;
    const eq = piece.indexOf("=");
    const name = eq >= 0 ? piece.slice(0, eq).trim().toLowerCase() : piece.toLowerCase();
    if (name === "_csrf") continue;
    parts.push(piece);
  }
  if (freshCsrf) parts.push(`_csrf=${freshCsrf}`);
  return parts.join("; ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
