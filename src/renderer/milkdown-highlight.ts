/**
 * Obsidian 风格高亮（`==文本==`）在 Milkdown / Crepe 编辑器里的双向支持。
 *
 * 为什么要自己做一套：Crepe 自带的 commonmark/gfm preset 没有 highlight 语法，
 * 而文渡把 Markdown 当作 canonical 内容源——`==` 必须能**原样读进来、原样写回去**，
 * 否则在可视化编辑器里打开一次就会把高亮信息吃掉，这与「本地 Markdown 为准」冲突。
 *
 * 实现分三处，缺一不可：
 * 1. **解析侧**：remark 插件把 `==文本==` 切成自定义 mdast 节点（见 `remarkHighlight`）。
 *    围栏代码块与行内代码在 mdast 里是 `value` 而非 `children`，递归天然跳过。
 * 2. **schema 侧**：`$mark('highlight')` 通过 `parseMarkdown` 认领该 mdast 节点，
 *    通过 `toMarkdown` 再吐回同类型节点。
 * 3. **序列化侧**：mdast-util-to-markdown 不认识自定义类型会直接抛错，必须注册
 *    对应的 handler。该 handler 只能通过 `remarkStringifyOptionsCtx` 注入，而它
 *    在 InitReady 阶段就被读取，所以要放在 `editor.config`（ConfigReady 阶段，
 *    早于 init）里写入——见 `useHighlight`。
 */
import type { Ctx, MilkdownPlugin } from "@milkdown/kit/ctx";
import { commandsCtx, remarkPluginsCtx, remarkStringifyOptionsCtx, type Editor } from "@milkdown/kit/core";
import { markRule } from "@milkdown/kit/prose";
import { toggleMark } from "@milkdown/kit/prose/commands";
import { $command, $inputRule, $mark, $useKeymap } from "@milkdown/kit/utils";

/** 自定义 mdast 节点类型名。加前缀以免与 remark 生态里的同名节点冲突。 */
export const HIGHLIGHT_NODE_TYPE = "wunduHighlight";

/** 与 `src/shared/markdown-highlight.ts` 保持一致：正文不含 `=` 与换行。 */
const MARKER = "==";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

function isTextNode(node: MdastNode | undefined): node is MdastNode & { value: string } {
  return node !== undefined && node.type === "text" && typeof node.value === "string";
}

/**
 * 内容需非空且两侧不贴空白，否则 `a == b == c` 这类判等文本会被误判成高亮。
 * 跨节点时（`==**粗**==`）正文由其它节点承载，此时 body 可以是空串。
 */
function isValidBody(body: string, hasOtherContent: boolean): boolean {
  if (body) return Boolean(body.trim()) && body === body.trim();
  return hasOtherContent;
}

interface HighlightSpan {
  /** 起始文本节点里 `==` 之前的普通文本。 */
  head: string;
  /** 高亮正文节点。 */
  content: MdastNode[];
  /** 收尾 `==` 之后的剩余文本节点。 */
  tail?: MdastNode;
  /** 下一个待处理节点的下标。 */
  nextIndex: number;
}

/**
 * 从 `children[start]` 里的 `==` 出发，向后找配对的 `==`。
 *
 * 为什么不能只在单个文本节点内匹配：remark 会先把 `==**粗**==` 切成
 * `[text "==", strong, text "=="]`，开闭标记落在不同节点上，只扫单节点会漏掉
 * 高亮里带强调/链接的常见写法。
 */
function matchSpan(children: MdastNode[], start: number): HighlightSpan | null {
  const first = children[start];
  if (!isTextNode(first)) return null;
  const openAt = first.value.indexOf(MARKER);
  if (openAt < 0) return null;
  const head = first.value.slice(0, openAt);
  let rest = first.value.slice(openAt + MARKER.length);
  const content: MdastNode[] = [];
  for (let index = start + 1; ; index += 1) {
    const closeAt = rest.indexOf(MARKER);
    if (closeAt >= 0) {
      const body = rest.slice(0, closeAt);
      if (!isValidBody(body, content.length > 0)) return null;
      if (body) content.push({ type: "text", value: body });
      const tailValue = rest.slice(closeAt + MARKER.length);
      return {
        head,
        content,
        tail: tailValue ? { type: "text", value: tailValue } : undefined,
        nextIndex: index
      };
    }
    if (index >= children.length) return null;
    if (rest) content.push({ type: "text", value: rest });
    const node = children[index];
    if (isTextNode(node)) {
      rest = node.value;
      continue;
    }
    content.push(node);
    rest = "";
  }
}

