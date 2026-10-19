# 编码 Agent 人工审批门

本规范管理开发阶段的编码 Agent。文渡应用内的文章发布、真实数据库恢复、账号操作继续遵循产品 spec 和业务接口授权，不由本地 Codex hook 代替。

## 审批责任

| 动作 | 执行前条件 | 执行入口 |
| --- | --- | --- |
| 结束测试保护 | 基线未改变，维护者核对当前提交和工作区，交互批准 | Codex 外的终端 `npm run fix:end` |
| 发布安装包 | 构建与启动验证通过，批准指定运行的候选包 | GitHub Environment `release-production` |
| 修改治理配置 | 维护者审阅目的、影响、失败行为和验证结果 | PR review；CODEOWNERS 路由给维护者 |
| 真实内容、数据库、平台副作用 | 产品规定的对象、范围与人工确认 | 应用/API 业务入口，沿用现有设计 |

普通读取、编辑产品代码、运行隔离测试与生成本地安装包无需增加批准。

## 测试保护解锁

1. Agent 完成修复并运行 `npm run fix:verify`，报告基线、修改、测试结果及解锁原因。
2. 维护者另开终端进入同一 worktree，运行 `npm run fix:end`。该命令先验证基线，显示 HEAD 和工作区范围指纹，再询问维护者名称、原因（`completed` 或 `test-correction`）以及完整 `UNLOCK <指纹>`。
3. 非交互、管道输入或检测到 Agent/CI 会话时拒绝解锁。确认期间基线、HEAD、暂存、未暂存或非忽略未跟踪文件变化时拒绝，重新运行后确认新范围。忽略目录与 Git 元数据不作为产品差异计算。
4. 确认后再次验证测试未变，先写入批准记录，再清除该 worktree 的保护标记。没有预先批准文件或环境变量开关。错误输入或取消保持保护开启；终端异常退出后重新执行即可。
5. 若原测试有误，先在测试仍与基线一致时按 `test-correction` 解锁，再单独修订测试并确认仍能检测原缺陷，建立新基线。不得以已改坏测试为由绕过 `fix:verify`。

本地批准人是维护者填写的声明，并非经过独立身份认证。TTY、环境检测、shell 文本识别和仓库内脚本都可以被具有同等文件权限的进程绕过；它们减少误操作，不构成抵御恶意同权限进程的安全边界。需要强制组织治理时，应由管理员部署不可由开发者修改的托管 hook 和脚本，并在服务端限制权限。

## 发布门禁

`release-windows.yml` 分为构建和发布两个 job：构建只持有读取权限；发布 job 使用 `release-production` 环境并持有 Release 写权限。

- 环境的唯一 Required reviewer 为 `weiluliaokeji`，禁止管理员绕过。当前单人维护允许发起人本人审批；这表示明确的人工作出决定，不是双人审批。以后增加维护者再启用防止自审。
- 构建开始前检查环境配置；缺失或审批人变化时失败。完整 `dist:win` 流程成功后，将安装包、blockmap 和 SHA256SUMS 保存为候选 artifact，附 `release-manifest.json`，绑定 tag、提交、运行 ID、运行次数及逐文件 SHA-256。
- 维护者在本次 Actions 运行中下载候选 artifact，核对版本、提交、验证结果、清单与安装包，再通过 Review deployments 批准。发布 job 只下载构建输出的 artifact ID，不重新构建。
- 发布前重新检查环境、运行审批记录、tag 指向与全部文件哈希；先创建 Release 草稿，确认远端资产摘要匹配，再公开。已有 Release 或草稿不会被自动覆盖；上传中途失败留下草稿，由维护者核对和处置。
- 运行次数必须匹配。失败后不要仅重跑发布 job 来复用旧候选；选择重新运行整个 workflow，生成新候选并重新审批。拒绝过的运行应以同一版本 tag 手动创建新运行（例如 `gh workflow run release-windows.yml --ref v0.3.3`，替换为实际 tag）；手动选择分支会明确失败。候选 artifact 保留 14 天，过期后重建并重新批准。
- 本地 `approval-gates.mjs` 对常见 tag 推送、Release 写入和调整发布审批的命令返回 deny，说明上述执行路径；读取与本地构建放行。它不是 shell 解释器，间接脚本、HTTP、浏览器和其他工具仍可能绕过，最终权限需靠 GitHub 管理。

环境配置变更和 GitHub Actions 审批记录由 GitHub 保存。仓库管理员仍能更改环境或 workflow；限制这种能力需要组织级权限及规则，不由仓库脚本保证。

## 审计与治理配置

当前 worktree 的 Git 管理目录下，`contentferry-gate-audit.jsonl` 保存测试保护开启、保护期工具判定、解锁批准及解锁结果，以及发布 hook 的拒绝事件。字段包含 UTC 时间、规则 ID、allow/deny、可用时的工具调用 ID、基线/HEAD 和范围指纹。批准包含本地声明的维护者、原因码和一次性编号。完整命令、工具参数、文章正文及凭据不写入日志。

本地审计不提交、不提供防篡改保证，也不自动删除。linked worktree 各自记录；删除 worktree 前由维护者按保留需求归档。审计无法写入时前置 gate 拒绝执行；PostToolUse 只报告已发生的副作用，不自动回滚。

`.github/CODEOWNERS` 为 AGENTS、REVIEW、`.agents/`、`.codex/`、workflow 及审批脚本声明维护者。评审这些路径时，检查是否削弱保护、扩大自动批准、记录敏感信息或把模型判断当成人工授权。CODEOWNERS 本身不强制阻止合并；单人仓库不配置“必须由同一个所有者批准自己的 PR”的死锁门禁。强制人审应在具备其他评审人的分支规则中配置。

Codex hook 定义修改后，需要重新 review/trust；在此之前不能宣称本机会话已受新 gate 保护。`PreToolUse` 使用 deny；不使用目前不支持的 ask。真实治理要求管理员策略、GitHub 权限与业务接口共同执行。

## 验证范围

`npm run fix:test` 覆盖非交互拒绝、基线保持、交互批准校验、脱敏审计、发布环境/批准记录及候选文件篡改。`npm run eval:agent:test` 与 `npm run eval:agent -- --prepare-only` 检查夹具兼容性，不证明实际会话加载 hook 或远程发布门已演练。

实际发布前，提交本次 workflow，运行一次候选构建，确认未批准时发布 job 等待；下载核验后由维护者批准，再核对 Release 清单。这会产生真实安装包发布，需要单独安排，不能以本地单测代替。
