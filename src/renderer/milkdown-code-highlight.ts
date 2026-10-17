/**
 * 编辑器内代码块语法高亮 + 行号。
 *
 * 与 `milkdown-mermaid.ts` 同一模式：纯装饰层，不改 document model、不影响
 * Markdown 序列化——编辑器里打开再保存，代码块内容不丢字节。Crepe 的
 * CodeMirror 方案（`Crepe.Feature.CodeMirror`）已在 VisualMarkdownEditor 里
 * 显式关闭，这里改用共享 tokenizer（`src/shared/code-highlight.ts`）按 token
 * 上色，与手机预览、差异预览共用同一份着色规则。
 *
 * 三层装饰：
 * - `Decoration.node` 给 `<pre>` 挂 `cf-code-block`，负责背景 / 圆角 / 横向滚动（CSS 侧）；
 * - `Decoration.widget` 每行行首一个行号（`cf-code-gutter`，contentEditable=false，
 *   不进 document，复制代码时不会被带出去）；
 * - `Decoration.inline` 按 token 类型着色（`cf-code-tok--*`）。
 *
 * mermaid 块交给 mermaid 预览插件，这里跳过，避免两层装饰打架。
 */

import type { Node as ProsemirrorNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { tokenizeCodeBlock, type CodeToken } from "../shared/code-highlight";

/** 超过这个行数的块只保留容器样式、不逐行高亮，避免超大块每次按键全量 tokenize 卡顿。 */
const MAX_HIGHLIGHT_LINES = 2000;

const MERMAID_LANGUAGE = "mermaid";

/** 收集文档里所有需要高亮的代码块（mermaid 块除外）。 */
export function collectCodeBlocks(doc: ProsemirrorNode): Array<{ pos: number; node: ProsemirrorNode }> {
  const found: Array<{ pos: number; node: ProsemirrorNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "code_block" && node.attrs.language !== MERMAID_LANGUAGE) {
      found.push({ pos, node });
    }
  });
  return found;
}

function makeGutter(lineNumber: number): HTMLElement {
  const gutter = document.createElement("span");
  gutter.className = "cf-code-gutter";
  gutter.contentEditable = "false";
  gutter.textContent = String(lineNumber);
  return gutter;
}

export const codeHighlightKey = new PluginKey("cf-code-highlight");

export function createCodeHighlightPlugin(): Plugin {
  return new Plugin({
    key: codeHighlightKey,
    props: {
      decorations(state) {
        const blocks = collectCodeBlocks(state.doc);
        if (blocks.length === 0) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        for (const { pos, node } of blocks) {
          // 容器样式始终加；超大块降级为「只包容器、不逐行高亮」。
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "cf-code-block" }));
          const text = node.textContent;
          const lines = text.split("\n");
          if (lines.length > MAX_HIGHLIGHT_LINES) continue;
          const tokens = tokenizeCodeBlock(text, String(node.attrs.language ?? ""));
          // code_block 的文本起点是 pos + 1：开标签占 1 位（同 milkdown-mermaid.ts 的注释）。
          let textStart = pos + 1;
          for (let index = 0; index < lines.length; index += 1) {
            const lineTokens: CodeToken[] = tokens[index] ?? [];
            decorations.push(
              Decoration.widget(
                textStart,
                () => makeGutter(index + 1),
                { key: `cf-code-ln:${pos}:${index + 1}`, side: -1 }
              )
            );
            let offset = 0;
            for (const token of lineTokens) {
              const from = textStart + offset;
              const to = from + token.text.length;
              if (token.type !== "plain" && to > from) {
                decorations.push(Decoration.inline(from, to, { class: `cf-code-tok cf-code-tok--${token.type}` }));
              }
              offset += token.text.length;
            }
            // +1 是该行末尾的换行符；最后一行没有换行符时越界一位也无妨，
            // 后面不会再基于这个位置取内容。
            textStart += lines[index].length + 1;
          }
        }
        return DecorationSet.create(state.doc, decorations);
      }
    }
  });
}

export const codeHighlight = $prose(() => createCodeHighlightPlugin());

/** 在编辑器上启用代码块高亮。同 `useHighlight` / `useMermaidPreview`，必须在 `create()` 之前调用。 */
export function useCodeHighlight(editor: { use: (plugin: ReturnType<typeof $prose>) => void }): void {
  editor.use(codeHighlight);
}
