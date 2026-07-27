import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import { redo, undo } from "@milkdown/kit/prose/history";
import { replaceAll } from "@milkdown/kit/utils";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";

export type VisualMarkdownSelection = {
  selectedMarkdown: string;
  documentMarkdown: string;
};

function remoteImageFromClipboard(clipboard: DataTransfer | null): { url: string; alt: string } | undefined {
  if (!clipboard) return undefined;
  const text = clipboard.getData("text/plain").trim();
  const markdown = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)$/i.exec(text);
  if (markdown) return { url: markdown[2], alt: markdown[1] || remoteImageName(markdown[2]) };
  const html = clipboard.getData("text/html");
  if (!html) return undefined;
  const image = new DOMParser().parseFromString(html, "text/html").querySelector<HTMLImageElement>("img[src]");
  if (!image || !/^https?:\/\//i.test(image.src)) return undefined;
  return { url: image.src, alt: image.alt || remoteImageName(image.src) };
}

function remoteImageName(url: string): string {
  try {
    const lastSegment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return lastSegment || "远程图片";
  } catch {
    return "远程图片";
  }
}

export function VisualMarkdownEditor({
  value,
  onChange,
  assetContextId,
  sourceArticlePath,
  onError,
  onTextSelection,
  onSwitchToMarkdown,
  initialScrollOffset,
  suggestions = [],
  suggestionOffsets = {},
  onSuggestionOffsetChange,
  onAcceptSuggestion,
  onRejectSuggestion,
  minHeight = 420
}: {
  value: string;
  onChange: (markdown: string) => void;
  assetContextId: string;
  sourceArticlePath?: string;
  onError?: (message: string) => void;
  onTextSelection?: (selection?: VisualMarkdownSelection) => void;
  onSwitchToMarkdown?: (markdownOffset: number) => void;
  initialScrollOffset?: number;
  suggestions?: Array<{ id: string; original: string; replacement: string; reason: string }>;
  suggestionOffsets?: Record<string, { x: number; y: number }>;
  onSuggestionOffsetChange?: (id: string, offset: { x: number; y: number }) => void;
  onAcceptSuggestion?: (id: string) => void;
  onRejectSuggestion?: (id: string) => void;
  minHeight?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const lastEditorValueRef = useRef<string | undefined>(undefined);
  const suggestionsRef = useRef(suggestions);
  const suggestionCallbacksRef = useRef({ onAcceptSuggestion, onRejectSuggestion });
  const suggestionOffsetsRef = useRef(suggestionOffsets);
  const onSuggestionOffsetChangeRef = useRef(onSuggestionOffsetChange);
  onChangeRef.current = onChange;
  valueRef.current = value;
  suggestionsRef.current = suggestions;
  suggestionCallbacksRef.current = { onAcceptSuggestion, onRejectSuggestion };
  suggestionOffsetsRef.current = suggestionOffsets;
  onSuggestionOffsetChangeRef.current = onSuggestionOffsetChange;

  useEffect(() => {
    if (!rootRef.current) return;
    let disposed = false;
    let userHasEdited = false;
    const root = rootRef.current;
    const markUserEdit = () => { userHasEdited = true; };
    const markToolbarEdit = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest("button")) userHasEdited = true;
    };
    const markKeyboardEdit = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && (key === "z" || key === "y")) {
        const historyCommand = key === "y" || event.shiftKey ? redo : undo;
        const handled = crepeRef.current?.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          return historyCommand(view.state, view.dispatch, view);
        });
        if (handled) {
          userHasEdited = true;
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      // ProseMirror handles Tab and several structural shortcuts as editor
      // commands. They can change Markdown without emitting `beforeinput`.
      if (event.key === "Tab" || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete") {
        userHasEdited = true;
      }
    };
    const copySelection = (event: ClipboardEvent) => {
      const copied = crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        if (from === to) return "";
        return view.state.doc.textBetween(from, to, "\n");
      });
      if (!copied || !event.clipboardData) return;
      event.clipboardData.setData("text/plain", copied);
      event.preventDefault();
    };
    root.addEventListener("beforeinput", markUserEdit);
    root.addEventListener("paste", markUserEdit);
    root.addEventListener("drop", markUserEdit);
    root.addEventListener("cut", markUserEdit);
    root.addEventListener("click", markToolbarEdit);
    root.addEventListener("keydown", markKeyboardEdit, true);
    root.addEventListener("copy", copySelection);
    const uploadImage = async (file: File): Promise<string> => {
      try {
        if (file.size > 15 * 1024 * 1024) throw new Error("图片文件不能超过 15 MB。");
        const mimeType = normalizeImageMime(file);
        const base64 = await fileToBase64(file);
        const response = await fetch(`http://127.0.0.1:4317/api/${sourceArticlePath ? "content-source/article-asset" : "content-assets"}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sourceArticlePath
            ? { path: sourceArticlePath, mimeType, base64 }
            : { contextId: assetContextId, mimeType, base64 })
        });
        const payload = await response.json() as { assetUrl?: string; error?: string };
        if (!response.ok || !payload.assetUrl) throw new Error(payload.error ?? "图片保存失败。");
        return payload.assetUrl;
      } catch (error) {
        const message = error instanceof Error ? error.message : "图片保存失败。";
        onError?.(message);
        throw error;
      }
    };
    const importRemoteImage = async (url: string): Promise<string> => {
      try {
        const response = await fetch(`http://127.0.0.1:4317/api/${sourceArticlePath ? "content-source/article-asset/import-remote" : "content-assets/import-remote"}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sourceArticlePath ? { path: sourceArticlePath, url } : { contextId: assetContextId, url })
        });
        const payload = await response.json() as { assetUrl?: string; error?: string };
        if (!response.ok || !payload.assetUrl) throw new Error(payload.error ?? "远程图片下载失败。");
        return payload.assetUrl;
      } catch (error) {
        const message = error instanceof Error ? error.message : "远程图片下载失败。";
        onError?.(message);
        throw error;
      }
    };
    const insertImportedImage = (source: string, alt: string) => {
      const inserted = crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const imageType = view.state.schema.nodes.image;
        if (!imageType) return false;
        view.dispatch(view.state.tr.replaceSelectionWith(imageType.create({ src: source, alt })).scrollIntoView());
        view.focus();
        return true;
      });
      if (!inserted) onError?.("图片已保存，但无法插入到当前位置。");
    };
    const importPastedImage = (event: ClipboardEvent) => {
      const clipboardImage = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile();
      if (clipboardImage) {
        event.preventDefault();
        event.stopPropagation();
        userHasEdited = true;
        void uploadImage(clipboardImage).then((source) => insertImportedImage(source, clipboardImage.name || "粘贴图片")).catch(() => undefined);
        return;
      }
      const candidate = remoteImageFromClipboard(event.clipboardData);
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      userHasEdited = true;
      void importRemoteImage(candidate.url).then((source) => insertImportedImage(source, candidate.alt)).catch(() => undefined);
    };
    root.addEventListener("paste", importPastedImage, true);
    const crepe = new Crepe({
      root: rootRef.current,
      // Markdown treats a single line break as whitespace, while authors who
      // edit a VitePress source file often intentionally use it as a visual
      // line break. Preserve that intent in WYSIWYG mode by upgrading only
      // ordinary soft breaks to Markdown hard breaks before Milkdown parses.
      defaultValue: preserveVisualLineBreaks(value),
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.CodeMirror]: false,
        [Crepe.Feature.ImageBlock]: true,
        [Crepe.Feature.Latex]: false,
        // Keep the compact selection toolbar, but also expose the common
        // structural actions in a persistent bar. This makes lists and
        // tables discoverable instead of requiring users to know `/`.
        [Crepe.Feature.TopBar]: true
      },
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: {
          onUpload: uploadImage,
          inlineOnUpload: uploadImage,
          blockOnUpload: uploadImage,
          proxyDomURL: (url) => {
            if (sourceArticlePath && isLocalArticleImage(url)) {
              return `http://127.0.0.1:4317/api/content-source/article-resource?path=${encodeURIComponent(sourceArticlePath)}&src=${encodeURIComponent(url)}`;
            }
            if (!url.startsWith("contentferry-asset://")) return url;
            const relative = url.slice("contentferry-asset://".length);
            return `http://127.0.0.1:4317/api/content-assets/${relative}`;
          }
        }
      }
    });
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, previousMarkdown) => {
        // Crepe may normalize Markdown while constructing the document. That is
        // not a user edit and must not make a freshly opened article look dirty.
        if (!disposed && userHasEdited && markdown !== previousMarkdown) {
          // The parent will pass this exact value back as a prop. Remember it
          // so that round trip is not mistaken for an external replacement,
          // which would rebuild the document and move the caret to the end.
          const normalizedMarkdown = normalizeSerializedLineBreaks(markdown);
          lastEditorValueRef.current = normalizedMarkdown;
          onChangeRef.current(normalizedMarkdown);
        }
      });
    });
    void crepe.create().then(() => {
      if (!disposed) {
        crepeRef.current = crepe;
        setEditorReady(true);
        const visualValue = preserveVisualLineBreaks(valueRef.current);
        if (crepe.getMarkdown() !== visualValue) crepe.editor.action(replaceAll(visualValue));
      }
    });

    return () => {
      disposed = true;
      if (crepeRef.current === crepe) crepeRef.current = null;
      setEditorReady(false);
      root.removeEventListener("beforeinput", markUserEdit);
      root.removeEventListener("paste", markUserEdit);
      root.removeEventListener("drop", markUserEdit);
      root.removeEventListener("cut", markUserEdit);
      root.removeEventListener("click", markToolbarEdit);
      root.removeEventListener("keydown", markKeyboardEdit, true);
      root.removeEventListener("copy", copySelection);
      root.removeEventListener("paste", importPastedImage, true);
      void crepe.destroy();
    };
  }, []);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (value === lastEditorValueRef.current) {
      lastEditorValueRef.current = undefined;
      return;
    }
    const visualValue = preserveVisualLineBreaks(value);
    if (!crepe || crepe.getMarkdown() === visualValue) return;
    // Keep programmatic changes (for example an accepted AI suggestion) in
    // the same ProseMirror history, so Ctrl+Z can undo them as well.
    crepe.editor.action(replaceAll(visualValue));
  }, [value]);

  useEffect(() => {
    const root = rootRef.current;
    if (!editorReady || !root || initialScrollOffset === undefined) return;
    const visibleLine = markdownToVisibleText(markdownLineNearOffset(value, initialScrollOffset));
    const editorRoot = root.querySelector<HTMLElement>(".ProseMirror");
    if (!visibleLine || !editorRoot) return;
    const range = findUniqueTextRange(editorRoot, [visibleLine]);
    const block = range ? closestSuggestionBlock(range.startContainer, root) : undefined;
    let stopped = false;
    const alignTopVisibleContent = () => {
      if (stopped) return;
      const canvas = root.closest<HTMLElement>(".editor-canvas");
      if (!canvas) return;
      if (block) {
        const canvasRect = canvas.getBoundingClientRect();
        const blockRect = block.getBoundingClientRect();
        canvas.scrollTop = Math.max(0, canvas.scrollTop + blockRect.top - canvasRect.top - 52);
        return;
      }
      const available = Math.max(0, canvas.scrollHeight - canvas.clientHeight);
      canvas.scrollTop = available * Math.max(0, Math.min(1, initialScrollOffset / Math.max(1, value.length)));
    };
    // Milkdown, fonts and article images can complete layout at different
    // moments. Re-align briefly while the newly mounted view settles. Any
    // deliberate wheel/pointer interaction cancels the remaining passes.
    const canvas = root.closest<HTMLElement>(".editor-canvas");
    const stopAlignment = () => { stopped = true; };
    canvas?.addEventListener("wheel", stopAlignment, { once: true });
    canvas?.addEventListener("pointerdown", stopAlignment, { once: true });
    const frame = requestAnimationFrame(() => requestAnimationFrame(alignTopVisibleContent));
    const timers = [120, 360, 800].map((delay) => window.setTimeout(alignTopVisibleContent, delay));
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      timers.forEach((timer) => clearTimeout(timer));
      canvas?.removeEventListener("wheel", stopAlignment);
      canvas?.removeEventListener("pointerdown", stopAlignment);
    };
  }, [editorReady, initialScrollOffset]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.classList.remove("has-awen-suggestions");
    root.querySelectorAll(".awen-inline-suggestion").forEach((node) => node.remove());
    if (suggestions.length === 0) return;
    const editorRoot = root.querySelector<HTMLElement>(".ProseMirror");
    if (!editorRoot) return;
    const adjustedBlocks = new Map<HTMLElement, string>();
    const originalMargins = new Map<HTMLElement, number>();
    const reservedBelowBlock = new Map<HTMLElement, number>();
    for (const suggestion of suggestions) {
      // Suggestions are anchored in Markdown, whereas the visual editor
      // renders headings, emphasis and links without their Markdown marks.
      // Match either form, and support text that spans several DOM nodes.
      const original = suggestion.original.trim();
      const range = findUniqueTextRange(editorRoot, suggestionAnchorCandidates(original));
      if (!range) continue;
      const targetBlock = closestSuggestionBlock(range.startContainer, root);
      if (!targetBlock) continue;
      const reservedBefore = reservedBelowBlock.get(targetBlock) ?? 0;
      const rect = targetBlock.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const bubble = document.createElement("div");
      bubble.className = "awen-inline-suggestion";
      // Unlike a comment rail, an IDE-style suggestion belongs immediately
      // after the paragraph it changes. Reserve vertical room below that
      // paragraph so the card never covers the following text.
      bubble.style.top = `${Math.max(0, rect.bottom - rootRect.top + 8 + reservedBefore)}px`;
      bubble.style.left = `${Math.max(12, rect.left - rootRect.left)}px`;
      bubble.innerHTML = `<strong>阿文建议</strong><span>${escapeHtml(suggestion.reason)}</span><div><button type="button" data-action="accept">同意</button><button type="button" data-action="reject">拒绝</button></div>`;
      bubble.querySelector<HTMLButtonElement>("[data-action='accept']")?.addEventListener("click", () => suggestionCallbacksRef.current.onAcceptSuggestion?.(suggestion.id));
      bubble.querySelector<HTMLButtonElement>("[data-action='reject']")?.addEventListener("click", () => suggestionCallbacksRef.current.onRejectSuggestion?.(suggestion.id));
      root.appendChild(bubble);
      if (!adjustedBlocks.has(targetBlock)) {
        adjustedBlocks.set(targetBlock, targetBlock.style.marginBottom);
        originalMargins.set(targetBlock, Number.parseFloat(getComputedStyle(targetBlock).marginBottom) || 0);
      }
      const baseMargin = originalMargins.get(targetBlock) ?? 0;
      targetBlock.classList.add("has-awen-suggestion-target");
      // The root is the positioning context, so this anchor remains stable
      // when the editor is unmounted and rebuilt after switching modes. The
      // persisted offset is intentionally relative to the matched paragraph,
      // not to the page scroll position.
      const baseTop = Number.parseFloat(bubble.style.top) || 0;
      const baseLeft = Number.parseFloat(bubble.style.left) || 12;
      let activeOffset = suggestionOffsetsRef.current[suggestion.id] ?? { x: 0, y: 0 };
      const applySuggestionPosition = (offset: { x: number; y: number }) => {
        const safeY = Math.max(0, offset.y);
        const maxLeft = Math.max(12, root.clientWidth - bubble.offsetWidth - 12);
        bubble.style.left = `${Math.min(maxLeft, Math.max(12, baseLeft + offset.x))}px`;
        bubble.style.top = `${Math.max(0, baseTop + safeY)}px`;
        // Reserve exactly the room occupied below the anchor. This prevents a
        // dragged card from covering the next paragraph.
        targetBlock.style.marginBottom = `${baseMargin + reservedBefore + bubble.offsetHeight + safeY + 12}px`;
      };
      applySuggestionPosition(activeOffset);
      reservedBelowBlock.set(targetBlock, reservedBefore + bubble.offsetHeight + Math.max(0, activeOffset.y) + 12);
      const actions = bubble.querySelector<HTMLDivElement>("div");
      const dragHandle = document.createElement("button");
      dragHandle.type = "button";
      dragHandle.className = "awen-suggestion-drag-handle";
      dragHandle.textContent = "↕";
      dragHandle.title = "拖动建议位置";
      dragHandle.setAttribute("aria-label", "拖动建议位置");
      actions?.prepend(dragHandle);
      dragHandle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startY = event.clientY;
        const offsetAtStart = activeOffset;
        dragHandle.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          activeOffset = {
            x: offsetAtStart.x + moveEvent.clientX - startX,
            y: Math.max(0, offsetAtStart.y + moveEvent.clientY - startY)
          };
          applySuggestionPosition(activeOffset);
        };
        const finish = () => {
          dragHandle.removeEventListener("pointermove", move);
          dragHandle.removeEventListener("pointerup", finish);
          dragHandle.removeEventListener("pointercancel", finish);
          onSuggestionOffsetChangeRef.current?.(suggestion.id, activeOffset);
        };
        dragHandle.addEventListener("pointermove", move);
        dragHandle.addEventListener("pointerup", finish);
        dragHandle.addEventListener("pointercancel", finish);
      });
    }
    return () => {
      root.querySelectorAll(".awen-inline-suggestion").forEach((node) => node.remove());
      adjustedBlocks.forEach((marginBottom, block) => {
        block.style.marginBottom = marginBottom;
        block.classList.remove("has-awen-suggestion-target");
      });
    };
  }, [suggestions, editorReady]);

  return <div className="visual-editor-shell">
    <div className="editor-inline-mode-switch editor-mode-switch" aria-label="编辑模式">
      <button type="button" className="active editor-mode-icon" title="当前：所见即所得编辑" aria-label="当前：所见即所得编辑">✎</button>
      <button type="button" className="editor-mode-icon" title="切换到 Markdown 原文" aria-label="切换到 Markdown 原文" onClick={() => onSwitchToMarkdown?.(readVisibleMarkdownOffset(rootRef.current, crepeRef.current, value))}>{"</>"}</button>
    </div>
    <div
      className="visual-markdown-editor"
      style={{ minHeight }}
      ref={rootRef}
      aria-label="可视化文章编辑器"
      onMouseUp={() => reportSelection(rootRef.current, crepeRef.current, onTextSelection)}
      onKeyUp={() => reportSelection(rootRef.current, crepeRef.current, onTextSelection)}
    />
  </div>;
}

