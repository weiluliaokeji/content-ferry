# 按账号学习并持续应用历史文章写作风格

## Problem Statement

账号设置中的手动“写作风格”可以明确表达作者偏好，但它不会自动归纳历史文章中稳定的表达习惯。当前文章库检索也可能命中其他账号或作者的文章，不能安全地把这些文章当作目标账号的风格样本。作者因此需要重复描述风格，阿文也无法可靠地延续账号已有的表达方式和相关旧文观点。

## Solution

作者可以为一个媒体账号挑选并确认代表文章，让阿文提炼可检查、可修改的风格候选。作者确认后，文渡保存一个独立于手动“写作风格”的、有版本和样本来源的账号风格档案。撰写主稿和各平台渠道稿时，阿文结合文章主题、当前文章要求、账号手动风格和目标账号已确认档案选择写法，并简短说明选择依据。账号之间的档案和旧文观点相互隔离。

## User Stories

1. As a content author, I want to see which historical articles are eligible for a selected account, so that other authors’ work is not silently treated as that account’s voice.
2. As a content author, I want the system to explain why each article is attributed to an account, so that I can distinguish confirmed publishing history from my own attribution.
3. As a content author, I want Awen to suggest representative articles from eligible samples, so that I can review a useful sample set without manually searching the entire library.
4. As a content author, I want to add or remove samples before extraction, so that the learned profile reflects the examples I consider representative.
5. As a content author, I want Awen to extract common voice and genre-specific traits, so that the profile captures both the account’s stable tone and differences between article types.
6. As a content author, I want to inspect and edit the extracted profile before saving, so that inferred traits do not become account settings without my decision.
7. As a content author, I want to compare a candidate with the active profile, so that I can understand what an update would change.
8. As a content author, I want only my explicit confirmation to create and activate a new profile version, so that declining a candidate leaves the current profile untouched.
9. As a content author, I want each version to retain its sample list and article references, so that I can trace where a style conclusion came from.
10. As a content author, I want to keep editing the account’s manual writing-style field independently, so that learning never overwrites instructions I entered myself.
11. As a content author, I want the current article’s explicit requirements to override account-level style, so that a specific assignment can intentionally use a different voice.
12. As a content author, I want Awen to choose how the topic, manual style and confirmed profile apply to a new article, so that I do not need to choose low-level style settings for every draft.
13. As a content author, I want a brief explanation of the style choice in drafting progress or completion, so that I can tell which account context informed the draft without adding meta commentary to the article.
14. As a content author, I want the main draft to use only its explicitly selected primary account’s profile, so that an unspecified account never inherits an arbitrary account voice.
15. As a content author, I want each account’s channel draft to use that account’s own profile, so that multi-account variants remain distinct.
16. As a content author, I want related historical viewpoints to be retrieved only from the target account’s attributed articles, so that an old viewpoint is not misrepresented as another account’s position.
17. As a content author, I want historical claims to remain separate from current verified research, so that an old article is not treated as proof of a current fact.
18. As a content author, I want insufficient or ambiguous sample attribution to be reported clearly, so that Awen does not invent a profile or claim a style was learned when it was not.
19. As a content author, I want deleted, draft and current articles excluded from new sample suggestions, while archived articles remain eligible, so that the profile can draw on older work without treating archive status as a quality judgment.
20. As a content author, I want prior profile versions and their sources to remain inspectable after an update, so that I can understand how the account voice evolved.

## Implementation Decisions

