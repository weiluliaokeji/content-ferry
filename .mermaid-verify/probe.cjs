/**
 * Temporary probe (delete after use).
 *
 * Decision table in a single Electron run:
 *   A1-A4: can `capturePage` produce a non-blank PNG at all in this sandbox?
 *          (off-screen shown window / hidden+paintWhenInitiallyHidden /
 *           offscreen:true+paint / on-screen visible window)
 *   B1-B2: can we rasterize mermaid inside the page via <img>+<canvas>?
 *          B1 = mermaid defaults (emits <foreignObject> for labels)
 *          B2 = htmlLabels:false (pure SVG <text>, no foreignObject)
 *
 * B matters because it does not depend on window visibility/compositing at
 * all — if it works, we never need capturePage.
 */
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

// This sandbox has no usable GPU process — Chromium aborts with
// "GPU process isn't usable. Goodbye." unless we force software rendering.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const ROOT = "D:/Workbench/ContentFerry";
const OUT = path.join(ROOT, ".mermaid-verify/out");
const MERMAID_JS = path.join(ROOT, "node_modules/mermaid/dist/mermaid.min.js");

const ARTICLE =
  "D:/Workbench/weiluliaokejiBlogs/docs/posts/Agent 的记忆是怎么工作的：12 个框架源码拆解/index.md";

