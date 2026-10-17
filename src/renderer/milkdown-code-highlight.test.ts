import { describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, type Plugin } from "@milkdown/kit/prose/state";
import { type DecorationSet } from "@milkdown/kit/prose/view";
import { collectCodeBlocks, createCodeHighlightPlugin } from "./milkdown-code-highlight";

/**
 * 只含 doc / paragraph / code_block 的最小 schema。
 * 装饰逻辑只认 `code_block` + `language` 这个契约，不必拉起整套 Milkdown preset。
 */
const testSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "text*", group: "block", toDOM: () => ["p", 0] },
    code_block: {
      content: "text*",
      group: "block",
      code: true,
      defining: true,
      attrs: { language: { default: "" } },
      toDOM: (node) => ["pre", ["code", { class: node.attrs.language }, 0]]
    },
    text: { group: "inline" }
  }
});

function makeState(markdown: string): EditorState {
  const lines = markdown.split("\n");
  const nodes = lines.map((line) => {
    const fence = /^```(\w*)$/.exec(line.trim());
    if (fence) return { kind: "fence" as const, language: fence[1] };
    return { kind: "text" as const, text: line };
  });
  const blocks = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.kind === "fence") {
      const body: string[] = [];
      i += 1;
      while (i < nodes.length && nodes[i].kind === "text") {
        body.push((nodes[i] as { text: string }).text);
        i += 1;
      }
      blocks.push(testSchema.node("code_block", { language: node.language }, body.length ? testSchema.text(body.join("\n")) : undefined));
      continue;
    }
    if (node.text.trim()) blocks.push(testSchema.node("paragraph", null, testSchema.text(node.text)));
  }
  return EditorState.create({ doc: testSchema.node("doc", null, blocks), schema: testSchema });
}

interface DecorationSpec {
  class?: string;
  key?: string;
}

function collectDecorations(plugin: Plugin, state: EditorState): Array<{ from: number; to: number; spec: DecorationSpec; attrs: DecorationSpec }> {
  const set = plugin.props.decorations?.call(plugin, state) as DecorationSet | undefined;
  if (!set) return [];
  // PM 的 Decoration.node/inline(from, to, attrs) 把 class 存在 type.attrs；
  // widget 的 {key, side} 在 type.spec（即 decoration.spec getter）。
  return [...set.find()].map((decoration) => {
    const type = (decoration as unknown as { type?: { attrs?: DecorationSpec } }).type;
    return {
      from: decoration.from,
      to: decoration.to,
      spec: ((decoration.spec ?? {}) as DecorationSpec),
      attrs: (type?.attrs ?? {}) as DecorationSpec
    };
  });
}

describe("collectCodeBlocks", () => {
  it("挑出所有非 mermaid 代码块", () => {
    const state = makeState("前文\n\n```js\nconst a = 1;\n```\n\n```mermaid\ngraph TD\n```\n\n```python\nprint(1)\n```\n");
    const blocks = collectCodeBlocks(state.doc);
    expect(blocks.map((block) => block.node.attrs.language)).toEqual(["js", "python"]);
  });
});

describe("code highlight decorations", () => {
  const plugin = createCodeHighlightPlugin();

  it("为每行生成行号 widget，为非 plain token 生成 inline 着色，并给容器加 class", () => {
    const state = makeState("前文\n\n```js\nconst a = 1;\n// note\n```\n");
    const decorations = collectDecorations(plugin, state);
    const gutters = decorations.filter((item) => item.spec.key?.startsWith("cf-code-ln:"));
    const inlines = decorations.filter((item) => item.attrs.class?.includes("cf-code-tok--"));
    const containers = decorations.filter((item) => item.attrs.class === "cf-code-block");

    expect(gutters).toHaveLength(2);
    expect(containers).toHaveLength(1);
    // 第 1 行 const/=/1/; 共 4 个非 plain token，第 2 行注释 1 个。
    expect(inlines).toHaveLength(5);
    expect(inlines.map((item) => item.attrs.class)).toEqual([
      "cf-code-tok cf-code-tok--keyword",
      "cf-code-tok cf-code-tok--operator",
      "cf-code-tok cf-code-tok--number",
      "cf-code-tok cf-code-tok--punctuation",
      "cf-code-tok cf-code-tok--comment"
    ]);
  });

  it("inline 装饰的区间落在代码块文本内且首尾不越界", () => {
    const state = makeState("```js\nconst a = 1;\n```\n");
    const block = collectCodeBlocks(state.doc)[0];
    const decorations = collectDecorations(plugin, state);
    const inlines = decorations.filter((item) => item.attrs.class?.includes("cf-code-tok--"));
    for (const inline of inlines) {
      expect(inline.from).toBeGreaterThanOrEqual(block.pos + 1);
      expect(inline.to).toBeLessThanOrEqual(block.pos + block.node.nodeSize - 1);
      expect(inline.to).toBeGreaterThan(inline.from);
    }
  });

  it("跳过 mermaid 块，不产生任何装饰", () => {
    const state = makeState("```mermaid\ngraph TD\nA-->B\n```\n");
    expect(collectDecorations(plugin, state)).toHaveLength(0);
  });

  it("空代码块只有容器装饰，不崩", () => {
    const state = makeState("```js\n```\n");
    const decorations = collectDecorations(plugin, state);
    expect(decorations.filter((item) => item.attrs.class === "cf-code-block")).toHaveLength(1);
  });
});
