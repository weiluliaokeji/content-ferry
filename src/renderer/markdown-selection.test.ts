import { describe, expect, it } from "vitest";
import { locateMarkdownSelection } from "./markdown-selection";

describe("locateMarkdownSelection", () => {
  it("locates a selection containing headings despite normalized blank lines", () => {
    const source = "开头\n## 二级标题\n正文内容\n### 三级标题\n结尾内容";
    const serialized = "## 二级标题\n\n正文内容\n\n### 三级标题\n\n结尾内容";

    const range = locateMarkdownSelection(source, serialized);

    expect(range).toBeDefined();
    expect(source.slice(range!.start, range!.end)).toBe("## 二级标题\n正文内容\n### 三级标题\n结尾内容");
  });

  it("keeps exact Markdown selection boundaries when available", () => {
    const source = "前文\n## 标题\n\n正文\n后文";
    expect(locateMarkdownSelection(source, "## 标题\n\n正文")).toEqual({ start: 3, end: 12 });
  });

  it("restores heading markers when the visual selection only contains rendered text", () => {
    const source = "前文\n## 二级标题\n正文内容\n后文";
    const range = locateMarkdownSelection(source, "二级标题\n正文内容");

    expect(range).toBeDefined();
    expect(source.slice(range!.start, range!.end)).toBe("## 二级标题\n正文内容");
  });

  it("does not guess when the same selection occurs more than once", () => {
    expect(locateMarkdownSelection("## 标题\n正文\n## 标题\n正文", "## 标题\n\n正文")).toBeUndefined();
  });
});
