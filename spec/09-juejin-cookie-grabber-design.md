# 掘金 Cookie 自动获取设计

> 状态：设计中（待评审）
> 关联文档：`spec/08-juejin-publishing-implementation.md`（掘金发布实现）
> 参考实现：`src/main/automation/windows.ts`、`src/main/automation/zhuque-detection.ts`（BrowserWindow 自动化先例）
> 交互位置：账号页掘金凭据配置卡片（`src/renderer/App.tsx`）

## 1. 背景与目标

掘金发布需要 Cookie + AID + UUID 三项凭据。现状是用户在账号页手动从浏览器开发者工具复制 Cookie 后粘贴，步骤繁琐且易出错（Cookie 串长、AID/UUID 需自行定位）。本期在账号页提供一个"自动获取"入口：应用内弹出登录窗口，用户正常扫码/手机号登录后，自动读取登录态 Cookie、AID、UUID 并回填保存，全程无需复制粘贴。

### 已确认决策

| 决策点 | 结论 |
|---|---|
| 交互形态 | 应用内弹出 BrowserWindow 登录窗口（非系统浏览器） |
| 抓取范围 | Cookie + AID + UUID 三项全自动 |
| 登录成功判定 | 以登录态 Cookie 出现为准（sessionid / passport_csrf_token），不依赖 URL 跳转 |
| 收尾方式 | 检测到登录态后自动回填并关闭窗口；窗口保留"取消/关闭"兜底 |
| 有效性验证 | 回填前用 Cookie 调掘金轻量接口验证；失败仅提示不阻塞保存 |
| 多账号 | 只作用于当前选中的掘金账号，登录窗口与账号绑定 |
| 凭据安全 | 复用 CredentialVault 加密存储，凭据永不回显、不落日志、不进 Git |

## 2. 需求范围

### 本期做

- 账号页掘金配置卡片新增"自动获取 Cookie"按钮。
- 主进程打开登录窗口加载 `https://juejin.cn/`，用户正常登录。
- 检测到登录态 Cookie 后自动抓取：Cookie 全串、AID（默认 2608，可被页面值覆盖）、UUID（优先读页面 localStorage，兜底从 Cookie 提取）。
- 抓取后用 Cookie 调用掘金轻量接口验证有效性。
- 验证通过后回填到当前账号并保存（`juejin_cookie` / `juejin_aid` / `juejin_uuid`），自动关闭登录窗口，账号页提示成功。
- 用户可随时取消/关闭窗口，不产生任何凭据变更。

### 本期不做

- 多账号同时获取（一次一个，作用于当前选中账号）。
- Cookie 过期后的自动重新登录提醒（沿用现有 `needs_credentials` 状态流转）。
- 浏览器自动化发布（掘金发布仍是纯 API 链路，本期只做凭据获取）。
- 登录窗口内嵌进配置卡片（独立窗口，交互简单可靠）。

## 3. 架构设计

### 3.1 分层

```
账号页（renderer）──POST /api/integrations/juejin/cookie-grab/start──▶ 主进程 grab 模块
   ▲                                                                        │
   │  GET /api/integrations/juejin/cookie-grab/status（轮询）              │ 新建 BrowserWindow
   │                                                                        ▼
   └──────── 返回 { cookie, aid, uuid, verified } ◀── 检测登录态 → 抓取 → 验证
```

- 主进程新增 `src/main/juejin/juejin-cookie-grab.ts`：管理登录窗口生命周期、登录态检测、Cookie/UUID 抓取、验证。
- 主进程 `src/main/automation/windows.ts`：在辅助窗口列表中登记 grab 窗口，退出时统一销毁（`destroyAuxiliaryWindows`）。
- HTTP API 新增两条路由（注册于 `src/main/server/routes-channels.ts` 或新建 `routes-juejin.ts`）：
  - `POST /api/integrations/juejin/cookie-grab/start`：body `{ accountId }`，启动登录窗口，返回 `{ grabId }`。
  - `GET /api/integrations/juejin/cookie-grab/status?grabId=...`：返回当前状态（`waiting_login` / `grabbing` / `success` / `cancelled` / `error`）及成功时的凭据数据。
- renderer 账号页：点击按钮 → start → 轮询 status → 成功回填并保存（复用现有 `PUT /media-accounts/:id/credentials/:kind`）。

### 3.2 登录窗口

