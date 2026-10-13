import { describe, expect, it } from "vitest";
import { applyDraftTextEdits } from "./draft-text-edits";

describe("draft local text edits", () => {
  const draft = "# 指南\n\n开篇。\n\n## 安装\n旧安装说明。\n\n## 验证\n保留这段真实观察。";

  it("changes only the uniquely anchored passage", () => {
    expect(applyDraftTextEdits(draft, [{ original: "旧安装说明。", replacement: "先检查条件，再按已核对的步骤安装。" }]))
      .toBe("# 指南\n\n开篇。\n\n## 安装\n先检查条件，再按已核对的步骤安装。\n\n## 验证\n保留这段真实观察。");
  });

  it("rejects stale, overlapping and structural edits", () => {
    expect(() => applyDraftTextEdits(draft, [{ original: "不存在", replacement: "新文" }])).toThrow("唯一定位");
    expect(() => applyDraftTextEdits(draft, [
      { original: "旧安装说明。", replacement: "新说明。" },
      { original: "安装\n旧安装说明。", replacement: "安装\n另一段。" }
    ])).toThrow("重叠");
    expect(() => applyDraftTextEdits(draft, [{ original: "## 安装\n旧安装说明。", replacement: "## 新标题\n新说明。" }])).toThrow("章节结构");
    expect(() => applyDraftTextEdits(draft, [{ original: "## 安装\n旧安装说明。\n\n## 验证", replacement: "## 安装\n压缩。\n\n## 验证" }])).toThrow("跨越多个");
    expect(() => applyDraftTextEdits(draft, [{ original: draft, replacement: "# 指南\n压缩版" }])).toThrow("小于整篇");
  });
});
