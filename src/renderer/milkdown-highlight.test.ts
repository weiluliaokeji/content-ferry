import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { HIGHLIGHT_NODE_TYPE, highlightToMarkdownHandler, remarkHighlight } from "./milkdown-highlight";

/**
 * 编辑器里的高亮是「Markdown → mdast → ProseMirror」再「ProseMirror → mdast →
 * Markdown」的双向过程。这里用真实的 remark 处理器验证两端：
 * - 解析侧：`remarkHighlight` 必须把 `==文本==` 切成自定义节点；
 * - 序列化侧：mdast-util-to-markdown 不认识自定义类型会抛错，注册的 handler
 *   必须把它写回 `==文本==`，否则编辑器里保存一次就会吃掉高亮。
 */
function makeProcessor() {
  // remark-stringify 的 `Options['handlers']` 形参按具体 mdast 节点类型声明，
  // 自定义节点类型无法直接匹配；这里按运行时约定传入，与编辑器里注入的方式一致。
  const stringifyOptions = { handlers: { [HIGHLIGHT_NODE_TYPE]: highlightToMarkdownHandler } } as never;
  return unified()
    .use(remarkParse)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .use(remarkHighlight as any)
    .use(remarkStringify, stringifyOptions);
}

function roundTrip(markdown: string): string {
  return makeProcessor().processSync(markdown).toString().replace(/\n$/, "");
}

function collectTypes(markdown: string): string[] {
  const processor = makeProcessor();
  // `.parse()` 只跑解析阶段；transformer 要在 `.runSync()` 之后才生效。
  const tree = processor.runSync(processor.parse(markdown));
  const types: string[] = [];
  const walk = (node: { type: string; children?: unknown[] }): void => {
    types.push(node.type);
    const children = node.children as Array<{ type: string; children?: unknown[] }> | undefined;
    children?.forEach(walk);
  };
  walk(tree as unknown as { type: string; children?: unknown[] });
  return types;
}

describe("remarkHighlight", () => {
  it("把 ==文本== 解析成高亮节点", () => {
    expect(collectTypes("这是 ==重点== 内容")).toContain(HIGHLIGHT_NODE_TYPE);
  });

  it("不改动围栏代码块里的 ==", () => {
    const markdown = "```js\nconst a = 1;\n// == 不是高亮 ==\n```";
    expect(collectTypes(markdown)).not.toContain(HIGHLIGHT_NODE_TYPE);
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("不改动行内代码里的 ==", () => {
    const markdown = "命令 `a == b` 是判等";
    expect(collectTypes(markdown)).not.toContain(HIGHLIGHT_NODE_TYPE);
  });

  it("=== 这类 setext 下划线不会被当成高亮", () => {
    expect(collectTypes("标题\n===")).not.toContain(HIGHLIGHT_NODE_TYPE);
  });

  it("两侧带空白的 == 不生效，避免 a == b == c 被误判", () => {
    expect(collectTypes("a == b == c")).not.toContain(HIGHLIGHT_NODE_TYPE);
  });

  it("解析再序列化后 ==文本== 原样回来（编辑器往返不丢高亮）", () => {
    expect(roundTrip("这是 ==重点== 内容")).toBe("这是 ==重点== 内容");
  });

  it("一段文字里的多处高亮都能保留", () => {
    expect(roundTrip("==甲== 与 ==乙== 都要高亮")).toBe("==甲== 与 ==乙== 都要高亮");
  });

  it("自定义高亮节点能被序列化回 ==", () => {
    // 直接用构造树序列化，确保走的是注册的 handler。仅靠全文往返不够：
    // remark 遇到不认识的 `==` 会当作普通文本原样带过，往返照样相等。
    const tree = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: HIGHLIGHT_NODE_TYPE, children: [{ type: "text", value: "重点" }] }] }
      ]
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(makeProcessor().stringify(tree as any).trimEnd()).toBe("==重点==");
  });

  it("高亮里嵌套强调也能原样回来", () => {
    const result = roundTrip("==**粗体重点**==");
    // 调试用：先把真实值打出来。
    if (result !== "==**粗体重点**==") {
      const proc = makeProcessor();
      const tree = proc.runSync(proc.parse("==**粗体重点**=="));
      throw new Error(
        `[debug] roundTrip=${JSON.stringify(result)} len=${result.length}\n` +
        `tree=${JSON.stringify(tree, null, 2)}`
      );
    }
    expect(result).toBe("==**粗体重点**==");
  });

  // 新增：「高亮跨 inline code」的实测。用户截图里的写法是
  // `==\`computer_use\` 是...原生内置工具==`，外面 `==` 是高亮标记，
  // 中间 `\`computer_use\`` 是 inline code。这里要确认当前实现到底把它当
  // 成高亮还是落空；只有先看到真实行为，才能判断要不要动 matchSpan 或
  // inlineCode 的原子节点策略。
  it("高亮跨 inline code：当前 collectTypes 实测", () => {
    const markdown = "==`computer_use` 是 GPT-6 Astra 在 Responses API 下的原生内置工具==";
    const types = collectTypes(markdown);
    expect(types).toContain(HIGHLIGHT_NODE_TYPE);
    expect(types).toContain("inlineCode");
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("高亮里只包一个 inline code，==仍能正确成对", () => {
    // `==\`code\`==` 是常见的写法（高亮内只含代码标识）。
    const markdown = "==`code`==";
    expect(collectTypes(markdown)).toContain(HIGHLIGHT_NODE_TYPE);
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it("单节点路径下 a == b == c 仍不被误判", () => {
    // 防御性回归：放宽跨节点分支不能破单节点分支的老合同。
    expect(collectTypes("a == b == c")).not.toContain(HIGHLIGHT_NODE_TYPE);
    expect(roundTrip("a == b == c")).toBe("a == b == c");
  });
});
