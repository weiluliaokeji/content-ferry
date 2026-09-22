import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResearchExecution, ResearchPlan } from "../../shared/research-state";
import type { ResearchAdoptionDecision, ResearchEvidence } from "../../shared/research-evidence";
import { mergeResearchPlan } from "./research-plan";

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  keyClaims: string[];
  sourceType: "official" | "public";
  evidence?: ResearchEvidence;
  adoptionHistory?: ResearchAdoptionDecision[];
  adoptionStatus: "recommended" | "adopted" | "rejected" | "pending_verification";
  provenance?: ResearchProvenance;
  retrievedAt: string;
  selected: boolean;
}

export type SpecifiedSourceStatus = "pending_manual_verification" | "verified" | "rejected" | "failed";

export interface SpecifiedSource {
  id: string;
  url: string;
  status: SpecifiedSourceStatus;
  verificationNote: string;
  failureReason: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProvenance {
  kind: "execution_observation";
  executionRunId: string;
  observationId: string;
  status: "pending" | "accepted" | "rejected";
  targetType: string;
  runtime: string;
  command: string[];
  networkPolicy: string;
  artifacts: Array<{ path: string; sha256: string }>;
}

export interface ContentResearch {
  projectId: string;
  planMarkdown: string;
  plan: ResearchPlan | null;
  sources: ResearchSource[];
  specifiedSources: SpecifiedSource[];
  updatedAt: string | null;
}

export class ContentResearchError extends Error {}

export class ContentResearchRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentResearch {
    const plan = this.db.prepare("SELECT plan_markdown, updated_at FROM content_research_plans WHERE project_id = ?")
      .get(projectId) as { plan_markdown: string; updated_at: string } | undefined;
    const sources = this.db.prepare(`SELECT id, title, url, excerpt, claims_json, provenance_json, evidence_json, adoption_history_json, adoption_status, source_type, retrieved_at, selected
      FROM content_research_sources WHERE project_id = ? ORDER BY retrieved_at DESC, id DESC`).all(projectId) as Array<Record<string, string | number>>;
    const specifiedSources = this.db.prepare(`SELECT id, url, status, verification_note, failure_reason, created_at, updated_at
      FROM content_specified_sources WHERE project_id = ? ORDER BY created_at ASC, id ASC`).all(projectId) as Array<Record<string, string>>;
    const planState = this.db.prepare("SELECT state_json FROM content_research_plan_states WHERE project_id = ?")
      .get(projectId) as { state_json: string } | undefined;
    return {
      projectId,
      planMarkdown: plan?.plan_markdown ?? "",
      plan: parsePlan(planState?.state_json),
      sources: sources.map((source) => ({
        id: source.id as string,
        title: source.title as string,
        url: source.url as string,
        excerpt: source.excerpt as string,
        keyClaims: parseClaims(source.claims_json),
        sourceType: source.source_type === "official" ? "official" : "public",
        evidence: parseEvidence(source.evidence_json),
        adoptionHistory: parseAdoptionHistory(source.adoption_history_json),
        adoptionStatus: parseAdoptionStatus(source.adoption_status),
        provenance: parseProvenance(source.provenance_json),
        retrievedAt: source.retrieved_at as string,
        selected: Boolean(source.selected)
      })),
      specifiedSources: specifiedSources.map((source) => ({
        id: source.id,
        url: source.url,
        status: source.status as SpecifiedSourceStatus,
        verificationNote: source.verification_note,
        failureReason: source.failure_reason,
        createdAt: source.created_at,
        updatedAt: source.updated_at
      })),
      updatedAt: plan?.updated_at ?? null
    };
  }

