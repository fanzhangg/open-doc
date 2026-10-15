# Editor frameworks and apps for AI-suggested edits, comments, and markdown round-tripping

Research date: 2026-10-14. About 20 search/fetch calls. Primary sources (vendor docs, npm package.json, READMEs) are preferred. Several findings come from search-result summaries rather than full page reads, and are flagged where that matters.

## Q1: Per-framework comparison (license of core vs AI/comments/track-changes, markdown fidelity, AI collaboration model, 2025-2026 updates)

### Takeaway
For an AI co-author whose edits arrive as reviewable suggestions, the main options split into three licensing tiers:
- **Fully MIT/OSS:** Plate.
- **Copyleft-or-pay:** BlockNote. The core is MPL-2.0. The AI package is GPL-3.0 or proprietary, and it ships a working "AI edits as tracked suggestions" flow built on the MIT-style ProseMirror suggestion library from handlewithcare.
- **Commercial add-ons on an MIT core:** Tiptap (AI Toolkit and Tracked Changes are paid add-ons with custom pricing) and CKEditor 5 (GPL core, with AI, comments and track changes all premium and commercial).

Liveblocks and Velt are hosted collaboration SaaS layers, not editors.

### Cited Findings

**Tiptap**
- The editor core is MIT and free: "The Tiptap Editor is open source (MIT) and free." Only platform features and cloud documents are priced — [Tiptap pricing](https://tiptap.dev/pricing.md)
- Plans cost Start $59/$49, Team $179/$149 and Business $1,199/$999 per month (monthly/annual billing). Enterprise is custom. Extra developer seats cost $49/dev/month, or $39 billed annually — [Tiptap pricing](https://tiptap.dev/pricing.md)
- All plans include Comments, the "In-line AI extension", and Markdown/DOCX import and export. **Tracked Changes and the AI Toolkit (which includes agent editing) are paid add-ons on every plan, with custom pricing through sales** — [Tiptap pricing](https://tiptap.dev/pricing.md)
- Third-party reviews disagree on whether AI features are bundled into tiers or sold as add-ons. The official pricing page says add-on — [makerstack review](https://makerstack.co/reviews/tiptap-ai-toolkit-review/); [Tiptap pricing](https://tiptap.dev/pricing.md)
- Tiptap was running a promotion offering "100 free AI Toolkit licenses" (banner on the docs) — [Tiptap docs](https://tiptap.dev/docs/ai/ai-toolkit/client/workflows/tiptap-edit)
- **How the AI Toolkit agent works:** the server runs a `ToolLoopAgent` (Vercel AI SDK) with `toolDefinitions()` from `@tiptap-pro/client-ai-toolkit-ai-sdk`. Its instructions say "Use tiptapRead before tiptapEdit". The client runs each tool call through `getAiToolkit(editor).executeTool(...)` inside `useChat.onToolCall`, and `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` keeps the loop going — [Tiptap: Use with Tracked Changes](https://tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes/tracked-changes)
- To route AI edits into tracked changes, set `reviewOptions.mode: 'trackedChanges'` with `trackedChangesOptions: { userId: 'ai-assistant', userMetadata: { name: 'AI' } }`. Users then accept or reject with `acceptSuggestion` / `rejectSuggestion` / `acceptAllSuggestions` / `rejectAllSuggestions` — [Tiptap: Use with Tracked Changes](https://tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes/tracked-changes)
- The Tracked Changes extension is "currently in Alpha phase" and sold separately from the AI Toolkit. It "handles user edits by default and can review AI edits when integrated with the AI Toolkit". The extension must be configured with `enabled: false` while the AI makes edits — [Tiptap: Use with Tracked Changes](https://tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes/tracked-changes)
- The AI Toolkit also has its own "suggestions" display, distinct from Tracked Changes. You can set suggestions directly or generate them by diffing the current document against another document. Suggestions cannot overlap because of ProseMirror decoration limits — [Tiptap Suggestions API](https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/api-reference/suggestions)
- The older "AI Suggestion" extension previews AI changes before they are applied. A separate "AI Changes" extension reviews changes after they are applied — [Tiptap AI Suggestion docs](https://tiptap.dev/docs/content-ai/capabilities/agent/review/ai-suggestion.md)
- **Markdown:** `@tiptap/markdown` was introduced in Tiptap 3.7.0 as an official, open-source extension with "full Markdown parsing and serialization" using MarkedJS. Its API includes `editor.markdown.parse`, `editor.markdown.serialize` and `editor.getMarkdown()`, plus a `contentType` option for setContent. The changelog reaches 3.22.x: marked was upgraded to v17, and HTML entities now decode correctly as of 3.22.0 — [Tiptap blog](https://tiptap.dev/blog/release-notes/introducing-bidirectional-markdown-support-in-tiptap); [@tiptap/markdown changelog](https://tiptap.dev/docs/resources/changelog/markdown)
- The paid `@tiptap-pro/extension-export-markdown` wraps `@tiptap/markdown` — [Tiptap docs](https://tiptap.dev/docs/conversion/export/markdown/editor-extension.md)

**BlockNote**
- The core is MPL-2.0, which permits commercial and closed-source use. The "XL" packages, including `@blocknote/xl-ai`, are GPL-3.0. Closed-source use needs a commercial license, which is part of the Business subscription — [BlockNote README](https://raw.githubusercontent.com/TypeCellOS/BlockNote/main/README.md); [BlockNote AI docs](https://www.blocknotejs.org/docs/features/ai); [BlockNote XL Commercial License](https://www.blocknotejs.org/legal/blocknote-xl-commercial-license)
- `@blocknote/xl-ai` v0.56.0 has the npm license field `"GPL-3.0 OR PROPRIETARY"`. **Its dependencies include `@handlewithcare/prosemirror-suggest-changes` ^0.1.8, `prosemirror-changeset` ^2.4.2, `ai` ^6.0.5 (Vercel AI SDK v6), `@ai-sdk/react` ^3 and `@tiptap/core` ^3.31.3.** This means BlockNote AI renders LLM edits as ProseMirror suggestion marks with changeset diffing — [unpkg @blocknote/xl-ai package.json](https://unpkg.com/@blocknote/xl-ai/package.json)
- BlockNote AI is described as being in "early preview". Its claimed features:
  - Users can "accept or reject AI suggestions with a simple click".
  - Streaming.
  - "No Backend Required", or your own backend.
  - Model agnostic, built on the Vercel AI SDK.
  - Supports RAG.
  - [BlockNote AI docs](https://www.blocknotejs.org/docs/features/ai)
- **Mechanism (API reference):**
  - LLM edits are expressed as "stream tools" from `getStreamToolsProvider(withDelays, defaultStreamTools)`, with separate `add`, `update` and `delete` block tools.
  - The default document format is HTML (`aiDocumentFormats.html.getStreamToolsProvider()`, `aiDocumentFormats.html.defaultDocumentStateBuilder`).
  - Menu states are `user-input → thinking → ai-writing → user-reviewing`.
  - There is an `agentCursor` (default name "AI"), plus `acceptChanges()`, `rejectChanges()`, `retry()` and `abort()`.
  - `transport` lets you swap the backend, for example to websockets.
  - `sendMessageWithAIRequest` attaches `documentState` to message metadata and sends tool definitions as JSON Schemas to the backend.
  - [BlockNote AI reference](https://www.blocknotejs.org/docs/features/ai/reference)
- Comments are in the liberally licensed core. Per a search summary of blocknotejs.org, "the core editor, including comments, is liberally licensed" — [BlockNote site](https://www.blocknotejs.org/) (search-snippet level; not verified on a full page read)

**Plate (platejs)**
- The GitHub license badge links to MIT. Tagline: "Rich-text editor with AI and shadcn/ui". A "Notion-like template" links to pro.platejs.org (Plate Plus, a paid template tier) — [Plate GitHub](https://github.com/udecode/plate)
- Plate's comparison table lists AI, comments and suggestions as free/OSS in Plate, against paid extensions or "Comments Pro" in Tiptap (vendor marketing) — [platejs.org](https://platejs.org)
- **The AI plugin streams markdown into the editor:**
  - `streamInsertChunk` "deserializes Markdown chunks, updates the current block in place, and appends new blocks as needed".
  - Lower-level helpers are `streamDeserializeMd` and `streamDeserializeInlineMd`, plus `streamSerializeMd` for drift checks.
  - Streaming supports tables, columns and code blocks.
  - Preview and rollback use `tf.ai.beginPreview`, `acceptPreview`, `cancelPreview` and `discardPreview`.
  - [Plate AI docs](https://platejs.org/docs/ai)
- **AI edits as suggestions:** in chat mode with `toolName: 'edit'`, `applyAISuggestions` "Diffs AI output against stored `chatNodes` and writes transient suggestion nodes". This requires `@platejs/suggestion`. `acceptAISuggestions` converts transient suggestions into permanent suggestions, and `rejectAISuggestions` removes them. `tf.ai.undo()` reverts the latest `withAIBatch` — [Plate AI docs](https://platejs.org/docs/ai)
- **AI comments:** with `toolName: 'comment'`, `aiCommentToRange` "maps streamed comment metadata back to document ranges", turning streamed comments into discussion threads. The server routes each request through `getChooseToolPrompt` into `generate`, `edit` or `comment`. This is intent routing, not general model tool-calling — [Plate AI docs](https://platejs.org/docs/ai)
- Packages are `@platejs/ai`, `@platejs/markdown`, `@platejs/selection` and `@platejs/suggestion`, used with `ai` and `@ai-sdk/react` — [Plate AI docs](https://platejs.org/docs/ai)
- The Copilot plugin renders ghost-text suggestions as you type. The Copilot docs reference a "Plate Plus" item, "Suggestions powered by AI SDK (OpenAI)" — [Plate Copilot docs](https://next.platejs.org/docs/copilot)
- The suggestion plugin is `BaseSuggestionPlugin` from `@platejs/suggestion`, with a suggesting-mode toggle — [Plate suggestion docs](https://platejs.org/docs/suggestion)

**ProseMirror (raw)**
- `@handlewithcare/prosemirror-suggest-changes`:
  - Adds `insertion`, `deletion` and `modification` marks via `addSuggestionMarks(...)`.
  - Provides a `suggestChanges()` plugin and a `withSuggestChanges()` dispatch decorator that turns incoming transactions into suggestion transactions (for example, a delete becomes a deletion mark).
  - Commands: `applySuggestion(s)`, `applySuggestionsInRange`, `revertSuggestion(s)`, `revertSuggestionsInRange`, `selectSuggestion`, and `enable/disable/toggleSuggestChanges`.
  - Renders pilcrows for inserted or deleted paragraph breaks. Sponsored by dskrpt.de.
  - The README does not state a license or mention AI or Yjs.
  - [README](https://cdn.jsdelivr.net/npm/@handlewithcare/prosemirror-suggest-changes@0.1.8/README.md)
- The maintainers chose a dispatchTransaction "decorator" over appendTransaction. A separate community package, `prosemirror-suggestion-mode`, also exists — [discuss.prosemirror.net](https://discuss.prosemirror.net/t/releasing-prosemirror-suggestion-mode/8239/2)

**CKEditor 5**
- Dual license: GPL-2.0-or-later, or commercial from CKSource. This comes from an unofficial docs mirror — [docsearch mirror](https://docsearch.algolia.com/mcp/docs/repo/ckeditor/ckeditor5)
- Track changes is "a premium feature", part of `ckeditor5-premium-features` — [track-changes README v48.3.1](https://unpkg.com/@ckeditor/ckeditor5-track-changes@48.3.1/README.md)
- The Comments feature "is licensed under a commercial license" — [comments README v48.3.0](https://unpkg.com/@ckeditor/ckeditor5-comments@48.3.0/README.md)
- Track changes depends on Comments — [OutSystems forum](https://www.outsystems.com/forums/discussion/103591/how-do-i-load-the-premium-features-and-apply-the-licenses)
- AI Assistant also requires a license — [Merkle Drupal guide (2024)](https://drupal.merkle.com/post/2024/07/ckeditor-5-premium-features/)
- **CKEditor AI (2025-2026):**
  - AI Chat works on the active document and returns proposed edits that users can "review, accept, reject, or convert into Track Changes suggestions".
  - AI Review covers grammar, style, tone and clarity, with suggestions accepted or rejected in-editor.
  - v48.3.0 added opt-in labeling of AI-proposed tracked changes, as a "pill view" or "AI author view" (`config.trackChanges.showAISource`, `config.trackChanges.aiAuthor`).
  - v48.4.0 added a snapshot of loaded editor features sent to AI Chat, image analysis, and an "Outdated" tooltip for stale suggestions. Comments and suggestions *inside* AI Chat are still planned.
  - Sources: [newreleases v48.4.0](https://newreleases.io/project/github/ckeditor/ckeditor5/release/v48.4.0); [newreleases v48.3.0](https://newreleases.io/project/github/ckeditor/ckeditor5/release/v48.3.0); [TYPO3 CKEditor AI docs (third-party)](https://docs.typo3.org/p/t3planet/rte-ckeditor-pack/1.1/en-us/CKEditorAI/AIChat/Index.html)

**Lexical**
- There is no official track changes. The community prototype `lexical-track-changes` uses insertion and deletion nodes and is marked "work in progress, likely contains bugs". There is also a `lexical-review` package — [Lexical discussion #4707](https://github.com/facebook/lexical/discussions/4707); [lexical-track-changes](https://github.com/Ramnath-Karthikesan/lexical-track-changes)
- No built-in AI, per a competitor comparison (vendor marketing; treat with caution) — [richtexteditor.com](https://richtexteditor.com/compare/lexical)
- Liveblocks ships a "Notion-like AI editor" Vercel template — [Vercel template](https://vercel.com/templates/next.js/liveblocks-notion-like-ai-editor)

**Milkdown**
- Milkdown is markdown-first (ProseMirror plus Remark) and its core is MIT. AI is not built in.
- The official blog has "Build Your Own Milkdown Copilot" (ghost-text completion) — [Milkdown blog](https://milkdown.dev/blog/build-your-own-milkdown-copilot)
- The third-party `milkdown-copilot` does Codestral or OpenAI-compatible completions with tab-to-accept, and requires Milkdown >= 7.19.2 — [skaldapp/milkdown-copilot](https://github.com/skaldapp/milkdown-copilot)
- There is a Yjs collab plugin — [@milkdown/plugin-collab](https://milkdown.dev/docs/api/plugin-collab)

**Novel**
- Novel (steven-tey/novel) is a Notion-style Tiptap-based editor with AI autocompletion, licensed Apache-2.0 — [GitHub](https://github.com/steven-tey/novel)

**Yoopta**
- The core is MIT. AI features (generation, inline editing, plugin generator) live in the separate "Yoo AI" app builder, not the OSS editor — [Yoopta GitHub](https://github.com/yoopta-editor/Yoopta-Editor); [Yoo AI](https://ai.yoopta.dev/)

**Editor.js**
- Editor.js is free and OSS with JSON output, and has no official AI.
- The community `editorjs-aitext` tool shows a delayed AI suggestion that you accept or decline with keys, using your own provider — [editorjs-aitext](https://github.com/etozhealkhipce/editorjs-aitext); [npm](https://www.npmjs.com/package/@editorjs/editorjs)

**Liveblocks AI Copilots**
- Liveblocks AI Copilots are React UI components plus hosted AI that can "edit content, navigate your app". The first stage, released January 2025, was an AI suggestions toolbar for collaborative Tiptap (`AiToolbar`) — [Liveblocks blog](https://liveblocks.io/blog/introducing-ai-copilots-ready-made-interfaces-for-human-like-collaboration); [Liveblocks Jan 2025](https://liveblocks.io/blog/whats-new-in-liveblocks-january-2025)
- Tools let AI act through Liveblocks Comments, Notifications and Sync. A knowledge feature takes files and webpages. Access is not self-serve: "we'll reach out to you and enable it on your account" after a demo — [AI Copilots features](https://liveblocks.io/docs/products/ai-copilots/features)

**Velt**
- Velt is a Yjs-based CRDT layer with integrations for Tiptap and BlockNote. Agent edits that need consent go through "Suggestions": an agent posts a suggestion as a comment-style user, and a human approves or rejects it. On approve, the change "fires through your webhook" — [Velt CRDT docs](https://velt.dev/docs/realtime-collaboration/crdt); [Velt BlockNote page](https://velt.dev/libraries/blocknote)

### Inferences
- **Cheapest fully-OSS path to AI-edits-as-suggestions plus comments:** Plate (MIT, with built-in AI diff-to-suggestion and AI comments), or raw ProseMirror/Tiptap-core with `@handlewithcare/prosemirror-suggest-changes` plus `prosemirror-changeset`, which is the same stack BlockNote xl-ai uses.
- BlockNote xl-ai is the most turnkey "agent streams block ops, user reviews diff" implementation, but it is GPL-3.0. An open-source GPL app could use it freely. A closed-source app would need the Business subscription.
- Tiptap's agent/tool-calling model (tiptapRead/tiptapEdit, routed to tracked changes) is the most mature "agent over document" design. It is paid, and Tracked Changes is still Alpha.
- **Markdown fidelity:** Milkdown (remark-based) and Tiptap's `@tiptap/markdown` (MarkedJS) are markdown-native. Plate streams markdown. BlockNote's AI uses HTML as its LLM interchange format, which suggests its markdown export is lossy, as BlockNote docs generally note.

### Gaps
- No official prices were found for Tiptap's AI Toolkit or Tracked Changes (custom/sales), Liveblocks AI Copilots, Velt, or BlockNote's Business tier.
- The `@handlewithcare/prosemirror-suggest-changes` license was not confirmed. The README omits it, and the package.json was not fetched.
- Which Plate AI or Copilot features sit in paid Plate Plus versus MIT is not itemized in the docs.
- CKEditor's GPL/commercial split was taken from an unofficial mirror. Current ckeditor.com/legal wording was not fetched, and CKEditor AI pricing was not found.
- The BlockNote markdown import/export fidelity page was not fetched.
- Lexical official AI or 2025-2026 features: nothing official found.

## Q2: Open-source end-user apps (not demos) built on these frameworks that open/save local .md files with AI suggestions/comments

### Takeaway
No open-source end-user app was found that combines all of the following: local `.md` files, AI edits as accept/reject suggestions, and comments on Tiptap, BlockNote, Plate or Milkdown. The closest apps are server/collaboration apps (La Suite Docs, AFFiNE) or markdown editors without AI review.

### Cited Findings
- **La Suite Docs** (French and German government) is built on Django REST Framework, Next.js, BlockNote, HocusPocus and Yjs. Version 5.x reportedly added native AI writing assistance (Mistral and OpenAI via pydantic-ai, "mapped directly to BlockNote document operations"). Its licensing is described inconsistently: MIT overall, with a `PUBLISH_AS_MIT=true` build that strips the BlockNote XL packages. The README says XL packages used for PDF export are AGPL-3.0 and not MIT compatible. It is a server app, not a local .md app — [suitenumerique-docs](https://github.com/opf/suitenumerique-docs); [openapps.pro](https://openapps.pro/apps/docs)
- A La Suite Docs PR integrating BlockNote AI exists — [suitenumerique/docs PR #1016](https://github.com/suitenumerique/docs/pull/1016)
- BlockNote is used in Docs (La Suite/ZenDiS), OpenProject and XWiki (FOSDEM talk) — [FOSDEM](https://fosdem.hub.test.c3voc.de/event/detail/whats-new-in-blocknote-the-block-based-notion-styl)
- **AFFiNE** is built on BlockSuite (not BlockNote) with Yjs/OctoBase. It supports Markdown syntax and export, and has AI writing, summaries, and "BYOK & agent-ready AI workflows" — [AFFiNE editor docs (mintlify)](https://www.mintlify.com/toeverything/AFFiNE/features/editor)
- **Other candidates:**
  - **ScribeDog:** a local-first WYSIWYG markdown editor with local LLMs (Ollama, LM Studio). AI suggestions show as a preview to accept or discard. Its open-source status and framework were unconfirmed.
  - **GeekDown:** an OSS desktop markdown editor on Milkdown, with no AI or comments.
  - **Umo Editor:** Vue 3 on Tiptap, with AI creation; not local .md focused.
  - **Vrite:** Tiptap-based, with comments and GPT-3.5 (2023; possibly stale).
  - All from search summaries; not individually verified — [libhunt markdown editors](https://www.libhunt.com/topic/markdown-editor); [HN Vrite](https://news.ycombinator.com/item?id=36446045)

### Inferences
- A local-`.md` AI co-author with suggestion review and comments appears to be an open niche. Existing OSS apps are either cloud/collab document apps (Docs, AFFiNE) or plain markdown editors.
- Comments and suggestion metadata do not round-trip through plain markdown. Any local-.md product needs a sidecar or an embedded-annotation convention. None of the frameworks above define one for markdown files.

### Gaps
- ScribeDog's license and framework, and any 2026 local-first apps (Obsidian-plugin style or VS Code-based) built on these frameworks with AI suggestion review, were not verified within the search budget.

## Q3: How frameworks implement "AI edits as suggestions" (diff marks, suggestion marks, CRDT agent users)

### Takeaway
There are three patterns:
- **Post-hoc diff into suggestion marks:** Plate `applyAISuggestions`; BlockNote via `prosemirror-changeset` plus `prosemirror-suggest-changes`; Tiptap AI Toolkit's diff-based suggestions.
- **Tool calls whose transactions are recorded in suggestion mode under an AI author identity:** Tiptap `reviewOptions.mode: 'trackedChanges'` with `userId: 'ai-assistant'`; CKEditor AI Chat converting to Track Changes with AI-source labels.
- **CRDT-level agent users or approval gates:** Velt Suggestions via comment-style agent users and webhooks; BlockNote's `agentCursor` shown as a collaborator.

### Cited Findings
- **Plate:** diffs AI output against stored `chatNodes`, then writes transient suggestion nodes, which accept converts to permanent suggestions — [Plate AI docs](https://platejs.org/docs/ai)
- **BlockNote:** block-level `add`, `update` and `delete` stream tools. It depends on `prosemirror-changeset` and `@handlewithcare/prosemirror-suggest-changes`, uses an `agentCursor` for the AI, and resolves with `acceptChanges` or `rejectChanges` — [BlockNote AI reference](https://www.blocknotejs.org/docs/features/ai/reference); [xl-ai package.json](https://unpkg.com/@blocknote/xl-ai/package.json)
- **Tiptap:** the agent tool loop (`tiptapRead`/`tiptapEdit`) with tracked-changes review mode attributes edits to an AI user. Suggestions can also come from diffing against another document. Non-overlapping ranges are required — [Tiptap tracked changes](https://tiptap.dev/docs/ai/ai-toolkit/client/agents/review-changes/tracked-changes); [Tiptap Suggestions API](https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/api-reference/suggestions)
- **CKEditor:** AI proposals can be converted to Track Changes suggestions, with AI-source labeling (`showAISource`, `aiAuthor`) and "Outdated" status for stale suggestions — [newreleases v48.4.0](https://newreleases.io/project/github/ckeditor/ckeditor5/release/v48.4.0)
- **Velt:** "every agent suggestion is a change a human approves before it lands". Approval fires a webhook, which keeps trusted co-editing separate from consent-gated agent edits — [Velt BlockNote](https://velt.dev/libraries/blocknote)
- **ProseMirror primitive:** `withSuggestChanges()` turns any transaction into suggestion marks. An AI's edits applied through that dispatch become reviewable suggestions without custom diffing — [suggest-changes README](https://cdn.jsdelivr.net/npm/@handlewithcare/prosemirror-suggest-changes@0.1.8/README.md)

### Inferences
- For a markdown-file product, the simplest robust approach is to:
  1. Have the agent propose a new markdown text (or block ops).
  2. Parse it to a ProseMirror doc.
  3. Diff with `prosemirror-changeset`.
  4. Replay as suggestion marks via `prosemirror-suggest-changes`.

  This is the open-source core of what BlockNote xl-ai does, and it avoids GPL and paid add-ons.
- The "stale suggestion" problem, where the document changes under a pending AI suggestion, is handled explicitly only by CKEditor ("Outdated" status) among the sources reviewed.

### Gaps
- No source confirmed whether BlockNote AI forks a Yjs document for the AI's in-progress edits, or applies them directly as suggestion marks on the live doc.
- No documented "Yjs agent user" pattern (an AI connecting as a y-websocket peer) was found in official framework docs, beyond Velt's comment-style agent and Liveblocks' hosted copilots.
