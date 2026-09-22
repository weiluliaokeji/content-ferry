# Wayfinder #31：工具计划到可执行调用的协议与编排边界

## 结论

ContentFerry 采用“模型回合驱动、应用侧编排”的工具调用协议：

1. 模型只能返回结构化的计划更新、工具调用请求或最终文本，不能返回 `confirmed`、授权租约或策略决定。
2. 主进程中的 `ToolWorkflowRunner` 负责把一次阿文请求编排成有界的工作流：驱动模型回合、校验调用、调用统一的 `ToolRunner`、处理 `allow/ask/deny`、把结果反馈给模型并决定继续、暂停、重规划或结束。
3. `ToolRunner` 是单次调用的策略与适配器模块；`ToolWorkflowRunner` 是多回合编排模块。两者不合并，也不让 renderer 或模型直接调用执行适配器。
4. 每次工具调用拥有工作流内唯一的 `callId`，每次工作流拥有 `workflowId` 和 `correlationId`。事件、审计、权限请求、执行记录和模型回合都通过这两个标识关联。
5. 被拒绝的调用不会执行，也不能通过改名、拆分、替换目标或改变执行目标来绕过拒绝。编排器把拒绝作为“当前路径不可用”的事实交给模型，允许模型提出替代路径；替代调用必须重新经过完整策略评估。
6. 执行目标（本机、WSL、Docker、Windows Sandbox）属于调用的资源维度。切换目标等同于产生一个新的调用请求；如果新请求仍在授权租约范围内可以自动执行，否则进入 `ask`。

## 为什么选择这个边界

当前代码已经有两个可复用的 seam：

- `ToolRunner`：对单个结构化调用执行权限评估和 Adapter 分发，返回 `completed`、`waiting_user`、`denied` 或 `failed`。
- `generateWithTools`：在特定联网检索场景中维护供应商消息、tool call 和 tool result 的循环。

第二个模块目前把“供应商协议转换”“循环调度”“工具执行”和“失败后的文本反馈”放在一起，无法自然暂停等待用户授权，也无法让代码执行、Git、联网检索共享同一种工作流语义。新的外部 seam 应放在两者之上：供应商适配器只负责模型回合协议，`ToolWorkflowRunner` 隐藏多回合状态和策略交互，调用方只需提交一次工作流请求并订阅事件。

这使模块足够深：调用方不需要知道 OpenAI-compatible `tool_calls`、Codex 结构化流、权限租约、暂停恢复和重规划的细节；测试可以通过模型回合 Adapter 和工具 Adapter 的内存实现覆盖完整循环。

## 协议对象

以下是逻辑协议，具体 TypeScript 类型可以在实现阶段落到 `src/shared/` 和 `src/main/agent/`；本阶段不直接新增生产类型。

### 工作流输入

```ts
interface ToolWorkflowRequest {
  workflowId: string;
  correlationId: string;
  projectId?: string;
  conversationId?: string;
  articleContext: {
    mode: "new" | "edit";
    articleId?: string;
    sourcePath?: string;
  };
  goal: string;
  initialContext: unknown;
  limits: {
    maxModelTurns: number;
    maxToolCalls: number;
    maxWallTimeMs: number;
  };
}
```

`articleContext` 只描述创作上下文，不授权修改正文。新草稿的结果吸收、已有文章的建议生成以及正式正文写入仍由上层内容模块决定。

### 模型回合输出

模型回合适配器将不同供应商的响应归一化为以下三类之一：

```ts
type AgentModelTurn =
  | { kind: "plan"; plan: ToolPlan; assistantText?: string }
  | { kind: "tool_requests"; requests: ToolRequest[]; assistantText?: string }
  | { kind: "final"; assistantText: string; provenance?: ProvenanceRef[] };

interface ToolRequest {
  callId: string;
  toolId: string;
  input: unknown;
  purpose: string;
  dependsOn?: string[];
  requestedTarget?: string;
  modelRiskHint?: "low" | "medium" | "high";
}
```

约束：

- `input` 必须通过工具注册表中的 schema 校验；不能把任意 shell 文本当作调用协议。
- `purpose` 和 `modelRiskHint` 只用于解释和排序，是模型建议，不是权限依据。
- 模型不得提供 `decision`、`confirmed`、`grant`、`lease` 或“跳过策略”的字段。
- `dependsOn` 只表达调用之间的结果依赖，不表达授权关系。
- `requestedTarget` 不能直接决定本机/WSL/Docker/Sandbox；适配器和策略引擎根据规范化后的真实目标重新评估。