function transformChildren(children: MdastNode[]): MdastNode[] {
  const result: MdastNode[] = [];
  let index = 0;
  while (index < children.length) {
    const node = children[index];
    if (isTextNode(node) && node.value.includes(MARKER)) {
      const span = matchSpan(children, index);
      if (span) {
        if (span.head) result.push({ type: "text", value: span.head });
        result.push({ type: HIGHLIGHT_NODE_TYPE, children: transformChildren(span.content) });
        if (span.tail) result.push(...transformChildren([span.tail]));
        index = span.nextIndex;
        continue;
      }
    }
    transformTree(node);
    result.push(node);
    index += 1;
  }
  return result;
}

function transformTree(node: MdastNode): void {
  // 代码块（code / inlineCode）的内容在 `value` 上而不是 `children`，递归天然跳过。
  if (Array.isArray(node.children)) node.children = transformChildren(node.children);
}

/**
 * remark 插件：把 Markdown 里的 `==文本==` 解析成 `wunduHighlight` 节点。
 * 只在 `run()`（解析）阶段生效，序列化是 `stringify()` 直出，不会重复处理。
 */
export function remarkHighlight(): (tree: MdastNode) => void {
  return (tree) => {
    transformTree(tree);
  };
}

/**
 * mdast-util-to-markdown 的 handler：把高亮节点写回 `==文本==`。
 * 导出是为了让 remark 往返测试使用与编辑器完全相同的实现。
 */
export const highlightToMarkdownHandler = (
  node: unknown,
  _parent: unknown,
  state: unknown,
  info: unknown
): string => {
  // 必须保持方法调用：`containerPhrasing` 内部用 `this` 取 state，解构出来会丢绑定。
  const stateWithPhrasing = state as { containerPhrasing: (target: unknown, info: unknown) => string };
  return `${MARKER}${stateWithPhrasing.containerPhrasing(node, info)}${MARKER}`;
};

export const highlightSchema = $mark("highlight", () => ({
  attrs: {},
  // 从别处（如 Obsidian、网页）粘贴带 <mark> 的内容时也能识别成高亮。
  parseDOM: [{ tag: "mark" }],
  toDOM: () => ["mark", 0],
  parseMarkdown: {
    match: (node) => node.type === HIGHLIGHT_NODE_TYPE,
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "highlight",
    runner: (state, mark) => {
      state.withMark(mark, HIGHLIGHT_NODE_TYPE);
    }
  }
}));

export const toggleHighlightCommand = $command("ToggleHighlight", (ctx) => () => toggleMark(highlightSchema.type(ctx)));

/** 输入规则：敲完收尾的 `==` 即把中间内容变成高亮，与 Obsidian 一致。 */
export const highlightInputRule = $inputRule((ctx) => markRule(/==([^=]+)==$/, highlightSchema.type(ctx)));

export const highlightKeymap = $useKeymap("highlightKeymap", {
  ToggleHighlight: {
    shortcuts: "Mod-Shift-h",
    command: (ctx) => {
      const commands = ctx.get(commandsCtx);
      return () => commands.call(toggleHighlightCommand.key);
    }
  }
});

// `$useKeymap` 返回的是 [$Ctx, $Shortcut] 元组，展开后才是两个独立插件。
export const highlightFeature: MilkdownPlugin[] = [
  highlightSchema,
  toggleHighlightCommand,
  highlightInputRule,
  ...highlightKeymap
];

/**
 * 在编辑器上启用高亮。必须在 `create()` 之前调用：
 * `remarkStringifyOptionsCtx` 在 InitReady 就被读走了，晚于 config 阶段再改无效。
 */
export function useHighlight(editor: Editor): void {
  editor.config((ctx: Ctx) => {
    ctx.update(remarkPluginsCtx, (plugins) => [...plugins, { plugin: remarkHighlight, options: {} }]);
    ctx.update(remarkStringifyOptionsCtx, (options) => {
      const handlers = { ...(options.handlers ?? {}), [HIGHLIGHT_NODE_TYPE]: highlightToMarkdownHandler };
      return { ...options, handlers } as unknown as typeof options;
    });
  });
  editor.use(highlightFeature);
}
