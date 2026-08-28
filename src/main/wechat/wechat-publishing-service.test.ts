import { describe, expect, it } from "vitest";
import { markdownToWechatHtml, rasterizeSvgToPng, removeDuplicateLeadingTitle } from "./wechat-publishing-service";

describe("Wechat article title rendering", () => {
  it("removes a matching leading level-one heading from the Wechat body", () => {
    expect(removeDuplicateLeadingTitle(
      "\n# 1B参数实现多项SOTA：腾讯混元OCR模型开源体验\n\n正文第一段",
      "1B参数实现多项SOTA：腾讯混元OCR模型开源体验"
    )).toBe("\n正文第一段");
  });

  it("keeps a different leading heading as part of the article body", () => {
    const markdown = "# 核心结论\n\n正文第一段";
    expect(removeDuplicateLeadingTitle(markdown, "腾讯混元OCR模型开源体验")).toBe(markdown);
  });

  it("compares titles after removing harmless Markdown emphasis", () => {
    expect(removeDuplicateLeadingTitle(
      "# **腾讯混元OCR模型开源体验**\n\n正文",
      "腾讯混元OCR模型开源体验"
    )).toBe("正文");
  });
});

describe("Wechat article typography", () => {
  it("renders an explicit heading hierarchy larger than the 17px body", () => {
    const html = markdownToWechatHtml([
      "# 一级内容标题",
      "## 二级内容标题",
      "### 三级内容标题",
      "#### 四级内容标题",
      "正文内容"
    ].join("\n\n"));

    expect(html).not.toMatch(/<h[1-6]\b/);
    expect(html).toContain("font-size:22px");
    expect(html).toContain("font-size:20px");
    expect(html).toContain("font-size:18px");
    expect(html.match(/font-size:17px/g)).toHaveLength(2);
    expect(html).toContain("正文内容</p>");
  });
});

describe("Wechat code-block rendering", () => {
  it("emits WeChat-native code-block markup so the editor renders a real block", () => {
    const html = markdownToWechatHtml("```ts\nconst first = 1;\nconst second = 2;\n```");
    // WeChat-native markers — the editor renders these as a styled block
    // (background, monospace, optional line numbers) rather than plain text.
    expect(html).toContain('<section class="code-snippet__js">');
    expect(html).toContain('<pre class="code-snippet__js code-snippet code-snippet_nowrap"');
    expect(html).toContain("<code>");
    expect(html).toContain("<span leaf=\"\">");
    // Each source line must be its own <code><span leaf="">...
    // so WeChat cannot collapse all lines into one.
    expect(html).toContain(">const first = 1;</span></code>");
    expect(html).toContain(">const second = 2;</span></code>");
    // No fragile inline fenced/pre-wrap simulation that WeChat justifies away.
    expect(html).not.toContain("<br/>");
  });

  it("preserves empty lines with a non-breaking space", () => {
    const html = markdownToWechatHtml("```\nfirst\n\nthird\n```");
    // An empty source line becomes a non-breaking space inside its own
    // <code><span leaf=""> so the block keeps its height.
    expect(html).toContain(">first</span></code>");
    expect(html).toContain("> </span></code>");
    expect(html).toContain(">third</span></code>");
  });
});