- Keep the hand-entered account `writing_style` field unchanged and independently editable. Store extracted profiles and their versions separately, keyed by media account.
- A sample is eligible only when it has a confirmed published record associated with the account, or the author explicitly confirms that article’s account attribution. A project’s target account, folder name, article text, topic similarity, or search rank alone does not establish attribution.
- Candidate articles must be completed/published and not marked draft. Archived articles remain visible and eligible under the same attribution rules. Exclude the article currently being written. Show the attribution basis and article title/path next to each candidate. The author may review, add, or remove eligible samples before extraction.
- For VitePress sources, `publish: false` means the page is not published; it is still a candidate so the author can explicitly confirm that an unpublished article is complete and belongs to the account. An explicit `publish: draft` marker remains excluded. This distinction must not change the article’s actual VitePress publish setting.
- Order sample candidates by creation time descending. Prefer a valid Front Matter `created` timestamp and fall back to the file creation time when it is missing or invalid. Provide inclusive start/end creation-date filters; narrowing the range must allow authors to find older candidates beyond the bounded initial result list.
- The author initiates extraction/update. Awen proposes a profile that distinguishes common voice from genre-specific traits where the samples support it. It may report insufficient or conflicting evidence instead of filling gaps with generic claims.
- Keep an extraction proposal separate from the active profile. Show its source samples, editable profile text, and a comparison with the active version. Confirmation creates and activates a new immutable version; rejection or abandonment does not change the active version. Keep prior versions and source references.
- Allow direct editing of the active profile. Saving an edit creates and activates a new immutable version, copies the active version’s sample provenance, and leaves the account’s manual `writing_style` unchanged. Require the active version ID observed by the editor so a stale edit cannot overwrite a newer profile.
- Reuse the existing account-profile API and account settings experience for profile retrieval and actions, while introducing a focused account-style service/repository boundary for eligible samples, proposals, version history and confirmation. Validate all account and article references server-side.
- Reuse the existing local article library reader/search rather than adding a remote service, vector database or model dependency. Add account-attributed search for style samples and related viewpoints; keep general workspace article search separate and continue treating retrieved article text as untrusted data.
- Apply style context at outline generation/refinement and main-draft generation. For a main draft, use only its explicit primary account. For channel drafts, resolve the channel’s selected account independently. Never merge profiles across accounts. Preserve manual writing style and the current article’s explicit instructions; Awen determines and briefly explains how the topic and account context apply. The profile may also record stable, observable body-image habits (`visualTraits`) when samples contain enough evidence; missing evidence stays blank rather than becoming an invented preference. During main-draft generation, Awen decides whether the topic and confirmed visual habits warrant practice screenshots or web images; useful practice screenshots may be inserted directly, and relevant web images may be searched, reviewed, placed and attributed without a per-image confirmation. The full article remains subject to ordinary author review, including image usage conditions.
- Put the short style-selection explanation in drafting progress or completion metadata, not in article Markdown. Do not expose private model reasoning.
- If a new article has no target account, do not select a profile implicitly. If account style is needed, ask which account; drafting may continue using non-account-specific instructions while awaiting the answer.
- Add an ordered SQLite migration for the profile-version and provenance records. Existing account data and writing-style values must remain unchanged. Back up an existing database before schema migration and verify foreign keys and retained records using the repository migration policy.
- Do not infer cross-account ownership from older channel drafts alone unless a confirmed publishing record ties the source article to that account. Drafts can inform a candidate only after author attribution confirmation.

## Testing Decisions

- Test observable behavior at service, route, prompt and UI boundaries; avoid tests that merely mirror private helper structure.
- Extend account repository and database migration tests to verify profile versions, sample provenance, active-version changes, rejection behavior, migration from supported historical schemas, and preservation of manual `writing_style`.
- Extend content-source tests to verify only explicitly attributed articles are returned for an account, while general related-article search remains workspace-scoped and does not claim account ownership.
- Extend AI content and channel-generation tests to verify primary-account selection, per-channel account isolation, current-article instruction precedence, concise style-choice explanation, no implicit profile without an account, and no use of old claims as current research evidence.
- Add route/service tests for sample eligibility, explicit author attribution, proposal editing/confirmation, version comparison and rejection. Invalid or cross-account article references must be rejected.
- Add renderer tests for sample review, candidate editing, confirmation/rejection and history/source display, following existing account settings and modal test patterns.
- Use existing prior art in account repository tests, content-source tests, AI content prompt tests, channel draft generation tests, and database migration fixtures. Run `npm run typecheck` and `npm test`; run the production build for any packaging/resource changes.

## Out of Scope

- Automatically changing or replacing the manually entered account `writing_style` field.
- Silently learning, updating or activating an account profile without author confirmation.
- Inferring account ownership from text, directory names, similarity, or an unconfirmed project target.
- Mixing style profiles or attributed historical viewpoints between accounts.
- Treating historical article statements as current verified facts.
- Automatically rewriting existing articles when a profile is updated.
- Adding cloud storage, third-party analytics, vector search, new model providers, or autonomous publication.
- Displaying private chain-of-thought; only concise progress and the style-selection explanation are user-visible.

## Further Notes

- Product-level decisions and acceptance criteria are in `spec/01-product-requirements.md`, including AC-17. Architecture and current implementation status are in section 18.8 of `spec/02-development-design.md`.
- The current account-profile editor is the entry point for account settings. The current historical article service is workspace-scoped; this feature must add an explicit account-attribution path rather than narrowing general search implicitly.
- The main draft and platform channel drafts use different generation services. Ticket breakdown should keep each deliverable vertical and include the related tests and user-facing documentation.
