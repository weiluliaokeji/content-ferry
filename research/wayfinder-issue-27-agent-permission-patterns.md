# Wayfinder Issue 27：智能体工具自动执行与授权模式调研

## 结论摘要

成熟 harness 通常不会要求用户为每一次低风险工具调用单独确认，也不会把最终授权完全交给大模型。更常见的结构是：

1. 模型提出结构化工具调用，并可提供风险提示；
2. 应用侧根据工具、实际参数、资源范围、沙箱状态和持久化策略独立判断 `allow`、`ask` 或 `deny`；
3. 已授权且未越过策略边界的调用自动继续；
4. 只有越过边界、风险未知或需要扩大能力时才请求用户；
5. 明确 `deny` 始终优先，历史授权不能扩大权限。

因此，ContentFerry 不应实现“每次执行都勾选 confirmed”，也不应实现“让模型自己决定是否安全”。更合适的是把一次用户批准转换为有边界的授权规则，让后续同类调用在当前会话或项目范围内自动执行。

## 一手资料对比

### OpenCode

OpenCode 将每个权限解析为 `allow`、`ask` 或 `deny`，支持按工具和实际资源/命令模式匹配；明确 `deny` 不会被自动模式覆盖。用户面对询问时可选择仅本次允许、在当前项目中持续允许，或拒绝本次会话后续请求。它还把外部目录作为独立权限，并提示 shell 仍拥有宿主机文件、进程和网络权限，因此目录推断不能替代窄范围命令规则。

来源：

- https://dev.opencode.ai/docs/permissions/
- https://opencode.ai/v2/docs/permissions

### OpenHands Agent SDK

OpenHands 提供基于风险阈值的 `ConfirmRisky` 策略：高于阈值的动作需要确认，未知风险默认可配置为需要确认；同时保留始终确认和从不确认两种极端策略。这里的核心不是模型自行授予权限，而是独立的风险分类与确认策略。

来源：

- https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/security/confirmation_policy.py

### Goose

Goose 明确提供四种运行模式：完全自动、每次人工确认、智能审批和仅对话。智能审批允许系统根据动作决定哪些需要用户介入；工具还可以配置为始终允许、询问或永不允许。它说明“代码执行不必每次询问”可以作为产品模式，但自动模式必须被视为信任环境能力，而不是普通默认安全边界。

来源：

- https://github.com/aaif-goose/goose/blob/main/documentation/docs/mcp/developer-mcp.md
- https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md

### Cline

Cline 的 SDK 支持按工具配置 `autoApprove`，可以默认自动放行读文件/搜索，而把写文件和命令执行设为需批准；也支持根据工具实际输入实现条件批准。其文档特别警告：全量自动批准意味着模型可以执行任意 shell、修改文件和发起网络请求，只适合沙箱或完全信任环境。

来源：

- https://github.com/cline/cline/blob/main/docs/sdk/guides/permission-handling.mdx
- https://github.com/Cline/Cline

### OpenAI Codex CLI

Codex 将沙箱限制与审批策略分开：非危险且不需要扩大沙箱权限的命令可以直接执行；危险命令或需要越过沙箱边界时才提示。若策略设为不允许询问，原本需要批准的危险操作会被禁止，而不是静默放行。

来源：

- https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs
- https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md

## 对 ContentFerry 的直接启示

### 代码执行不必每次询问，但不能只按“工具名称”判断

建议把“执行代码”拆成实际动作与边界，而不是把 `runtime=python/node/git` 直接视为统一风险：

- 在已选定且可验证的隔离目标中，使用结构化 argv、已授权目录、固定网络策略、资源限制和超时，执行只读探测、测试、Git 状态/历史读取、源码分析等操作，可自动继续；
- 需要切换到本机高风险目标、扩大目录、打开直连网络、写文章目录、安装依赖、删除文件、读取敏感目录、访问凭据或进行外部写入时，暂停并询问；
- 解析失败、风险未知、沙箱不可用或命令组合无法可靠分析时，默认询问或拒绝，不能让模型自行降级绕过；
- 用户一次选择“始终允许”时，应保存为带工具、动作、目标、路径、网络范围和有效期的规则，而不是保存一个无限制的 `confirmed=true`。

### 大模型可以参与风险判断，但只能作为输入

模型可以在工具调用中声明意图和预期副作用，甚至给出风险标签；最终决定必须由应用侧策略、参数解析、路径归一化、沙箱能力和显式拒绝共同决定。这样既能利用模型理解上下文，也不会让模型通过修改风险字段或伪造确认绕过权限。

### 推荐的用户模式

ContentFerry 可以提供三种可见模式：

- **协作模式（推荐默认）**：已授权低风险调用自动执行，策略边界外询问；
- **谨慎模式**：所有会改变文件、运行代码或访问网络的调用都询问；
- **自动模式**：在用户明确选择的隔离目标和授权范围内自动执行，但明确拒绝和高风险外部操作仍不可绕过。

三种模式只改变 `ask` 如何处理，不能覆盖 `deny`、不能扩大目录/网络范围，也不能把正文建议自动应用到已有文章。

## 当前待用户决定的问题

1. 是否采用“协作模式”作为默认，并允许项目级切换到谨慎/自动模式？
2. 哪些本地代码执行场景可列入默认自动放行：只读探测、测试、Git 分析、受限 demo，还是仅限隔离目标？
3. 用户选择“始终允许”时，授权有效期是当前会话、当前项目，还是允许用户显式保存为全局规则？
4. 风险未知时是统一询问，还是对无法安全分析的动作直接拒绝？
5. 初次起草时，工具结果是作为阿文上下文由阿文直接写入新草稿；编辑已有文章时，是否统一转成带证据来源的建议卡，由用户应用？