function readVisibleMarkdownOffset(root: HTMLElement | null, crepe: Crepe | null, markdown: string): number {
  if (!root || !crepe) return 0;
  const canvas = root.closest<HTMLElement>(".editor-canvas");
  const proseMirror = root.querySelector<HTMLElement>(".ProseMirror");
  if (!canvas || !proseMirror) return 0;
  const canvasRect = canvas.getBoundingClientRect();
  const editorRect = proseMirror.getBoundingClientRect();
  const visibleTop = canvasRect.top + 52;
  const blocks = [...proseMirror.children].filter((item): item is HTMLElement => item instanceof HTMLElement);
  const visibleBlock = blocks.find((block) => block.getBoundingClientRect().bottom > visibleTop);
  const expectedOffset = visibleBlock
    ? Math.round(markdown.length * Math.max(0, blocks.indexOf(visibleBlock)) / Math.max(1, blocks.length - 1))
    : Math.round(markdown.length * canvas.scrollTop / Math.max(1, canvas.scrollHeight - canvas.clientHeight));
  const visibleText = visibleBlock?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const matchedOffset = markdownOffsetForVisibleText(markdown, visibleText, expectedOffset);
  if (matchedOffset !== undefined) return matchedOffset;

  const point = crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    return view.posAtCoords({
      left: Math.max(editorRect.left + 16, canvasRect.left + 16),
      top: Math.max(editorRect.top + 8, visibleTop)
    });
  });
  if (!point) {
    const available = Math.max(1, canvas.scrollHeight - canvas.clientHeight);
    return Math.round(markdown.length * canvas.scrollTop / available);
  }
  return crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const serializer = ctx.get(serializerCtx);
    const slice = view.state.doc.slice(0, point.pos);
    const wrapper = view.state.schema.topNodeType.createAndFill(null, slice.content);
    return Math.min(markdown.length, wrapper ? serializer(wrapper).length : Math.round(markdown.length * point.pos / Math.max(1, view.state.doc.content.size)));
  });
}

