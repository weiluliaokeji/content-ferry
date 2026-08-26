# 掘金（Juejin）发布实现设计

> 状态：已实现待真实验证
> 关联文档：`spec/01-product-requirements.md`、`spec/02-development-design.md`（第 10 章渠道发布子流程）
> 参考实现：`src/main/cnblogs/`（API 直发链路）、`src/main/csdn/`（渠道稿工作台）
> 外部参考：PsChina/web-publish（adapters/juejin.yaml 分类/tag ID 实测，仅作参考不执行）

## 1. 背景与目标

用户需要 ContentFerry 支持掘金（juejin.cn）账号的接入与自动发布，交互形态对齐现有 CSDN / 博客园渠道稿工作台。

掘金提供 `content_api` JSON REST 接口，可纯 API 直发，无需浏览器自动化。按项目"有稳定官方接口时优先使用接口"的产品不变量，本期采用 API 型发布链路。

### 本期已确认决策

| 决策点 | 结论 |
|---|---|
| 发布模式 | 纯 API 直发（content_api JSON REST） |
| 发布确认 | 两段式：创建掘金草稿 → 用户确认 → 公开 |
| 操作范围 | 仅发布新文章；编辑/更新已发布文章列为二期 |
| 入口形态 | 完整渠道稿工作台（对齐 CSDN / 博客园） |
| 凭据 | Cookie + AID + UUID（Cookie 从掘金编辑器页登录态获取） |
| 图片策略 | 本地图片经 ImageX 上传接口传至掘金图床并替换为 CDN URL；远程图片外链直用 |

## 2. 需求范围

### 本期做

- 掘金账号接入：创建账号、配置凭据（Cookie + AID + UUID）、删除账号、凭据状态查询。
- 渠道稿生成：内容库条目生成掘金稿（AI 改写或复制），编辑、审核冻结。
- 两段式发布：创建掘金草稿 → 展示草稿链接 → 用户确认 → 公开。
- 分类与标签：固定分类 ID 映射 + 已知 tag 映射，未命中按 ID 透传。
- 软引流拦截（复用 CSDN 的拦截规则）。
- 发布状态管理与人工校正。

### 本期不做

- 编辑/更新已发布文章（数据库预留 `remote_content_id`，二期扩展）。
- 定时发布（`supportsScheduledPublish: false`）。
- 浏览器自动化路径。
- 文章删除。

## 3. 架构设计

### 3.1 分层

```
账号层（复用 AccountRepository + CredentialVault）
  → 渠道稿层（复用 channel_drafts 表 + 新增 JuejinChannelService）
  → API 客户端层（新增 juejin-client.ts）
  → 发布契约层（实现 PlatformPublisherConnector 能力声明）
  → HTTP API 层（新增 /api/integrations/juejin/* 路由）
  → 渲染层（新增 JuejinDraftWorkspace.tsx）
```

与 CSDN 的差异：无浏览器自动化层，无 IPC 浏览器驱动层，发布链路纯 HTTP API，结构与博客园对齐。

### 3.2 API 端点与凭据

- 端点：`https://api.juejin.cn/content_api/v1/`
- 凭据：`juejin_cookie`（登录 Cookie）、`juejin_aid`（应用 ID，默认 `2608`）、`juejin_uuid`（可选，设备 UUID）
- 签名说明：写接口（draft create/update、publish）不需要反爬签名（msToken / a_bogus），plain `fetch` + Cookie + `aid`/`uuid` 查询参数即可；读接口中 `article/detail` 需要签名，**有意避开**，改用免签名的 `article_draft/detail` 与 `article/list_by_user`。
- 核心方法（均 POST JSON）：
  - `article_draft/create` — 创建草稿
  - `article_draft/update` — 更新草稿
  - `article/publish` — 公开草稿（body 含 `draft_id`、`sync_to_org: false`、`column_ids: []`、`theme_ids: []`）
  - `article_draft/detail` — 读取草稿全文（免签名）
  - `article/list_by_user` — 列出本人文章（免签名；`audit_status` / `status` 必须为 `null`）

### 3.3 HTTP 客户端