  beginPlan(projectId: string, plan: ResearchPlan): ContentResearch {
    const now = new Date().toISOString();
    const current = this.get(projectId).plan;
    const next = mergeResearchPlan(current, { ...plan, updatedAt: now });
    this.db.prepare(`INSERT INTO content_research_plan_states (project_id, state_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .run(projectId, JSON.stringify(next), now);
    return this.get(projectId);
  }

  completePlan(projectId: string, execution?: ResearchExecution, coverage?: { answeredQuestions?: Array<{ question: string; sourceUrls: string[] }>; remainingQuestions?: string[] }): ContentResearch {
    const current = this.get(projectId).plan;
    if (!current) return this.get(projectId);
    const sources = this.db.prepare("SELECT source_type, claims_json, url, evidence_json FROM content_research_sources WHERE project_id = ?")
      .all(projectId) as Array<{ source_type: string; claims_json: string; url: string; evidence_json: string }>;
    const officialCount = sources.filter((source) => source.source_type === "official").length;
    const publicCount = sources.length - officialCount;
    const allClaims = sources.flatMap((source) => parseClaims(source.claims_json)).join("\n");
    const covered = [
      sources.length ? `已保留 ${sources.length} 个可追溯来源（官方 ${officialCount}，公开 ${publicCount}）。` : "",
      officialCount ? "已获得官方原始资料。" : "",
      publicCount ? "已获得公开资料。" : "",
      /限制|反例|风险|不适用|边界/i.test(allClaims) ? "已获得限制、反例或适用边界的线索。" : ""
    ].filter(Boolean);
    const evidenceGaps = current.evidenceDimensions.flatMap((dimension) => {
      if (dimension === "官方原始资料" && officialCount) return [];
      if (dimension === "独立实践、评论或案例" && publicCount) return [];
      if (dimension === "限制、反例或适用边界" && /限制|反例|风险|不适用|边界/i.test(allClaims)) return [];
      if (dimension === "当前版本、价格、限额或规则") return [`待人工核对：${dimension}的发布时间、版本和适用地区。`];
      return [`待补充：${dimension}`];
    });
    const gaps = [...evidenceGaps];
    const sourceUrls = new Set(sources.flatMap((source) => [source.url, ...((parseEvidence(source.evidence_json)?.sourceUrls ?? [])), ...((parseEvidence(source.evidence_json)?.snapshots ?? []).map((snapshot) => snapshot.url))]
      .map(normalizeResearchUrl)));
    const planQuestions = new Set(current.questions);
    const answeredQuestions = coverage?.answeredQuestions?.filter((item) => planQuestions.has(item.question) && item.sourceUrls.some((url) => sourceUrls.has(normalizeResearchUrl(url))))
      .map((item) => item.question) ?? [];
    const answered = new Set(answeredQuestions);
    const declaredRemaining = new Set(coverage?.remainingQuestions ?? []);
    const remainingQuestions = coverage
      ? current.questions.filter((question) => !answered.has(question) || declaredRemaining.has(question))
      : current.questions;
    covered.push(...answeredQuestions.map((question) => `已回答：${question}`));
    gaps.push(...remainingQuestions.map((question) => `待核验：${question}`));
    const nextExecution = execution ?? current.execution;
    const budgetExhausted = Boolean(nextExecution?.budgetExhausted);
    if (budgetExhausted) gaps.push("本轮执行预算已耗尽；以下材料为部分调研结果，请围绕缺口继续补研。");
    if (sources.length === 0) gaps.push("尚未获得可追溯资料卡；请检查网络、指定来源或补研方向。");
    const next: ResearchPlan = {
      ...current,
      covered,
      gaps: [...new Set(gaps)],
      partial: evidenceGaps.length > 0 || remainingQuestions.length > 0 || budgetExhausted || sources.length === 0,
      execution: nextExecution ?? null,
      updatedAt: new Date().toISOString()
    };
    this.db.prepare(`INSERT INTO content_research_plan_states (project_id, state_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
      .run(projectId, JSON.stringify(next), next.updatedAt);
    return this.get(projectId);
  }

  addSpecifiedSources(projectId: string, urls: string[]): ContentResearch {
    const now = new Date().toISOString();
    const normalizedUrls = [...new Set(urls.map(normalizePublicResearchUrl))];
    const insert = this.db.prepare(`INSERT INTO content_specified_sources
      (id, project_id, url, status, verification_note, failure_reason, created_at, updated_at)
      VALUES (?, ?, ?, 'pending_manual_verification', '', '', ?, ?)
      ON CONFLICT(project_id, url) DO NOTHING`);
    this.db.transaction(() => {
      for (const url of normalizedUrls) insert.run(randomUUID(), projectId, url, now, now);
    })();
    return this.get(projectId);
  }

  updateSpecifiedSource(projectId: string, sourceId: string, input: {
    status: SpecifiedSourceStatus;
    verificationNote: string;
    failureReason: string;
  }): ContentResearch {
    const exists = this.db.prepare("SELECT 1 FROM content_specified_sources WHERE id = ? AND project_id = ?").get(sourceId, projectId);
    if (!exists) throw new ContentResearchError("找不到这条指定资料。");
    this.db.prepare(`UPDATE content_specified_sources
      SET status = ?, verification_note = ?, failure_reason = ?, updated_at = ?
      WHERE id = ? AND project_id = ?`)
      .run(input.status, input.verificationNote.trim(), input.failureReason.trim(), new Date().toISOString(), sourceId, projectId);
    return this.get(projectId);
  }

  markSpecifiedSourceExtraction(projectId: string, results: Array<{ url: string; status: "extracted" | "failed"; reason?: string }>): ContentResearch {
    const now = new Date().toISOString();
    const update = this.db.prepare(`UPDATE content_specified_sources
      SET status = ?, verification_note = ?, failure_reason = ?, updated_at = ?
      WHERE project_id = ? AND url = ?`);
    this.db.transaction(() => {
      for (const result of results) {
        const url = normalizeResearchUrl(result.url);
        update.run(
          result.status === "extracted" ? "verified" : "failed",
          result.status === "extracted" ? "系统已自动提取正文；资料是否进入写作由资料卡采纳决定。" : "",
          result.status === "failed" ? (result.reason ?? "正文提取失败，请打开来源后重试。") : "",
          now,
          projectId,
          url
        );
      }
    })();
    return this.get(projectId);
  }

  markSpecifiedSourceExtractionFailure(projectId: string, sourceIds: string[], reason: string): ContentResearch {
    const ids = [...new Set(sourceIds.filter(Boolean))];
    if (ids.length === 0) return this.get(projectId);
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`UPDATE content_specified_sources
      SET status = 'failed', verification_note = '', failure_reason = ?, updated_at = ?
      WHERE project_id = ? AND status = 'pending_manual_verification' AND id IN (${placeholders})`)
      .run(reason, new Date().toISOString(), projectId, ...ids);
    return this.get(projectId);
  }

  retrySpecifiedSourceExtraction(projectId: string, sourceIds: string[]): ContentResearch {
    const ids = [...new Set(sourceIds.filter(Boolean))];
    if (ids.length === 0) return this.get(projectId);
    const placeholders = ids.map(() => "?").join(", ");
    this.db.prepare(`UPDATE content_specified_sources
      SET status = 'pending_manual_verification', verification_note = '', failure_reason = '', updated_at = ?
      WHERE project_id = ? AND status = 'failed' AND id IN (${placeholders})`)
      .run(new Date().toISOString(), projectId, ...ids);
    return this.get(projectId);
  }

  verifySpecifiedSourceFromManualCard(projectId: string, url: string | undefined, verificationNote: string): void {
    if (!url?.trim()) return;
    this.db.prepare(`UPDATE content_specified_sources
      SET status = 'verified', verification_note = ?, failure_reason = '', updated_at = ?
      WHERE project_id = ? AND url = ?`)
      .run(verificationNote.trim(), new Date().toISOString(), projectId, normalizePublicResearchUrl(url));
  }

  save(projectId: string, input: { planMarkdown: string; sources: Omit<ResearchSource, "id" | "retrievedAt" | "selected" | "adoptionStatus">[] }): ContentResearch {
    const now = new Date().toISOString();
    const save = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET plan_markdown = excluded.plan_markdown, updated_at = excluded.updated_at`)
        .run(projectId, input.planMarkdown, now);
      this.db.prepare("DELETE FROM content_research_sources WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, provenance_json, evidence_json, adoption_history_json, adoption_status, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '[]', 'recommended', ?, ?, 0)`);
      const seen = new Set<string>();
      for (const source of input.sources) {
        const url = normalizeResearchUrl(source.url);
        if (seen.has(url)) continue;
        seen.add(url);
        insert.run(randomUUID(), projectId, source.title, url, source.excerpt, JSON.stringify(source.keyClaims), JSON.stringify(source.evidence ?? {}), source.sourceType, now);
      }
    });
    save();
    return this.get(projectId);
  }

  append(projectId: string, input: { planMarkdown: string; sources: Omit<ResearchSource, "id" | "retrievedAt" | "selected" | "adoptionStatus">[] }): ContentResearch {
    const now = new Date().toISOString();
    const append = this.db.transaction(() => {
      const existingPlan = this.db.prepare("SELECT plan_markdown FROM content_research_plans WHERE project_id = ?")
        .get(projectId) as { plan_markdown: string } | undefined;
      const planMarkdown = existingPlan?.plan_markdown.trim()
        ? `${existingPlan.plan_markdown.trim()}\n\n---\n\n${input.planMarkdown.trim()}`
        : input.planMarkdown.trim();
      this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET plan_markdown = excluded.plan_markdown, updated_at = excluded.updated_at`)
        .run(projectId, planMarkdown, now);
      const existingSources = this.db.prepare("SELECT url FROM content_research_sources WHERE project_id = ?").all(projectId) as Array<{ url: string }>;
      const existingUrls = new Set(existingSources.map((row) => normalizeResearchUrl(row.url)));
      const insert = this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, provenance_json, evidence_json, adoption_history_json, adoption_status, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '[]', 'recommended', ?, ?, 0)`);
      for (const source of input.sources) {
        const url = normalizeResearchUrl(source.url);
        if (existingUrls.has(url)) continue;
        existingUrls.add(url);
        insert.run(randomUUID(), projectId, source.title, url, source.excerpt, JSON.stringify(source.keyClaims), JSON.stringify(source.evidence ?? {}), source.sourceType, now);
      }
    });
    append();
    return this.get(projectId);
  }

  updateSelection(projectId: string, sourceId: string, selected: boolean): ContentResearch {
    const exists = this.db.prepare("SELECT 1 FROM content_research_sources WHERE id = ? AND project_id = ?").get(sourceId, projectId);
    if (!exists) throw new Error("找不到这张资料卡。");
    this.updateAdoption(projectId, sourceId, selected ? "adopted" : "rejected");
    return this.get(projectId);
  }

  updateAdoption(projectId: string, sourceId: string, adoptionStatus: ResearchSource["adoptionStatus"]): ContentResearch {
    const exists = this.db.prepare("SELECT 1 FROM content_research_sources WHERE id = ? AND project_id = ?").get(sourceId, projectId);
    if (!exists) throw new Error("找不到这张资料卡。");
    this.db.prepare("UPDATE content_research_sources SET adoption_status = ?, selected = ? WHERE id = ? AND project_id = ?")
      .run(adoptionStatus, adoptionStatus === "adopted" ? 1 : 0, sourceId, projectId);
    return this.get(projectId);
  }

  merge(projectId: string, targetId: string, sourceId: string): ContentResearch {
    if (targetId === sourceId) throw new ContentResearchError("请选择另一张资料卡进行合并。");
    const cards = this.get(projectId).sources;
    const target = cards.find((card) => card.id === targetId);
    const source = cards.find((card) => card.id === sourceId);
    if (!target || !source) throw new ContentResearchError("找不到要合并的资料卡。");
    const snapshots = [...(target.evidence?.snapshots ?? []), ...(source.evidence?.snapshots ?? [])]
      .filter((snapshot, index, all) => all.findIndex((item) => item.url === snapshot.url) === index);
    const evidenceBase = target.evidence ?? source.evidence;
    const evidence = evidenceBase ? { ...evidenceBase, sourceUrls: snapshots.map((snapshot) => snapshot.url), snapshots } : undefined;
    this.db.transaction(() => {
      const mergedDecisions = [...(target.adoptionHistory ?? []), { sourceId: target.id, title: target.title, adoptionStatus: target.adoptionStatus }, ...(source.adoptionHistory ?? []), { sourceId: source.id, title: source.title, adoptionStatus: source.adoptionStatus }]
        .filter((decision, index, all) => all.findIndex((item) => item.sourceId === decision.sourceId) === index);
      this.db.prepare("UPDATE content_research_sources SET claims_json = ?, evidence_json = ?, adoption_history_json = ? WHERE id = ? AND project_id = ?")
        .run(JSON.stringify([...new Set([...target.keyClaims, ...source.keyClaims])]), JSON.stringify(evidence ?? {}), JSON.stringify(mergedDecisions), targetId, projectId);
      this.db.prepare("DELETE FROM content_research_sources WHERE id = ? AND project_id = ?").run(sourceId, projectId);
    })();
    return this.get(projectId);
  }

  split(projectId: string, sourceId: string): ContentResearch {
    const source = this.get(projectId).sources.find((card) => card.id === sourceId);
    const snapshots = source?.evidence?.snapshots ?? [];
    if (!source || snapshots.length < 2) throw new ContentResearchError("这张资料卡没有可拆分的多个来源。");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const snapshot of snapshots.slice(1)) {
        const evidence = { ...source.evidence!, sourceUrls: [snapshot.url], snapshots: [snapshot] };
        this.db.prepare(`INSERT INTO content_research_sources (id, project_id, title, url, excerpt, claims_json, provenance_json, evidence_json, adoption_history_json, adoption_status, source_type, retrieved_at, selected)
          VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '[]', ?, ?, ?, ?)`)
          .run(randomUUID(), projectId, source.title, snapshot.url, source.excerpt, JSON.stringify(source.keyClaims), JSON.stringify(evidence), source.adoptionStatus, source.sourceType, now, source.adoptionStatus === "adopted" ? 1 : 0);
      }
      const first = snapshots[0];
      const evidence = { ...source.evidence!, sourceUrls: [first.url], snapshots: [first] };
      this.db.prepare("UPDATE content_research_sources SET url = ?, evidence_json = ? WHERE id = ? AND project_id = ?")
        .run(first.url, JSON.stringify(evidence), sourceId, projectId);
    })();
    return this.get(projectId);
  }

  addManual(projectId: string, input: { title: string; url?: string; excerpt: string; keyClaims: string[]; adoptionStatus?: "adopted" | "pending_verification"; evidence?: ResearchEvidence }): ContentResearch {
    const now = new Date().toISOString();
    const capturedAt = input.evidence?.snapshots[0]?.capturedAt;
    const retrievedAt = capturedAt && !Number.isNaN(Date.parse(capturedAt)) ? capturedAt : now;
    const url = input.url?.trim() ? normalizePublicResearchUrl(input.url) : `manual://${randomUUID()}`;
    if (!url.startsWith("manual://")) {
      const existing = this.db.prepare("SELECT 1 FROM content_research_sources WHERE project_id = ? AND url = ?")
        .get(projectId, url);
      if (existing) return this.get(projectId);
    }
    this.db.prepare(`INSERT INTO content_research_sources
      (id, project_id, title, url, excerpt, claims_json, provenance_json, evidence_json, adoption_history_json, adoption_status, source_type, retrieved_at, selected)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '[]', ?, 'public', ?, ?)`)
      .run(randomUUID(), projectId, input.title.trim(), url, input.excerpt.trim(), JSON.stringify(input.keyClaims.map((claim) => claim.trim()).filter(Boolean)), JSON.stringify(input.evidence ?? manualEvidence(input, url, retrievedAt)), input.adoptionStatus ?? "adopted", retrievedAt, input.adoptionStatus === "pending_verification" ? 0 : 1);
    this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, '', ?)
      ON CONFLICT(project_id) DO UPDATE SET updated_at = excluded.updated_at`).run(projectId, now);
    return this.completePlan(projectId);
  }

  addExecutionObservation(projectId: string, input: {
    observationId: string;
    executionRunId: string;
    title: string;
    claim: string;
    provenance: ResearchProvenance;
    artifacts: Array<{ path: string; sha256: string }>;
  }): ContentResearch {
    const now = new Date().toISOString();
    const url = `execution://${input.executionRunId}`;
    const existing = this.db.prepare("SELECT id FROM experimental_observations WHERE execution_run_id = ?")
      .get(input.executionRunId) as { id?: string } | undefined;
    if (existing?.id) return this.get(projectId);
    const observationId = existing?.id ?? input.observationId;
    const provenance = { ...input.provenance, observationId };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO experimental_observations
        (id, project_id, execution_run_id, title, claim, status, provenance_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(execution_run_id) DO UPDATE SET title = excluded.title, claim = excluded.claim,
          provenance_json = excluded.provenance_json, updated_at = excluded.updated_at`)
        .run(observationId, projectId, input.executionRunId, input.title.trim(), input.claim.trim(), JSON.stringify(provenance), now, now);
      this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, provenance_json, evidence_json, adoption_history_json, adoption_status, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '[]', 'pending_verification', 'public', ?, 0)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt,
          claims_json = excluded.claims_json, provenance_json = excluded.provenance_json, retrieved_at = excluded.retrieved_at`)
        .run(observationId, projectId, `实验观察 · ${input.title.trim()}`, url,
          `${input.claim.trim()}\n执行记录：${input.executionRunId}；结果仅适用于记录的目标、版本和输入。`,
          JSON.stringify([input.claim.trim(), `复现条件见执行记录 ${input.executionRunId}`]), JSON.stringify(provenance), now);
    })();
    return this.get(projectId);
  }

  findExecutionObservationId(executionRunId: string): string | null {
    const row = this.db.prepare("SELECT id FROM experimental_observations WHERE execution_run_id = ? LIMIT 1")
      .get(executionRunId) as { id?: string } | undefined;
    return row?.id ?? null;
  }

}