function extractFirst(markdown, kind) {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let isMermaid = false;
  let buf = [];
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (!inFence && fence) {
      inFence = true;
      isMermaid = /^\s*```\s*mermaid\s*$/i.test(line);
      buf = [];
      continue;
    }
    if (inFence && fence) {
      inFence = false;
      if (isMermaid && buf.length && buf.join("\n").trim().startsWith(kind)) {
        return buf.join("\n");
      }
      buf = [];
      continue;
    }
    if (inFence && isMermaid) buf.push(line);
  }
  return "";
}

function nonWhite(pngBuffer) {
  const img = nativeImage.createFromBuffer(pngBuffer);
  const size = img.getSize();
  const bmp = img.toBitmap();
  let n = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    if (bmp[i] < 250 || bmp[i + 1] < 250 || bmp[i + 2] < 250) n++;
  }
  return { w: size.width, h: size.height, n };
}

const RED =
  '<!doctype html><html><body style="margin:0;background:#ffffff">' +
  '<div style="width:600px;height:400px;background:#ff0000"></div></body></html>';

async function captureVariant(label, opts) {
  const { BrowserWindow } = require("electron");
  const win = new BrowserWindow(
    Object.assign(
      {
        width: 800,
        height: 600,
        skipTaskbar: true,
        focusable: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
      },
      opts
    )
  );
  win.on("page-title-updated", (e) => e.preventDefault());
  let result;
  try {
    // data: URLs fail with ERR_FAILED in this sandbox (and take the process
    // down with them), so always load from a temp file instead.
    const file = path.join(os.tmpdir(), "mermaid-probe-" + label + ".html");
    fs.writeFileSync(file, RED, "utf-8");
    await win.loadFile(file);
    await new Promise((r) => setTimeout(r, 600));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 800, height: 600 });
    const png = img.toPNG();
    fs.writeFileSync(path.join(OUT, "probe-" + label + ".png"), png);
    const s = nonWhite(png);
    result = label + ": img=" + s.w + "x" + s.h + " bytes=" + png.length + " nonWhite=" + s.n +
      (s.n > 1000 ? "  [OK]" : "  [BLANK]");
  } catch (e) {
    result = label + ": EXCEPTION " + (e && e.message ? e.message : String(e));
  }
  win.destroy();
  return result;
}

// ---- canvas rasterization, run inside a hidden window -------------------
const RASTER_FN = `
(async (src, optsJson) => {
  const out = { stage: 'start' };
  try {
    out.stage = 'init';
    window.mermaid.initialize(JSON.parse(optsJson));
    out.stage = 'render';
    const { svg } = await window.mermaid.render('probe-render', src);
    out.svgLen = svg.length;
    out.hasForeignObject = /<foreignObject/i.test(svg);
    out.stage = 'measure';
    const host = document.getElementById('host');
    host.innerHTML = svg;
    const el = host.firstElementChild;
    let w = parseFloat(el.getAttribute('width')) || 0;
    let h = parseFloat(el.getAttribute('height')) || 0;
    if (!w || !h) {
      const vb = (el.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number);
      if (vb.length === 4) { w = w || vb[2]; h = h || vb[3]; }
    }
    w = Math.ceil(w); h = Math.ceil(h);
    out.w = w; out.h = h;
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const clean = new XMLSerializer().serializeToString(el);
    // Add a white background rect so the PNG is not transparent-on-white-later.
    const withBg = clean.replace(
      /(<svg[^>]*>)/,
      '$1<rect width="100%" height="100%" fill="#ffffff"/>'
    );
    out.stage = 'load';
    const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(withBg)));
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG <img> failed to load'));
      img.src = url;
    });
    out.stage = 'draw';
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    out.stage = 'export';
    out.dataUrl = canvas.toDataURL('image/png');
    out.stage = 'done';
  } catch (error) {
    out.error = error && error.message ? error.message : String(error);
    out.stage = out.stage + ':FAILED';
  }
  return out;
})
`;

async function rasterVariant(label, src, mermaidOpts) {
  const { BrowserWindow } = require("electron");
  const mermaidSource = fs.readFileSync(MERMAID_JS, "utf-8");
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<script>" + mermaidSource + "</script></head>" +
    '<body style="margin:0;background:#fff"><div id="host"></div></body></html>';
  const file = path.join(os.tmpdir(), "mermaid-probe-" + label + ".html");
  fs.writeFileSync(file, html, "utf-8");

  // canvas path must work even with a fully hidden window — that is the point.
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  await win.loadFile(file);
  const r = await win.webContents.executeJavaScript(
    "(" + RASTER_FN + ")(" + JSON.stringify(src) + ", " + JSON.stringify(JSON.stringify(mermaidOpts)) + ")"
  );
  win.destroy();

  if (!r.dataUrl) {
    return label + ": [FAIL] stage=" + r.stage + " error=" + r.error +
      " (svgLen=" + r.svgLen + " foreignObject=" + r.hasForeignObject + " " + r.w + "x" + r.h + ")";
  }
  const b64 = r.dataUrl.slice("data:image/png;base64,".length);
  const png = Buffer.from(b64, "base64");
  fs.writeFileSync(path.join(OUT, "probe-" + label + ".png"), png);
  const s = nonWhite(png);
  return label + ": [OK] " + s.w + "x" + s.h + " bytes=" + png.length + " nonWhite=" + s.n +
    " foreignObject=" + r.hasForeignObject + (s.n > 500 ? "  RENDERED" : "  BLANK!");
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };

  log("=== probe Electron " + process.versions.electron + " ===");

  // B first: it is the path we actually want, and it must survive even if
  // capturePage is broken in this environment.
  log("\n--- B) <img>+<canvas> rasterization of a real mermaid block ---");
  const md = fs.readFileSync(ARTICLE, "utf-8");
  const seq = extractFirst(md, "sequenceDiagram");
  const flow = extractFirst(md, "flowchart");
  log("sequence block chars=" + seq.length + "  flowchart block chars=" + flow.length);

  const base = { startOnLoad: false, securityLevel: "loose", theme: "default" };
  if (flow) {
    log(await rasterVariant("B1-flow-default", flow, Object.assign({}, base)));
    log(await rasterVariant("B2-flow-noHtmlLabels", flow, Object.assign({}, base, { flowchart: { htmlLabels: false, useMaxWidth: false } })));
  }
  if (seq) {
    log(await rasterVariant("B3-seq-default", seq, Object.assign({}, base)));
  }

  log("\n--- A) capturePage on a plain red rect ---");
  log(await captureVariant("A1-offscreen-shown", { show: true, x: -4096, y: -4096 }));
  log(await captureVariant("A3-onscreen-visible", { show: true, x: 40, y: 40 }));

  fs.writeFileSync(path.join(ROOT, ".mermaid-verify/probe.txt"), lines.join("\n") + "\n");
  app.quit(0);
}

main().catch((e) => {
  console.error("HARNESS ERROR: " + (e && e.stack ? e.stack : String(e)));
  app.quit(1);
});
