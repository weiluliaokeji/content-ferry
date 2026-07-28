# ContentFerry（文渡）AI 编码 Agent 操作手册

本文件只规定 AI 编码 Agent 在本仓库中的工作方式、工程边界和完成标准。产品需求、交互细节和技术设计以 `spec/` 下的文档为准，不在这里重复维护。

## 指令与文档优先级

发生冲突时按以下顺序处理：

1. 用户在当前任务中的明确要求。
2. 本文件及目标子目录中更具体的 `AGENTS.md`。
3. `spec/01-product-requirements.md` 中已确认的产品需求与验收标准。
4. `spec/02-development-design.md` 及专题设计/实现文档。
5. 当前代码、测试和应用内帮助所体现的现状。

如果需求文档、设计文档和代码互相矛盾，不要静默选择其中一个。先查明当前实现和最新决策；能够安全统一时在同一次修改中统一，无法判断时向用户说明冲突。

## 开始修改前

- 阅读与本次任务直接相关的需求、设计、实现说明和测试，不要只根据界面文案猜测业务规则。
- 检查工作区已有修改，保留用户未提交的内容，不覆盖无关文件。
- 明确改动属于产品需求、技术设计、用户帮助、内部重构或缺陷修复中的哪一类。
- 优先修复根因；不要用延时、重复刷新、静默吞错或硬编码特例掩盖状态、生命周期和数据一致性问题。
- 涉及文件删除、数据库迁移、发布、凭据或外部平台写操作时，先确认目标范围、失败恢复和幂等行为。

## 文档地图

| 文档 | 维护内容 |
|---|---|
| `spec/01-product-requirements.md` | 产品目标、用户价值、功能需求、范围、状态语义、验收场景 |
| `spec/02-development-design.md` | 架构、进程边界、数据模型、文件设计、技能/模型、记忆、日志、测试策略 |
| `spec/03-wechat-api-validation-checklist.md` | 微信接口能力和部署前置验证 |
| `spec/04-windows-packaging-and-ai-setup.md` | Windows 安装、数据目录、升级和 AI 初始化设计 |
| `spec/05-product-interaction-redesign.md` | 页面信息架构、编辑器和关键交互 |
| `spec/06-wechat-publishing-implementation.md` | 微信发布当前实现、状态语义和未完成项 |
| `docs/BUILDING.md` | 开发者打包、分发、签名和故障排查 |
| `docs/USER-GUIDE.md` | 可独立发送、导出和发布的完整用户使用说明 |
| `README.md` | 项目入口、能力现状、快速启动、文档导航和参与开发方式 |
| `TODO.md` | 已确认但尚未开发的功能、优化方向、边界和完成条件 |
| `src/renderer/components/HelpCenter.tsx` | 应用内快速上手和常见问题；用户可见流程变化时必须同步更新 |

不要把完整产品规则复制回本文件。需要新增长期业务规则时，先写入对应 `spec`，这里只保留开发时必须始终遵守的少量不变量。

## 文档同步是完成定义的一部分

新增或修改功能时，在同一次变更中完成相应文档更新：

- 用户行为、业务规则、范围或验收标准变化：更新 `spec/01-product-requirements.md`。
- 架构、数据结构、状态机、接口、文件规则、技能执行或恢复策略变化：更新 `spec/02-development-design.md` 或对应专题文档。
- 微信发布实现和能力边界变化：同时检查 `spec/03-*` 与 `spec/06-*`。
- Windows 安装、数据目录、升级、模型初始化或打包变化：更新 `spec/04-*` 和/或 `docs/BUILDING.md`。
- 导航、页面职责、主要交互或错误反馈变化：更新 `spec/05-product-interaction-redesign.md`。
- 用户能看到、配置或操作的功能变化：同步更新 `docs/USER-GUIDE.md` 和应用内 `HelpCenter`；配置步骤和故障处理必须让普通用户能够理解。
- 项目能力、支持范围、启动/构建命令、目录结构、文档入口或参与开发方式变化：更新 `README.md`。
- 确认了暂不在当前任务实现的功能或优化项：写入 `TODO.md`，说明动机、范围、建议步骤和完成条件；已经完成或被需求取代时及时移除或更新，不能让它成为失真的愿望清单。
- 仅内部重构且不改变外部行为时，可以不改需求文档，但交付说明中要明确“无产品/帮助文档影响”。

禁止先实现长期行为、以后再补文档。若功能尚未完成，文档必须明确标为“规划中”“部分实现”或“即将开放”，不能写成已经可用。

## 技术栈与目录

| 层 | 技术 |
|---|---|
| 桌面运行时 | Electron 37、Node.js |
| 语言 | TypeScript 5.9（strict mode） |
| 渲染进程 | React 19、Vite 7（ESM） |
| 主进程 | TypeScript 编译为 CommonJS |
| 编辑器 | Milkdown / ProseMirror |
| 数据库 | better-sqlite3 / SQLite |
| 本地服务 | Fastify 5，仅监听本地回环地址 |
| 测试 | Vitest |
| 打包 | electron-builder、NSIS 和 portable |

主要目录：

```text
src/main/       Electron 主进程、文件/数据库/网络/进程与本地服务
src/renderer/   React 界面，只使用浏览器 API 和白名单 bridge
src/shared/     跨进程纯类型与无副作用工具
spec/           产品需求、开发设计和专题设计
docs/           开发者构建与分发文档
assets/skills/  可随安装包分发的内置技能；每个技能使用独立目录
research/       调研材料
scripts/        构建、打包和验证脚本
```

## 进程与安全边界

