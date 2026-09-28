# 阿文智能体设计参考与文渡落地方案

日期：2026-09-26

## 结论

文渡已有单一模型统筹、多轮结构化工具调用、应用侧权限策略、取消/恢复、工具事件记录和结果回填。当前暴露出的 Scoop 问题同时说明专用工具目录不能成为每种软件的接入门槛。无需先引入一个大型智能体框架或多个互相交接的智能体；应让阿文按目标调用已安装 CLI 的通用执行通道，并保留用于边界清晰操作的专用工具。文渡在执行边缘校验结构化参数、显示 Windows 本机影响并请求任务授权。

## 一手资料中的可复用模式

### OpenAI Agents SDK

- [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)：敏感工具调用暂停等待决定；运行状态可序列化并从中断位置恢复。文渡已有授权等待与恢复状态，后续需继续确保恢复不重放不确定的副作用。
- [Guardrails](https://openai.github.io/openai-agents-python/guardrails/)：输入校验发生在实际工具执行边缘，输出也可在返回智能体前校验。文渡应继续让主进程适配器按真实工具和参数实施 schema、目标和副作用检查，不能依赖模型自报的风险级别。
- [Tracing](https://openai.github.io/openai-agents-python/tracing/)：把模型回合、工具调用、授权和自定义事件组织在一次 trace 中。文渡已有本地工作流事件与执行记录，可在此基础上补充每次调用的意图、输入摘要、风险判定、产物引用与失败分类；不得因此把文章和原始日志上传到第三方。
- [Orchestration](https://openai.github.io/openai-agents-python/multi_agent/)：单一经理型智能体可持有工具并组织最终答复；只有确有独立职责、上下文或交接收益时才需要专门智能体。阿文以单一写作统筹为默认，并以任务型工具模块承接检索、执行、网页观察和来源管理。
- [Context](https://openai.github.io/openai-agents-python/context/)：可按单次运行上下文动态暴露工具，但工具是否可见不等于权限已批准。文渡可根据是否有关联项目、可用本机工具、是否处于起草/编辑阶段缩小本轮工具清单；实际权限始终再次由主进程判定。
- [Testing](https://openai.github.io/openai-agents-python/testing/)：用脚本化模型确定性验证工具选择、回合、授权、恢复和异常路径，并把真实模型表现作为单独集成评估。文渡已有结构化工作流测试，应增加代表性任务轨迹和反例集。

### Google Agent Development Kit

- [Agent Runtime Code Execution](https://google.github.io/adk-docs/tools/google-cloud/code-exec-agent-engine/)：多步代码实践使用同一持久沙箱，保留环境状态并回传 stdout/stderr；生命周期可清理。适用于文渡的方向是按任务持久工作区和可追溯产物，但不能默认引入云端执行；文渡一期应优先本地临时工作区，并清楚展示 Windows 本机执行限制。
- [ADK Tools](https://google.github.io/adk-docs/tools/)：工具本身承载明确能力，清晰工具描述帮助模型正确选择。文渡的日常入口应对应作者意图，而不是要求作者登记每款软件或填写 `argv`、PowerShell 等设置。
- [ADK Evaluation](https://google.github.io/adk-docs/evaluate/)：用可复现评估案例检测智能体轨迹和最终结果质量。文渡应验收“何时不实践、何时选工具、拒绝后如何替代、结果如何限定”等行为，而非只测 schema 可解析。

### Anthropic Claude

- [Tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)：工具调用是模型提出的结构化请求，由宿主应用执行并将结果回填；应用应拥有工具实现与执行策略。此模式与文渡现有 `ToolWorkflowRunner` 一致。
- [Prompting best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prompt-templates-and-variables)：若期望主动采取行动，应明说动作默认值；遇到意图不清时先通过可用工具查证，而不是停留在“我不能执行”。阿文提示词应明确要求检查可用能力、区分缺失工具和缺少授权、在失败后重新规划，同时不允许谎称执行。

### DeepSeek Harness

- [DeepSeek Harness Agent Loop](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md)：runtime 循环模型请求、工具执行和持久历史，可组合生命周期扩展。其公开说明也明确列出当前 loop 没有内建轮次预算；调用方需自行通过生命周期扩展取消。
- [DeepSeek Harness Tools](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)：工具参数校验、allow/deny/ask 管线、守卫和执行后检查可放在工具运行时。它提供可复用的执行管线思路，但公开核心文档没有一个对所有任务通用的目标完成裁决器。
- Harness 仓库将自身标为开发预览。文渡可以参考其可组合运行时与扩展点，不应把它等同于普通用户产品，也不能推断它已开箱提供预算、独立验证器或文章写作记忆产品流程。

## 文渡落地原则

1. **作者讲目标，阿文选能力。**普通入口不要求作者手选运行时、命令、参数或工作目录。
2. **目标优先，结构化执行。**作者讲目标，阿文选择已安装的 CLI；命令名与每个参数分开传递，不拼接 shell 文本，也不接受模型给出的 executable 路径或命令解释器。通用本机调用按高风险请求当前任务授权；常见操作可用专用工具定义输入、影响与结果口径。
3. **文渡决定权限。**主进程校验工具实际目标和副作用；低风险只读操作可按既有规则继续，新主机运行、写入、安装、删除和外部提交按范围询问。
4. **闭环到证据。**每次规划、调用、授权、结果、失败、重试和恢复都有本地事件；最终答复经过无工具权限的独立验证回合和运行时引文检查后，才可将目标记为已核验。
5. **按需缩小工具上下文。**只把本轮可用工具交给模型，并将不可用原因（未安装、平台不支持、需授权、执行失败）作为不同结果回填。
6. **质量用轨迹评估。**回归任务覆盖无须实践、应主动实践、工具缺失、授权等待/拒绝、工具失败后替代、相反结果及来源入稿。

## 当前实现与仍需补齐的部分

- 系统工具发现向模型提供当前机器可见的能力线索；未列出的合法命令仍可通过通用 CLI 执行器尝试，无需为每种软件写专用任务目录或重新打包。
- `AwenPracticeCommandRunner` 按命令名和结构化参数调用 CLI，并复用执行记录、任务授权、资源限制和真实结果回填。通用调用按本机高风险处理，当前用户的文件和网络权限仍有效，临时任务目录不是系统级沙箱。命令解释器、整段 shell 文本和 executable 路径不可由模型指定。
- 专用操作目录仍由应用代码维护，适用于要提供更精确参数、影响说明和结果口径的操作。运行时 MCP/本地插件任务发现尚未接入；如接入仍须服从文渡的应用侧权限边界。
- 工作流已有有限回合上限、单轮调用上限和最终答复 schema 修复；当前增加单独完成验证回合、逐字来源检查、验证不通过时重规划，以及“未完成/待核查”终态。该验证回合使用当前配置的同一模型连接，因此是职责分离而非模型供应方独立；需要用本机/网页实测轨迹持续评估其判定质量。

## 验收重点

- 对“统计本机已安装 Java”，验收需要拿到真实 `list` 类命令的清单，并按明确的 `Source`/包名口径统计；名称搜索的空结果不能被当成已安装清单或软件源总量。
- 换成其他软件或 CLI 目标时应走相同通用执行器与完成验证协议，不增加该软件专用的源码目录；无法回答时明确缺失证据和替代路径。
- 对不需要实测的 Markdown 语法起草任务，阿文不调用本机工具，也不生成实践任务。
- 工具需本机运行或可能产生网络/文件影响时，授权说明使用通俗目标和影响；拒绝后不重试等价操作。
- 用脚本化模型验证“无实践直接完成”“无效/空结果继续”“工具证据支撑后通过”“无安全替代时未完成”“验证器故障/预算耗尽不标成功”等轨迹；真实模型和 Windows portable 结果另做集成验收。
- 用多个不同软件的 CLI 目标检验能力发现、授权、真实观察与完成判定通用性；再评估运行时 MCP 发现作为单独扩展。
