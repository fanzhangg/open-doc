# Architecture

How OpenDoc is built. For what it does, see
[user experience](user-experience.md); for the file format in full, see
[SPEC.md](../spec/SPEC.md).

## Overview

```
Desktop app (Electron)                 Browser (opendoc serve)
  one window per doc ──┐                    │
                       ▼                    ▼
              Local server, one per doc (127.0.0.1 + token)
              ├─ HTTP API + SSE live sync
              ├─ file watcher, saves, version history
              └─ agent team → dispatchers → agent CLIs (claude, codex, …)
                       │
                       ▼
        plan.md  +  plan.md.opendoc.json      ◄── opendoc CLI (agents, scripts)
```

Everything converges on two plain files. The doc is the source of truth; the
server, the CLI and outside agents all read and write the same files using the
same core library, so any of them can work without the others.

## Data: the doc and its sidecar

- **Doc**: any markdown file, never modified to hold OpenDoc data.
- **Sidecar** (`X.md.opendoc.json`): participants and comment threads. Each
  thread has an anchor, messages, status, and optional agent edits and
  proposals. Created on the first comment; `opendoc mv` moves it with the doc.
- **Anchors** are on the doc's *rendered* text (markup removed): the quote plus
  up to 32 characters of context each side and a position hint. After a
  change, re-anchoring tries exact match, then surrounding context, then fuzzy
  match; failing all, the thread is marked `detached`, never dropped. It is
  deterministic, so every tool agrees.
- **Inbox** is computed from the sidecar alone: a thread waits on an agent when
  its latest human message mentions it (or no one, for agents taking open
  asks) and the agent has not answered since. No cursors or server state.
- **Mentions in the doc text** (SPEC §4.1) become threads, so the inbox rule
  stays the same. On each human save the server diffs the rendered text
  (lines, then the characters of changed lines) and takes as new each
  `@name` of an agent outside code that is not an old one carried over
  untouched (`addedMentions`, `src/core/text-mentions.js`); agents' writes
  ask nothing. `src/server/text-asks.js` follows each by an anchor on its
  `@name` and sends it, as a thread by the human anchored from the `@` to the
  end of its block, once the human is done writing it: the caret (the page
  reports moves between paragraphs and blur, `POST /api/caret`) or a save is
  in another paragraph, or the paragraph has been still for 15 s, or 3 s when
  the ask ends a sentence. Until the agent answers, the thread follows the
  text: a human change to the ask holds the thread back from the agents
  (`held`, checked by each dispatcher), stops a run answering it (not counted
  as a failure), and once the human is done again rewrites the first
  message and anchor and lets the agents look.
- **Writes** take a short exclusive lock file, re-read, apply an operation with
  a client-generated id, and rename a temp file over the sidecar. Concurrent
  writers never lose changes; retries apply at most once.

## Code layout

| Path | Role |
| --- | --- |
| `spec/` | Format spec, JSON Schema, example doc. The contract between tools. |
| `src/core/` | Pure library, same output in Node and the browser: rendered text (`project`), anchors, sidecar ops, inbox, mentions (in comments and in the doc text), diffs/edits/proposals, three-way merge, settings and agent profiles. |
| `src/store/` | Disk: locked sidecar writes, file watching, user settings, version history. |
| `src/server/` | Local HTTP server per doc: API, SSE, byte-preserving saves (`splice.js`), @mentions typed in the text (`text-asks.js`), and the agent runner (`agents/`). |
| `src/cli/` | `opendoc` CLI: `comment`, `comments`, `inbox`, `wait`, `reply`, `propose`, `resolve`, `mv`, `serve`, `guard`. `--json` and stable exit codes. |
| `web/` | Editor page: Milkdown (ProseMirror) editor, comment margin, replay of agent edits, proposal previews, panels. Bundled by esbuild into `dist/web`. |
| `desktop/` | Electron shell: windows, menus, dialogs, OS file association, start window, `opendoc` shim. |
| `skills/opendoc/` | Skill that teaches an agent the comment loop. |

## Editor and saving

- The page edits markdown in a WYSIWYG editor and sends the serialized
  markdown to the server. `splice.js` keeps the original bytes of every block
  whose meaning did not change, so diffs show only real edits.
