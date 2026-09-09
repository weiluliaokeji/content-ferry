/**
 * 编辑器内的 mermaid 实时预览（Obsidian 同款交互）。
 *
 * 为什么用 Decoration 而不是 NodeView / `@milkdown/plugin-diagram`：
 * - 文渡把本地 Markdown 当 canonical 内容源，```mermaid 必须原样存回文件。
 *   plugin-diagram 会把代码块换成 diagram 节点，等于在编辑器里打开一次就改写存盘格式，
 *   与「本地 Markdown 为准」冲突。
 * - NodeView 按节点名注册，无法只挑 mermaid；Decoration 天然可以按 language 条件生效。
 *
 * 交互（对齐 Obsidian）：
 * - 默认把 code_block[language=mermaid] 隐藏、在其位置显示渲染出的 PNG；
 * - 点击图片切回源码并把光标放进去，光标离开该块后自动恢复为图片；
 * - 渲染失败（语法还没写完是常态）时**不隐藏源码**，只在块上方显示原因。
 *
 * 文档结构全程不变，所有效果都只是装饰层。
 */
import type { Node as ProsemirrorNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** code_block 的语言标记，与 commonmark 的 fence info 一致。 */
const MERMAID_LANGUAGE = "mermaid";
/** 源码隐藏类名，配合 styles.css 里的 `.cf-mermaid-src-hidden`。 */
const SOURCE_HIDDEN_CLASS = "cf-mermaid-src-hidden";
/** 打字过程中频繁触发，节流避免每个字符都开一次渲染窗口。 */
const RENDER_DEBOUNCE_MS = 400;
/** 同一篇文章里图表数量有限，缓存上限防止长会话累积。 */
const CACHE_LIMIT = 40;

export type MermaidRenderOutcome = { ok: true; dataUrl: string } | { ok: false; error: string };

/** 渲染入口，抽成参数是为了测试时可替换（测试环境没有 `window.contentFerry`）。 */
export type MermaidRenderer = (source: string) => Promise<MermaidRenderOutcome>;

const defaultRenderer: MermaidRenderer = async (source) => {
  const api = (globalThis as { contentFerry?: { renderMermaid?: (s: string) => Promise<MermaidRenderOutcome> } }).contentFerry;
  if (!api?.renderMermaid) return { ok: false, error: "当前环境不支持 mermaid 预览。" };
  return api.renderMermaid(source);
};

/** 收集文档里所有 mermaid 代码块。 */
export function collectMermaidBlocks(doc: ProsemirrorNode): Array<{ pos: number; node: ProsemirrorNode }> {
  const found: Array<{ pos: number; node: ProsemirrorNode }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "code_block" && node.attrs.language === MERMAID_LANGUAGE) found.push({ pos, node });
  });
  return found;
}

/** 取某个源码块在文档里的绝对区间，找不到返回 null。 */
function blockRangeFor(doc: ProsemirrorNode, source: string): { start: number; end: number } | null {
  const block = collectMermaidBlocks(doc).find((entry) => entry.node.textContent === source);
  if (!block) return null;
  return { start: block.pos, end: block.pos + block.node.nodeSize };
}

export const mermaidPreviewKey = new PluginKey<MermaidPreviewState>("cf-mermaid-preview");

type MermaidPreviewState = {
  /** 正在以源码方式编辑的块。用**源码**而非位置标识：位置随输入漂移，源码不会。 */
  editing: string | null;
  /** source → 渲染结果，避免同一张图重复开渲染窗口。 */
  cache: Map<string, MermaidRenderOutcome>;
};

/**
 * 渲染调度：防抖 + in-flight 去重 + LRU 缓存。
 * 放在插件外而非 plugin state，因为定时任务和请求是副作用，不应进 state。
 */
