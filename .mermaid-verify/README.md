# mermaid 渲染验证脚手架

ContentFerry 的 mermaid → PNG 渲染链路在某些 Chromium/Windows 环境（GPU 进程崩溃、窗口离屏遮挡、software-only）会让 `webContents.capturePage` 返回空白帧。本目录是一个独立 Electron 应用，按真实文章源码驱动 **生产代码**（`dist/main/main/mermaid/mermaid-render.js`）渲染 9 个 mermaid 块，并统计每张 PNG 的非白像素比例，确认渲染确实落到非空图。

**重要原则**：任何对 `src/main/mermaid/mermaid-render.ts` 的修改，**必须**先在本脚手架里跑通 `main.cjs`，再让用户复测。

## 运行

```bash
# 1) 构建主进程（脚手架加载编译产物）
npm run build:main

# 2) 用本地 Electron 跑真实代码
./node_modules/electron/dist/electron.exe .mermaid-verify/main.cjs

# 3) 跑端到端管线（renderMermaidBlocks → markdownToWechatHtml）
./node_modules/electron/dist/electron.exe .mermaid-verify/e2e.cjs

# 4) 比较两种 mermaid 选项
./node_modules/electron/dist/electron.exe .mermaid-verify/probe2.cjs
```

产物写到 `out/`，日志写到 `probe2.txt` / `main-run.txt` / `probe.txt` / `e2e-run.txt`。

优先跑 `e2e.cjs`：它驱动的是**用户实际走的发布管线**（mermaid 转图 + 代码块转微信样式），一次覆盖两个回归点。

## 文件

- `main.cjs` —— 跑生产 `inspectMermaidRender`（已编译的 dist），全部 9 个 mermaid 块，输出非白像素统计。
- `e2e.cjs` —— **首选**：跑生产管线 `renderMermaidBlocks()` → `markdownToWechatHtml()`，断言「N 个 mermaid fence → N 张 PNG、0 个 fence 残留、python fence 全部拿到 `code-snippet__js` + `data-lang`」，并把最终 HTML 落到 `out/e2e-wechat.html`。
- `probe.cjs` —— 横向对比 `capturePage`（off-screen / 隐藏 / 可见）和 `<img>+<canvas>` 两条路径。诊断用。
- `probe2.cjs` —— 验证 `htmlLabels:false` 和默认配置在 9 个块上的尺寸与质量，决定生产实现选哪个。
- `sanity.cjs` —— 隔离测试：纯 HTML 红矩形 → `capturePage` 看空白边界。
- `package.json` —— `{"main": "main.cjs"}`。
- `out/` —— 渲染产物 PNG。

## 当前生产结论（2026-09-04）

- `capturePage` 任何变体在该环境（无 GPU / 软件渲染）返回 0x0 空白。
- `<img>+<canvas>` 路径**始终**工作：9/9 OK，PNG 35–160KB，nonWhite 15–61%。
- 选择 `htmlLabels:false`（避免 `<foreignObject>` 触发 canvas tainted）。
- 尺寸从 `viewBox` 取（mermaid 给的是 `width="100%"`，attribute 不可信）。