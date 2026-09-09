import { describe, expect, it, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, type Plugin } from "@milkdown/kit/prose/state";
import { type DecorationSet } from "@milkdown/kit/prose/view";
import {
  collectMermaidBlocks,
  createMermaidPreviewPlugin,
  mermaidPreviewKey,
  type MermaidRenderer
} from "./milkdown-mermaid";

/** 数一数这次算出了几个装饰。`props.decorations` 的声明类型是 DecorationSource，取不到 find。 */
function countDecorations(plugin: Plugin, state: EditorState): number {
  const set = plugin.props.decorations?.call(plugin, state) as DecorationSet | undefined;
  if (!set) return 0;
  return [...set.find()].length;
}

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

function makeState(markdown: string, plugins: unknown[] = []): EditorState {
  const lines = markdown.split("\n");
  const nodes = lines
    .map((line) => {
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
  // 插件必须注册进 state，否则 mermaidPreviewKey.getState() 读不到 editing。
  return EditorState.create({
    doc: testSchema.node("doc", null, blocks),
    schema: testSchema,
    plugins: plugins as []
  });
}

describe("collectMermaidBlocks", () => {
  it("只挑出 language=mermaid 的代码块", () => {
    const state = makeState("前文\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```js\nconst a = 1;\n```\n");
    const blocks = collectMermaidBlocks(state.doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].node.attrs.language).toBe("mermaid");
    expect(blocks[0].node.textContent).toBe("graph TD\nA-->B");
  });

  it("没有 mermaid 块时返回空数组", () => {
    expect(collectMermaidBlocks(makeState("只有文字\n\n```js\nx\n```\n").doc)).toEqual([]);
  });
});

describe("createMermaidPreviewPlugin", () => {
  it("文档里没有 mermaid 时不产生任何装饰", () => {
    const plugin = createMermaidPreviewPlugin(async () => ({ ok: false, error: "不应被调用" }));
    const state = makeState("```js\nconst a = 1;\n```\n");
    expect(countDecorations(plugin, state)).toBe(0);
  });

  it("渲染成功后隐藏源码并插入图片 widget", async () => {
    const render: MermaidRenderer = async () => ({ ok: true, dataUrl: "data:image/png;base64,AAAA" });
    const plugin = createMermaidPreviewPlugin(render);
    const state = makeState("```mermaid\ngraph TD\n```\n");

    // 首次装饰：缓存未命中，先给占位（源码仍隐藏，避免闪烁回文本）。
    expect(countDecorations(plugin, state)).toBe(2); // 1 个 node 装饰 + 1 个 widget

    // 等防抖过去，缓存写入后仍是 node + widget，只是 widget 内容换成图片。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(countDecorations(plugin, state)).toBe(2);
  });

  it("渲染失败时不隐藏源码，保证作者能继续改", async () => {
    const render: MermaidRenderer = async () => ({ ok: false, error: "语法错误" });
    const plugin = createMermaidPreviewPlugin(render);
    const state = makeState("```mermaid\ngraph ???\n```\n");
    countDecorations(plugin, state);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // 只剩 widget（错误提示），没有隐藏源码的 node 装饰。
    expect(countDecorations(plugin, state)).toBe(1);
  });

  it("相同的源码只渲染一次（缓存生效）", async () => {
    const render = vi.fn<MermaidRenderer>(async () => ({ ok: true, dataUrl: "data:image/png;base64,AAAA" }));
    const plugin = createMermaidPreviewPlugin(render);
    const state = makeState("```mermaid\ngraph TD\n```\n");
    countDecorations(plugin, state);
    countDecorations(plugin, state);
    await new Promise((resolve) => setTimeout(resolve, 500));
    countDecorations(plugin, state);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("处于编辑态的块不产生装饰（显示源码）", () => {
    const plugin = createMermaidPreviewPlugin(async () => ({ ok: true, dataUrl: "data:image/png;base64,AAAA" }));
    // 同一次 state 上改 meta：插件已注册，getState 才能读到 editing。
    const state = makeState("```mermaid\ngraph TD\n```\n", [plugin]);
    const withEditing = state.apply(state.tr.setMeta(mermaidPreviewKey, { editing: "graph TD" }));
    expect(mermaidPreviewKey.getState(withEditing)?.editing).toBe("graph TD");
    expect(countDecorations(plugin, withEditing)).toBe(0);
  });
});
