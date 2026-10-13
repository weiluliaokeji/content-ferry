## Context

See `proposal.md` for motivation and `specs/article-draft-quality/spec.md` for observable requirements.

Today, `AiContentService.generateReviewedDraft` runs generation, independent review, and prose-only repair in one call. The project route then runs image curation and stores the review result. Autonomous practice and formal research are separate services with their own authorization, evidence, and recovery state. Review repair prompts intentionally cannot turn temporary search results into accepted facts or invent practice results, so the current loop has no handoff from a finding to the evidence workflow that could resolve it.

The change spans multiple services and requires durable progress, but must preserve Markdown as the article source of truth, existing user authorization boundaries, accepted research-card decisions, style profiles, and the three-round prose-revision limit.

## Goals / Non-Goals

**Goals:**

- Coordinate article depth, evidence acquisition, practice, image decisions, review, and repair as one resumable generation run.
- Keep research-card adoption separate from candidate drafting and preserve task authorization gates; new orchestration cannot grant permissions or promote transient reviewer search snippets into checked evidence.
- Preserve every workflow stage and its outcome for UI progress, recovery, and diagnosis.
- Give guide and practice drafts enough detail to complete the promised reader task without enforcing a universal article length.

**Non-Goals:**

- Replacing provider-specific model adapters or embedding DeepSeek Harness runtime.
- Making every article contain practice, screenshots, or web images.
- Changing platform publishing, channel-draft review, account style learning, or the existing permission risk model.
- Treating old article content or previous machine observations as current evidence without explicit source association.
- Introducing a task-wide elapsed-time limit; existing operation timeouts, research budgets, permissions, and no-progress guards remain authoritative.

## Decisions

### One draft-run orchestrator owns cross-stage routing

Introduce a focused draft workflow orchestrator above the existing generation, research, practice, curation, and review services. It owns the immutable run context, stage transitions, checkpoints, and final review gate. Existing services remain responsible for their own domain operations: the research service creates source-backed cards, the practice task/workflow executes authorized tools, the image curator searches and places assets, and the independent reviewer evaluates a content revision.

The orchestrator should not absorb provider prompts, CLI execution, HTTP retrieval, or image downloads. Compared with placing all behavior in `AiContentService`, this gives evidence routing and recovery one explicit seam while retaining already-tested adapters and authorization checks.

### Stage transitions are explicit and evidence-driven

The run follows this conceptual state path:

```text
planning_depth
  -> assessing_practice
  -> [research_needed | awaiting_permission | practicing]
  -> drafting
  -> curating_images
  -> reviewing
  -> [research_needed | awaiting_permission | practicing | revising]
  -> reviewing
  -> passed | needs_author | failed | cancelled
```

Optional stages may be skipped only with a recorded reason. A finding is routed from its structured resolution category, then checked against the actual missing evidence and available workflow. The classifier is advisory: the runtime verifies that research or practice is relevant, that the operation is in scope, and that authorization is present before dispatch. A review finding can never authorize a tool call.

Research stays on the formal research path. Existing cards are a starting point, not a closed source set: a drafting or review gap can trigger further web retrieval, and a practice gap can trigger an in-scope authorized practice task. A search snippet cannot support a draft fact. Extracted and source-checked page content may support a **candidate-only** claim before card adoption, provided the exact draft passage is linked to the source snapshot and marked pending author confirmation in the editor. Adopting a card and confirming a candidate claim are separate author decisions. Practice uses the existing task repository and tool workflow; an authorization wait is a resumable state. If practice is skipped, the run asks for an explicit scope adjustment, regenerates against that scope, and reviews it again.

### Depth is a run input guided by reader promises

Persist the author's `concise | standard | detailed` preference with the article creation brief. When absent, mark the plan `adaptive` and let the model use the writing goal, target reader, task complexity, and outline promises to determine depth. Guides and practice articles should explain relevant prerequisites, executable steps, result checks, and limits; conceptual and argument articles should develop their explanations and evidence without being forced into tutorial structure. Do not infer an article type from heading keywords or impose reading-time and character allocations.

After generation, the independent reviewer checks that sections deliver their promised information and operational detail. The confirmed outline is a coverage floor, not a content ceiling: keep its scope and H2 headings, but add useful H3s, explanations, examples, steps, comparisons, or troubleshooting when they help readers complete the promised task. New current facts and observations still require checked sources or practice records. A short article is not expanded merely to hit a number; the system revises only missing explanation, evidence, examples, conditions, or steps.

Outline generation and review distinguish the subject from the requested article deliverable. The requested type, scope, and reader outcome anchor the central arc; an adjacent question may support it but cannot replace it unless the brief explicitly chooses that narrower goal. This is a semantic alignment check, not a genre-to-template mapping.

Draft the confirmed outline as one full-article request so the writer can hold the narrative arc, research, and practice observations together instead of relying on compressed summaries between section calls. Stream the growing Markdown to the editor when the provider supports it and save bounded checkpoints; if the provider cannot stream, save its complete response when it returns. A failed or cancelled stream preserves the received candidate as incomplete and skips image curation and full-article review. Outline points remain reader-facing commitments, not one-sentence output quotas; actionable sections develop the relevant prerequisites, steps, observable outcomes, and limits without fixed word counts or padding.

### Evidence gaps and prose repair use separate budgets

Keep the existing maximum of three automatic prose revisions. A review finding includes a validated category such as `research`, `practice`, `revision`, or `scope_decision`. A batch of newly accepted research or newly observed practice may cause one affected-content revision and a fresh independent review without consuming a prose-only revision slot. The research depth/budget, individual tool timeouts, authorization scope, and existing duplicate/no-progress guard limit evidence work; there is no new global wall-clock deadline.

