---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: ede075e5af8053be83d373b168b03696_928fd8e09baa11f1a98a525400f8a581
    ReservedCode1: aGCSJLRnxR87YLRMnFehiEruRhsE02Ip4BdO6Z2qJdeicIbl1nx0IOozeGaRIrIt+iab6zkSPhgce0tPCXt/FDzdtZ0+WCwtqX2b/OHvAz9Y/W7uL/Wj4kor65FnhIGC6IDzGisJRUeNT4aImkaIiMWphkWz8oxag2SQ0ktR4dedxYwR7ddni0/QknM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: ede075e5af8053be83d373b168b03696_928fd8e09baa11f1a98a525400f8a581
    ReservedCode2: aGCSJLRnxR87YLRMnFehiEruRhsE02Ip4BdO6Z2qJdeicIbl1nx0IOozeGaRIrIt+iab6zkSPhgce0tPCXt/FDzdtZ0+WCwtqX2b/OHvAz9Y/W7uL/Wj4kor65FnhIGC6IDzGisJRUeNT4aImkaIiMWphkWz8oxag2SQ0ktR4dedxYwR7ddni0/QknM=
---

# 博客园（Cnblogs）发布实现设计

> 状态：已确认待实现
> 关联文档：`spec/01-product-requirements.md`、`spec/02-development-design.md`（第 10 章 CSDN 渠道发布子流程）
> 参考实现：`src/main/csdn/`（渠道稿链路）、`src/main/wechat/wechat-publishing-service.ts`（API 型发布链路）
> 外部参考：博客园 MetaWeblog API（https://www.cnblogs.com/ningguang-ai/p/19858898）

## 1. 背景与目标

用户已开通博客园站点 `https://www.cnblogs.com/weiluliaokeji`，需要 ContentFerry 支持博客园账号的接入与自动发布，交互形态对齐现有 CSDN 渠道稿工作台。

博客园提供官方 MetaWeblog XML-RPC 接口，可纯 API 直发，无需浏览器自动化。按项目"有稳定官方接口时优先使用接口"的产品不变量，本期采用 API 型发布链路。

### 本期已确认决策

| 决策点 | 结论 |
|---|---|
| 发布模式 | 纯 API 直发（MetaWeblog XML-RPC） |
| 发布确认 | 两段式：创建博客园草稿 → 用户确认 → 公开 |
| 操作范围 | 仅发布新文章；编辑/更新列为二期 |
| 入口形态 | 完整渠道稿工作台（对齐 CSDN） |
| 凭据 | 用户名 + MetaWeblog API Key（用户已生成，可真实端到端验证） |

## 2. 需求范围

### 本期做

- 博客园账号接入：创建账号、配置凭据（用户名 + API Key）、删除账号、凭据状态查询。
- 渠道稿生成：内容库条目生成博客园稿（AI 改写或复制），编辑、审核冻结。
- 两段式发布：创建草稿 → 展示草稿链接 → 用户确认 → 公开。
- 图片处理：本地图片上传博客园图床，封面图置为正文第一张图。
- 发布状态管理与人工校正。
- 软引流拦截（复用 CSDN 的拦截规则）。

### 本期不做

- 编辑/更新已发布文章（数据库预留 `remote_content_id`，二期扩展）。
- 定时发布（`supportsScheduledPublish: false`）。
- 浏览器自动化路径。
- 文章删除。

## 3. 架构设计

### 3.1 分层

```
账号层（复用 AccountRepository + CredentialVault）
  → 渠道稿层（复用 channel_drafts 表 + 新增 CnblogsChannelService）
  → API 客户端层（新增 cnblogs-client.ts）
  → 发布契约层（实现 PlatformPublisherConnector 接口）
  → HTTP API 层（新增 /api/integrations/cnblogs/* 路由）
  → 渲染层（新增 CnblogsDraftWorkspace.tsx）
```

与 CSDN 的差异：无浏览器自动化层，无 IPC 浏览器驱动层（`driveBrowserPublish` 类），发布链路纯 HTTP API。

### 3.2 API 端点与凭据

- 端点：`https://rpc.cnblogs.com/metaweblog/{blogName}`
- blogName 取自站点 URL 末段：`weiluliaokeji`
- 凭据：`username`（博客园登录用户名）、`api_key`（MetaWeblog 专用密钥，后台「设置 → MetaWeblog → 生成新密码」获取，非登录密码）
- 核心方法：
  - `blogger.getUsersBlogs(appKey, username, password)` — 凭据验证与博客信息
  - `metaWeblog.newPost(blogId, username, password, post, publish)` — 创建文章（publish=false 为草稿）
  - `metaWeblog.editPost(postId, username, password, post, publish)` — 更新文章（publish=true 公开）
  - `metaWeblog.newMediaObject(blogId, username, password, mediaObject)` — 上传图片

### 3.3 XML-RPC 客户端

不新增第三方依赖。基于 Node 内置 `fetch` 实现轻量 XML-RPC 客户端：

