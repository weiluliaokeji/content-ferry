## Why

Guide and practice articles can be too brief or omit useful operation evidence and images even when the outline and review identify those needs. The current draft revision loop can rewrite prose but cannot route an evidence gap to research or practice, so it may exhaust its repair budget without resolving the issue.

## What Changes

- Keep the author-selectable concise, standard, and detailed preferences, and plan depth from each section's reader-facing promise rather than keyword-based article classification or character quotas.
- Allow source-backed facts from extracted, checked pages into a candidate draft with paragraph-level provenance and a pending-author-confirmation state; author confirmation remains distinct from automated source checking.
- Route review findings to the work that can resolve them: accepted-source research, authorized autonomous practice, or prose revision; retain a separate bounded budget for each kind of work.
- After research or practice obtains new evidence, revise the draft and independently review the new revision. Do not mark unresolved required findings as passed.
- If the author skips or denies required practice, allow continuation only after explicitly narrowing the article scope, then review the revised scope and its evidence boundaries.
- Record the image-curation decision and outcome in the article workflow so authors can distinguish a deliberate skip from unavailable search, unsuitable candidates, placement failure, or successful insertion.

## Capabilities

### New Capabilities
- `article-draft-quality`: Adaptive depth planning and evidence-aware orchestration for drafting, autonomous practice, image curation, and independent review.

### Modified Capabilities

## Impact

- Affects the article brief/outline and draft generation pipeline, the independent review orchestrator, research and practice task coordination, draft image curation, workflow progress events, and their persistence and UI projections.
- Reuses existing account style profiles, research cards, autonomous-practice authorization, CLI/web/image tools, and independent reviewer; does not grant new tool permissions or treat search snippets as checked evidence. Candidate-only source use requires extracted page text and an author-visible pending state.
- Requires updates to product/design specifications, user guidance, application help, and focused workflow tests. No new external dependency is assumed.
