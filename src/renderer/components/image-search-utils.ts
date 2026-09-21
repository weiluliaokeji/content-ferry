export function isCurrentImageSearchRequest(
  requestId: number,
  currentRequestId: number,
  requestedContextKey: string,
  currentContextKey: string
): boolean {
  return requestId === currentRequestId && requestedContextKey === currentContextKey;
}