- Changes on disk arrive over SSE. Agent edits are **replayed** as typing
  (`web/replay.js`), mapped through the human's own transactions so both can
  type at once. Other outside changes replace only the blocks that differ.
- Concurrent edits merge three-way (`src/core/merge.js`): different
  paragraphs merge; the same paragraph merges by character when safe; true
  overlaps keep the human's text and turn the agent's into a proposal.

## Agents

- **Profiles** live in the user's `settings.json` (`src/core/agents.js`):
  name, persona (one line), instructions (any length), runtime, permissions, limits,
  and whether it is starred. A new user has one plain agent, Clippy, starred;
  there are no built-in roles. An unstarred agent is one doc's own (`doc`:
  its full path, set only by the server, moved on rename): it shows and runs
  only there, and removing it from the doc deletes it. Names are unique among
  the starred agents and each doc's own. **Membership** lives in the
  sidecar's participants, which also carry each agent's persona and
  instructions (SPEC §2.4), so a doc travels with its agents: opening a doc
  whose agents this machine lacks sets them up as its own, with the safest
  permissions (never taken from the doc). The **crew** (starred agents with
  `crew`) joins a doc the first time it is opened with no agents in it; the
  desktop start window edits it through the preload API.
- **Team** (`agents/team.js`): one dispatcher per agent in the open doc. They
  share a `Floor`, so only one runs at a time. This keeps each run's file
  changes attributable to it (recorded edits, undo, version history).
- **Dispatcher** (`agents/dispatcher.js`): watches the inbox, claims threads
  (`working`), runs the agent with the threads and a prompt (task, persona and instructions as one block,
  other agents, rules), records the run's edits on its reply, and handles
  failures, limits and restarts when settings change. A Doc Watcher's
  dispatcher also hears every change to the doc's text with its author (the
  server attributes human saves, the running agent's edits and outside
  changes); once the doc is still for 5 s it runs with those changes, and the
  run's edits go on the comment it wrote (or a new one). The Floor counts
  watch runs set off by agents alone and stops them after 6 in a row, until
  anyone else changes the doc.
- **Runtimes** (`agents/config.js`, `adapters.js`): an adapter per program
  (Claude Code, Codex, custom command) that checks the program, builds the
  command line, prepares an empty private working folder per agent per doc,
  and parses the result.
- **Nothing remembered in private.** Every run is a new session: no
  `--resume`, Claude Code runs with `--no-session-persistence`, and the
  private folder is emptied before each run. What an agent knows comes from
  the doc and its threads, which the human sees too. The agent acts only through its file tools and
  the `opendoc` CLI, so a new runtime needs no other changes.
- **Permissions are enforced by the run's tools**, not just the prompt: a
  permission that is off is absent from the command line. Secrets (`.env*`,
  keys, `~/.ssh`, `~/.aws`) are always denied. With Auto Editor, a hook runs
  `opendoc guard` before each edit and refuses one where the human is typing.
- An agent's program path can only be set from the desktop app (with a native
  confirmation) or `settings.json`; the page can only clear it.

## Desktop app

- Electron, because the server, watcher and dispatcher are Node and run
  unchanged in the main process. Each window loads its doc's local server, so
  the app and `opendoc serve` share one page.
- Single instance: a second launch hands its files to the running app. Paths
  are resolved to real paths, so one doc never opens twice.
- Renderer is sandboxed with context isolation; the preload API accepts only
  user-initiated actions and never takes paths from the page.
- Packaged with electron-builder: a Windows NSIS installer (unsigned), a
  macOS dmg (ad-hoc signed until there is a Developer ID), and a Linux
  AppImage target.

## Local state

All in the user config folder (`%APPDATA%\OpenDoc`,
`~/Library/Application Support/OpenDoc`, `~/.config/opendoc`;
`OPENDOC_CONFIG_DIR` overrides):

- `settings.json`: editor settings and agent profiles, shared by every window
  and `opendoc serve`, with live updates.
- `state.json`: recent docs and window bounds.
- `history/`: per-doc version snapshots, kept out of the doc's folder.

Nothing leaves the machine except what an agent's own program sends to its
model provider.
