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
}

export class CTOClient {
  static readonly PUBLISH_URL = "https://blog.51cto.com/blogger/publish";
  static readonly PAGE_URL = "https://blog.51cto.com/blogger/publish?old=1&orig=first-publish";

  private readonly baseHeaders: Record<string, string>;

  constructor(private readonly cookie: string, private readonly fetcher: FetchLike = fetch) {
    this.baseHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
      Cookie: cookie
    };
  }

  /** 从发布页抓取 CSRF token、pid（一级栏目）、cate_id（二级/授权分类）。 */
  async fetchConfig(): Promise<{ csrfToken: string; pid: string; cateId: string }> {
    const result = { csrfToken: "", pid: "", cateId: "" };
    const req = new Request(CTOClient.PAGE_URL, { headers: this.baseHeaders });
    const resp = await this.fetcher(req);
    const html = await resp.text();

    const csrf = /<meta\s+name="csrf-token"\s+content="([^"]+)"/.exec(html);
    if (csrf) result.csrfToken = csrf[1];

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
      blog_type: input.blogType,
      copy_code: "1",
      is_old: "2",
      check: "0",
      _csrf: config.csrfToken
    });

    const headers: Record<string, string> = {
      ...this.baseHeaders,
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
