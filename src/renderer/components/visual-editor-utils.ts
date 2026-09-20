/**
 * Suggestion bubbles are mounted inside the editor root, but their controls
 * are not part of the article selection flow. A mouseup from a bubble must
 * not clear the current selection and trigger an editor rerender before the
 * button's click handler runs.
 */
export function shouldReportVisualEditorSelection(isSuggestionInteraction: boolean): boolean {
  return !isSuggestionInteraction;
}

export function centeredSuggestionScrollTop(
  currentScrollTop: number,
  containerTop: number,
  containerHeight: number,
  targetTop: number,
  targetHeight: number
): number {
  return Math.max(0, currentScrollTop + targetTop - containerTop - (containerHeight - targetHeight) / 2);
}
