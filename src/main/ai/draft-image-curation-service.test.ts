import { describe, expect, it, vi } from "vitest";
import { DraftImageCurationService } from "./draft-image-curation-service";

const candidate = {
  imageUrl: "https://images.example.test/diagram.png",
  thumbnailUrl: null,
  caption: "Markdown heading hierarchy diagram",
  sourceUrl: "https://example.test/markdown-guide",
  sourceTitle: "Markdown Guide"
};

function fixture(options?: { action?: "none" | "search"; anchor?: string; reviewed?: boolean | "unreviewed" }) {
  const generateStructured = vi.fn()
    .mockResolvedValueOnce({ value: { action: options?.action ?? "none", query: "markdown heading hierarchy", count: 1, reason: "已有内容足以说明操作，无需额外配图。" } })
    .mockResolvedValueOnce({ value: { images: [{ candidateIndex: 0, anchor: options?.anchor ?? "Headings show the structure of an article.", alt: "Heading hierarchy" }] } });
  const webSearch = { searchImages: vi.fn(async () => [candidate]) };
  const imageReview = { review: vi.fn(async (_query: string, items: typeof candidate[]) => ({ provider: "vision", items: items.map((item) => ({ ...item, review: { status: options?.reviewed === false ? "uncertain" as const : options?.reviewed === "unreviewed" ? "unreviewed" as const : "accepted" as const, score: 0.99, reason: "Relevant." } })) })) };
  const remoteImages = { importForArticle: vi.fn(async () => ({ assetUrl: "./assets/diagram.png" })) };
  const contentSources = {};
  const service = new DraftImageCurationService({ generateStructured } as never, webSearch as never, imageReview as never, remoteImages as never, contentSources as never);
  return { service, generateStructured, webSearch, imageReview, remoteImages };
}

