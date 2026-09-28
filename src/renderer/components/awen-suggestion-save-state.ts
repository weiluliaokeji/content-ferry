export function reconcileAwenSuggestionSaveState(
  currentUnsavedIds: ReadonlySet<string>,
  currentSyncPendingIds: ReadonlySet<string>,
  submittedIds: readonly string[],
  failedSyncIds: readonly string[]
): { unsavedIds: Set<string>; syncPendingIds: Set<string> } {
  const submitted = new Set(submittedIds);
  const unsavedIds = new Set([...currentUnsavedIds].filter((id) => !submitted.has(id)));
  const syncPendingIds = new Set([...currentSyncPendingIds].filter((id) => !submitted.has(id)));
  for (const id of failedSyncIds) syncPendingIds.add(id);
  return { unsavedIds, syncPendingIds };
}
