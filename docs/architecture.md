# Architecture

How OpenDoc is built, and why. No backward compatibility with OpenDoc 1: a
version 1 sidecar is reported as unreadable.

Two words: a **buddy** is who you @mention in a doc (a name, a persona,
instructions); an **agent** is the CLI that does its work (Claude Code,
Codex). A buddy runs on an agent.

## Principles

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
   [Undo](#undo).
6. **Only my own comments start runs.** Nothing in a shared file makes a
   buddy run, or chooses what program runs, on this machine.

## Buddies and folders

A window has a doc and, in project mode, a folder. Its buddies are Clippy,
built into the app, and the folder's (`.opendoc/buddies/`), each a
`<Name>.md` file ([PROJECT](../spec/PROJECT.md)).

| | Doc mode | Project mode |
| --- | --- | --- |
| Opened from | Finder: a `.md` file | The home page: a folder |
| Window | One doc | File tree and docs |
| Folder | none | the opened folder |

That is the only difference: doc mode is project mode with no folder.

## Components

| Component | Owns |
| --- | --- |
| Format | `X.md` + `X.md.opendoc.jsonl` ([SPEC](../spec/SPEC.md)) |
| Model (`src/core`) | rendered text, anchors, diff and three-way merge, reading the sidecar, the inbox. No I/O. |
| DocService | every write to a doc and its sidecar, one at a time; outside changes; versions |
| Runner | which runs should start (the inbox), runs them, their status in memory |
| Windows | editing and commenting, through DocService |

DocService and Runner run in the doc host, the app's utility process.
Windows reach it over Electron message ports.

## Who answers

A thread waits on buddy X when a comment by this machine's user, newer than
X's last comment there, @mentions X. That is computed from the sidecar and
the user's id. A comment that mentions no one asks no one. Buddies run only
on docs open in a window.

## A run

1. Runner copies the doc and its sidecar into a new private folder and runs
   the [agent script](agent-config.md) there, with the prompt (persona,
   instructions, the thread, the rules) on stdin and the buddy's name in
   `OPENDOC_BUDDY`.
2. The agent edits the doc copy, appends comments to the sidecar copy, and
   prints its reply on stdout.
3. On exit 0, DocService saves versions before and after, merges the doc
   copy's diff into the doc, three-way from the copy as it started, adds
   the appended comments as the buddy's, and writes the reply as the
   buddy's comment. Where the human changed the same text meanwhile, the
   buddy's change is dropped and the reply is marked `conflict`.
4. The private folder is deleted.

A buddy comments as a human does: new threads, replies in any thread. It
cannot resolve or delete; anything but appended comments is ignored
([agent config](agent-config.md#comments)). Its comments start no runs
(principle 6).

What the app knows, the app shows, not the buddy's reply: under the reply,
how many edits and comments the run made and how many edits were dropped.
The reply says only what the app cannot (why, what to decide), and may be
empty. The run's edits land at once, underlined in the buddy's color until
the user next types. Both are on the machine that ran it only: the counts
are kept with the version saved after the run.

A run that fails is answered too: the buddy's comment is marked `failed`,
with the end of the program's output. One ask, one reply; to retry, or to
redo a `conflict`, @mention the buddy again. Which runs are working lives
only in memory: after a restart, unanswered asks run again. Runs go on at
the same time; their merges are applied one at a time.

## Undo

1. **Your own edits:** Cmd+Z, which undoes only yours, as in shared docs.
2. **A buddy's run:** Undo on its reply. The diff between the versions
   saved before and after the run is its changes. Each change whose new
   text is still in the doc, found the way an anchor is, is put back; the
   rest are skipped: text belongs to whoever changed it last. All at once,
   never one change; its comments stay.
3. **Anything else:** restore a version from history.

Each of them saves a version first. Undo on a reply works only on the
machine that ran it, where its versions are.

## Writes

- Before writing, DocService checks the file is still what it last read;
  if not, it merges the outside change first. Where it overlaps what is
  being typed, the typing wins and the outside version is saved to history.
- Every file is written whole: a temporary file in the same folder,
  renamed over it.

## Local state

In the config folder (`~/Library/Application Support/OpenDoc/` on macOS),
written only by the app.

| File | Holds |
| --- | --- |
| `settings.json` | the user's id and name; editor preferences; which agent runs buddies |
| `agents/` | agent scripts; Claude Code and Codex ship as two |
| `state.json` | recent docs and folders, window bounds |
| `history/` | versions of each doc, saved before and after each buddy edit (tagged with its reply's id), before each outside change, undo and restore |
