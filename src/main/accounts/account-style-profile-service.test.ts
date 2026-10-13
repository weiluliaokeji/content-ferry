import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProvider } from "../ai/model-provider";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase } from "../db/database";
import { AccountRepository } from "./account-repository";
import { AccountStyleSampleService } from "./account-style-sample-service";
import { AccountStyleProfileService, type AccountStyleProfile } from "./account-style-profile-service";

describe("AccountStyleProfileService", () => {
  let database: ReturnType<typeof openInMemoryDatabase>;
  let directory: string;
  let accounts: AccountRepository;
  let contentSources: ContentSourceService;
  let accountId: string;
  let service: AccountStyleProfileService;
  let generateStructured: ReturnType<typeof vi.fn>;
  let manualWritingStyle: string;

  beforeEach(() => {
    database = openInMemoryDatabase();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-style-profile-"));
    const workspace = new AccountRepository(database.connection).getOrCreateDefaultWorkspace();
    accounts = new AccountRepository(database.connection);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "wechat_official", displayName: "风格测试账号" });
    accountId = account.id;
    manualWritingStyle = "手动设置：清楚、克制";
    accounts.updateProfile(accountId, { ...account.profile, writingStyle: manualWritingStyle });
    contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, directory, "plain");
    for (const [name, title, text] of [
      ["first", "工具实测", "先说明使用条件，再列出观察结果。结论保持克制，并指出限制。"],
      ["second", "方法拆解", "从真实问题开始，按步骤解释做法。每个判断都说明适用范围。"]
    ]) {
      const articleDirectory = path.join(directory, "posts", name);
      fs.mkdirSync(articleDirectory, { recursive: true });
      fs.writeFileSync(path.join(articleDirectory, "index.md"), `---\ntitle: ${title}\nstatus: published\n---\n\n${text}`);
    }
    const samples = new AccountStyleSampleService(database.connection, accounts, contentSources);
    samples.saveSelection(accountId, {
      selectedPaths: ["posts/first/index.md", "posts/second/index.md"],
      authorConfirmedPaths: ["posts/first/index.md", "posts/second/index.md"]
    });
    const extracted: AccountStyleProfile = { commonVoice: "具体、克制，先交代条件再给判断。", genreTraits: [{ genre: "实测", traits: "交代环境、步骤和限制。" }], visualTraits: "实测文章通常配一张操作截图，并紧跟在对应步骤之后。" };
    generateStructured = vi.fn(async (request: { parse(value: unknown): unknown }) => ({ value: request.parse(extracted), provider: "test", model: "test-model", usage: null }));
    const provider = { generateStructured } as unknown as ModelProvider;
    service = new AccountStyleProfileService(database.connection, accounts, contentSources, provider);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("keeps extraction as a reviewable proposal until the author confirms it", async () => {
    const proposal = await service.createProposal(accountId);
    expect(proposal.sampleSources).toHaveLength(2);
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("visualTraits");
    expect(service.getState(accountId)).toMatchObject({ active: null, pendingProposal: { id: proposal.id } });

    const edited = service.updateProposal(accountId, proposal.id, { ...proposal.profile, commonVoice: "作者检查后的风格描述。" });
    expect(edited.profile.commonVoice).toBe("作者检查后的风格描述。");
    const version = service.confirmProposal(accountId, proposal.id);
    expect(version).toMatchObject({ versionNumber: 1, profile: { commonVoice: "作者检查后的风格描述。", visualTraits: "实测文章通常配一张操作截图，并紧跟在对应步骤之后。" }, sampleSources: proposal.sampleSources });
    expect(service.getState(accountId)).toMatchObject({ active: { id: version.id }, versions: [{ id: version.id }], pendingProposal: null });
    expect(accounts.requireAccount(accountId).profile.writingStyle).toBe(manualWritingStyle);
  });

  it("keeps the active version unchanged when a proposal is rejected and versions history on confirmation", async () => {
    const first = await service.createProposal(accountId);
    const v1 = service.confirmProposal(accountId, first.id);
    const rejected = await service.createProposal(accountId);
    service.rejectProposal(accountId, rejected.id);
    expect(service.getState(accountId).active?.id).toBe(v1.id);
    expect(service.getState(accountId).versions).toHaveLength(1);

    const next = await service.createProposal(accountId);
    const v2 = service.confirmProposal(accountId, next.id);
    expect(v2.versionNumber).toBe(2);
    expect(service.getState(accountId)).toMatchObject({ active: { id: v2.id }, versions: [{ id: v2.id }, { id: v1.id }] });
  });

  it("saves direct edits as a new active version while preserving provenance and manual writing style", async () => {
    const proposal = await service.createProposal(accountId);
    const first = service.confirmProposal(accountId, proposal.id);
    const edited = service.updateActiveProfile(accountId, first.id, {
      ...first.profile,
      commonVoice: "作者手工调整后的风格。",
      visualTraits: "正文遇到操作步骤时插入截图。"
    });
    expect(edited).toMatchObject({ versionNumber: 2, profile: { commonVoice: "作者手工调整后的风格。", visualTraits: "正文遇到操作步骤时插入截图。" }, sampleSources: first.sampleSources });
    expect(service.getState(accountId)).toMatchObject({ active: { id: edited.id }, versions: [{ id: edited.id }, { id: first.id }] });
    expect(accounts.requireAccount(accountId).profile.writingStyle).toBe(manualWritingStyle);
    expect(() => service.updateActiveProfile(accountId, first.id, first.profile)).toThrow("风格档案已被其他操作更新");
  });

  it("does not extract from fewer than two samples", async () => {
    database.connection.prepare("DELETE FROM account_style_samples WHERE account_id = ? AND source_relative_path = ?")
      .run(accountId, "posts/second/index.md");
    await expect(service.createProposal(accountId)).rejects.toThrow("至少选择 2 篇");
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("does not confirm a candidate after one of its source samples has been removed", async () => {
    const proposal = await service.createProposal(accountId);
    const samples = new AccountStyleSampleService(database.connection, accounts, contentSources);
    samples.saveSelection(accountId, { selectedPaths: ["posts/first/index.md"], authorConfirmedPaths: ["posts/first/index.md"] });
    expect(() => service.confirmProposal(accountId, proposal.id)).toThrow("提炼所依据的代表文章已被移除");
    expect(service.getState(accountId).active).toBeNull();
  });
});
