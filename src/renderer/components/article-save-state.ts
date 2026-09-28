/**
 * The article service may normalize Markdown while saving. Adopt that exact
 * persisted value when the editor has not changed since the save began, while
 * preserving any newer edits made during the request.
 */
export function reconcileMarkdownAfterSave(
  currentMarkdown: string,
  submittedMarkdown: string,
  persistedMarkdown: string | undefined
): { currentMarkdown: string; savedMarkdown: string } {
  const savedMarkdown = persistedMarkdown ?? submittedMarkdown;
  return {
    currentMarkdown: currentMarkdown === submittedMarkdown ? savedMarkdown : currentMarkdown,
    savedMarkdown
  };
}
