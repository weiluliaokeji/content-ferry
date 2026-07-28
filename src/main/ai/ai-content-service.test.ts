import { describe, it, expect } from "vitest";
import {
  buildResearchPrompt,
  buildResearchFollowUpPrompt,
  buildOutlinePrompt,
  buildDraftPrompt,
  buildRevisionPrompt,
  type CreationContext
} from "./ai-content-service";

function baseContext(overrides: Partial<CreationContext> = {}): CreationContext {
  return {
    topic: "AI 写作工具横评",
    objective: "",
    audience: "",
    angle: "",
    sourceNotes: "",
    positioning: "",
    prohibitedTopics: "",
    writingStyle: "",
    regularColumns: "",
    outlineMarkdown: null,
    researchSources: [],
    ...overrides
  };
}

describe("prompt builders omit empty optional fields", () => {
  it("research prompt drops 写作目标/目标读者/核心角度 when not filled", () => {
    const prompt = buildResearchPrompt(baseContext());
    expect(prompt).toContain("文章主题：AI 写作工具横评");
    expect(prompt).not.toContain("写作目标：");
    expect(prompt).not.toContain("目标读者：");
    expect(prompt).not.toContain("核心角度：");
    expect(prompt).not.toContain("未单独填写");
  });

  it("research prompt keeps a field once it is filled", () => {
    const prompt = buildResearchPrompt(baseContext({ objective: "帮读者选型" }));
    expect(prompt).toContain("写作目标：帮读者选型");
    expect(prompt).not.toContain("目标读者：");
    expect(prompt).not.toContain("核心角度：");
  });

  it("research follow-up prompt omits empty context fields", () => {
    const prompt = buildResearchFollowUpPrompt(baseContext(), "补查价格");
    expect(prompt).toContain("用户的补研要求：\n补查价格");
    expect(prompt).not.toContain("写作目标：");
    expect(prompt).not.toContain("未单独填写");
  });

  it("outline prompt omits all empty optional fields", () => {
    const prompt = buildOutlinePrompt(baseContext());
    expect(prompt).toContain("文章主题：AI 写作工具横评");
    expect(prompt).not.toContain("写作目标：");
    expect(prompt).not.toContain("账号定位：");
    expect(prompt).not.toContain("写作风格：");
  });

  it("draft prompt omits empty optional fields but always shows topic + outline", () => {
    const prompt = buildDraftPrompt(baseContext({ outlineMarkdown: "# 大纲\n- 一" }));
    expect(prompt).toContain("文章主题：AI 写作工具横评");
    expect(prompt).toContain("已确认提纲：\n# 大纲");
    expect(prompt).not.toContain("写作目标：");
    expect(prompt).not.toContain("账号定位：");
  });

  it("revision prompt omits empty 目标读者/账号定位 etc.", () => {
    const prompt = buildRevisionPrompt(baseContext(), "正文", "朱雀低风险", "去套路化");
    expect(prompt).toContain("文章主题：AI 写作工具横评");
    expect(prompt).not.toContain("目标读者：");
    expect(prompt).not.toContain("账号定位：");
    expect(prompt).toContain("作者希望重点修改：去套路化");
  });
});
