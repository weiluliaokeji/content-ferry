import { describe, expect, it } from "vitest";
import { findChannelCrossPromotion } from "./channel-cross-promotion";

describe("findChannelCrossPromotion", () => {
  it("allows ordinary mentions and headings that are not promotion", () => {
    expect(findChannelCrossPromotion("## 延伸阅读\n\n参考文档。\n\n公众号原文是术语说明的一部分。"))
      .toBeNull();
  });

  it("returns the exact public account promotion that should be removed", () => {
    expect(findChannelCrossPromotion("关注公众号获取更多教程。"))
      .toBe("关注公众号");
  });

  it("blocks a linked public account original article", () => {
    expect(findChannelCrossPromotion("[公众号原文](https://example.com/article)"))
      .toBe("[公众号原文](https://example.com/article)");
  });
});
