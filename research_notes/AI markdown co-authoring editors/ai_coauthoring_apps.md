# AI-native document co-authoring products (AI as co-author/reviewer leaving comments and suggested edits)

Research date: 2026-10-14. About 17 tool calls. Sources are mostly vendor pages, release notes, GitHub READMEs and tech press. Where a source is a third-party directory or marketing page, that is noted.

## Which products do "doc editor + AI collaborator that comments and suggests edits" in 2025-2026, and how does each handle comments, suggestions, autonomy and accept/reject?

### Takeaway
By mid-to-late 2026 all three big incumbents have shipped "AI proposes, human approves" review flows. Microsoft Word Copilot does tracked changes plus anchored comments (GA June-July 2026). Google Docs Gemini drafts comments, replies and suggested edits from reviewer feedback (July 2026). Notion has "Ask your agent to suggest edits" (Aug 28, 2026). The newer AI-native field includes Every's **Proof**, launched March 11, 2026. It is free, MIT-licensed through proof-sdk, has comments, suggestions and provenance, and is built to be driven by external agents. Lex remains a closed, hosted editor whose AI works through comments.

### Cited Findings

**Microsoft Word + Microsoft 365 Copilot (closed, cloud/OneDrive .docx)**
- Message Center MC1384426 (published June 8, 2026) gives these dates: public preview from mid-May 2026 and worldwide GA from early June 2026, finishing early July 2026. It covers Word on Windows desktop and Mac for users with M365 Copilot, and the features are on by default — [MC1384426 via mc.merill.net](https://mc.merill.net/message/MC1384426)
- Copilot "makes edits with word-level precision" as tracked changes, which are visible by default. Users can turn on Track Changes from within Copilot — [MC1384426](https://mc.merill.net/message/MC1384426)
- Copilot "creates, reads, replies to, and manages comments anchored to document text." It can also insert and update a TOC, headers, footers and fields, and it shows progress messages during multi-step edits. Example prompts include "summarize pending tracked changes and comments" — [MC1384426](https://mc.merill.net/message/MC1384426)
- Conflict: Microsoft's Agent Mode help page still says Agent Mode "cannot add or modify comments" and cannot turn tracked changes on or off or accept or reject them. It also warns that a comment may be deleted if Agent Mode changes the paragraph it is anchored to. That page probably predates the 2026 update — [Agent Mode in Word (support.microsoft.com)](https://support.microsoft.com/office/agent-mode-in-word-647d5d14-eaec-4e8a-a574-7cefffa7f8f0); [search summary of the-decoder / Neowin coverage](https://the-decoder.com/microsoft-copilot-in-word-can-now-track-changes-and-manage-comments/)
- Earlier coverage said the features first appeared only on Windows desktop through the Office Insiders Beta / Frontier program, with web and Mac to follow — [the-decoder](https://the-decoder.com/microsoft-copilot-in-word-can-now-track-changes-and-manage-comments/); [Neowin](https://www.neowin.net/news/microsoft-words-copilot-just-got-much-smarter-at-handling-complex-edits/)
- The "Edit with Copilot" help page says that if Track Changes is on, Copilot's edits are tracked — [Edit with Copilot in Word](https://support.microsoft.com/en-us/word/edit-with-copilot-in-word)

**Google Docs + Gemini (closed, Google Drive cloud store)**
- In July 2026, Google Workspace Updates announced Gemini-powered comment workflows. Gemini can summarize and sort unresolved comments by reviewer or theme, insert comments for you (for example, reviewing "as a copy editor"), draft replies to open threads (it can pull in Drive files), and "suggest updates to document content based on reviewer feedback." Those updates appear as suggested edits that you review, approve and apply — [Google Workspace Updates blog, July 2026](https://workspaceupdates.googleblog.com/2026/07/streamline-collaboration-in-google-docs-with-Gemini-powered-comment-workflows.html)
- Press coverage says Gemini does not publish comments or make permanent text changes on its own. It produces drafts and markups for the user to approve — [Ubergizmo, July 2026](https://www.ubergizmo.com/2026/07/google-docs-smart-review-gemini-now-reads-replies-and-edits/); [Android Authority](https://androidauthority.com/gemini-google-docs-comments-3692242)
- Access is through the bottom bar or the Gemini side panel, and requires edit access. Plans include Business Standard and Plus, Enterprise Standard and Plus, Education Plus, and Google AI Pro and Ultra — [Workspace Updates](https://workspaceupdates.googleblog.com/2026/07/streamline-collaboration-in-google-docs-with-Gemini-powered-comment-workflows.html)

**Notion AI / Notion agents (closed, proprietary cloud block store)**
- Notion's release of Aug 28, 2026, "Ask your agent to suggest edits," says "Your agents can now propose changes instead of making them directly." The user reviews the suggestions top to bottom and approves each one. It is recommended for line-level changes such as a grammar pass — [Notion releases 2026-08-28](https://www.notion.com/releases/2026-08-28)
- Human suggested edits and grouped comment and suggestion threads in the Inbox came earlier (2024). Release notes say any collaborator can suggest, and you can "quickly accept or reject" — [Notion release 2.43, 2024-07-29](https://www.notion.com/releases/2024-07-29)

**Proof by Every (proofeditor.ai): hosted is free, SDK is MIT open source**
- Launched March 11, 2026 as "an online document editor built for agents and humans to collaborate," aimed at the PRDs, plans, research briefs and memos that agents write. It is free with no login. An Every account gives you a document library — [Every, "Introducing Proof"](https://every.to/on-every/introducing-proof)
- Features include live multi-user editing, comments and tracked changes. A colored rail shows provenance: green is human text and purple is AI text — [Introducing Proof](https://every.to/on-every/introducing-proof); [help.every.to "What is Proof"](https://help.every.to/en/articles/14291292-what-is-proof)
- The homepage says agents suggest edits and the user can accept, reject or reply. "Every character tracks who wrote it." Comments have reply and resolve — [proofeditor.ai](https://www.proofeditor.ai/)
- It began as an internal tool at Every and was later launched as a full product (Dan Shipper on the podcast). Some homepage copy once called it "an agent-native markdown editor for Mac," which conflicts with the web-editor descriptions — [Every podcast transcript](https://every.to/podcast/transcript-how-we-use-proof-a-collaborative-editor-for-humans-and-ai); [search snippet of proofeditor.ai](https://www.proofeditor.ai/)

**Lex (lex.page): closed, hosted**
- In February 2023, Lex added Google-Docs-style comments with draft comments and an "AI Rewrite" button. Highlight text and "the AI will leave a comment with a suggestion for a rewrite" — [Lex newsletter, "New in Lex: comments, AI rewrite"](https://buttondown.com/lex/archive/new-in-lex-comments-ai-rewrite); [Paragraph post, Feb 6, 2023](https://paragraph.com/@kazani/lex-is-evolving)
- Lex's 2024 positioning says it was built by writers to give "deep feedback on your writing," as opposed to bulk generation or generic rewrites. Lex for Teams was also announced — [Lex newsletter, "Announcing Lex for Teams"](https://buttondown.com/lex/archive/announcing-lex-for-teams/)
- A GetApp listing (updated Sept 2026; third-party, not verified against lex.page) describes these features: a document Chat panel, "Ask Lex" inline comments that use the whole document as context, "AI Checks" (writing-improvement suggestions), custom saved prompts, Style Guides built from uploaded samples, Knowledge Bases, and user-selectable models from OpenAI, Anthropic and TogetherAI — [GetApp listing](https://www.getapp.com/all-software/a/lex/)

**Grammarly "docs" + agents (now Superhuman; closed, cloud)**
- On Aug 18, 2025, Grammarly launched specialized AI agents inside "docs," a new AI-native writing surface. Agents include Reader Reactions, AI Grader, Proofreader, Citation Finder, AI Detector and Plagiarism Checker (the last two Pro-only). They were later to roll out across more than 500k apps — [BusinessWire press release](https://www.businesswire.com/news/home/20250818186419/en/Grammarly-Launches-Specialized-AI-Agents-and-Writing-Surface-for-Students-and-Professionals); [Neowin](https://www.neowin.net/news/grammarly-expands-ai-efforts-with-eight-new-writing-focused-agents/)
- Grammarly rebranded as Superhuman. The suite includes Grammarly, Coda, Superhuman Mail and the Superhuman Go assistant — [Thurrott](https://www.thurrott.com/a-i/328965/grammarly-rebrands-to-superhuman-and-launches-new-ai-suite); [Superhuman help center](https://help.superhuman.com/hc/en-us/articles/46242075007373)
- The "Expert Review" agent, which gave suggestions in the style of well-known writers, was removed after backlash and a class-action lawsuit. Superhuman says future features will be opt-in — [search summary citing Yahoo/AOL coverage](https://tech.yahoo.com/ai/articles/grammarly-pushes-beyond-proofreading-ai-214500951.html)

**ChatGPT Canvas (closed)**
- Canvas has a "show changes" view: green for additions and red for deletions, for both text and code. It was added in response to requests for track changes after Canvas launched in October 2024 — [VentureBeat](https://venturebeat.com/ai/chatgpts-canvas-now-shows-tracked-changes)
- Canvas review gives inline feedback as comments to the right of the text, with an "Apply" button to accept each suggestion. This comes from a secondary guide — [Coursera article](https://www.coursera.org/articles/canvas-chatgpt)

**Type.ai and Moonbeam (closed)**
- Type (YC) now describes itself as an "AI-native document editor" for long-form writing (books, novels, essays, screenplays). Its earlier pitch was to marketers. A profile reports a $2.8M pre-seed raise in Sept 2025 and the company claims more than 300k writers — [YC company page](https://www.ycombinator.com/companies/type); [YC launch](https://www.ycombinator.com/launches/I2D-type-an-ai-first-document-editor); [extruct.ai profile](https://www.extruct.ai/hub/type-ai/)
- Moonbeam is still listed as a long-form AI writing assistant, with little independent coverage and no news of a shutdown or pivot — [Capterra](https://www.capterra.com/p/10011226/Moonbeam/); [toolsforhumans review](https://www.toolsforhumans.ai/ai-tools/moonbeam-ai)

### Inferences
- In 2026, AI review UX across the incumbents has settled on reusing the existing human-review primitives: anchored comments plus suggestion mode or tracked changes. The agent writes into the same review channel a human reviewer would, rather than overwriting text. Word, Docs and Notion all made this change between May and Aug 2026.
- Lex's distinctive model, where the AI's suggestions arrive as margin comments, has been around since 2023 and is now matched by Google Docs and Word.
- Proof is the closest commercial or open-source product to an "editor for agent-written markdown docs with comments, suggestions and provenance." It is the main reference point for any new open-source project in this space.

### Gaps
- Could not confirm whether Word's tracked-changes and comment support works in **Agent Mode** specifically, or only in the Copilot chat and edit flow. The Agent Mode help page contradicts the June 2026 notice.
- Did not get current primary-source detail on Lex's 2025-2026 product: whether it has tracked-change suggestions (rather than comment-only rewrites), agent mode, or ownership and company status.
- No research done on Craft, Wordtune or Claude (Artifacts or any Claude doc editor). The single search found no evidence that Claude Artifacts supports anchored comments or suggested edits.
- Did not verify whether Grammarly docs agents leave anchored comments or tracked suggestions. They appear to be sidebar suggestion cards, but this is unverified.

## File model: local plain markdown, markdown export, or proprietary/cloud store?

### Takeaway
The incumbents (Word .docx in OneDrive, Google Docs, Notion blocks, Grammarly/Superhuman docs, Lex) all use cloud or proprietary stores. Only the open-source tools (OpenWriter, Markra) keep plain `.md` files on local disk. Proof sits in between: markdown-based and fetchable as raw markdown over HTTP, but stored on a hosted server.

### Cited Findings
- **OpenWriter**: "Documents are plain .md files on disk," with no database and no proprietary format. It has Git sync, version history with rollback, and export to Markdown, HTML, Word, plain text and PDF — [GitHub travsteward/openwriter](https://github.com/travsteward/openwriter)
- **Markra**: plain `.md` files on local disk, opened as single files or folder workspaces. It has optional WebDAV sync and only contacts services the user configures — [GitHub markrahq/markra](https://github.com/markrahq/markra)
- **Proof**: shared doc pages can be fetched "with Accept: text/markdown to get raw markdown" — [proofeditor.ai shared doc snippet](https://www.proofeditor.ai/d/g0v8racn). The SDK describes a "collaborative markdown editor" and includes a `packages/doc-store-sqlite` package, so the server stores documents in SQLite rather than local files — [EveryInc/proof-sdk](https://github.com/EveryInc/proof-sdk). The homepage pitch "Leave .md files behind" positions Proof as a replacement for local markdown files — [proofeditor.ai](https://www.proofeditor.ai/); the launch post contrasts it with agent docs "living in Markdown files on laptops" — [Introducing Proof](https://every.to/on-every/introducing-proof)
- **Word Copilot**: works on Word documents and keeps "existing formatting and collaboration history" — [MC1384426](https://mc.merill.net/message/MC1384426)

### Inferences
- There is a clear gap between local-first plain markdown with sidecar review state and cloud collaboration with provenance. OpenWriter and Markra keep files local, but they appear to have only a pending-change review, not persistent anchored comment threads. Proof has the full review model but is server-based.

### Gaps
- Did not find how Proof persists comments and suggestions (inline marks in the markdown, or a separate store) or whether it supports round-trip import and export of local .md files.
- Lex's export formats were not confirmed.

## Open-source status, license, self-hosting, bring-your-own-model

### Takeaway
The open-source options found are Proof SDK (MIT, self-hostable Node server plus editor, about 1.1k stars), Markra (AGPL-3.0, desktop plus web, BYO model including Ollama, about 917 stars) and OpenWriter (MIT, MCP-driven, about 35 stars but 1,241 commits). Every incumbent is closed. Lex lets you choose a model but not bring your own key or self-host.

### Cited Findings
- **Proof SDK**: MIT code license (trademarks are separate). It includes the collaborative markdown editor with provenance, "comments, suggestions, and rewrite operations," a realtime collaboration server, an agent HTTP bridge and an example app. Self-hosting needs Node 18+: `npm run dev` runs the editor on :3000 and `npm run serve` runs the API on :4000. About 1.1k stars, 196 forks, an ADR dated 2026-03, and 10 commits on main — [EveryInc/proof-sdk](https://github.com/EveryInc/proof-sdk). The homepage says the open-source SDK "is a snapshot that lags the hosted product" — [proofeditor.ai](https://www.proofeditor.ai/)
- **Markra**: AGPL-3.0. Desktop builds for macOS, Windows and Linux, plus a web editor at editor.markra.app. BYO model: OpenAI, Anthropic, Gemini, Ollama or any OpenAI-compatible endpoint, with separate models allowed for inline editing and the side panel. About 917 stars and 54 forks, © 2026 — [GitHub markrahq/markra](https://github.com/markrahq/markra)
- **OpenWriter**: MIT, by Travis Steward. 35 stars and 1,241 commits, no tagged releases. There is a near-identical mirror at iviaxpow3r/openwriter — [travsteward/openwriter](https://github.com/travsteward/openwriter); [iviaxpow3r/openwriter](https://github.com/iviaxpow3r/openwriter)
- **Write Assist AI** (VS Code extension, open source) has inline accept and reject of AI rewrites with a git-diff-style interface for Markdown, LaTeX, Quarto and Typst — [GitHub ra-jeev/write-assist-ai](https://github.com/ra-jeev/write-assist-ai)
- **Others** found but not verified: Intellicode/writer (markdown editor with Ollama), MarkDX ("open source AI markdown editor" with suggestions), and TinaCMS Markdown Bot (suggestions as PR review commits on GitHub) — [Intellicode/writer](https://github.com/Intellicode/writer); [MarkDX](https://markdx.vercel.app/); [DEV: Markdown Bot](https://dev.to/tinacms/markdown-bot-an-ai-friend-who-improves-your-content-1dpd)
- **Lex model selection** (per a third-party listing): it routes to OpenAI, Anthropic and TogetherAI models through enterprise APIs, and users can switch models — [GetApp](https://www.getapp.com/all-software/a/lex/)

### Inferences
- No open-source project was found that combines all of these: local plain-markdown files, persistent anchored comment threads, tracked suggestions with accept and reject, and external-agent access over MCP or CLI. Proof SDK has the review model but is server and SQLite based. OpenWriter and Markra are local-file based but lack comment threads.

### Gaps
- Did not check Proof SDK's commit cadence after March 2026, or whether the hosted product and the SDK have diverged a lot.
- Markra's and OpenWriter's repository creation dates and first-release dates were not visible.

## External agent integration (MCP, API, CLI, skills)

### Takeaway
Proof (HTTP bridge plus an installable agent "skill"; works with Claude Code, Codex, OpenClaw and ChatGPT) and OpenWriter (an MCP server with 24 tools) are the products built to be driven by outside agents. Markra speaks ACP (Agent Client Protocol) to local agents. The incumbents' AI is in-app only. No public MCP or agent API was found for Lex.

### Cited Findings
- **Proof HTTP bridge**: routes under `/documents/:slug/bridge/` for `state`, `marks`, `comments`, `suggestions`, `rewrite` and `presence`, plus `/edit`, `/edit/v2`, `/ops`, `/presence`, and `/events/pending` with `/events/ack` (event polling with acknowledgement). The README lists no explicit accept or reject endpoint — [EveryInc/proof-sdk](https://github.com/EveryInc/proof-sdk)
- **Proof agent setup**: agents create docs over HTTP and identify themselves with an `X-Agent-Id` header on `/state` and `/presence`. Codex installs a `proof` skill file, and setup lives at `/agent-setup`. You can also paste a doc link into an agent. Named agents are OpenClaw, Claude Code, Codex and ChatGPT. The homepage does not mention MCP or a CLI — [proofeditor.ai](https://www.proofeditor.ai/). The launch post says "Anything you can do in Proof, your agent can do just as easily," and that agents connect through plain HTTP rather than browser automation — [Introducing Proof](https://every.to/on-every/introducing-proof)
- **OpenWriter**: an MCP server with 24 tools to read, write and organize documents. Agent edits show as colored pending decorations (green insert, blue rewrite, red delete) that the user accepts or rejects with a keystroke. It names Claude Code, Cursor, Codex and OpenCode, and claims "20+ agents" and "any MCP-compatible agent." The README does not mention comments — [travsteward/openwriter](https://github.com/travsteward/openwriter)
- **Markra**: supports the Agent Client Protocol for local agents, with model discovery, permission prompts and editor write previews. Every AI edit is previewed for accept, reject or copy — [markrahq/markra](https://github.com/markrahq/markra)
- **Scratch** (from a search snippet only): an offline-first markdown notes app said to integrate with local CLI tools such as Claude Code and Codex for AI editing — [search results summary](https://github.com/iviaxpow3r/openwriter) (snippet; primary repo not fetched)
- **Lex**: searches for a Lex.page MCP server or API turned up only unrelated "Lex" MCP servers (EUR-Lex legal search, @smartergpt/lex-mcp) — [socket.dev @lexapi/mcp](https://socket.dev/npm/package/@lexapi/mcp/overview/0.1.3); [getdrio listing](https://www.getdrio.com/mcp/dev-smartergpt-lex)

### Inferences
- Two integration patterns have emerged. One is HTTP bridge plus agent skill, with events and ack for agent wake-up (Proof). The other is an MCP tool server over local files (OpenWriter). ACP (Markra) is a third, editor-hosts-agent pattern.
- The incumbents expose documents through general platform APIs (Graph, Docs API, Notion API/MCP). None of the sources reviewed present these as a way for outside agents to post tracked suggestions. This was not verified.

### Gaps
- Did not verify whether Google Docs API, Microsoft Graph or Notion's API/MCP let an external agent create suggestion-mode edits (as opposed to direct edits or comments).
- Could not confirm "Scratch" (repo, license, accept/reject UX).

## Open-source projects launched 2025-2026 explicitly positioned as "open-source Lex / AI co-writer"

### Takeaway
No project was found that explicitly brands itself as "open-source Lex." The closest positioning is OpenWriter ("The open-source writing surface for AI agents... your agent writes, you accept or reject") and Proof SDK (Every's open-source agent-human editor, March 2026). Markra positions itself as an open-source WYSIWYG markdown editor with native AI.

### Cited Findings
- OpenWriter's tagline: "The open-source writing surface for AI agents. Markdown-native editor with pending change review — your agent writes, you accept or reject." — [GitHub travsteward/openwriter](https://github.com/travsteward/openwriter)
- Proof SDK describes itself as an "open-source collaborative editor, provenance model, and agent HTTP bridge that powers collaborative documents in Proof" — [EveryInc/proof-sdk](https://github.com/EveryInc/proof-sdk)
- Markra: "A WYSIWYG Markdown editor with native AI. Fully open source. Free to use. Your data stays local." — [GitHub markrahq/markra](https://github.com/markrahq/markra)
- A search for an "open-source alternative to Lex" returned only commercial alternatives (Grammarly, DeepL Write) and an unrelated self-hosted Grammarly clone — [toolradar Lex alternatives](https://toolradar.com/alternatives/lex); [postmake alternatives](https://postmake.io/alternatives/lex)

### Inferences
- The "open-source AI co-writer" niche in 2026 is moving toward agent-writes and human-reviews tools aimed at coding-agent users (Claude Code, Codex). It is not a clone of Lex's writer-first UX.

### Gaps
- No GitHub-wide topic search was run (for example, GitHub topics "ai-writing" or "track-changes"), so smaller projects may be missing. No Hacker News or Product Hunt launch threads were reviewed for OpenWriter, Markra or Proof, so community reception and exact launch dates (other than Proof's March 11, 2026) are unknown.
