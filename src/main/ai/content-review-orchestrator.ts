import { z } from "zod";

export const CONTENT_REVIEW_MAX_REPAIR_ROUNDS = 3;
export const CONTENT_REVIEW_MAX_ALLOWED_REPAIR_ROUNDS = 5;

export interface ContentReviewFinding {
  severity: "blocker" | "warning";
  resolution?: "research" | "practice" | "revision" | "scope_decision";
  title: string;
  detail: string;
  evidence?: string[];
}

export interface ContentReviewResult {
  findings: ContentReviewFinding[];
  evidenceUsed: string[];
  summary: string;
  searchQueries: string[];
}

export interface DraftCommitmentCoverage {
  sectionHeading: string;
  commitment: string;
  status: "covered" | "partial" | "missing";
  resolution: "research" | "practice" | "revision" | "scope_decision";
  /** Concrete result the current section gives the reader, not a restatement of its heading. */
  readerOutcome: string;
  evidenceQuote: string;
}

export interface OutlineSectionCoverage {
  heading: string;
  readerQuestion: string;
  sectionRole: string;
  keyContentElements: string[];
  status: "sufficient" | "underspecified";
  assessment: string;
  evidenceQuote: string;
}

export interface OutlineBriefAlignment {
  requestedDeliverable: string;
  readerOutcome: string;
  supportingSections: string[];
  status: "aligned" | "misaligned";
  assessment: string;
  evidenceQuote: string;
}

export interface ContentReviewOutcome {
  status: "passed" | "needs_author" | "review_failed";
  markdown: string;
  findings: ContentReviewFinding[];
  evidenceUsed: string[];
  summary: string;
  repairRounds: number;
  error?: string;
}

export interface ContentReviewRunOptions {
  signal?: AbortSignal;
  initial: () => Promise<string>;
  /** Previously persisted candidate to preserve if a resumed initial revision fails. */
  fallbackMarkdown?: string | (() => string);
  review: (markdown: string, repairRound: number) => Promise<ContentReviewResult>;
  revise: (markdown: string, findings: ContentReviewFinding[], repairRound: number) => Promise<string>;
  /** Acquires checked evidence and revises the affected prose without spending a prose-only repair round. */
  resolveResearch?: (markdown: string, findings: ContentReviewFinding[], evidenceRound: number) => Promise<string | null>;
  /** Performs an authorized practice task and revises prose only after new observations exist. */
  resolvePractice?: (markdown: string, findings: ContentReviewFinding[], evidenceRound: number) => Promise<string | null>;
  /** Persists the current candidate and a compact audit record after each review/revision boundary. */
  onIteration?: (iteration: ContentReviewIteration) => void | Promise<void>;
  onProgress?: (message: string) => void;
}

export interface ContentReviewIteration {
  phase: "reviewed" | "candidate_revised";
  markdown: string;
  findings: ContentReviewFinding[];
  summary: string;
  repairRounds: number;
  evidenceRounds: number;
  status?: "passed" | "needs_author" | "review_failed";
}

export const contentReviewOutput = z.object({
  findings: z.array(z.object({
    severity: z.enum(["blocker", "warning"]),
    resolution: z.enum(["research", "practice", "revision", "scope_decision"]).default("revision"),
    title: z.string().min(1),
    detail: z.string().min(1),
    // Older/non-strict providers may omit evidence; normalize it while keeping
    // the strict provider contract explicit and required.
    evidence: z.array(z.string()).default([])
  }).strict()),
  evidenceUsed: z.array(z.string()),
  summary: z.string(),
  searchQueries: z.array(z.string().trim().min(2).max(240)).max(3)
}).strict();

export const draftContentReviewOutput = contentReviewOutput.extend({
  commitmentCoverage: z.array(z.object({
    sectionHeading: z.string().min(1),
    commitment: z.string().min(1),
    status: z.enum(["covered", "partial", "missing"]),
    resolution: z.enum(["research", "practice", "revision", "scope_decision"]),
    readerOutcome: z.string().trim().min(1).max(500),
    evidenceQuote: z.string()
  }).strict()).max(120)
}).strict();

