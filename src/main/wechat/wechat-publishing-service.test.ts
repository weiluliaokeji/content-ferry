import { describe, expect, it } from "vitest";
import { markdownToWechatHtml, removeDuplicateLeadingTitle } from "./wechat-publishing-service";

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
