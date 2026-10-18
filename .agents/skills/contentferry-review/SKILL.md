---
name: contentferry-review
description: Review ContentFerry PRs, branches, commits or uncommitted changes using REVIEW.md. Preserve Standards and Spec reports and check bugs, security and requirement compliance. Use for code review requests, not product article review or implementation.
---

# 文渡代码评审

1. 读取仓库根目录 `REVIEW.md`、适用 `AGENTS.md`，按政策固定范围与 SHA。未指定范围时先从分支、上游及工作区判断；存在多个合理范围时询问，先完成不依赖范围的规范读取。
2. 读取关联 Issue、相关 spec 与验收标准，追踪差异影响的调用方、测试和恢复路径。需求缺失时标记待确认，继续可判断的检查。
3. 按 REVIEW.md 的 Bugs、Security、Compliance 三轮检查，分别归入 Standards 与 Spec。可用独立子 Agent 时让两个轴独立评审，交接相同的固定差异、政策与依据；不可用时自行完成并说明。安全检查是明确职责。
4. 按政策核实每条发现的位置、触发条件、影响与级别，去重并保留两轴独立结论。通用 `$code-review` 的代码异味建议服从项目政策，不强制报告或扩展为重构任务。本技能可独立执行，不要求安装全局技能。
5. 报告前检查快照是否变化，按 REVIEW.md 输出范围、两轴、验证证据、缺口与逐轴摘要。默认只报告；修复、推送及合并按用户授权另行处理。
