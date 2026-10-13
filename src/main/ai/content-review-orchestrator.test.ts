import { describe, expect, it, vi } from "vitest";
import { CONTENT_REVIEW_MAX_ALLOWED_REPAIR_ROUNDS, CONTENT_REVIEW_OUTPUT_SCHEMA, DRAFT_CONTENT_REVIEW_OUTPUT_SCHEMA, ContentReviewOrchestrator, contentReviewOutput, draftContentReviewOutput, type ContentReviewFinding, type ContentReviewResult } from "./content-review-orchestrator";

const blocker: ContentReviewFinding = { severity: "blocker", title: "章节缺少依据", detail: "核心结论没有对应资料。" };

function result(findings: ContentReviewFinding[]): ContentReviewResult {
  return { findings, evidenceUsed: [], summary: findings.length ? "需要修订。" : "可以交给作者确认。", searchQueries: [] };
}

describe("content review orchestration", () => {
  it("keeps every object property required in the strict response schema", () => {
    expectStrictJsonSchema(CONTENT_REVIEW_OUTPUT_SCHEMA);
    expectStrictJsonSchema(DRAFT_CONTENT_REVIEW_OUTPUT_SCHEMA);
    expect(draftContentReviewOutput.parse({
      findings: [], evidenceUsed: [], summary: "通过", searchQueries: [],
      commitmentCoverage: [{ sectionHeading: "安装", commitment: "列出步骤", status: "covered", resolution: "revision", readerOutcome: "读者知道具体运行步骤。", evidenceQuote: "运行命令。" }]
    }).commitmentCoverage).toHaveLength(1);
  });

  it("normalizes missing finding evidence for providers that do not enforce the strict schema", () => {
    const parsed = contentReviewOutput.parse({
      findings: [{ severity: "warning", title: "可补充例子", detail: "当前不是阻断问题。" }],
      evidenceUsed: [], summary: "可交作者确认。", searchQueries: []
    });

    expect(parsed.findings[0].evidence).toEqual([]);
  });

  it("requires a concrete reader outcome for every draft coverage judgment", () => {
    expect(() => draftContentReviewOutput.parse({
      findings: [], evidenceUsed: [], summary: "通过", searchQueries: [],
      commitmentCoverage: [{ sectionHeading: "安装", commitment: "列出步骤", status: "covered", resolution: "revision", evidenceQuote: "运行命令。" }]
    })).toThrow();
  });

  it("does not revise a candidate when the independent review has no blockers", async () => {
    const revise = vi.fn(async () => "unexpected");
    const orchestrator = new ContentReviewOrchestrator({ maxRepairRounds: 3 });

    const outcome = await orchestrator.run({
      initial: async () => "# 提纲\n\n## 已有依据的章节",
      review: async () => result([]),
      revise
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.repairRounds).toBe(0);
    expect(revise).not.toHaveBeenCalled();
  });

  it("emits ordered review and candidate checkpoints after every iteration", async () => {
    const iterations: Array<{ phase: string; markdown: string; repairRounds: number; findingCount: number }> = [];
    const review = vi.fn().mockResolvedValueOnce(result([blocker])).mockResolvedValueOnce(result([]));
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 初稿",
      review,
      revise: async (markdown) => `${markdown}\n\n已补充依据。`,
      onIteration: (iteration) => iterations.push({ phase: iteration.phase, markdown: iteration.markdown,
        repairRounds: iteration.repairRounds, findingCount: iteration.findings.length })
    });

    expect(outcome.status).toBe("passed");
    expect(iterations).toEqual([
      { phase: "reviewed", markdown: "# 初稿", repairRounds: 0, findingCount: 1 },
      { phase: "candidate_revised", markdown: "# 初稿\n\n已补充依据。", repairRounds: 1, findingCount: 1 },
      { phase: "reviewed", markdown: "# 初稿\n\n已补充依据。", repairRounds: 1, findingCount: 0 }
    ]);
  });

  it("does not spend prose-revision rounds on findings that require research or practice", async () => {
    const findings: ContentReviewFinding[] = [
      { severity: "blocker", resolution: "research", title: "缺少官方安装步骤", detail: "需要当前官方来源。" },
      { severity: "warning", resolution: "practice", title: "缺少本篇观察", detail: "需要实际运行结果。" }
    ];
    const revise = vi.fn(async () => "不应调用");
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 候选正文",
      review: async () => result(findings),
      revise
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(0);
    expect(outcome.findings).toEqual(findings);
    expect(outcome.summary).toContain("纯文字改写");
    expect(revise).not.toHaveBeenCalled();
  });

  it("repairs independent editorial findings while retaining unresolved evidence blockers", async () => {
    const researchFinding: ContentReviewFinding = { severity: "blocker", resolution: "research", title: "缺少官方依据", detail: "需要核对官方安装来源。", evidence: ["安装步骤"] };
    const editorialFinding: ContentReviewFinding = { severity: "warning", resolution: "revision", title: "开头没有说明读者痛点", detail: "第一段应直接交代指南解决的问题。", evidence: ["本文介绍 Scoop"] };
    const review = vi.fn().mockResolvedValueOnce(result([researchFinding, editorialFinding])).mockResolvedValueOnce(result([researchFinding]));
    const resolveResearch = vi.fn(async () => null);
    const revise = vi.fn(async (markdown: string, findings: ContentReviewFinding[]) => `${markdown}\n\n已补充具体读者痛点：重装电脑时需要重新配置开发工具。`);

    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# Scoop 指南\n\n本文介绍 Scoop。",
      review,
      resolveResearch,
      revise
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.markdown).toContain("已补充具体读者痛点");
    expect(outcome.findings).toEqual([researchFinding]);
    expect(outcome.repairRounds).toBe(1);
    expect(resolveResearch).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]?.[1]).toEqual([editorialFinding]);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("keeps an evidence blocker pending if the reviewer omits it after a prose-only repair", async () => {
    const researchFinding: ContentReviewFinding = { severity: "blocker", resolution: "practice", title: "缺少本篇观察", detail: "需要授权后取得实际运行结果。", evidence: ["目前没有运行输出"] };
    const editorialFinding: ContentReviewFinding = { severity: "warning", resolution: "revision", title: "操作结果段落不清楚", detail: "把读者可观察到的结果说清楚。", evidence: ["结果见下文"] };
    const review = vi.fn().mockResolvedValueOnce(result([researchFinding, editorialFinding])).mockResolvedValueOnce(result([]));
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 指南\n\n结果见下文。",
      review,
      resolvePractice: async () => null,
      revise: async (markdown) => `${markdown}\n\n已说明如何判断结果。`
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.findings).toEqual([researchFinding]);
    expect(outcome.markdown).toContain("已说明如何判断结果。");
    expect(outcome.repairRounds).toBe(1);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("stops repeated editorial repair when the same mixed evidence review state remains", async () => {
    const researchFinding: ContentReviewFinding = { severity: "blocker", resolution: "research", title: "缺少官方依据", detail: "需要核对官方安装来源。", evidence: ["安装步骤"] };
    const editorialFinding: ContentReviewFinding = { severity: "warning", resolution: "revision", title: "开头没有说明读者痛点", detail: "第一段应直接交代指南解决的问题。", evidence: ["本文介绍 Scoop"] };
    const review = vi.fn(async () => result([researchFinding, editorialFinding]));
    const resolveResearch = vi.fn(async () => null);
    const revise = vi.fn(async (markdown: string) => `${markdown}\n\n增加了痛点说明。`);

    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# Scoop 指南\n\n本文介绍 Scoop。",
      review,
      resolveResearch,
      revise
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(1);
    expect(outcome.markdown).toContain("增加了痛点说明");
    expect(outcome.findings).toEqual([researchFinding, editorialFinding]);
    expect(review).toHaveBeenCalledTimes(2);
    expect(revise).toHaveBeenCalledTimes(1);
    expect(outcome.summary).toContain("没有改善");
  });

  it("rechecks a candidate after checked research changes its prose without spending prose repairs", async () => {
    const researchFinding: ContentReviewFinding = { severity: "blocker", resolution: "research", title: "缺少官方步骤", detail: "需要当前来源。" };
    const review = vi.fn().mockResolvedValueOnce(result([researchFinding])).mockResolvedValueOnce(result([]));
    const resolveResearch = vi.fn(async (markdown: string) => `${markdown}\n\n已核对官方步骤`);
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 初稿", review, revise: async () => { throw new Error("不应花费文字修订轮次"); }, resolveResearch
    });
    expect(outcome.status).toBe("passed");
    expect(outcome.repairRounds).toBe(0);
    expect(review).toHaveBeenCalledTimes(2);
    expect(resolveResearch).toHaveBeenCalledTimes(1);
  });

  it("rechecks unchanged prose once after new research and stops if the same gap remains", async () => {
    const researchFinding: ContentReviewFinding = { severity: "blocker", resolution: "research", title: "缺少来源", detail: "需要核对。" };
    const resolveResearch = vi.fn(async () => "# 初稿");
    const review = vi.fn(async () => result([researchFinding]));
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 初稿", review,
      revise: async () => { throw new Error("不应修订"); }, resolveResearch
    });
    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(0);
    expect(resolveResearch).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("passes unchanged prose only after new checked evidence is independently reviewed", async () => {
    const finding: ContentReviewFinding = { severity: "blocker", resolution: "research", title: "缺少来源", detail: "需要核对。" };
    const review = vi.fn().mockResolvedValueOnce(result([finding])).mockResolvedValueOnce(result([]));
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 初稿", review,
      revise: async () => { throw new Error("不应修订"); }, resolveResearch: async () => "# 初稿" });
    expect(outcome).toMatchObject({ status: "passed", markdown: "# 初稿", repairRounds: 0 });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("resumes review after new authorized practice observation and keeps prose repair budget separate", async () => {
    const practiceFinding: ContentReviewFinding = { severity: "blocker", resolution: "practice", title: "缺少本篇结果", detail: "需要实际运行。" };
    const review = vi.fn().mockResolvedValueOnce(result([practiceFinding])).mockResolvedValueOnce(result([]));
    const resolvePractice = vi.fn(async (markdown: string) => `${markdown}\n\n本机实际观察：命令输出示例`);
    const revise = vi.fn(async () => "不应调用");
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 初稿", review, revise, resolvePractice });
    expect(outcome.status).toBe("passed");
    expect(outcome.repairRounds).toBe(0);
    expect(review).toHaveBeenCalledTimes(2);
    expect(resolvePractice).toHaveBeenCalledTimes(1);
    expect(revise).not.toHaveBeenCalled();
  });

  it("does not approve practice when no new observation changes the candidate", async () => {
    const practiceFinding: ContentReviewFinding = { severity: "blocker", resolution: "practice", title: "缺少观察", detail: "需要本篇实测。" };
    const resolvePractice = vi.fn(async () => null);
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 初稿",
      review: async () => result([practiceFinding]), revise: async () => "不应调用", resolvePractice });
    expect(outcome.status).toBe("needs_author");
    expect(outcome.summary).toContain("未取得新的实际观察");
    expect(resolvePractice).toHaveBeenCalledTimes(1);
  });

  it("rechecks unchanged prose after a new practice observation", async () => {
    const finding: ContentReviewFinding = { severity: "blocker", resolution: "practice", title: "缺少观察", detail: "需要本篇实测。" };
    const review = vi.fn().mockResolvedValueOnce(result([finding])).mockResolvedValueOnce(result([]));
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 初稿", review,
      revise: async () => { throw new Error("不应修订"); }, resolvePractice: async () => "# 初稿" });
    expect(outcome).toMatchObject({ status: "passed", markdown: "# 初稿", repairRounds: 0 });
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("explains that new practice was reviewed but the same gap remains without repeating the operation", async () => {
    const practiceFinding: ContentReviewFinding = { severity: "blocker", resolution: "practice", title: "缺少本机结果", detail: "需要本机执行结果。" };
    const review = vi.fn(async () => result([practiceFinding]));
    const resolvePractice = vi.fn(async () => "# 初稿\n\n本机观察：命令返回两个版本");
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 初稿", review,
      revise: async () => "不应调用", resolvePractice });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.summary).toContain("实践已取得新观察并完成复评");
    expect(resolvePractice).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("explains that new research was reviewed but the same gap remains without repeating the search", async () => {
    const researchFinding: ContentReviewFinding = { severity: "blocker", resolution: "research", title: "缺少官方步骤", detail: "需要当前官方安装命令。" };
    const review = vi.fn(async () => result([researchFinding]));
    const resolveResearch = vi.fn(async () => "# 初稿\n\n已补入新核对资料");
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 初稿", review,
      revise: async () => "不应调用", resolveResearch });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.summary).toContain("补研已取得新资料并完成复评");
    expect(resolveResearch).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("automatically repairs actionable warnings before passing the candidate", async () => {
    const warning: ContentReviewFinding = { severity: "warning", title: "可补充例子", detail: "当前不是阻断问题。" };
    const review = vi.fn()
      .mockResolvedValueOnce(result([warning]))
      .mockResolvedValueOnce(result([]));
    const revise = vi.fn(async (markdown: string, findings: ContentReviewFinding[]) => `${markdown}\n\n## 操作示例：${findings[0].title}`);
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 提纲",
      review,
      revise
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.repairRounds).toBe(1);
    expect(outcome.markdown).toContain("## 操作示例：可补充例子");
    expect(outcome.findings).toEqual([]);
    expect(revise).toHaveBeenCalledWith("# 提纲", [warning], 1);
  });

  it("stops when a prose repair returns the same candidate", async () => {
    const review = vi.fn(async () => result([{ severity: "warning", title: "缺少步骤", detail: "请补充操作步骤。" }]));
    const revise = vi.fn(async (markdown: string) => markdown);
    const outcome = await new ContentReviewOrchestrator().run({ initial: async () => "# 正文", review, revise });
    expect(outcome.status).toBe("needs_author");
    expect(outcome.summary).toContain("没有改变候选内容");
    expect(review).toHaveBeenCalledTimes(1);
    expect(revise).toHaveBeenCalledTimes(1);
  });

  it("automatically repairs a blocker and reviews the revised candidate again", async () => {
    const review = vi.fn()
      .mockResolvedValueOnce(result([blocker]))
      .mockResolvedValueOnce(result([]));
    const revise = vi.fn(async (markdown: string) => `${markdown}\n\n## 补足资料依据`);
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 提纲",
      review,
      revise
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.repairRounds).toBe(1);
    expect(outcome.markdown).toContain("## 补足资料依据");
    expect(review).toHaveBeenCalledTimes(2);
    expect(revise).toHaveBeenCalledWith("# 提纲", [blocker], 1);
  });

  it("feeds a repeated unresolved finding back as a failed prior approach", async () => {
    const repeated = { ...blocker, title: "安装步骤仍不完整", detail: "正文没有给出可执行命令。", evidence: ["先运行安装命令。"] };
    const review = vi.fn()
      .mockResolvedValueOnce(result([repeated]))
      .mockResolvedValueOnce(result([{ ...repeated, evidence: ["正文仍未列出具体命令。"] }]))
      .mockResolvedValueOnce(result([]));
    const revise = vi.fn(async (markdown: string) => `${markdown}\n已补上命令`);
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 安装指南",
      review,
      revise
    });

    expect(outcome.status).toBe("passed");
    expect(revise).toHaveBeenCalledTimes(2);
    expect(revise.mock.calls[0]?.[1]).toEqual([repeated]);
    expect(revise.mock.calls[1]?.[1][0]?.detail).toContain("上一轮自动修订后，独立评审仍报告此问题");
    expect(revise.mock.calls[1]?.[1][0]?.detail).toContain("请从当前正文定位未解决的根因");
    expect(outcome.findings).toEqual([]);
  });

  it("stops after a revision changes unrelated text but the same review state remains", async () => {
    const unchanged = { ...blocker, evidence: ["核心结论没有对应资料。"] };
    const review = vi.fn(async () => result([unchanged]));
    const revise = vi.fn(async (markdown: string) => `${markdown}\n\n增加一段无关背景。`);
    const progress: string[] = [];
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 初稿",
      review,
      revise,
      onProgress: (message) => progress.push(message)
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(2);
    expect(outcome.markdown).toContain("增加一段无关背景。");
    expect(outcome.findings).toEqual([unchanged]);
    expect(outcome.summary).toContain("连续两轮修订后，同一问题仍未解决");
    expect(review).toHaveBeenCalledTimes(3);
    expect(revise).toHaveBeenCalledTimes(2);
    expect(progress.at(-1)).toContain("已停止自动修订");
  });

  it("stops after two unchanged review rounds even when the reviewer rephrases the same evidence-backed finding", async () => {
    const first = { ...blocker, title: "安装入口缺失", detail: "正文没有给出可执行的安装命令。", evidence: ["目前请读者查看官方说明。"] };
    const rephrased = { ...blocker, title: "读者仍无法开始安装", detail: "核心安装步骤依旧被推给外部文档。", evidence: ["目前请读者查看官方说明。"] };
    const review = vi.fn()
      .mockResolvedValueOnce(result([first]))
      .mockResolvedValueOnce(result([rephrased]))
      .mockResolvedValueOnce(result([{ ...rephrased, title: "缺少可照做的入口", detail: "没有提供命令或步骤。" }]))
      .mockResolvedValue(result([]));
    const revise = vi.fn(async (markdown: string, _findings: ContentReviewFinding[], round: number) => `${markdown}\n\n加入泛化背景 ${round}。`);

    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 指南\n\n目前请读者查看官方说明。",
      review,
      revise
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(2);
    expect(review).toHaveBeenCalledTimes(3);
    expect(revise).toHaveBeenCalledTimes(2);
    expect(outcome.summary).toContain("连续两轮修订后，同一问题仍未解决");
  });

  it("treats a blocker downgraded to a warning as review progress before applying the no-progress stop", async () => {
    const blockerFinding = { ...blocker, title: "安装步骤不完整", detail: "读者仍无法按文完成安装。", evidence: ["缺少安装后的验证步骤。"] };
    const warningFinding = { ...blockerFinding, severity: "warning" as const };
    const review = vi.fn()
      .mockResolvedValueOnce(result([blockerFinding]))
      .mockResolvedValueOnce(result([warningFinding]))
      .mockResolvedValueOnce(result([warningFinding]))
      .mockResolvedValueOnce(result([warningFinding]));
    const revise = vi.fn(async (markdown: string, _findings: ContentReviewFinding[], round: number) => `${markdown}\n修订 ${round}`);

    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 安装指南",
      review,
      revise
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(3);
    expect(review).toHaveBeenCalledTimes(4);
    expect(revise).toHaveBeenCalledTimes(3);
    expect(outcome.summary).toContain("连续两轮修订后，同一问题仍未解决");
  });

  it("carries a failed approach forward when the same anchored issue returns under a new title", async () => {
    const firstIssue = { ...blocker, title: "安装入口缺失", detail: "正文没有给出可执行的安装命令。", evidence: ["目前请读者查看官方说明。"] };
    const unrelatedIssue = { ...blocker, title: "目录选择缺少条件", detail: "没有解释何时使用自定义目录。", evidence: ["目录可按需要调整。"] };
    const rephrasedIssue = { ...blocker, title: "核心操作仍留给读者", detail: "读者仍需离开文章寻找安装方法。", evidence: ["目前请读者查看官方说明。"] };
    const review = vi.fn()
      .mockResolvedValueOnce(result([firstIssue, unrelatedIssue]))
      .mockResolvedValueOnce(result([unrelatedIssue]))
      .mockResolvedValueOnce(result([rephrasedIssue]))
      .mockResolvedValueOnce(result([]));
    const revisionFindings: ContentReviewFinding[][] = [];
    const revise = vi.fn(async (markdown: string, findings: ContentReviewFinding[], round: number) => {
      revisionFindings.push(findings);
      return `${markdown}\n修订 ${round}`;
    });

    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 指南\n\n目前请读者查看官方说明。",
      review,
      revise
    });

    expect(outcome.status).toBe("passed");
    expect(revise).toHaveBeenCalledTimes(3);
    expect(revisionFindings[2]?.[0]?.title).toBe(rephrasedIssue.title);
    expect(revisionFindings[2]?.[0]?.detail).toContain("上一轮自动修订后，独立评审仍报告此问题");
    expect(revisionFindings[2]?.[0]?.detail).toContain(firstIssue.detail);
  });

  it("preserves the last candidate and blocks handoff after three unsuccessful repairs", async () => {
    let revision = 0;
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 初稿",
      review: async (_markdown, round) => result([{ ...blocker, evidence: [`第 ${round} 次复核仍未解决。`] }]),
      revise: async (markdown) => `${markdown}\n修订 ${++revision}`
    });

    expect(outcome.status).toBe("needs_author");
    expect(outcome.repairRounds).toBe(3);
    expect(outcome.markdown).toBe("# 初稿\n修订 1\n修订 2\n修订 3");
    expect(outcome.findings).toEqual([{ ...blocker, evidence: ["第 3 次复核仍未解决。"] }]);
  });

  it("allows a specialized workflow to use more than three explicitly configured repairs", async () => {
    let revision = 0;
    const outcome = await new ContentReviewOrchestrator({ maxRepairRounds: 5 }).run({
      initial: async () => "# 初稿",
      review: async (_markdown, round) => round < 4 ? result([{ ...blocker, evidence: [`第 ${round} 次复核。`] }]) : result([]),
      revise: async (markdown) => `${markdown}\n修订 ${++revision}`
    });

    expect(CONTENT_REVIEW_MAX_ALLOWED_REPAIR_ROUNDS).toBe(5);
    expect(outcome.status).toBe("passed");
    expect(outcome.repairRounds).toBe(4);
    expect(outcome.markdown).toBe("# 初稿\n修订 1\n修订 2\n修订 3\n修订 4");
  });

  it("does not treat review failure as approval", async () => {
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => "# 候选提纲",
      review: async () => { throw new Error("评审模型不可用"); },
      revise: async () => "不得被调用"
    });

    expect(outcome.status).toBe("review_failed");
    expect(outcome.markdown).toBe("# 候选提纲");
    expect(outcome.error).toContain("评审模型不可用");
  });

  it("preserves a persisted candidate when a resumed scope revision fails before review", async () => {
    const review = vi.fn();
    const outcome = await new ContentReviewOrchestrator().run({
      initial: async () => { throw new Error("范围修订没有改变候选正文"); },
      fallbackMarkdown: "# 原候选\n\n原有内容",
      review,
      revise: async () => "不得被调用"
    });
    expect(outcome).toMatchObject({ status: "needs_author", markdown: "# 原候选\n\n原有内容", error: "范围修订没有改变候选正文" });
    expect(review).not.toHaveBeenCalled();
  });
});

function expectStrictJsonSchema(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, unknown> | undefined;
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.required as string[])].sort()).toEqual(Object.keys(properties ?? {}).sort());
    for (const property of Object.values(properties ?? {})) expectStrictJsonSchema(property);
  }
  if (schema.type === "array") expectStrictJsonSchema(schema.items);
}
