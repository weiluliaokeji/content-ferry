## Purpose

Helps Awen deliver drafts with appropriate depth and evidence by coordinating research, authorized practice, image curation, revision, and independent review as one observable workflow.

## ADDED Requirements

### Requirement: Outlines cover the reader's complete task path
The system MUST evaluate a topic and brief to identify the reader's central task, decisions, and expected outcomes before accepting an outline. For complex topics, especially guides, tutorials, and practice-oriented articles, the outline MUST describe the key reader question and content elements for each section rather than listing headings alone; it MUST NOT impose a fixed bullet count, and this planning detail MUST NOT cap later draft elaboration. For guides, tutorials, and practice-oriented articles, the outline and its independent review MUST check that core decisions, operations, and result checks have clear structural homes and that unrelated tasks are not compressed into an overloaded section. Possible dimensions such as prerequisites, comparisons, troubleshooting, advanced scenarios, limitations, and FAQs are diagnostic lenses only; the system MUST NOT require every dimension, impose a fixed section count, or copy a universal template. An outline MAY plan future practice scenarios and questions, but MUST NOT require or invent observations before drafting.

The outline MUST preserve the distinction between the subject discussed and the deliverable or reader outcome promised by the author. Its central arc MUST fulfill the requested article type, scope, and outcome; an adjacent narrower question MUST NOT replace that outcome unless the brief explicitly makes the narrower question primary. This alignment MUST be reviewed without mapping article types to fixed section templates.

Independent review MUST return a whole-outline alignment assessment naming the requested deliverable, expected reader outcome, supporting section headings, and a literal quote from the candidate outline. The runtime MUST reject an aligned assessment when its supporting headings or quote cannot be located. A misaligned assessment MUST create a revision blocker even when the general findings list is empty.

Independent outline review MUST return one structured coverage assessment for every H2 section, including the reader question, the section's role, planned content elements, sufficiency, and an exact excerpt from that section. Missing or mismatched entries, an underspecified section, or an excerpt that cannot be located in that section MUST become a repair finding even when the general findings list is empty.

The outline generator and reviewer MUST receive user-provided brief notes as author input, distinct from adopted public evidence and style profiles. They MUST NOT present the author's specific personal use, test, observation, or local machine result as an existing fact unless the brief notes support it. A confirmed style profile or historical article sample MUST NOT be treated as evidence of author experience. Unsupported first-hand material may be planned as a question for later authorized practice, without requiring results at outline time.

When author notes are empty and an outline contains an explicit personal-use record, hands-on test, or local-machine result claim, the runtime MUST add a revision blocker even if the independent reviewer reports a pass.

Outline points MUST describe the reader-facing answers, judgments, procedures, or boundaries that the article will contain. They MUST NOT consist mostly of author-task verbs such as “explain”, “introduce”, “remind”, or “provide”. The runtime MUST turn a section dominated by such task-like points into a revision finding even if the model reviewer reports no findings.

An outline section MUST NOT consist mostly of instructions for the reader to find its core answer in an external manual or website. The outline may defer evidence gathering to drafting, but MUST still plan the answer and operation path the article will provide. When the core reader task depends on a command, step, or prerequisite, deferring that single critical operation to an external source MUST trigger revision even if other section points are concrete and the model reviewer reports no findings.

#### Scenario: A complex guide outline needs section-level direction
- **WHEN** a complex guide outline contains only broad chapter titles without indicating the reader questions or key content carried by each section
- **THEN** the outline review requests concrete section-level direction without imposing a fixed number of bullets or treating the outline as a limit on the later draft

#### Scenario: A guide outline omits a core reader task
- **WHEN** a guide promises an end-to-end outcome but the outline has no section or subsection that carries a necessary decision, operation, or result check
- **THEN** the independent outline review returns a concrete structural finding for repair without demanding actual practice results at the outline stage

#### Scenario: An adjacent question replaces the requested outcome
- **WHEN** the author requests an operational guide but the proposed outline centers on an adjacent suitability discussion and does not structurally fulfill the promised reader operation or learning outcome
- **THEN** the reviewer requests a concrete realignment unless the brief explicitly makes suitability the primary goal; it does not prescribe a fixed chapter template

#### Scenario: A false pass omits whole-outline alignment
- **WHEN** the reviewer reports no findings but marks the outline misaligned, cites a nonexistent supporting section, or supplies no locatable outline quote
- **THEN** the runtime adds a revision blocker and does not mark the outline passed

#### Scenario: Optional dimensions do not fit the topic
- **WHEN** comparisons, FAQs, advanced examples, or other common guide dimensions would add no meaningful reader value
- **THEN** the outline may omit them without a review finding

