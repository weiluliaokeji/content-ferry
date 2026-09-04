import { BrowserWindow, app } from "electron";
import { readFile, writeFile, mkdtemp } from "fs/promises";
import * as path from "path";

/**
 * Render a Mermaid diagram definition to a PNG buffer using a headless
 * Electron BrowserWindow + an in-page canvas.
 *
 * Earlier revisions tried every shape of `webContents.capturePage`:
 *   - hidden + `paintWhenInitiallyHidden: true`
 *   - `offscreen: true` + the `paint` event
 *   - shown, but pushed far off-screen at (-4096, -4096)
 * All three returned blank PNGs. `capturePage` reads the page's compositor
 * framebuffer; in software-rendered Chromium (no working GPU process) and
 * on Windows when the window is occluded/off-screen, that buffer is empty
 * even though the DOM layout reports the correct dimensions. We gave up
 * fighting the compositor.
 *
 * The current approach rasterizes inside the renderer process instead:
 *   1. mermaid renders to SVG (HTML label rendering is disabled so the SVG
 *      stays pure <text> and never contains <foreignObject>, which is what
 *      used to taint 2D canvases in some Chromium versions).
 *   2. We compute the natural size from the SVG viewBox (mermaid emits
 *      `width="100%"`, so the attribute is useless).
 *   3. We embed the SVG into a 2x-canvas via an in-memory data-URL <img>
 *      and call `toDataURL("image/png")`. This path does not depend on
 *      window visibility, GPU health, or the compositor, so it works in
 *      exactly the environments `capturePage` failed in.
 *   4. We hand the base64-encoded PNG back to the main process.
 *
 * The single render window is created lazily and reused. Chromium
 * serializes `executeJavaScript` calls on the same WebContents, so
 * concurrent renders queue naturally.
 */

let renderWindow: BrowserWindow | null = null;
let initPromise: Promise<BrowserWindow> | null = null;

async function createRenderWindow(): Promise<BrowserWindow> {
  // A hidden window is enough — the canvas rasterization path never asks
  // the compositor for a frame. `offscreen:false` (default) is the most
  // compatible setting; the rasterizer does not care either way.
  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1200,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: false
    }
  });
  // Suppress noisy "ContentFerry Mermaid Renderer" title updates from the
  // renderer (we never display the window, so the title never matters).
  win.on("page-title-updated", (event) => event.preventDefault());

  // Load the bundled mermaid UMD into a small page. Reading from
  // `node_modules` works even when packaged (the require.resolve path is
  // honored by electron's asar extraction); inlining the script avoids
  // file:// cross-origin quirks that surface when the page is loaded via
  // a temp dir on Windows.
  const mermaidSource = await readFile(
    require.resolve("mermaid/dist/mermaid.min.js"),
    "utf-8"
  );
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;background:#ffffff}#host{display:inline-block}</style>` +
    `<script>${mermaidSource}</script></head>` +
    `<body><div id="host"></div></body></html>`;
  const tmpDir = await mkdtemp(path.join(app.getPath("temp"), "contentferry-mermaid-"));
  const htmlPath = path.join(tmpDir, "mermaid-render.html");
  await writeFile(htmlPath, html, "utf-8");
  await win.loadFile(htmlPath);
  // Initialize mermaid once for the lifetime of the window. `htmlLabels:false`
  // is the critical bit: it forces labels to be plain SVG <text> instead of
  // nested `<foreignObject>` HTML. The latter has a long history of tainting
  // 2D canvases in Chromium — the very error we hit in the wild — and the
  // visual difference for typical diagrams is negligible.
  await win.webContents.executeJavaScript(
    'window.mermaid.initialize({ ' +
      'startOnLoad: false, ' +
      'securityLevel: "loose", ' +
      'theme: "default", ' +
      'flowchart: { useMaxWidth: false, htmlLabels: false }, ' +
      'sequence: { useMaxWidth: false }, ' +
      'class: { useMaxWidth: false }, ' +
      'state: { useMaxWidth: false }, ' +
      'gantt: { useMaxWidth: false } ' +
    '})'
  );
  // eslint-disable-next-line no-console
  console.log("[mermaid] headless renderer initialized");
  return win;
}

async function getRenderWindow(): Promise<BrowserWindow> {
  if (renderWindow && !renderWindow.isDestroyed()) return renderWindow;
  if (!initPromise) initPromise = createRenderWindow();
  renderWindow = await initPromise;
  return renderWindow;
}

/**
 * Render a mermaid diagram and rasterize it via an in-page canvas. Runs in
 * the renderer process. The returned PNG is base64-encoded so it survives the
 * JSON boundary back to the main process cleanly.
 *
 * NOTE: every line of this template literal is PLAIN JAVASCRIPT that runs
 * inside the renderer. It is NOT TypeScript — do not add type annotations
 * here, they are syntax errors at runtime and the TypeScript compiler
 * only sees a string and cannot catch them.
 */
