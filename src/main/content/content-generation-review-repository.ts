import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ContentReviewOutcome } from "../ai/content-review-orchestrator";

export type ReviewedArtifactType = "outline" | "draft" | "channel_draft_csdn" | "channel_draft_cnblogs" | "channel_draft_juejin" | "channel_draft_51cto";
export type GenerationReviewStatus = ContentReviewOutcome["status"];

export interface ContentGenerationReviewRecord {
  id: string;
  projectId: string;
  artifactType: ReviewedArtifactType;
  revisionSha256: string;
  status: GenerationReviewStatus;
  repairRounds: number;
  report: Omit<ContentReviewOutcome, "markdown" | "status" | "repairRounds">;
  createdAt: string;
  stale: boolean;
}

export function contentRevisionSha256(markdown: string): string {
  return createHash("sha256").update(markdown.replace(/\r\n/gu, "\n").trim(), "utf8").digest("hex");
}

export class ContentGenerationReviewRepository {
  constructor(private readonly db: Database.Database) {}

  save(projectId: string, artifactType: ReviewedArtifactType, outcome: ContentReviewOutcome): ContentGenerationReviewRecord {
    this.assertProject(projectId);
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const { markdown, status, repairRounds, ...report } = outcome;
    this.db.prepare(`INSERT INTO content_generation_reviews
      (id, project_id, artifact_type, revision_sha256, status, repair_rounds, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, artifactType, contentRevisionSha256(markdown), status, repairRounds, JSON.stringify(report), createdAt);
    return { id, projectId, artifactType, revisionSha256: contentRevisionSha256(markdown), status, repairRounds, report, createdAt, stale: false };
  }

  latest(projectId: string, artifactType: ReviewedArtifactType, currentMarkdown: string): ContentGenerationReviewRecord | null {
    this.assertProject(projectId);
    const row = this.db.prepare(`SELECT id, project_id, artifact_type, revision_sha256, status, repair_rounds, report_json, created_at
      FROM content_generation_reviews WHERE project_id = ? AND artifact_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(projectId, artifactType) as Record<string, string | number> | undefined;
    if (!row) return null;
    const reportValue: unknown = JSON.parse(String(row.report_json));
    const report = parseReport(reportValue);
    const revisionSha256 = String(row.revision_sha256);
    return {
      id: String(row.id), projectId: String(row.project_id), artifactType: row.artifact_type as ReviewedArtifactType,
      revisionSha256, status: row.status as GenerationReviewStatus, repairRounds: Number(row.repair_rounds), report,
      createdAt: String(row.created_at), stale: revisionSha256 !== contentRevisionSha256(currentMarkdown)
    };
  }

  private assertProject(projectId: string): void {
    if (!this.db.prepare("SELECT 1 FROM content_projects WHERE id = ?").get(projectId)) throw new Error("Content project not found.");
  }
}

function parseReport(value: unknown): ContentGenerationReviewRecord["report"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("评审记录格式无效。");
  const report = value as Record<string, unknown>;
  if (!Array.isArray(report.findings) || !Array.isArray(report.evidenceUsed) || typeof report.summary !== "string") {
    throw new Error("评审记录缺少必要字段。");
  }
  return {
    findings: report.findings as ContentReviewOutcome["findings"],
    evidenceUsed: report.evidenceUsed.filter((item): item is string => typeof item === "string"),
    summary: report.summary,
    ...(typeof report.error === "string" ? { error: report.error } : {})
  };
}
