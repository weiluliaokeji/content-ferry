import { describe, expect, it } from "vitest";
import { convertHighlightInline, convertHighlightMarkdown, matchHighlightToken } from "./markdown-highlight";

describe("matchHighlightToken", () => {
  it("识别整段高亮并返回正文", () => {
    expect(matchHighlightToken("==重点==")).toBe("重点");
  });

  it("两侧带空白时不算高亮", () => {
    expect(matchHighlightToken("== 重点 ==")).toBeNull();
  });

  it("=== 这类文本不算高亮", () => {
    expect(matchHighlightToken("====")).toBeNull();
  });
});

describe("convertHighlightInline", () => {
  it("默认输出 <mark>", () => {
    expect(convertHighlightInline("这是 ==重点== 内容")).toBe("这是 <mark>重点</mark> 内容");
  });

  it("微信输出带背景色的 span，因为清洗器会剥掉 <mark>", () => {
    const result = convertHighlightInline("这是 ==重点==", "wechat");
    expect(result).not.toContain("<mark>");
    expect(result).toContain("background-color:#ffe58f");
    expect(result).toContain(">重点</span>");
  });

  it("不改写行内代码里的 ==", () => {
    expect(convertHighlightInline("命令 `a == b` 是判等")).toBe("命令 `a == b` 是判等");
  });

  it("两侧带空白的 == 保持原样", () => {
    expect(convertHighlightInline("a == b == c")).toBe("a == b == c");
  });

  it("一行里的多处高亮都能转换", () => {
    expect(convertHighlightInline("==甲== 与 ==乙==")).toBe("<mark>甲</mark> 与 <mark>乙</mark>");
  });

  it("没有 == 时原样返回", () => {
    expect(convertHighlightInline("普通文本")).toBe("普通文本");
  });
});

describe("convertHighlightMarkdown", () => {
  it("跳过围栏代码块里的 ==", () => {
    const markdown = "正文 ==重点==\n\n```js\nif (a == b) {}\n```\n";
    const result = convertHighlightMarkdown(markdown);
    expect(result).toContain("<mark>重点</mark>");
    expect(result).toContain("if (a == b) {}");
  });

  it("~~~ 围栏同样被跳过", () => {
    const markdown = "~~~\nx == y\n~~~\n==外==";
    const result = convertHighlightMarkdown(markdown);
    expect(result).toContain("x == y");
    expect(result).toContain("<mark>外</mark>");
  });

  it("代码块外的多处高亮都能转换", () => {
    expect(convertHighlightMarkdown("==甲==\n\n==乙==")).toBe("<mark>甲</mark>\n\n<mark>乙</mark>");
  });

  it("高亮跨行内代码时，代码片段原样保留在高亮内", () => {
    const markdown = "==`computer_use` 是 GPT-6 Astra 在 Responses API 下的原生内置工具==";
    expect(convertHighlightInline(markdown, "mark")).toBe(
      "<mark>`computer_use` 是 GPT-6 Astra 在 Responses API 下的原生内置工具</mark>"
    );
  });

  it("高亮内只含行内代码也能转换", () => {
    expect(convertHighlightInline("==`code`==", "mark")).toBe("<mark>`code`</mark>");
  });
});