export function normalizeResearchUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("manual://")) return trimmed;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function normalizePublicResearchUrl(value: string): string {
  const normalized = normalizeResearchUrl(value);
  let parsed: URL;
  try { parsed = new URL(normalized); }
  catch { throw new Error("资料来源链接必须是有效的 HTTP(S) 地址。"); }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error("资料来源链接只支持不带凭据的 HTTP(S) 地址。");
  }
  return normalized;
}

function parseClaims(value: string | number): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((claim): claim is string => typeof claim === "string") : [];
  } catch {
    return [];
  }
}

function parseAdoptionStatus(value: unknown): ResearchSource["adoptionStatus"] {
  return value === "adopted" || value === "rejected" || value === "pending_verification" ? value : "recommended";
}

function parseAdoptionHistory(value: unknown): ResearchAdoptionDecision[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is ResearchAdoptionDecision => Boolean(item) && typeof item === "object"
      && typeof (item as { sourceId?: unknown }).sourceId === "string"
      && typeof (item as { title?: unknown }).title === "string"
      && ["recommended", "adopted", "rejected", "pending_verification"].includes(String((item as { adoptionStatus?: unknown }).adoptionStatus))) : [];
  } catch {
    return [];
  }
}

function parseProvenance(value: string | number | undefined): ResearchProvenance | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value)) as ResearchProvenance;
    return parsed?.kind === "execution_observation" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseEvidence(value: string | number | undefined): ResearchEvidence | undefined {
  if (!value) return undefined;
  try {
    const evidence = JSON.parse(String(value)) as Partial<ResearchEvidence>;
    if (!evidence || typeof evidence.claim !== "string" || !Array.isArray(evidence.sourceUrls) || !Array.isArray(evidence.snapshots)) return undefined;
    return {
      claim: evidence.claim,
      recommendation: typeof evidence.recommendation === "string" ? evidence.recommendation : "",
      qualityReason: typeof evidence.qualityReason === "string" ? evidence.qualityReason : "",
      freshness: typeof evidence.freshness === "string" ? evidence.freshness : "",
      boundary: typeof evidence.boundary === "string" ? evidence.boundary : "",
      kind: ["official", "review", "experience", "counterexample", "manual"].includes(String(evidence.kind)) ? evidence.kind as ResearchEvidence["kind"] : "manual",
      sourceUrls: evidence.sourceUrls.filter((item): item is string => typeof item === "string"),
      snapshots: evidence.snapshots.filter((item): item is ResearchEvidence["snapshots"][number] => Boolean(item) && typeof item === "object" && typeof (item as { url?: unknown }).url === "string" && typeof (item as { excerpt?: unknown }).excerpt === "string" && typeof (item as { capturedAt?: unknown }).capturedAt === "string" && typeof (item as { sha256?: unknown }).sha256 === "string")
    };
  } catch {
    return undefined;
  }
}

