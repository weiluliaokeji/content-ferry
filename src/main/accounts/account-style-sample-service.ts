import type Database from "better-sqlite3";
import type { AccountRepository } from "./account-repository";
import type { ContentSourceService, StyleSampleArticleDateRange } from "../content/content-source-service";

export type AccountStyleSampleAttribution = "published_record" | "author_confirmed" | "unassigned";

export interface AccountStyleSample {
  title: string;
  relativePath: string;
  createdAt: string;
  articleStatus: "published" | null;
  attribution: AccountStyleSampleAttribution;
  attributionEvidence: string;
  selected: boolean;
}

export interface AccountStyleSampleList {
  sourceConfigured: boolean;
  items: AccountStyleSample[];
  selectedPaths: string[];
  authorConfirmedPaths: string[];
  truncated: boolean;
}

export interface SaveAccountStyleSamplesInput {
  selectedPaths: string[];
  authorConfirmedPaths: string[];
}

export class AccountStyleSampleService {
  constructor(
    private readonly db: Database.Database,
    private readonly accounts: AccountRepository,
    private readonly contentSources: ContentSourceService
  ) {}

  list(accountId: string, dateRange: StyleSampleArticleDateRange = {}): AccountStyleSampleList {
    const account = this.accounts.requireAccount(accountId);
    if (!this.contentSources.getSourceConfig(account.workspaceId)) return { sourceConfigured: false, items: [], selectedPaths: [], authorConfirmedPaths: [], truncated: false };

    const publishedPaths = this.accounts.publishedArticlePaths(accountId);
    const selectedRows = this.db.prepare(`SELECT source_relative_path AS relativePath, attribution_basis AS attributionBasis
      FROM account_style_samples WHERE account_id = ?`).all(accountId) as Array<{ relativePath: string; attributionBasis: "published_record" | "author_confirmed" }>;
    const selectedByPath = new Map(selectedRows.map((row) => [row.relativePath, row.attributionBasis]));
    const articles = this.contentSources.listStyleSampleArticles(account.workspaceId, dateRange);
    return {
      sourceConfigured: true,
      truncated: articles.truncated,
      selectedPaths: selectedRows.map((row) => row.relativePath),
      authorConfirmedPaths: selectedRows.filter((row) => row.attributionBasis === "author_confirmed").map((row) => row.relativePath),
      items: articles.items.map((article) => {
        const published = publishedPaths.has(article.relativePath);
        const authorConfirmed = selectedByPath.get(article.relativePath) === "author_confirmed";
        const attribution: AccountStyleSampleAttribution = published ? "published_record" : authorConfirmed ? "author_confirmed" : "unassigned";
        return {
          title: article.title,
          relativePath: article.relativePath,
          createdAt: article.createdAt,
          articleStatus: article.status === "published" ? "published" : null,
          attribution,
          attributionEvidence: published
            ? `已在账号“${account.displayName}”的确认发布记录中找到这篇文章。`
            : authorConfirmed
              ? `你已确认这篇文章属于账号“${account.displayName}”。`
              : `尚未确认归属；纳入样本时请确认这是账号“${account.displayName}”的已完成文章。`,
          selected: selectedByPath.has(article.relativePath)
        };
      })
    };
  }

  saveSelection(accountId: string, input: SaveAccountStyleSamplesInput): AccountStyleSampleList {
    const account = this.accounts.requireAccount(accountId);
    if (!this.contentSources.getSourceConfig(account.workspaceId)) throw new Error("请先配置文章库，再挑选账号代表样本。");
    const selectedPaths = uniquePaths(input.selectedPaths, "代表样本");
    const authorConfirmedPaths = uniquePaths(input.authorConfirmedPaths, "归属确认");
    if (selectedPaths.length > 100) throw new Error("一次最多选择 100 篇代表样本。");
    const selected = new Set(selectedPaths);
    if (authorConfirmedPaths.some((articlePath) => !selected.has(articlePath))) {
      throw new Error("只有本次选中的代表样本才能确认账号归属。");
    }

    const publishedPaths = this.accounts.publishedArticlePaths(accountId);
    const confirmedPaths = new Set(authorConfirmedPaths);
    const sampleRows = selectedPaths.map((relativePath) => {
      const article = this.contentSources.getStyleSampleArticle(account.workspaceId, relativePath);
      if (!article) throw new Error("只能选择文章库中的文章作为代表样本。");
      if (article.status === "draft") throw new Error(`草稿不能作为代表样本：${article.title}`);
      const basis = publishedPaths.has(article.relativePath) ? "published_record" : confirmedPaths.has(article.relativePath) ? "author_confirmed" : null;
      if (!basis) throw new Error(`请确认“${article.title}”属于账号“${account.displayName}”且已经完成，再将它加入代表样本。`);
      return { relativePath: article.relativePath, basis };
    });

    this.db.transaction(() => {
      this.db.prepare("DELETE FROM account_style_samples WHERE account_id = ?").run(accountId);
      const insert = this.db.prepare(`INSERT INTO account_style_samples
        (account_id, source_relative_path, attribution_basis, selected_at) VALUES (?, ?, ?, ?)`);
      const now = new Date().toISOString();
      for (const row of sampleRows) insert.run(accountId, row.relativePath, row.basis, now);
    })();
    return this.list(accountId);
  }

}

function uniquePaths(paths: string[], label: string): string[] {
  if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label}路径格式无效。`);
  }
  const normalized = paths.map((value) => value.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label}中有重复文章。`);
  return normalized;
}
