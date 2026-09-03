import { BrowserWindow, app } from "electron";
import { readFile, writeFile, mkdtemp } from "fs/promises";
import * as path from "path";

/**
 * Render a Mermaid diagram definition to a PNG buffer using a headless
 * Electron BrowserWindow. We reuse the app's own Chromium (no puppeteer /
 * extra download): load the bundled mermaid UMD bundle into a hidden page,
 * call `mermaid.render` to get SVG, then rasterize that SVG to PNG with the
 * page's own canvas so fonts and styling match what a browser would show.
 *
 * The single render window is created lazily and reused across calls. Chromium
 * serializes `executeJavaScript` calls on the same WebContents, so concurrent
 * renders are effectively queued — which is what we want (mermaid.render
 * mutates a shared temporary container).
 */

let renderWindow: BrowserWindow | null = null;
let initPromise: Promise<BrowserWindow> | null = null;

async function createRenderWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // No remote content is loaded; we only inject the local mermaid bundle.
      allowRunningInsecureContent: false
    }
  });
  win.on("page-title-updated", (event) => event.preventDefault());

  // Read the mermaid UMD bundle from node_modules (readable even from asar)
  // and inline it into a temp HTML file. Inlining avoids file:// cross-origin
  // and asar path issues when loading the script.
  const mermaidSource = await readFile(require.resolve("mermaid/dist/mermaid.min.js"), "utf-8");
  const html = `<!doctype html><html><head><meta charset="utf-8"><script>${mermaidSource}</script></head><body></body></html>`;
  const tmpDir = await mkdtemp(path.join(app.getPath("temp"), "contentferry-mermaid-"));
  const htmlPath = path.join(tmpDir, "mermaid-render.html");
  await writeFile(htmlPath, html, "utf-8");
  await win.loadFile(htmlPath);
  await win.webContents.executeJavaScript(
    'window.mermaid.initialize({ startOnLoad: false, securityLevel: "loose", theme: "default" })'
  );
  return win;
}

async function getRenderWindow(): Promise<BrowserWindow> {
  if (renderWindow && !renderWindow.isDestroyed()) return renderWindow;
  if (!initPromise) initPromise = createRenderWindow();
  renderWindow = await initPromise;
  return renderWindow;
}

const RENDER_FN = `
async (source) => {
  const id = 'mermaid-' + Math.random().toString(36).slice(2);
  const { svg } = await window.mermaid.render(id, source);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    const width = img.naturalWidth || img.width || 800;
    const height = img.naturalHeight || img.height || 600;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
`;

/**
 * Render a Mermaid source string to a PNG buffer. Throws if mermaid fails to
 * parse or render the diagram (callers decide whether to keep the raw block).
 */
export async function renderMermaidToPng(source: string): Promise<Buffer> {
  const win = await getRenderWindow();
  const dataUrl: unknown = await win.webContents.executeJavaScript(`(${RENDER_FN})(${JSON.stringify(source)})`);
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    throw new Error("mermaid 渲染未返回有效的 PNG 数据。");
  }
  const base64 = dataUrl.split(",")[1];
  if (!base64) throw new Error("mermaid 渲染返回的 PNG 数据无法解码。");
  return Buffer.from(base64, "base64");
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
