# Wayfinder #33：Git 与本地工具结果的可追溯证据模型

## 决策结论

本地工具结果进入文章资料链时分成三层，不能把执行成功直接等同于事实：

1. **工具结果（Tool Result）**：一次工作流调用的原始输出、摘要、错误和产物索引。它属于工作流运行记录，可供阿文继续推理或重规划，但默认不是资料卡，也不能直接成为正文事实。
2. **实验观察（Experimental Observation）**：作者明确保存的一条有界主张，绑定一个或多个执行记录、目标环境、输入/版本、限制和产物哈希。它只能支持“在这些条件下观察到 X”，状态从 `pending` 开始，作者采纳后才可进入正式写作上下文。
3. **证据卡（Evidence Card）**：围绕可用于文章论证的主张形成的可追溯资料单元，绑定一个或多个具体来源快照或实验观察。证据卡的 `adoptionStatus` 独立于来源是否已抓取、执行是否成功和 AI 是否推荐。

保存实验观察不等于采纳证据；AI 推荐不等于作者采纳；执行记录成功不等于通用事实。

## 证据链

```text
workflow/call
  -> immutable tool result / execution run
  -> experimental observation (optional, user saves)
  -> evidence candidate (pending verification/recommended)
  -> author adoption
  -> claim used by outline/article/fact-check context
```

每一层都保留向前一层的 ID。摘要、合并、重写或跨轮补研只能生成派生记录，不能覆盖原始执行记录、原始主张、来源快照或作者决定。

## 工具结果与执行记录

每次工具调用至少保存：

- `workflowId`、`correlationId`、`callId` 和 Adapter/tool ID；
- 规范化后的输入摘要、目标、执行目标、网络策略和权限决定；敏感参数只保存脱敏摘要或摘要哈希；
- 开始/结束时间、状态、退出码/信号、超时/取消/输出超限标记；
- 有大小上限的 stdout/stderr 摘要；完整输出是否保存由执行记录策略决定；
- 产物相对路径、大小和 SHA-256；
- 结果摘要的生成方式和是否经过模型压缩。

失败、取消、超时、输出超限、目标不可用和非零退出码都可以保留为可诊断的运行记录，但不能创建“已验证事实”的证据卡。工具返回的错误文本也不能直接被模型当作事实来源。

## 实验观察

实验观察的最小领域对象为：

```ts
interface ExperimentalObservation {
  observationId: string;
  projectId: string;
  claim: string;
  boundary: string;
  status: "pending" | "accepted" | "rejected";
  executionRunIds: string[];
  provenance: {
    kind: "local_execution" | "git_snapshot";
    targetType: string;
    runtime: string;
    argv?: string[];
    networkPolicy?: string;
    inputDigest?: string;
    artifactDigests: Array<{ path: string; sha256: string }>;
    git?: GitSnapshotProvenance;
  };
  createdAt: string;
  updatedAt: string;
}
```

`boundary` 是必填的领域事实：例如“仅适用于 Windows 11、Node 版本 X、该 commit 和给定输入”。没有边界的“运行成功”不能成为实验观察。

当前数据库已经有 `experimental_observations` 表和 `pending/accepted/rejected` 状态，但 `addExecutionObservation()` 同时把对应 `content_research_sources` 写成了 `adopted`。这违反“保存不等于采纳”，后续实现必须改为 `pending_verification`/未采纳状态，并由作者单独执行采纳。

## Git 取证

Git 证据不是“某个 staging 目录里当前存在的文件”，而是固定版本的源码快照：

```ts
interface GitSnapshotProvenance {
  repositoryUrl: string;
  commitSha: string;
  requestedRef?: string;
  remoteVerificationRunId: string;
  commitVerificationRunId: string;
  fileSnapshots: Array<{
    path: string;
    lineStart: number;
    lineEnd: number;
    contentSha256: string;
    excerpt: string;
    readRunId: string;
  }>;
}
```

规则如下：

- `commitSha` 是身份主键的一部分；同一仓库不同 commit 必须形成不同快照，不能覆盖旧证据。
- `repositoryUrl` 必须与 staging 仓库的 `origin` 经过规范化比较；不一致时不能生成来源引用。
- 文件路径必须是 commit 内受 Git 跟踪的相对路径，不能是 staging 目录外的路径或符号链接路径。
- 行号范围、摘录上限和内容 SHA-256 必须一起保存。摘录是解释材料，SHA-256 用于发现内容变化，不能只保存摘录文本。
- clone、commit 校验、remote 校验、文件列表和文件读取的执行记录都属于同一取证链；任何关键步骤失败时保留失败运行记录，但不产生可采纳证据。
- URL、commit、路径和行号可生成查看器链接或复制引用，但系统不自动把链接、脚注或归因文字写进公众正文。

当前 `GitAnalysisResult` 已返回 commit SHA、规范化仓库 URL、文件路径、行号范围、摘录、文件 SHA-256 和读取 run ID；后续应把 commit/remote/file runs 作为一组 provenance 持久化，而不是只保留单个执行记录。

## 证据卡与来源类型

现有网页资料卡的 `ResearchEvidence` 适合 URL 快照，但本地工具和 Git 需要统一的来源引用联合类型：

```ts
type EvidenceSourceRef =
  | { kind: "web_snapshot"; sourceId: string; url: string; capturedAt: string; sha256: string }
  | { kind: "git_snapshot"; observationId: string; repositoryUrl: string; commitSha: string; path: string; lineStart: number; lineEnd: number; sha256: string }
  | { kind: "execution_observation"; observationId: string; executionRunIds: string[] }
  | { kind: "manual"; sourceId: string };
```

证据卡保存主张、来源引用、质量理由、时效、边界、证据性质和作者采纳状态。不同证据性质即使支持相同结论，也保留各自的引用关系；网页来源、Git 源码和本地实验不能因为文字相似而静默合并。

合并资料卡时必须合并来源引用和采纳历史；拆分资料卡时每张卡只能留下与其主张对应的引用。跨来源类型合并应默认禁止，除非用户明确创建一个同时包含多个来源引用的综合主张。

## 创作中的使用规则

- 新草稿：工作流可以直接把工具结果用于生成草稿，但每个可验证主张必须携带内部 provenance 映射；这不自动创建已采纳证据卡。
- 编辑已有文章：工具结果进入阿文对话，转化为建议；用户决定是否应用，应用也不等于采纳证据。
- 保存为实验观察：进入 `pending`，展示执行条件、目标、commit/输入和边界；用户可以采纳、拒绝或留待核验。
- 只有作者采纳的证据主张才能进入提纲、正文事实检查或正式证据上下文。正式正文仍不自动插入链接、脚注或归因文字。
- 当源码、执行环境或输入发生变化时，旧引用保持指向旧快照，系统应提示需要重新求证，而不是更新原卡内容。

## 后续实现切分

- #34：把工作流事件、取消/恢复、重试和多次执行尝试完整关联到证据链。
- #36：把执行活动、临时结果、保存实验观察和证据采纳设计成编辑器内可理解的交互。
- 实现票据：修正 `addExecutionObservation()` 的自动 `adopted` 状态；扩展 provenance 联合类型；为 Git 分析持久化多 run 取证链；补充旧数据迁移和引用失效检查。

