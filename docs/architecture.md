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
- **Writes** take a short exclusive lock file, re-read, apply an operation with
  a client-generated id, and rename a temp file over the sidecar. Concurrent
  writers never lose changes; retries apply at most once.

## Code layout

| Path | Role |
| --- | --- |
| `spec/` | Format spec, JSON Schema, example doc. The contract between tools. |
| `src/core/` | Pure library, same output in Node and the browser: rendered text (`project`), anchors, sidecar ops, inbox, mentions, diffs/edits/proposals, three-way merge, settings and agent profiles. |
| `src/store/` | Disk: locked sidecar writes, file watching, user settings, version history. |
| `src/server/` | Local HTTP server per doc: API, SSE, byte-preserving saves (`splice.js`), and the agent runner (`agents/`). |
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
  name, introduction, persona, runtime, permissions, limits. **Membership**
  lives in the sidecar's participants, so it travels with the doc.
- **Team** (`agents/team.js`): one dispatcher per agent in the open doc. They
  share a `Floor`, so only one runs at a time. This keeps each run's file
  changes attributable to it (recorded edits, undo, version history).
- **Dispatcher** (`agents/dispatcher.js`): watches the inbox, claims threads
  (`working`), runs the agent with the threads and a prompt (task, persona,
  other agents, rules), records the run's edits on its reply, and handles
  failures, limits and restarts when settings change.
- **Runtimes** (`agents/config.js`, `adapters.js`): an adapter per program
  (Claude Code, Codex, custom command) that checks the program, builds the
  command line, prepares a private working folder and session per agent per
  doc, and parses the result. The agent acts only through its file tools and
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
