import { useEffect, useRef } from "react";
import type { ToolWorkflowSnapshot } from "../types";
import type { DraftRunEvent } from "../types";

const DRAFT_PROGRESS_EVENT_TYPES = new Set([
  "progress",
  "model_round_started",
  "tool_started",
  "tool_output",
  "tool_completed",
  "permission_requested",
  "goal_verification_passed",
  "goal_verification_continued",
  "goal_verification_incomplete",
  "workflow_incomplete",
  "workflow_failed",
  "workflow_completed"
]);

export function getDraftWorkflowProgressEvents(events: ToolWorkflowSnapshot["events"]): ToolWorkflowSnapshot["events"] {
  return events.filter((event) => DRAFT_PROGRESS_EVENT_TYPES.has(event.type));
}

export function DraftWorkflowProgress({ events, draftRunId, draftRunEvents = [] }: { events: ToolWorkflowSnapshot["events"]; draftRunId?: string; draftRunEvents?: DraftRunEvent[] }) {
  const progressEvents = getDraftWorkflowProgressEvents(events);
  const listRef = useRef<HTMLOListElement>(null);
  const followLatestRef = useRef(true);
  const latestEventId = progressEvents.at(-1)?.id;

  useEffect(() => {
    const list = listRef.current;
    if (list && followLatestRef.current) list.scrollTop = list.scrollHeight;
  }, [latestEventId]);

  if (progressEvents.length === 0 && draftRunEvents.length === 0) return null;

  return <section className="draft-workflow-progress-panel" aria-label="正文准备过程" data-draft-run-id={draftRunId}>
    <div className="draft-workflow-progress-heading">执行记录（{progressEvents.length}）</div>
    <ol
      className="draft-workflow-progress"
      aria-label="正文准备进度记录"
      ref={listRef}
      onScroll={(event) => {
        const list = event.currentTarget;
        followLatestRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      }}
    >
      {progressEvents.map((event) => <li key={event.id}><span>{event.message}</span></li>)}
    </ol>
    {draftRunEvents.length > 0 && <>
      <div className="draft-workflow-progress-heading">正文任务记录（{draftRunEvents.length}）</div>
      <ol className="draft-workflow-progress" aria-label="正文任务进度记录">
        {draftRunEvents.map((event) => <li key={`${event.runId}:${event.sequence}`}><span>{event.summary}</span></li>)}
      </ol>
    </>}
  </section>;
}
