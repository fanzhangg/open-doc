# Architecture

## Overview

How OpenDoc is built, in two parts. [The app](#the-app): the doc host, a
background process that does every file write and runs the buddies, and
the windows you edit in. [A buddy's turn](#a-buddys-turn): buddies are AI
agents that answer comments, and a turn is one buddy answering one
comment: the app starts an agent program on a copy of the doc, then merges
what it changed back in. (The code calls a turn a run: `Runner`,
`runs.jsonl`.)

No backward compatibility with earlier formats: a version 1 sidecar is
ignored, and a version 2 one is not converted. A sidecar this version must
not write (another version, or no header) shows its comments read-only,
with a way to fix it.

### Principles

1. **Files are the truth.** Docs, sidecars and buddy files are plain files.
   Everything else is a cache, rebuilt from them, or only costs undo if
   lost.
2. **Only the app writes them.** An agent gets only a copy. Any other
   change (other editors, `git pull`) is seen and merged.
3. **An agent is a filter:** prompt on stdin, copies of the doc and its
   comments to edit, reply on stdout. It knows nothing of OpenDoc and
   remembers nothing.
4. **No one resolves a conflict by hand.** The person typing always wins.
   What loses is redone (ask the buddy again) or restored (history).
5. **Buddies always edit, and every edit can be undone.** See
   [Undoing changes](#undoing-changes).
6. **Only my own comments start turns.** Nothing in a shared file makes a
   buddy run, or chooses what program runs, on this machine.

## The app

### Doc mode and project mode

The app has two modes:

- **Doc mode:** a `.md` file opened on its own (from Finder, say). One
  doc, one buddy: Clippy. That holds even if the file sits in a project
  folder.
- **Project mode:** a folder opened from the home page. A file tree and
  its docs, Clippy, and the project's own buddies. They live in
  `.opendoc/buddies/` at the folder's root and travel with it
  ([PROJECT](../spec/PROJECT.md)).

| | Doc mode | Project mode |
| --- | --- | --- |
| Opened from | Finder: a `.md` file | The home page: a folder |
| Window | One doc | File tree and docs |
| Folder | none | the opened folder |

The asymmetry is intentional: doc mode is a light editor with one
buddy; project mode is the full multi-doc, multi-buddy experience.

Clippy is the same in both modes: who it is lives in the user's config
folder, not in any project. That is what sets it apart from every other
buddy ([PROJECT §2](../spec/PROJECT.md)):

| | Clippy | Project buddies |
| --- | --- | --- |
| Reached from | every doc, in either mode | docs in their project only |
| Who it is | the user's `buddies/Clippy.md` in their config folder; built in if missing or empty | `.opendoc/buddies/<Name>.md` in the project |
| Travels with | the user | the project folder |
| Name, face | the app's; a project's `Clippy.md` is ignored | the file name; a face made from it |
| Color | yellow, its own | one of the other seven, picked by name |

### Components

| Component | Owns |
| --- | --- |
| Format | `X` + `X.opendoc.jsonl`, anchors on X's text ([SPEC](../spec/SPEC.md)) |
| Model (`src/core`) | anchors, diff and three-way merge on text, reading the sidecar, the inbox. No I/O, and no file format. |
| Markdown library (`src/markdown`) | not a plugin; what both Markdown plugins use: a doc's rendered text and its map back to the source (`project.js`), and saving with the bytes of unchanged blocks kept (`splice.js`) |
| DocService | every write to a doc and its sidecar, one at a time; outside changes; versions |
| Runner | which turns should start (the inbox), runs them, their status in memory |
| Windows | editing and commenting, through DocService. The page talks to its editor, a view, in offsets on the doc's text and works out the marks a view draws (comments, a draft, a revision); every view passes one contract (`test/views.test.js`). The plain view (`web/views/plain.js`, CodeMirror, the text as it is) is the app's own, for any UTF-8 text file up to 1 MB. A view plugin (`web/plugins/`) gives one format a view of its own with its UI and settings, and can be switched off; `viewFor` in `web/plugins/index.js` picks a doc's view: an enabled plugin's that claims its extension, else the plain one. The page knows no format |
| Plugins | built in, each a declaration with no lifecycle, of two kinds; each switches on and off alone, and neither Markdown plugin imports the other. A view plugin (`web/plugins/`) is `{ id, name, about, extensions, createView, settings, labels }`, `settings` its boolean switches and their defaults, `labels` their names in Settings. The Markdown editor (`web/plugins/markdown/`) is a WYSIWYG view with its toolbar, "/" menu, outline and focus mode; it maps the doc's text to its own document through the rendered text, and saves each block the user did not change as it was written. A harness plugin (`src/plugins/`) is `{ id, name, about, extensions, ...hooks }`: what a format adds to plain text where edits merge, whatever the view. `harnessOf(path, settings)` gives the one that is on for the doc's extension, which the doc host (merging a buddy's edit) and the page (merging a change from outside) hand to the merge. Harnesses live in `src/` because the doc host loads only `src/`, never `web/`. The one hook, `mergeLine`, may only refuse: the Markdown harness (`src/plugins/markdown.js`) refuses a character merge inside a line that would change how it renders; off, a `.md` merges as plain text. Settings keep `plugins: { <id>: { enabled, ...switches } }`; the core checks only that shape and keeps ids it does not know. Switching a view plugin makes the affected views again from the same text in every window, the history's too, after saving pending typing; its own switches reach its view as they are. A harness's switch applies from the next merge |

DocService and Runner run in the doc host, the app's utility process.
Windows reach it over Electron message ports.

### How files are read and written

- DocService reads the doc and its sidecar when the doc opens, keeping a
  hash of each. Windows never read the files; they ask DocService.
- It watches both files, through a folder watch and a poll every 500 ms
  for file systems where watches miss changes. When a hash changes, it tells
  every window; a doc change it did not write is saved to history first.
- Before writing, DocService checks the file is still what it last read;
  if not, it merges the outside change first. Where it overlaps what is
  being typed, the typing wins and the outside version is saved to history.
- Every file is written whole: a temporary file in the same folder,
  renamed over it.
- Above the files, a doc is its text: UTF-8, no byte order mark, lines
  ending in `\n`. The file's byte order mark and CRLF line ends are put
  back when it is written; a file that is not UTF-8 does not open.

### Undoing changes

1. **Your own edits:** Cmd+Z, which undoes only yours, as in shared docs.
2. **A buddy's turn:** Undo on its reply. The diff between the versions
   saved before and after the turn is its changes. Each change whose new
   text is still in the doc, found the way an anchor is, is put back; the
   rest are skipped: text belongs to whoever changed it last. All at once,
   never one change; its comments stay.
3. **Anything else:** restore a version from history.

Each of them saves a version first. Undo on a reply works only on the
machine that ran it, where its versions are.

### The config folder

In the config folder (`~/Library/Application Support/OpenDoc/` on macOS),
written only by the app.

| File | Holds |
| --- | --- |
| `settings.json` | the user's id and name; editor preferences; plugins' switches; which agent runs buddies |
| `agents/` | agent scripts; Claude Code and Codex ship as two |
| `state.json` | recent docs and folders, window bounds |
| `history/` | versions of each doc, saved before and after each buddy edit (tagged with its reply's id), before each outside change, undo and restore |

## A buddy's turn

A thread waits on buddy X when a comment by this machine's user, newer than
X's last comment there, asks X. A comment asks whom it @mentions; one that
mentions no one asks the thread's buddies: the one that opened it, and each
the user @mentioned there before. An empty one (resolving, reopening) asks
no one. That is computed from the sidecar and the user's id. Buddies run
only on docs open in a window.

### How a turn works

1. Runner copies the doc and its sidecar into a new private folder and runs
   the [agent script](agent-config.md) there, with the prompt (who the
   buddy is, the thread, the rules) on stdin and the buddy's name in
   `OPENDOC_BUDDY`.
2. The agent edits the doc copy, appends comments to the sidecar copy, and
   prints its reply on stdout.
3. On exit 0, DocService saves versions before and after, merges the doc
   copy's diff into the doc, three-way from the copy as it started, adds
   the appended comments as the buddy's, and writes the reply as the
   buddy's comment. Where the human changed the same text meanwhile, the
   buddy's change is dropped and the reply is marked `conflict`. The reply
   and comments are dated just after the last comment the turn was given,
   so a comment the user wrote meanwhile still waits on X.
4. The private folder is deleted, and the turn gets a line in the config
   folder's `logs/runs.jsonl`: doc, buddy, thread, start, duration, and
   `ok`, `failed`, `timedOut` or `stopped` with the exit code.

Resolving a thread ends its turns at once, with no answer; a turn that
ended but is not merged yet is dropped. Deleting a buddy ends its turns too.

A buddy comments as a human does: new threads, replies in any thread. It
cannot resolve or reopen; anything but appended comments is ignored
([agent config](agent-config.md#comments)). Its comments start no turns
(principle 6).

### What the user sees after a turn

What the app knows, the app shows, not the buddy's reply: under the reply,
how many places the turn edited, with Undo; a dropped change marks the reply
`conflict`; its comments are in the margin. The reply says only what the
app cannot (why, what to decide), and may be empty. The turn's edits land at
once, shown as a revision (new text in the buddy's color, removed text
struck through) until the user next types or another turn's edits land;
clicking the count shows them again. The count, the revision and Undo are on
the machine that ran it only, read from the version saved after the turn and
the one before it.

### Failures, retries and restarts

A turn that fails is answered too: the buddy's comment is marked `failed`,
with the end of the program's output. One ask, one reply; to retry, or to
redo a `conflict`, @mention the buddy again. Which turns are working lives
only in memory: after a restart, unanswered asks run again. Turns go on at
the same time; their merges are applied one at a time.
