/**
 * Temporary probe #2 (delete after use).
 *
 * probe.cjs proved the <img>+<canvas> path WORKS (even with <foreignObject>)
 * while capturePage is dead in this environment (0x0 blank). The remaining
 * open question is SIZING: mermaid emits width="100%" + style="max-width:..."
 * on the SVG, so naive parsing yields a 100px-wide, squashed image.
 *
 * This harness reuses a single hidden window (destroying/recreating windows
 * crashed V8 in probe.cjs) and reports, for every mermaid block in the real
 * article, which sizing strategy produces a correctly-proportioned PNG.
 */
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

function extractMermaidBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
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
      if (isMermaid && buf.length) blocks.push(buf.join("\n"));
      isMermaid = false;
      buf = [];
      continue;
    }
    if (inFence && isMermaid) buf.push(line);
  }
  return blocks;
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

/**
 * Runs inside the renderer. Everything here is PLAIN JAVASCRIPT.
 */
const RASTER_FN = `
(async (src, optsJson) => {
  const out = { stage: 'start' };
  try {
    out.stage = 'init';
    window.mermaid.initialize(JSON.parse(optsJson));
    out.stage = 'render';
    const id = 'm' + Math.random().toString(36).slice(2);
    const { svg } = await window.mermaid.render(id, src);
    out.svgLen = svg.length;
    out.hasForeignObject = /<foreignObject/i.test(svg);

    out.stage = 'measure';
    const host = document.getElementById('host');
    host.innerHTML = svg;
    const el = host.firstElementChild;

    // Report the raw attributes so we can see what mermaid actually emitted.
    out.attrWidth = el.getAttribute('width');
    out.attrHeight = el.getAttribute('height');
    out.attrViewBox = el.getAttribute('viewBox');
    out.inlineStyle = el.getAttribute('style');

    // Sizing strategy: viewBox is the ONLY reliable natural size. mermaid sets
    // width="100%" plus style="max-width:Npx", so both the width attribute and
    // getBoundingClientRect() (inside a shrink-wrapped container) lie.
    let w = 0, h = 0;
    const vb = (out.attrViewBox || '').trim().split(/[\\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
    if (!w || !h) {
      const px = (raw) => {
        if (!raw) return 0;
        const m = /^(-?[0-9.]+)px$/i.exec(String(raw).trim());
        return m ? parseFloat(m[1]) : 0;
      };
      w = px(out.attrWidth); h = px(out.attrHeight);
    }
    if (!w || !h) {
      const r = el.getBoundingClientRect();
      w = r.width; h = r.height;
    }
    w = Math.ceil(w); h = Math.ceil(h);
    out.w = w; out.h = h;
    if (!w || !h) { out.stage = 'measure:EMPTY'; return out; }

    // Normalize the SVG so it rasterizes at exactly w x h.
    el.setAttribute('width', String(w));
    el.setAttribute('height', String(h));
    el.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    el.removeAttribute('style');
    el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    el.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    out.stage = 'serialize';
    let markup = new XMLSerializer().serializeToString(el);
    // White backdrop: PNG must not be transparent (WeChat renders it on white).
    markup = markup.replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="#ffffff"/>');

    out.stage = 'load';
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('SVG <img> failed to load'));
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(markup)));
    });

    out.stage = 'draw';
    const scale = 2; // retina-quality output
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

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

async function main() {
  await app.whenReady();
  fs.mkdirSync(OUT, { recursive: true });
  const lines = [];
  const log = (s) => { lines.push(s); console.log(s); };
  log("=== probe2 Electron " + process.versions.electron + " ===");

  const { BrowserWindow } = require("electron");
  const mermaidSource = fs.readFileSync(MERMAID_JS, "utf-8");
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<script>" + mermaidSource + "</script></head>" +
    '<body style="margin:0;background:#fff"><div id="host" style="display:inline-block"></div></body></html>';
  const file = path.join(os.tmpdir(), "mermaid-probe2.html");
  fs.writeFileSync(file, html, "utf-8");

  // One hidden window, reused. show:false is enough — the canvas path never
  // touches the compositor.
  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1200,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, offscreen: false }
  });
  win.on("page-title-updated", (e) => e.preventDefault());
  await win.loadFile(file);

  const md = fs.readFileSync(ARTICLE, "utf-8");
  const blocks = extractMermaidBlocks(md);
  log("mermaid blocks: " + blocks.length);

  const noHtml = {
    startOnLoad: false,
    securityLevel: "loose",
    theme: "default",
    flowchart: { useMaxWidth: false, htmlLabels: false },
    sequence: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    gantt: { useMaxWidth: false }
  };
  const defaults = { startOnLoad: false, securityLevel: "loose", theme: "default" };

  for (const [label, opts] of [["htmlLabels-false", noHtml], ["defaults", defaults]]) {
    log("\n--- options: " + label + " ---");
    let ok = 0, bad = 0, fail = 0;
    for (let i = 0; i < blocks.length; i++) {
      const head = blocks[i].trim().split(/\r?\n/)[0].slice(0, 24);
      try {
        const r = await win.webContents.executeJavaScript(
          "(" + RASTER_FN + ")(" + JSON.stringify(blocks[i]) + ", " +
          JSON.stringify(JSON.stringify(opts)) + ")"
        );
        if (!r.dataUrl) {
          fail++;
          log("[FAIL]  #" + (i + 1) + " " + head + " stage=" + r.stage + " err=" + r.error +
            " attrs=" + r.attrWidth + "x" + r.attrHeight + " vb=" + r.attrViewBox);
          continue;
        }
        const png = Buffer.from(r.dataUrl.slice("data:image/png;base64,".length), "base64");
        const s = nonWhite(png);
        const pct = s.w * s.h ? ((s.n / (s.w * s.h)) * 100).toFixed(2) : "0";
        if (s.n < 500) { bad++; } else { ok++; }
        fs.writeFileSync(path.join(OUT, "p2-" + label + "-" + (i + 1) + ".png"), png);
        log(
          (s.n < 500 ? "[BLANK] " : "[OK]    ") + "#" + (i + 1) + " " + head +
          "  natural=" + r.w + "x" + r.h + "  png=" + s.w + "x" + s.h +
          "  nonWhite=" + s.n + " (" + pct + "%)" +
          "  attr=" + r.attrWidth + "x" + r.attrHeight + " fo=" + r.hasForeignObject
        );
      } catch (e) {
        fail++;
        log("[THROW] #" + (i + 1) + " " + head + " " + (e && e.message ? e.message : String(e)));
      }
    }
    log("SUMMARY " + label + ": ok=" + ok + " blank=" + bad + " fail=" + fail + " / " + blocks.length);
  }

  fs.writeFileSync(path.join(ROOT, ".mermaid-verify/probe2.txt"), lines.join("\n") + "\n");
  app.quit(0);
}

main().catch((e) => {
  console.error("HARNESS ERROR: " + (e && e.stack ? e.stack : String(e)));
  app.quit(1);
});
