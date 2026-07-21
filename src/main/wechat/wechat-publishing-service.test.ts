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