- `src/main/` 禁止引入 React、ReactDOM 或浏览器端依赖。
- `src/renderer/` 禁止直接引入 `fs`、`path`、`child_process` 或其他 Node API。
- 跨进程能力通过 preload 的最小白名单 bridge 暴露；禁止关闭 `contextIsolation`。
- `src/shared/` 不得执行文件、网络、数据库或进程 I/O。
- 数据库查询必须参数化，禁止拼接不可信 SQL。
- API Key、AppSecret、OAuth 凭证、Cookie 和 token 不得进入源码、测试、日志或 Git。
- 日志不得记录完整正文、授权头或敏感凭据；只保留排查所需的脱敏上下文。
- 例外：用户可在“技能与模型”中显式开启「AI 调用审计」，开启后每次模型调用的完整请求/响应会写入数据目录下的 `logs/ai-audit/`（独立于只记 HTTP 元数据的运行日志）。这属于用户主动同意的留痕，不受上述脱敏约束，但 API Key 与鉴权头不在 prompt/响应中，不会被写入。

## 必须保持的产品不变量

以下内容是编码时的护栏，详细行为仍以 `spec/` 为准：

- 一期是 Windows 单机版，普通用户不依赖 Docker、WSL 或开发环境。
- VitePress Markdown 文章库是正式内容源；数据库保存索引、运行状态、配置和记录，不能形成互相冲突的第二份正式正文。
- AI 是可协作的自媒体助理；用户掌握关键事实和最终发布决定。
- “去 AI 味”是创作质量要求，但不得编造经历、数据、引用或来源。
- 技能定义任务规则，模型连接定义执行提供商，两者不得混为一体。
- 有稳定官方接口时优先使用接口；浏览器自动化用于无稳定接口或必须网页操作的能力。
- 微信接口返回“提交成功”不等于最终发布成功，最终状态必须来自回执或有理由的人工校正。
- 用户内容和模型调用数据默认只在本地使用，不用于产品改进。

## 代码约定

- 普通 TypeScript 文件使用 kebab-case；现有 React 组件文件命名保持项目当前约定，不为统一风格进行无关重命名。
- 类型、接口和 React 组件使用 PascalCase；函数和变量使用 camelCase；常量使用 UPPER_SNAKE_CASE。
- 禁止新增 `any`；使用 `unknown`、schema 校验和 type guard 收窄外部输入。
- 优先 named export；遵循现有模块风格，不在无关改动中批量调整导出方式。
- 异步流程使用 `async/await`，支持超时、取消和可诊断错误。
- 用户可恢复的失败必须保留原数据和重试/人工接管入口。
- 不直接编辑 `dist/`、`release/` 等构建产物。

## 测试与验证

| 修改范围 | 最低验证 |
|---|---|
| `src/renderer/` | `npm run typecheck`，并人工验证受影响交互 |
| `src/main/`、`src/shared/`、数据库或本地 API | `npm run typecheck` + `npm test` |
| preload、IPC、Electron 生命周期或原生模块 | 上述检查 + `npm run dev` 完整启动验证 |
| 依赖、构建配置或打包脚本 | `npm run build`；发布相关改动再运行对应打包/安装验证 |
| 文件删除、迁移、发布状态或恢复逻辑 | 增加/更新针对性测试，并验证失败路径 |

常用命令：

```powershell
npm run typecheck
npm test
npm run dev
npm run build
npm run dist:portable
npm run verify:installer
```

不要声称未实际执行的测试已经通过。因环境限制无法完成 GUI、外部平台或安装包验证时，明确列出需要用户执行的步骤。

## 新增依赖

新增依赖前检查体积、直接与传递许可证、维护状态、是否包含原生模块以及现有依赖能否完成同一任务。项目未来可能公开源代码，许可证兼容性属于合并前置条件，不得等到发布前再清理。

- 优先选择 MIT、BSD-2-Clause、BSD-3-Clause、Apache-2.0、ISC 等与预期分发方式兼容的依赖。
- GPL、AGPL、LGPL、SSPL、BSL、Commons Clause、非商业或来源不明的代码/资源，不得自行引入；必须先说明使用方式、动态或静态链接关系、分发义务和可替代方案，并取得用户明确确认。不要把“能安装”理解为“可合法分发”。
- 同时检查 npm 包本身、复制的源码片段、模型/数据集、字体、图标、图片和浏览器脚本的许可证；保留必要的版权声明与 NOTICE。
- 新依赖的名称、版本、用途和许可证应在变更说明中可追溯。若需要新增 `LICENSE`、`NOTICE` 或第三方许可证清单，应在同一次变更完成。
- 原生模块必须验证 Electron ABI 重建和 `asarUnpack`。
- 新增依赖后至少运行 `npm run build`。
- 不为一个很小的功能引入体积大、权限广或维护不稳定的依赖。

## 内置技能

- 内置技能源码位于 `assets/skills/<skill-id>/`。主入口必须是 `SKILL.md`，补充材料放在该技能自己的 `references/`。
- `assets/skills/manifest.json` 只保存技能 ID、名称、分类、默认模型等注册信息；不要再把完整提示词写回 TypeScript 字符串。
- `legacy/` 仅用于识别并迁移从未被用户修改的旧默认版本，不能作为当前技能说明。
- 修改技能时检查其调用方、模型输入边界、输出解析、用户数据目录中的自定义副本兼容性以及安装包资源是否完整。
- 不得静默覆盖用户在“技能与模型”中修改过的技能文件。

## 禁止事项

- 使用 `git reset --hard`、覆盖式 checkout 等破坏性操作处理用户工作区。
- 在渲染进程绕过 preload 直接访问 Node API。
- 通过关闭安全隔离、忽略证书、记录密钥或绕过平台风控来“快速打通”功能。
- 把未完成能力展示成可用，或把任务提交状态展示成最终成功。
- 为修复一个界面问题无关地重写整页、格式化全仓库或改动用户文章。
