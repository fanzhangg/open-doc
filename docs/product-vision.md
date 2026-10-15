# Product Vision

AI agents collaborate with you in the same Markdown doc, in real time, like teammates.

## Background and Problem

Document editing is one of the most fundamental and enduring uses of computers. Human collaboration on documents has gone through two stages:

- **Sequential collaboration** (e.g., Word): User A finishes editing a Word doc and emails it to User B, who marks changes with Track Changes and comments, then sends it back to User A for review
- **Real-time co-editing** (e.g., Google Docs): User A and User B edit the same doc at the same time

Writing with AI is now inevitable, yet human–AI collaboration is still stuck in the sequential stage: a person leaves comments in the doc or in a chat box, the AI reads them and revises the doc, then hands it back.

## Our Solution

Our product moves human–AI collaboration into the real-time stage: the AI is no longer a tool in a chat box, but a collaborator in the doc. People and AI work on the same doc at the same time, discussing in comments and each making their own edits, just like two teammates reviewing a proposal together.

## Design Principles

- **Familiar**: The interface uses the familiar "edit + comment" interaction, so there is almost no learning curve. The AI agent reads comments, edits the file directly, and replies through the command line
- **Real-time**: The agent stands by in the background. As soon as you comment, it starts working and replies in the thread. You don't have to stop and wait. you can keep editing other parts of the doc
- **In control**: Comments are anchored to the text you select, and the agent only changes what the comment is about, leaving unrelated sections alone. Every change is explained in the thread and can be undone. You can also ask the agent to only suggest changes and decide yourself whether to accept them. Only you decide when a comment is resolved
- **Open**: An open-source document format and editor, so you never have to worry about being locked into a subscription service.
- **Multi-agent**: Multiple agents can edit and collaborate in the same doc at the same time. Each with its own persona and permission: Grammar police, fact checker, creative writer, ...

## Non-Goals

- **Cloud documents**: Docs live only on your machine; no cloud storage
- **Real-time collaboration between people**: We focus on human–AI collaboration, not real-time collaboration between people
- **Proprietary document formats**: Plain Markdown only
- **Knowledge base**: We focus on a single doc, not note management
- **Chat interface**: All communication happens in comments; no chat window

## Target Users

We start with people who already write docs with AI. They:

- Want working with AI to feel as smooth as working with a human teammate, without copying and pasting between a chat box and a doc
- Mostly write locally and keep docs next to their code (e.g., READMEs and design docs in a GitHub repo)
- Value open standards and software, and don't want to be locked into a subscription service

## Core Use Cases

- **AI writes, human edits**: The AI drafts a design doc; I review it as I read and use comments to ask the AI to fine-tune specific paragraphs
- **Human writes, AI edits**: I've written a 10,000-word novel. I don't want the AI making sweeping changes that mess up the whole thing, only fine-tuning a few paragraphs
- **Alongside chat-based agents**: Hand big changes to a chat agent's CLI or desktop app, and make small changes by commenting directly in the doc. The page also works as a reader

## Competitive Landscape and Differentiation

Existing tools fall into four categories:

| Category | Examples | Strengths | Weaknesses |
| --- | --- | --- | --- |
| **Cloud docs with built-in AI** | Google Docs + Gemini, Notion AI, Word + Copilot | Real-time co-editing between people; agentic edits in the doc | Locked to the vendor's AI; cloud-only, proprietary format |
| **Chat AI canvases** | ChatGPT Canvas, Claude Artifacts | Generate and edit docs in a chat | Chat-centric; not local; no comment threads |
| **AI code editors and CLI agents** | Cursor, VS Code + Copilot, Claude Code | Powerful agents on local files | Built for code, not for discussing prose paragraph by paragraph |
| **Local Markdown editors** | Obsidian, Typora + AI plugins | Local, open format | AI is a plugin; no comments; no external agents |

How we're different:

- **Real-time, not turn-taking**: You keep writing while the AI handles a comment, and it acts on each comment as it arrives instead of waiting for a batch.
- **Comments are the interface**: You comment, the AI edits and replies in the thread, you resolve. No switching to a chat box.
- **Local, plain Markdown**: A regular file in your repo, comments stored alongside it; no subscription lock-in.
- **Any agent, many agents**: Any command-line agent can plug in, and several can work in the same doc at once.

## Success Metrics

- **User in control**: The AI never takes over the doc. Measure edits that go beyond the comment's scope and the share of edits users undo.
- **Less waiting**: Measure time from comment to agent reply, and how long people and agents wait on each other.
- **Multi-agent collaboration**: Measure the share of docs with 2+ agents and the number of edit conflicts.
- **Better writing experience**: Beat an editor + AI plugin on completion time and satisfaction for the same task; track weekly active docs and retention.
- **Open**: Docs open correctly in any Markdown editor; count the third-party agents that connect.

## Roadmap

- Single agent + human collaboration
- Multiple agents + human collaboration

## Risks

- Managing agent permissions
- Whether we can replicate the experience of collaborating with real people
