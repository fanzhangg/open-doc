# WYSIWYG (Word-like / Typora-style) editors for plain local .md files, and their AI co-authoring features (as of 2026-10-14)

## Which open-source WYSIWYG markdown file editors are actively maintained in 2025–2026? (license, platform, last release, stars/activity)

### Takeaway
The older open-source single-file editors still ship releases, but none of them has added AI. MarkText was revived in 2026 and released v0.21.x in October 2026; Zettlr reached 4.x; ghostwriter ships with KDE Gear. Separately, a new group of open-source, AI-native WYSIWYG editors appeared in 2025–2026: Markra (AGPL), VMark (ISC), Nimbalyst (MIT) and DOMD (MIT/GPL). All are built on Tauri or Electron with React, and all work on plain .md files on disk.

### Cited Findings
**Established open-source editors (no AI)**
- **MarkText** (MIT, Electron, Typora-like inline WYSIWYG). It has 62.6k stars, 4.6k forks, 2,335 commits, 292 open issues, and no AI features in the README. — [GitHub marktext/marktext](https://github.com/marktext/marktext)
  - Latest releases are v0.21.2 (11 Oct; asset timestamps say 2026-10-11), v0.21.1 (08 Oct) and v0.21.0 (08 Oct). The v0.21.0 macOS arm64 build crashes on launch. — [MarkText releases](https://github.com/marktext/marktext/releases)
  - History: the community fork jacobwhall/marktext was archived on Aug 11, 2025, and pointed users to Tkaixiang's fork. Tkaixiang's notice says that on 13/5/2026 the original developer returned to maintaining the upstream repo, and the fork's code was merged back into it. — [jacobwhall/marktext](https://github.com/jacobwhall/marktext); [Tkaixiang/marktext](https://github.com/Tkaixiang/marktext)
  - A Floatboat article dated Sept 2026 still describes MarkText as having a "slower maintenance cadence as of 2026" with no AI. It may predate the October releases. — [Floatboat](https://floatboat.ai/blog/best-markdown-editors)
- **Zettlr** (open source, academic Markdown editor, citations/Pandoc). Zettlr 4.0 shipped in late Dec 2025 with a rewritten table editor (CodeMirror-based), an in-app PDF/image viewer, an improved citation parser and pandoc-crossref support. — [Zettlr 4.0 Released](https://zettlr.com/post/zettlr-400-released); [AlternativeTo news](https://alternativeto.net/news/2025/12/zettlr-4-0-launches-with-new-table-editor-in-app-pdf-image-viewer-and-big-workflow-upgrades)
  - Later 4.x releases exist (4.3.1, 4.4.0, 4.6.0 are referenced). — [warp2search 4.4.0](https://www.warp2search.net/story/zettlr-440-released/); [Adaptiva patch 4.3.1](https://adaptiva.com/patch-library/1000002816_patch_for_zettlr)
  - Floatboat says Zettlr "deliberately kept AI out" and is donation-funded. — [Floatboat](https://floatboat.ai/blog/best-markdown-editors)
  - Note: Zettlr is a source editor with inline rendering (CodeMirror), not true WYSIWYG.
- **ghostwriter** (KDE Gear, distraction-free Markdown with live HTML preview, so source plus preview rather than WYSIWYG). It had releases in 2025: 24.12.3 (2025-03-06), 25.04.0 (2025-04-17) and 25.04.1 (2025-05-08). — [apps.kde.org/ghostwriter](https://apps.kde.org/ghostwriter)
  - Arch packages 25.08.2 (built 2025-10-08). — [Arch package](https://archlinux.org/packages/kde-unstable/x86_64/ghostwriter)
  - FreeBSD tracks 25.12.3 (port updated March 2026). — [FreshPorts](https://www.freshports.org/editors/ghostwriter/)
  - No AI features found.

**New AI-native open-source WYSIWYG editors (2025–2026)**
- **Markra** (AGPL-3.0, Tauri + React + TypeScript). It runs on macOS, Windows and Linux, with a web editor at editor.markra.app. Files are plain `.md` on disk, opened singly or as a folder workspace, with optional WebDAV sync. It has 917 stars, 54 forks, 941 commits on the v2 branch, 33 open issues, and no release date visible. — [GitHub markrahq/markra](https://github.com/markrahq/markra) (also listed under [murongg/markra](https://github.com/murongg/markra))
- **VMark** ("An AI friendly markdown editor", ISC license). It uses Tauri v2, React 19, Tiptap/ProseMirror for WYSIWYG, and CodeMirror 6 for source mode. It has three modes: WYSIWYG, Source Peek (F5) and Source Mode (F6). macOS is the primary platform; Windows and Linux are "best-effort". It has 841 stars and 5,969 commits. It is self-described as "vibe-coded" and does not accept external PRs. — [GitHub xiaolai/vmark](https://github.com/xiaolai/vmark)
  - It was in beta at v0.9.26 per a directory listing. — [everydev.ai](https://www.everydev.ai/tools/vmark/llms.txt)
- **Nimbalyst** (MIT, Electron, Lexical WYSIWYG editor, Monaco for code). It runs on macOS 12+, Windows 10+ and Linux, with an iOS companion. Content is plain files in your git repo, with "no proprietary store". It has about 1.9k stars and 301 forks. Copyright is held by Nimbalyst Inc. — [GitHub nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst); [winstall](https://winstall.app/apps/Nimbalyst.Nimbalyst)
  - It is more of an "agent workspace" (Files / Agent / Tasks modes, kanban of sessions, worktrees, terminal) than a pure single-file editor. — [SitePoint](https://www.sitepoint.com/nimbalyst-the-visual-workspace-for-building-with-claude-code-and-codex/)
- **DOMD**. It has an app layer (macOS app, web app; MIT) and an editor kernel `@do-md/core-react` (GPL-3.0 from v0.11.0 with small-entity/FOSS exceptions; earlier versions were PolyForm Noncommercial; a commercial license is available). It is described as "30KB Markdown-native WYSIWYG editor for React, built for AI streaming". There is a native macOS app and a local-first web editor, but no Windows. It has 587 stars and 188 commits. — [GitHub do-md/domd](https://github.com/do-md/domd)

### Inferences
- The incumbent OSS WYSIWYG editors (MarkText, Zettlr, ghostwriter) have not added AI. Zettlr appears to have chosen this explicitly. The AI-native space is filled by new, small projects (roughly 0.6k–2k stars) built in 2025–2026.
- The common stack for new entrants is Tauri or Electron, React, and a ProseMirror-family editor (Tiptap, Lexical) or a custom kernel.
- MarkText's 2026 revival makes it the most popular (62k-star) OSS Typora-alike again. It is the obvious candidate for someone to add AI through a fork or plugin, but nothing indicates such plans.

### Gaps
- Apostrophe (GNOME) 2025–2026 release status was not found in search results.
- No release dates were visible for Markra, Nimbalyst or VMark (empty Releases sections in the scraped pages), and the VMark beta version number comes from a third-party directory.
- Milkdown-based end-user apps were not specifically identified. Milkdown is a framework; I found no prominent standalone Milkdown desktop app with AI in this pass.
- Star counts are snapshots from the scrape date and were not cross-checked.

## Which have built-in or plugin AI features, and what is the collaboration model?

### Takeaway
Among the new AI-native editors, the dominant pattern is AI edits proposed as an inline diff with accept/reject, plus an agent or chat side panel. Some also expose the editor to external coding agents: MCP in VMark, ACP in Markra, the Claude Code/Codex SDKs in Nimbalyst, and a CLI in DOMD. Tab-autocomplete is rarer: it appears in MDX's "Ghost-writer". None of the established editors has built-in AI.

### Cited Findings
- **Markra** offers several AI modes:
  - Selection actions: polish, rewrite, continue, summarize, translate.
  - A side-panel agent for document-wide tasks.
  - Every AI edit is previewed, and you can accept, reject or copy it before it is applied.
  - Providers: cloud, local, or any OpenAI-compatible endpoint.
  - It supports the Agent Client Protocol (ACP) for local agents and reads `AGENTS.md` and repo-scoped Agent Skills. MCP is not mentioned.
  - Autocomplete is not mentioned.
  - The web version uses the browser file picker and handles, and AI is not core there.
  - Sources: [GitHub markrahq/markra](https://github.com/markrahq/markra); [search summary of murongg/markra](https://github.com/murongg/markra)
- **VMark** has native MCP support. Listed clients are Claude Desktop, Claude Code, Codex CLI, Antigravity CLI, Grok CLI and opencode, each installed from Settings → Integrations. It also has "AI Genies for inline writing assistance". Whether suggestions use accept/reject is not stated. — [GitHub xiaolai/vmark](https://github.com/xiaolai/vmark)
- **Nimbalyst** has these AI features:
  - Agent edits show as red/green diffs that you accept or reject one at a time.
  - Supported agents: Claude Code and Codex, plus OpenCode and GitHub Copilot (both alpha) and a Gemini provider.
  - Parallel agent sessions run in git worktrees.
  - It includes an MCP client and servers.
  - Sources: [GitHub nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst); [Nimbalyst blog (vendor), Dec 2025 / updated May 2026](https://nimbalyst.com/blog/the-complete-guide-to-markdown-editors/)
- **DOMD** streams AI Markdown chunk by chunk, rendering partial syntax such as open fences and half-built tables. `domd-cli` can open windows, stream content into a document and rewrite selections, so agents can use DOMD as a rendering surface. It also has real-time multi-editor sync with remote cursor presence. — [GitHub do-md/domd](https://github.com/do-md/domd)
- **MDX** (hellomdx.com, closed/indie, $15 one-time; macOS, Windows, Linux) is an editor for people who don't want to write Markdown syntax: a toolbar, a doc-style view, and "the file on disk is still plain markdown". Its AI is a "Ghost-writer" with Tab-to-accept inline suggestions, using your own key (OpenAI, Anthropic, Google, xAI, or a local model). No chat, track changes or comments are mentioned. — [hellomdx.com](https://hellomdx.com/)
- **Octarine** is a light (<30MB) WYSIWYG editor with local plain-markdown storage and optional multi-provider AI. **ScribeDog** is privacy-focused, with local AI through Ollama, Jan.ai or LM Studio. — [search summary citing markdownforai.org / markdownconverters lists](https://markdownforai.org/tools/markdown-editors/) (third-party roundup, not verified against primary sources)
- **Plugin-level AI**:
  - Typora has no built-in AI, but third parties offer a GitHub Copilot plugin (via Copilot.vim) and a Pieces "AI memory" add-on. — [GitHub topic typora-extension](https://fr.github.com/topics/typora-extension); [Pieces](https://pieces.app/ai-memory/typora)
- **Read-only, agent-companion viewers** (not WYSIWYG editors, but relevant): mdserve and mdlive are live-reload markdown preview servers distributed as Claude Code plugins. mdlive also allows editing files in the browser. — [mdlive docs.rs](https://docs.rs/crate/mdlive/2.2.1); [mdserve plugin](https://claudepluginhub.com/plugins/jfernandez-mdserve)

### Inferences
- The collaboration models fall into four types:
  - (a) Selection rewrite with a diff preview: Markra, VMark "Genies".
  - (b) Ghost-text autocomplete: MDX.
  - (c) Agent side panel with inline red/green diffs: Nimbalyst, Markra.
  - (d) The editor as a surface that an external agent drives through MCP, ACP or a CLI: VMark, Markra, DOMD.
- Agent-to-editor integration is converging on MCP (VMark, Nimbalyst) and ACP (Markra). No common standard has appeared for how an external agent's edits are presented as reviewable suggestions inside a WYSIWYG view.

### Gaps
- I could not verify Octarine's and ScribeDog's AI details or their licenses from primary sources.
- I found no evidence that any of these editors persists AI suggestions or comments into the .md file for later review. Their diffs appear to be in-session UI state, though this is not confirmed for each.
- "ColaMD", cited by one search summary as a live-reload editor for files edited by Claude Code/Codex/Cursor, could not be found in a direct search. Treat it as unverified.

## Do any support comments or track-changes / suggestion mode on markdown (e.g., CriticMarkup)?

### Takeaway
Persistent comments and suggestions inside .md files exist almost entirely through CriticMarkup tooling. The standalone tools are Marked 2, MultiMarkdown Composer, pymdownx.critic and the new RoughDraft CLI reviewer. The rest are Obsidian plugins, some of them aimed at AI agents. None of the WYSIWYG AI editors above was found to read or write CriticMarkup. iA Writer's Authorship is a different approach: it attributes provenance in an end-of-file annotation block rather than recording suggestions.

### Cited Findings
- **RoughDraft** is an open-source (MIT, TypeScript Node CLI), local-first Markdown reviewer "built for the era of coding agents". You open any `.md`, leave comments, suggest edits via CriticMarkup, and feed the review back to the agent that wrote the draft. It does not support collaboration. — [notes.dsebastien.net RoughDraft](https://notes.dsebastien.net/30+Areas/33+Permanent+notes/33.02+Content/RoughDraft)
- **Marked 2** (macOS previewer) supports CriticMarkup with three tabs: the markup, the original, and the edited version. — [Marked 2 help](https://cdn2.marked2app.com/help/CriticMarkup.html)
- **MultiMarkdown Composer** and Python-Markdown's `pymdownx.critic` (as used by MkDocs Material) also support CriticMarkup. — [search summary; mkdocs-material formatting docs](https://git.struchkov.dev/OpenSourceArk/mkdocs-material/raw/commit/6248412844383e3e4ed538eb86c7a38c0501ead6/docs/reference/formatting.md)
- **Obsidian plugins**:
  - **Track Changes** (MIT) shows each CriticMarkup mark as a card in a side panel, and accepting or rejecting writes back into the markdown. Its bundled AI reviewer prompt tells the AI to find issues but not write prose. — [Obsidian community: Track Changes](https://community.obsidian.md/plugins/track-changes)
  - **Agent Comments** builds on Track Changes and adds background agent replies. — [GitHub andrewroxby/agent-comments](https://github.com/andrewroxby/agent-comments)
  - **Inkling Markup** has a Suggesting mode, where edits become suggestion ranges, and a Commenting mode. — [Obsidian community: Inkling Markup](https://community.obsidian.md/plugins/inkling-markup)
  - **Review & Critic** offers a Track Changes mode. — [Obsidian community: Review Critic](https://community.obsidian.md/plugins/review-critic)
- A Mac Power Users forum thread asks whether a Markdown editor with change tracking exists, which shows this is a recognized gap. — [MPU forum](https://talk.macpowerusers.com/t/does-a-markdown-editor-with-change-tracking-exist/28703)
- **iA Writer Authorship / Markdown Annotations**:
  - Authorship is stored as a separate block at the end of the file, not inline. Editing outside iA Writer can misplace annotations, and the app warns you when it detects this.
  - "Paste Edits From" diffs pasted text and attributes the changes to a chosen author.
  - The format is published on GitHub as "Markdown Annotations" for others to adopt.
  - Sources: [iA Writer 7](https://ia.net/topics/ia-writer-7); [iA Authorship support](https://ia.net/writer/support/editor/authorship)
  - Author metadata is stripped on export to Markdown, HTML, PDF and Word, but is shared when the file itself is shared. — [iA Authorship support](https://ia.net/writer/support/editor/authorship) (via search summary)

### Inferences
- There is a clear gap: no WYSIWYG, Typora-style desktop editor was found that renders CriticMarkup suggestions and comments as Word-like tracked changes and lets an AI agent add them. The existing CriticMarkup tooling is source-mode (Obsidian plugins), a previewer (Marked 2) or a CLI (RoughDraft).
- There are two competing in-file conventions for "who wrote what or what changed": CriticMarkup (inline `{++ ++}`, `{-- --}`, `{>> <<}` marks) and iA's Markdown Annotations (an end-of-file range block).

### Gaps
- I did not verify whether Zettlr, MarkText, VMark, Markra or Nimbalyst render CriticMarkup. No source mentioned it.
- RoughDraft's GitHub repo, star count and release date were not retrieved. The description comes from a third-party notes page.

## Notable closed-source references (Typora, iA Writer, Ulysses, Bear, etc.) — what AI features do they have?

### Takeaway
The leading closed WYSIWYG and markdown writing apps have taken a light-touch approach to AI:
- Typora has none built in.
- iA Writer focuses on provenance (Authorship) rather than generation.
- Ulysses relies on Apple's system AI: Writing Tools since 2024, and Siri AI in its macOS/iOS 27 update.
- Bear opened up to external agents through a CLI, a Claude Connector and an MCP server in 2.8 (April 2026) instead of adding in-app AI.

### Cited Findings
- **Typora** (closed, $14.99–$15 one-time, inline WYSIWYG, no plugin system) has no built-in AI.
  - The 1.13 line (Mar/Apr 2026) added MathJax 4, Mermaid 11.12 and an "Open in Typora" VS Code extension. — [AlternativeTo Typora news](https://alternativeto.net/software/typora/news); [rywalker.com Typora research](https://rywalker.com/research/typora)
  - An unofficial article reports v1.14.6 (around Aug 2026) adding an editor toolbar and file-tree navigation, with no AI. This is unverified. — [titikey](https://www.titikey.com/zh-TW/article/tk6qc3-51o3x)
  - The no-built-in-AI finding is corroborated. — [Floatboat](https://floatboat.ai/blog/best-markdown-editors); [Nimbalyst blog](https://nimbalyst.com/blog/the-complete-guide-to-markdown-editors/)
- **iA Writer** (closed; $49.99 Mac/iOS, $29.99 Windows per Floatboat):
  - iA Writer 7 (announced Nov 30, 2023) introduced Authorship. Pasted AI text is marked and shown faded or with a gradient. The app auto-detects ChatGPT and LM Studio conversations, has a "Paste Edits From" option and a Reference category, and stores data in the open Markdown Annotations format. — [iA Writer 7](https://ia.net/topics/ia-writer-7); [iA: see what AI wrote](https://ia.net/topics/see-what-ai-wrote)
  - Authorship came to Windows in the iA Writer 2.1 beta. — [Thurrott](https://www.thurrott.com/windows/windows-11/334306/ia-writer-for-windows-is-getting-authorship-capabilities)
  - There is no generative AI in the app. A "Quiet Mode" handoff passes text to any chatbot for copy-and-compare. — [Floatboat](https://floatboat.ai/blog/best-markdown-editors)
- **Ulysses** (closed, subscription, proprietary library plus external folders):
  - v36 (2024) added Apple Intelligence Writing Tools (proofread, rewrite, summarize). — [TidBITS Ulysses 36](https://tidbits.com/watchlist/ulysses-36/)
  - The macOS 27 / iOS 27 update (2026) added Siri AI with onscreen awareness and a toolbar button for writing, rewriting and proofreading. It is not available in the EU. — [9to5Mac](https://9to5mac.com/?p=1069852); [Mac4Ever](https://www.mac4ever.com/divers/198062-ios-27-et-macos-27-ulysses-integre-siri-ai-pour-ecrire-et-retravailler-vos-textes)
- **Bear** (closed notes app, proprietary database, markdown-ish):
  - 2025 releases (2.4 in May, callouts, math, Web Clipper 2.0) had no AI. — [Bear blog updates](https://blog.bear.app/category/updates)
  - Bear 2.8 (April 2026) added BearCLI, a Claude Connector and an MCP server so external AI can read and edit notes. — [rywalker.com Bear research](https://rywalker.com/research/bear-app) (third-party; not confirmed against Bear's own changelog in this pass)
- **MDX** (hellomdx.com, closed, $15): Word-like WYSIWYG on plain .md with BYOK Tab-autocomplete "Ghost-writer". See above. — [hellomdx.com](https://hellomdx.com/)

### Inferences
- The closed incumbents differ in approach. iA Writer has invested in provenance and authorship as its AI story. Bear has moved toward making the app agent-accessible through MCP and CLI. Ulysses relies on OS-level AI. None offers an in-app agent that edits with tracked suggestions.
- Bear 2.8's MCP and Claude Connector is the clearest example of a closed writing app choosing "be a tool for external agents" over "embed an AI".

### Gaps
- I did not verify Bear 2.8's details on Bear's official blog.
- Typora's official changelog was not fetched, so the 1.14.x claims are unverified.
- Ulysses 9to5Mac article publication date was not visible.

## Any NEW 2025–2026 products marketed as "AI-native markdown editor" or "Cursor for writing" that work on local .md files?

### Takeaway
Yes. Several new products have appeared:
- Markra ("WYSIWYG Markdown editor with native AI", AGPL)
- VMark ("AI friendly markdown editor", MCP-native, ISC)
- Nimbalyst (MIT "visual workspace for Claude Code/Codex" with a WYSIWYG markdown editor and inline diffs)
- DOMD (WYSIWYG kernel and app for AI streaming and agent workflows)
- MDX ($15 closed, "WYSIWYG Markdown editor for the AI era")

"Cursor for writing" mostly appears as extensions to Cursor itself (e.g., Buckram Studio), not as standalone apps.

### Cited Findings
- **Markra**: "A WYSIWYG Markdown editor with native AI. Fully open source. Free to use. Your data stays local." — [GitHub markrahq/markra](https://github.com/markrahq/markra)
- **VMark**: "An AI friendly markdown editor". It is MCP-native for Claude Desktop, Claude Code, Codex CLI and others. — [GitHub xiaolai/vmark](https://github.com/xiaolai/vmark)
- **Nimbalyst**: an open-source visual workspace for Claude Code, where markdown, mockups, diagrams, CSV and Excalidraw files are edited with an agent side panel and red/green diff review. — [SitePoint](https://www.sitepoint.com/nimbalyst-the-visual-workspace-for-building-with-claude-code-and-codex/); [GitHub](https://github.com/nimbalyst/nimbalyst)
  - Reviewers flag it as a young project that requires separately configured agents. — [AI IDE List](https://aiidelist.com/ide/nimbalyst)
- **DOMD**: "30KB Markdown-native WYSIWYG editor for React, built for AI streaming, human editing, huge files, macOS, Web, and agent workflows." — [GitHub do-md/domd](https://github.com/do-md/domd)
- **MDX**: "A WYSIWYG Markdown editor for the AI era", positioned for the .md files that chatbots generate. It exports to DOCX, PDF and HTML. — [hellomdx.com](https://hellomdx.com/)
- **writ**: a Rust editor with raw text plus live inline rendering that watches files for external edits. Its license was not confirmed. — [docs.rs writ](https://docs.rs/crate/writ/0.14.0)
- **Buckram Studio**: a Cursor extension (on Open-VSX) that turns Cursor into a "local-first, agentic IDE for long-form writing/novels", building a Markdown "Story Bible". — [Cursor forum](https://forum.cursor.com/t/built-for-cursor-turning-cursor-into-a-local-first-agentic-ide-for-long-form-writing-novels-buckram-studio/166057)
- Vendor-written "best markdown editor 2026" roundups (Nimbalyst, Floatboat) are self-interested, and their rankings should be discounted. — [Nimbalyst blog](https://nimbalyst.com/blog/the-complete-guide-to-markdown-editors/); [Floatboat](https://floatboat.ai/blog/best-markdown-editors)

### Inferences
- The 2025–2026 wave of AI-native markdown editors is driven by people working with coding agents (Claude Code, Codex). Their pitch is that agents write .md files, such as plans, specs and docs, and humans need a pleasant WYSIWYG surface to read, edit and review them. Integration happens through MCP or ACP or by embedding the agent SDK.
- The products split into two groups:
  - "Editor with embedded AI": Markra, MDX, Octarine.
  - "Editor as a surface for external agents": VMark, Nimbalyst, DOMD.
- No product combines all three of Word-like WYSIWYG, persistent in-file suggestions or comments (CriticMarkup-style), and an external-agent protocol. That combination appears to be unoccupied.

### Gaps
- Product Hunt and Hacker News launch threads for these products were not reviewed, so traction signals beyond GitHub stars are missing.
- "ColaMD" (mentioned in one AI-generated search summary) could not be verified to exist.
- Mobile and web-only AI markdown editors were not surveyed.
