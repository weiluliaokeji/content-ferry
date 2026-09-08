# Wayfinder #4：多源研究任务的状态、去重与恢复策略

## 研究范围

本文只冻结写作前多源研究任务的运行语义：联网网页、公开 Git 证据、用户资料、截图和图表作为不同来源步骤进入同一研究任务。Mermaid 和第三方图片的专用素材字段另由后续票据决定。

## 当前实现基线

- `POST /api/content-projects/:projectId/research/generate` 与 `.../research/follow-up` 当前仍在 HTTP SSE 请求内运行模型与检索；请求开始前已创建持久化 `ResearchTask`，并通过任务 ID 写入状态、心跳、检查点和追加事件。SSE 订阅断开不再取消任务，任务会继续完成并保存结果；资料窗口的取消接口仍会在安全的状态回调点停止后续处理并保留已保存资料。
- 研究结果在请求完成时才写入 `content_research_plans` 和 `content_research_sources`。首次研究使用 `save` 替换资料卡，补研使用 `append`，目前按项目内 URL 去重。
- `web-search.ts` 已有 Tavily → Bing RSS → DuckDuckGo 的检索回退链；DuckDuckGo 自身最多尝试 3 次。SSE 订阅断开不会取消任务，任务会继续完成并保存结果；应用启动时会将心跳过期的 `running` 任务重新排队，由单进程恢复器按持久化请求续跑。现阶段仍没有逐来源步骤检查点、暂停/恢复或跨进程 worker/租约。

这些现状说明：下一阶段不能继续把“研究任务”当作一次长 HTTP 请求；SSE 应降级为任务事件订阅，任务本身必须先持久化。

## 冻结的任务模型

### 任务状态

```text
queued → running → waiting_user → running
                 ├→ paused → running
                 ├→ completed
                 ├→ completed_with_warnings
                 ├→ failed (retryable | terminal)
                 └→ cancelled
```

- `queued`：已创建、等待本地 worker 获取。
- `running`：至少一个步骤正在执行。
- `waiting_user`：遇到登录、验证码、来源选择、许可证确认或其他必须由用户处理的门槛；不算失败。
- `paused`：用户主动暂停；不再启动新步骤，已完成资料和检查点保留。
- `completed`：所有必需步骤完成，结果已持久化。
- `completed_with_warnings`：主任务完成，但可选来源/素材失败或存在未核实项；允许进入资料审核，不得把警告隐藏成成功。
- `failed`：任务未完成。必须附 `error_kind`、`failed_step_id`、`retryable` 和最后检查点；可重试错误由用户或策略重新排队。
- `cancelled`：用户明确取消；不再自动推进。

“审核”不是运行状态。任务完成后结果进入 `proposed`，用户选择资料卡/证据并确认后才变为 `accepted`；只有 `accepted` 的资料进入提纲和正文生成上下文。

每个来源步骤单独记录 `planned | running | waiting_user | succeeded | skipped | failed | cancelled`、`attempt`、`provider`、`checkpoint`、`error_kind`、`started_at`、`finished_at`。任务状态由步骤汇总，但人工暂停/取消优先级高于自动汇总。

### 持久化字段与事件

最低模型：

- `research_tasks`：`id`、`project_id`、`request_hash`、`request_json`、`status`、`result_state`、`current_step_id`、`cancel_requested`、`attempt`、`last_checkpoint`、`last_error`（脱敏）、`created_at`、`updated_at`、`last_heartbeat_at`。
- `research_task_steps`：`task_id`、`step_key`、`kind`（web/git/user/screenshot/chart）、规范化输入、`status`、`attempt`、`checkpoint_json`、`result_ref`、错误字段和时间戳。
- `research_task_events`：任务状态变化、步骤开始/完成/等待/失败、用户暂停/恢复/取消、重试和审核决定；事件追加而不是覆盖。
- 资料卡增加 `source_fingerprint`、`content_hash`/`etag`、`task_id` 和 `snapshot_version`。保留现有 `id` 作为兼容标识。

