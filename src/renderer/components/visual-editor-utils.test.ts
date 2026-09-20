import { describe, expect, it } from "vitest";

import { centeredSuggestionScrollTop, shouldReportVisualEditorSelection } from "./visual-editor-utils";

describe("visual editor suggestion interactions", () => {
  it("does not report a selection when mouseup originated in a suggestion bubble", () => {
    expect(shouldReportVisualEditorSelection(true)).toBe(false);
  });

  it("continues to report selections from the article body", () => {
    expect(shouldReportVisualEditorSelection(false)).toBe(true);
  });

  it("centers the suggestion anchor in the article canvas", () => {
    expect(centeredSuggestionScrollTop(120, 100, 600, 500, 80)).toBe(260);
  });
});
