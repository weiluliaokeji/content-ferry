import { renderMermaidToPng } from "../mermaid/mermaid-render";

/**
 * Render a Mermaid source string to a PNG buffer. Injected by callers so tests
 * can stub rendering without spinning up a BrowserWindow. The default uses the
 * real headless-Chromium renderer.
 */
export type MermaidRenderer = (source: string) => Promise<Buffer>;

export interface MermaidPreprocessOptions {
  /**
   * Upload (or inline) a rendered diagram PNG and return the URL/data-URI that
   * should replace the original ```mermaid block. Per-platform: WeChat uses its
   * image upload endpoint, Cnblogs/Juejin use their uploaders, CSDN/51CTO inline
   * as data URIs that their editors then host.
   */
  uploadImage: (png: Buffer, name: string) => Promise<string>;
  /** Override the renderer (mainly for tests). */
  renderer?: MermaidRenderer;
  /** Called once per diagram that failed to render; the raw block is kept. */
  onError?: (source: string, error: unknown) => void;
}

// Match a fenced ```mermaid block. We deliberately only match the `mermaid`
// language so ordinary code blocks are never touched.
const MERMAID_FENCE = /```mermaid\n([\s\S]*?)\n```/g;

/**
 * Replace every ```mermaid ... ``` block in `markdown` with a Markdown image
 * reference whose source is the uploaded/inline PNG. Non-mermaid code blocks and
 * all other Markdown are left untouched. If a diagram fails to render, the
 * original block is preserved (so the user never silently loses content).
 *
 * Replacement is done from the end of the document backwards so earlier string
 * indices stay valid as we splice.
 */
export async function renderMermaidBlocks(
  markdown: string,
  options: MermaidPreprocessOptions
): Promise<string> {
  const render = options.renderer ?? renderMermaidToPng;
  const matches = [...markdown.matchAll(MERMAID_FENCE)];
  if (matches.length === 0) return markdown;

  let result = markdown;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const full = match[0];
    const start = match.index ?? 0;
    const end = start + full.length;
    const source = (match[1] ?? "").replace(/\r\n/g, "\n").trim();
    if (!source) continue;

    let replacement = full;
    try {
      const png = await render(source);
      const url = await options.uploadImage(png, `mermaid-${index + 1}.png`);
      replacement = `\n![mermaid 图 ${index + 1}](${url})\n`;
    } catch (error) {
      options.onError?.(source, error);
      // Keep the original block so the diagram text is still visible.
    }
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}
