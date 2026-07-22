# 打包与分发指南

> 目标：让任何 Windows 用户在干净电脑上双击安装包后即可使用文渡（ContentFerry）。
> 依据：[spec/04 Windows 安装包与 AI 初始化设计](../spec/04-windows-packaging-and-ai-setup.md)。

普通用户不需要阅读本文。开发者和发布工程师按下面步骤操作。

## 1. 流水线总览

`scripts/build-installer.mjs` 把以下七步串成一条命令（与 `spec/04 §5` 对应）：

1. **依赖锁定** — `npm install`（如 `node_modules` 不存在）。
2. **类型检查** — `tsc --noEmit` 同时校验 `tsconfig.main.json` 和 `tsconfig.renderer.json`。
3. **单元测试** — `npm test`（与开发共用同一条 vitest + Electron 运行时命令）。
4. **生产构建** — `tsc -p tsconfig.main.json` + `vite build`。
5. **原生模块重建** — `electron-rebuild -f -w better-sqlite3`。
6. **打包** — `electron-builder`，按 `package.json#build` 配置产出 NSIS 安装包 + Portable EXE。
7. **后置校验** — `scripts/verify-installer.mjs` 检查 `app.asar` 完整性、`better_sqlite3.node` 和 `codex.exe` 是否正确放置在 ASAR 之外。

> `npm run typecheck`、`npm test`、`npm run rebuild:native` 三个命令在开发模式下也使用；流水线里复用它们，避免维护两份等价逻辑。

## 2. 开发者先决条件

- Windows 10 1809+（x64）。
- Node.js 20+；建议使用项目自带的托管版 `C:\Users\adams\.workbuddy\binaries\node\versions\22.22.2\node.exe`。
- Visual Studio Build Tools（含 C++ 桌面开发组件，用于 `better-sqlite3` 编译）。
- Python 3（electron-rebuild 在 Windows 上需要）。
- 磁盘至少 5 GB 空闲（Electron + node_modules + 中间产物 + 安装包）。
- 网络畅通（`electron-builder` 会下载 Electron 二进制与 NSIS 模板）。

macOS / Linux 主机可以跑 `npm run pack`（即 `--dir` 模式）做交叉编译验证；正式发布需要在 Windows 上执行 `npm run dist:win`。

## 3. 命令

```powershell
# 完整构建：类型检查 + 测试 + 构建 + 重建原生 + 打包 + 校验
npm run dist:win

# 只产 portable EXE
npm run dist:portable

# 只产未压缩目录（开发自测最快）
npm run pack

# 仅校验 release/ 下的产物
npm run verify:installer
```

默认产出会写入 `release/`：

| 文件                            | 含义                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `文渡-Setup-0.1.0.exe`        | NSIS 安装包（推荐给普通用户）                                                              |
| `文渡-Portable-0.1.0.exe`     | 单文件便携版，无需安装                                                                     |
| `win-unpacked/`               | 未压缩的可执行目录，便于开发自测或调查问题                                                 |
| `latest.yml` / `*.blockmap` | `electron-builder` 默认生成的分块元数据，未配 `publish` 时只用于差分计算，不会被推上去 |

## 4. 第一次发布前的本地验证

流水线跑通后，请在 **未安装 Node.js、未安装 Codex CLI** 的 Windows x64 虚拟机或实体机上做以下验证（与 `spec/04 §5.5/§5.6` 对应）：

1. 双击 `文渡-Setup-0.1.0.exe` 完成安装，确认：
   - 桌面和开始菜单出现"文渡 ContentFerry"快捷方式。
   - 卸载时**不**自动删除 `%APPDATA%\contentferry\app-settings.json` 和 `…\data`。
2. 首次启动看到四步向导，按提示选数据目录、检测 Codex。允许跳过 AI 步骤，确认仍能进入主界面。
3. 关闭应用，再启动一次——不应再弹向导。
4. 把 `%APPDATA%\contentferry\app-settings.json` 删除后再次启动——应重新进入向导。
5. 模拟"未登录 OpenAI Codex"：跳过 AI 后到 `设置 → 模型与技能`，触发一次"生成提纲"，确认能引导到登录页。
6. 模拟"已有 Codex 登录"：用一台已登录 ChatGPT 的电脑直接跑安装包，启动后不弹向导，且能直接调用 Codex。
7. 模拟"断网"：拔网线后启动应用，登录页和主界面应正常加载，仅 AI 任务失败并显示可读错误。
8. 模拟"升级"：覆盖安装一次 0.1.0 到 0.1.0（或任意两个相邻版本），确认数据目录、app-settings、数据库不丢失；新版本可继续使用。
9. 模拟"回退"：覆盖安装回旧版本，确认旧版本仍能打开新版本的数据目录（如不兼容则有保护性提示）。

## 5. 升级策略