function manualEvidence(input: { title: string; url?: string; excerpt: string; keyClaims: string[] }, url: string, capturedAt: string): ResearchEvidence {
  const excerpt = input.excerpt.trim().slice(0, 1600);
  return {
    claim: input.keyClaims.map((claim) => claim.trim()).find(Boolean) ?? excerpt.slice(0, 200),
    recommendation: "这是你手工补录的资料，可在确认原文语境后用于写作。",
    qualityReason: "由用户提供摘要或摘录，未经过自动网页提取。",
    freshness: "以手工补录时间为准，请自行核对原文发布日期和版本。",
    boundary: "仅覆盖手工输入的摘要或摘录，不代表系统已验证整页内容。",
    kind: "manual",
    sourceUrls: [url],
    snapshots: [{ url, excerpt, capturedAt, sha256: createHash("sha256").update(input.excerpt.trim()).digest("hex") }]
  };
}

function parsePlan(value: string | undefined): ResearchPlan | null {
  if (!value) return null;
  try {
    const plan = JSON.parse(value) as Partial<ResearchPlan>;
    if (!plan || !["quick", "balanced", "deep"].includes(String(plan.depth))) return null;
    return {
      depth: plan.depth as ResearchPlan["depth"],
      questions: stringList(plan.questions),
      evidenceDimensions: stringList(plan.evidenceDimensions),
      freshnessRisks: stringList(plan.freshnessRisks),
      pendingConflicts: stringList(plan.pendingConflicts),
      covered: stringList(plan.covered),
      gaps: stringList(plan.gaps),
      partial: Boolean(plan.partial),
      execution: parseExecution(plan.execution),
      updatedAt: typeof plan.updatedAt === "string" ? plan.updatedAt : ""
    };
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseExecution(value: unknown): ResearchExecution | null {
  if (!value || typeof value !== "object") return null;
  const execution = value as Partial<ResearchExecution>;
  return {
    rounds: typeof execution.rounds === "number" ? execution.rounds : null,
    maxRounds: typeof execution.maxRounds === "number" ? execution.maxRounds : null,
    budgetExhausted: Boolean(execution.budgetExhausted)
  };
}