- `src/main/cnblogs/cnblogs-client.ts`
- 构造 XML 请求体（methodCall + params），解析 XML 响应（fault 或 params）
- 封装方法：`getUsersBlogs` / `newPost` / `editPost` / `newMediaObject`
- 二进制图片经 base64 编码后放入 `<base64>` 节点
- 超时、HTTP 状态码与 XML fault 统一转为 `CnblogsApiError`（携带 faultCode / faultString）

## 4. 数据设计

### 4.1 账号

- `media_accounts` 表复用；`AccountPlatform` 联合类型增加 `"cnblogs"`。
- 凭据复用 `account_credentials(account_id, credential_kind, secret_id)` + `credential_secrets(encrypted_value)`：
  - `credential_kind = "username"` → 博客园用户名
  - `credential_kind = "api_key"` → MetaWeblog API Key
- 凭据一次性接收、永不回显；列表只暴露 `credentialsConfigured` 布尔。
- `external_account_id` 存博客名（如 `weiluliaokeji`），发布时用于拼端点；博客名在配置凭据后通过 `blogger.getUsersBlogs` 从返回的博客 URL 自动提取并写入，用户无需手填。

### 4.2 发布任务表

新增 `cnblogs_publish_jobs`：

```sql
CREATE TABLE IF NOT EXISTS cnblogs_publish_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
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

新增 `cnblogs_publish_job_events`（状态审计，同构 CSDN）：

```sql
CREATE TABLE IF NOT EXISTS cnblogs_publish_job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES cnblogs_publish_jobs(id),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
```

### 4.3 渠道稿

复用平台无关的 `channel_drafts` 表，无需改动。`generation_mode = 'rewrite' | 'source'` 语义与 CSDN 一致。

## 5. 状态机

渠道稿状态（复用现有语义）：

```
draft → approved（审核冻结，冻结后不可改）
```

发布任务状态（`cnblogs_publish_jobs.status`）：

```
createPublishJob → draft_creating
  → newPost(publish=false) 成功 → draft_created（UI 展示草稿链接 + 确认公开按钮）
  → 用户确认 → confirming → editPost(publish=true) 成功 → published（保存回执）
旁路：
  → 凭据缺失/无效 → needs_credentials（引导补凭据后可重试）
  → API/网络异常 → failed（可重试，幂等键防重复）
  → 草稿已创建但公开失败 → needs_manual_reconciliation（人工校正表单）
  → 用户取消 → cancelled
