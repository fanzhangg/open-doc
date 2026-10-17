# v2 Milestones

Done: M1–M6, one commit each on branch `v2`. Verified on Linux (lint,
build, `npm test`, `test:stress`, `smoke:desktop` under xvfb); not yet on
macOS or Windows, nor with the real Claude Code and Codex scripts. Changed
from the plan: history keeps versions of the doc only, not of its sidecar.
This plan keeps the Removed lists as the record of what went.

How to get from the app before v2 to the [architecture](architecture.md) in
steps. Each milestone ships on its own: the app works end to end, `npm test`
and lint pass on macOS, Windows and Linux, and the docs it touches are
updated. Tests follow [testing and CI](testing-ci.md): the agent is a fake
script, and no test runs a model.

```
M1 ──> M2 ──> M3 ──> M4
  └──> M5
                         all ──> M6
```

## M1. An agent is a filter

The run becomes: copy the doc into a private folder, run a script with the
prompt on stdin, read the reply from stdout, merge the copy on exit.

**In:** agent scripts in `agents/` (`<name>` and `<name>.cmd`), Claude
Code and Codex shipped as two, one picked in Settings for every buddy, with
`OPENDOC_BUDDY` set; merge on exit, the human's text wins, the buddy's
overlapping change is dropped and its reply marked `conflict`; buddies
always edit; a failed run answered with a reply marked `failed`; which runs
are working, in memory only. The UI says buddy for who you @mention and
agent for the CLI.

**Removed:** floor, guard hook, lease, run base rebasing, `catchUp`,
`overwritten`; runtime JSON configs, adapters, program checks and a
runtime per agent; Retry and Cancel; `opendoc reply` and the skill; the Editor switch, File Searcher,
Auto Editor, Auto Commenter, Web Searcher.

**Done when:**
- A fake script that edits its copy and prints a line: the doc has its
  edit, the thread has its reply, and the run had no `opendoc` to call.
- The human edits the same paragraph during the run: the human's text
  stays, the buddy's change there is dropped, the reply says `conflict`,
  and nothing asks the user to choose.
- Two buddies run at once on one doc; both edits land, one merge at a time.
- A script that exits 1: its reply is marked `failed`, with the end of its
  output and its path; @mentioning the buddy again runs it again.
- The shipped Claude and Codex scripts answer a real @ on all three
  platforms (checked by hand once).

## M2. One app, no server

The CLI and the HTTP server go. Windows talk to the doc host over Electron
message ports.

**Removed:** `opendoc` CLI, `bin/`, the shim, `opendoc serve`; the HTTP
server, its port, token and SSE; text asks (`@name` typed in the doc),
`/api/caret`, `/api/editing`.

**Done when:**
- The running app listens on no port.
- `package.json` has no `bin`; nothing in the repo starts a server.
- Opening, editing, commenting and buddy runs work in several windows at
  once, and after the doc host restarts.
- `@name` typed in the doc text is plain text.

## M3. Sidecar v2

`X.md.opendoc.jsonl` per [SPEC](../spec/SPEC.md): one kind of line,
the comment.

**In:** reading and writing v2, the file always written whole; `resolved`,
`conflict` and `failed` on comments; delete removes lines; runs start only for comments by
this machine's user; conformance fixtures in `spec/conformance/`.

**Removed:** the v1 sidecar (shown as unreadable, left untouched); editing
comments; proposals, recorded edits and their review UI; agents and
participants in the sidecar, and setting them up from a doc.

**Done when:**
- Conformance fixtures pass; any order or duplication of lines reads to
  the same threads (property test).
- Resolving is a comment with `resolved`; any later comment reopens.
- A comment by another user id that @mentions a buddy runs nothing.
- A v1 sidecar opens with a notice, and its bytes are unchanged.

## M4. Buddies are files

**In:** buddy files per [PROJECT](../spec/PROJECT.md): the user's in
`<config>/buddies/` (`Clippy.md` made there on first run), a project's in
`.opendoc/buddies/`; doc mode is project mode with no folder; a project's
buddy wins a shared name; each buddy a `<Name>.md` (name from the file,
persona the first line); avatars made from the name; `by.kind` is `ai`.

**Removed:** agents in `settings.json`, starred agents, a doc's own agents,
templates, project trust, per-machine overrides, Clippy as a special case,
agent ids, JSON agent files, stored faces, `mentions`; a v1
`settings.json` is discarded.

**Done when:**
- A `.md` opened from Finder reaches the user's buddies only, even inside a
  project folder.
- A folder opened from the home page reaches the user's and the folder's
  buddies; adding the first buddy creates `.opendoc/`.
- A project committed on one machine and cloned on another has the same
  buddies and the same avatars.
- Moving the folder keeps its buddies.
- `settings.json` holds no buddy.

## M5. Undo and history

**In:** versions saved before and after each buddy edit (tagged with its
reply's id), before each outside change, undo and restore; Undo on a
buddy's reply (reverse diff, merged three-way, your later text stays);
Cmd+Z undoes only your own edits; an outside change overlapping your typing
loses, and its version is saved.

**Done when:**
- Undo on a reply removes that buddy's edit and keeps a later human edit
  and a later buddy's edit elsewhere.
- Where you changed the buddy's text since, Undo leaves your text and asks
  nothing.
- Cmd+Z after a buddy's edit undoes your last edit, not the buddy's.
- `git pull` changing the paragraph being typed: the typing stays, and the
  pulled version is in history.
- Every undo and restore can itself be restored.

## M6. Docs

**Done when:**
- The v2 docs replace `architecture.md` and `spec/SPEC.md`.
- `user-experience.md` and `README.md` describe v2.
- No doc but this plan mentions a concept in architecture v2's Removed list.