describe("DraftImageCurationService", () => {
  it("leaves the draft untouched when the model decides no external image is useful", async () => {
    const { service, webSearch, remoteImages } = fixture({ action: "none" });
    const markdown = "# Article\n\nHeadings show the structure of an article.";
    const result = await service.curate({ workspaceId: "workspace", relativePath: "posts/article/index.md", context: { topic: "Markdown", writingStyle: "", visualTraits: "likes diagrams", practiceEvidence: "" }, markdown });
    expect(result).toMatchObject({
      markdown,
      inserted: 0,
      outcome: "not_added",
      reason: "已有内容足以说明操作，无需额外配图。"
    });
    expect(webSearch.searchImages).not.toHaveBeenCalled();
    expect(remoteImages.importForArticle).not.toHaveBeenCalled();
  });

  it("uses an existing practice screenshot as a reason not to duplicate images", async () => {
    const { service, generateStructured, webSearch, remoteImages } = fixture({ action: "none" });
    const markdown = "# Article\n\n## 实测\n\n![本机实践截图](./assets/practice.png)\n\n命令输出了预期结果。";
    const result = await service.curate({ workspaceId: "workspace", relativePath: "posts/article/index.md",
      context: { topic: "本机实测", writingStyle: "", visualTraits: "操作后附截图", practiceEvidence: "本机截图：./assets/practice.png" }, markdown });

    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("已有图片（包括本次实践截图）足够时选择 none");
    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("./assets/practice.png");
    expect(result.markdown).toBe(markdown);
    expect(webSearch.searchImages).not.toHaveBeenCalled();
    expect(remoteImages.importForArticle).not.toHaveBeenCalled();
  });

  it("searches, reviews, imports and attributes a useful image without asking for per-image confirmation", async () => {
    const { service, generateStructured, webSearch, imageReview, remoteImages } = fixture({ action: "search" });
    const markdown = "# Article\n\nHeadings show the structure of an article.\n\nMore text.";
    const result = await service.curate({ workspaceId: "workspace", relativePath: "posts/article/index.md", context: { topic: "Markdown", writingStyle: "", visualTraits: "Uses diagrams near explanations.", practiceEvidence: "" }, markdown });
    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("没有实践截图不代表文章有缺陷");
    expect(generateStructured.mock.calls[0]?.[0].prompt).toContain("配图偏好只是选择依据，不是每篇文章必须满足的要求");
    expect(webSearch.searchImages).toHaveBeenCalledWith("markdown heading hierarchy", 4);
    expect(imageReview.review).toHaveBeenCalledOnce();
    expect(remoteImages.importForArticle).toHaveBeenCalledWith("workspace", "posts/article/index.md", candidate.imageUrl);
    expect(result.inserted).toBe(1);
    expect(result.markdown).toContain("![Heading hierarchy](./assets/diagram.png)");
    expect(result.markdown).toContain("[图片来源：Markdown Guide](https://example.test/markdown-guide)");
    expect(result).toMatchObject({ outcome: "added", reason: expect.stringContaining("发布前核对") });
  });

  it("does not import unreviewed candidates or insert against an ambiguous anchor", async () => {
    const uncertain = fixture({ action: "search", reviewed: false });
    const markdown = "# Article\n\nHeadings show the structure of an article.";
    const uncertainResult = await uncertain.service.curate({ workspaceId: "workspace", relativePath: "posts/a/index.md", context: { topic: "Markdown", writingStyle: "", visualTraits: "", practiceEvidence: "" }, markdown });
    expect(uncertainResult.inserted).toBe(0);
    expect(uncertain.remoteImages.importForArticle).not.toHaveBeenCalled();

    const ambiguous = fixture({ action: "search", anchor: "This paragraph does not exist in the article." });
    const ambiguousResult = await ambiguous.service.curate({ workspaceId: "workspace", relativePath: "posts/a/index.md", context: { topic: "Markdown", writingStyle: "", visualTraits: "", practiceEvidence: "" }, markdown });
    expect(ambiguousResult.inserted).toBe(0);
    expect(ambiguous.remoteImages.importForArticle).not.toHaveBeenCalled();
  });

  it("records an empty candidate search without claiming that an image was added", async () => {
    const { service, webSearch, imageReview, remoteImages } = fixture({ action: "search" });
    webSearch.searchImages.mockResolvedValueOnce([]);
    const markdown = "# Article\n\nA paragraph that may benefit from an image.";
    const result = await service.curate({ workspaceId: "workspace", relativePath: "posts/a/index.md",
      context: { topic: "Markdown", writingStyle: "", visualTraits: "", practiceEvidence: "" }, markdown });

    expect(result).toMatchObject({ markdown, inserted: 0, outcome: "not_added", reason: "没有找到相关性和来源都合适的图片。" });
    expect(imageReview.review).toHaveBeenCalledWith("markdown heading hierarchy", []);
    expect(remoteImages.importForArticle).not.toHaveBeenCalled();
  });

  it("preserves the draft and reports an unavailable outcome when image search fails", async () => {
    const { service, webSearch, imageReview, remoteImages } = fixture({ action: "search" });
    webSearch.searchImages.mockRejectedValueOnce(new Error("image provider unavailable"));
    const markdown = "# Article\n\n正文仍然可用。";
    const result = await service.curate({ workspaceId: "workspace", relativePath: "posts/a/index.md",
      context: { topic: "Markdown", writingStyle: "", visualTraits: "", practiceEvidence: "" }, markdown });

    expect(result).toMatchObject({ markdown, inserted: 0, outcome: "unavailable", reason: "联网配图搜索未完成：image provider unavailable" });
    expect(imageReview.review).not.toHaveBeenCalled();
    expect(remoteImages.importForArticle).not.toHaveBeenCalled();
  });

  it("allows the drafting model to curate candidates when optional visual review is disabled", async () => {
    const { service, remoteImages } = fixture({ action: "search", reviewed: "unreviewed" });
    const result = await service.curate({ workspaceId: "workspace", relativePath: "posts/a/index.md", context: { topic: "Markdown", writingStyle: "", visualTraits: "", practiceEvidence: "" }, markdown: "# Article\n\nHeadings show the structure of an article." });
    expect(result.inserted).toBe(1);
    expect(result.reason).toContain("图片内容仍需发布前核对");
    expect(remoteImages.importForArticle).toHaveBeenCalledOnce();
  });
});
