import type { DraftRunEvent } from "../shared/draft-workflow";

/** Reconcile streamed updates with the durable snapshot used when a run is reopened. */
export function appendDraftRunEvent(events: DraftRunEvent[], value: unknown): DraftRunEvent[] {
  if (!isRecord(value) || typeof value.runId !== "string" || !Number.isInteger(value.sequence)
    || typeof value.kind !== "string" || typeof value.stage !== "string" || typeof value.summary !== "string"
    || typeof value.createdAt !== "string" || !isRecord(value.payload)) return events;

  const event = value as unknown as DraftRunEvent;
  if (events.some((item) => item.runId === event.runId && item.sequence === event.sequence)) return events;
  return [...events, event].sort((left, right) => left.sequence - right.sequence);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
