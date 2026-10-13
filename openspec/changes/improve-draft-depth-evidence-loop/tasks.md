## 1. Durable draft-run foundation

- [x] 1.1 Define the draft-run states, checkpoint schema, and append-only event types shared by server and renderer.
- [x] 1.2 Add the ordered SQLite migration and repository for draft-run checkpoints and events; preserve Markdown and existing review records as the formal content sources.
- [x] 1.3 Add migration tests for empty and supported historical databases, backup creation, event/data preservation, foreign-key checks, repeat startup, and migration failure recovery.
- [x] 1.4 Add recovery reconciliation that rereads current article, accepted research cards, practice workflow, and authorization state without replaying completed side effects.
- [x] 1.5 Require structured per-section outline review coverage and deterministically repair missing, underspecified, or unanchored assessments; test that a heading-only guide cannot pass an empty general findings list.
- [x] 1.6 Require reader-facing outline points and deterministically reject sections dominated by author-task wording; test that a false-positive reviewer pass still triggers repair.
- [x] 1.7 Reject outline sections that defer most of their core answer to external manuals or websites, while allowing evidence to be gathered during drafting; test repair when the model reviewer falsely passes.

## 2. Adaptive depth planning

- [x] 2.1 Add the optional concise/standard/detailed preference to the article brief and creation UI, preserving existing records with no preference.
- [x] 2.2 Implement article-type and complexity depth resolution with a detailed default for guides/practice articles and per-section purpose budgets.
- [x] 2.3 Pass the depth plan into draft generation and independent review; add tests for explicit overrides, adaptive defaults, and no length padding.
- [x] 2.4 Replace keyword and character arithmetic with reader-promise depth guidance; retain author length preference and add tests for misleading headings and varied article types.

## 3. Evidence-aware review routing

- [x] 3.1 Extend the review skill and structured finding schema with validated research, practice, revision, and scope-decision categories.
- [x] 3.2 Implement the draft-run orchestrator to route research findings through formal evidence cards, practice findings through existing authorized tasks, and editorial findings through prose revision.
- [x] 3.3 Enforce the separate three-round prose revision limit, existing research/tool budgets, duplicate/no-progress stop rules, and strict not-passed handling for unresolved findings.
- [x] 3.4 Add explicit scope-adjustment handling when the author skips required practice; re-draft and re-review under the changed scope.
- [x] 3.5 Add scripted integration tests for missing official evidence, missing practice observations, authorization denial, accepted evidence, bounded no-progress, repair exhaustion, and review pass/fail transitions.
- [x] 3.6 Allow extracted, checked sources as candidate-only facts; persist claim-to-source links and confirmation state, reconcile edited text, and keep snippets and failed extracts out of the draft.
- [x] 3.7 Carry query/result history across research rounds and resumable draft runs, block repeated no-progress queries, and let the planner stop while preserving unresolved gaps; add planner-loop regression tests.
- [x] 3.8 Repair independent editorial findings even when evidence findings remain unresolved, keep evidence findings pending across prose-only reviews, and stop repeated unchanged editorial findings; add mixed-finding regression tests.
- [x] 3.9 Distinguish stable general knowledge, current/high-impact facts, and first-hand observations in drafting and review so evidence requirements remain proportional; add prompt and skill regression tests.

## 4. Image curation outcomes

- [x] 4.1 Persist image-curation decisions and outcomes with source attribution and reliable-placement results in the draft-run event stream.
- [x] 4.2 Add tests for account visual preferences, existing images, actual practice screenshots, no-candidate/service-failure outcomes, and successful attributed insertion.

## 5. Progress, recovery, and documentation

- [x] 5.1 Stream ordered draft-run events to the article workspace and render append-only progress, authorization waits, evidence actions, image outcomes, review status, and specific stopping reasons.
- [x] 5.2 Add renderer tests for event ordering, reconnect/resume, busy and waiting states, skipped stages, and passed versus needs-author presentation.
- [x] 5.5 Show compact pending-source count, claim markers in visual editing, a source review panel, and source-mode location without writing markers into Markdown; test confirm, reject, save, and edit invalidation.
- [x] 5.3 Update product/design specs, user guide, README if the supported workflow changes, and in-app HelpCenter.
- [x] 5.4 Run typecheck, full tests, build, and production boot/Portable checks for affected paths.
- [x] 5.7 Route desktop search and page extraction through the Windows-aware Chromium network stack unless an explicit research proxy is configured; preserve the HTTP(S)-only extraction boundary and cover fallback behavior with tests.
- [x] 5.8 Preserve both early and late evidence from long tool results in planner and bounded completion-verifier contexts; test that tail evidence remains available to both.
- [x] 5.9 After two verifier rejections without new observations, allow one bounded final answer repair based on existing observations when the candidate materially changes; ignore formatting-only edits, preserve the no-progress counter, and test both pass and stop paths.
- [x] 5.10 Strengthen topic-specific editorial arc planning and review without requiring a fixed hook, story, table, or chapter template; add generic prompt regressions.
- [x] 5.11 Add a bounded in-place verifier evidence-quote repair pass, preserve the no-false-success gate, and document the behavior.
- [x] 5.12 Infer a focused reader task from the topic when audience, objective, or angle is omitted, carry it through outline, draft, and review, and add generic prompt regressions.
- [x] 5.13 Expand adaptive depth per reader commitment complexity and reject one-sentence mentions as coverage for multi-step or multi-condition promises; update help and reviewer guidance.
- [x] 5.14 Detect a draft that only repeats all confirmed outline sections with Markdown list formatting changes; require normal revision without a fixed length threshold and cover expanded-draft behavior with tests.
- [x] 5.15 Reject outlines that defer a single core operation to external documentation even when the rest of the section is concrete; add a generic false-pass regression and update the authoring/review skill guidance.
- [x] 5.16 Pass author-provided brief notes into outline review, distinguish them from style-profile evidence, and deterministically block explicit unsupported personal-experience claims when author notes are empty; add false-pass regression tests.
- [x] 5.17 Improve domain-general source selection and conflict handling in research/review skills; preserve exact prior defaults for safe user-skill migration and test source guidance plus custom-edit retention.
- [x] 5.18 After a malformed completion citation survives verifier-only repair, allow a bounded planner continuation with the audit and original observations; prevent replay and stop repeated no-progress retries with regression tests.
- [x] 5.19 Keep failed pre-draft practice assessment visible without turning the assessment failure itself into a review blocker; let independent draft review determine whether the article actually owes practice evidence.
- [x] 5.20 Align the outline's central reader outcome with the author's requested article type and scope, and add domain-general generator/reviewer prompt regressions without prescribing a fixed structure.
- [x] 5.21 Add a structured whole-outline brief-alignment assessment with deterministic heading/evidence validation, false-pass regression coverage, and synchronized product/design/help documentation.
- [ ] 5.6 Manually accept the generated article using the Scoop guide scenario in `design.md`.
