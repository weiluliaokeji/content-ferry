import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountRepository } from "./account-repository";
import { AccountStyleSampleService } from "./account-style-sample-service";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase } from "../db/database";

describe("account style sample selection", () => {
  const database = openInMemoryDatabase();
  const accounts = new AccountRepository(database.connection);
  const workspace = accounts.getOrCreateDefaultWorkspace();
  const contentSources = new ContentSourceService(database.connection);
  const service = new AccountStyleSampleService(database.connection, accounts, contentSources);
  const articleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-style-samples-"));
  let accountA: ReturnType<AccountRepository["createAccount"]>;
  let accountB: ReturnType<AccountRepository["createAccount"]>;

  beforeEach(() => {
    accountA = accounts.createAccount({ workspaceId: workspace.id, platform: "wechat_official", displayName: `账号A-${randomUUID()}` });
    accountB = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: `账号B-${randomUUID()}` });
    contentSources.setSource(workspace.id, articleRoot, "plain");
  });

  afterEach(() => {
    database.connection.prepare("DELETE FROM wechat_publish_jobs WHERE account_id IN (?, ?)").run(accountA.id, accountB.id);
    database.connection.prepare("DELETE FROM account_style_samples WHERE account_id IN (?, ?)").run(accountA.id, accountB.id);
    accounts.deleteAccount(accountA.id);
    accounts.deleteAccount(accountB.id);
    fs.rmSync(articleRoot, { recursive: true, force: true });
    fs.mkdirSync(articleRoot, { recursive: true });
  });

  it("lists published records with their account and lets the author confirm completed and archived articles", () => {
    writeArticle("published", "已发布文章", "published", false, "2025-01-03");
    writeArticle("unassigned", "待确认旧文", null, false, "2025-01-02");
    writeArticle("draft", "草稿", "draft", false, "2025-01-05");
    writeArticle("archived", "归档文章", "published", true, "2025-01-04");
    recordWechatPublication(accountA.id, "posts/published/index.md");
    recordWechatPublication(accountB.id, "posts/other-account/index.md");
    writeArticle("other-account", "其他账号文章", "published", false, "2025-01-01");

    const initial = service.list(accountA.id);
    expect(initial.items.map((item) => [item.relativePath, item.attribution])).toEqual([
      ["posts/archived/index.md", "unassigned"],
      ["posts/published/index.md", "published_record"],
      ["posts/unassigned/index.md", "unassigned"],
      ["posts/other-account/index.md", "unassigned"]
    ]);
    expect(service.list(accountA.id, { createdFrom: "2025-01-02", createdTo: "2025-01-03" }).items.map((item) => item.title))
      .toEqual(["已发布文章", "待确认旧文"]);
    expect(initial.items.find((item) => item.relativePath === "posts/published/index.md")?.attributionEvidence).toContain(accountA.displayName);

    const selected = service.saveSelection(accountA.id, {
      selectedPaths: ["posts/published/index.md", "posts/unassigned/index.md", "posts/archived/index.md"],
      authorConfirmedPaths: ["posts/unassigned/index.md", "posts/archived/index.md"]
    });

    const narrowed = service.list(accountA.id, { createdFrom: "2025-01-02", createdTo: "2025-01-03" });
    expect(narrowed.items.map((item) => item.relativePath)).not.toContain("posts/archived/index.md");
    expect(narrowed.selectedPaths).toContain("posts/archived/index.md");
    expect(narrowed.authorConfirmedPaths).toContain("posts/archived/index.md");

    expect(selected.items.find((item) => item.relativePath === "posts/published/index.md")).toMatchObject({ selected: true, attribution: "published_record" });
    expect(selected.items.find((item) => item.relativePath === "posts/unassigned/index.md")).toMatchObject({ selected: true, attribution: "author_confirmed" });
    expect(selected.items.find((item) => item.relativePath === "posts/archived/index.md")).toMatchObject({ selected: true, attribution: "author_confirmed" });
    expect(selected.items.some((item) => item.relativePath.includes("/draft/"))).toBe(false);
    expect(service.list(accountB.id).items.find((item) => item.relativePath === "posts/unassigned/index.md")).toMatchObject({ selected: false, attribution: "unassigned" });
  });

  it("rejects missing, draft, or unconfirmed samples without partially changing the selected set", () => {
    writeArticle("published", "已发布文章", "published");
    recordWechatPublication(accountA.id, "posts/published/index.md");
    service.saveSelection(accountA.id, { selectedPaths: ["posts/published/index.md"], authorConfirmedPaths: [] });
    writeArticle("draft", "草稿", "draft");
    writeArticle("archived", "归档文章", "published", true);

    expect(() => service.saveSelection(accountA.id, {
      selectedPaths: ["posts/published/index.md", "posts/draft/index.md"],
      authorConfirmedPaths: ["posts/draft/index.md"]
    })).toThrow(/草稿|不能作为/);
    expect(() => service.saveSelection(accountA.id, {
      selectedPaths: ["posts/missing/index.md"], authorConfirmedPaths: ["posts/missing/index.md"]
    })).toThrow();
    expect(service.list(accountA.id).items.find((item) => item.relativePath === "posts/published/index.md")?.selected).toBe(true);
    const archived = service.saveSelection(accountA.id, {
      selectedPaths: ["posts/archived/index.md"], authorConfirmedPaths: ["posts/archived/index.md"]
    });
    expect(archived.items.find((item) => item.relativePath === "posts/archived/index.md")).toMatchObject({ selected: true, attribution: "author_confirmed" });
  });

  it("does not overwrite the account's manually entered writing style", () => {
    accounts.updateProfile(accountA.id, { ...accountA.profile, writingStyle: "手动风格" });
    writeArticle("old", "旧文章", null);
    service.saveSelection(accountA.id, { selectedPaths: ["posts/old/index.md"], authorConfirmedPaths: ["posts/old/index.md"] });
    expect(accounts.requireAccount(accountA.id).profile.writingStyle).toBe("手动风格");
  });

  it("allows author-confirmed completed VitePress articles marked publish:false while excluding explicit drafts", () => {
    contentSources.setSource(workspace.id, articleRoot, "vitepress");
    writeVitePressArticle("unpublished", "尚未发布但已完成", "false");
    writeVitePressArticle("draft", "明确草稿", "draft");

    const candidates = service.list(accountA.id);
    expect(candidates.items.map((item) => item.relativePath)).toContain("posts/unpublished/index.md");
    expect(candidates.items.map((item) => item.relativePath)).not.toContain("posts/draft/index.md");
    expect(candidates.items.find((item) => item.relativePath === "posts/unpublished/index.md"))
      .toMatchObject({ articleStatus: null, attribution: "unassigned" });

    const selected = service.saveSelection(accountA.id, {
      selectedPaths: ["posts/unpublished/index.md"],
      authorConfirmedPaths: ["posts/unpublished/index.md"]
    });
    expect(selected.items.find((item) => item.relativePath === "posts/unpublished/index.md"))
      .toMatchObject({ selected: true, attribution: "author_confirmed" });
  });

  function writeArticle(slug: string, title: string, status: "published" | "draft" | null, archived = false, created = "2025-01-01"): void {
    const directory = path.join(articleRoot, "posts", slug);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "index.md"), `---\ntitle: ${title}\ncreated: ${created}\n${status ? `status: ${status}\n` : ""}${archived ? "archived: true\n" : ""}---\n\n# ${title}\n\n正文内容。`, "utf8");
  }

  function writeVitePressArticle(slug: string, title: string, publish: "false" | "draft"): void {
    const directory = path.join(articleRoot, "posts", slug);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "index.md"), `---\ntitle: ${title}\ncreated: 2026-09-25\npublish: ${publish}\n---\n\n# ${title}\n\n正文内容。`, "utf8");
  }

  function recordWechatPublication(accountId: string, sourceRelativePath: string): void {
    const id = randomUUID();
    database.connection.prepare(`INSERT INTO wechat_publish_jobs
      (id, workspace_id, account_id, source_relative_path, mode, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'publish', '文章', 'published', ?, ?)`)
      .run(id, workspace.id, accountId, sourceRelativePath, new Date().toISOString(), new Date().toISOString());
  }
});