#### Scenario: The outline lists author tasks instead of reader-facing content
- **WHEN** most points in a section ask the writer to explain, introduce, remind, or provide something without stating the actual content direction
- **THEN** the runtime requests a revision that states the intended answer, judgment, operation, or boundary, even if the model reviewer marked the section sufficient

#### Scenario: The outline sends readers elsewhere for the core answer
- **WHEN** most points in a section tell readers to consult an external manual or website instead of planning the article's answer or operation path
- **THEN** the runtime requests revision while allowing uncertain facts to be researched during drafting

#### Scenario: One core operation is deferred to an external source
- **WHEN** a guide's core reader task depends on an operation, but even one outline point leaves its command, steps, or prerequisites to an external manual
- **THEN** the runtime requests revision to plan the article's operation path without requiring unverified commands or evidence at outline time

#### Scenario: Outline attributes an experience to the author
- **WHEN** an outline presents an explicit personal-use record, hands-on test, or local result, the author notes are empty, and the reviewer reports a pass
- **THEN** the runtime requests a revision that reframes it as a later validation question or a general reader scenario; the style profile does not count as evidence

### Requirement: Draft depth follows reader promises
Authors MUST be able to select concise, standard, or detailed depth. Without a preference, the system MUST use the confirmed brief and outline to decide how much explanation each promised reader outcome needs. The confirmed outline is a coverage floor, not a content ceiling: the draft MUST preserve its scope and confirmed H2 headings, while MAY adding useful subsections, explanations, examples, steps, comparisons, or troubleshooting that help fulfill the reader promises. Added current facts and practice observations MUST remain supported by checked sources or practice records. It MUST NOT infer a fixed reading duration or section character allocation solely from title keywords, section count, or source count. The reviewer MUST check that each section fulfills its reader-facing purpose instead of padding with repetition. A numeric length explicitly supplied by the author remains an additional constraint.

#### Scenario: Guide without an explicit length
- **WHEN** the author confirms a guide outline without choosing a length
- **THEN** Awen gives each operational promise enough explanation for relevant prerequisites, steps, observable results, and limitations without applying a universal reading-time or character target

#### Scenario: A short outline needs useful elaboration
- **WHEN** a confirmed outline has concise points but the reader task needs additional explanation or actionable detail
- **THEN** Awen preserves the confirmed scope and H2 headings, adds relevant subsections or detail, and keeps any new current facts tied to checked sources or practice records

#### Scenario: A multi-part promise needs complete treatment
- **WHEN** one outline promise includes multiple judgments, actions, steps, or applicability conditions
- **THEN** Awen explains each element the reader needs to understand, act, or verify the promised result; a one-sentence mention cannot count as fulfillment, while simple promises remain concise and no fixed word quota applies

#### Scenario: Author chooses concise depth
- **WHEN** the author selects concise depth for an article
- **THEN** the draft follows that preference while preserving the article's essential claims, required evidence boundaries, and necessary reader instructions

#### Scenario: The full article is drafted with its complete arc
- **WHEN** Awen drafts a confirmed outline
- **THEN** one generation request receives the complete outline, article depth plan, relevant research, and practice observations; supported providers stream the growing full article to the editor and checkpoints preserve partial output if generation is interrupted

#### Scenario: Draft review accounts for every confirmed promise
- **WHEN** the independent reviewer evaluates a completed draft against its depth plan
- **THEN** it returns exactly one status and a verbatim excerpt from that section's body for every outline point (or the section purpose when no points exist); it distinguishes a mention from a substantive answer without imposing a uniform word count, and missing, partial, duplicated, unexpected, cross-section, or unlocatable entries become blockers that cannot be passed by an empty general findings list

#### Scenario: Draft repeats the outline without elaboration
- **WHEN** every H2 body in a candidate draft is text-identical to its matching outline body after removing Markdown list markers
- **THEN** runtime adds a revision blocker requiring reader-facing explanation or actionable detail; it does not apply a fixed word or paragraph quota

#### Scenario: An executable promise requires executable content
- **WHEN** an outline promise explicitly asks for a command, code, or script
- **THEN** a generic sentence such as “run the relevant command” cannot count as fulfillment; the cited section evidence must contain a concrete, copyable code span or fenced snippet, otherwise review routes the missing command to source research

### Requirement: Candidate source facts remain visible for author confirmation
The system MAY use a fact from an extracted and checked web page in a candidate draft before the author adopts its research card. It MUST retain the exact source, retrieval time, supporting excerpt, and the article claim or paragraph that uses it. The editor MUST distinguish candidate-only links from author-confirmed evidence without adding review markers to publishable Markdown. If the supported text changes or no longer maps uniquely, the link MUST become pending recheck. Search snippets, failed page extracts, and unchecked assertions MUST NOT enter candidate facts. Saving a candidate MUST NOT imply author confirmation or final review approval.