function markdownOffsetForVisibleText(markdown: string, visibleText: string, expectedOffset: number): number | undefined {
  if (visibleText.length < 2) return undefined;
  const candidates: number[] = [];
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const renderedLine = markdownToVisibleText(line);
    if (renderedLine.length >= 2 && (visibleText.startsWith(renderedLine) || renderedLine.startsWith(visibleText))) candidates.push(offset);
    offset += line.length + 1;
  }
  if (!candidates.length) return undefined;
  return candidates.reduce((best, candidate) =>
    Math.abs(candidate - expectedOffset) < Math.abs(best - expectedOffset) ? candidate : best
  );
}

function markdownLineNearOffset(markdown: string, offset: number): string {
  const safeOffset = Math.max(0, Math.min(markdown.length, offset));
  const before = markdown.lastIndexOf("\n", safeOffset);
  const after = markdown.indexOf("\n", safeOffset);
  const current = markdown.slice(before + 1, after < 0 ? markdown.length : after).trim();
  if (markdownToVisibleText(current).length >= 4) return current;
  const remaining = markdown.slice(after < 0 ? safeOffset : after + 1).split("\n");
  return remaining.find((line) => markdownToVisibleText(line).length >= 4) ?? current;
}

function findUniqueTextRange(root: HTMLElement, candidates: string[]): Range | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) nodes.push(node);
  const source = nodes.map((item) => item.data).join("");

  for (const candidate of [...new Set(candidates.map((item) => item.trim()).filter(Boolean))]) {
    const exactStart = uniqueTextStart(source, candidate);
    if (exactStart >= 0) return rangeFromTextNodes(nodes, exactStart, exactStart + candidate.length);

    const normalizedSource = normalizeTextWithOffsets(source);
    const normalizedCandidate = candidate.replace(/\s+/g, " ").trim();
    const normalizedStart = uniqueTextStart(normalizedSource.text, normalizedCandidate);
    if (normalizedStart >= 0) {
      const rawStart = normalizedSource.starts[normalizedStart];
      const rawEnd = normalizedSource.ends[normalizedStart + normalizedCandidate.length - 1];
      return rangeFromTextNodes(nodes, rawStart, rawEnd);
    }
  }
  return undefined;
}

