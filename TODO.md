# 文渡待开发与优化事项

问题、需求和设计事项统一记录在 GitHub Issues 中。本文件只保留未完成事项的索引，不复制 Issue 的详细范围、验收标准或实现讨论。

## 待处理

- [实现阿文自主实践与正文来源闭环](https://github.com/weiluliaokeji/content-ferry/issues/53)（`ready-for-agent`；起草入口、任务状态、结构化代码工作流和结果上下文已接通；新目标已能并入进行中的工作流，等待授权/恢复/正文建议处理时保留当前选择并排队；手动停止后的新指示会继续同一任务。首稿和编辑阶段保存时可将实践摘要随文章保存；模型只会将直接支持且逐字唯一匹配的段落自动关联，其余来源标待核查；右侧可查看来源状态，段落改写后会重新判断原结论是否仍受支持。来源随文章 assets 保存并过滤本机路径与原始输出，运行条件按白名单写入可分享摘要。实践截图在正文移动后按内容指纹识别新位置，移出正文后保留证据并解除正文关联；正文图裁剪替换与封面裁剪都会保存截图父子指纹；本地 HTML Demo 截图已接入任务临时目录边界与随文来源清单，需完成界面验收。旧版实践计划查看入口已从正文工作区移除，历史数据只作兼容保留；活动视图已改为通俗进度和影响说明，隐藏内部编号与工具名；授权范围优先为本次任务，参数、目录和原始事件按需展开。授权卡高级详情已支持直接调整代码/运行环境、项目内相对文件与网页操作参数；工具、动作和目标固定，主进程校验后仍需明确授权。登录、验证码和受限 SSO 弹窗已接入同一临时隔离会话，真实网站登录接管与弹窗式身份验证仍需 GUI 验收；多次结果并列对照需真实任务界面验收。打包版文章工作区、旧入口移除、空闲“执行活动”入口及其打开本文对话的行为已完成人工检查；活动中的授权卡、截图结果、接管/恢复及重试仍需真实任务界面验收。旧手动面板中可归属文章的 `execution_runs` 已通过备份保护的数据库迁移关联为 `legacy_manual` 待核查历史任务，原始输出、产物、旧实验观察与权限事实保持在旧记录；旧版工具工作流和无法归属文章的运行仍只读展示，旧中断步骤及授权不自动恢复。失败步骤重试入口与整个重试流程单次调用限制已实现；固定本机任务运行器已支持 Scoop `search` 和 `list`；通用 CLI 执行器已接入，阿文可按目标调用已安装命令，参数结构化并由文渡以高风险本机操作请求任务授权，无需为每款软件改代码或重新打包；运行时 MCP 发现尚未开放；语义来源映射现有回归测试覆盖直接支持、部分支持、重复段落、错误索引和模型不可用时保持待核查，仍待真实模型评估）
- [研究资料来源可信度与精确引用](https://github.com/weiluliaokeji/content-ferry/issues/38)（`needs-triage`）
- [补齐 Git 结果应用为文章建议动作](https://github.com/weiluliaokeji/content-ferry/issues/39)（`needs-triage`）
- [高级记忆维护与冲突版本确认](https://github.com/weiluliaokeji/content-ferry/issues/40)（`needs-triage`）
- [Git 源码证据的符号级分析](https://github.com/weiluliaokeji/content-ferry/issues/41)（`needs-triage`）
- [普通 Markdown 内容源入口与 Front Matter 扩展](https://github.com/weiluliaokeji/content-ferry/issues/42)（`needs-triage`）
- [文渡原生微信视频号执行工作流](https://github.com/weiluliaokeji/content-ferry/issues/43)（`needs-triage`、`ready-for-human`）
- [支持自定义视觉连接作为图片初审模型](https://github.com/weiluliaokeji/content-ferry/issues/44)（`needs-triage`）

已完成的阿文工具调用闭环和联网找图事项不再列在这里；对应历史 Issue 可在 GitHub 的已关闭列表中查看。
