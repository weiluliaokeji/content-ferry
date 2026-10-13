import { describe, expect, it, vi } from "vitest";
import { ChannelDraftReviewService } from "./channel-draft-review-service";
import type { GenerateStructuredRequest, GenerateStructuredResult, ModelProvider } from "./model-provider";
import type { WebSearchClient } from "./web-search";

describe("channel draft independent review", () => {
  it("checks a rewrite against its source and permits review-only public searches", async () => {
    const calls: GenerateStructuredRequest<unknown>[] = [];
    let reviewCall = 0;
    const search = vi.fn(async () => [{ title: "平台官方说明", url: "https://example.com/platform", snippet: "官方格式说明。" }]);
    const provider = {
      id: "channel-review-test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
        calls.push(request as GenerateStructuredRequest<unknown>);
        reviewCall += 1;
        return { value: request.parse(reviewCall === 1
          ? { findings: [{ severity: "blocker", title: "平台事实需核验", detail: "确认一项时效性平台规则。" }], evidenceUsed: [], summary: "需要核验。", searchQueries: ["平台官方说明"] }
          : { findings: [], evidenceUsed: ["https://example.com/platform"], summary: "渠道稿符合边界。", searchQueries: [] }), provider: this.id, model: "reviewer", usage: null };
      },
      async webResearch() { throw new Error("review should not use synthesis research"); }
    } as unknown as ModelProvider;
    const outcome = await new ChannelDraftReviewService(provider, { search } as unknown as WebSearchClient).review({
      platform: "CSDN", title: "适配文章", markdown: "# 适配文章\n\n渠道稿正文。", sourceMarkdown: "# 原文章\n\n原文事实与限制。",
      positioning: "技术实践", audience: "开发者", writingStyle: "具体克制", prohibitedTopics: "夸大承诺"
    });
    expect(outcome).toMatchObject({ status: "passed", repairRounds: 0, evidenceUsed: ["https://example.com/platform"] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ skillId: "content-review", prependInstructions: true });
    expect(calls[0].prompt).toContain("原文事实与限制");
    expect(calls[0].prompt).toContain("评审阶段：渠道稿");
    expect(calls[1].prompt).toContain("评审期间实际检索的网页");
    expect(search).toHaveBeenCalledWith("平台官方说明", 5);
  });

  it("repairs blockers using only the source and requires a confirming review", async () => {
    let reviewCall = 0;
    let revisionCall = 0;
    const provider = {
      id: "channel-review-test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
        if (request.task === "revision") {
          revisionCall += 1;
          expect(request).toMatchObject({ skillId: "content-review", prependInstructions: true });
          expect(request.prompt).toContain("源文章");
          return { value: request.parse({ markdown: "# 渠道稿\n\n已删除来源无法支持的绝对化说法。" }), provider: this.id, model: "writer", usage: null };
        }
        reviewCall += 1;
        return { value: request.parse(reviewCall === 1
          ? { findings: [{ severity: "blocker", title: "绝对化结论", detail: "源文章没有支持该保证。" }], evidenceUsed: [], summary: "需要修订。", searchQueries: [] }
          : { findings: [], evidenceUsed: [], summary: "修订后已符合依据边界。", searchQueries: [] }), provider: this.id, model: "reviewer", usage: null };
      },
      async webResearch() { throw new Error("unexpected webResearch"); }
    } as unknown as ModelProvider;
    const outcome = await new ChannelDraftReviewService(provider, { search: vi.fn() } as unknown as WebSearchClient).review({
      platform: "博客园", title: "渠道稿", markdown: "# 渠道稿\n\n绝对保证。", sourceMarkdown: "# 原稿\n\n有限条件。",
      positioning: "", audience: "", writingStyle: "", prohibitedTopics: ""
    });
    expect(outcome).toMatchObject({ status: "passed", repairRounds: 1, markdown: "# 渠道稿\n\n已删除来源无法支持的绝对化说法。" });
    expect(revisionCall).toBe(1);
    expect(reviewCall).toBe(2);
  });
});
