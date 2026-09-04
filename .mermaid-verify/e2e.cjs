/**
 * End-to-end verification of the two bugs the user reported:
 *   1. ```mermaid blocks must become images (not raw source text).
 *   2. ```python (and other) code blocks must get WeChat code styling.
 *
 * Unlike main.cjs (which exercises the renderer in isolation), this drives the
 * *production* pipeline: renderMermaidBlocks() -> markdownToWechatHtml(), i.e.
 * exactly what prepareWechatArticle() does before it uploads the draft.
 *
 * Run: ./node_modules/electron/dist/electron.exe .mermaid-verify/e2e.cjs
 */
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-dev-shm-usage");

const ROOT = "D:/Workbench/ContentFerry";
const ARTICLE = "D:/Workbench/weiluliaokejiBlogs/docs/posts/Agent 的记忆是怎么工作的：12 个框架源码拆解/index.md";

function countOf(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

async function main() {
  await app.whenReady();

  const { renderMermaidBlocks } = require(path.join(ROOT, "dist/main/main/publishing/mermaid-markdown.js"));
  const { markdownToWechatHtml } = require(path.join(ROOT, "dist/main/main/wechat/wechat-publishing-service.js"));
  const { disposeMermaidRenderer } = require(path.join(ROOT, "dist/main/main/mermaid/mermaid-render.js"));

  const md = fs.readFileSync(ARTICLE, "utf-8");
  const mermaidFences = countOf(md, "```mermaid");
  const pythonFences = countOf(md, "```python");
  console.log("article: " + md.length + " chars, ```mermaid x" + mermaidFences + ", ```python x" + pythonFences);

  // --- Stage 1: mermaid fences -> images (inline data URI, same shape as CSDN) ---
  const errors = [];
  const uploaded = [];
  const md2 = await renderMermaidBlocks(md, {
    uploadImage: async (png, name) => {
      uploaded.push({ name, bytes: png.length });
      return "data:image/png;base64," + png.toString("base64");
    },
    onError: (source, error) => {
      errors.push({ head: source.split(/\r?\n/)[0], error: String(error && error.message ? error.message : error) });
    }
  });

  const remainingFences = countOf(md2, "```mermaid");
  const images = (md2.match(/!\[mermaid 图 \d+\]\(data:image\/png;base64,/g) || []).length;
  console.log("\n[stage 1] renderMermaidBlocks");
  console.log("  rendered PNGs uploaded = " + uploaded.length);
  console.log("  inline <img> refs      = " + images);
  console.log("  ```mermaid left        = " + remainingFences);
  console.log("  render errors          = " + errors.length);
  uploaded.forEach((u) => console.log("    " + u.name + "  " + u.bytes + " bytes"));
  errors.forEach((e) => console.log("    ERROR " + e.head + " :: " + e.error));

  // --- Stage 2: markdown -> WeChat HTML ---
  const html = markdownToWechatHtml(md2);
  console.log("\n[stage 2] markdownToWechatHtml");
  console.log("  html length        = " + html.length);
  console.log("  <img> tags         = " + countOf(html, "<img"));
  console.log("  code-snippet__js   = " + countOf(html, "code-snippet__js"));
  console.log("  code-snippet (any) = " + (html.match(/code-snippet__[a-z0-9]+/g) || []).length);
  console.log('  data-lang="python" = ' + countOf(html, 'data-lang="python"'));
  console.log("  <pre> tags         = " + countOf(html, "<pre"));
  console.log("  raw ``` left       = " + countOf(html, "```"));

  // --- Verdict ---
  const problems = [];
  if (uploaded.length !== mermaidFences) problems.push("expected " + mermaidFences + " PNGs, got " + uploaded.length);
  if (remainingFences !== 0) problems.push(remainingFences + " ```mermaid blocks survived (kept as text)");
  if (countOf(html, "<img") < mermaidFences) problems.push("fewer <img> in HTML than mermaid blocks");
  if (countOf(html, "code-snippet__js") < pythonFences) problems.push("python fences without code-snippet styling");
  if (errors.length) problems.push(errors.length + " render error(s)");

  console.log("\n=== " + (problems.length ? "FAIL" : "PASS") + " ===");
  problems.forEach((p) => console.log("  - " + p));

  fs.mkdirSync(path.join(ROOT, ".mermaid-verify/out"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, ".mermaid-verify/out/e2e-wechat.html"), html);

  disposeMermaidRenderer();
  app.quit(problems.length ? 1 : 0);
}

main().catch((error) => {
  console.error("HARNESS ERROR: " + (error && error.stack ? error.stack : String(error)));
  app.quit(1);
});
