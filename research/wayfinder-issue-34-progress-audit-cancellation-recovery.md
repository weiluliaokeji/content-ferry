# Wayfinder #34：执行进度、审计、取消与恢复语义

## 决策结论

ContentFerry 将“工作流状态”和“单次执行状态”分开持久化：

- **工作流**描述阿文为了完成用户目标如何计划、调用工具、等待授权、重规划和结束。
- **执行尝试**描述某一个具体 Adapter 是否真的启动、产生了什么结果、是否可能留下副作用。
- **执行进度**是由不可变事件投影出的用户可见摘要，不是另一个可以独立修改的事实源。
- **审计记录**记录模型、工具和权限决定之间的关联与原因；运行日志、AI 完整调用审计和证据链各自独立，不互相替代。

应用退出或进程崩溃时，未完成的工作流和执行尝试必须进入可恢复的中断状态，不能显示为成功。恢复默认不重放有副作用的调用；低风险、只读、租约仍有效且结果可安全重复的调用可以在用户启用自动恢复时重新尝试，但必须产生新的 attempt 记录并重新做策略/preflight 检查。

## 两层状态

### 工作流状态

```text
queued
  -> planning
  -> running
  -> waiting_user
  -> replanning
  -> completed
  -> completed_with_warnings
  -> failed
  -> cancel_requested
  -> cancelled
  -> interrupted
```

含义：

- `queued`：已接受请求，尚未开始模型回合。
- `planning`：模型正在形成或更新计划，尚未执行新的工具调用。
- `running`：至少一个计划步骤或工具调用正在推进。
- `waiting_user`：至少一个调用需要授权、人工接管或明确选择；没有未经授权的调用继续执行。
- `replanning`：某个调用被拒绝、失败或目标不可用，阿文正在寻找不绕过策略的替代路径。
- `completed`：用户目标已由模型给出结果，且没有未处理的必要步骤。
- `completed_with_warnings`：有明确标注的缺口、失败分支或部分结果，但仍产出了可用的受限结果。
- `failed`：达到预算/重规划上限、协议不可恢复错误或关键状态无法继续。
- `cancel_requested`：用户已请求停止，正在等待活动调用响应取消。
- `cancelled`：后续工作流已停止；已经产生的运行记录和结果仍可查看。
- `interrupted`：应用退出或崩溃导致最终结果不确定，等待恢复选择；不是成功、失败或取消的别名。

### 执行尝试状态

```text
queued -> waiting_policy -> preflighting -> running
  -> completed
  -> failed | denied | timed_out | output_limit | cancelled | interrupted
```

每次重试都是新的 `attemptId` 和新的执行记录，旧尝试永不覆盖。`denied` 表示 Adapter 没有启动；`interrupted` 表示无法确定 Adapter 是否完成或产生副作用；`cancelled` 只在应用确认调用已停止或调用尚未启动时使用。

## 进度事件

工作流使用追加式事件序列，每个事件至少包含 `eventId`、`workflowId`、可选 `callId`/`attemptId`、单调递增 `sequence`、时间、事件类型和脱敏摘要。建议事件类型为：

```text
workflow_created
plan_updated
call_queued
permission_evaluated
permission_requested
permission_resolved
preflight_started
preflight_completed
call_started
call_progress
call_completed
call_failed
call_denied
replan_started
checkpoint_saved
cancel_requested
cancelled
workflow_completed
workflow_failed
workflow_interrupted
recovery_selected
retry_started
```

事件规则：

- 原始事件追加后不可编辑；更正通过新的事件表达。
- 事件 payload 只保存用户需要的目标摘要、状态、耗时、计数、错误摘要和结果引用；不把完整文章、凭据、授权头或无限制 stdout 放入活动流。
- `call_progress` 是可丢弃的展示事件，最终状态和 checkpoint 事件不可丢失；界面断线后可从最后一个 sequence 重新拉取。
- 进度投影展示“当前步骤、已完成/总数、等待原因、可执行操作”，不把每个内部轮询或子进程细节都暴露给用户。
- 事件中的错误必须区分“工具失败”“权限拒绝”“目标不可用”“用户取消”和“结果不确定”，避免统一显示成“执行失败”。

## 审计分层

### 运行审计

始终保存结构化元数据：工作流/调用/尝试 ID、工具、目标、权限决定、匹配租约、开始结束时间、状态、退出码、资源限制、输出截断标记和产物哈希。它用于诊断与恢复，不保存完整正文或凭据。

### AI 调用审计