export const outlineContentReviewOutput = contentReviewOutput.extend({
  briefAlignment: z.object({
    requestedDeliverable: z.string().trim().min(1).max(500),
    readerOutcome: z.string().trim().min(1).max(500),
    supportingSections: z.array(z.string().trim().min(1).max(160)).max(20),
    status: z.enum(["aligned", "misaligned"]),
    assessment: z.string().trim().min(1).max(800),
    evidenceQuote: z.string().max(800)
  }).strict(),
  sectionCoverage: z.array(z.object({
    heading: z.string().trim().min(1).max(160),
    readerQuestion: z.string().trim().min(1).max(400),
    sectionRole: z.string().trim().min(1).max(400),
    keyContentElements: z.array(z.string().trim().min(1).max(400)).max(12),
    status: z.enum(["sufficient", "underspecified"]),
    assessment: z.string().trim().min(1).max(600),
    evidenceQuote: z.string().max(600)
  }).strict()).max(60)
}).strict();

export const CONTENT_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: { type: "array", items: { type: "object", properties: {
      severity: { type: "string", enum: ["blocker", "warning"] },
      resolution: { type: "string", enum: ["research", "practice", "revision", "scope_decision"] },
      title: { type: "string" }, detail: { type: "string" }, evidence: { type: "array", items: { type: "string" } }
    }, required: ["severity", "resolution", "title", "detail", "evidence"], additionalProperties: false } },
    evidenceUsed: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    searchQueries: { type: "array", maxItems: 3, items: { type: "string" } }
  },
  required: ["findings", "evidenceUsed", "summary", "searchQueries"],
  additionalProperties: false
} as const;

export const DRAFT_CONTENT_REVIEW_OUTPUT_SCHEMA = {
  ...CONTENT_REVIEW_OUTPUT_SCHEMA,
  properties: {
    ...CONTENT_REVIEW_OUTPUT_SCHEMA.properties,
    commitmentCoverage: { type: "array", maxItems: 120, items: { type: "object", properties: {
      sectionHeading: { type: "string" }, commitment: { type: "string" },
      status: { type: "string", enum: ["covered", "partial", "missing"] },
      resolution: { type: "string", enum: ["research", "practice", "revision", "scope_decision"] },
      readerOutcome: { type: "string" },
      evidenceQuote: { type: "string" }
    }, required: ["sectionHeading", "commitment", "status", "resolution", "readerOutcome", "evidenceQuote"], additionalProperties: false } }
  },
  required: [...CONTENT_REVIEW_OUTPUT_SCHEMA.required, "commitmentCoverage"]
} as const;

export const OUTLINE_CONTENT_REVIEW_OUTPUT_SCHEMA = {
  ...CONTENT_REVIEW_OUTPUT_SCHEMA,
  properties: {
    ...CONTENT_REVIEW_OUTPUT_SCHEMA.properties,
    briefAlignment: { type: "object", properties: {
      requestedDeliverable: { type: "string" }, readerOutcome: { type: "string" },
      supportingSections: { type: "array", maxItems: 20, items: { type: "string" } },
      status: { type: "string", enum: ["aligned", "misaligned"] },
      assessment: { type: "string" }, evidenceQuote: { type: "string" }
    }, required: ["requestedDeliverable", "readerOutcome", "supportingSections", "status", "assessment", "evidenceQuote"], additionalProperties: false },
    sectionCoverage: { type: "array", maxItems: 60, items: { type: "object", properties: {
      heading: { type: "string" }, readerQuestion: { type: "string" }, sectionRole: { type: "string" },
      keyContentElements: { type: "array", maxItems: 12, items: { type: "string" } },
      status: { type: "string", enum: ["sufficient", "underspecified"] },
      assessment: { type: "string" }, evidenceQuote: { type: "string" }
    }, required: ["heading", "readerQuestion", "sectionRole", "keyContentElements", "status", "assessment", "evidenceQuote"], additionalProperties: false } }
  },
  required: [...CONTENT_REVIEW_OUTPUT_SCHEMA.required, "briefAlignment", "sectionCoverage"]
} as const;

/** Keeps an independently reviewed candidate from becoming ready before it passes. */
export class ContentReviewOrchestrator {
  constructor(private readonly options: { maxRepairRounds?: number } = {}) {}

