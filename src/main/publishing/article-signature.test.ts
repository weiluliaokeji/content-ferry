import { describe, expect, it } from "vitest";
import { appendArticleSignature } from "./article-signature";

describe("appendArticleSignature", () => {
  it("returns markdown unchanged when signature is empty or blank", () => {
    expect(appendArticleSignature("# 标题\n\n正文", "")).toBe("# 标题\n\n正文");
    expect(appendArticleSignature("# 标题\n\n正文", "   \n ")).toBe("# 标题\n\n正文");
  });

  it("returns markdown unchanged when signature is undefined", () => {
    expect(appendArticleSignature("# 标题", undefined as unknown as string)).toBe("# 标题");
  });

  it("appends a non-empty signature after a separator line", () => {
    const result = appendArticleSignature("# 标题\n\n正文", "本文首发于公众号「围炉聊科技」");
    expect(result).toBe("# 标题\n\n正文\n\n---\n\n本文首发于公众号「围炉聊科技」");
  });

  it("trims trailing whitespace of markdown and leading/trailing whitespace of signature", () => {
    const result = appendArticleSignature("# 标题\n\n正文  \n\n", "  签名内容  ");
    expect(result).toBe("# 标题\n\n正文\n\n---\n\n签名内容");
  });
});
