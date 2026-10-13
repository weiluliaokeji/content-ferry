import { describe, expect, it } from "vitest";
import { describeDraftDepth, extractDraftSection, planDraftDepth, splitDraftSections, summarizeDraftForContinuity } from "./draft-depth-planner";

describe("draft depth planning", () => {
  it("carries the outline's reader promises without guessing a genre from headings", () => {
    const plan = planDraftDepth({
      outline: "# 一篇文章\n## 适合解决什么问题\n- 比较目标读者的两种选择\n## 个人观察\n- 区分作者经历和推测"
    });
    expect(plan.level).toBe("adaptive");
    expect(plan.reason).toContain("指南与实践文章按需展开前提、操作、结果判断和边界");
    expect(plan.sections[0].outlinePoints).toEqual(["比较目标读者的两种选择"]);
    expect(plan.sections[0].purpose).not.toContain("症状");
    expect(plan.sections[1].outlinePoints).toEqual(["区分作者经历和推测"]);
    expect(plan).not.toHaveProperty("approximateCharacters");
  });

  it("honors an explicit concise preference without dropping outline obligations", () => {
    const plan = planDraftDepth({ outline: "## 操作步骤\n1. 准备环境\n2. 验证结果", preference: "concise" });
    expect(plan.level).toBe("concise");
    expect(plan.sections[0].outlinePoints).toEqual(["准备环境", "验证结果"]);
    expect(plan.noPaddingRule).toContain("不以字数");
  });

  it("turns each depth choice into distinct, task-relevant guidance without word quotas", () => {
    expect(describeDraftDepth("adaptive")).toContain("概念和观点内容要讲清机制、论据及适用边界，不套用操作模板");
    expect(describeDraftDepth("adaptive")).toContain("不按标题关键词推断体裁或分配固定字数");
    expect(describeDraftDepth("adaptive")).toContain("不能因一句话提到要点就判定完成");
    expect(describeDraftDepth("adaptive")).toContain("复杂任务充分展开");
    expect(describeDraftDepth("concise")).toContain("不得省略完成核心任务所必需的前提");
    expect(describeDraftDepth("standard")).toContain("在易读和充分说明之间平衡");
    expect(describeDraftDepth("detailed")).toContain("预期结果与判断方法");
    expect(describeDraftDepth("detailed")).toContain("不硬塞教程内容");
  });

  it("keeps H3 reader promises under the H2 section that drafting can verify", () => {
    const plan = planDraftDepth({
      outline: "# 操作指南\n\n## 操作\n### Windows\n- 给出可执行命令\n### 验证\n- 说明如何判断结果"
    });
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0]).toMatchObject({
      heading: "操作",
      outlinePoints: ["给出可执行命令", "说明如何判断结果"]
    });
  });

  it("ignores Markdown headings and commands inside fenced examples when planning sections", () => {
    const plan = planDraftDepth({
      outline: "# Scoop 指南\n\n## 安装与验证\n- 说明如何判断安装结果\n\n```markdown\n## 示例中的标题\n```\n\n```powershell\nscoop list\n```"
    });
    expect(plan.sections).toEqual([{
      heading: "安装与验证",
      purpose: "完成已确认提纲在“安装与验证”下列出的内容；根据读者任务展开必要的依据、步骤、示例和限制。",
      outlinePoints: ["说明如何判断安装结果"]
    }]);
  });

  it("keeps subordinate headings inside their parent section and rejects sibling output", () => {
    const sections = splitDraftSections("# 标题\n\n## 安装\n- 前提\n### Windows\n- 命令\n```sh\n## 这是命令输出\n```\n## 使用\n- 验证");
    expect(sections).toHaveLength(2);
    expect(sections[0].outlineMarkdown).toContain("### Windows");
    expect(sections[0].outlineMarkdown).toContain("## 这是命令输出");
    expect(sections[1].outlineMarkdown).not.toContain("Windows");
    expect(extractDraftSection("# 标题\n\n开篇\n\n## 安装\n正文", "安装", true)).toContain("开篇");
    expect(extractDraftSection("# 标题\n\n## 使用\n正文", "使用", false)).toBe("## 使用\n正文");
    expect(() => extractDraftSection("# 标题\n\n## 安装\n正文\n\n## 使用\n正文", "安装", true)).toThrow("章节“安装”");
    expect(extractDraftSection("# 标题\n\n## 安装\n```sh\n## 命令输出\n```", "安装", true)).toContain("## 命令输出");
  });

  it("summarizes all completed sections and keeps the latest transition without passing the whole growing draft", () => {
    const draft = [
      "# 指南",
      "## 选择工具",
      "先比较当前任务的风险和成本。选择应以实际需求为准。",
      "## 准备环境",
      "先检查系统与权限。准备工作完成后再执行安装。",
      "## 安装验证",
      "运行安装步骤后观察命令输出。确认版本和路径符合预期。"
    ].join("\n\n");

    const continuity = summarizeDraftForContinuity(draft);
    expect(continuity).toContain("## 选择工具");
    expect(continuity).toContain("比较当前任务的风险和成本");
    expect(continuity).toContain("## 准备环境");
    expect(continuity).toContain("准备工作完成后再执行安装");
    expect(continuity).toContain("## 安装验证");
    expect(continuity).toContain("确认版本和路径符合预期");
    expect(continuity.length).toBeLessThanOrEqual(6_000);
  });
});