  async run(options: ContentReviewRunOptions): Promise<ContentReviewOutcome> {
    const maxRepairRounds = Math.max(0, Math.min(CONTENT_REVIEW_MAX_ALLOWED_REPAIR_ROUNDS, Math.floor(this.options.maxRepairRounds ?? CONTENT_REVIEW_MAX_REPAIR_ROUNDS)));
    let markdown: string;
    try {
      options.signal?.throwIfAborted();
      options.onProgress?.("正在生成候选内容…");
      markdown = (await options.initial()).trim();
      if (!markdown) {
        return { status: "needs_author", markdown, findings: [], evidenceUsed: [], summary: "模型没有返回可评审的内容。", repairRounds: 0 };
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      return { status: "needs_author", markdown: typeof options.fallbackMarkdown === "function" ? options.fallbackMarkdown() : options.fallbackMarkdown ?? "", findings: [], evidenceUsed: [], summary: "候选内容生成失败。", repairRounds: 0, error: errorMessage(error) };
    }

    let repairRounds = 0;
    let evidenceRounds = 0;
    let practiceRounds = 0;
    const attemptedResearch = new Set<string>();
    const attemptedPractice = new Set<string>();
    let researchStopReason = "";
    let practiceStopReason = "";
    let previousRevisionFindings: ContentReviewFinding[] = [];
    let consecutiveUnchangedReviewRounds = 0;
    let previousMixedRevisionFindings: ContentReviewFinding[] = [];
    let revisionFindingHistory: ContentReviewFinding[] = [];
    let pendingEvidenceFindings: ContentReviewFinding[] = [];
    const emitIteration = async (iteration: ContentReviewIteration): Promise<void> => {
      try { await options.onIteration?.(iteration); }
      catch (error) { throw new IterationPersistenceError(error); }
    };
    while (true) {
      options.signal?.throwIfAborted();
      let reviewed: ContentReviewResult;
      try {
        options.onProgress?.(evidenceRounds > 0 && repairRounds === 0 ? "新增资料已进入候选依据，正在重新评审正文…"
          : repairRounds === 0 ? "独立评审正在检查候选内容…" : `正在复核第 ${repairRounds} 轮修订…`);
        reviewed = await options.review(markdown, repairRounds);
      } catch (error) {
        options.signal?.throwIfAborted();
        return { status: "review_failed", markdown, findings: [], evidenceUsed: [], summary: "独立评审未能完成，候选内容尚未通过。", repairRounds, error: errorMessage(error) };
      }

      const findings = mergePendingEvidenceFindings(reviewed.findings, pendingEvidenceFindings);
      pendingEvidenceFindings = findings.filter((finding) => finding.resolution === "research"
        || finding.resolution === "practice" || finding.resolution === "scope_decision");
      await emitIteration({ phase: "reviewed", markdown, findings, summary: reviewed.summary,
        repairRounds, evidenceRounds, ...(findings.length === 0 ? { status: "passed" as const } : {}) });
      if (findings.length === 0) {
        return {
          status: "passed", markdown, findings: reviewed.findings,
          evidenceUsed: reviewed.evidenceUsed, summary: reviewed.summary, repairRounds
        };
      }
      const evidenceRoutes = findings.filter((finding) => finding.resolution === "research" || finding.resolution === "practice" || finding.resolution === "scope_decision");
      if (evidenceRoutes.length > 0) {
        const researchFindings = evidenceRoutes.filter((finding) => finding.resolution === "research");
        const practiceFindings = evidenceRoutes.filter((finding) => finding.resolution === "practice");
        const researchKey = JSON.stringify(researchFindings.map((finding) => [finding.title.trim(), finding.detail.trim()]));
        if (researchFindings.length && options.resolveResearch && evidenceRounds < 2 && !attemptedResearch.has(researchKey)) {
          attemptedResearch.add(researchKey);
          evidenceRounds += 1;
          try {
            options.onProgress?.(`评审发现资料缺口，正在补研并核对来源（${evidenceRounds}/2）…`);
            const revised = (await options.resolveResearch(markdown, researchFindings, evidenceRounds))?.trim();
            // A checked source may support an already-accurate sentence without
            // changing its wording. The resolver returns null when no new
            // evidence was acquired, so any returned candidate merits review.
            if (revised) {
              researchStopReason = "补研已取得新资料并完成复评，但评审仍报告相同资料缺口；系统没有依据改变查询目标，因此不会重复同一搜索。";
              pendingEvidenceFindings = pendingEvidenceFindings.filter((finding) => finding.resolution !== "research");
              markdown = revised;
              await emitIteration({ phase: "candidate_revised", markdown, findings: researchFindings,
                summary: "已依据新增核对资料修订候选内容。", repairRounds, evidenceRounds });
              continue;
            }
            researchStopReason = "补研没有取得新的可核对网页正文。";
          } catch (error) {
            options.signal?.throwIfAborted();
            if (error instanceof IterationPersistenceError) throw error.causeValue;
            researchStopReason = `补研失败：${errorMessage(error).slice(0, 160)}`;
            options.onProgress?.(researchStopReason);
          }
        }
        const practiceKey = JSON.stringify(practiceFindings.map((finding) => [finding.title.trim(), finding.detail.trim()]));
        if (practiceFindings.length && options.resolvePractice && practiceRounds < 2 && !attemptedPractice.has(practiceKey)) {
          attemptedPractice.add(practiceKey);
          practiceRounds += 1;
          try {
            options.onProgress?.(`评审发现实践缺口，正在执行获授权的验证（${practiceRounds}/2）…`);
            const revised = (await options.resolvePractice(markdown, practiceFindings, practiceRounds))?.trim();
            if (revised) {
              practiceStopReason = "实践已取得新观察并完成复评，但评审仍报告相同实践缺口；系统没有依据改变验证目标，因此不会重复同一操作。";
              pendingEvidenceFindings = pendingEvidenceFindings.filter((finding) => finding.resolution !== "practice");
              markdown = revised;
              await emitIteration({ phase: "candidate_revised", markdown, findings: practiceFindings,
                summary: "已依据新增实践观察修订候选内容。", repairRounds, evidenceRounds });
              continue;
            }
            practiceStopReason = "本轮实践未取得新的实际观察。";
          } catch (error) {
            options.signal?.throwIfAborted();
            if (error instanceof IterationPersistenceError) throw error.causeValue;
            practiceStopReason = `实践未完成：${errorMessage(error).slice(0, 160)}`;
            options.onProgress?.(practiceStopReason);
          }
        }
        const revisionFindings = findings.filter((finding) => (finding.resolution ?? "revision") === "revision");
        if (revisionFindings.length > 0 && repairRounds < maxRepairRounds) {
          if (previousMixedRevisionFindings.length > 0 && sameUnresolvedFindingSet(revisionFindings, previousMixedRevisionFindings)) {
            const summary = "资料或实践缺口仍未解决；上一轮可直接修订的问题也没有改善，已停止重复请求并保留候选内容。";
            options.onProgress?.(summary);
            return { status: "needs_author", markdown, findings, evidenceUsed: reviewed.evidenceUsed, summary, repairRounds };
          }
          repairRounds += 1;
          try {
            options.onProgress?.(`证据缺口暂未解决，先修订 ${revisionFindings.length} 项可直接改进的内容（${repairRounds}/${maxRepairRounds}）…`);
            const revised = (await options.revise(markdown,
              addRepeatedFindingFeedback(revisionFindings, revisionFindingHistory), repairRounds)).trim();
            previousMixedRevisionFindings = revisionFindings;
            if (!revised) {
              return { status: "needs_author", markdown, findings, evidenceUsed: reviewed.evidenceUsed,
                summary: "可直接修订的问题没有返回修改内容；证据缺口仍未解决，候选内容已保留。", repairRounds };
            }
            if (revised === markdown) {
              return { status: "needs_author", markdown, findings, evidenceUsed: reviewed.evidenceUsed,
                summary: "可直接修订的问题没有改变候选内容；证据缺口仍未解决，已停止重复请求。", repairRounds };
            }
            revisionFindingHistory = mergeFindingHistory(revisionFindingHistory, revisionFindings);
            markdown = revised;
            await emitIteration({ phase: "candidate_revised", markdown, findings: revisionFindings,
              summary: "已处理可直接修订的评审意见。", repairRounds, evidenceRounds });
            continue;
          } catch (error) {
            options.signal?.throwIfAborted();
            if (error instanceof IterationPersistenceError) throw error.causeValue;
            return { status: "needs_author", markdown, findings, evidenceUsed: reviewed.evidenceUsed,
              summary: "可直接修订的问题处理失败；证据缺口仍未解决，候选内容已保留。", repairRounds, error: errorMessage(error) };
          }
        }
        const routes = [...new Set(evidenceRoutes.map((finding) => finding.resolution))];
        const routeText = routes.map((route) => route === "research" ? "补充有正文依据的资料" : route === "practice" ? "执行获授权的实践" : "由作者明确调整范围").join("、");
        options.onProgress?.(`评审发现需要${routeText}的问题；暂停纯文字修订以避免重复空转。`);
        return {
          status: "needs_author", markdown, findings,
          evidenceUsed: reviewed.evidenceUsed,
          summary: `评审意见需要${routeText}后才能解决；系统没有用纯文字改写代替缺失的证据或授权。${revisionFindings.length ? "可直接修订的意见仍未处理，修订预算已用完。" : ""}${researchStopReason ? ` ${researchStopReason}` : ""}${practiceStopReason ? ` ${practiceStopReason}` : ""}`,
          repairRounds
        };
      }
      if (previousRevisionFindings.length > 0 && sameUnresolvedFindingSet(findings, previousRevisionFindings)) {
        consecutiveUnchangedReviewRounds += 1;
        if (consecutiveUnchangedReviewRounds >= 2) {
          const titles = findings.map((finding) => `“${finding.title}”`).slice(0, 3).join("、");
          const summary = `连续两轮修订后，同一问题仍未解决${titles ? `：${titles}` : ""}。已停止自动修订并保留候选内容；评审措辞变化不作为进展。`;
          options.onProgress?.(summary);
          return { status: "needs_author", markdown, findings, evidenceUsed: reviewed.evidenceUsed, summary, repairRounds };
        }
      } else {
        consecutiveUnchangedReviewRounds = 0;
      }
      if (repairRounds >= maxRepairRounds) {
        return {
          status: "needs_author", markdown, findings,
          evidenceUsed: reviewed.evidenceUsed, summary: "自动修订次数已用完，仍有评审意见未解决，保留候选内容并交由作者处理。", repairRounds
        };
      }

      repairRounds += 1;
      try {
        options.onProgress?.(`发现 ${findings.length} 个待改进问题，正在自动修订（${repairRounds}/${maxRepairRounds}）…`);
        const revisionFindings = addRepeatedFindingFeedback(findings, revisionFindingHistory);
        previousRevisionFindings = findings;
        const revised = (await options.revise(markdown, revisionFindings, repairRounds)).trim();
        if (!revised) {
          return {
            status: "needs_author", markdown, findings,
            evidenceUsed: reviewed.evidenceUsed, summary: "自动修订没有返回内容，保留上一版候选并交由作者处理。", repairRounds
          };
        }
        if (revised === markdown) {
          return {
            status: "needs_author", markdown, findings,
            evidenceUsed: reviewed.evidenceUsed,
            summary: "自动修订没有改变候选内容；已停止重复请求并保留评审意见。", repairRounds
          };
        }
        revisionFindingHistory = mergeFindingHistory(revisionFindingHistory, findings);
        markdown = revised;
        await emitIteration({ phase: "candidate_revised", markdown, findings,
          summary: "已依据独立评审意见修订候选内容。", repairRounds, evidenceRounds });
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof IterationPersistenceError) throw error.causeValue;
        return {
          status: "needs_author", markdown, findings,
          evidenceUsed: reviewed.evidenceUsed, summary: "自动修订失败，保留上一版候选并交由作者处理。", repairRounds, error: errorMessage(error)
        };
      }
    }
  }
}