function uniqueTextStart(haystack: string, needle: string): number {
  if (!needle) return -1;
  const start = haystack.indexOf(needle);
  return start >= 0 && haystack.indexOf(needle, start + needle.length) < 0 ? start : -1;
}

function rangeFromTextNodes(nodes: Text[], start: number, end: number): Range | undefined {
  let offset = 0;
  let startNode: Text | undefined;
  let startOffset = 0;
  for (const node of nodes) {
    const nodeEnd = offset + node.data.length;
    if (!startNode && start >= offset && start <= nodeEnd) {
      startNode = node;
      startOffset = start - offset;
    }
    if (startNode && end >= offset && end <= nodeEnd) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(node, end - offset);
      return range;
    }
    offset = nodeEnd;
  }
  return undefined;
}

function normalizeTextWithOffsets(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      if (!text || text.endsWith(" ")) {
        if (text.endsWith(" ")) ends[ends.length - 1] = index + 1;
        continue;
      }
      text += " ";
    } else {
      text += character;
    }
    starts.push(index);
    ends.push(index + 1);
  }
  return { text, starts, ends };
}

function markdownToVisibleText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-+*]|\d+\.)\s+/gm, "")
    .replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, "$1")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function suggestionAnchorCandidates(original: string): string[] {
  const rendered = markdownToVisibleText(original);
  // A model can legitimately return a Markdown fragment spanning several
  // list rows, table cells or inline marks. The complete source is unique in
  // Markdown but may not be one continuous browser text node after rendering.
  // Fall back only to substantial, still-unique pieces so a card remains
  // attached to the relevant paragraph rather than disappearing.
  const fragments = original
    .split(/\r?\n|[|。！？!?；;]/)
    .map((item) => markdownToVisibleText(item))
    .filter((item) => item.length >= 8);
  return [original, rendered, ...fragments];
}