Research planning receives the prior query text, result count, and candidate URLs from the current and resumable prior draft run. Runtime blocks normalized-equivalent queries before dispatch. A planner `done` decision ends retrieval even if app-owned coverage gaps remain; those gaps stay open and are reported as partial research. The application validates coverage from checked page bodies and never equates “no useful next query” with “evidence complete.”

An identical no-progress action is not retried. After a prose-only revision, if the independent review returns the same findings, severity, resolution, normalized detail, and cited draft evidence, stop early even if unrelated text changed; preserve the latest candidate and explain that the attempted revision did not move the review state. If the finding or its evidence changes, remaining repair budget may continue. When the relevant budget is exhausted, permission is denied, or the needed tool is unavailable, save the latest draft, evidence snapshot, findings, and specific stopping reason as `needs_author`. No candidate with unresolved requirements is marked review-passed.

### Durable events are the progress and recovery source

Add a versioned draft workflow run record plus append-only event records. The run snapshot stores the chosen depth, current article scope, outline/content revision hashes, current stage, and safe resume checkpoint. Events store progress labels, stage outcomes, resolution routes, authorization-wait references, accepted evidence identifiers or practice task references, image-curation result, review result, and timestamps. They do not duplicate article Markdown, raw CLI output, secrets, or full model prompts.

The existing article Markdown remains the only formal body. Review snapshots continue to bind to a content hash. Recovery re-reads current article, source-card, permission, and practice task state before resuming; it never blindly replays tool side effects. A terminal tool workflow is reconciled into the draft run as a result or gap rather than sent to a resume endpoint.

This is preferable to replacing prior stage events with a single mutable progress string: append-only history makes it possible to explain a long run, detect no-progress behavior, and recover after restart without claiming work that did not occur.

### Image curation remains an optional, recorded decision

Run image curation as its own stage after a usable draft exists and before final review. The decision considers account visual preferences, existing assets, and actual practice screenshots. An account preference is a meaningful signal, not a mandatory image quota. Keep automatic insertion limited to attributed candidates with a reliable unique placement; record outcomes using explicit categories (`inserted`, `not_needed`, `no_candidate`, `screening_rejected`, `placement_unavailable`, `service_unavailable`). A failed or skipped image stage does not erase the draft or claim that a screenshot was captured.

### The author handoff is a strict review gate

Only a review pass for the current draft hash and current scope is presented as passed. Remaining findings after budgets are exhausted remain visible with a `needs_author` status and the candidate is preserved for recovery. An author-approved scope change creates a new review target; it does not retroactively convert old findings or evidence into a pass.

## Risks / Trade-offs

- **[Risk] More stage coordination can increase latency and model/tool cost** → Show append-only stage progress, reuse accepted evidence and completed safe observations, and stop repeated no-progress work.
- **[Risk] Reviewer categories may misroute a finding** → Validate categories, keep the reviewer’s evidence and rationale, and let the orchestrator reject a route that lacks a matching gap or permission.
- **[Risk] Vague depth guidance can produce shallow sections** → Review each section against its specific reader promise rather than a word count.
- **[Risk] Candidate web facts may be mistaken for accepted facts** → Show exact source links and pending confirmation on the candidate, invalidate links after edits or source changes, and never turn snippets into evidence.
- **[Risk] Durable workflow records may outlive or diverge from article changes** → Bind checkpoints and review results to content hashes; revalidate the current article, accepted cards, practice state, and authorization on recovery.
- **[Risk] SQLite migration may fail or need rollback** → Add an ordered migration, back up before schema changes, verify foreign keys and legacy records, and test from supported historical fixtures and failure injection.
- **[Risk] Image results may be misleading or lack reuse rights** → Preserve exact source attribution, do not claim licensing was verified, and leave ordinary publication review to the author.

## Migration Plan

1. Add the durable draft-run/event schema with an ordered migration and backup-aware upgrade behavior. Existing articles and review records remain readable and do not receive synthetic evidence or passed statuses.
2. Create workflow runs only for new drafting requests. Existing in-flight practice/research tasks continue through their current recovery paths; when linked to a new draft run, reconcile from their actual durable state.
3. On rollback, stop creating new runs and use the application’s pre-migration database backup for database rollback. Existing Markdown files are not rewritten by migration.
4. Keep compatibility readers for old review records and article briefs with no depth preference; treat absent preference as `adaptive`, with writing goal, target reader, and actual section commitments guiding depth during generation and review.

## Validation Strategy

- Unit tests for depth resolution, section allocation, finding categorization, route validation, image outcome mapping, no-progress stopping, and strict review gating.
- Integration tests with scripted models and fake research/practice/image services: missing official install evidence routes to research; practical result gaps route to an authorized task; denial/skip requires scope adjustment; new evidence triggers revision and re-review; unresolved findings never pass.
- Restart tests at drafting, permission wait, research adoption wait, image curation, and review checkpoints; assert that completed side effects are not replayed and that events remain append-only.
- SQLite tests from an empty database and supported historical fixtures, including backup, foreign-key checks, repeated startup, and migration failure recovery.
- Renderer tests for adaptive-depth choice, append-only progress display, explicit stage outcomes, and `needs_author` versus `passed` states.
- Run typecheck, full tests, build, and the production/Portable checks required for changed runtime or packaging paths. Manual acceptance uses a Scoop guide: draft at detailed depth, obtain current official install evidence, run only authorized local queries, record a real observation, decide on a useful attributed image, resolve the repetition finding, and show ordered stage events through final review.