describe("Wechat horizontal-rule rendering", () => {
  it("converts ---, *** and ___ into a styled separator instead of literal characters", () => {
    const html = markdownToWechatHtml("第一段\n\n---\n\n第二段\n\n***\n\n第三段\n\n___");
    expect(html).not.toContain("<p>---</p>");
    expect(html).not.toContain("<p>***</p>");
    expect(html).not.toContain("<p>___</p>");
    expect(html).toContain("border-top:1px solid #d8dee8");
    // Three separators in total.
    expect(html.match(/border-top:1px solid #d8dee8/g)).toHaveLength(3);
  });
});

describe("Wechat table rendering", () => {
  it("recognizes delimiters with only two dashes per cell", () => {
    const html = markdownToWechatHtml([
      "| 排名 | Server |",
      "| -- | ---------------------------- |",
      "| 1  | microsoft/markitdown         |"
    ].join("\n"));
    expect(html).toContain("<table");
    expect(html).toContain("排名");
    expect(html).toContain("Server");
    expect(html).toContain("microsoft/markitdown");
    expect(html).not.toContain("| 排名 |");
  });

  it("keeps cell links as clickable <a> tags in the flat WeChat-safe table structure", () => {
    const html = markdownToWechatHtml([
      "| 产品 | 官方链接 |",
      "| --- | --- |",
      "| Coze | [积分规则](https://docs.coze.cn/coze_pro_credits) |",
      "| 通义 | [官网](https://qwenwork.cn) |"
    ].join("\n"));
    expect(html).toContain('<table style="width:100%;border-collapse:collapse;margin:1em 0;font-size:14px;"><tr><th');
    // Flat structure only: WeChat strips thead/tbody and rebuilding the DOM
    // can drop <a> links nested inside the removed groups.
    expect(html).not.toContain("<thead");
    expect(html).not.toContain("<tbody");
    // Cell links survive as real anchors with the full URL kept as visible
    // text: even if WeChat's editor strips the <a>, the URL remains readable
    // and copyable instead of silently degrading to bare link text.
    expect(html).toContain('<td style="padding:8px;border:1px solid #d8dee8;vertical-align:top;"><a href="https://docs.coze.cn/coze_pro_credits">积分规则（https://docs.coze.cn/coze_pro_credits）</a></td>');
    expect(html).toContain('<a href="https://qwenwork.cn">官网（https://qwenwork.cn）</a>');
    expect(html).not.toContain("](");
  });

  it("keeps inline formatting alongside links inside table cells", () => {
    const html = markdownToWechatHtml([
      "| 名称 | 说明 |",
      "| --- | --- |",
      "| **Agent** | 支持 `API` 与 [文档](https://example.com) |"
    ].join("\n"));
    expect(html).toContain("<strong>Agent</strong>");
    expect(html).toContain('<code style="padding:.15em .35em;background:#f2f3f5;border-radius:3px;">API</code>');
    expect(html).toContain('<a href="https://example.com">文档（https://example.com）</a>');
  });

  it("keeps ordinary paragraph links as plain <a> tags without visible URL", () => {
    const html = markdownToWechatHtml("数据来源：[官网](https://example.com)。");
    expect(html).toContain('<a href="https://example.com">官网</a>');
    expect(html).not.toContain("官网（https://example.com）");
  });

  it("keeps cell links intact when the URL contains a pipe character", () => {
    const html = markdownToWechatHtml([
      "| 名称 | 链接 |",
      "| --- | --- |",
      "| 示例 | [筛选](https://example.com/search?a=1|b=2) |"
    ].join("\n"));
    // The pipe character inside the URL must not be treated as a table cell delimiter.
    // The full URL with pipe should appear inside a single <a> tag.
    expect(html).toContain('<a href="https://example.com/search?a=1|b=2">筛选（https://example.com/search?a=1|b=2）</a>');
    // The pipe inside the URL should NOT create extra table cells (no more than 2 data cells).
    expect(html).not.toContain("<td>|b=2</td>");
  });
});

describe("Wechat italic rendering", () => {
  it("converts single-asterisk emphasis into <em>", () => {
    const html = markdownToWechatHtml("*文中数据来源：示例。*");
    expect(html).toContain("<em>文中数据来源：示例。</em>");
    expect(html).not.toContain("*文中数据来源");
  });
});

describe("Wechat markdown escape rendering", () => {
  it("removes backslash escapes from punctuation in normal text", () => {
    const html = markdownToWechatHtml("## 踩坑：CREDIT\\_REPORT 报错\n\n记录 CREDIT\\_REPORT 错误。");
    expect(html).toContain("CREDIT_REPORT");
    expect(html).not.toContain("CREDIT\\_REPORT");
  });

  it("keeps backslashes inside inline code literal", () => {
    const html = markdownToWechatHtml("`CREDIT\\_REPORT`");
    expect(html).toContain("CREDIT\\_REPORT");
    expect(html).not.toContain("CREDIT_REPORT");
  });
});

describe("Wechat ordered-list rendering", () => {
  it("keeps source numbers visible without relying on WeChat ol styling", () => {
    const html = markdownToWechatHtml("1. 注册免费域名\n   访问服务并完成注册\n2. 注册 Cloudflare 账户\n3. 域名迁移到 Cloudflare");
    expect(html).not.toContain("<ol");
    expect(html).toContain(">1.</span>");
    expect(html).toContain(">2.</span>");
    expect(html).toContain(">3.</span>");
    expect(html).toContain("注册 Cloudflare 账户");
  });
});

describe("Wechat unordered-list rendering", () => {
  it("drops empty Markdown list markers instead of creating blank WeChat bullets", () => {
    const html = markdownToWechatHtml([
      "-",
      "- 技术栈及主要版本；",
      "* ",
      "* 核心目录及模块职责；",
      "+",
      "+ 启动、测试和构建命令；"
    ].join("\n"));

    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<li");
    expect(html.match(/>•<\/span>/g)).toHaveLength(3);
    expect(html).not.toContain(">-</p>");
    expect(html).toContain("技术栈及主要版本；");
    expect(html).toContain("核心目录及模块职责；");
    expect(html).toContain("启动、测试和构建命令；");
  });

  it("keeps list items separated by blank source lines in one WeChat list", () => {
    const html = markdownToWechatHtml([
      "项目级上下文通常包括：",
      "",
      "* 技术栈及主要版本；",
      "",
      "* 核心目录及模块职责；",
      "",
      "* 启动、测试和构建命令；",
      "",
      "* 编码规范；",
      "",
      "下一段正文。"
    ].join("\n"));

    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<li");
    expect(html.match(/>•<\/span>/g)).toHaveLength(4);
  });
});

describe("rasterizeSvgToPng", () => {
  it("converts an SVG with only a viewBox into a valid PNG", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#00f"/></svg>');
    const png = rasterizeSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
    expect(png.toString("binary", 1, 4)).toBe("PNG"); // PNG magic bytes
  }, 15_000);

  it("respects the SVG intrinsic width when present", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#0f0"/></svg>');
    const png = rasterizeSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });

  it("caps oversized SVGs to avoid generating huge images", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5000 5000"><rect width="5000" height="5000" fill="#f00"/></svg>');
    const png = rasterizeSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });
});