function closestSuggestionBlock(node: Node, root: HTMLElement): HTMLElement | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  const block = element?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, table");
  return block instanceof HTMLElement && root.contains(block) ? block : undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character] ?? character));
}

function preserveVisualLineBreaks(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  return lines.map((line, index) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const next = lines[index + 1];
    if (inFence || next === undefined || !line.trim() || !next.trim()) return line;
    // Existing hard breaks, list items, block syntax and front matter should
    // retain their native Markdown meaning.
    if (/ {2,}$|\\$/.test(line) || /^\s*(?:[-+*]|\d+\.)\s|^\s*(?:>|#{1,6}\s|---$|\*\*\*$)/.test(line) || /^\s*(?:[-+*]|\d+\.)\s/.test(next)) return line;
    return `${line}  `;
  }).join("\n");
}

function normalizeSerializedLineBreaks(markdown: string): string {
  let inFence = false;
  return markdown.replace(/\r?\n/g, "\n").split("\n").map((line) => {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) return line.replace(/\\[ \t]*$/, "  ");
    return line;
  }).join("\n");
}

function reportSelection(root: HTMLDivElement | null, crepe: Crepe | null, callback?: (selection?: VisualMarkdownSelection) => void): void {
  if (!root || !callback) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
    callback(undefined);
    return;
  }
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return;
  const markdownSelection = readMarkdownSelection(crepe);
  if (markdownSelection) {
    callback(markdownSelection);
    return;
  }
  const selectedMarkdown = selection.toString().trim();
  if (crepe && selectedMarkdown) callback({ selectedMarkdown, documentMarkdown: crepe.getMarkdown() });
}

