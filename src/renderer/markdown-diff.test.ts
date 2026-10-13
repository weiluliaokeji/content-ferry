import { describe, expect, it } from "vitest";
import { diffMarkdownLines, trimMarkdownDiffContext } from "./markdown-diff";

describe("diffMarkdownLines", () => {
  it("shows inserted, removed, and unchanged lines with their line numbers", () => {
    const diff = diffMarkdownLines("# Guide\n\nold step\n\n## Next", "# Guide\n\nnew step\nextra detail\n\n## Next");

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.lines).toEqual([
      { kind: "context", text: "# Guide", oldLine: 1, newLine: 1 },
      { kind: "context", text: "", oldLine: 2, newLine: 2 },
      { kind: "removed", text: "old step", oldLine: 3 },
      { kind: "added", text: "new step", newLine: 3 },
      { kind: "added", text: "extra detail", newLine: 4 },
      { kind: "context", text: "", oldLine: 4, newLine: 5 },
      { kind: "context", text: "## Next", oldLine: 5, newLine: 6 }
    ]);
  });

  it("normalizes Windows line endings and reports identical content", () => {
    const diff = diffMarkdownLines("# 标题\r\n正文\r\n", "# 标题\n正文\n");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });
});

describe("trimMarkdownDiffContext", () => {
  it("collapses long unchanged areas around modified lines", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 10", "changed line 10");
    const trimmed = trimMarkdownDiffContext(diffMarkdownLines(before, after), 2);

    expect(trimmed.some((line) => line.kind === "omitted" && line.count > 0)).toBe(true);
    expect(trimmed.some((line) => line.kind === "removed" && line.text === "line 10")).toBe(true);
    expect(trimmed.some((line) => line.kind === "added" && line.text === "changed line 10")).toBe(true);
  });
});
