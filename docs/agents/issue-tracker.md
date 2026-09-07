# 问题跟踪：GitHub

本仓库的问题、需求和设计事项使用 GitHub Issues 管理。技能需要通过 `gh` CLI 读取和写入，不要把 GitHub Issue 与本地临时清单混用。

## 常用操作

- 创建：`gh issue create --title "..." --body "..."`
- 查看：`gh issue view <number> --comments`
- 列出：`gh issue list --state open`
- 评论：`gh issue comment <number> --body "..."`
- 添加/移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

在仓库目录中执行命令时，`gh` 会根据 `git remote -v` 自动识别仓库。

## Pull Request 与 triage

Pull Request 不作为外部需求的 triage 入口。普通需求、缺陷和设计事项先创建或更新 Issue。

## 技能要求发布或读取事项时

- “发布到 issue tracker”：创建 GitHub Issue。
- “获取相关 ticket”：执行 `gh issue view <number> --comments`，同时查看标签和必要的关联评论。

## Wayfinding 约定

如果使用需要路线图的技能：

- 路线图使用一个带 `wayfinder:map` 标签的 GitHub Issue，正文维护 Notes、已解决决策和未决问题。
- 子任务优先使用 GitHub 子 Issue；如果仓库不支持子 Issue，则在路线图正文中维护任务清单，并在子任务正文开头写明 `Part of #<map>`。
- 子任务类型使用 `wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling` 或 `wayfinder:task`。
- 阻塞关系优先使用 GitHub 原生 Issue dependencies；不支持时，在子任务顶部写 `Blocked by: #<n>`。
- 认领任务时先执行 `gh issue edit <n> --add-assignee @me`。
- 解决任务时先评论结论，再关闭 Issue，并把最终上下文指针补回路线图。
