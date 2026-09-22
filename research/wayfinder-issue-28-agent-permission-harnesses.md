# Wayfinder Issue 28：开源 Agent Harness 权限与审批模式

## 结论

开源 harness 的共同做法不是“每次代码执行都询问”，也不是让大模型自行决定是否安全，而是把模型工具调用、策略判断、沙箱执行和用户授权分开：

- 模型提出结构化调用，可附带意图或风险提示；
- 应用侧根据实际工具、参数、路径、网络和副作用计算 `allow`、`ask` 或 `deny`；
- 沙箱/运行器强制执行边界；
- 用户授权通常可以选择一次、当前任务/会话或保存为更窄的项目规则；
- 明确 `deny` 不能被自动模式或模型改写。

## 项目对比

### OpenCode

OpenCode 为权限规则提供 `allow`、`ask` 和 `deny`。规则可以按工具、命令、路径、外部目录和资源模式匹配，并按顺序由更具体的规则覆盖通配规则。询问时可以选择仅本次允许、后续同类请求持续允许或拒绝；自动模式只把原本的 `ask` 转成自动允许，明确 `deny` 仍然有效。

来源：

- https://dev.opencode.ai/docs/permissions/
- https://opencode.ai/v2/docs/permissions

### OpenHands Agent SDK

OpenHands 提供 `AlwaysConfirm`、`NeverConfirm` 和 `ConfirmRisky`。后者通过风险阈值决定是否询问，并可配置未知风险是否确认。风险判断在独立确认策略中完成，而不是由模型直接授予权限。

来源：

- https://github.com/OpenHands/software-agent-sdk/blob/main/openhands-sdk/openhands/sdk/security/confirmation_policy.py

### Goose

Goose 将运行模式明确分成完全自动、每次人工确认、Smart Approval 和仅对话；工具还可以配置始终允许、询问或永不允许。它证明代码执行可以在受信环境中连续自动进行，但也把完全自动模式标为需要用户理解风险的选择。

来源：

- https://github.com/aaif-goose/goose/blob/main/documentation/docs/mcp/developer-mcp.md
- https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/config-files.md

### Cline

Cline 支持按工具配置 `autoApprove`，常见做法是自动放行读文件和搜索，把写文件、命令执行设为需批准；SDK 也允许根据工具的实际输入实现条件批准。它明确警告全量自动批准等价于允许任意 shell、文件修改和网络请求，只适用于沙箱或完全信任环境。

来源：

- https://github.com/cline/cline/blob/main/docs/sdk/guides/permission-handling.mdx
- https://github.com/Cline/Cline

### OpenAI Codex CLI

Codex 将审批策略和沙箱策略分离：受沙箱保护、未被识别为危险且不需要扩大权限的命令可以自动执行；危险命令或需要沙箱外权限时才询问。若配置为永不询问，需要批准的危险动作会被禁止而不是静默执行。

来源：

- https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs
- https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/permissions/approval_policy/on_request_rule_request_permission.md

## 对 ContentFerry 的采用建议

1. 保留现有 `allow / ask / deny` 层次，但把 `confirmed` 从所有执行的硬门槛改成策略结果的一种来源；低风险已授权调用不应重复询问。
2. 将授权建模为带工具、动作、项目、执行目标、目录、网络范围、参数模式和有效期的授权租约。
3. 将“代码执行”拆成实际调用与边界：只读探测、Git 分析、测试和受限 Demo 可以在已授权目标内自动连续执行；依赖安装、删除、敏感读取、外部写入和扩大网络/目录范围进入 `ask` 或 `deny`。
4. 模型可以提交风险标签，但最终风险决策必须由应用侧策略和执行器独立计算。
5. 用户拒绝某个调用后，编排器可以让模型寻找替代路径；替代调用必须重新评估，不能拆分、换名或换执行目标绕过原拒绝。
6. 执行目标属于策略资源维度。若从本机切到 WSL 只做同一授权目录的只读检查，且有效文件、网络和副作用边界没有扩大，可以自动切换；改变边界时才询问。

## 参考决策

该研究支撑路线图 Issue 27 已确认的“协作模式”：低风险已授权调用自动执行，跨越策略边界才询问；模型不拥有权限决定权。