按 `spec/04 §2` 与 `spec/02 §12`：本版**不**内置 auto-update。用户手动触发升级时：

- 安装包升级**不**覆盖 `%APPDATA%\contentferry\app-settings.json` 与 `…\data`。
- 升级前会由 NSIS 把旧 `app.asar` 备份到 `%APPDATA%\contentferry\backups\`（自动备份逻辑在 `spec/02 §12.4` 后续阶段补；本流水线不强制，但建议保留目录结构）。
- `package.json` 的 `productName` 是 `文渡`，NSIS 会以它作为安装目录与快捷方式名。

如需自动更新，再加 `electron-updater` 并设置 `publish: { provider: "generic", url: "https://your-cdn/contentferry" }`，届时 `latest.yml` 才会有用。

## 6. 代码签名（未启用）

本次不接 Windows 代码签名（用户决定）。拿到的 EV/OV 代码签名 PFX 后，扩展 `package.json#build` 即可：

```jsonc
"win": {
  "icon": "assets/wendu-icon.ico",
  "target": [
    { "target": "nsis", "arch": ["x64"] },
    { "target": "portable", "arch": ["x64"] }
  ],
  "artifactName": "${productName}-Setup-${version}.${ext}",
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
| 卸载时数据被删                                                | `nsis.deleteAppDataOnUninstall` 被改成 `true`；保持 `false` 即可。                                                                      |
| 第一次启动无限弹向导                                          | `app-settings.json` 写入失败；查看 `%APPDATA%\contentferry\logs\` 下的运行日志。                                                          |
| `ERROR: Cannot create symbolic link` 报在 `…\winCodeSign\<hash>\darwin\…\libcrypto.dylib` | `winCodeSign-2.6.0.7z` 内的 `darwin/` 目录含 macOS 符号链接，7-Zip 21.07 在 Windows 上无法重建。流水线已自动用 `-snld -xr!darwin` 预先解压跳过该子目录，正常情况下看不到这个错误。**仅当 cache 目录被手动弄坏** 时才会出现，删 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` 后重跑 `npm run dist:win` 即可。 |
| winCodeSign 预解压失败，提示 `7-Zip finished but …signtool.exe is missing` | 归档文件损坏或被改过。运行 `npm run dist:win -- --refresh-wincodesign` 强制清掉旧的 `.contentferry-pre-extracted` 哨兵和临时目录并重新解压。 |

## 7.1 winCodeSign 预解压：为什么流水线要自己跑 7-Zip

`electron-builder` 内部会下载 `winCodeSign-2.6.0.7z` 并调用其自带的 7-Zip 21.07 解压到
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<sha1>\`。该归档在 `darwin/10.12/lib/`
下包含若干指向 `libcrypto.1.0.0.dylib` / `libssl.1.0.0.dylib` 的符号链接，**Windows 默认
不开启"开发人员模式"时** 没有创建符号链接的权限，7-Zip 会以非零退出码失败并让
electron-builder 终止。

普通 macOS-only 仓库可以直接删掉 `darwin/`，但 ContentFerry 必须保留 winCodeSign 全部
Windows 资产（`rcedit.exe`、`signtool.exe`、`makeappx.exe` 等），所以采用"流水线自己
预解压"的方式：

1. 找出 `Cache\winCodeSign\` 下所有 `<hash>.7z`（不一定是 `winCodeSign-2.6.0.7z`，
   electron-builder 按 URL 的 SHA1 命名），以及对应的 `<hash>\` 目录。
2. 对每个 `<hash>\` 检查 `.contentferry-pre-extracted` 哨兵 + `windows-10\x64\signtool.exe`、
   `windows-6\signtool.exe`、`rcedit-x64.exe` 是否齐全；齐全就跳过。
3. 否则**先清空**该目录（避免 7-Zip 失败留下的 0 字节残文件干扰），用
   `node_modules\7zip-bin\win\x64\7za.exe x -bd -y -snld -xr!darwin -o<dir> <archive>`
   重新解压。`-snld` 让 7-Zip **完全跳过符号链接创建**，`-xr!darwin` 是冗余防御。
4. 解压后再检查上面三个关键文件大小 > 0；通过则写哨兵。
5. `electron-builder` 随后看到 cache 已就绪、关键文件齐备，会跳过自己的解压步骤。

何时需要手工介入：

- 主机从未解压过 `darwin/` 符号链接，**且** 没有开启开发人员模式 → 流水线自己就能解决。
- 删 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` → 下次构建会重新走预解压。
- `npm run dist:win -- --refresh-wincodesign` → 强制忽略哨兵、从头解压，用于排查疑似缓存
  损坏。
- 想要彻底关闭这个 workaround → 开启 Windows「设置 → 隐私和安全 → 开发者选项 →
  开发人员模式」，并把 `scripts/build-installer.mjs` 里的 `prepareWinCodeSignCache` 调用
  包成 `if (false) { ... }`。

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
