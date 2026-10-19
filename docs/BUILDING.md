# 打包与分发指南

> 目标：让任何 Windows 用户在干净电脑上双击安装包后即可使用文渡（ContentFerry）。
> 依据：[spec/04 Windows 安装包与 AI 初始化设计](../spec/04-windows-packaging-and-ai-setup.md)。

普通用户不需要阅读本文。开发者和发布工程师按下面步骤操作。

## 1. 流水线总览

`scripts/build-installer.mjs` 把以下七步串成一条命令（与 `spec/04 §5` 对应）：

1. **依赖锁定** — `npm install`（如 `node_modules` 不存在）。
2. **类型检查** — `tsc --noEmit` 同时校验 `tsconfig.main.json` 和 `tsconfig.renderer.json`。
3. **原生模块重建** — `electron-rebuild -f -w better-sqlite3`，先让 SQLite 与 Electron 测试运行时的 ABI 一致。
4. **单元测试** — `npm test` 会先执行原生模块重建，再运行 vitest + Electron；打包流水线已完成重建时直接调用内部的 `npm run test:electron`，避免重复编译。
5. **生产构建** — `tsc -p tsconfig.main.json` + `vite build`。
6. **打包** — `electron-builder`；`dist:portable` 显式选择 `portable` 目标，`dist:win` 按配置产出 NSIS 安装包 + Portable EXE。
7. **后置校验** — `scripts/verify-installer.mjs` 检查 `app.asar` 完整性、`better_sqlite3.node`、`codex.exe`、内置技能目录和独立用户手册是否正确进入安装资源。

> `npm run typecheck`、`npm test`、`npm run rebuild:native` 三个命令在开发模式下也使用；流水线里复用它们，避免维护两份等价逻辑。

## 2. 开发者先决条件

- Windows 10 1809+（x64）。
- Node.js 22.19+；当前 Undici 8 的运行要求不支持更早的 Node.js。建议使用项目自带的托管版 Node.js（路径形如 `C:\Users\<用户名>\.workbuddy\binaries\node\versions\<版本>\node.exe`）。
- Visual Studio Build Tools（含 C++ 桌面开发组件，用于 `better-sqlite3` 编译）。
- Python 3（electron-rebuild 在 Windows 上需要）。
- 磁盘至少 5 GB 空闲（Electron + node_modules + 中间产物 + 安装包）。
- 网络畅通（`electron-builder` 会下载 Electron 二进制与 NSIS 模板）。

macOS / Linux 主机可以跑 `npm run pack`（即 `--dir` 模式）做交叉编译验证；正式发布需要在 Windows 上执行 `npm run dist:win`。

## 3. 命令

```powershell
# 完整构建：类型检查 + 重建原生 + 测试 + 构建 + 打包 + 校验
npm run dist:win

# 只产 portable EXE
npm run dist:portable

# 只产未压缩目录（开发自测最快）
npm run pack

# 仅校验 release/ 下的产物
npm run verify:installer
```

发布前对生产依赖执行 `npm audit --omit=dev --registry=https://registry.npmjs.org`，并核对锁文件中的已知漏洞修复版本。`npmmirror` 可用于安装依赖，但目前不提供 npm 的安全审计接口；审计命令只在本次调用使用官方仓库，不修改本机默认镜像设置。高危和中危告警应在发布前处理或逐项记录不可达的依据。

### 隔离开发版用户数据

若需排查启动或迁移问题，可让开发版使用全新用户配置目录，避免打开日常配置和数据库。设置 `CONTENTFERRY_DEV_USER_DATA_DIR` 后运行 `npm run dev`：

```powershell
$env:CONTENTFERRY_DEV_USER_DATA_DIR = Join-Path $env:TEMP "contentferry-dev-profile"
npm run dev
```

此目录不包含现有模型连接和凭据；未设置该变量时，开发版仍使用 Electron 默认用户配置。隔离目录中的文章和设置与日常配置相互独立。


