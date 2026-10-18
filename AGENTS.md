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
| preload、IPC、Electron 生命周期、窗口创建或打包脚本 | 上述检查 + **生产构建启动验证**（见下），`npm run dev` 不足以覆盖 |
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
npm run verify:boot
```

不要声称未实际执行的测试已经通过。因环境限制无法完成 GUI、外部平台或安装包验证时，明确列出需要用户执行的步骤。

### 独立验收

- 完成影响用户交互、preload/IPC/启动、持久化、发布副作用或恢复路径的修改后，在最终汇报前委派 Codex 项目级 `verifier`（`.codex/agents/verifier.toml`）。交接时提供变更范围、相关 `spec`、原缺陷复现步骤或新行为验收标准；等待其报告，失败项修复后重新验收。
- `verifier` 负责运行本节要求的检查、实际操作目标行为与两个最近的相邻流程，并只报告结果。无法使用 subagent 时，主 Agent 按相同范围自行验收并说明；缺少 GUI 或安全测试环境时，明确标记未验证，不能将自动化检查通过等同于界面验收。
- 对可通过本地 HTTP API 完成的界面流程，优先让项目级 `verifier` 使用沙箱内浏览器和隔离测试数据验收，按 [本地界面验收方法](docs/agents/gui-acceptance.md) 启动页面与本地服务、检查连通性，再实际操作目标流程和两个相邻流程。Electron 窗口启动失败时，先尝试文档中的浏览器与独立本地服务方案；只有实际探测失败后才将对应流程标为“未验证”。
- 交接浏览器验收时，提供页面与 API 地址、隔离数据位置、测试夹具及替代的外部接口、启动日志和验收标准。浏览器验收只覆盖实际操作的页面与真实本地业务链路；preload、IPC、Electron 生命周期、生产构建启动和真实平台行为仍须分别验收。仓库说明不能改变 Codex 的沙箱与审批权限。

### 缺陷修复的测试先行

- 对能稳定复现、且在现有测试层以合理成本覆盖的逻辑缺陷，优先先写测试并确认它因预期行为失败，再改产品代码。实施修复时不得为了让测试变绿而删除、跳过或弱化原断言。
- 对视觉布局、浏览器/Electron 环境差异、原生模块或外部平台问题，如果自动化测试成本过高、脆弱，或无法覆盖真实故障，可用截图对照、手工复现与修复后复验、日志/回执等证据完成验证；说明未新增自动化回归测试的原因和验证步骤，不因此阻塞修复。
- 数据丢失、安全、数据库迁移、发布状态/副作用和恢复逻辑等高风险缺陷必须增加针对性自动化测试并验证失败路径。优先用独立测试提交建立不可变基线；一般缺陷不强制增加单独提交。
- 如果诊断表明测试假设或测试代码有误，可以修正测试，但要说明原因、确认修正后的测试仍能检测原缺陷，再继续修复；不得静默改测试来消除失败。
- 对采用独立测试提交基线的修复，基线提交必须新增或修改至少一个测试文件，且不能改其他文件。运行 `npm run fix:begin -- <复现测试提交>` 开启 Codex 本地保护；结束前运行 `npm run fix:verify`，通过后再运行 `npm run fix:end`。保护期内 hook 会检查 `apply_patch`、shell 命令，以及工具名表明会写文件的 MCP/本地调用；工具执行后的差异审计和 `fix:verify` 会发现测试文件被修改、删除或新增，`fix:end` 在检查通过前不会清除保护标记。shell 静态分析无法识别所有间接副作用，因此该门禁是降低误改概率的加强措施，不是安全沙箱；不要用它替代最终差异 review。此流程可选，不要求每种缺陷都建立单独测试提交。
- Codex 首次加载仓库 hook 时，须在 Codex 的 hook review 中检查并信任该项目 hook；未信任时 hook 不会运行。采用本地保护时要确认当前项目已信任 `.codex/` 配置。
- 无论采用自动化还是人工/视觉验证，都要运行本手册要求的改动范围检查，报告实际执行的命令与结果，不声称未执行的验证已通过。

### SQLite schema 变更

每次修改 SQLite 表、列、索引、约束或持久化数据语义时，都要把新建库与旧库升级作为同一项工作完成：

- 为每个已发布的 schema 变化增加有序、不可改写的迁移；新建数据库也从初始 schema 按同一迁移链创建。数据库记录已应用的迁移版本，启动时只按顺序执行未应用项。已发布迁移不得重排、删除或修改；需要修正时追加新迁移。
- 对可安全补充的简单列，可用结构协调逻辑兜底；重命名、数据转换、约束/主键变化和表重建必须写明确迁移。`CREATE TABLE IF NOT EXISTS` 或检查缺列不能代替完整迁移。
- 在迁移事务中一并写入迁移完成记录；迁移失败时保留原 schema 版本并停止业务启动，给出可诊断错误。应用必须识别比自身支持版本更新的数据库并拒绝写入，提示恢复或升级程序。
- 会改写用户数据库的应用升级必须先生成可恢复的一致性备份；使用 SQLite 支持 WAL 的备份方式。验证迁移后的关键 schema、数据不变量和 `foreign_key_check`，确认成功后才开放业务服务。明确升级回退使用旧库备份恢复，不能假定旧程序可直接打开新版数据库。
- 测试从空库创建当前 schema，并从受支持的历史 schema fixture 逐版升级到当前版本；验证旧记录保留、默认值/转换正确、索引和约束符合预期、迁移可重复启动，以及中途失败后原库可恢复。每增加 schema 迁移，都必须增加对应旧结构和数据的针对性测试；只测试最新版空库不算完成。
- schema、迁移 runner、备份/恢复或升级行为变化时，同步更新 `spec/02-development-design.md`；若影响 Windows portable/安装版升级或回退，再更新 `spec/04-windows-packaging-and-ai-setup.md` 与相关构建说明。

### 生产构建启动验证（dev 验证不到打包版）

`npm run dev` 由 `scripts/dev-desktop.mjs` 注入 `CONTENTFERRY_DEV_SERVER_URL`，主窗口走 `loadURL` 分支，**永远不会执行打包版的 `loadFile` 路径**。因此任何触碰主窗口创建、`preload` 接线、`loadFile` 入口或 `app.getAppPath()` 的改动，不能用「`npm run dev` 启动过」来判定为已验证。这类改动的最低验证：

- `npm run build` 成功（编译产物落盘）；
- `npm run dist:portable` 产出可运行包；
- `npm run verify:installer` 通过（含 `startup entry files present`、`preload bundled`、`startup path safety` 三项门禁，其中 `startup path safety` 静态禁止启动资产再用 `__dirname` 往上跳目录）；
- `npm run verify:boot` 通过（无头启动打包后的 exe，确认主窗口能加载、不会白屏即退）。本地若已有其他文渡实例占用端口 4317 会误报，应在无其他实例时运行，或依赖 CI。

普通 PR 和 `master` 推送由 `.github/workflows/ci.yml` 执行 Windows 检查（hook 测试、含类型检查的生产编译、全量自动化测试）。此检查不覆盖安装包或窗口启动；涉及上述生产启动路径的修改，仍须在本地完成生产构建启动验证。Tag 发布的 `dist:win` 流水线另有 `verify:installer` 与 `verify:boot` 发布前门禁。

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

## Agent skills

### Issue tracker

本仓库的问题和设计事项统一记录在 GitHub Issues 中，使用 `gh` CLI 操作。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和 `wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用 single-context 结构：根目录使用 `CONTEXT.md`，架构决策记录放在 `docs/adr/`。详见 `docs/agents/domain.md`。