function createRenderScheduler(render: MermaidRenderer, cache: Map<string, MermaidRenderOutcome>) {
  const inFlight = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(source: string) => void>();

  const remember = (source: string, outcome: MermaidRenderOutcome): void => {
    cache.set(source, outcome);
    // 简易 LRU：Map 保持插入顺序，超限淘汰最早写入的。
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  return {
    subscribe(listener: (source: string) => void): void {
      listeners.add(listener);
    },
    /** 命中缓存直接返回；否则排一次防抖渲染并返回 undefined。 */
    request(source: string): MermaidRenderOutcome | undefined {
      const cached = cache.get(source);
      if (cached) return cached;
      if (inFlight.has(source) || timers.has(source)) return undefined;
      const timer = setTimeout(() => {
        timers.delete(source);
        if (cache.has(source) || inFlight.has(source)) return;
        inFlight.add(source);
        void render(source)
          .then((outcome) => remember(source, outcome))
          .catch((error: unknown) =>
            remember(source, { ok: false, error: error instanceof Error ? error.message : String(error) })
          )
          .finally(() => {
            inFlight.delete(source);
            listeners.forEach((listener) => listener(source));
          });
      }, RENDER_DEBOUNCE_MS);
      timers.set(source, timer);
      return undefined;
    },
    dispose(): void {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    }
  };
}

function makeImage(dataUrl: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "cf-mermaid-live__image";
  img.src = dataUrl;
  img.alt = "mermaid 图";
  img.draggable = false;
  return img;
}

function makePlaceholder(): HTMLElement {
  const box = document.createElement("div");
  box.className = "cf-mermaid-live__placeholder";
  box.textContent = "正在渲染图表…";
  return box;
}

function makeError(message: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "cf-mermaid-live__error";
  box.textContent = `图表暂时无法渲染：${message}`;
  return box;
}

/** 按结果状态重画 widget 容器。 */
function paint(host: HTMLElement, outcome: MermaidRenderOutcome | undefined): void {
  if (outcome?.ok) {
    host.replaceChildren(makeImage(outcome.dataUrl));
    host.dataset.state = "ready";
    return;
  }
  if (outcome && !outcome.ok) {
    host.replaceChildren(makeError(outcome.error));
    host.dataset.state = "error";
    return;
  }
  host.replaceChildren(makePlaceholder());
  host.dataset.state = "loading";
}

/**
 * 构建 mermaid 实时预览插件。
 * @param render 渲染实现，默认走 `window.contentFerry.renderMermaid`。
 */
export function createMermaidPreviewPlugin(render: MermaidRenderer = defaultRenderer) {
  const cache = new Map<string, MermaidRenderOutcome>();
  const scheduler = createRenderScheduler(render, cache);
  let view: EditorView | null = null;

  // 结果回来后原地更新 DOM：widget 的 key 与 source 绑定，ProseMirror 会复用同一节点，
  // 所以直接改 DOM 即可，不必 dispatch（dispatch 会触发装饰重算，可能打断输入）。
  scheduler.subscribe((source) => {
    if (!view) return;
    const outcome = cache.get(source);
    if (!outcome) return;
    view.dom
      .querySelectorAll<HTMLElement>(".cf-mermaid-live[data-mermaid-source]")
      .forEach((host) => {
        if (host.dataset.mermaidSource === source) paint(host, outcome);
      });
  });

  return new Plugin<MermaidPreviewState>({
    key: mermaidPreviewKey,
    state: {
      init: () => ({ editing: null, cache }),
      apply(tr: Transaction, prev: MermaidPreviewState): MermaidPreviewState {
        const meta = tr.getMeta(mermaidPreviewKey) as { editing?: string | null } | undefined;
        if (meta && "editing" in meta) return { ...prev, editing: meta.editing ?? null };
        // 光标离开正在编辑的块后自动恢复为图片。这里用 tr.doc 而不是旧 state，
        // 因为编辑过程中文档已经变了。
        if (prev.editing && tr.selectionSet) {
          const range = blockRangeFor(tr.doc, prev.editing);
          const inside = range !== null && tr.selection.from >= range.start && tr.selection.to <= range.end;
          if (!inside) return { ...prev, editing: null };
        }
        return prev;
      }
    },
    props: {
      decorations(state: EditorState): DecorationSet {
        const pluginState = mermaidPreviewKey.getState(state);
        const blocks = collectMermaidBlocks(state.doc);
        if (blocks.length === 0) return DecorationSet.empty;

        const decorations: Decoration[] = [];
        for (const { pos, node } of blocks) {
          const source = node.textContent;
          if (pluginState?.editing === source) continue; // 让人能改源码

          // 在这里而不是 widget 的 toDOM 里发起渲染：toDOM 要等 ProseMirror 真正
          // 把装饰挂到 DOM 上才触发，会晚一拍；装饰计算每次 state 变化都跑，
          // 由 scheduler 负责防抖与去重，不会重复开渲染窗口。
          scheduler.request(source);
          const cached = cache.get(source);
          // 渲染失败时不隐藏源码——作者得能看见并继续修改。
          const hideable = cached?.ok !== false;

          if (hideable) {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: SOURCE_HIDDEN_CLASS }));
          }
          decorations.push(
            Decoration.widget(
              pos,
              () => {
                const host = document.createElement("div");
                host.className = "cf-mermaid-live";
                host.dataset.mermaidSource = source;
                host.contentEditable = "false";
                host.title = "点击编辑图表源码";
                paint(host, cached);
                host.addEventListener("mousedown", (event) => {
                  // 必须 preventDefault，否则浏览器会先落一个光标位置再触发本逻辑。
                  event.preventDefault();
                  const currentView = view;
                  if (!currentView) return;
                  const range = blockRangeFor(currentView.state.doc, source);
                  if (!range) return;
                  const doc = currentView.state.doc;
                  // 落在块的文本内容里（起点 +1 跳过 code_block 自身的开标签位置）。
                  const caret = Math.min(range.start + 1, Math.max(range.start, range.end - 1));
                  const tr = currentView.state.tr
                    .setSelection(TextSelection.near(doc.resolve(caret)))
                    .setMeta(mermaidPreviewKey, { editing: source });
                  currentView.dispatch(tr);
                  currentView.focus();
                });
                return host;
              },
              { key: `cf-mermaid:${source}`, side: -1, ignoreSelection: true }
            )
          );
        }
        return DecorationSet.create(state.doc, decorations);
      }
    },
    view(editorView: EditorView) {
      view = editorView;
      return {
        destroy(): void {
          scheduler.dispose();
          view = null;
        }
      };
    }
  });
}

/** 在编辑器上启用 mermaid 实时预览。同 `useHighlight`，必须在 `create()` 之前调用。 */
export const mermaidPreview = $prose(() => createMermaidPreviewPlugin());

export function useMermaidPreview(editor: { use: (plugin: ReturnType<typeof $prose>) => void }): void {
  editor.use(mermaidPreview);
}