产物写入 `release/`。`dist:portable` 只生成当前版本的 Portable EXE；`dist:win` 生成当前版本的 NSIS 安装包和 Portable EXE。文件名在版本号后附本次打包的 UTC 时间（`YYYYMMDDTHHMMSSZ`）；包内 `dist/build-info.json`、应用“关于文渡”和每条运行日志使用同一个构建标识，便于核对正在运行的包。目录中的旧版本会保留，构建报告只列出本次构建与目标对应的文件。产物名固定使用 ASCII 前缀 `ContentFerry-`（应用名仍是「文渡」）：GitHub Release 上传通路会丢弃资产名中的非 ASCII 前缀，中文产物名会导致发布清单与草稿资产名不一致，`scripts/release-gates.mjs` 在构建期强制校验 ASCII 命名：

| 文件                            | 含义                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `ContentFerry-Setup-<version>-<UTC时间>.exe`    | NSIS 安装包（推荐给普通用户）                                                          |
| `ContentFerry-Portable-<version>-<UTC时间>.exe` | 单文件便携版，无需安装                                                                 |
| `win-unpacked/`               | 未压缩的可执行目录，便于开发自测或调查问题                                                 |
| `latest.yml` / `*.blockmap` | `electron-builder` 默认生成的分块元数据，未配 `publish` 时只用于差分计算，不会被推上去 |

## 4. 第一次发布前的本地验证

流水线跑通后，请在 **未安装 Node.js、未安装 Codex CLI** 的 Windows x64 虚拟机或实体机上做以下验证（与 `spec/04 §5.5/§5.6` 对应）：

1. 双击 `ContentFerry-Setup-<version>-<UTC时间>.exe` 完成安装，确认：
   - 桌面和开始菜单出现"文渡 ContentFerry"快捷方式。
   - 卸载时**不**自动删除 `%APPDATA%\contentferry\app-settings.json` 和 `…\data`。
2. 首次启动看到四步向导，按提示选数据目录、检测 Codex。允许跳过 AI 步骤，确认仍能进入主界面。
3. 关闭应用，再启动一次——不应再弹向导。
4. 把 `%APPDATA%\contentferry\app-settings.json` 删除后再次启动——应重新进入向导。
5. 模拟"未登录 OpenAI Codex"：跳过 AI 后到 `设置 → 模型与技能`，触发一次"生成提纲"，确认能引导到登录页。
6. 模拟"已有 Codex 登录"：用一台已登录 ChatGPT 的电脑直接跑安装包，启动后不弹向导，且能直接调用 Codex。
7. 模拟"断网"：拔网线后启动应用，登录页和主界面应正常加载，仅 AI 任务失败并显示可读错误。
8. 模拟"升级"：覆盖安装任意两个相邻版本，确认数据目录、app-settings、数据库不丢失；新版本可继续使用。
9. 模拟"回退"：覆盖安装回旧版本，确认旧版本仍能打开新版本的数据目录（如不兼容则有保护性提示）。
10. 打开“帮助”，确认“打开完整说明”能够打开安装包中的`docs/USER-GUIDE.md`；进入“技能与模型”，确认清单中的技能均已从`resources/assets/skills/`初始化。

## 5. 升级策略

按 `spec/04 §2` 与 `spec/02 §12`：本版**不**内置 auto-update。用户手动触发升级时：