### 工具结果

编排器将 `ToolRunner` 的结果包成工作流结果，并分成“给模型的结果”和“给用户/审计的结果”：

```ts
type WorkflowToolResult =
  | { status: "completed"; callId: string; output: unknown; summary: string }
  | { status: "waiting_user"; callId: string; permission: PermissionPrompt }
  | { status: "denied"; callId: string; reason: string }
  | { status: "failed"; callId: string; error: string };

interface PermissionPrompt {
  action: string;
  target: string;
  sideEffects: string[];
  reason: string;
  choices: Array<"once" | "task" | "project" | "deny">;
}
```

给模型的 `output` 必须有大小上限、敏感信息清理和来源标记；完整 stdout、stderr、文件摘要和哈希只进入执行记录或证据模块，不直接无限制塞回上下文。

## 编排状态机

```text
planning
  -> running                 模型给出合法调用请求，且至少一个调用自动放行
  -> completed               模型给出最终文本且没有待处理调用
  -> failed                  模型回合或协议校验不可恢复失败

running
  -> waiting_user            存在需要授权的调用
  -> replanning              调用被拒绝、失败或目标不可用，需要寻找替代路径
  -> completed               调用结果足够，模型结束本轮
  -> cancelled               用户取消或工作流超时

waiting_user
  -> running                 用户授权后只恢复对应调用/依赖分支
  -> replanning              用户拒绝当前调用
  -> cancelled               用户取消

replanning
  -> running                 模型提出的新调用通过协议和策略检查
  -> waiting_user            新调用跨越授权边界
  -> completed               无需继续调用即可回答
  -> failed                  达到重规划次数或预算上限
```

一次模型回合可以返回多个调用，但调度规则如下：

- 先逐个 schema 校验并逐个做权限决策，再启动任何 Adapter。
- 无依赖且均为 `allow` 的低风险调用可以并发；有依赖的调用必须等待前置结果。
- 一旦某个调用进入 `ask`，只暂停该调用及其下游依赖；其他已经通过策略且与其无依赖的调用可以继续。
- `deny` 不会调用 Adapter。编排器记录拒绝约束后进入 `replanning`，而不是把整个工作流标记为失败。
- 同一个 `callId` 不能重复执行。恢复时必须生成新的执行尝试记录，并重新确认调用仍符合当前策略。
- 工作流必须有最大模型回合数、最大工具调用数和最长墙钟时间；达到上限时以可恢复的 `failed` 结果结束，不静默继续。

## 授权交互

`ask` 产生一个可持久化的待授权事件，事件中展示：工具、动作、规范化目标、主要副作用、原因、预计结果和授权期限。用户可以选择一次、本任务同类、本项目同类或拒绝；具体可选项由 #32 的权限矩阵决定。

授权只改变策略租约，不修改模型消息，也不把“用户曾经允许过”写入模型可自行解释的记忆。用户拒绝后，原调用和等价绕过会进入工作流的拒绝约束集合；替代调用仍需独立评估。

## 与现有模块的迁移关系

1. 保留 `ToolRunner` 的单次调用接口，并补齐工具注册表的输入 schema、结果摘要和取消语义。
2. 把 `configured-model-provider.generateWithTools` 收缩为供应商 Adapter：只负责把模型请求/响应转换为 `AgentModelTurn`，不再直接决定是否执行工具。
3. 新增 `ToolWorkflowRunner`，由它拥有工作流状态、模型回合上限、工具调用调度、待授权恢复和重规划输入。
4. `AwenConversationService` 只消费工作流的最终文本、工具活动和建议/来源引用；它不直接访问 `ExecutionService` 或 `ToolRunner`。
5. `ExecutionService`、`GitSourceService`、联网检索和未来文件读取分别作为 Adapter 接入；执行目标切换通过新的 `ToolRequest` 进入同一策略 seam。
6. `confirmed` 不再作为模型调用协议字段。它可以在兼容旧版人工面板接口时暂时保留，但新的工作流必须使用结构化授权结果；删除硬闸门属于后续实现票据，不在本决策中偷偷改变现有接口。

## 明确留给后续票据的内容

- #32：动作、风险、目标和授权租约的具体 allow/ask/deny 矩阵。
- #33：工具结果、Git 固定版本、文件哈希和正文引用之间的证据模型。
- #34：事件审计、取消、应用重启恢复、重试和用户可见进度。
- #36：编辑器聊天、自动活动流、授权卡片和新稿吸收/已有文章建议的交互。