不新增第三方依赖。基于 Node 内置 `fetch` 实现轻量 JSON 客户端：

- `src/main/juejin/juejin-client.ts`
- 统一错误类型 `JuejinApiError`（携带 errNo / errMsg）；超时（默认 30s）、HTTP 非 2xx、JSON 解析失败、`err_no !== 0` 均归一化
- 请求头：`content-type: application/json`、`cookie`、`user-agent: ContentFerry/1.0`、`referer: https://juejin.cn/editor/drafts`
- 查询参数：`aid`、`uuid`（有值时）、`spider=0`

## 4. 数据设计

### 4.1 账号

- `media_accounts` 表复用；`AccountPlatform` 联合类型增加 `"juejin"`。
- 凭据复用 `account_credentials(account_id, credential_kind, secret_id)` + `credential_secrets(encrypted_value)`：
  - `credential_kind = "juejin_cookie"` → 掘金登录 Cookie
  - `credential_kind = "juejin_aid"` → AID
  - `credential_kind = "juejin_uuid"` → UUID（可选）
- 凭据一次性接收、永不回显；列表只暴露 `juejinCookieConfigured` / `juejinAidConfigured` / `juejinUuidConfigured` 布尔。
- 凭据获取：账号页支持「自动获取 Cookie」（应用内弹出掘金登录窗口，登录后自动抓取 Cookie/AID/UUID 并回填保存），设计见 `spec/09-juejin-cookie-grabber-design.md`。

### 4.2 发布任务表

新增 `juejin_publish_jobs`（结构同构 cnblogs）：

```sql
CREATE TABLE IF NOT EXISTS juejin_publish_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  account_id TEXT NOT NULL REFERENCES media_accounts(id),
  channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
  rendered_package_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'draft_creating', 'draft_created', 'confirming',
    'published', 'failed', 'needs_manual_reconciliation', 'cancelled',
    'needs_credentials'
  )),
  remote_url TEXT,
  remote_content_id TEXT,
  status_note TEXT,
  error_message TEXT,
  status_source TEXT NOT NULL DEFAULT 'system' CHECK (status_source IN ('system', 'manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

新增 `juejin_publish_job_events`（状态审计，同构 CSDN / 博客园）：

```sql
CREATE TABLE IF NOT EXISTS juejin_publish_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES juejin_publish_jobs(id) ON DELETE CASCADE,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

### 4.3 渠道稿

复用平台无关的 `channel_drafts` 表，无需改动。`generation_mode = 'rewrite' | 'source'` 语义与 CSDN / 博客园一致。渠道稿标题保存时截断至 80 字符，正文上限 100000 字符。

## 5. 状态机

渠道稿状态（复用现有语义）：

```
draft → approved（审核冻结，冻结后不可改）
```

发布任务状态（`juejin_publish_jobs.status`）：

```
createPublishJob → draft_creating
  → article_draft/create 成功 → draft_created（UI 展示草稿链接 + 确认公开按钮）
  → 用户确认 → confirming → article/publish 成功 → published（保存回执）
旁路：
  → 凭据缺失/无效 → needs_credentials（引导补凭据后可重试）
  → API/网络异常 → failed（可重试，幂等键防重复）
  → 草稿已创建但公开失败 → needs_manual_reconciliation（人工校正表单）
  → 用户取消 → cancelled
```

- `idempotency_key` UNIQUE：格式 `juejin:{accountId}:{draftId}:{renderedPackageHash}:publish`；已终止任务重试追加 `:retry:{uuid}` 生成新键，防止重复创建/重复公开。
- 草稿创建并发去重：`createRemoteDraftPromises` 按 job 缓存进行中的 Promise，避免重复请求。
- 可重启状态：`draft_creating` / `draft_created` / `confirming` / `needs_credentials` / `failed` 命中已有任务时复用并继续推进。
- `status_source = 'system' | 'manual'`：区分系统流转与人工校正。

## 6. 图片处理

- 掘金接受外部图片 URL：远程 http(s) 图片保持外链；本地相对路径图片先上传到掘金 ImageX 图床（STS 凭证 + AWS SigV4 五步流程），替换为 CDN URL（`main_url`）。上传失败或单张超过 10M 时回退为 base64 data URI 内联；内联后正文超过 100k 字符本地转 failed 并提示。
- 封面：`coverSource` 直接写入 `cover_image` 字段；空则留空。

