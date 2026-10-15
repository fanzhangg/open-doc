# Tools that let external AI agents (Claude Code, Codex CLI, Cursor, MCP clients) co-author or review markdown/prose with a human

Research date: 2026-10-14. Star counts, licenses and last-push dates come from the GitHub REST API (`gh api repos/<owner>/<repo>`) queried on 2026-10-14; the repo URL is the source for each. "License: none" means GitHub detected no license file. That does not prove the code is unlicensed, but no permissive license was found.

## 1. Which projects let an agent leave anchored comments or suggested edits on markdown that a human reviews in a GUI, and how do they keep anchors stable?

### Takeaway
A crowded niche of small open-source tools appeared between late 2025 and October 2026. Almost all are MIT-licensed and under one year old. They split into four anchoring/storage families:
- **Inline markup in the .md file.** CriticMarkup (Roughdraft, mcp-criticmarkup) or invisible HTML-comment markers (md-redline, markdown-review).
- **Sidecar JSON keyed by a W3C-style text-quote selector with fuzzy re-anchoring.** markdown-claude-review is the most rigorous public example.
- **Line-number anchoring in a separate review store.** Crit.
- **Editor-internal marks/CRDT in a database.** Proof SDK, MarkDocs, Prose.

Most use plain (often blocking) CLI calls or a stdio MCP server for agent integration.

### Cited Findings

**Closest analogues to open-doc (local server + browser/editor GUI + comment store + CLI/MCP with blocking wait)**