class IterationPersistenceError extends Error {
  constructor(readonly causeValue: unknown) { super("正文评审检查点保存失败。"); }
}

function addRepeatedFindingFeedback(
  findings: ContentReviewFinding[],
  findingHistory: ContentReviewFinding[]
): ContentReviewFinding[] {
  if (findingHistory.length === 0) return findings;
  return findings.map((finding) => {
    const previous = [...findingHistory].reverse().find((candidate) => sameFindingForFeedback(finding, candidate));
    if (!previous) return finding;
    const priorDetail = previous.detail.trim() === finding.detail.trim()
      ? ""
      : `上一轮评审描述：${previous.detail.trim()}\n`;
    return {
      ...finding,
      detail: `${finding.detail}\n\n运行时反馈：上一轮自动修订后，独立评审仍报告此问题。${priorDetail}请从当前正文定位未解决的根因，改变处理方式并直接落实修复；不要只复述、移动或弱化原句。若现有材料无法解决，保留缺口，不得编造事实、资料或实践结果。`
    };
  });
}

function mergeFindingHistory(
  history: ContentReviewFinding[],
  findings: ContentReviewFinding[]
): ContentReviewFinding[] {
  const merged = [...history];
  for (const finding of findings) {
    const existingIndex = merged.findIndex((candidate) => sameFindingForFeedback(finding, candidate));
    if (existingIndex < 0) merged.push(finding);
    else merged[existingIndex] = finding;
  }
  return merged;
}

