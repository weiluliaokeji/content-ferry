import { describe, expect, it } from "vitest";
import { normalizeLanguage, tokenizeCodeBlock, type CodeToken } from "./code-highlight";

/** 测试辅助：把逐行 token 拍平成一个「文本@类型」序列，断言更直观。 */
function flatten(tokens: CodeToken[][]): string[] {
  return tokens.flat().map((token) => `${token.text}@${token.type}`);
}

function lineTypes(tokens: CodeToken[][], lineIndex: number): string[] {
  return tokens[lineIndex].map((token) => token.type);
}

/** 把某行重新拼回原文，保证 tokenize 是无损的（渲染正确性底线）。 */
function joinLine(tokens: CodeToken[]): string {
  return tokens.map((token) => token.text).join("");
}

describe("code-highlight tokenizer", () => {
  it("normalizes language aliases", () => {
    expect(normalizeLanguage("  JSX ")).toBe("javascript");
    expect(normalizeLanguage("TSX")).toBe("typescript");
    expect(normalizeLanguage("py")).toBe("python");
    expect(normalizeLanguage("shell")).toBe("bash");
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("unknown-lang")).toBe("unknown-lang");
  });

  it("tokenizes javascript keywords, strings, comments and numbers", () => {
    const tokens = tokenizeCodeBlock('const x = "hi"; // note\nlet n = 0x1F;', "js");
    expect(lineTypes(tokens, 0)).toEqual(["keyword", "plain", "operator", "plain", "string", "punctuation", "plain", "comment"]);
    expect(tokens[0][4]).toMatchObject({ text: '"hi"', type: "string" });
    expect(lineTypes(tokens, 1)).toEqual(["keyword", "plain", "operator", "plain", "number", "punctuation"]);
    expect(tokens[1][4]).toMatchObject({ text: "0x1F", type: "number" });
  });

  it("keeps text lossless across every line", () => {
    const code = 'const a = "x"; // c\nfunction f() { return 1 }\n/* block\n comment */ const y = 2;';
    const tokens = tokenizeCodeBlock(code, "typescript");
    expect(tokens.map((line) => joinLine(line))).toEqual(code.split("\n"));
  });

  it("marks function calls and member access", () => {
    const tokens = tokenizeCodeBlock("renderMermaid(source)\nMath.max(1, 2)", "javascript");
    expect(tokens[0][0]).toMatchObject({ text: "renderMermaid", type: "function" });
    expect(tokens[1][0]).toMatchObject({ text: "Math", type: "plain" });
    // 被调用的方法算 function，纯属性访问（a.b）才算 property。
    expect(tokens[1][2]).toMatchObject({ text: "max", type: "function" });
  });

  it("does not treat comment markers inside strings as comments", () => {
    const tokens = tokenizeCodeBlock('const url = "https://x.dev/a#b";', "javascript");
    expect(flatten(tokens)).toEqual([
      "const@keyword", " url @plain", "=@operator", " @plain",
      '"https://x.dev/a#b"@string', ";@punctuation"
    ]);
  });

  it("handles multi-line block comments with state carry-over", () => {
    const tokens = tokenizeCodeBlock("/* 开头\n中间 comment\n结尾 */ const a = 1;", "javascript");
    expect(lineTypes(tokens, 0)).toEqual(["comment"]);
    expect(lineTypes(tokens, 1)).toEqual(["comment"]);
    expect(lineTypes(tokens, 2)).toEqual(["comment", "plain", "keyword", "plain", "operator", "plain", "number", "punctuation"]);
  });

  it("tokenizes python hash comments, decorators and triple-quoted strings", () => {
    const tokens = tokenizeCodeBlock('# 注释\n@mcp.tool\ndef f(url: str) -> str:\n    return "ok"', "python");
    expect(lineTypes(tokens, 0)).toEqual(["comment"]);
    expect(lineTypes(tokens, 1)).toEqual(["operator", "function", "punctuation", "property"]);
    expect(tokens[2][0]).toMatchObject({ text: "def", type: "keyword" });
    const triple = tokenizeCodeBlock('s = """line1\nline2"""\nx = 1', "python");
    expect(lineTypes(triple, 0)).toEqual(["plain", "operator", "plain", "string"]);
    expect(lineTypes(triple, 1)).toEqual(["string"]);
    expect(lineTypes(triple, 2)).toEqual(["plain", "operator", "plain", "number"]);
  });

  it("tokenizes bash comments, variables and keywords", () => {
    const tokens = tokenizeCodeBlock('echo "$HOME" # 回显\ncd /tmp', "bash");
    expect(tokens[0][0]).toMatchObject({ text: "echo", type: "keyword" });
    expect(tokens[0][2]).toMatchObject({ text: '"$HOME"', type: "string" });
    expect(tokens[0][4]).toMatchObject({ text: "# 回显", type: "comment" });
  });

  it("marks json keys and literals", () => {
    const tokens = tokenizeCodeBlock('{\n  "name": "app",\n  "port": 8080,\n  "on": true\n}', "json");
    expect(tokens[1][1]).toMatchObject({ text: '"name"', type: "property" });
    expect(tokens[2][1]).toMatchObject({ text: '"port"', type: "property" });
    expect(tokens[3][1]).toMatchObject({ text: '"on"', type: "property" });
    expect(tokens[3][4]).toMatchObject({ text: "true", type: "keyword" });
  });

  it("marks yaml keys and keeps values plain", () => {
    const tokens = tokenizeCodeBlock("name: 文渡\nversion: 0.3.2\nlist:\n  - item", "yaml");
    expect(tokens[0][0]).toMatchObject({ text: "name", type: "property" });
    expect(joinLine(tokens[0])).toBe("name: 文渡");
    expect(tokens[3][1]).toMatchObject({ text: "-", type: "operator" });
  });

  it("tokenizes html tags, attributes and comments", () => {
    const tokens = tokenizeCodeBlock('<!-- note -->\n<a href="https://x.dev" class=\'btn\'>go</a>', "html");
    expect(lineTypes(tokens, 0)).toEqual(["comment"]);
    expect(tokens[1][0]).toMatchObject({ text: "<a", type: "tag" });
    expect(tokens[1][2]).toMatchObject({ text: "href", type: "attr" });
    expect(tokens[1][4]).toMatchObject({ text: '"https://x.dev"', type: "string" });
    expect(joinLine(tokens[1])).toBe('<a href="https://x.dev" class=\'btn\'>go</a>');
  });

  it("tokenizes sql comments and case-insensitive keywords", () => {
    const tokens = tokenizeCodeBlock("-- 注释\nselect id from users where age > 20", "sql");
    expect(lineTypes(tokens, 0)).toEqual(["comment"]);
    expect(tokens[1][0]).toMatchObject({ text: "select", type: "keyword" });
    expect(tokens[1][1]).toMatchObject({ type: "plain" });
    expect(tokens[1][1].text.trim()).toBe("id");
  });

  it("falls back to generic rules for unknown languages without crashing", () => {
    const tokens = tokenizeCodeBlock('x = "s" # c\n42', "brainfuck");
    expect(joinLine(tokens[0])).toBe('x = "s" # c');
    expect(joinLine(tokens[1])).toBe("42");
  });

  it("keeps empty lines and unclosed strings intact", () => {
    const tokens = tokenizeCodeBlock("const a = 'oops\nnext", "javascript");
    expect(joinLine(tokens[0])).toBe("const a = 'oops");
    expect(joinLine(tokens[1])).toBe("next");
    expect(lineTypes(tokens, 1)).toEqual(["plain"]);
    expect(tokenizeCodeBlock("\n\n", "js").map(joinLine)).toEqual(["", "", ""]);
  });
});