- 安装包升级**不**覆盖 `%APPDATA%\contentferry\app-settings.json` 与 `…\data`。
- 升级前会由 NSIS 把旧 `app.asar` 备份到 `%APPDATA%\contentferry\backups\`（自动备份逻辑在 `spec/02 §12.4` 后续阶段补；本流水线不强制，但建议保留目录结构）。
- 旧数据库首次应用自主实践任务表迁移时，程序会先在所选数据目录的 `backups/` 下生成 `contentferry-before-schema-v1-*.db` 一致性副本。迁移失败时停止服务启动；回退旧程序前应关闭文渡，用该副本恢复 `contentferry.db`，不要让旧程序直接写新版库。应用的一键数据库恢复界面尚未实现。
- 后续 schema 迁移也会在执行前创建一致性备份。schema v9 将内容评审记录允许的修订轮数扩展至 5 并保留旧记录；迁移失败时程序停止开放业务服务。
- schema v13 新增独立的正文候选稿表；迁移前同样会备份数据库。回退到不支持 v13 的程序时，关闭文渡后恢复 `backups/` 中升级前的数据库副本，不要直接用旧程序打开新版库。
- `package.json` 的 `productName` 是 `文渡`，NSIS 会以它作为安装目录与快捷方式名。

如需自动更新，再加 `electron-updater` 并设置 `publish: { provider: "generic", url: "https://your-cdn/contentferry" }`，届时 `latest.yml` 才会有用。

## 5.1 GitHub Actions 发布

仓库的 `.github/workflows/release-windows.yml` 会在推送形如 `v0.1.0` 的 Git tag 时，使用 GitHub 托管的 Windows Runner 自动执行：

1. `npm ci`；
2. `npm run dist:win`（类型检查、原生模块重建、测试、构建、打包与产物校验）；
3. 冻结安装包、blockmap、`SHA256SUMS.txt` 和 `release-manifest.json` 为绑定本次提交与运行次数的候选 artifact；
4. 发布 job 在 `release-production` 环境等待 `weiluliaokeji` 人工批准；
5. 下载同一 artifact，复验批准记录、tag 与全部文件哈希，先上传 Release 草稿并核对远端资产摘要，最后公开发布。

`build/installer.nsh` 是 NSIS 的安装/卸载钩子，虽位于构建缓存目录旁，但必须随源码提交；`.gitignore` 只忽略 `build/` 下的其余生成内容。
发布工作流保留原始中文文件名；同名 Release 或草稿已存在时拒绝创建，不覆盖资产。失败的草稿需维护者核对处置；重新发布使用新的完整构建与审批，不仅重跑发布 job。发布 job 不安装项目依赖、不重新构建安装包。

首次使用需配置 GitHub Environment `release-production`：唯一 Required reviewer 为 `weiluliaokeji`，关闭管理员绕过，单人维护允许本人审批自己的运行。流水线会检查该配置，未配置时失败。批准前下载本次候选 artifact，核对提交、版本、验证结果和清单；随后在 Actions 的 Review deployments 中批准。详情及本地测试解锁见 [人工审批门](agents/approval-gates.md)。

Tag 必须与 `package.json` 中的版本一致。例如将版本改为 `0.1.1`、完成提交并推送后：

```powershell
git tag v0.1.1
git push origin v0.1.1
```

Actions 页面可查看完整构建日志。工作流默认生成**未签名**安装包；代码签名配置见下一节。

## 5.2 GitHub Actions PR 检查

`.github/workflows/ci.yml` 在所有 PR、`master` 推送和手动触发时运行。`Windows checks` 使用 Windows Runner、Node.js 22 和 npm 缓存，依次执行：

1. `npm ci`，按锁文件安装依赖并执行现有原生模块安装步骤；
   安装及后续检查通过 `ci:step` 包装，逐步保存退出码和脱敏日志。
2. `npm run fix:test`，检查测试保护 hook 的脚本行为；
3. `npm run eval:agent:test`，检查 Agent eval 评分器，避免把损坏轨迹、误改测试或超时判为通过；
4. `npm run build`，完成主进程、渲染进程的类型检查与生产编译；
5. `npm test`，重建 SQLite 原生模块并在 Electron 运行时执行全量 Vitest 测试。

另外运行 `ci:tooling:test` 和 `verify:rollback`：前者验证诊断包、脱敏、退出码和只读分析准备；后者用固定的 v12 合成夹具演练数据迁移、生产备份与恢复，不覆盖真实用户库或旧版 EXE。始终尝试采集并上传白名单诊断包（保留 7 天），采集步骤不能把原始失败改为成功；取消或 runner 故障时上传可能缺失。本地准备与分析方法见 [CI 诊断](agents/ci-triage.md)。

工作流只授予仓库读取权限，不持久保存 checkout 凭据，不需要模型或平台密钥。相同 PR 或分支的新运行会取消旧运行，单次作业上限为 30 分钟；未设置路径过滤，文档或 Agent 配置变更也会触发检查。hook 脚本测试不代表 Codex 会话中的 hook 已加载，后者仍须单独验收。

另有独立的 `.github/workflows/ci-health.yml` 每周一生成只读 CI 健康快照，也可在 Actions 中手动运行并选择 `master`。它统计近 37 天 PR 检查与 `master` 推送的完成结果，不参与 PR 必需检查，不调用模型或触发自动行动；报告位于 workflow 摘要和 90 天 artifact 中。指标口径、样本上限提示及解释见 [CI 诊断与健康快照](agents/ci-triage.md)。

此检查不生成安装包，也不验证 GUI、preload/IPC 或生产窗口启动，相关改动仍按 `AGENTS.md` 完成对应验证。要强制检查通过后才能合并，还需在 GitHub 分支保护或 ruleset 中将 `Windows checks` 设为必需状态检查；提交 workflow 文件本身不会开启合并限制。

## 5.3 Agent 快速 eval

编码 Agent 配置变更由 `.github/workflows/agent-evals.yml` 另行运行六个隔离任务，使用实际工具轨迹、文件指纹和独立测试评分。普通 CI 只运行不调用模型的评分器自测。模型认证、触发范围、报告与首次基线建立步骤见 [Agent 快速 eval](agents/agent-evals.md)。这套检查不替代 Windows 产品测试、GUI 或生产构建启动验证。

## 6. 代码签名（未启用）

本次不接 Windows 代码签名（用户决定）。拿到的 EV/OV 代码签名 PFX 后，扩展 `package.json#build` 即可：

