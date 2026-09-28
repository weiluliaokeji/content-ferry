export function resolveLoadedCoverPrompt(
  currentPrompt: string,
  loadedPrompt: string,
  contextKey: string,
  editedContextKey: string | undefined
): string {
  return editedContextKey === contextKey ? currentPrompt : loadedPrompt;
}