继续复用现有 `AiAuditLog` 的用户主动开启语义：只有用户开启“AI 调用审计”时，才保存完整 prompt/response；通过 `correlationId` 关联工作流和模型回合。关闭时仍保留脱敏的运行元数据和失败原因，不能因为关闭完整审计而丢失权限或执行决定。

### 权限审计

每次 `allow/ask/deny` 保存规范化调用、风险输入、匹配租约、决定理由和解决方式。授权响应要记录是 `once`、`task`、`project` 还是 `deny`；拒绝约束必须可关联后续重规划调用。

### 证据审计

证据卡和实验观察只引用执行记录/尝试 ID，不复制成另一份未经验证的输出。运行失败、取消或中断不能进入“已采纳事实”；具体证据边界由 #33 的 provenance 模型负责。

## 取消语义

取消分为“请求”和“已停止”两步：

1. 用户点击取消后，工作流先进入 `cancel_requested`，写入事件并停止调度新的模型回合、工具调用和重规划。
2. 活动 Adapter 收到同一个 `AbortSignal`；执行服务负责终止进程树或调用适配器的取消接口。
3. 所有活动尝试结束后，工作流进入 `cancelled`；已完成的独立调用结果保留，未完成调用按实际结果标记。
4. 如果取消无法确认子进程或外部平台状态，执行尝试标记为 `interrupted`/结果不确定，并向用户提供人工检查，而不是声称已撤销副作用。
5. 对已完成或已取消的工作流重复点击取消是幂等 no-op；不能因为取消请求晚到而覆盖已记录的成功结果。

取消不等于拒绝：拒绝允许编排器规划替代路径，取消则停止该工作流的后续自动动作。用户取消后如要继续，应创建新的恢复/继续操作，不能偷偷在旧工作流中复活。

## 中断恢复与重试

应用启动时：

- 把仍为 `running`/`preflighting` 的执行尝试标记为 `interrupted`，记录应用退出/恢复时间和“结果不确定”原因。
- 把对应工作流标记为 `interrupted`，保留最后一个 checkpoint、已完成调用和待处理授权，不把它直接标记为失败。
- 不自动重放写入、删除、安装、发布、宿主机代码执行或任何可能产生不可逆副作用的调用。
- 对低风险只读调用，只有在租约未过期、目标仍在同一范围、输入相同、工具版本/配置没有发生不允许的变化且用户启用了自动恢复时，才可以自动创建新的 retry attempt；默认仍展示恢复提示。

用户恢复选择：

- **继续工作流**：从最后 checkpoint 继续，仅重建尚未完成的依赖分支；已经完成的调用不重复执行。
- **重试中断调用**：只创建指定调用的新 attempt，重新执行 schema、权限和 preflight；如原调用可能有副作用，先显示不确定性警告。
- **放弃并结束**：工作流变为 `cancelled`/`failed`（以用户选择的语义记录），保留所有运行和审计事件。

恢复和重试必须保留旧 attempt 的输出、错误和产物；不能用最新成功结果覆盖历史失败或中断记录。重试不是自动换目标：目标变化是新的调用请求，必须重新经过 #32 权限矩阵。

## 检查点与幂等

检查点至少包含：当前工作流状态、计划版本、已完成 callId 集合、待授权 callId、拒绝约束、重规划次数、预算消耗和最后事件 sequence。模型上下文可以从检查点和事件重建，不把完整 prompt 当作唯一恢复依据。

调用幂等键为 `workflowId + callId + attemptId`。同一个 attempt 只能产生一次 Adapter 启动记录；恢复时必须生成新 attempt。对外部写入或发布，幂等键还要传给 Adapter（如果目标平台支持），无法保证时必须人工接管。

## 与现有实现的关系

- `ExecutionRepository.recoverInterrupted()` 已有“running -> interrupted”的基础，但后续需要把 workflow、attempt、checkpoint 和事件关联起来，不能只更新执行行。
- `research_tasks`/`research_task_events` 已具备任务状态、取消请求、检查点和心跳的部分模型；工具工作流应复用其状态语义，但不能把研究任务的资料快照表当作通用工具执行记录。
- `AiAuditLog` 继续只负责用户开启后的完整模型请求/响应文件，不承担工作流状态或工具运行恢复。
- `ExecutionService` 的 `AbortSignal` 和进程树终止是 Adapter 级取消能力；工作流取消要在其上增加调度停止、状态确认和不确定结果提示。
- 现有 `execution_runs.started_at` 尚未在 `create()` 中写入，且 `running` 行的恢复说明仍直接要求重新确认；后续实现应补齐启动时间、workflow/attempt 关联和授权租约重评估，而不是简单放宽旧 `confirmed` 检查。