/**
 * Browser Selection only exposes rendered text, so headings lose their `##`
 * markers and can no longer be located in the Markdown source. Serialize the
 * ProseMirror selection instead, preserving headings, lists, links and marks.
 */
function readMarkdownSelection(crepe: Crepe | null): VisualMarkdownSelection | undefined {
  if (!crepe) return undefined;
  return crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const serializer = ctx.get(serializerCtx);
    const { state } = view;
    if (state.selection.empty) return undefined;

    const { from, to } = state.selection;
    const slice = state.doc.slice(from, to);
    const { schema } = state.doc.type;
    let wrapper = schema.topNodeType.createAndFill(null, slice.content);
    if (!wrapper) {
      const paragraph = schema.nodes.paragraph?.createAndFill(null, slice.content);
      if (paragraph) wrapper = schema.topNodeType.createAndFill(null, paragraph);
    }
    const selectedMarkdown = (wrapper ? serializer(wrapper) : state.doc.textBetween(from, to)).trim();
    if (!selectedMarkdown) return undefined;
    return { selectedMarkdown, documentMarkdown: serializer(state.doc) };
  });
}

function normalizeImageMime(file: File): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp") return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  throw new Error("只支持 JPG、PNG、GIF 和 WebP 图片。");
}

function isLocalArticleImage(url: string): boolean {
  return !/^(?:https?:|data:|blob:|contentferry-asset:)/i.test(url);
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