const RASTER_FN = `
(async (id, source) => {
  try {
    if (typeof window.mermaid !== 'object' || typeof window.mermaid.render !== 'function') {
      return { ok: false, error: 'mermaid 运行时未就绪（window.mermaid 不可用）。' };
    }
    const { svg } = await window.mermaid.render(id, source);
    if (typeof svg !== 'string' || svg.length === 0) {
      return { ok: false, error: 'mermaid.render 未返回 SVG。' };
    }
    const host = document.getElementById('host');
    host.innerHTML = svg;
    const el = host.firstElementChild;
    if (!el || el.tagName.toLowerCase() !== 'svg') {
      return { ok: false, error: '渲染出的 SVG 未在容器中找到。' };
    }
    // mermaid emits width="100%" + style="max-width:Npx;max-height:Npx" on
    // the root <svg>. The width attribute is therefore useless — only the
    // viewBox tells us the diagram's natural pixel size. Fall back to
    // max-* styles or getBoundingClientRect if viewBox is missing.
    const vb = (el.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
    let w = 0, h = 0;
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
      w = vb[2];
      h = vb[3];
    }
    if (!w || !h) {
      const style = el.getAttribute('style') || '';
      const mw = /max-width:\\s*([0-9.]+)px/i.exec(style);
      const mh = /max-height:\\s*([0-9.]+)px/i.exec(style);
      if (mw) w = parseFloat(mw[1]);
      if (mh) h = parseFloat(mh[1]);
    }
    if (!w || !h) {
      const r = el.getBoundingClientRect();
      w = w || r.width;
      h = h || r.height;
    }
    w = Math.ceil(w);
    h = Math.ceil(h);
    if (!w || !h) {
      return { ok: false, error: '无法推断 SVG 尺寸（width/height/viewBox/max-* 均不可用）。' };
    }

    // Normalize the SVG so it rasterizes at exactly w x h. The host's #host
    // element is display:inline-block, but we explicitly stamp width and
    // height + viewBox here so the SVG's own layout is correct regardless of
    // the surrounding DOM.
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    el.removeAttribute('style');
    el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    el.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    let markup = new XMLSerializer().serializeToString(el);
    // PNG must be opaque white. WeChat renders on a white background and a
    // transparent PNG would let the body color bleed through any anti-aliased
    // edges. Add a backdrop rect that covers the full viewBox.
    markup = markup.replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="#ffffff"/>');

    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG <img> failed to load (data URL rejected).'));
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(markup)));
    });

    // Render at 2x for retina-quality output that survives mobile screens.
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { ok: false, error: 'canvas 2D context 不可用。' };
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
      return { ok: false, error: 'canvas.toDataURL 失败（PNG 输出为空或被污染）。' };
    }
    const tmp = document.getElementById(id);
    if (tmp) tmp.remove();
    return { ok: true, dataUrl: dataUrl.slice('data:image/png;base64,'.length), width: w, height: h };
  } catch (error) {
    return {
      ok: false,
      error: error && typeof error === 'object' ? (error.message || error.toString()) : String(error),
      stack: error && typeof error === 'object' && error.stack ? String(error.stack) : undefined
    };
  }
})
`;

interface RasterResult {
  ok: boolean;
  dataUrl?: string;
  width?: number;
  height?: number;
  error?: string;
  stack?: string;
}

/** A render that takes longer than this is treated as failed instead of hanging the publish. */
const RENDER_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）。`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Escape a JS string for safe interpolation into `executeJavaScript`. */
function jsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render a Mermaid diagram definition to a PNG buffer. Throws if mermaid fails
 * to parse or render the diagram (callers decide whether to keep the raw
 * block).
 */
export async function renderMermaidToPng(source: string): Promise<Buffer> {
  const win = await getRenderWindow();
  const id = "mermaid-" + Math.random().toString(36).slice(2);
  const result: unknown = await withTimeout(
    win.webContents.executeJavaScript(`(${RASTER_FN})(${jsString(id)}, ${jsString(source)})`),
    RENDER_TIMEOUT_MS,
    "mermaid 渲染"
  );
  if (!result || typeof result !== "object") {
    throw new Error("mermaid 渲染返回了非对象结果。");
  }
  const r = result as RasterResult;
  if (!r.ok) {
    const detail = (r.error ?? "未知错误") + (r.stack ? `\n${r.stack}` : "");
    throw new Error(`mermaid 渲染失败：${detail}`);
  }
  if (typeof r.dataUrl !== "string" || r.dataUrl.length === 0) {
    throw new Error("mermaid 渲染未返回有效的 PNG dataURL。");
  }
  const buf = Buffer.from(r.dataUrl, "base64");
  // eslint-disable-next-line no-console
  console.log(`[mermaid] rendered ${r.width}x${r.height} → PNG ${buf.length} bytes`);
  if (!buf.length) {
    throw new Error("mermaid 渲染产物为空（PNG 字节数为 0）。");
  }
  return buf;
}

/**
 * Inspect-only render: same as `renderMermaidToPng`, but surfaces errors
 * instead of throwing. Used by the verify harness and any future test.
 */
export async function inspectMermaidRender(source: string): Promise<{
  png: Buffer | null;
  width: number;
  height: number;
  error?: string;
}> {
  try {
    const png = await renderMermaidToPng(source);
    return { png, width: 0, height: 0 };
  } catch (error) {
    return {
      png: null,
      width: 0,
      height: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Force-close the shared render window (e.g. on app quit). Safe to call when no
 * window exists.
 */
export function disposeMermaidRenderer(): void {
  if (renderWindow && !renderWindow.isDestroyed()) {
    renderWindow.destroy();
  }
  renderWindow = null;
  initPromise = null;
}