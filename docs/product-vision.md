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
- **Real-time**: @ an agent in a comment or in the text, and it wakes up right away, reads the doc, and replies in the thread. An agent in auto-commenter mode watches every comment and reply as they change, and without an @ picks up the ones that mention no one and fit its persona. You don't have to stop and wait; you can keep editing other parts of the doc while it works
- **In control**: Comments are anchored to the text you select, and the agent only changes what the comment is about, leaving unrelated sections alone. Every change is explained in the thread and can be undone. You can also ask the agent to only suggest changes and decide yourself whether to accept them. Only you decide when a comment is resolved
- **Open**: An open-source document format and editor, so you never have to worry about being locked into a subscription service.
- **Agents work like people**: An agent is another user in the doc. It sees the same doc and threads you do, does the same things (comment, reply, edit, suggest), and signs everything it does. It can @ you, and in the multi-agent stage other agents too, so agents hand work to each other without you passing messages along. Its persona is plain text that anyone can read and rewrite: grammar police, fact checker, creative writer, ...
- **Nothing remembered in private**: Each run (an @, or a comment picked up in auto-commenter mode) is a fresh agent session that reads the doc and its threads, does its part, and ends. Nothing carries over from one run to the next. Anything worth remembering is written into the doc or a thread, where everyone can see it. So you can always tell why an agent did something, and switch models or restart without losing progress

## Agent Design Philosophy: Props, Not Games

We provide props like dice and playing cards, not games. Dice are generic, combine into games nobody planned, carry no rules of their own, and sit on the table where everyone can see them. The rules come from the players.

Our props are the doc, comments and threads, edits and suggestions, anchors, and @. How people and agents use them (a review checklist, who goes next, when a draft is done) is written in plain language in the doc itself, and can change whenever the people in it want. Before adding a feature, we ask: **is it a die, or an arcade machine with one game built in?** Only generic props go into the product. That rules out:

- **Job titles**: No built-in agent roles, orchestrator agents, or task routing. Agents are reached with @, and who does what emerges from the conversation, the way you @ a colleague known for careful reviews. Auto-commenter mode is a prop too: any agent can switch it on, like a colleague who keeps an eye on the doc and chimes in
- **Built-in workflows**: No official review mode or game mode. Workflows live in the doc's text
- **Hidden powers**: Agents get no back channel, private view, or memory that people can't see

The asymmetries are guardrails, not roles: anyone can speak, but only people resolve a thread, apply a proposal, or undo an agent's edit; when a person and an agent change the same paragraph, the person's text is kept and the agent's becomes a proposal; and for now only a person's message wakes an agent. Agents waking each other comes with the multi-agent stage, together with a guard against loops.

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

- **A shared live doc, not handoffs**: The doc stays open to everyone. You keep writing while an agent handles your comment, and it acts as soon as you @ it (or comment, in auto-commenter mode) instead of waiting for you to hand the doc over.
- **Comments are the interface**: You comment, the AI edits and replies in the thread, you resolve. No switching to a chat box.
- **Local, plain Markdown**: A regular file in your repo, comments stored alongside it; no subscription lock-in.
- **Any agent, many agents**: Any command-line agent can plug in, several can work in the same doc at once, and they @ each other to hand off work.
- **Everything is in the doc**: An agent knows only what the doc and its threads say, so its behavior can always be explained from what you can see.

## Success Metrics

- **User in control**: The AI never takes over the doc. Measure edits that go beyond the comment's scope and the share of edits users undo.
- **Less waiting**: Measure time from a comment or @ to the agent's reply, and how long people and agents wait on each other.
- **Multi-agent collaboration**: Measure the share of docs with 2+ agents, the number of edit conflicts, and how often a person has to pass a message from one agent to another (the target is never).
- **Better writing experience**: Beat an editor + AI plugin on completion time and satisfaction for the same task; track weekly active docs and retention.
- **Open**: Docs open correctly in any Markdown editor; count the third-party agents that connect.

## Roadmap

- **Single agent + human**: @ an agent in a comment or the text, or let it pick up comments in auto-commenter mode; it edits and replies in the thread
- **Multiple agents + human**: Agents @ each other and hand off work with no human passing messages. Milestone: one person and three agents play a full word-chain game whose rules are written only in the doc, with no game-specific code. The game is a test of the props, not a feature

## Risks

- Managing agent permissions
- Agents @-ing each other in a loop, and the cost that comes with it
- Whether we can replicate the experience of collaborating with real people