```

- `idempotency_key` UNIQUE：防重复创建/重复公开。
- `status_source = 'system' | 'manual'`：区分系统流转与人工校正。
- 两段式陷阱：`editPost` 是**完全替换**，公开时必须传完整的 post 对象（title/description/categories/mt_keywords/mt_excerpt/mt_allow_comments），由 `draft_created` 阶段缓存完整 payload 保证。

## 6. 图片处理

- 发布前扫描渠道稿 markdown 中的本地图片引用。
- 逐张调用 `newMediaObject` 上传博客园图床，替换为返回的 URL（永久有效）。
- 封面图：博客园封面取正文第一张图；若有封面，将其插入 markdown 文首作为第一张图。
- 单张图片限制 ≤10MB（超出提前报错，不进入上传）。
- 任一张图片上传失败 → 中止发布（`failed` + failedAssets 明细），避免半成品发布。
- 已上传成功的图片 URL 在失败时无需回滚（图床 URL 永久有效，可复用），但任务标记失败并提示重试。

## 7. 分类与标签映射

- 自动注入 `[Markdown]` 分类（博客园 Markdown 识别机制，缺失则正文按 HTML 解析乱版）。
- 标签：渠道稿标签 → `mt_keywords`（逗号分隔）。
- 分类：发布设置提供可选分类输入（追加到 `[Markdown]` 之后），默认空。
- `mt_allow_comments = 1`。

## 8. HTTP API

在 `src/main/server/create-server.ts` 新增路由（对齐现有 `/api/integrations/*` 风格）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/media-accounts` 等 | 账号 CRUD 复用现有路由，无需新增 |
| PUT | `/api/media-accounts/:accountId/credentials/:credentialKind` | 复用：配置 username / api_key |
| GET | `/api/integrations/cnblogs/capabilities/:accountId` | 能力声明 |
| GET | `/api/integrations/cnblogs/channel-drafts` | 渠道稿列表（按账号/项目过滤） |
| POST | `/api/integrations/cnblogs/channel-drafts` | 从项目或文章库生成渠道稿 |
| PUT/DELETE | `/api/integrations/cnblogs/channel-drafts/:draftId` | 编辑/删除渠道稿 |
| POST | `/api/integrations/cnblogs/channel-drafts/:draftId/approve` | 审核冻结 |
| POST | `/api/integrations/cnblogs/channel-drafts/:draftId/jobs` | 创建发布任务（幂等） |
| GET | `/api/integrations/cnblogs/jobs` | 任务列表 |
| GET | `/api/integrations/cnblogs/jobs/:jobId` | 任务详情（含草稿链接） |
| POST | `/api/integrations/cnblogs/jobs/:jobId/confirm` | 用户确认 → 公开（单次提交） |
| POST | `/api/integrations/cnblogs/jobs/:jobId/record-submission` | 保存回执 |
| POST | `/api/integrations/cnblogs/jobs/:jobId/status` | 人工校正 |

依赖注入：`buildServer(..., options)` 增加 `cnblogsChannel` 服务实例（与现有 `csdnBrowserConfirm` 注入模式一致）。

## 9. 渲染层交互

新建 `CnblogsDraftWorkspace.tsx`，复制改造自 `CsdnDraftWorkspace.tsx`：

- 左工具 / 中编辑器（可视化 + Markdown 双模式）/ 右 AI 助手 + 预览 + 发布设置，布局对齐 CSDN。
- 差异点：
  - 去掉浏览器预检/填充相关 UI（无"待你在浏览器确认"步骤）。
  - 发布流程：点"发布到博客园" → 冻结确认 → 创建任务 → 轮询至 `draft_created` → 展示**博客园草稿链接** + "确认公开"按钮 → 确认 → `published` 展示文章链接。
  - 异常状态展示：`needs_credentials` 引导补凭据；`needs_manual_reconciliation` 提供人工校正表单。
- `src/renderer/main.tsx`：平台枚举增加 cnblogs、内容库入口行"生成博客园稿/进入博客园稿"。
- 无新增 preload/IPC 方法（纯 API 型，无浏览器驱动）。

## 10. 错误处理

| 场景 | 处理 |
|---|---|
| 凭据缺失/无效（getUsersBlogs fault） | `needs_credentials`，UI 引导账号管理补凭据 |
| 网络超时/HTTP 错误 | `failed` + 错误信息；用户可重试，幂等键防重复 |
| newPost 成功但 editPost 失败 | `needs_manual_reconciliation`，人工校正 |
| 图片上传失败 | 中止发布，`failed` + failedAssets 明细 |
| 渠道稿内容为空/标题超长 | 创建任务前校验（标题 ≤120，正文 ≤100000，对齐 CSDN 限制） |

## 11. 测试策略

| 层级 | 覆盖 |
|---|---|
| 单元 | XML-RPC 请求构造/响应解析（mock fetch）；fault 与网络异常映射；状态机全流转；幂等键 UNIQUE；图片扫描与 URL 替换；[Markdown] 分类注入 |
| 集成 | mock XML-RPC server 验证 newPost → editPost 链路、完整 post 对象传递 |
| E2E | 使用用户真实凭据：账号配置 → 渠道稿生成 → 创建草稿 → 确认公开 → 博客园线上校验文章与格式 |

## 12. 验收标准

1. 可在账号管理中创建"博客园"账号并配置用户名 + API Key，凭据加密存储、不回显。
2. 内容库条目可生成博客园渠道稿（AI 改写/复制），编辑保存、审核冻结语义与 CSDN 一致。
3. 冻结后创建发布任务，调用 MetaWeblog 创建草稿，UI 展示草稿链接。
4. 用户确认后单次提交公开，保存 remote_url（文章链接）与 remote_content_id（post_id）。
5. 博客园线上文章正文 Markdown 格式正确、图片可访问、分类含 `[Markdown]`。
6. 异常路径（凭据错误、网络失败、公开失败）状态正确且可人工校正。
7. 重复点击创建任务/确认公开不产生重复文章（幂等键验证）。
8. `npm run typecheck` 与 `npm test` 全绿。

## 13. 实现文件清单

| 文件 | 动作 |
|---|---|
| `src/main/accounts/account-repository.ts` | 修改：AccountPlatform 增加 "cnblogs" |
| `src/main/db/database.ts` | 修改：新增两表 |
| `src/main/cnblogs/cnblogs-client.ts` | 新建：XML-RPC 客户端 |
| `src/main/cnblogs/cnblogs-image-uploader.ts` | 新建：图片上传与替换 |
| `src/main/cnblogs/cnblogs-channel-service.ts` | 新建：渠道稿服务 + 状态机 |
| `src/main/server/create-server.ts` | 修改：新增路由 + 依赖注入 |
| `src/renderer/components/CnblogsDraftWorkspace.tsx` | 新建：渠道稿工作台 |
| `src/renderer/main.tsx` | 修改：平台枚举 + 入口行 |
| `spec/01-product-requirements.md` | 修改：需求补充博客园平台条目（或备注） |
| `docs/USER-GUIDE.md` | 修改：博客园账号配置与发布说明 |
| `README.md` | 修改：能力现状更新 |

## 14. 风险与依赖

- 博客园 MetaWeblog 端点稳定性：需真实账号验证；若端点异常走 `needs_manual_reconciliation` 人工兜底。
- XML 解析依赖手写实现：控制在最小方法集，避免过度泛化。
- `editPost` 完全替换陷阱：公开阶段必须传完整 payload（设计已约束）。
- 博客园对 Markdown 的解析行为（[Markdown] 分类）需真实账号 E2E 确认。
*（内容由AI生成，仅供参考）*
