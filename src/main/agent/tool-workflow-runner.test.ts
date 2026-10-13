import { describe, expect, it, vi } from "vitest";
import { ToolRunner } from "./tool-runner";
import { ToolWorkflowRunner, type ModelTurn, type ToolWorkflowCompletionVerificationInput, type ToolWorkflowModelInput } from "./tool-workflow-runner";
import { ToolWorkflowRepository } from "./tool-workflow-repository";
import { openInMemoryDatabase } from "../db/database";

function policy() {
  return {
    projectId: "article-1",
    grants: [],
    defaultAllowReadOnly: true,
    resolveRisk: () => "low" as const
  };
}

describe("tool workflow runner", () => {
  it("runs an in-scope read and then returns the model result", async () => {
    const run = vi.fn(async (input: unknown) => ({ value: input }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: "hello" }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);

    const result = await workflow.start("check", policy());

    expect(result.status).toBe("completed");
    expect(run).toHaveBeenCalledWith("hello", expect.any(Object));
    expect(result.toolResults[0]?.toolId).toBe("echo");
    expect(result.events.some((event) => event.type === "tool_completed")).toBe(true);
    expect(result.events.find((event) => event.type === "workflow_completed")?.message).toContain("已结束本轮并返回答复");
  });

  it("does not rerun a successfully completed identical tool request", async () => {
    const run = vi.fn(async () => ({ stdout: "first observation" }));
    let verificationCount = 0;
    const verifyCompletion = vi.fn(async () => ({
      decision: verificationCount++ === 0 ? "continue" as const : "incomplete" as const,
      reason: "工具观察仍不足以回答目标。",
      nextStep: "检查工具输出是否完整并判断该结果能否回答目标。",
      unresolvedRequirements: verificationCount === 1 ? ["需要给出与目标相关的有效观察。"] : ["当前观察仍未回答目标。"],
      unresolvedRequirementIds: ["R1"],
      evidence: [{ source: "tool" as const, quote: "first observation" }]
    }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: { query: "java" } }] },
      { kind: "final", text: "观察到的内容不足，正在尝试下一种办法。", goalAssessment: "achieved" },
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: { query: "java" } }] },
      { kind: "final", text: "目前证据不足，结论待核查。", goalAssessment: "incomplete" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { ...model, verifyCompletion }, { maxRounds: 4 });

    const result = await workflow.start("统计目标", { ...policy(), requireCompletionVerification: true });

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.events.some((event) => event.type === "tool_duplicate_blocked")).toBe(true);
    expect(result.transcript.some((message) => message.content.includes("相同调用"))).toBe(true);
    expect(result.status).toBe("incomplete");
  });

  it("grounds verifier citations against raw multiline tool output", async () => {
    const rawOutput = "Java packages:\ncorretto11-jdk\ncorretto17-jdk";
    const run = vi.fn(async () => ({ stdout: rawOutput }));
    const verifyCompletion = vi.fn(async (input: { toolResults: Array<{ output: unknown }> }) => {
      expect(input.toolResults).toHaveLength(1);
      return {
        decision: "verified" as const,
        reason: "引用与原始观察一致。",
        evidence: [{ source: "tool" as const, quote: "corretto11-jdk\ncorretto17-jdk" }]
      };
    });
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
      { kind: "final", text: "观察到两个包。", goalAssessment: "achieved" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { ...model, verifyCompletion });

    const result = await workflow.start("列出 Java 包", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.type === "goal_verification_passed")).toBe(true);
  });

  it("accepts literal evidence when only whitespace and line wrapping differ", async () => {
    const run = vi.fn(async () => ({ stdout: "Java packages:\ncorretto11-jdk  corretto17-jdk" }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
      { kind: "final", text: "观察到两个包。", goalAssessment: "achieved" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), {
      ...model,
      async verifyCompletion() {
        return {
          decision: "verified" as const,
          reason: "引用原文一致，只有换行差异。",
          evidence: [{ source: "tool" as const, quote: "corretto11-jdk\ncorretto17-jdk" }]
        };
      }
    });

    const result = await workflow.start("列出 Java 包", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.type === "goal_verification_passed")).toBe(true);
  });

  it("marks a final answer with an unmet goal as completed with warnings", async () => {
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), sequenceModel([
      { kind: "final", text: "本机命令成功启动，但没有返回目标所需的数据。", goalAssessment: "incomplete" }
    ]));

    const result = await workflow.start("统计目标数据", policy());

    expect(result.status).toBe("completed_with_warnings");
    expect(result.warningCount).toBe(1);
    expect(result.events.at(-1)?.message).toContain("目标尚未达成");
  });

  it("preserves rejected candidates and stops after two verifier retries without new observations", async () => {
    const candidates = [
      "候选答复一：这是第一份用于验证未满足要求的完整候选答复。",
      "候选答复二：我根据意见重写了内容，但仍没有说明统计对象到底是什么。",
      "意外的第三轮"
    ];
    let candidateIndex = 0;
    let secondRoundFeedback = "";
    const model = {
      async next(input: ToolWorkflowModelInput): Promise<ModelTurn> {
        if (input.round === 2) secondRoundFeedback = input.transcript.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
        return { kind: "final", text: candidates[candidateIndex++] ?? "unexpected" };
      },
      async verifyCompletion() {
        const round = candidateIndex;
        return {
          decision: "continue" as const,
          reason: "缺少可核实依据。",
          nextStep: "用已观察结果明确说明统计范围。",
          unresolvedRequirements: [round <= 1
            ? "答复没有说明统计对象是本机已安装包，而不是软件源中可用包。"
            : "需要区分当前机器已安装的 Java 包和 bucket 里可安装的 Java 包。"],
          unresolvedRequirementIds: ["R1"],
          recoveryPlan: {
            action: "collect_new_evidence" as const,
            requirementIds: ["R1"],
            nextAction: "读取本机 Scoop 的完整已安装清单并筛选 java 来源",
            expectedResult: "得到每个已安装 Java 包的名称和版本行"
          },
          evidence: []
        };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), model);

    const result = await workflow.start("判断目标", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("incomplete");
    expect(result.round).toBe(2);
    expect(result.transcript.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([
      candidates[0], candidates[1], expect.stringContaining(candidates[1])
    ]);
    expect(result.events.find((event) => event.type === "goal_verification_continued")?.data).toMatchObject({ candidateChars: candidates[0].length, evidenceCount: 0 });
    expect(result.events.some((event) => event.type === "progress" && event.data?.candidateRevision === true)).toBe(true);
    expect(result.events.at(-1)?.message).toContain("核验器没有返回证据引文");
    expect(result.events.at(-1)?.message).toContain("不等同于工具没有取得观察");
    expect(result.events.at(-1)?.message).toContain("上一轮候选答复有实质改动，但核验器仍保留相同未满足要求");
    expect(result.events.at(-1)?.message).toContain("需要区分当前机器已安装的 Java 包");
    expect(result.events.at(-1)?.data).toMatchObject({ noProgressVerifierRejections: 2, evidenceCount: 0, groundedEvidenceCount: 0, ungroundedEvidenceCount: 0 });
    expect(result.events.at(-1)?.data?.candidateChangedSinceLastRejection).toBe(true);
    expect(result.events.at(-1)?.data?.unresolvedRequirementSummary).toBe("需要区分当前机器已安装的 Java 包和 bucket 里可安装的 Java 包。");
    expect(result.transcript.some((message) => message.content.includes("验证器没有给出可核对的证据摘录"))).toBe(true);
    expect(result.transcript.some((message) => message.content.includes("仍未满足的作者要求") && message.content.includes("软件源中可用包"))).toBe(true);
    expect(secondRoundFeedback).toContain("用已观察结果明确说明统计范围");
    expect(secondRoundFeedback).toContain("答复没有说明统计对象是本机已安装包");
    expect(secondRoundFeedback).toContain("引用其中的连续原文");
    expect(secondRoundFeedback).toContain('"action":"collect_new_evidence"');
    expect(secondRoundFeedback).toContain('"expectedResult":"得到每个已安装 Java 包的名称和版本行"');
    expect(result.events.find((event) => event.type === "goal_verification_continued")?.data).toMatchObject({
      recoveryAction: "collect_new_evidence",
      recoveryRequirementIdsJson: '["R1"]'
    });
  });

  it("allows one final evidence-grounded answer repair after two rejections when the candidate materially improves", async () => {
    const observed = "Installed apps:\ncorretto8-jdk 8.502.07.1\ncorretto11-jdk 11.0.32.9.1\ncorretto17-jdk 17.0.20.8.1\ncorretto21-jdk 21.0.12.8.1";
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
      { kind: "final", text: "Scoop 查询完成，电脑上装有一些 Java。", goalAssessment: "achieved" },
      { kind: "final", text: "本机 Scoop 清单列出 corretto8-jdk、corretto11-jdk、corretto17-jdk 和 corretto21-jdk；我还没有说明数量口径。", goalAssessment: "achieved" },
      { kind: "final", text: "本机 Scoop 已安装 4 个 Java JDK：corretto8-jdk、corretto11-jdk、corretto17-jdk 和 corretto21-jdk。这是本机已安装项数量，不代表 bucket 中可安装包总数。", goalAssessment: "achieved" }
    ]);
    let verificationRound = 0;
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", async run() { return { stdout: observed }; } }]), {
      ...model,
      async verifyCompletion() {
        verificationRound += 1;
        return verificationRound < 3
          ? {
            decision: "continue" as const,
            reason: "答复没有明确数量和统计范围。",
            nextStep: "直接依据已观察清单给出数量，并限定为本机已安装项。",
            unresolvedRequirements: ["需要给出本机已安装 Java 包数量并明确统计范围。"],
            unresolvedRequirementIds: ["R1"],
            evidence: []
          }
          : {
            decision: "verified" as const,
            reason: "答复给出数量且限定为本机已安装项。",
            evidence: [{ source: "tool" as const, sourceId: "tool-1", quote: "corretto8-jdk 8.502.07.1" }]
          };
      }
    }, { maxRounds: 5 } );

    const result = await workflow.start("请统计本机 Scoop 已安装的 Java 包数量", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("completed");
    expect(result.round).toBe(4);
    expect(result.finalText).toContain("已安装 4 个 Java JDK");
    expect(result.events.some((event) => event.type === "progress" && event.data?.answerOnlyVerifierGraceUsed === true)).toBe(true);
    expect(result.transcript.some((message) => message.content.includes("唯一一次基于现有观察的额外修答机会"))).toBe(true);
    expect(result.toolResults).toHaveLength(1);
  });

  it("stops after the single existing-observation repair grace is still rejected", async () => {
    const observed = "Observed value: 42.";
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
      { kind: "final", text: "结果已经取得。", goalAssessment: "achieved" },
      { kind: "final", text: "本轮观察的值为 42，但没有明确回答作者要求。", goalAssessment: "achieved" },
      { kind: "final", text: "观察值是 42；这里需要明确解释它如何回答原目标。", goalAssessment: "achieved" },
      { kind: "final", text: "本次工具记录显示值为 42，统计范围仅限本轮观察。", goalAssessment: "achieved" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", async run() { return { stdout: observed }; } }]), {
      ...model,
      async verifyCompletion() {
        return {
          decision: "continue" as const,
          reason: "候选仍未解释该观察与作者目标的关系。",
          nextStep: "对照原始观察补充目标所需解释。",
          unresolvedRequirements: ["需要说明观察结果是否满足作者提出的目标。"],
          unresolvedRequirementIds: ["R1"],
          evidence: [{ source: "tool" as const, sourceId: "tool-1", quote: observed }]
        };
      }
    }, { maxRounds: 8 });

    const result = await workflow.start("根据本机结果说明目标是否完成", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("incomplete");
    expect(result.round).toBe(4);
    expect(result.events.filter((event) => event.type === "progress" && event.data?.answerOnlyVerifierGraceUsed === true)).toHaveLength(1);
    expect(result.events.at(-1)?.message).toContain("已停止自动重试");
    expect(result.finalText).toContain("基于现有观察的额外修答核验仍未通过");
  });

  it("resets the no-progress guard when a revised answer resolves a verifier requirement", async () => {
    const observed = "The package list contains four installed Java packages: corretto8, corretto11, corretto17, corretto21.";
    const firstCandidate = "The local package command returned a result, but the Java package count has not been explained yet.";
    const repairedCandidate = "The local Scoop list shows four installed Java packages: corretto8, corretto11, corretto17, and corretto21. This count describes installed packages only.";
    const finalCandidate = "The current Scoop installation contains four Java packages: corretto8, corretto11, corretto17, and corretto21. This is the installed-package count, not the number available in a bucket.";
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
      { kind: "final", text: firstCandidate, goalAssessment: "achieved" },
      { kind: "final", text: repairedCandidate, goalAssessment: "achieved" },
      { kind: "final", text: finalCandidate, goalAssessment: "achieved" }
    ]);
    let verificationRound = 0;
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", async run() { return { stdout: observed }; } }]), {
      ...model,
      async verifyCompletion() {
        verificationRound += 1;
        return verificationRound < 3
          ? {
            decision: "continue" as const,
            reason: "需要明确统计口径，并区分已安装项与可用项。",
            nextStep: "根据已有清单补充统计范围。",
            unresolvedRequirements: verificationRound === 1
              ? ["需要明确数量", "需要说明统计范围"]
              : ["需要说明统计范围"],
            unresolvedRequirementIds: verificationRound === 1 ? ["R1", "R2"] : ["R2"],
            evidence: [{ source: "tool" as const, quote: "four installed Java packages" }]
          }
          : { decision: "verified" as const, reason: "候选已明确数量和统计范围。", evidence: [{ source: "tool" as const, quote: "four installed Java packages" }] };
      }
    }, { maxRounds: 5 });

    const result = await workflow.start("统计本机已安装的 Java 包数量", {
      ...policy(), requireCompletionVerification: true
    });

    expect(result.status).toBe("completed");
    expect(result.round).toBe(4);
    expect(verificationRound).toBe(3);
    expect(result.events.some((event) => event.type === "progress" && event.data?.candidateRevision === true)).toBe(true);
    expect(result.events.some((event) => event.type === "goal_verification_passed")).toBe(true);
  });

  it("stops when a continue decision omits actionable unresolved requirements", async () => {
    let verificationRound = 0;
    const model = {
      async next(input: ToolWorkflowModelInput): Promise<ModelTurn> {
        return { kind: "final", text: `这是第 ${input.round} 轮经过修改的候选答复，仍需要核实目标要求。`, goalAssessment: "achieved" };
      },
      async verifyCompletion() {
        verificationRound += 1;
        return verificationRound === 1
          ? {
            decision: "continue" as const,
            reason: "候选没有说明统计范围。",
            nextStep: "根据本轮观察明确统计范围。",
            unresolvedRequirements: ["需要明确本机已安装项目的统计范围"],
            unresolvedRequirementIds: ["R1"],
            evidence: []
          }
          : {
            decision: "continue" as const,
            reason: "仍未能确认目标已满足。",
            nextStep: "说明当前证据缺口。",
            unresolvedRequirements: [],
            unresolvedRequirementIds: [],
            evidence: []
          };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), model);

    const result = await workflow.start("统计目标", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("incomplete");
    expect(result.round).toBe(2);
    expect(result.events.find((event) => event.type === "goal_verification_incomplete")?.message)
      .toContain("没有同时提供具体未满足的作者要求和可执行的下一步");
    expect(result.finalText).toContain("没有同时提供具体未满足的作者要求和可执行的下一步");
  });

  it("keeps an incomplete verification incomplete instead of retrying without a reason to replan", async () => {
    let rounds = 0;
    const model = {
      async next(): Promise<ModelTurn> {
        rounds += 1;
        return { kind: "final", text: "已确认当前没有可执行的安全替代步骤，结果待核查。", goalAssessment: "incomplete" };
      },
      async verifyCompletion() {
        return { decision: "incomplete" as const, reason: "本机命令入口不可用，且没有可替代的本机观察。", evidence: [] };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), model);

    const result = await workflow.start("核实本机状态", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("incomplete");
    expect(rounds).toBe(1);
    expect(result.events.find((event) => event.type === "goal_verification_incomplete")?.message)
      .toContain("本机命令入口不可用");
    expect(result.events.some((event) => event.type === "goal_verification_continued")).toBe(false);
  });

  it("repairs an ungrounded verifier quote against the same observation without regenerating the answer", async () => {
    let nextCalls = 0;
    let verificationCalls = 0;
    const model = {
      async next(): Promise<ModelTurn> {
        nextCalls += 1;
        return nextCalls === 1
          ? { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] }
          : { kind: "final", text: "本机清单列出四个 Java 包。", goalAssessment: "achieved" };
      },
      async verifyCompletion(input: ToolWorkflowCompletionVerificationInput) {
        verificationCalls += 1;
        if (verificationCalls === 1) {
          return { decision: "verified" as const, reason: "结果里有四个包名，可直接计数。", evidence: [{ source: "tool" as const, quote: "the output contains four Java packages" }] };
        }
        expect(input.transcript.some((message) => message.content.includes("goal_verification_evidence_repair"))).toBe(true);
        expect(input.transcript.some((message) => message.content.includes("至少一条引文无法在本轮作者请求或原始工具观察中找到连续原文"))).toBe(true);
        return { decision: "verified" as const, reason: "原始清单确实列出四个包。", evidence: [{ source: "tool" as const, quote: "corretto8 corretto11 corretto17 corretto21" }] };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run: async () => ({ stdout: "corretto8 corretto11 corretto17 corretto21" }) }]), model);

    const result = await workflow.start("统计本机 Java 包", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("completed");
    expect(result.round).toBe(2);
    expect(nextCalls).toBe(2);
    expect(verificationCalls).toBe(2);
    expect(result.events.some((event) => event.type === "progress" && event.data?.evidenceRepairAttempt === 1)).toBe(true);
    expect(result.events.some((event) => event.type === "goal_verification_passed")).toBe(true);
  });

  it("replans once after a citation repair fails and can complete from the same observation", async () => {
    let nextCalls = 0;
    let verificationCalls = 0;
    let replanFeedback = "";
    const observed = "corretto8 corretto11 corretto17 corretto21";
    const model = {
      async next(input: ToolWorkflowModelInput): Promise<ModelTurn> {
        nextCalls += 1;
        if (nextCalls === 1) return { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] };
        if (input.round > 2) replanFeedback = input.transcript.filter((message) => message.role === "tool").map((message) => message.content).join("\n");
        return { kind: "final", text: "本机 Scoop 清单列出四个已安装的 Java 包。", goalAssessment: "achieved" };
      },
      async verifyCompletion() {
        verificationCalls += 1;
        return verificationCalls <= 2
          ? { decision: "verified" as const, reason: "结果含有四个 Java 包。", evidence: [] }
          : { decision: "verified" as const, reason: "清单原文支持计数。", evidence: [{ source: "tool" as const, quote: observed }] };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run: async () => ({ stdout: observed }) }]), model, { maxRounds: 4 });

    const result = await workflow.start("统计本机 Scoop 清单中的 Java 包", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("completed");
    expect(result.round).toBe(3);
    expect(nextCalls).toBe(3);
    expect(verificationCalls).toBe(3);
    expect(replanFeedback).toContain("不要重复已完成的调用");
    expect(replanFeedback).toContain("从原始工具观察中选择连续原文");
    expect(result.events.some((event) => event.type === "goal_verification_continued" && event.message.includes("本轮没有标记成功"))).toBe(true);
    expect(result.events.some((event) => event.type === "tool_duplicate_blocked")).toBe(false);
  });

  it("stops after bounded replanning when the verifier still cannot quote evidence", async () => {
    let nextCalls = 0;
    let verificationCalls = 0;
    let repairFeedback = "";
    const model = {
      async next(): Promise<ModelTurn> {
        nextCalls += 1;
        return nextCalls === 1
          ? { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] }
          : { kind: "final", text: "已统计出四个 Java 包。", goalAssessment: "achieved" };
      },
      async verifyCompletion(input: ToolWorkflowCompletionVerificationInput) {
        verificationCalls += 1;
        if (verificationCalls === 2) repairFeedback = input.transcript.map((message) => message.content).join("\n");
        return { decision: "verified" as const, reason: "结果里有四个包名，可直接计数。", evidence: [] };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run: async () => ({ stdout: "corretto8 corretto11 corretto17 corretto21" }) }]), model, { maxRounds: 4 });

    const result = await workflow.start("统计本机 Java 包", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("incomplete");
    expect(result.round).toBe(3);
    expect(nextCalls).toBe(3);
    expect(verificationCalls).toBe(4);
    expect(result.finalText).toContain("经过一次引文修正后仍未通过证据校验");
    expect(result.finalText).toContain("核验器没有返回证据引文");
    expect(result.finalText).toContain("不等同于工具没有取得观察");
    expect(result.events.at(-1)?.message).toContain("核验器经过一次引文修正后仍未通过证据校验");
    expect(result.events.filter((event) => event.type === "goal_verification_continued")).toHaveLength(2);
    expect(result.events.at(-1)?.data).toMatchObject({ noProgressVerifierRejections: 2 });
    expect(repairFeedback).toContain("核验器没有返回任何证据引文");
    expect(repairFeedback).not.toContain("至少一条引文无法从本轮作者请求或原始工具观察中逐字定位");
  });

  it("returns a workflow snapshot immediately while its model turn continues in the background", async () => {
    let release: ((turn: ModelTurn) => void) | undefined;
    const model = { next: () => new Promise<ModelTurn>((resolve) => { release = resolve; }) };
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), model);

    const initial = workflow.startBackground("目标", policy());

    expect(initial.workflowId).toBeTruthy();
    expect(initial.status).toBe("planning");
    expect(initial.events.some((event) => event.type === "model_round_started")).toBe(true);
    release?.({ kind: "final", text: "完成" });
    expect((await workflow.waitForSettled(initial.workflowId)).status).toBe("completed");
  });

  it("allows evidence-free verification only for explicitly bounded decisions", async () => {
    const model = {
      async next(): Promise<ModelTurn> { return { kind: "final", text: "本阶段不需要实践；当前没有需要核实的外部或本机事实。" }; },
      async verifyCompletion() { return { decision: "verified" as const, reason: "这是阶段判断。", evidence: [] }; }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), model);

    const allowed = await workflow.start("起草前判断是否实践", { ...policy(), requireCompletionVerification: true, allowEvidenceFreeCompletion: true });
    const blocked = await workflow.start("检查本机版本", { ...policy(), requireCompletionVerification: true });

    expect(allowed.status).toBe("completed");
    expect(blocked.status).toBe("incomplete");
  });

  it("keeps the candidate and verifier error when the verifier fails", async () => {
    const model = {
      async next(): Promise<ModelTurn> { return { kind: "final", text: "候选答复需保留" }; },
      async verifyCompletion(): Promise<never> { throw new Error("invalid_json_schema"); }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), model);

    const result = await workflow.start("验证目标", { ...policy(), requireCompletionVerification: true });

    expect(result.status).toBe("failed");
    expect(result.transcript).toEqual(expect.arrayContaining([
      { role: "assistant", content: "候选答复需保留" },
      expect.objectContaining({ role: "tool", content: expect.stringContaining("invalid_json_schema") })
    ]));
    expect(result.events.at(-1)?.message).toContain("invalid_json_schema");
  });

  it("defers a proposed tool without executing it, then lets the model respond", async () => {
    const run = vi.fn(async () => ({ value: "ran" }));
    const modelInputs: Array<{ transcript: Array<{ role: string; content: string }> }> = [];
    const model = {
      async next(input: { transcript: Array<{ role: string; content: string }> }): Promise<ModelTurn> {
        modelInputs.push(input);
        return modelInputs.length === 1
          ? { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: "check" }] }
          : { kind: "final", text: "已记录并等待选择" };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);
    const result = await workflow.start("请验证新的目标", {
      ...policy(),
      onToolProposed: async () => ({ practiceTaskId: "task-id", deferMessage: "目标已记录，需先处理当前选择。" })
    });

    expect(result.status).toBe("completed");
    expect(run).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "tool_deferred")).toBe(true);
    expect(modelInputs[1]?.transcript.at(-1)?.content).toContain("需先处理当前选择");
  });

  it("adds a new goal to a workflow waiting on user authorization", async () => {
    const run = vi.fn(async () => ({ value: "authorized" }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "write", target: "workspace/file", input: "write" }] },
      { kind: "final", text: "继续了新增目标" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);
    const waiting = await workflow.start("原始请求", { ...policy(), resolveRisk: () => "high" });
    expect(waiting.status).toBe("waiting_user");
    const updated = workflow.appendUserInstruction(waiting.workflowId, "再验证另一个边界");
    expect(updated.transcript.at(-1)?.content).toContain("再验证另一个边界");

    const completed = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(completed.transcript.some((item) => item.role === "user" && item.content.includes("再验证另一个边界"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("replans instead of executing a model plan generated before a new goal arrived", async () => {
    const run = vi.fn(async () => ({ value: "must not run" }));
    let returnFirstPlan: ((value: ModelTurn) => void) | undefined;
    let workflowId: string | undefined;
    const modelInputs: Array<{ transcript: Array<{ role: string; content: string }> }> = [];
    const model = {
      async next(input: { workflowId: string; transcript: Array<{ role: string; content: string }> }): Promise<ModelTurn> {
        workflowId = input.workflowId;
        modelInputs.push(input);
        if (modelInputs.length === 1) return await new Promise<ModelTurn>((resolve) => { returnFirstPlan = resolve; });
        return { kind: "final", text: "已按新要求重新规划" };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), model);
    const started = workflow.start("原验证", policy());
    await Promise.resolve();
    if (!workflowId) throw new Error("工作流尚未进入模型规划。" );
    workflow.appendUserInstruction(workflowId, "新增边界验证");
    returnFirstPlan?.({ kind: "tool_calls", calls: [{ toolId: "echo", action: "write", input: "old plan" }] });

    const result = await started;
    expect(result.status).toBe("completed");
    expect(run).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "model_plan_superseded")).toBe(true);
    expect(modelInputs[1]?.transcript.at(-1)?.content).toContain("新增边界验证");
  });

  it("pauses before an unapproved call and resumes after a one-run grant", async () => {
    const run = vi.fn(async () => "ok");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: { text: "x" } }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), model);
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });

    expect(waiting.status).toBe("waiting_user");
    expect(run).not.toHaveBeenCalled();
    const completed = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });
    expect(completed.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reuses a task grant for matching calls in the same workflow", async () => {
    const run = vi.fn(async () => "ok");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), model);
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    const completed = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });

    expect(completed.status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not execute a denied call and lets the model replan", async () => {
    const danger = vi.fn(async () => "should-not-run");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "danger", action: "delete", target: "D:/work", input: {} }] },
      { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: "safe" }] },
      { kind: "final", text: "replanned" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([
      { id: "danger", run: danger },
      { id: "echo", run: async (input: unknown) => input }
    ]), model);
    const result = await workflow.start("delete old file", { ...policy(), grants: [{ scope: "global", decision: "deny", toolId: "danger" }] });

    expect(result.status).toBe("completed_with_warnings");
    expect(danger).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "tool_denied")).toBe(true);
  });

  it("rejects direct and nested model-controlled permission fields", async () => {
    const run = vi.fn(async () => "should-not-run");
    const direct = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { next: async () => ({ kind: "tool_calls", confirmed: true, calls: [] }) });
    const nested = new ToolWorkflowRunner(new ToolRunner([{ id: "echo", run }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: { options: { confirmed: true } } }] }) });

    expect((await direct.start("run", policy())).status).toBe("failed");
    expect((await nested.start("run", policy())).status).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not reuse a one-run grant for a later identical call", async () => {
    const run = vi.fn(async () => "ok");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "done" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), model);
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    const secondWaiting = await workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });

    expect(secondWaiting.status).toBe("waiting_user");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("blocks an identical tool request after an empty observation and feeds the reason back to planning", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", target: "host:cli", input: { command: "nvm", args: ["list"] } }] },
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", target: "host:cli", input: { command: "nvm", args: ["list"] } }] },
      { kind: "final", text: "No local result; use another method or report the limitation." }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "cli", run }]), model);

    const result = await workflow.start("list local versions", policy());

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.events.map((event) => event.type)).toContain("tool_duplicate_blocked");
    expect(result.transcript.some((message) => message.content.includes("没有产生可用观察"))).toBe(true);
    expect(result.status).toBe("completed_with_warnings");
  });

  it("returns the known blocker after distinct retries produce no new observations", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "corretto11-jdk\ncorretto17-jdk\ncorretto21-jdk\ncorretto8-jdk" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "" });
    const blocker = "当前没有能截取终端输出并插入文章的工具；Scoop 清单已经取得，但截图要求未完成。";
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", input: { command: "scoop", args: ["list"] } }] },
      { kind: "final", text: JSON.stringify({ reply: "本机列出 4 个 Java 包。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), goalAssessment: "achieved" },
      { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: "terminal screenshot" } }] },
      { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: "capture command window" } }] },
      { kind: "final", text: "不应再调用模型" }
    ]);
    const verifyCompletion = vi.fn(async () => ({ decision: "continue" as const, reason: blocker, nextStep: "查找可用的终端截图能力。", unresolvedRequirements: ["需要把真实终端输出制成截图并插入文章。"], unresolvedRequirementIds: ["R1"], evidence: [{ source: "tool" as const, quote: "corretto11-jdk" }] }));
    const workflow = new ToolWorkflowRunner(new ToolRunner([
      { id: "cli", run },
      { id: "catalog", async run() { return { items: [] }; } }
    ]), { ...model, verifyCompletion }, { maxRounds: 8 });

    const result = await workflow.start("运行 scoop list，统计本机 Java 并截图放入文章", {
      ...policy(), requireCompletionVerification: true
    });

    expect(result.status).toBe("incomplete");
    expect(result.round).toBeLessThan(8);
    expect(result.toolResults[0]?.output).toEqual({ stdout: "corretto11-jdk\ncorretto17-jdk\ncorretto21-jdk\ncorretto8-jdk" });
    expect(result.finalText).toContain("本机列出 4 个 Java 包。");
    expect(result.finalText).toContain(blocker);
    expect(result.events.at(-1)).toMatchObject({ type: "workflow_incomplete", message: expect.stringContaining(blocker) });
  });

  it("keeps the no-progress cutoff across workflow resume", async () => {
    const run = vi.fn(async () => ({ items: [] }));
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: "java" } }] }
    ]);
    const runner = new ToolWorkflowRunner(new ToolRunner([{ id: "catalog", run }]), model);
    const snapshot = {
      workflowId: "workflow-resume-no-progress",
      status: "interrupted" as const,
      round: 1,
      userRequest: "获取可用的 Java 清单",
      transcript: [{ role: "user" as const, content: "获取可用的 Java 清单" }],
      events: [],
      toolResults: [],
      pendingPermission: null,
      finalText: null,
      warningCount: 1,
      consecutiveNoProgressCalls: 1
    };

    const result = await runner.resumeInterrupted(snapshot, policy());

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("incomplete");
    expect(result.consecutiveNoProgressCalls).toBe(2);
    expect(result.finalText).toContain("连续 2 次");
  });

  it("resets the consecutive no-progress counter when the author supplies a new direction", async () => {
    let signalSecondRound: (() => void) | undefined;
    let releaseSecondRound: (() => void) | undefined;
    const secondRoundStarted = new Promise<void>((resolve) => { signalSecondRound = resolve; });
    const waitForDirection = new Promise<void>((resolve) => { releaseSecondRound = resolve; });
    let round = 0;
    let workflowId = "";
    const model = {
      async next(input: { workflowId: string }): Promise<ModelTurn> {
        workflowId = input.workflowId;
        round += 1;
        if (round === 2) {
          signalSecondRound?.();
          await waitForDirection;
        }
        return round <= 3
          ? { kind: "tool_calls", calls: [{ toolId: "catalog", action: "read", input: { query: `attempt-${round}` } }] }
          : { kind: "final", text: "本轮观察仍有限，已如实说明。", goalAssessment: "incomplete" };
      }
    };
    const runner = new ToolWorkflowRunner(new ToolRunner([{ id: "catalog", async run() { return { items: [] }; } }]), model);
    const running = runner.start("查找当前清单", policy());
    await secondRoundStarted;
    expect(workflowId).toBeTruthy();
    runner.appendUserInstruction(workflowId, "改用另一种安全方法查询");
    releaseSecondRound?.();

    const result = await running;

    expect(result.status).toBe("completed_with_warnings");
    expect(result.consecutiveNoProgressCalls).toBe(1);
    expect(result.round).toBe(4);
  });

  it("does not accept request metadata as verified evidence when a tool returned no observation", async () => {
    let verificationCount = 0;
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", input: { command: "nvm", args: ["list"] } }] },
      { kind: "final", text: "There are no Node versions.", goalAssessment: "achieved" },
      { kind: "final", text: "No usable local output was captured; result is unverified.", goalAssessment: "incomplete" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "cli", async run() { return { command: "nvm", args: ["list"], exitCode: 0, stdout: "" }; } }]), {
      ...model,
      verifyCompletion: async () => verificationCount++ === 0
        ? { decision: "verified", reason: "引用了命令字段。", evidence: [{ source: "tool", quote: "nvm" }] }
        : { decision: "incomplete", reason: "观察为空。", evidence: [{ source: "request", quote: "List local Node versions" }] }
    }, { maxRounds: 4 });
    const snapshot = await workflow.start("List local Node versions", {
      ...policy(),
      requireCompletionVerification: true,
      resolveRisk: () => "low",
    });

    expect(verificationCount, JSON.stringify(snapshot)).toBe(3);
    expect(snapshot.status).toBe("incomplete");
    expect(snapshot.events.some((event) => event.type === "progress" && event.data?.evidenceRepairAttempt === 1)).toBe(true);
    expect(snapshot.events.some((event) => event.type === "goal_verification_passed")).toBe(false);
  });

  it("grounds completion against a stable observation reference and exact source text", async () => {
    const model = {
      ...sequenceModel([
        { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
        { kind: "final", text: "本机清单列出 4 个 Java 包。", goalAssessment: "achieved" }
      ]),
      async verifyCompletion() {
        return {
          decision: "verified" as const,
          reason: "候选答复的数量可由本轮清单直接核对。",
          evidence: [{ source: "tool" as const, sourceId: "tool-1", quote: "corretto8-jdk\ncorretto11-jdk\ncorretto17-jdk\ncorretto21-jdk" }]
        };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{
      id: "echo",
      async run() { return { stdout: "corretto8-jdk\ncorretto11-jdk\ncorretto17-jdk\ncorretto21-jdk" }; }
    }]), model);

    const result = await workflow.start("统计本机已安装的 Java 包", {
      ...policy(), requireCompletionVerification: true
    });

    expect(result.status).toBe("completed");
    expect(result.events.find((event) => event.type === "goal_verification_passed")?.data)
      .toMatchObject({ evidenceCount: 1, groundedEvidenceCount: 1 });
  });

  it("repairs a verifier-only stop from saved observations without rerunning tools", async () => {
    const run = vi.fn(async () => "must not execute");
    const model = sequenceModel([
      { kind: "final", text: "本机 Scoop 清单列出 4 个 Java JDK：corretto8-jdk、corretto11-jdk、corretto17-jdk 和 corretto21-jdk。", goalAssessment: "achieved" }
    ]);
    const observed = "corretto8-jdk 8.502.07.1\ncorretto11-jdk 11.0.32.9.1\ncorretto17-jdk 17.0.20.8.1\ncorretto21-jdk 21.0.12.8.1";
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "cli", run }]), {
      ...model,
      async verifyCompletion(input) {
        expect(input.toolResults[0]?.callId).toBe("previous-run-1");
        return {
          decision: "verified" as const,
          reason: "答复列出观察中的四项，并限定为本机已安装包。",
          evidence: [{ source: "tool" as const, sourceId: "tool-1", quote: observed }]
        };
      }
    }, {
      initialTranscript: [
        { role: "assistant", content: "旧候选答复因核验引用问题未能完成。" },
        { role: "tool", content: `cli：${observed}` }
      ],
      initialToolResults: [{ callId: "previous-run-1", toolId: "cli", output: { stdout: observed } }]
    });

    const result = await workflow.start("只基于上次观察修复答复", { ...policy(), requireCompletionVerification: true, reuseObservationsOnly: true });

    expect(result.status).toBe("completed");
    expect(result.toolResults).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "progress" && event.message.includes("不会重新运行工具"))).toBe(true);
  });

  it("blocks a proposed tool call during answer-only recovery and feeds back why", async () => {
    const run = vi.fn(async () => "should not execute");
    const model = sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "cli", action: "read", input: { command: "scoop", args: ["list"] } }] },
      { kind: "final", text: "已有观察不足以回答，因此我保留未完成状态。", goalAssessment: "incomplete" }
    ]);
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "cli", run }]), model);

    const result = await workflow.start("只修复答复", { ...policy(), reuseObservationsOnly: true });

    expect(result.status).toBe("completed_with_warnings");
    expect(run).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === "tool_duplicate_blocked" && event.data?.reason === "reuse_observations_only")).toBe(true);
    expect(result.transcript.some((message) => message.content.includes("本次恢复只允许复用上次保存的观察"))).toBe(true);
  });

  it("keeps verifier source numbering stable when an earlier tool result has no useful observation", async () => {
    const model = {
      ...sequenceModel([
        { kind: "tool_calls", calls: [
          { toolId: "empty", action: "read", input: {} },
          { toolId: "echo", action: "read", input: {} }
        ] },
        { kind: "final", text: "本机清单列出 4 个 Java 包。", goalAssessment: "achieved" }
      ]),
      async verifyCompletion() {
        return {
          decision: "verified" as const,
          reason: "候选答复依据第二条工具观察。",
          evidence: [{ source: "tool" as const, sourceId: "tool-2", quote: "corretto8-jdk\ncorretto11-jdk\ncorretto17-jdk\ncorretto21-jdk" }]
        };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([
      { id: "empty", async run() { return { stdout: "" }; } },
      { id: "echo", async run() { return { stdout: "corretto8-jdk\ncorretto11-jdk\ncorretto17-jdk\ncorretto21-jdk" }; } }
    ]), model);

    const result = await workflow.start("统计本机已安装的 Java 包", {
      ...policy(), requireCompletionVerification: true
    });

    expect(result.status).toBe("completed_with_warnings");
    expect(result.events.find((event) => event.type === "goal_verification_passed")?.data)
      .toMatchObject({ evidenceCount: 1, groundedEvidenceCount: 1 });
  });

  it("does not accept an exact quote attributed to the wrong observation", async () => {
    const model = {
      ...sequenceModel([
        { kind: "tool_calls", calls: [{ toolId: "echo", action: "read", input: {} }] },
        { kind: "final", text: "结果已核实。", goalAssessment: "achieved" },
        { kind: "final", text: "观察记录不足，无法核实。", goalAssessment: "incomplete" }
      ]),
      async verifyCompletion() {
        return { decision: "verified" as const, reason: "看起来有依据。", evidence: [{ source: "tool" as const, sourceId: "tool-2", quote: "实际观察" }] };
      }
    };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{
      id: "echo", async run() { return { stdout: "实际观察" }; }
    }]), model);

    const result = await workflow.start("核实本机观察", {
      ...policy(), requireCompletionVerification: true
    });

    expect(result.status).toBe("incomplete");
    expect(result.events.find((event) => event.type === "workflow_incomplete")?.data)
      .toMatchObject({ groundedEvidenceCount: 0, ungroundedEvidenceCount: 1 });
  });

  it("records safe lifecycle progress with replayable monotonic event cursors", async () => {
    let workflowId = "";
    let continueModel: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const workflow = new ToolWorkflowRunner(new ToolRunner([]), {
      async next(input) {
        workflowId = input.workflowId;
        signalStarted?.();
        input.onProgress?.("已连接模型，开始处理任务…");
        await new Promise<void>((resolve) => { continueModel = resolve; });
        return { kind: "final", text: "done" };
      }
    });
    const running = workflow.start("check", policy());
    await started;
    const received: number[] = [];
    workflow.subscribe(workflowId, (event) => received.push(event.sequence ?? 0));
    continueModel?.();
    const snapshot = await running;

    expect(snapshot.events.some((event) => event.type === "progress" && event.message.includes("已连接模型"))).toBe(true);
    expect(received.length).toBeGreaterThan(0);
    expect(received).toEqual([...received].sort((left, right) => left - right));
  });

  it("does not let callers mutate a live snapshot", async () => {
    const input = { command: "read", nested: { value: 1 } };
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", async run() { return "ok"; } }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", input }] }) });
    const waiting = await workflow.start("run", { ...policy(), defaultAllowReadOnly: false });
    (waiting.pendingPermission?.request.input as typeof input).nested.value = 99;
    waiting.transcript[0].content = "changed";
    waiting.events[0].message = "changed";

    const snapshot = workflow.getSnapshot(waiting.workflowId);
    expect((snapshot.pendingPermission?.request.input as typeof input).nested.value).toBe(1);
    expect(snapshot.transcript[0]?.content).toBe("run");
  });

  it("rejects concurrent permission responses instead of executing twice", async () => {
    let releaseModel: (() => void) | undefined;
    const run = vi.fn(async () => "ok");
    let round = 0;
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), {
      next: async () => {
        round += 1;
        if (round === 1) return { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", input: {} }] };
        return new Promise<ModelTurn>((resolve) => { releaseModel = () => resolve({ kind: "final", text: "done" }); });
      }
    });
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    const first = workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" });
    await Promise.resolve();
    await expect(workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" })).rejects.toThrow();
    releaseModel?.();
    expect((await first).status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels a waiting workflow without invoking the adapter", async () => {
    const run = vi.fn(async () => "should-not-run");
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", input: {} }] }) });
    const waiting = await workflow.start("save", { ...policy(), defaultAllowReadOnly: false });
    expect(workflow.cancel(waiting.workflowId).status).toBe("cancelled");
    expect(run).not.toHaveBeenCalled();
    await expect(workflow.respondToPermission(waiting.workflowId, { decision: "allow", scope: "run" })).rejects.toThrow();
  });

  it("propagates cancellation to a running adapter and does not continue planning", async () => {
    let workflowId = "";
    let adapterStarted: (() => void) | undefined;
    const run = vi.fn(async (_input: unknown, context: { signal?: AbortSignal }) => {
      adapterStarted?.();
      return new Promise<string>((resolve) => context.signal?.addEventListener("abort", () => resolve("stopped"), { once: true }));
    });
    const workflow = new ToolWorkflowRunner(new ToolRunner([{ id: "read", run }]), {
      next: async (input: { workflowId: string }) => {
        workflowId = input.workflowId;
        return { kind: "tool_calls" as const, calls: [{ toolId: "read", action: "read" as const, input: {} }] };
      }
    });
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    const running = workflow.start("read", policy());
    await started;
    expect(workflow.cancel(workflowId).status).toBe("cancel_requested");
    expect((await running).status).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("restores an interrupted pending permission without replaying the tool", async () => {
    const run = vi.fn(async () => "ok");
    const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] }) });
    const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false });
    const second = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "final" as const, text: "done" }) });
    const restored = await second.restoreWaiting({ ...waiting, status: "interrupted" }, { ...policy(), defaultAllowReadOnly: false });

    expect(restored.status).toBe("waiting_user");
    expect(run).not.toHaveBeenCalled();
    expect((await second.respondToPermission(restored.workflowId, { decision: "allow", scope: "run" })).status).toBe("completed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reuses a matching task grant after explicit restart continuation", async () => {
    const run = vi.fn(async () => "ok");
    const database = openInMemoryDatabase();
    try {
      const now = new Date().toISOString();
      database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace", "test", now);
      database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("article-1", "workspace", "task grant recovery", now, now);
      const repository = new ToolWorkflowRepository(database.connection);
      const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
        { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
        { kind: "final", text: "first step done" }
      ]));
      const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });
      const completed = await first.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });
      expect(completed.status).toBe("completed");
      repository.save(completed, { contextKey: "project:article-1", projectId: "article-1", request: { practiceTaskId: "task-id" } });

      // A second application process loads only the durable database snapshot.
      const persisted = repository.require(completed.workflowId).snapshot;
      const snapshot = { ...persisted, status: "interrupted" as const, finalText: null };
      const resumed = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
        { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work/subfile", input: {} }] },
        { kind: "final", text: "resumed" }
      ]));
      const result = await resumed.resumeInterrupted(snapshot, { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });

      expect(result.status).toBe("completed");
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("does not extend a restored task grant beyond its saved target", async () => {
    const run = vi.fn(async () => "ok");
    const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "saved" }
    ]));
    const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });
    const completed = await first.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });
    const snapshot = {
      ...completed,
      status: "interrupted" as const,
      finalText: null,
      pendingPermission: {
        callId: "pending-call",
        request: { toolId: "write-file", action: "write" as const, target: "D:/outside", input: {} },
        permission: { decision: "ask" as const, reason: "需确认", matchedScope: null }
      }
    };
    const resumed = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "final", text: "done" }) });
    const restored = await resumed.restoreWaiting(snapshot, { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });

    expect(restored.status).toBe("waiting_user");
    expect(restored.pendingPermission?.request.target).toBe("D:/outside");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues a matching pending request after the author chooses to resume", async () => {
    const run = vi.fn(async () => "ok");
    const first = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), sequenceModel([
      { kind: "tool_calls", calls: [{ toolId: "write-file", action: "write", target: "D:/work", input: {} }] },
      { kind: "final", text: "saved" }
    ]));
    const waiting = await first.start("save", { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });
    const completed = await first.respondToPermission(waiting.workflowId, { decision: "allow", scope: "task" });
    const snapshot = {
      ...completed,
      status: "interrupted" as const,
      finalText: null,
      pendingPermission: {
        callId: "pending-call",
        request: { toolId: "write-file", action: "write" as const, target: "D:/work/subfile", input: {} },
        permission: { decision: "ask" as const, reason: "需确认", matchedScope: null }
      }
    };
    const resumed = new ToolWorkflowRunner(new ToolRunner([{ id: "write-file", run }]), { next: async () => ({ kind: "final", text: "done" }) });
    const result = await resumed.restoreWaiting(snapshot, { ...policy(), defaultAllowReadOnly: false, practiceTaskId: "task-id" });

    expect(result.status).toBe("completed");
    expect(result.events.some((event) => event.type === "permission_decided" && event.data?.resumed === true)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

function sequenceModel(turns: ModelTurn[]): { next: (input: { round: number }) => Promise<ModelTurn> } {
  let index = 0;
  return {
    async next() {
      const turn = turns[index] ?? turns.at(-1);
      if (!turn) throw new Error("missing test turn");
      index += 1;
      return turn;
    }
  };
}
