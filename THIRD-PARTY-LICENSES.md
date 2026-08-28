# 第三方许可证（Third-Party Licenses）

文渡（ContentFerry）以 MIT 许可证发布。本项目在分发时随附若干第三方依赖，其许可证如下。本文件用于满足各依赖的许可证署名与源码可得性要求，并不取代上游许可证原文。

## 需注意的许可证

### MPL-2.0（文件级 copyleft）

- **`@resvg/resvg-js`**（版本 `2.6.2`）：用于将 SVG 渲染为 PNG（封面图处理）。
  - 许可证：Mozilla Public License 2.0
  - 源码可得性：以 npm 包形式发布，源码见 `https://www.npmjs.com/package/@resvg/resvg-js` 及其仓库。
  - 说明：MPL-2.0 为文件级 copyleft。本项目**未修改** `@resvg/resvg-js` 的源码，仅作为普通依赖调用，因此可按 MIT 项目整体分发；若未来修改其源码，被修改文件须以 MPL-2.0 提供。

## 其余主要依赖（宽松许可证）

以下依赖均为 OSI 批准的宽松许可证，可在遵守其署名条款的前提下随本项目分发：

- **MIT**：`@fastify/cors`、`@github/copilot-sdk`、`better-sqlite3`、`fastify`、`react`、`react-dom`、`undici`、`zod`、`@milkdown/crepe`、`@milkdown/kit`、`@milkdown/react`、`@electron/rebuild`、`@types/*`、`@vitejs/plugin-react`、`concurrently`、`cross-env`、`electron`、`electron-builder`、`typescript`、`vite`、`vitest`、`wait-on`
- **Apache-2.0**：`@openai/codex-sdk`

完整依赖及其精确版本以 `package.json` 与 `package-lock.json` 为准。新增依赖前须按 [AGENTS.md](AGENTS.md) 检查直接与传递许可证。

最后更新：2026-08-28