```jsonc
"win": {
  "icon": "assets/wendu-icon.ico",
  "target": [
    { "target": "nsis", "arch": ["x64"] },
    { "target": "portable", "arch": ["x64"] }
  ],
  "artifactName": "ContentFerry-Setup-${version}.${ext}",
  "signAndEditExecutable": true,
  "signtoolOptions": {
    "publisherName": "ContentFerry",
    "signingHashAlgorithms": ["sha256"],
    "certificateFile": "%CSC_LINK%",
    "certificatePassword": "%CSC_KEY_PASSWORD%"
  }
}
```

常用环境变量：

- `CSC_LINK` — 指向 `.pfx` 文件的绝对路径或 base64 内容。
- `CSC_KEY_PASSWORD` — PFX 密码。
- `CSC_KEY_REMOTE` / `CSC_KEY_TSA_URL` — 远端签名服务与时间戳（可选）。

未配置时不报错；这是开发阶段故意保留的"无签名也能出包"行为。

## 7. 故障排查

| 现象                                                          | 原因 / 处置                                                                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron-builder` 报 `cannot find module @electron/asar` | `npm install` 没装 devDependencies；重新跑 `npm install`。                                                                                |
| `rebuild:native` 卡在下载 prebuilt binaries                 | 离线环境；设置`npm config set @electron/rebuild_rebuild_prebuilt false` 或允许访问 `electronjs.org`。                                     |
| 安装包能装但启动后白屏                                        | 检查`app.asar` 内 `dist/main/main/index.js` 是否在；`verify:installer` 报告若不通过说明构建没把 `dist/` 收进去。                      |
| 启动时`codex.exe not found` 警告                            | `asarUnpack` 没把 `@openai/codex-win32-x64` 列上；检查 `package.json#build.asarUnpack` 是否包含 `**/node_modules/@openai/codex*/**`。 |
| 启动时报“找不到内置技能资源”                                  | 检查`resources/assets/skills/manifest.json`与每个技能的`SKILL.md`是否存在；运行`npm run verify:installer`。                         |
| “打开完整说明”提示安装包缺少文件                              | 检查`resources/docs/USER-GUIDE.md`；确认`package.json#build.extraResources`仍包含`docs`规则。                                       |
| 卸载时数据被删                                                | `nsis.deleteAppDataOnUninstall` 被改成 `true`；保持 `false` 即可。                                                                      |
| 第一次启动无限弹向导                                          | `app-settings.json` 写入失败；查看 `%APPDATA%\contentferry\logs\` 下的运行日志。                                                          |
| `ERROR: Cannot create symbolic link` 报在 `…\winCodeSign\<hash>\darwin\…\libcrypto.dylib` | electron-builder ≤25 的 7-Zip 符号链接问题（历史 workaround 已退场，见 §7.1）。删 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` 后重跑 `npm run dist:win`；仍不行则开启 Windows「开发人员模式」。 |
| 打包时报 `ENOENT … mkdir …electron-builder\Cache\127.0.0.1:<port>\nsis-…` | 本地覆写服务与 app-builder-lib 26.17.0 的缓存目录推导冲突（v0.3.4 发布事故，0.3.5 已移除该服务，见 §7.1）。若在旧工作区复现：确认 `scripts/build-installer.mjs` 不再设置 `ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL`。 |