## 7. 分类与标签映射

- 分类：固定分类 ID 映射（来自 PsChina/web-publish adapters/juejin.yaml 实测），默认"后端"（`6809637769959178254`）；发布设置可选其他分类，未命中按 ID 透传。

| 分类 | ID |
|---|---|
| 后端（默认） | 6809637769959178254 |
| 前端 | 6809637767543259144 |
| Android | 6809635626879549454 |
| iOS | 6809635626661445640 |
| 人工智能 | 6809637773935378440 |
| 开发工具 | 6809637771511070734 |
| 代码人生 | 6809637776263217160 |
| 阅读 | 6809637772874219534 |

- 标签：已知 tag 名 → ID 映射（AI编程 / OpenAI / AIGC），未命中的输入按 tag ID 原文透传。
- `edit_type = 10`（Markdown 编辑器）；`html_content` 传 `"deprecated"`。
- 摘要 `brief_content`：取渠道稿 digest，为空时取 markdown 去标题/符号后前 100 字符，上限 100。

## 8. HTTP API

在 `src/main/server/create-server.ts` 新增路由（对齐现有 `/api/integrations/*` 风格，共 12 条）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/integrations/juejin/capabilities/:accountId` | 能力声明 |
| GET | `/api/integrations/juejin/channel-drafts` | 渠道稿列表（按账号过滤） |
| POST | `/api/integrations/juejin/channel-drafts` | 从项目或文章库生成渠道稿 |
| POST | `/api/integrations/juejin/channel-drafts/:draftId/approve` | 审核冻结 |
| PUT | `/api/integrations/juejin/channel-drafts/:draftId` | 编辑渠道稿 |
| DELETE | `/api/integrations/juejin/channel-drafts/:draftId` | 删除渠道稿 |
| GET | `/api/integrations/juejin/jobs` | 任务列表 |
| POST | `/api/integrations/juejin/channel-drafts/:draftId/jobs` | 创建发布任务（幂等，body 可带 categoryId/tagIds） |
| GET | `/api/integrations/juejin/jobs/:jobId` | 任务详情（含草稿链接） |
| POST | `/api/integrations/juejin/jobs/:jobId/confirm` | 用户确认 → 公开（单次提交） |
| POST | `/api/integrations/juejin/jobs/:jobId/record-submission` | 保存回执 |
| POST | `/api/integrations/juejin/jobs/:jobId/status` | 人工校正 |

依赖注入：`buildServer(..., options)` 增加 `juejinChannel` 服务实例；未注入时由 create-server 自行构造（同 cnblogs 模式）。`JuejinChannelError` 统一映射为 400 系列 HTTP 错误。

## 9. 渲染层交互

新建 `JuejinDraftWorkspace.tsx`，复制改造自 `CnblogsDraftWorkspace.tsx` / `CsdnDraftWorkspace.tsx`：

- 左工具 / 中编辑器（可视化 + Markdown 双模式）/ 右 AI 助手 + 预览 + 发布设置，布局对齐 CSDN / 博客园。
- 差异点：
  - 无浏览器预检/填充相关 UI（纯 API 直发）。
  - 发布设置：分类下拉（固定分类映射）+ 标签输入（已知映射透传）。
  - 发布流程：点"发布到掘金" → 冻结确认 → 创建任务 → 轮询至 `draft_created` → 展示**掘金草稿链接** + "确认公开"按钮 → 确认 → `published` 展示文章链接。
  - 异常状态展示：`needs_credentials` 引导补凭据；`needs_manual_reconciliation` 提供人工校正表单。
- `src/renderer/main.tsx`：平台枚举增加 juejin、内容库入口行"生成掘金稿/进入掘金稿"、账号列表掘金凭据按钮、掘金凭据弹窗（Cookie/AID/UUID）、发布记录 pending/completed 分支、`juejinJobLabel` 状态文案、任务轮询（活跃状态每 3s 刷新）。
- 无新增 preload/IPC 方法（纯 API 型，无浏览器驱动）。

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 凭据缺失/无效（err_no 401 类） | `needs_credentials`，UI 引导账号管理补凭据 |
| 网络超时/HTTP 错误 | `failed` + 错误信息；用户可重试，幂等键防重复 |
| createDraft 成功但 publish 失败 | `needs_manual_reconciliation`，人工校正 |
| 渠道稿内容为空/标题超长 | 创建任务前校验（标题 ≤80，正文 ≤100000，对齐掘金限制） |
| 模型返回稿不完整 | `JuejinChannelError` 提示重新生成 |
| 软引流内容（公众号链接/二维码/关注公众号等） | 生成、保存、冻结时拦截，提示重新生成 |

## 11. 测试策略

| 层级 | 覆盖 |
|---|---|
| 单元 | JSON 请求构造/响应解析（mock fetch）；err_no 与网络异常映射；状态机全流转；幂等键 UNIQUE 与重启语义；分类/tag 映射与透传；软引流拦截；摘要构建 |
| 集成 | mock HTTP server 验证 createDraft → confirmPublish → publish 链路、完整 payload 传递 |
| E2E | 使用用户真实 Cookie：账号配置 → 渠道稿生成 → 创建草稿 → 确认公开 → 掘金线上校验文章与格式 |

## 12. 验收标准

1. 可在账号管理中创建"掘金"账号并配置 Cookie + AID + UUID，凭据加密存储、不回显。
2. 内容库条目可生成掘金渠道稿（AI 改写/复制），编辑保存、审核冻结语义与 CSDN / 博客园一致。
3. 冻结后创建发布任务，调用 `article_draft/create` 创建草稿，UI 展示草稿链接。
4. 用户确认后单次提交公开，保存 remote_url（文章链接）与 remote_content_id（draft_id）。
5. 掘金线上文章正文 Markdown 格式正确、分类/标签正确。
6. 异常路径（凭据错误、网络失败、公开失败）状态正确且可人工校正。
7. 重复点击创建任务/确认公开不产生重复文章（幂等键验证）。
8. `npm run typecheck` 与 `npm test` 全绿。

## 13. 实现文件清单

| 文件 | 动作 |
|---|---|
| `src/main/accounts/account-repository.ts` | 修改：AccountPlatform 增加 "juejin"，凭据状态 juejinCookieConfigured / juejinAidConfigured / juejinUuidConfigured |
| `src/main/db/database.ts` | 修改：新增 juejin_publish_jobs / juejin_publish_job_events 两表 |
| `src/main/juejin/juejin-client.ts` | 新建：content_api JSON 客户端 |
| `src/main/juejin/juejin-channel-service.ts` | 新建：渠道稿服务 + 状态机 |
| `src/main/server/create-server.ts` | 修改：新增 12 条路由 + 依赖注入 + 平台枚举 |
| `src/renderer/components/JuejinDraftWorkspace.tsx` | 新建：渠道稿工作台 |
| `src/renderer/main.tsx` | 修改：平台枚举 + 入口行 + 凭据弹窗 + 发布记录 + 轮询 |
| `src/main/juejin/juejin-client.test.ts` | 新建：客户端单测（15 tests） |
| `src/main/juejin/juejin-channel-service.test.ts` | 新建：渠道服务单测（14 tests） |
| `spec/02-development-design.md` | 修改：第 10 章掘金列为二期的表述更新为已实现 |
| `spec/01-product-requirements.md` | 修改：目标平台列表补充掘金 |

## 14. 风险与依赖

- content_api 免签名写接口依赖掘金策略不变：若未来写接口加入签名校验，需引入 msToken / a_bogus 计算或降级浏览器路径。
- Cookie 有效期：登录态过期后任务进入 `needs_credentials`，需用户重新复制 Cookie。
- 分类/tag ID 为固定映射：掘金侧分类 ID 变更时需更新 `JUEJIN_CATEGORIES` / `JUEJIN_KNOWN_TAGS`。
- `article/list_by_user` 分页上限 100：文章数量大时 `findDraftId` 可能未命中，可翻页扩展。
*（内容由AI生成，仅供参考）*