#### Scenario: Candidate uses a checked official page
- **WHEN** Awen obtains a checked page body that directly supports an installation step and writes that step into a candidate draft
- **THEN** the editor shows the affected wording as pending author confirmation, lets the author inspect the source and supporting excerpt, and preserves the link after saving

#### Scenario: Author edits a linked claim
- **WHEN** the author changes a claim supported by a candidate source
- **THEN** the old confirmation state no longer applies to the changed wording and the editor asks for recheck rather than silently reattaching the source

### Requirement: Assess useful practice before drafting
After an outline is confirmed and before the first draft, the system MUST assess whether the article goal, promised reader outcome, accepted sources, and account style would materially benefit from local or web practice. The assessment MUST consider available tools and current task authorization. Awen MUST choose and explain a useful practice action itself; it MUST NOT require the author to fill out a practice checklist. It MUST NOT present a proposed action or expected result as an observation.

#### Scenario: Operational guide benefits from local verification
- **WHEN** a confirmed guide contains commands or procedures whose behavior can be checked with an available local tool
- **THEN** Awen identifies the relevant verification and starts it within the current task's authorization, or presents a specific authorization request before execution

#### Scenario: Practice would not improve the article
- **WHEN** the article's claims are adequately supported and local or web practice would add no useful reader-facing observation
- **THEN** Awen records that no practice is needed and proceeds without claiming that any practice occurred

### Requirement: Authorization and skipped-practice scope
The system MUST pause for a clear authorization decision before any practice operation that requires author approval. If the author denies or skips a practice action, the system MUST offer continuation only with an explicit, reviewable scope adjustment that accurately describes the article as unpracticed or source-based. It MUST preserve the original scope and evidence gap in the task history. A scope adjustment MUST be reviewed as a new current goal before the draft can pass review.

#### Scenario: Author skips local command execution
- **WHEN** a local practice action needs authorization and the author chooses to continue without it
- **THEN** the system updates the article scope to state that the operation was not locally tested, preserves the gap, and resumes drafting and review under that scope

#### Scenario: Practice permission is granted
- **WHEN** the author grants the displayed task-level authorization
- **THEN** Awen executes only the described practice scope and records the actual observation, conditions, and any captured artifact before using it in the draft

### Requirement: Route review findings to the work that can resolve them
Independent review findings MUST identify whether they require accepted-source research, authorized practice, prose revision, or an author decision. The system MUST route each finding to the corresponding workflow instead of asking a prose-only revision to invent missing evidence. After new evidence is obtained and formally available to the draft, the system MUST revise the affected content and independently review the resulting revision. Reviewer web search MAY verify current public facts within the current task's network authorization; transient search results MUST NOT silently become accepted article evidence.

#### Scenario: Current official installation instructions are missing
- **WHEN** review finds that a guide lacks current, source-supported installation steps, including when its only cited passage tells readers to open an official page and check the latest instructions
- **THEN** the system routes the finding to research, obtains source-backed material through the normal evidence workflow, and only then revises and reviews the draft

#### Scenario: First-hand observation is missing
- **WHEN** review finds that a promised practical section has no actual observation
- **THEN** the system routes the finding to the practice workflow and does not ask the prose reviser to fabricate results

#### Scenario: A disclaimer cannot satisfy a promised practice result
- **WHEN** the outline promises a local or practical result and the review cites text saying that this article has no such observation
- **THEN** the runtime rejects that coverage as incomplete and routes the gap to practice instead of treating the disclaimer as proof that the promise was fulfilled

#### Scenario: Finding is purely editorial
- **WHEN** review identifies repetition or an unclear explanation that requires no new evidence
- **THEN** the system routes the finding to prose revision and checks the changed draft again

### Requirement: Separate budgets for evidence work and prose revision
The system MUST keep the existing maximum of three automatic prose-revision rounds separate from research and practice budgets. Research and practice MUST remain bounded by their configured tool budgets, authorization, timeout, and no-progress guards. After each useful evidence batch, the system MAY perform one affected-content revision and independent review. Repeated actions that produce no new observation MUST stop, preserve the latest candidate and findings, and report the specific unresolved gap. The system MUST NOT report a pass while a required finding remains unresolved.

#### Scenario: New evidence resolves a blocker
- **WHEN** a bounded research or practice action yields new relevant evidence for a review finding
- **THEN** the system uses that evidence for a revision, runs an independent review of the new draft, and reports the updated finding status

#### Scenario: Evidence attempts make no progress
- **WHEN** an evidence action cannot run, returns no useful observation, or would repeat an identical no-progress action
- **THEN** the system stops that route, preserves the candidate and reason, and marks the workflow as needing author handling rather than passed