- `new BrowserWindow({ width: 1000, height: 720, parent: mainWindow, modal: false, autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false } })`，加载 `https://juejin.cn/`。
- 不注入任何脚本、不修改登录页；用户扫码或手机验证码登录均为掘金原生流程。
- 窗口关闭（含用户取消）→ 状态置 `cancelled`，无凭据变更。

### 3.3 登录态检测与抓取

- 监听 `window.webContents.session.cookies.on("changed", ...)`，每次变更后读取 `session.cookies.get({})`。
- 判定登录成功的条件：存在登录态 Cookie（键名含 `sessionid` 或 `passport_csrf_token`，以实测为准；登录前这些键不存在）。
- 成功判定后（防抖 800ms 等待 Cookie 稳定）：
  - Cookie 串：`cookies.get({})` 结果按 `name=value` 以 `; ` 拼接。
  - AID：默认 `"2608"`；若页面存在可读取的 AID（localStorage/接口），以其为准（可选，默认 2608 即可）。
  - UUID：优先 `webContents.executeJavaScript("localStorage.getItem('uuid')")`；为空则从 Cookie 中查找候选键（如 `uuid` / `sessionid` 的提取值，以实测为准）；仍为空则留空字符串（现有客户端允许 uuid 为空）。

### 3.4 有效性验证

- 用抓到的 Cookie 请求掘金免签名轻量接口（候选：`article/list_by_user` 或 `article_draft/detail` 的空调用；以 `spec/08` 已确认的免签名接口为准）。
- 返回 `err_no === 0` 视为有效；否则 `verified: false`，仍回填但账号页提示"凭据已保存，但验证未通过，请检查登录态"。

### 3.5 凭据保存

- 成功抓取后 renderer 调用现有凭据保存接口：
  - `PUT /api/media-accounts/:accountId/credentials/juejin_cookie` → `{ secret: cookie }`
  - `PUT /api/media-accounts/:accountId/credentials/juejin_aid` → `{ secret: aid }`
  - `PUT /api/media-accounts/:accountId/credentials/juejin_uuid` → `{ secret: uuid }`
- 凭据进入 CredentialVault 加密存储，行为与手动配置完全一致。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| 用户关闭/取消窗口 | 状态 `cancelled`，无凭据变更，按钮复位 |
| 登录窗口加载失败（网络/被墙） | 状态 `error`，窗口保留可重试，账号页提示"无法打开掘金登录页" |
| 长时间未登录 | 不自动超时；用户可手动关闭；按钮可再次触发新窗口 |
| 验证接口失败 | `verified: false`，凭据仍保存，账号页提示验证未通过 |
| 重复点击"自动获取" | 若已有活跃 grab 窗口，直接复用并返回同一 grabId，不重复开窗 |

## 5. 测试策略

- 单测（Vitest，主进程纯逻辑）：
  - Cookie 拼接函数：输入 cookie 对象数组，输出 `name=value; name2=value2`，空值过滤。
  - 登录态判定：含 `sessionid` / `passport_csrf_token` 键为 true，否则 false。
  - UUID 提取：localStorage 命中 / Cookie 兜底 / 全空 三种分支。
  - 验证结果映射：`err_no === 0` → verified。
- 手动验收：
  - 账号页点击"自动获取"→ 弹出窗口 → 扫码登录 → 自动关闭并提示成功 → 凭据状态变已配置。
  - 取消窗口 → 无凭据变更。
  - 用抓到的凭据执行一次掘金草稿创建验证全链路。

## 6. 安全约束（对齐 AGENTS.md）

- 凭据（Cookie 串、AID、UUID）不得进入源码、测试、日志或 Git。
- 日志只记录状态迁移（`grab waiting_login` / `grab success`），不记录凭据内容与 Cookie 字段值。
- 登录窗口 webPreferences 保持 `contextIsolation: true`、`nodeIntegration: false`，不注入 preload 之外的桥。
- 不做任何绕过掘金验证码/风控的自动化输入；登录动作全部由用户手动完成。

## 7. 文档同步

- `docs/USER-GUIDE.md`：账号配置章节补充"掘金自动获取 Cookie"步骤。
- `src/renderer/components/HelpCenter.tsx`：常见问题补充自动获取说明。
- `spec/08-juejin-publishing-implementation.md`：凭据获取章节指向本文档。