## 7.1 winCodeSign 与本地覆写服务：一段已经退场的历史

`winCodeSign-2.6.0.7z` 的 `darwin/10.12/lib/` 下含 macOS 符号链接。electron-builder ≤25
调用 7-Zip 时传了并不存在的 `-snld` 参数，7-Zip 静默忽略后按默认行为尝试重建符号链接，
未开启 Windows「开发人员模式」的机器会直接失败。流水线先后用过两代 workaround：
预解压（`-snld -xr!darwin` + 哨兵文件）和本地 HTTP 覆写服务
（`ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL` 指向 `127.0.0.1:<port>`，serve 剔除
`darwin/` 后的归档，其余请求代理到 GitHub）。

**两代 workaround 均已于 0.3.5 移除**，原因有两条，都有源码级证据：

1. electron-builder 26 不再传递 `-snld`（`app-builder-lib` 全仓已无该字符串），且其
   winCodeSign 下载路径（`toolsets/windows.js` 的 `getLegacyWinCodeSignBin`）根本不读该
   环境变量——覆写服务对 winCodeSign 早已不起作用。
2. app-builder-lib 26.17.0 的 `binDownload.js#getBin` 改为从 override URL 的 basename
   推导工具集缓存目录名，`http://127.0.0.1:<port>` 因此变成含英文冒号的目录名，而冒号在
   Windows 是非法目录名字符：所有走 `getBinFromUrl` 的工具集（nsis、rcedit 等）在
   `mkdir` 阶段即报 `ENOENT`。**v0.3.4 的发布构建（run 39223578350）正是死在这里**，
   失败点在 NSIS 打包阶段的 `getNsisElevatePath`。本地最小复现：对该进程设置
   `ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL=http://127.0.0.1:56370/` 后调用
   `getBinFromUrl("nsis-3.0.4.1", …)`，无需真的起服务器就会得到同一 ENOENT；不设置则该
   调用干净下载解压到 `Cache\nsis-3.0.4.1\`。上游 master 已把此处重构为"URL 只贡献哈希
   后缀"，但修复尚未进入任何稳定版（稳定线最新即 26.17.0）。

现在所有工具集（nsis、winCodeSign、rcedit……）都从 GitHub 直接下载解压。
`scripts/build-installer.test.mjs` 有一条防回归断言：流水线不得再设置
`ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL`，也不得再引入上述三个覆写服务函数。

## 8. 相关脚本

- `scripts/build-installer.mjs` — 整条流水线（CI 与本地共用）。
- `scripts/verify-installer.mjs` — 单独跑校验，传 `--release-dir` 可指向其他目录。
- `scripts/dev-desktop.mjs` — 已有；开发时跑 Electron 桌面壳，不参与打包。

## 9. 待办（按 spec 顺序）

- [ ] Windows 代码签名（拿到证书后接入）。
- [ ] 应用自动备份（`spec/02 §12.4`）。
- [ ] 设置页 → 数据目录迁移（`spec/04 §2`）。
- [ ] macOS / Linux 产物（`spec/04 §2` 限定 x64 优先，跨平台后置）。
- [ ] 在干净 Windows 虚拟机上的端到端冒烟测试脚本化。
