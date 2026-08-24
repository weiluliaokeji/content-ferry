# 文渡（ContentFerry）

文渡是一款面向 Windows 的本地 AI 自媒体工作台。它以用户自己的 VitePress Markdown 文章库为正式内容源，把资料整理、AI 辅助创作、自然化改写、AIGC 特征检测、封面处理和微信公众号发布串成可恢复的工作流。

项目仍处于早期开发阶段，界面、数据结构和安装方式可能继续调整。目前没有发布开源许可证；在许可证文件正式加入仓库之前，公开可见不等于允许复制、修改或再分发。

## 已实现的主要能力

- 管理多个微信公众号、CSDN 或博客园账号，并保存账号定位、目标读者、写作风格、禁用话题和常用栏目。
- 扫描 VitePress 文章库，新建草稿时直接写入符合现有 Front Matter 和目录规则的 Markdown 文件，仍可使用 Obsidian 等外部编辑器。
- 从主题、想法和资料生成创作简报、提纲与正文；支持 OpenAI Codex、OpenAI API、OpenRouter、Nous Research、NVIDIA Build、GitHub Copilot 等模型连接，并可配置 Tavily 作为独立的联网检索服务。
- 使用所见即所得或 Markdown 原文编辑文章，支持图片、表格、手机预览、选区 AI 编辑、修改对比和文章顾问“阿文”。
- 通过独立技能管理公众号撰写、平台改写、去 AI 味、摘要、封面提示词、封面生成和浏览器检测规则。
- 自动调用腾讯朱雀或 ContentAny 做 AIGC 特征检测；遇到登录、验证码或网页变化时允许人工接管。
- 通过微信公众号官方接口创建草稿、普通发布或群发，并接收回调、保留发布记录和支持有理由的人工状态校正；可从发布中心打开目标草稿，辅助处理原创声明、赞赏和合集后由用户最终发布。
- 已支持从本地文章库生成、编辑和冻结独立的 CSDN 渠道稿；可选择 AI 改写或直接使用主稿，并拦截公众号链接、文末延伸阅读等软引流内容。CSDN 浏览器自动发布仍处于能力验证阶段，暂不会提交内容。
- 已支持博客园账号接入与纯 API 自动发布：生成并审核博客园渠道稿后，通过官方 MetaWeblog（XML-RPC，用户名 + API Key）两段式发布——先创建草稿展示链接，用户确认后再公开；本地图片自动上传博客园图床、封面置为正文首图并注入 `[Markdown]` 分类，支持人工校正与幂等防重复。
- 按日保存运行日志，便于排查模型、微信接口、回调和浏览器自动化问题。

完整操作步骤见 [用户使用说明](docs/USER-GUIDE.md)。产品范围和实现状态以 [需求与设计文档](spec/) 为准。

## 技术架构

| 层 | 主要技术 |
|---|---|
| 桌面应用 | Electron 37 |
| 界面 | React 19、Vite 7、Milkdown / ProseMirror |
| 本地服务 | Fastify 5，仅监听 `127.0.0.1:4317` |
| 数据 | SQLite；文章正文以 VitePress Markdown 文件为准 |
| AI | 文渡模型适配层与可编辑技能 |
| 发布 | 微信公众号官方 API、回调与必要的浏览器自动化；博客园 MetaWeblog XML-RPC（API Key）直发 |
| 打包 | electron-builder、NSIS、Portable EXE |

渲染进程不直接访问文件系统、数据库或系统凭据；这些能力由 Electron 主进程和最小化 preload bridge 提供。

## 开发环境

建议使用当前 Node.js LTS、npm 和 Windows 10/11。普通最终用户不需要安装 Node.js、Codex CLI、Docker、WSL 或 Hermes Agent。

```powershell
npm install
npm run dev
```

开发模式会启动 Electron 桌面窗口、本地 API 和固定在 `http://127.0.0.1:5175/` 的前端服务。若 5175 端口被占用，启动会直接报错，关闭旧开发进程后重试。

切换 Electron 或 Node 版本后，可重新构建 SQLite 原生模块：

```powershell
npm run rebuild:native
```

## 验证与构建

```powershell
npm run typecheck       # 主进程和渲染进程类型检查
npm test                # 自动化测试
npm run build           # 完整生产构建
npm run pack            # 生成未压缩应用目录
npm run dist:portable   # 生成 Portable EXE
npm run dist:win        # 生成 NSIS 安装包和 Portable EXE
npm run verify:installer
```

详细的安装包、签名、代理和故障排查说明见 [Windows 构建与分发](docs/BUILDING.md)。

## 平台支持

当前以 **Windows 10/11 为首要支持平台**：提供 NSIS 安装包与 Portable EXE，并由 `docs/BUILDING.md` 覆盖完整构建、签名与分发流程。

`package.json` 的 `build.mac` / `build.linux` 配置仅用于交叉编译验证（`npm run pack` 生成未压缩应用目录），**不提供官方 macOS / Linux 安装包**；在其他平台上运行属于自行验证范围。

## 仓库结构

```text
assets/skills/   内置技能，每个技能拥有独立 SKILL.md 和 references/
docs/            用户与开发者使用文档
scripts/         构建、安装包和验证脚本
spec/            产品需求、开发设计与专题实现文档
src/main/        Electron 主进程、本地服务、数据库和平台集成
src/renderer/    React 界面
src/shared/      跨进程纯类型与无副作用工具
```

## 数据与敏感信息

- 首次启动允许选择数据目录；数据库、账号配置、发布记录、会话、记忆摘要和日志保存在该目录。
- 文章正文和图片保存在用户选择的 VitePress 文章库。
- AppSecret、API Key、OAuth 凭证、Cookie 和 token 不得写入源码、测试、日志、文档或 Git。
- 凭据通过 Windows 安全存储保护，读取接口只返回“是否已配置”等非敏感状态。
- 用户内容和模型调用数据默认只在本地使用，不用于产品改进。

提交或推送前仍应检查暂存内容中是否出现密钥、真实回调 Token、个人目录、日志正文或账号数据。

## 开发注意事项

开发前请阅读 [AI 编码 Agent 操作手册](AGENTS.md)、相关需求与设计文档。功能行为变化必须同步更新相应需求、设计、README 和用户帮助，不能只修改代码。已确认但尚未实现的方向记录在 [TODO](TODO.md)。

新增依赖前必须检查直接和传递许可证。GPL、AGPL、LGPL、SSPL、BSL、非商业条款或许可证不明的依赖与素材需要单独评估并取得明确确认，不能默认加入可分发安装包。

## 文档入口

- [用户使用说明](docs/USER-GUIDE.md)
- [开发者构建与分发](docs/BUILDING.md)
- [待开发与优化事项](TODO.md)
- [产品需求](spec/01-product-requirements.md)
- [开发设计](spec/02-development-design.md)
- [交互设计](spec/05-product-interaction-redesign.md)
- [微信公众号发布实现](spec/06-wechat-publishing-implementation.md)
*（内容由AI生成，仅供参考）*