每个检查点与资料写入使用同一 SQLite 事务：先写步骤检查点/资料引用，再写事件和任务更新时间。SQLite 官方文档说明显式事务在错误时可回滚，且单写者约束要求缩短写事务；不要让网络请求处于数据库事务内（[SQLite transactions](https://sqlite.org/lang_transaction.html)）。可用唯一约束 + `ON CONFLICT DO NOTHING/UPDATE` 实现重启幂等（[SQLite UPSERT](https://sqlite.org/lang_upsert.html)）。

## 去重规则

1. Web 来源先规范化 URL：小写 host、移除 fragment、移除已知跟踪参数、统一默认端口和尾部斜杠；再结合响应 `ETag`/`Last-Modified` 或正文 hash 生成版本指纹。URL 相同但内容 hash 不同，创建新 `snapshot_version`，不能静默丢弃更新。
2. Git 来源使用 `canonical_repo_url + commit_sha + path`；同一 commit、同一路径只保留一个 `CodeEvidence`，证据内容用 blob SHA/片段 hash 校验。分支变化创建新快照，不覆盖旧证据。
3. 用户提供的文件、截图和图表以本地文件 hash + 采集版本为指纹。相同 hash 可复用，不同 hash 即使文件名相同也视为新版本。
4. 资料卡稳定 ID 由 `source_fingerprint` 派生或受唯一索引约束；重复任务只合并 `seen_at`、任务引用和新的 claim 映射，不重复插入正文资料。
5. 论点/claim 去重不能只比较文字：必须同时比较标准化表述、证据指纹和 claim 类型。相同文字但不同版本来源应保留两条证据关系，并标记冲突待审。

## 暂停、取消与恢复

- 暂停在步骤边界生效：停止调度新步骤；当前不可中断的单次请求完成或到达安全取消点后写检查点，任务变为 `paused`。恢复从 `last_checkpoint` 继续，不重复已成功步骤。
- 取消设置 `cancel_requested`，向检索、模型、浏览器和 Git worker 传递同一个 `AbortSignal`；Node 官方文档定义 `AbortController` 用于取消 Promise API，监听器应一次性注册并及时移除（[Node AbortController](https://nodejs.org/api/globals.html#class-abortcontroller)）。取消后不删除已保存的资料卡，未完成结果标为 partial，任务最终为 `cancelled`。
- SSE 断开只代表“订阅断开”，不再等同于用户取消；任务继续在后台运行。客户端重新连接时带 `taskId` 和最后事件序号，先读取持久事件，再继续接收增量。
- 应用重启时，`running` 且心跳过期的任务先回到 `queued`，再由恢复器按持久化请求重新执行；同一进程通过 claim 条件更新避免同一 task 并发执行。逐步骤检查点和跨进程租约仍待实现。

## 重试与网络失败

- 可重试：连接重置、DNS/代理暂时失败、超时、HTTP 429/5xx、模型流中断、搜索源反爬切换失败。优先采用 `Retry-After`，否则指数退避 + 抖动；自动重试最多 3 次，之后进入 `failed(retryable)` 等用户操作。
- 不自动重试：URL/参数无效、权限拒绝、明确的验证码/登录等待、许可证未知、schema 永久不匹配、用户取消。这些分别进入 `waiting_user` 或 terminal `failed`。
- 重试只重新执行失败或未完成步骤；已经成功的来源按指纹复用。一个搜索源失败时可以使用现有 provider fallback，但 fallback 过程必须写入步骤事件，不能把来源切换隐藏在一条“成功”日志中。
- 研究结果和失败原因必须脱敏保存；不记录 Cookie、token、完整授权头或整篇用户正文。网络失败保留错误分类、provider、HTTP 状态、请求摘要和恢复动作。
- 缓存键为 `project_id + normalized_input_hash + source_snapshot/version + skill_version + provider_policy`。相同键可复用已完成结果；用户显式“强制刷新”才重新抓取。对支持 ETag 的 HTTP 来源，使用条件请求；GitHub 官方建议用 ETag/Last-Modified 做轮询条件请求，304 不计入主要速率限制（[GitHub API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)）。

## 审阅门槛与现有流程关系

- 首次研究和补研都创建 `ResearchTask`；补研任务继承项目上下文，但只追加新步骤和新资料，不重写已接受资料卡。
- `content_research_sources.selected` 继续作为兼容字段；新模型把它解释为“用户已接受”，默认新卡是 `proposed/selected=0`，用户确认后才置为 1。现有历史资料迁移时保持当前 selected 值。
- `persistResearchConversation` 仍记录“用户补研要求/阿文结果”，但额外关联 `task_id` 和结果版本；编辑器里的阿文会话按时间把这些记录放在正文编辑对话之前。
- 提纲/正文只读取 `selected=1` 且证据状态有效的资料；`completed_with_warnings`、未核实 claim、失效来源必须在资料面板可见。

## 验收标准

1. 关闭 SSE 或重启应用后，研究任务仍可从任务列表恢复；重新连接不会重复抓取已经成功的来源。
2. 用户能暂停、恢复和取消；取消不会删除已获得的资料卡，且不会继续启动新步骤。
3. 网络失败展示 provider、错误类别、当前步骤和重试/切换来源入口；部分成功资料仍可审阅。
4. 相同 URL/commit/文件 hash 的重复研究不会生成重复资料卡；同 URL 内容变化会生成新版本并保留旧版本。
5. 未经用户接受的资料不能进入提纲/正文；文章中的研究结论仍能回到任务、来源版本和证据。

## 参考资料

- 仓库现状：`src/main/server/helpers.ts`、`src/main/server/routes-projects.ts`、`src/main/content/content-research-repository.ts`、`src/main/ai/web-search.ts`、`src/main/db/database.ts`。
- [SQLite Transaction](https://sqlite.org/lang_transaction.html)
- [SQLite UPSERT](https://sqlite.org/lang_upsert.html)
- [Node.js AbortController](https://nodejs.org/api/globals.html#class-abortcontroller)
- [GitHub REST API best practices: conditional requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
