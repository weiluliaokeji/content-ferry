import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";

export type VisualMarkdownSelection = {
  selectedMarkdown: string;
  documentMarkdown: string;
};

export function VisualMarkdownEditor({
  value,
  onChange,
  assetContextId,
  sourceArticlePath,
  onError,
  onTextSelection,
  minHeight = 420
}: {
  value: string;
  onChange: (markdown: string) => void;
  assetContextId: string;
  sourceArticlePath?: string;
  onError?: (message: string) => void;
  onTextSelection?: (selection?: VisualMarkdownSelection) => void;
  minHeight?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
      // ProseMirror handles Tab and several structural shortcuts as editor
      // commands. They can change Markdown without emitting `beforeinput`.
      if (event.key === "Tab" || event.key === "Enter" || event.key === "Backspace" || event.key === "Delete") {
        userHasEdited = true;
      }
    };
    root.addEventListener("beforeinput", markUserEdit);
    root.addEventListener("paste", markUserEdit);
    root.addEventListener("drop", markUserEdit);
    root.addEventListener("cut", markUserEdit);
    root.addEventListener("click", markToolbarEdit);
    root.addEventListener("keydown", markKeyboardEdit);
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
    const crepe = new Crepe({
      root: rootRef.current,
      defaultValue: value,
      features: {
        [Crepe.Feature.AI]: false,
        [Crepe.Feature.CodeMirror]: false,
        [Crepe.Feature.ImageBlock]: true,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.TopBar]: false
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
        if (!disposed && userHasEdited && markdown !== previousMarkdown) onChangeRef.current(markdown);
      });
    });
    void crepe.create().then(() => {
      if (!disposed) crepeRef.current = crepe;
    });

    return () => {
      disposed = true;
      if (crepeRef.current === crepe) crepeRef.current = null;
      root.removeEventListener("beforeinput", markUserEdit);
      root.removeEventListener("paste", markUserEdit);
      root.removeEventListener("drop", markUserEdit);
      root.removeEventListener("cut", markUserEdit);
      root.removeEventListener("click", markToolbarEdit);
      root.removeEventListener("keydown", markKeyboardEdit);
      void crepe.destroy();
    };
  }, []);

  return (
    <div
      className="visual-markdown-editor"
      style={{ minHeight }}
      ref={rootRef}
      aria-label="可视化文章编辑器"
      onMouseUp={() => reportSelection(rootRef.current, crepeRef.current, onTextSelection)}
      onKeyUp={() => reportSelection(rootRef.current, crepeRef.current, onTextSelection)}
    />
  );
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
