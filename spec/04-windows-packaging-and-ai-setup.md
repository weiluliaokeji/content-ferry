# Windows 安装包与 AI 初始化设计

> 状态：Windows x64 的 NSIS 安装包与 Portable EXE 已实现；代码签名、干净机器验收与自动更新仍待完善。

## 1. 普通用户如何安装

一期提供一个 Windows x64 安装程序，例如 `ContentFerry-Setup-0.1.0.exe`。普通用户双击安装即可，不需要自行安装 Node.js、npm、Python、Visual Studio、Docker、WSL、OpenAI SDK 或 Hermes Agent。

安装包内包含：

- Electron 运行时与 ContentFerry 已编译的桌面界面、本地服务；
- 运行所需的 JavaScript 依赖；
- `better-sqlite3` 对应 Electron/Windows x64 的原生模块；
- OpenAI 官方 Codex SDK 及 SDK 自带的 Windows x64 内部运行组件；
- 数据库迁移、默认配置和应用资源。

这里的“内部运行组件”不是要求用户另行安装 Codex 软件，也不会出现一个需要用户维护的 Codex 应用。它和 SQLite 原生模块一样由安装包随 ContentFerry 一起部署、由 ContentFerry 在后台调用。`npm install`、原生模块重建和安装包构建只发生在开发/发布机器或 CI 中，不发生在最终用户电脑上。编辑器等前端依赖会被编译进应用资源，不以单独 SDK 的形式要求用户配置。

Hermes Agent 的 `OpenAI Codex` provider 采用了另一条路径：Hermes 自行实现 ChatGPT OAuth、保存和刷新令牌，并直接请求 ChatGPT Codex 后端，因此不需要 Codex CLI 或 SDK 运行组件。该实现更轻，但它依赖的 ChatGPT 后端地址不是面向第三方应用承诺稳定的公开 API。ContentFerry 不应在没有兼容层、回退方案和持续维护承诺的情况下把这条路径作为唯一生产依赖。

一期保留两层选择：

1. 默认稳定路径：使用 OpenAI 官方 Codex SDK；内部运行组件随 ContentFerry 安装包部署，用户无感知、无需另行安装。
2. 实验性轻量路径：参考 Hermes 自行实现 OAuth provider；必须隔离在适配器后，并允许失效时切回官方 SDK。对外发布前需再次确认 OpenAI 的授权与接口政策。

## 2. 数据与升级边界

- 当前开发版默认把内部数据保存在 Electron `userData/data` 目录；在本机对应 `C:\Users\<用户名>\AppData\Roaming\contentferry\data`。其中包括 SQLite 数据库、ContentFerry 内部素材、AI 沙箱和诊断日志。用户单独配置的 VitePress 文章库仍保存在用户选择的原目录，不会复制进系统盘。除 `userData/data` 业务数据外，Electron 的 `userData` 根目录还保存启动定位配置 `app-settings.json`（记录数据目录位置、首次启动标记与 AI 初始化状态）与框架自动维护的运行时文件（`Preferences`、会话存储、缓存、`GPUCache` 等）；这些位于 `userData` 根、不随数据目录迁移，重装或换盘时由本地应用重新生成或重新写入。
- 当前开发版可通过 `CONTENTFERRY_DATA_DIR` 环境变量覆盖内部数据目录，但这不是面向普通用户的最终交互。
- 正式安装版首次启动时提供“使用推荐位置”和“选择其他位置”两个选项。选择其他位置后，数据库、内部素材、日志、缓存和备份都写入该目录；系统盘只保留很小的启动定位配置和 Windows 必需的应用配置。
- 设置页后续允许迁移数据目录。迁移必须在暂停写入后执行“复制到临时目录 → 校验数据库和文件数量 → 原子切换位置 → 保留旧目录供回退”，不得直接移动后立即删除原数据。
- Windows `safeStorage` 加密仍与当前 Windows 用户身份关联；数据目录可以放到其他磁盘，但不能把加密凭证文件直接复制给另一台电脑后期待自动解密。
- 程序文件安装在 Windows 应用目录；升级不得覆盖文章、数据库、检测结果或账号配置。
- AppSecret、token、Cookie 和 OpenAI 登录凭据不得打入安装包、不得复制到 Git 备份，也不得由开发者预置。
- 只提供稳定版，用户手动触发升级；升级前自动备份数据库和必要文件。
- 一键回退保留上一个可用程序版本，并在数据库迁移允许回退时恢复；不可逆迁移必须先完成兼容性预检。
- 首个安装包只支持 Windows x64。Windows ARM64 需要单独构建并验证 Codex 与 SQLite 原生模块。

## 3. 为什么当前电脑没有要求配置 AI

当前开发机此前已经通过 Codex/ChatGPT 登录，OpenAI 官方 Codex SDK 会复用本机已有的 Codex 授权状态，所以 ContentFerry 第一次生成提纲时可以直接调用模型。这只是开发阶段复用了现有登录，不代表 ContentFerry 内置了开发者账号或密钥。

任何安装包都不得携带当前开发机的授权文件。新电脑没有登录状态时，生成请求应被阻止并引导用户完成自己的登录。

## 4. 新电脑首次启动流程

首次启动增加“AI 服务”初始化卡片：

1. 检查安装包中的 Codex 运行文件是否完整；
2. 检查本机是否已经登录 OpenAI Codex；
3. 已登录时显示账号来源为“OpenAI Codex（ChatGPT 登录）”，并允许执行一次最小连接测试；
4. 未登录时显示“登录 OpenAI Codex”按钮，启动官方登录流程，由用户在浏览器中完成登录；
5. 登录完成后重新检查状态并运行最小连接测试；
6. 失败时区分未登录、无 Codex 权限、网络不可用、运行文件损坏和服务暂时不可用，给出对应操作；
7. 用户可以暂时跳过 AI 初始化，继续使用本地文章库和手工编辑能力。

一期不要求用户填写 OpenAI API Key，也不安装 Hermes Agent。后续如果增加平台统一计费的 SaaS 模式，由服务端模型网关处理计费与租户隔离，不能复用单机版用户的本地 Codex 登录。

## 5. 安装包构建方案

采用 Electron 的标准打包工具生成 NSIS 安装程序。发布流水线至少执行：

1. 锁定并安装依赖；
2. 类型检查、单元测试和生产构建；
3. 为目标 Electron 版本重建 `better-sqlite3`；
4. 打包应用并确保 Codex 可执行文件和原生模块位于 ASAR 外可执行位置；
5. 在一台未安装 Node.js、未安装 Codex CLI 的干净 Windows x64 虚拟机上验证安装；
6. 分别验证“从未登录”“已有 Codex 登录”“断网”“升级”“回退”；
7. 对应用与安装程序进行 Windows 代码签名，再发布稳定版。

### 5.1 GitHub Actions 发布

推送与 `package.json` 版本一致的 `v<版本号>` tag 时，GitHub Actions 在 `windows-latest` 上执行完整 `npm run dist:win` 流水线，并创建同名 GitHub Release。Release 附带 NSIS 安装包、Portable EXE、blockmap 与 SHA-256 校验文件。该流程不携带开发机凭据，也不默认签名；拿到证书后再以 GitHub Secrets 注入签名凭据。

当前工程仍处于开发运行阶段。生成第一个对外安装包前必须补齐：AI 初始化界面、打包配置、应用图标与版本信息、代码签名、干净机器安装测试，以及当前 Electron 安全版本升级。