- **Roughdraft (Lex-Inc/roughdraft).** This is the closest analogue to open-doc's design.
  - Stats: 454 stars. GitHub detects no license. Created 2026-04-22, last push 2026-06-19 — [GitHub](https://github.com/Lex-Inc/roughdraft)
  - Product: a "local-first markdown editor and viewer for working with AI". It opens a single .md file and stores comments and suggested changes inline as **CriticMarkup**, extended with attribute blocks like `{id="c3" by="user" at="..."}` and `re="c3"` for threaded replies — [README](https://github.com/Lex-Inc/roughdraft)
  - Server: `roughdraft start` runs a background localhost server (port 7373) and writes state to `~/.roughdraft/server.json` — [README](https://github.com/Lex-Inc/roughdraft)
  - Blocking review handoff: `roughdraft open file.md --json` blocks until the human clicks **Done Reviewing**. It then prints a `review.completed` event JSON with path, file version, feedback counts and optional `overallComment`. There is no default timeout; `--timeout` sets one — [README](https://github.com/Lex-Inc/roughdraft)
  - Overall comments are written as YAML endmatter, so "Markdown remains the durable source of truth" — [README](https://github.com/Lex-Inc/roughdraft)
  - Experimental `roughdraft mcp` stdio server: tools to read the review index, list pending feedback, watch review events, append replies and mark items resolved — [README](https://github.com/Lex-Inc/roughdraft)
  - Ecosystem of forks and add-ons:
    - kudzuweb/roughdraftplus (active 2026-10-14; issues propose an "approve" action that clears threads on Done Reviewing) — [GitHub](https://github.com/kudzuweb/roughdraftplus), [issue #9](https://github.com/kudzuweb/roughdraftplus/issues/9)
    - moiri-gamboni/roughdraft fork, which claims to fix "three bugs that break the review loop in 0.1.10" (missing yaml dep, a waiter crash at 300s, endmatter replies not rendering) — [GitHub](https://github.com/moiri-gamboni/roughdraft)
    - pmbaumgartner/pi-roughdraft integration for the Pi agent (MIT) — [GitHub](https://github.com/pmbaumgartner/pi-roughdraft)
    - A practitioner blog describes using it with Claude Code: the agent waits until "Done Reviewing", then applies only the CriticMarkup edits — [blog](https://aaron-nam-astro-blog.pages.dev/posts/claude-code-setup-log-11-three-agent-setups/)
- **md-redline (dejuknow/md-redline).**
  - Stats: 42 stars, MIT, created 2026-03-23, last push 2026-09-26. About 743 commits — [GitHub](https://github.com/dejuknow/md-redline)
  - Storage: comments are **invisible HTML comment markers inside the .md**, placed before the anchored text. Each marker holds JSON with `id, anchor, text, author, timestamp, replies`. There is no sidecar or DB — [GitHub](https://github.com/dejuknow/md-redline)
  - GUI: rendered, raw and diff views; threaded replies; open/resolved states; live reload via SSE — [GitHub](https://github.com/dejuknow/md-redline)
  - MCP tools:
    - `mdr_request_review`: agent asks for review and pauses
    - `mdr_comment`: agent posts anchored comments (renamed from `mdr_review` in 0.9)
    - `mdr_ask`: blocking anchored questions
    - `mdr_wait`
    - `mdr_baseline`: snapshot for the diff view
    - `mdr_add_files`
    - Source: [GitHub](https://github.com/dejuknow/md-redline)
  - CLI: `mdr <file|dir>`, `mdr mcp install` (registers with Claude Code/Desktop), `mdr baseline --hook`. Works with Claude Code, Claude Desktop, Codex CLI, Gemini CLI and any stdio MCP client. The server binds 127.0.0.1 with no auth — [GitHub](https://github.com/dejuknow/md-redline)
  - The README does not explain how anchors survive text changes; it mentions only manual drag handles to adjust anchors — [GitHub](https://github.com/dejuknow/md-redline)
  - A fork with the same README exists at sethfitz/md-redline — [GitHub](https://github.com/sethfitz/md-redline)
- **markdown-claude-review (MagicMicky).** A VS Code extension, not a browser app.
  - Stats: 0 stars, MIT, created 2026-09-03, last push 2026-10-07 — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
  - Product: Google-Docs-style threads wired to Claude Code over MCP. "You comment; Claude edits, replies, and resolves." Thread states are open / answered / resolved / stale — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
  - **Sidecar**: `docs/strategy.md -> .review/docs/strategy.md.review.json`, which is "plain, diffable, greppable" — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
  - **Anchoring (the most detailed public design found)**: "Comments store no line numbers." Each comment uses a W3C-style text quote selector: the exact quote, about 48 characters of context on either side, and the heading trail. On every save it re-resolves through a cascade:
    1. Unique exact quote: **exact**
    2. Repeated exact quote, disambiguated by context agreement: **exact**, or **drifted** when agreement is weak
    3. Fuzzy paragraph match (Sørensen–Dice over character trigrams) within the original section: **drifted**
    4. Document-wide fuzzy match at a stricter threshold: **drifted**
    - The default similarity threshold is `mdreview.fuzzyThreshold = 0.62`. Drifted threads keep showing the original wording — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
  - Concurrency: the extension and the MCP server both write the sidecar. Each merges against disk right before writing, unioning messages and resolving the rest by timestamp. An unparseable sidecar is never overwritten — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
  - MCP tools include `list_threads`, `get_thread` and others; setup writes `.mcp.json` and a `/markdown-review` slash command — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
- **couplet (malinborn/couplet).** Formerly md-mini.
  - Stats: 22 stars, GPL-3.0, last push 2026-10-06 — [GitHub](https://github.com/malinborn/couplet)
  - Product: a native macOS markdown editor "your AI agent can drive". It has no built-in AI and exposes a local Unix socket plus a stdio MCP server with `show`, `edit` and `ask` tools; every operation is also a shell verb — [GitHub](https://github.com/malinborn/couplet)
  - Comments live in a **markdown sidecar** `.mdmini_comments_<file>.md` beside the document. The CLI verbs read and write the sidecar directly, so they work with the app closed — [GitHub](https://github.com/malinborn/couplet)
  - `couplet watch` can be armed as a Claude Code **Monitor**, so a new comment interrupts the existing session. The agent is woken only after the user has been quiet for 20 s — [GitHub](https://github.com/malinborn/couplet)
- **Pena (mshddev/pena).**
  - Stats: 0 stars, MIT, last push 2026-10-09 — [GitHub](https://github.com/mshddev/pena)
  - Product: Claude "publishes" a markdown/HTML/Excalidraw draft to a local Fastify + **SQLite** server. The human selects text, comments and submits. Documents can include inline single-choice "decision blocks" — [GitHub](https://github.com/mshddev/pena)
  - CLI:
    - `pena feedback wait <slug> [--after <batch-id>] [--timeout]` blocks for the next submission
    - `pena feedback watch` long-polls and prints JSON lines
    - Publishing uses ETags plus `--feedback-match` for optimistic concurrency
    - Exit codes: 3 = precondition failed, 4 = wait timed out
    - Source: [GitHub](https://github.com/mshddev/pena)
  - Storage is a database (not files on disk); version history allows compare and restore — [GitHub](https://github.com/mshddev/pena)
- **claude-review (Ch00k/claude-review).**
  - Stats: 32 stars, Unlicense, last push 2025-11-20, so it looks dormant — [GitHub](https://github.com/Ch00k/claude-review)
  - Workflow: a Go binary renders markdown in the browser for inline threaded comments. The `/cr-review` and `/cr-address` slash commands let Claude Code fetch threads, reply, edit and resolve — [GitHub](https://github.com/Ch00k/claude-review)
  - It was listed as a resource in awesome-claude-code — [issue #327](https://github.com/hesreallyhim/awesome-claude-code/issues/327)

**Plan/diff review tools (adjacent: agent output review rather than document co-authoring)**
- **Plannotator (backnotprop/plannotator).**
  - Stats: 9,421 stars (by far the largest), Apache-2.0/MIT, created 2025-12-28, pushed 2026-10-14 — [GitHub](https://github.com/backnotprop/plannotator)
  - Plan review: a Claude Code `PermissionRequest` hook on `ExitPlanMode` opens a browser UI. The approve/deny decision returns to the agent with structured feedback — [GitHub](https://github.com/backnotprop/plannotator)
  - Beyond plans, it also annotates markdown files, folders, URLs, HTML and PR diffs — [GitHub](https://github.com/backnotprop/plannotator)
  - Supported agents: Claude Code, Codex, Copilot CLI, Gemini CLI, OpenCode, Kiro, Droid, Amp and Pi — [GitHub](https://github.com/backnotprop/plannotator)
  - Data lives under `~/.plannotator`. Sharing works via URL fragment, or AES-256-GCM encrypted paste. MCP is not mentioned, and the anchoring model is not documented — [GitHub](https://github.com/backnotprop/plannotator)
- **Crit (tomasz-tomczyk/crit).**
  - Stats: 1,211 stars, MIT, Go binary, pushed 2026-10-12 — [GitHub](https://github.com/tomasz-tomczyk/crit)
  - Review model: plans, diffs and running apps are reviewed in the browser. Comments anchor to **line numbers / line ranges**, and the agent receives the quoted selected text, file path and line range — [GitHub](https://github.com/tomasz-tomczyk/crit)
  - Storage: one review per branch in `~/.crit/reviews/`, or in the repo with `--output .crit` — [GitHub](https://github.com/tomasz-tomczyk/crit)
  - CLI: `crit comment` (file:line, `--selector`, `--json`), `status`, `resume`, `share`, `pull`, `push` and `live`. The `/crit` command makes the agent launch Crit and wait for review — [GitHub](https://github.com/tomasz-tomczyk/crit), [site](https://crit.md/)
  - Integrations: plugins for Claude Code and Cursor, with listed support for Codex, Copilot, OpenCode, Gemini and Aider. No MCP — [GitHub](https://github.com/tomasz-tomczyk/crit)
  - Not documented: how anchors survive edits — [GitHub](https://github.com/tomasz-tomczyk/crit)
- Smaller Claude Code plan reviewers, all created Sept–Oct 2026 with 0–2 stars:
  - shyamalaravind/plan-review: an Agent Skill; no license — [GitHub](https://github.com/shyamalaravind/plan-review)
  - primestack-labs/plan-review: a Claude Code plugin with section verdicts; Apache-2.0 — [GitHub](https://github.com/primestack-labs/plan-review)
  - damiafuentes/claude-code-plan-viewer: copy/paste feedback; MIT — [GitHub](https://github.com/damiafuentes/cc-plan-viewer)

**IDE-embedded review**
- **markdown-review (jinqishen0725).**
  - Stats: 3 stars, MIT, last push 2026-08-25 — [GitHub](https://github.com/jinqishen0725/markdown-review)
  - A VS Code/Cursor extension that reviews .md, .docx and .pptx — [GitHub](https://github.com/jinqishen0725/markdown-review)
  - Markdown comments are "block-level anchored" with internal `<!--@c...-->` markers in the source. These are hidden in edit mode and "reinserted into the source as clean-text offsets move" — [GitHub](https://github.com/jinqishen0725/markdown-review)
  - Native Word comments get replies via a sidecar — [GitHub](https://github.com/jinqishen0725/markdown-review)
  - Agent tools: 12 Copilot tools, mirrored by an embedded stdio MCP server auto-registered in `~/.cursor/mcp.json` (e.g. `docReview_read_comment`) — [GitHub](https://github.com/jinqishen0725/markdown-review)
- **Palarix/claude-review.** A VS Code webview extension; comments are sent to the Claude Code terminal or the clipboard. 0 stars, MIT — [GitHub](https://github.com/Palarix/claude-review)
- **md-tui PR #238.** Adds a comment/review mode to a terminal markdown renderer, with "Sidemark export" and a Claude Code review hook. md-tui itself has 554 stars and is AGPL-3.0 — [PR](https://github.com/henriklovhaug/md-tui/pull/238), [repo](https://github.com/henriklovhaug/md-tui)

**CriticMarkup-for-agents**
- **mcp-criticmarkup (Martennnnn).**
  - Stats: 0 stars, MIT, Python, created 2026-10-05 — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup)
  - The LLM proposes CriticMarkup track changes (search/replace arrays applied bottom-to-top "to prevent offset drift") and global substitutions that skip code, links, frontmatter and existing CriticMarkup — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup)
  - Comments are anchored with paired markers `<!--c:{id}s-->...<!--c:{id}e-->`, with a Monoleaf-compatible thread payload appended at the end of the file. Edits "slide comment anchors to the perimeter of the edit" — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup)
  - The reader tool abbreviates thread payloads into `[UID] Author: Message` to save tokens. The human reviews in a CriticMarkup-aware editor such as Monoleaf — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup)

**Hosted / commercial / database-backed agent-native editors**
- **Proof (Every).** The hosted product is "free, no login required"; agents suggest edits and comment, humans accept/reject/reply, and "every character tracks who wrote it" — [proofeditor.ai](https://www.proofeditor.ai/)
  - Agent integration is via a share link plus a skill file and HTTP API, with an `X-Agent-Id` header for presence — [proofeditor.ai](https://www.proofeditor.ai/)
  - The open-source **Proof SDK (EveryInc/proof-sdk)**: 1,120 stars, MIT, last push 2026-08-27. It is a collaborative markdown editor with a provenance model and an "agent HTTP bridge" exposing endpoints such as `GET /documents/:slug/bridge/marks`, `POST .../bridge/comments` and `POST .../bridge/suggestions`. The SDK "lags the hosted product" — [GitHub](https://github.com/EveryInc/proof-sdk), [proofeditor.ai](https://www.proofeditor.ai/)
- **MarkDocs (thakurkharel/markdocs).** MIT, self-hosted (Docker Compose + PostgreSQL), real-time editing via **Yjs CRDTs**, threaded comments anchored to text, inline accept/reject suggestions, a 23-tool stdio MCP server and a CLI with find/replace for agents — [markdocs.sh](https://www.markdocs.sh/). I could not retrieve GitHub stats (search returned nothing).
- **Comment.io.** Described as an "agent-native document editor" with real-time editing, comments, suggestions and per-edit human-vs-AI attribution. The GitHub repo (2 stars, MIT) holds docs, integrations and skill files, not clearly the editor source — [GitHub](https://github.com/comment-hq/comment.io)
- **mdreview (glama connector).** A hosted Streamable-HTTP connector: agent pushes draft, human comments, agent revises. The listing marks it as untested — [glama](https://glama.ai/mcp/connectors/io.github.ranawaqas-ai/mdreview)
- Others with unclear comment support or licensing:
  - OpenMarkdown: local-first co-editing; license not found — [Product Hunt](https://www.producthunt.com/products/openmarkdown)
  - OpenKnowledge: GPL-3.0 WYSIWYG editor with Claude Code/Codex/Cursor integrations; comments not described — [TechTimes](https://www.techtimes.com/articles/319223/20260628/open-source-ai-markdown-editor-openknowledge-wires-claude-codex-local-files.htm)
  - HackMD has a 2026 roundup of "markdown editors for your agents" — [HackMD blog](https://homepage.hackmd.io/blog/2026/06/03/best-markdown-editor-2026)

**Prose (solo-ist/prose) PR #854 (desktop app with MCP review lifecycle)**
- Prose is an Electron + React + TipTap/ProseMirror "Markdown editor for the agentic era". 6 stars, MIT, active 2026-10-13 — [GitHub](https://github.com/solo-ist/prose)
- Open PR #854 adds nine MCP review tools (list suggestions, add feedback, revise, decide, read event history, status) plus `insert_after`, `suggest_delete` and `reopen_comment` — [PR #854](https://github.com/solo-ist/prose/pull/854)
- Design details from the PR:
  - Suggestions are **editor marks with IDs** grouped across nodes
  - A durable append-only event log in IndexedDB
  - Attribution as You / MCP / model
  - Document-ID checks before and after waiting for saves, so changes cannot land in the wrong document
  - A human "Suggesting" mode
  - The maintainer wants final accept/reject to stay with the human, with autonomous `decide_suggestion` as a later opt-in
  - Not merged; planned split into issues #888–#891
  - Source: [PR #854](https://github.com/solo-ist/prose/pull/854)

### Inferences
- The anchoring approaches rank roughly by robustness to out-of-band agent rewrites:
  1. Text-quote + context + fuzzy cascade (markdown-claude-review), which closely mirrors Hypothesis/W3C practice
  2. Inline markers inside the file (md-redline, mcp-criticmarkup, markdown-review, Roughdraft CriticMarkup): robust to edits elsewhere, but they pollute the source and can be clobbered by an agent that rewrites the paragraph
  3. Line numbers (Crit): simplest, most fragile
  4. Editor marks/CRDT positions (Proof, MarkDocs, Prose): robust only while all edits go through the editor, not when an agent edits the .md on disk
- open-doc's architecture (local server + browser editor + sidecar store + CLI with inbox/wait) overlaps most with:
  - Roughdraft: blocking `open --json` wait, CLI + MCP, local server
  - md-redline: `mdr_wait`/`mdr_request_review`
  - Pena: `feedback wait/watch`, ETag concurrency
  - markdown-claude-review: sidecar + W3C text-quote anchors + fuzzy re-anchoring
  - couplet: sidecar + Monitor-based wakeups
- None of these has much traction except Plannotator and Crit. Those two focus on plans and diffs rather than prose co-authoring, which leaves room for a well-specified, spec-driven sidecar format (open-doc's "v1 spec + JSON Schema") as a differentiator.
- Blocking "wait for human" primitives have become a common pattern: Roughdraft `open --json`, md-redline `mdr_wait`/`mdr_ask`, Pena `feedback wait`, couplet `watch` + Monitor, Crit `/crit`.

### Gaps
- I found no documentation of re-anchoring strategy for md-redline, Crit, Plannotator, Roughdraft (CriticMarkup is inline, so no re-anchoring is needed unless the agent strips it), Proof SDK or MarkDocs.
- Roughdraft's license is not detected by GitHub and is not stated in the README excerpt reviewed.
- I could not verify GitHub stats for MarkDocs, OpenMarkdown or OpenKnowledge.
- The npm download counts for Roughdraft and md-redline were not checked.

## 2. Are there MCP servers for live document editors (Google Docs, Word, Tiptap/ProseMirror, Obsidian, etc.) that support comments/suggestions rather than overwrite?

### Takeaway
Yes, for Google Docs and Word. Several 2026 MCP servers expose native comments and suggestion/tracked-change modes, helped by Google opening comments and suggestions in the Docs API in late Sept/Oct 2026. For Tiptap/ProseMirror there is no official MCP server. Tiptap ships its own AI Toolkit with tracked agent edits instead, and editor-native MCP comes from apps like Prose, MarkDocs and couplet.

### Cited Findings

**Google Docs**
- **iamacarpet/google-docs-mcp.** A Node server, 1 star, MIT, created 2026-10-03 — [GitHub](https://github.com/iamacarpet/google-docs-mcp)
  - It creates native comments anchored to text, can replace a comment's anchored text with suggested wording (resolving the thread), and lists pending suggestions — [GitHub](https://github.com/iamacarpet/google-docs-mcp)
  - It supports `writeMode: "SUGGEST"`, which is the default for revisions — [GitHub](https://github.com/iamacarpet/google-docs-mcp)
- **mmedum/google-docs-mcp.** A Go server, Apache-2.0, pushed 2026-10-14 — [GitHub](https://github.com/mmedum/google-docs-mcp)
  - It does minimal-diff edits in suggest, direct or comment mode, and reviews suggestions and threads — [GitHub](https://github.com/mmedum/google-docs-mcp)
  - v2.1.0 says comments and suggestions no longer need Developer Preview, and the **default write mode is now suggest** — [release v2.1.0](https://github.com/mmedum/google-docs-mcp/releases/tag/v2.1.0), [PR #82](https://github.com/mmedum/google-docs-mcp/pull/82)
  - A fork exists at JesperGravgaard/google-docs-mcp — [GitHub](https://github.com/JesperGravgaard/google-docs-mcp)
- **taylorwilsdon/google_workspace_mcp.** 3,336 stars, MIT — [GitHub](https://github.com/taylorwilsdon/google_workspace_mcp)
  - PR #1055 adds `suggest_mode` to batch updates. Operations the API refuses in suggest mode are rejected client-side — [PR #1055](https://github.com/taylorwilsdon/google_workspace_mcp/pull/1055)
- **Google Docs API.** Release notes reportedly say that on 2026-09-30 the API made it possible to programmatically read, create and manage comments and suggestions (`commentsViewMode` in `documents.get`, creating and replying to threads). An Oct 1, 2026 note says Google's Docs MCP server supports comments in Developer Preview — [Google Docs API release notes](https://developers.google.com/workspace/docs/release-notes)
  - Caveat: the search summary flagged inconsistent date metadata on that page, so the exact timing is unverified.

**Word / .docx**
- **SecurityRonin/docx-mcp.** 63 stars, MIT, Python — [GitHub](https://github.com/SecurityRonin/docx-mcp)
  - It edits OOXML with tracked insertions and deletions, paragraph-anchored comments, threaded replies and footnotes — [GitHub](https://github.com/SecurityRonin/docx-mcp), [glama](https://glama.ai/mcp/servers/SecurityRonin/docx-mcp)
- **UseJunior/safe-docx.** 46 stars, Apache-2.0, TypeScript — [GitHub](https://github.com/UseJunior/safe-docx)
  - It edits at the run level to preserve formatting, generates a tracked-changes redline by comparing DOCX files, and manages comment threads and footnotes — [mintlify docs](https://www.mintlify.com/UseJunior/safe-docx)
- **juanocampo400/word-mcp.** Built specifically for tracked changes with author and date metadata; 45 tools. It notes that python-docx-based servers lack tracked changes — [README](https://cdn.jsdelivr.net/gh/juanocampo400/word-mcp@master/README.md)
- **Adeu.** A contract-redlining MCP covering Track Changes, comments and accept/reject through a "Markdown proxy". On Windows it can drive a running Word instance live — [lawve.ai](https://lawve.ai/en/mcp-servers/adeu)

**Tiptap / ProseMirror**
- Tiptap markets AI agents that edit documents "with real-time streaming, track-changes review". Its AI Toolkit exposes read and write operations as tools for LangChain, the Vercel AI SDK, OpenAI and Anthropic SDKs, but it is a commercial/Pro feature rather than an MCP server — [Tiptap](https://tiptap.dev/), [Product Hunt](https://www.producthunt.com/products/tiptap-ai-agent)
- The pricing claims conflict: one review says collaboration requires a $149/mo Pro plan, while another says cloud plans with AI-agent editing start at $59/mo — [MakerStack](https://makerstack.co/reviews/tiptap-review/); contradicted by [hokai.io](https://hokai.io/hub/tools/tiptap)
- The open-source collaboration path is Yjs via Hocuspocus or y-prosemirror — [Yjs docs](https://github.com/yjs/docs/blob/main/ecosystem/editor-bindings/prosemirror.md)
- Editor-native MCP examples built on ProseMirror/TipTap: Prose PR #854 (see Q1) — [PR](https://github.com/solo-ist/prose/pull/854)
- One project issue sketches an agent as a "headless agent peer" writing attributed CRDT suggestions into a live Yjs/Tiptap draft via a worker or MCP. It is a plan only — [issue](https://github.com/hrustalq/knowledge/issues/80)

### Inferences
- Google Docs and Word now have reasonably capable "suggest, don't overwrite" MCP servers, but nearly all are under two months old with very few stars. taylorwilsdon's is the exception, and its suggest-mode support is still a PR.
- A common default is emerging: suggest mode as the default write mode.
- Tiptap/ProseMirror has no off-the-shelf MCP server. Building one means wrapping a headless editor or a Yjs peer.

### Gaps
- Obsidian MCP servers with comment or suggestion support: not researched in depth within the tool budget, and I found no evidence of one.
- Typora-like apps: no MCP with comments found.
- Notion and Confluence MCP comment support: not investigated.
- I could not confirm the exact Google Docs API release dates.

## 3. Tools similar to open-doc's design (local editor server + browser editor + sidecar annotation store + CLI with inbox/wait)

### Takeaway
No single project matches all four elements with a formal spec. The nearest are:
- **Roughdraft**: local server + browser GUI + CLI blocking wait + MCP, but comments live inline as CriticMarkup rather than in a sidecar.
- **markdown-claude-review**: sidecar `.review.json` + W3C text-quote anchors + MCP, but VS Code instead of a browser and no CLI wait.
- **couplet**: sidecar + CLI + `watch`, but a native macOS app.
- **Pena**: browser + CLI `feedback wait`, but a SQLite store rather than a sidecar.
- **md-redline**: browser + MCP `wait`, but inline HTML-comment markers.

### Cited Findings

| Project | GUI | Comment store | Anchoring | Agent mechanism | Wait/inbox | License / stars / last push |
|---|---|---|---|---|---|---|
| Roughdraft | Local browser (localhost:7373) | Inline CriticMarkup + YAML endmatter in .md | Inline markup | CLI + experimental stdio MCP | `roughdraft open --json` blocks for `review.completed` | none detected / 454 / 2026-06-19 — [GitHub](https://github.com/Lex-Inc/roughdraft) |
| md-redline | Local browser | Inline hidden HTML-comment JSON markers in .md | Marker before anchored text | stdio MCP + CLI `mdr` | `mdr_request_review`, `mdr_wait`, `mdr_ask` | MIT / 42 / 2026-09-26 — [GitHub](https://github.com/dejuknow/md-redline) |
| markdown-claude-review | VS Code | Sidecar `.review/<path>.review.json` | W3C text-quote + 48-char context + heading trail, fuzzy cascade | MCP + slash command | Thread states (open/answered); no blocking wait documented | MIT / 0 / 2026-10-07 — [GitHub](https://github.com/MagicMicky/markdown-claude-review) |
| couplet | Native macOS | Sidecar `.mdmini_comments_<file>.md` | Not documented | stdio MCP (`show/edit/ask`) + Unix socket + shell verbs | `couplet watch` as Claude Code Monitor | GPL-3.0 / 22 / 2026-10-06 — [GitHub](https://github.com/malinborn/couplet) |
| Pena | Local browser | SQLite DB | Text selection (details not documented) | CLI (`pena`) + Claude skill | `pena feedback wait/watch`, ETag preconditions | MIT / 0 / 2026-10-09 — [GitHub](https://github.com/mshddev/pena) |
| Crit | Local browser | `~/.crit/reviews/` or `.crit` in repo | Line numbers/ranges + quoted text | CLI + agent plugins | `/crit` waits for review | MIT / 1,211 / 2026-10-12 — [GitHub](https://github.com/tomasz-tomczyk/crit) |
| Plannotator | Local browser | `~/.plannotator` | Not documented | Hooks (ExitPlanMode), slash commands, CLI | Hook blocks until approve/deny | Apache-2.0 / 9,421 / 2026-10-14 — [GitHub](https://github.com/backnotprop/plannotator) |
| claude-review (Ch00k) | Local browser | Not documented | "Anchored to specific sections" | Slash commands `/cr-review`, `/cr-address` | Manual (user runs `/cr-address`) | Unlicense / 32 / 2025-11-20 — [GitHub](https://github.com/Ch00k/claude-review) |
| mcp-criticmarkup | None (use Monoleaf) | Inline CriticMarkup + `<!--c:id s/e-->` + thread payload at EOF | Paired inline markers | stdio MCP (Python) | None | MIT / 0 / 2026-10-05 — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup) |
| Proof SDK | Browser editor + collab server | Server-side (marks/provenance) | Editor marks | HTTP "agent bridge" | Events endpoint | MIT / 1,120 / 2026-08-27 — [GitHub](https://github.com/EveryInc/proof-sdk) |
| MarkDocs | Browser, self-hosted | PostgreSQL + Yjs | CRDT | stdio MCP (23 tools) + CLI | Not documented | MIT / n/a — [site](https://www.markdocs.sh/) |
| Prose (PR #854) | Electron desktop | IndexedDB event log | Editor marks with IDs | MCP (9 review tools) | Waits for saves with doc-ID checks | MIT / 6 / 2026-10-13 — [PR](https://github.com/solo-ist/prose/pull/854) |

### Inferences
- Design features that open-doc could borrow or differentiate on:
  - From markdown-claude-review: a fuzzy re-anchor cascade with **exact/drifted** status, and merge-before-write for a sidecar with two writers.
  - From Pena: ETag/`--feedback-match` optimistic concurrency and distinct exit codes for timeout and precondition failures.
  - From Roughdraft: a fallback copy-paste prompt when no watcher is active.
  - From couplet: a debounce (20 s quiet) before waking the agent.
  - From Prose: document-identity checks and keeping accept/reject with the human.
- Sidecar vs inline is the main philosophical split. Inline (CriticMarkup or HTML comments) keeps a single file and works in other editors, but risks agents mangling the markup. A sidecar keeps the prose clean but needs re-anchoring.

### Gaps
- I did not inspect source code to confirm internal anchoring for md-redline, Pena or couplet.
- I found no published formal schema for any of these sidecar or marker formats (other than README descriptions).

## 4. Prior art for markdown comment/annotation formats

### Takeaway
The main prior art is:
- **CriticMarkup** (2013): inline `{++ ++}`, `{-- --}`, `{~~ ~> ~~}`, `{== ==}{>> <<}`. It is now reused by Roughdraft, mcp-criticmarkup and Monoleaf.
- The **W3C Web Annotation Data Model**: TextQuoteSelector with exact/prefix/suffix, and TextPositionSelector.
- **Hypothesis's** fuzzy anchoring: quote + position hint + diff-match-patch/Bitap.
- **Pandoc's** track-changes span representation.

Newer tools mostly reuse CriticMarkup inline or a W3C-style quote selector in a sidecar.

### Cited Findings
- **CriticMarkup-toolkit**: 850 stars, no license detected, last push 2021-03-04, so the original toolkit is dormant while the syntax lives on in new tools — [GitHub](https://github.com/CriticMarkup/CriticMarkup-toolkit); syntax site [criticmarkup.com](https://criticmarkup.com/) (referenced by [mcp-criticmarkup](https://github.com/Martennnnn/mcp-criticmarkup))
- **Roughdraft extends CriticMarkup** with attribute blocks (`{id="c3" by="user" at="..." re="c3"}`) for IDs, authorship, timestamps and reply threading — [README](https://github.com/Lex-Inc/roughdraft)
- **mcp-criticmarkup** pairs CriticMarkup edits with a Monoleaf-compatible comment-anchor syntax `<!--c:{id}s-->…<!--c:{id}e-->` and a thread payload at the bottom of the file. It says CriticMarkup extensions for VS Code, Positron and Obsidian "may work" — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup)
- **W3C Web Annotation TextQuoteSelector**: exact text plus prefix and suffix. Hypothesis builds it from the user's selection, and "you'll find something like TextQuoteSelector in any annotation system" — [Jon Udell, notes for an annotation SDK](https://blog.jonudell.net/2021/09/03/notes-for-an-annotation-sdk/); formal definition referenced by [markdown-claude-review](https://github.com/MagicMicky/markdown-claude-review) as [w3.org/TR/annotation-model](https://www.w3.org/TR/annotation-model/#text-quote-selector)
- **Hypothesis fuzzy anchoring**:
  - It moved away from exact prefix/suffix matching to fuzzy matching to reduce brittleness — [Hypothesis blog: Fuzzy Anchoring](https://web.hypothes.is/blog/fuzzy-anchoring/)
  - Stored character offsets serve as a starting hint for the search — [W3C public-openannotation list, 2013](https://lists.w3.org/Archives/Public/public-openannotation/2013Feb/0163.html)
  - It uses a modified google-diff-match-patch (Bitap matching, Myers diff) — [Hypothesis blog](https://web.hypothes.is/blog/fuzzy-anchoring/)
  - The anchoring code was split into standalone text-quote and text-position anchor npm modules, intended to feed Apache Annotator — [annotator-dev list, 2015](https://lists-archive.okfn.org/pipermail/annotator-dev/2015-July/004849.html)
  - Caveat: these sources date from 2013–2017; the current Hypothesis client may differ — [Jon Udell](https://blog.jonudell.net/2021/09/03/notes-for-an-annotation-sdk/)
- **Hypothesis server (hypothesis/h)**: BSD-2-Clause, 3,189 stars, still active (pushed 2026-10-14) — [GitHub](https://github.com/hypothesis/h)
- **Sidecar formats in 2026 tools**:
  - `.review/<path>.review.json` — [markdown-claude-review](https://github.com/MagicMicky/markdown-claude-review)
  - `.mdmini_comments_<file>.md`, a markdown sidecar — [couplet](https://github.com/malinborn/couplet)
  - Crit review files in `~/.crit/reviews/` or `.crit` — [Crit](https://github.com/tomasz-tomczyk/crit)
  - a JSON sidecar for replies to native Office comments — [markdown-review](https://github.com/jinqishen0725/markdown-review)
  - "Sidemark export" — [md-tui PR #238](https://github.com/henriklovhaug/md-tui/pull/238)
- **Inline hidden-marker formats**:
  - md-redline: an HTML comment holding JSON (`id, anchor, text, author, timestamp, replies`) — [GitHub](https://github.com/dejuknow/md-redline)
  - markdown-review: `<!--@c...-->` — [GitHub](https://github.com/jinqishen0725/markdown-review)

### Inferences
- open-doc's sidecar + W3C-style selector approach sits in the most principled lineage (W3C/Hypothesis). markdown-claude-review is the closest existing open implementation, but it is tied to VS Code and has no formal schema.
- Publishing a JSON Schema for the sidecar would be distinctive, since no competitor appears to publish one.
- Interop opportunity: import/export to CriticMarkup would connect to Roughdraft, Monoleaf and mcp-criticmarkup users.

### Gaps
- Pandoc comment/track-changes representation: Pandoc's `--track-changes` option for docx emits spans with insertion/deletion/comment classes, but I did not fetch the manual within the tool budget to cite it, so this is unverified here (see pandoc.org/MANUAL.html).
- I could not verify the current state of Apache Annotator (incubation status) or the current Hypothesis client's anchoring code.
- No "mdreview"-named open-source CLI was found beyond the glama hosted connector and the `mdreview.*` settings prefix in markdown-claude-review.

## 5. License, activity and maturity summary

### Takeaway
Only Plannotator (about 9.4k stars), Crit (about 1.2k), Proof SDK (about 1.1k), Roughdraft (about 450) and google_workspace_mcp (about 3.3k, a general Workspace server) have meaningful adoption. The rest are 0–63-star projects, nearly all created in 2026. Licensing is overwhelmingly MIT/Apache-2.0. The exceptions are couplet (GPL-3.0), md-tui (AGPL-3.0), and Roughdraft and plan-review (shyamalaravind), where no license was detected.

### Cited Findings
GitHub API figures retrieved 2026-10-14 (stars / license / created / last push):
- backnotprop/plannotator: 9,421 / Apache-2.0 (README says Apache-2.0 or MIT) / 2025-12-28 / 2026-10-14 — [GitHub](https://github.com/backnotprop/plannotator)
- taylorwilsdon/google_workspace_mcp: 3,336 / MIT / 2025-04-27 / 2026-10-09 — [GitHub](https://github.com/taylorwilsdon/google_workspace_mcp)
- tomasz-tomczyk/crit: 1,211 / MIT / 2026-02-16 / 2026-10-12 — [GitHub](https://github.com/tomasz-tomczyk/crit)
- EveryInc/proof-sdk: 1,120 / MIT / 2026-03-10 / 2026-08-27 — [GitHub](https://github.com/EveryInc/proof-sdk)
- Lex-Inc/roughdraft: 454 / none detected / 2026-04-22 / 2026-06-19 — [GitHub](https://github.com/Lex-Inc/roughdraft)
- SecurityRonin/docx-mcp: 63 / MIT / 2026-03-22 / 2026-08-05 — [GitHub](https://github.com/SecurityRonin/docx-mcp)
- UseJunior/safe-docx: 46 / Apache-2.0 / 2026-02-20 / 2026-10-14 — [GitHub](https://github.com/UseJunior/safe-docx)
- dejuknow/md-redline: 42 / MIT / 2026-03-23 / 2026-09-26 — [GitHub](https://github.com/dejuknow/md-redline)
- Ch00k/claude-review: 32 / Unlicense / 2025-10-02 / 2025-11-20 — [GitHub](https://github.com/Ch00k/claude-review)
- malinborn/couplet: 22 / GPL-3.0 / 2026-03-30 / 2026-10-06 — [GitHub](https://github.com/malinborn/couplet)
- solo-ist/prose: 6 / MIT / 2025-12-25 / 2026-10-13 — [GitHub](https://github.com/solo-ist/prose)
- jinqishen0725/markdown-review: 3 / MIT / 2026-03-13 / 2026-08-25 — [GitHub](https://github.com/jinqishen0725/markdown-review)
- comment-hq/comment.io: 2 / MIT / 2026-04-01 / 2026-10-11 — [GitHub](https://github.com/comment-hq/comment.io)
- damiafuentes/claude-code-plan-viewer: 2 / MIT / 2026-04-08 / 2026-04-25 — [GitHub](https://github.com/damiafuentes/cc-plan-viewer)
- iamacarpet/google-docs-mcp: 1 / MIT / 2026-10-03 / 2026-10-05 — [GitHub](https://github.com/iamacarpet/google-docs-mcp)
- MagicMicky/markdown-claude-review: 0 / MIT / 2026-09-03 / 2026-10-07 — [GitHub](https://github.com/MagicMicky/markdown-claude-review)
- mshddev/pena: 0 / MIT / 2026-07-24 / 2026-10-09 — [GitHub](https://github.com/mshddev/pena)
- Martennnnn/mcp-criticmarkup: 0 / MIT / 2026-10-05 / 2026-10-05 — [GitHub](https://github.com/Martennnnn/mcp-criticmarkup)
- mmedum/google-docs-mcp: 0 / Apache-2.0 / 2026-09-02 / 2026-10-14 — [GitHub](https://github.com/mmedum/google-docs-mcp)
- Palarix/claude-review: 0 / MIT / 2026-03-25 / 2026-08-11 — [GitHub](https://github.com/Palarix/claude-review)
- shyamalaravind/plan-review: 0 / none detected / 2026-09-16 / 2026-10-13 — [GitHub](https://github.com/shyamalaravind/plan-review)
- primestack-labs/plan-review: 0 / Apache-2.0 / 2026-10-07 / 2026-10-11 — [GitHub](https://github.com/primestack-labs/plan-review)
- CriticMarkup/CriticMarkup-toolkit: 850 / none detected / 2013-01-10 / 2021-03-04 — [GitHub](https://github.com/CriticMarkup/CriticMarkup-toolkit)
- hypothesis/h: 3,189 / BSD-2-Clause / 2012-04-02 / 2026-10-14 — [GitHub](https://github.com/hypothesis/h)

### Inferences
- The category has exploded in 2026, driven by Claude Code plan/spec workflows. Most entrants are weekend-to-months-old projects with near-zero adoption, so the market is fragmented with no standard format.
- Roughdraft's last push was 2026-06-19 and forks are fixing loop-breaking bugs. This suggests upstream may be slowing, but that is an inference from push dates and fork descriptions only.

### Gaps
- Commit counts, release cadence and issue activity were not checked for most repos (only md-redline's about 743 commits and Crit's about 962 commits were reported in the fetched pages).
- No download or usage metrics were gathered.
- I did not check MCP registries (mcp.so, smithery, the official modelcontextprotocol servers list) systematically. Glama surfaced mcp-criticmarkup, the mdreview connector and docx-mcp.
