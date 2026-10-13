import { describe, expect, it } from "vitest";
import { buildPlannerPrompt, buildResearchSynthesisPrompt, type WebResearchContext } from "./research-prompts";

const context: WebResearchContext = {
  topic: "Scoop 使用指南",
  objective: "核实安装和日常使用",
  audience: "Windows 开发者",
  angle: "可复现的操作指南",
  positioning: "实用",
  sourceNotes: ""
};

describe("research prompt context bounds", () => {
  it("uses the normalized article topic for queries while retaining the original author wording as scope", () => {
    const prompt = buildPlannerPrompt({
      ...context,
      topic: "Scoop使用指南与实践",
      creationIdea: "编写一篇关于《Scoop使用指南与实践》的公众号文章"
    }, [], 1, 4);

    expect(prompt).toContain("文章主题：Scoop使用指南与实践");
    expect(prompt).toContain("作者原始创作要求（用于理解范围；检索词应围绕文章主题提炼）：编写一篇关于《Scoop使用指南与实践》的公众号文章");
    expect(prompt).toContain("不要把“编写/写一篇/公众号文章”等写作指令连同整句复制进查询");
  });

  it("bounds the actual search snippet rendered into each planner round", () => {
    const prompt = buildPlannerPrompt(context, [{
      title: "官方文档",
      url: "https://example.com/docs",
      snippet: "x".repeat(3_000),
      sourceType: "official"
    }], 2, 5);

    expect(prompt).toContain("https://example.com/docs");
    expect(prompt).toContain(`${"x".repeat(400)}…`);
    expect(prompt).not.toContain("x".repeat(401));
  });

  it("keeps verified body excerpts separately bounded for synthesis", () => {
    const prompt = buildResearchSynthesisPrompt(context, [{
      title: "官方文档",
      url: "https://example.com/docs",
      snippet: "search snippet",
      bodyExcerpt: "y".repeat(2_000),
      sourceType: "official",
      capturedAt: "2026-10-06T00:00:00.000Z",
      sha256: "a".repeat(64)
    }], "研究资料规则");

    expect(prompt).toContain("核验时间: 2026-10-06T00:00:00.000Z");
    expect(prompt).toContain(`\n${"y".repeat(1_200)}…\n</untrusted-source-body>`);
    expect(prompt).not.toContain("y".repeat(1_201));
  });
});
