/**
 * Temporary verification harness (delete after use).
 *
 * Purpose: prove that `renderMermaidToPng` really works in a full Electron app
 * (with a real BrowserWindow), using the mermaid blocks from the actual article
 * that failed to publish. It also verifies the PNG is not blank by counting
 * non-white pixels — a blank PNG still has bytes, so size alone is not enough.
 */
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

// This sandbox has no usable GPU process. Software rasterization is not only
// required here, it is also the safer choice for offscreen capture in general
// (it does not depend on the user's GPU/driver being healthy).
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const ROOT = "D:/Workbench/ContentFerry";
const ARTICLE = "D:/Workbench/weiluliaokejiBlogs/docs/posts/Agent 的记忆是怎么工作的：12 个框架源码拆解/index.md";

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

/** Count non-white pixels so a blank (but non-empty) PNG cannot slip through. */
function analyzePng(pngBuffer) {
  const img = nativeImage.createFromBuffer(pngBuffer);
  const size = img.getSize();
  const bitmap = img.toBitmap(); // BGRA, 4 bytes per pixel
  let nonWhite = 0;
  const total = size.width * size.height;
  for (let i = 0; i < bitmap.length && i / 4 < total; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    if (r < 250 || g < 250 || b < 250) nonWhite++;
  }
  return { width: size.width, height: size.height, nonWhite, total };
}

async function main() {
  await app.whenReady();
  console.log("=== Electron app ready, Electron " + process.versions.electron + " ===");

  const { inspectMermaidRender, disposeMermaidRenderer } = require(
    path.join(ROOT, "dist/main/main/mermaid/mermaid-render.js")
  );

  const md = fs.readFileSync(ARTICLE, "utf-8");
  const blocks = extractMermaidBlocks(md);
  console.log("Extracted mermaid blocks from article: " + blocks.length);

  if (blocks.length === 0) {
    console.log("!! No mermaid blocks found — nothing to verify.");
    disposeMermaidRenderer();
    app.quit(1);
    return;
  }

  let ok = 0;
  let blank = 0;
  let failed = 0;
  const outDir = path.join(ROOT, ".mermaid-verify/out");
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < blocks.length; i++) {
    const src = blocks[i];
    const head = src.trim().split(/\r?\n/)[0].slice(0, 40);
    const label = "#" + (i + 1) + " (" + head + ")";
    try {
      const result = await inspectMermaidRender(src);
      if (result.error) {
        failed++;
        console.log("[FAIL]  " + label + "  " + result.error);
        continue;
      }
      if (!result.png) {
        blank++;
        console.log("[BLANK] " + label + "  no PNG bytes (size=0)  diag=" + JSON.stringify(result.diag));
        continue;
      }
      const stats = analyzePng(result.png);
      const pct = stats.total ? ((stats.nonWhite / stats.total) * 100).toFixed(2) : "0";
      const isBlank = stats.nonWhite === 0;
      if (isBlank) blank++; else ok++;
      console.log(
        (isBlank ? "[BLANK] " : "[OK]    ") +
          label +
          "  bytes=" + result.png.length +
          "  " + stats.width + "x" + stats.height +
          "  nonWhite=" + stats.nonWhite + "/" + stats.total + " (" + pct + "%)" +
          "  diag=" + JSON.stringify(result.diag)
      );
      const out = path.join(outDir, "mermaid-" + (i + 1) + ".png");
      fs.writeFileSync(out, result.png);
      if (i === 0 || isBlank) console.log("        saved -> " + out);
    } catch (error) {
      failed++;
      console.log("[FAIL]  " + label + "  " + (error && error.message ? error.message : String(error)));
      if (error && error.stack) console.log("        " + String(error.stack).split("\n").slice(0, 3).join("\n        "));
    }
  }

  console.log("\n=== SUMMARY: ok=" + ok + " blank=" + blank + " failed=" + failed + " of " + blocks.length + " ===");
  disposeMermaidRenderer();
  app.quit(failed === 0 && blank === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("HARNESS ERROR: " + (error && error.stack ? error.stack : String(error)));
  app.quit(1);
});