#### Scenario: Evidence blocker coexists with an independent editorial repair
- **WHEN** review reports both an unresolved evidence finding and a revision finding that does not depend on that evidence
- **THEN** Awen may revise only the actionable editorial finding, review the updated candidate, and keep the evidence finding unresolved until new evidence or an author scope decision resolves it

#### Scenario: Research planner stops while gaps remain
- **WHEN** the search planner decides that no useful new query remains while research gaps are still open
- **THEN** the system stops searching, preserves those gaps as unresolved, and reports partial research instead of forcing another query or claiming coverage

#### Scenario: Follow-up research has prior query history
- **WHEN** a draft review triggers another research round or a draft run resumes
- **THEN** the planner receives prior queries, result counts, and candidate URLs; runtime blocks identical or normalized-equivalent queries before execution and asks for a materially different route

#### Scenario: Review rejects a claim because the evidence is not applicable
- **WHEN** a review rejects a time-sensitive or operational claim because its source is stale, indirect, or for a different version or environment
- **THEN** Awen carries the exact claim, rejection reason, attempted sources, and observations into the next research decision; it seeks a directly relevant first-party source or reports why no useful route remains, and does not repeat the rejected evidence as fact

#### Scenario: Official sources appear to conflict
- **WHEN** current first-party sources describe different requirements or behavior
- **THEN** Awen checks version, date, platform, and configuration conditions; if the conflict remains unexplained, it preserves the differing claims and applicability boundaries instead of combining them into one unconditional conclusion

#### Scenario: Verifier cannot repair a citation
- **WHEN** the completion verifier still cannot quote a grounded request or tool observation after its evidence-only repair, and workflow rounds remain
- **THEN** the runtime gives Awen the failed citation audit and original observations for one bounded planning continuation; Awen may reformulate the answer from existing evidence or choose another evidence route, while completed operations are not replayed and repeated no-progress attempts still stop

### Requirement: AI-curated images have explicit outcomes
During draft generation, Awen MUST decide whether images would materially help the reader, considering the article topic, confirmed account visual preferences, existing article images, and actual practice screenshots. Account visual preferences MUST inform the decision but MUST NOT require an image in every article. When useful, Awen MAY search, select, and insert suitable attributed images without asking for per-image confirmation. The system MUST preserve source attribution and MUST record whether images were inserted, deliberately skipped, unavailable, rejected during screening, or unable to be placed reliably.

#### Scenario: Account preference favors operation screenshots
- **WHEN** a guide has an account preference for practical screenshots and this task has a relevant captured practice screenshot
- **THEN** Awen considers that screenshot for the relevant section and inserts it only if it supports the nearby text and its source association is preserved

#### Scenario: No suitable image is available
- **WHEN** Awen decides an image would help but search, screening, attribution, or paragraph placement produces no acceptable candidate
- **THEN** the system continues with the draft and records the specific image-curation outcome and reason

#### Scenario: Images would add no value
- **WHEN** images would be decorative, misleading, duplicative, or unrelated to the reader's task
- **THEN** Awen skips image insertion, records the decision, and does not treat the absence of an image as a practice failure

### Requirement: Review passes before author handoff
The system MUST present a draft as review-passed only when the independent reviewer finds no unresolved blocker or warning against the current article scope. When the evidence budget is exhausted or author handling is required, the system MUST preserve the candidate and show its unresolved findings as incomplete; it MUST NOT label that candidate as passed. If the author explicitly changes the article scope, the system MUST evaluate and review the changed scope before reporting a pass.

#### Scenario: All required findings are resolved
- **WHEN** the latest independent review returns no unresolved blockers or warnings for the current scope
- **THEN** the system marks that exact draft revision as passed and presents it for author review

#### Scenario: Required finding remains unresolved
- **WHEN** automatic evidence work and prose revision budgets are exhausted while a required finding remains
- **THEN** the system retains the latest candidate, shows the finding and the reason it could not be resolved, and marks the draft as not passed

### Requirement: Show an append-only creation activity trail
The system MUST show user-readable progress for depth planning, practice assessment, authorization, research, practice execution, image curation, revision, and review when those stages occur. Each new progress event MUST append to the task history without replacing earlier events. The activity view MUST distinguish a planned action from an executed action and a completed evidence result.

#### Scenario: Draft requires practice and images
- **WHEN** Awen assesses practice, runs an authorized command, captures an image, revises the draft, and reviews it
- **THEN** the author can see those events in order with actual results and clear stage statuses

#### Scenario: A stage is skipped or unavailable
- **WHEN** a stage is unnecessary or cannot proceed
- **THEN** the activity trail records the decision or reason instead of leaving a spinner or implying the stage completed
