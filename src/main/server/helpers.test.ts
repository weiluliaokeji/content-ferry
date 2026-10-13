import { describe, expect, it } from "vitest";
import { initialArticleTitle } from "./helpers";

describe("initialArticleTitle", () => {
  it("extracts the requested article subject from a creation instruction", () => {
    expect(initialArticleTitle("编写一篇关于《Scoop使用指南与实践》的公众号文章"))
      .toBe("Scoop使用指南与实践");
  });

  it("keeps an explicitly supplied title unchanged", () => {
    expect(initialArticleTitle("请写一篇文章", "我确认的标题"))
      .toBe("我确认的标题");
  });

  it("keeps a plain topic unchanged", () => {
    expect(initialArticleTitle("Scoop 使用指南"))
      .toBe("Scoop 使用指南");
    expect(initialArticleTitle("写作风格"))
      .toBe("写作风格");
  });

  it("removes a general creation wrapper without stripping the subject", () => {
    expect(initialArticleTitle("请帮我写一篇 Scoop 使用指南的公众号文章"))
      .toBe("Scoop 使用指南");
  });
});
