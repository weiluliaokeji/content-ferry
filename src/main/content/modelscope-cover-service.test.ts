import { describe, expect, it } from "vitest";
import { normalizeCoverImagePrompt } from "./modelscope-cover-service";

describe("cover image prompt", () => {
  it("passes the user's confirmed prompt through without adding article content or restrictions", () => {
    const prompt = "  极简摄影风格，一艘渡船穿过蓝色数据河流，画面右侧带文章标题  ";
    expect(normalizeCoverImagePrompt(prompt)).toBe("极简摄影风格，一艘渡船穿过蓝色数据河流，画面右侧带文章标题");
  });

  it("requires a confirmed prompt before invoking the image model", () => {
    expect(() => normalizeCoverImagePrompt("  ")).toThrow("请先让 AI 根据正文生成封面提示词");
  });
});
