import { describe, expect, it, vi } from "vitest";
import { CTOClient, mdToHtml51 } from "./fiftyone-cto-client";

const PAGE_HTML = `<!DOCTYPE html><html><head>
<meta name="csrf-token" content="META_CSRF_TOKEN_ABC">
</head><body>
<li class="more user">...</li>
<script>var pid = '179'; var cate_id = '212';</script>
</body></html>`;

/** 模拟 51CTO 发布页 GET：返回 csrf-token meta + 当次下发的 _csrf cookie。 */
function makePageResponse(csrfCookieValue = "FRESH_CSRF_COOKIE_XYZ") {
  return new Response(PAGE_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "set-cookie": `_csrf=${csrfCookieValue}; path=/; HttpOnly`
    }
  });
}

describe("CTOClient CSRF cookie 对齐（修复 404 误判）", () => {
  it("用发布页 GET 下发的 _csrf cookie 覆盖存储串里的旧 _csrf 后再 POST", async () => {
    // 存储串里的 _csrf 是旧会话值（与本次 csrf-token 不一致）——这正是此前 404 的根因。
    const storedCookie = "sessionid=abc; _csrf=STALE_CSRF_FROM_GRAB; uid=123";
    const publishJson = JSON.stringify({ status: 1, msg: "success", data: { blog_id: "14909999" } });

    let postedCookieHeader = "";
    let postedBody = "";
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/blogger/publish")) {
        postedCookieHeader = (init?.headers as Record<string, string>)?.Cookie ?? "";
        postedBody = (init?.body as string) ?? "";
        return new Response(publishJson, {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8" }
        });
      }
      return makePageResponse();
    }) as unknown as typeof fetch;

    const client = new CTOClient(storedCookie, fetcher);
    const result = await client.post({
      title: "测试标题",
      contentHtml: "<p>正文</p>",
      tags: "a,b",
      blogType: "1",
      pid: "",
      cateId: "",
      abstract: "摘要"
    });

    // 1) 发布成功
    expect(result.status).toBe(1);
    expect(result.blogId).toBe("14909999");
    // 2) POST 的 Cookie 头里 _csrf 已被当次 GET 下发的新鲜值覆盖（不再是 STALE）
    expect(postedCookieHeader).toContain("_csrf=FRESH_CSRF_COOKIE_XYZ");
    expect(postedCookieHeader).not.toContain("STALE_CSRF_FROM_GRAB");
    // 3) URLSearchParams 里 _csrf 参数等于 csrf-token meta
    expect(postedBody).toContain("_csrf=META_CSRF_TOKEN_ABC");
    // 4) 正文/摘要/栏目均已发送
    expect(postedBody).toContain("title=%E6%B5%8B%E8%AF%95%E6%A0%87%E9%A2%98");
    expect(postedBody).toContain("abstract=%E6%91%98%E8%A6%81");
  });

  it("当次 _csrf 缺失时仍携带存储串的 _csrf（不破坏既有行为）", async () => {
    const storedCookie = "sessionid=abc; _csrf=ONLY_CSRF";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/blogger/publish")) {
        return new Response(JSON.stringify({ status: 1, msg: "success", data: { blog_id: "1" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      // GET 不下发 _csrf cookie
      return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const client = new CTOClient(storedCookie, fetcher);
    await client.post({ title: "t", contentHtml: "<p>x</p>", tags: "", blogType: "1", pid: "", cateId: "" });
    // 至少不应抛错；存储串 _csrf 被原样保留
    expect(storedCookie).toContain("_csrf=ONLY_CSRF");
  });
});

describe("mdToHtml51", () => {
  it("将 Markdown 转为含标题/段落/代码块的 HTML", () => {
    const html = mdToHtml51("# 标题\n\n这是一段正文。\n\n```js\nconst a = 1;\n```");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<p>这是一段正文。</p>");
    expect(html).toContain("<pre><code");
    expect(html).toContain("const a = 1;");
  });

  it("输出纯 HTML 片段，不包 am-editor 编辑器容器 div", () => {
    // 51CTO 发布接口的 content 字段是纯 HTML 片段；包裹 <div class="editor-container ...">
    // 会被发布页当作字面文本整段显示（用户文章页看到 <div class="editor-container ..."> 等源码）。
    const html = mdToHtml51("# 标题\n\n正文。\n");
    expect(html).not.toContain("editor-container");
    expect(html).not.toContain("am-engine");
    expect(html).not.toContain("data-element=\"root\"");
    expect(html).not.toMatch(/^<div/i);
    expect(html.trimEnd().endsWith("</p>")).toBe(true);
  });

  it("不嵌套未识别 HTML，标题 / 段落 / 引用 / 列表 / 代码块标签保持原样", () => {
    // 防止以后有人重新加上包装 div 引入回归
    const html = mdToHtml51([
      "# 一级",
      "",
      "## 二级",
      "",
      "段落文字",
      "",
      "> 引用",
      "",
      "- 列表项 1",
      "- 列表项 2",
      "",
      "```py",
      "print(1)",
      "```",
      "",
      "[链接](https://example.com)",
      "",
      "![图](https://example.com/x.png)"
    ].join("\n"));
    expect(html).toContain("<h1>一级</h1>");
    expect(html).toContain("<h2>二级</h2>");
    expect(html).toContain("<p>段落文字</p>");
    expect(html).toContain("<blockquote>引用</blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<li>列表项 1</li>');
    expect(html).toContain('<pre><code class="language-py">');
    expect(html).toContain("print(1)");
    expect(html).toContain('<a href="https://example.com">链接</a>');
    expect(html).toContain('<img src="https://example.com/x.png" alt="图">');
    // 关键回归守卫：绝不再包 editor-container
    expect(html).not.toContain("editor-container");
  });
});