function sameFindingForFeedback(left: ContentReviewFinding, right: ContentReviewFinding): boolean {
  if ((left.resolution ?? "revision") !== (right.resolution ?? "revision")) return false;
  if (normalizeFindingText(left.title) === normalizeFindingText(right.title)) return true;
  const leftEvidence = new Set((left.evidence ?? []).map(normalizeFindingText).filter(Boolean));
  return (right.evidence ?? []).some((quote) => leftEvidence.has(normalizeFindingText(quote)));
}

function findingKey(finding: ContentReviewFinding): string {
  return [finding.severity, finding.resolution ?? "revision", finding.title.trim().replace(/\s+/gu, " ").toLocaleLowerCase()]
    .join("\u0000");
}

function sameUnresolvedFindingSet(current: ContentReviewFinding[], previous: ContentReviewFinding[]): boolean {
  if (current.length !== previous.length || current.length === 0) return false;
  const unmatchedPrevious = [...previous];
  for (const finding of current) {
    const matchingIndex = unmatchedPrevious.findIndex((candidate) => sameFindingIdentity(finding, candidate));
    if (matchingIndex < 0) return false;
    unmatchedPrevious.splice(matchingIndex, 1);
  }
  return unmatchedPrevious.length === 0;
}

function sameFindingIdentity(left: ContentReviewFinding, right: ContentReviewFinding): boolean {
  // A severity change is a meaningful review-state change: for example, a
  // blocker downgraded to a warning may reflect partial progress that still
  // merits another focused repair. Do not stop the loop as if nothing changed.
  if (left.severity !== right.severity || (left.resolution ?? "revision") !== (right.resolution ?? "revision")) return false;
  const leftEvidence = new Set((left.evidence ?? []).map(normalizeFindingText).filter(Boolean));
  const rightEvidence = (right.evidence ?? []).map(normalizeFindingText).filter(Boolean);
  if (leftEvidence.size > 0 && rightEvidence.length > 0) return rightEvidence.some((quote) => leftEvidence.has(quote));
  return normalizeFindingText(left.title) === normalizeFindingText(right.title);
}

function mergePendingEvidenceFindings(
  current: ContentReviewFinding[],
  pending: ContentReviewFinding[]
): ContentReviewFinding[] {
  const merged = [...current];
  for (const finding of pending) {
    const key = findingKey(finding);
    const index = merged.findIndex((candidate) => findingKey(candidate) === key);
    if (index < 0) {
      merged.push(finding);
      continue;
    }
    const currentFinding = merged[index];
    if (currentFinding) {
      merged[index] = {
        ...currentFinding,
        severity: currentFinding.severity === "blocker" || finding.severity === "blocker" ? "blocker" : "warning",
        evidence: [...new Set([...(finding.evidence ?? []), ...(currentFinding.evidence ?? [])])]
      };
    }
  }
  return merged;
}

function normalizeFindingText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
