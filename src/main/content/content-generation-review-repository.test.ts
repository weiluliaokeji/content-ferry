import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { AccountRepository } from "../accounts/account-repository";
import { ContentProjectRepository } from "./content-project-repository";
import { ContentGenerationReviewRepository, contentRevisionSha256 } from "./content-generation-review-repository";

describe("content generation review records", () => {
  let database: AppDatabase | undefined;
  afterEach(() => database?.close());

  it("binds a passing report to one exact content revision and marks edits stale", () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const projects = new ContentProjectRepository(database.connection);
    const project = projects.create({ workspaceId: workspace.id, topic: "文章主题" });
    const reviews = new ContentGenerationReviewRepository(database.connection);
    const outcome = {
      status: "passed" as const,
      markdown: "# 文章主题\n\n## 结构",
      findings: [{ severity: "warning" as const, title: "可补示例", detail: "不阻断。" }],
      evidenceUsed: ["https://example.com/source"],
      summary: "评审通过。",
      repairRounds: 1
    };

    const saved = reviews.save(project.id, "outline", outcome);

    expect(saved.revisionSha256).toBe(contentRevisionSha256(outcome.markdown));
    expect(reviews.latest(project.id, "outline", outcome.markdown)).toMatchObject({ id: saved.id, status: "passed", stale: false });
    expect(reviews.latest(project.id, "outline", `${outcome.markdown}\n## 作者调整`)).toMatchObject({ id: saved.id, status: "passed", stale: true });
  });

  it("keeps each review run and does not replace a prior candidate record", () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(database.connection).create({ workspaceId: workspace.id, topic: "文章主题" });
    const reviews = new ContentGenerationReviewRepository(database.connection);
    const base = { findings: [], evidenceUsed: [], summary: "", repairRounds: 0 };
    const first = reviews.save(project.id, "outline", { ...base, status: "needs_author", markdown: "# A" });
    const second = reviews.save(project.id, "outline", { ...base, status: "passed", markdown: "# B" });

    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM content_generation_reviews WHERE project_id = ?").get(project.id))
      .toEqual({ count: 2 });
    expect(reviews.latest(project.id, "outline", "# B")?.id).toBe(second.id);
    expect(reviews.latest(project.id, "outline", "# B")?.id).not.toBe(first.id);
  });

  it("persists an outline review after the fifth repair round", () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(database.connection).create({ workspaceId: workspace.id, topic: "文章主题" });
    const reviews = new ContentGenerationReviewRepository(database.connection);

    const saved = reviews.save(project.id, "outline", {
      status: "needs_author",
      markdown: "# 文章主题",
      findings: [],
      evidenceUsed: [],
      summary: "已达到五轮自动修订上限。",
      repairRounds: 5
    });

    expect(saved.repairRounds).toBe(5);
    expect(reviews.latest(project.id, "outline", "# 文章主题")?.repairRounds).toBe(5);
  });
});
