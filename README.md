# opendoc

Co-author plain markdown with AI agents. Comments live in a sidecar file next
to the doc (`plan.md` → `plan.md.opendoc.json`), anchored to the text so they
survive edits by either side.

Status: early, but complete end to end: the format spec, the core library,
the CLI, the local editor and the agent skill.

## Agent that answers on its own

Turn it on in Settings > Agent (in the desktop app or the browser editor), or
start one for a single run:

```bash
opendoc serve plan.md --agent claude
```

The editor works like a shared doc with Claude as a co-author, and Claude
follows the same rules as any other reviewer. Leave a comment and the server
starts a headless Claude Code run for it: Claude's avatar and the comment
card pulse while it works, and its edits appear in
the page highlighted with its name, merged with anything you are typing
elsewhere in the doc. Claude always ends with a reply in the thread. Only you
resolve threads: resolve it, reply again, or Undo its edit.

Claude's avatar in the header shows its presence, as in a chat app; click it
to change it:

- **Online** (green): every comment and reply goes to Claude unless it
  mentions only someone else (`@alex …`).
- **Do not disturb** (red with a bar): only comments that mention `@claude`.
  Comments left meanwhile are answered when you set it back to Online.
- **Offline** (grey): Claude cannot answer until something is fixed, for
  example a failed run, Claude Code not signed in, or the hourly run limit. The
  card says what is wrong and offers Try again.

How far Claude may go is up to you (Settings > Agent > Edits, or
`--edit-mode`): **Edit directly** (`auto`, the default) lets it change the
doc and reply with what it changed, which you can undo; **Ask first**
(`approve`) keeps it out of the doc: it replies with proposed changes, shown
struck through and inserted in the text while the thread is selected, and
nothing changes until you click Apply. An applied proposal can be undone
like any edit, and the thread stays open until you resolve it.

Each run uses `claude -p` in the doc's folder with only
`Read`, `Edit` on this doc (not in Ask first), and `opendoc` allowed; it cannot read `.env*`,
`*.pem` or `*.key` files anywhere, or `~/.ssh` and `~/.aws`. Runs are
batched, one at a time, and resume the same Claude session while the server runs. A failed run
takes Claude offline (its card has the log) and is not retried until you
reply or click Try again.

Settings > Agent is saved with your other settings and applies to every doc:
on or off, Claude Code or a custom command, the agent's name, whether it edits
directly or asks first, the model, limits (turns and minutes per run, runs per hour, budget),
where Claude Code is, and isolated runs. A status line says whether the agent
is ready, and changes restart it in every open doc once a run in progress
finishes. The agent's program (a custom command, or the Claude Code path) can
only be set in the desktop app, which asks you to confirm the exact command,
or in `settings.json`; the browser editor can only clear it.

The same options as `serve` flags, which apply instead of the settings for that
run: `--edit-mode auto|approve`, `--max-turns 30`, `--run-timeout 10` (minutes), `--runs-per-hour 20`,
optional `--max-budget-usd`. `--model` picks the model; `--agent-bin` points at
`claude` if it is not found; `--agent-isolated` adds `--bare` (needs
`ANTHROPIC_API_KEY`). Other agents: `--agent <name> --agent-cmd "<command with
{promptFile} {threadsFile} {doc}>"`.

## Agent skill

[`skills/opendoc/SKILL.md`](skills/opendoc/SKILL.md) teaches an agent the
loop: `opendoc wait` in the background, read and edit the doc (or propose
changes), always reply, wait again. Agents never resolve threads. For Claude Code, copy the
`skills/opendoc` folder into `~/.claude/skills/` (all projects) or
`.claude/skills/` (one project).

## Editor

```bash
opendoc serve plan.md        # opens a two-pane editor on 127.0.0.1
```

Edit the doc visually. Select text and click the comment button at the page
edge (or press Ctrl+Alt+M); comments sit in the margin beside their text. Type
`@` to mention a participant. Changes made to the file on disk show up live and
merge with your unsaved typing; only a change to the same paragraph you are
editing asks you to choose. Saves keep the original bytes of every block you did
not touch, so `git diff` shows only real edits.

Settings (your name, theme, font, width, outline, word count, focus mode) are
saved for every doc in `settings.json` in your config folder
(`%APPDATA%\OpenDoc` on Windows, `~/Library/Application Support/OpenDoc` on
macOS, `~/.config/opendoc` on Linux; `OPENDOC_CONFIG_DIR` overrides it). A
change applies at once in every open editor.

- [Format spec](spec/SPEC.md) and [JSON Schema](spec/opendoc.schema.json)
- [Example doc](spec/examples/plan.md) and [its sidecar](spec/examples/plan.md.opendoc.json)

## Desktop app (preview)

The same editor in its own window, without a terminal or a browser tab
([design and plan](docs/desktop-app.md)). Build the Windows installer with
`npm run dist:desktop` (it lands in `release/`), or run it from a checkout:

```bash
npm install
npm run desktop                      # start window: New doc, Open, recent docs
npm run desktop -- path/to/plan.md   # open a doc (asks before creating a missing one)
```

Each doc opens in its own window; opening a doc that is already open focuses
its window. File > Open (Ctrl/Cmd+O) takes `.md` and `.markdown` files, or a
doc's `.md.opendoc.json` sidecar. File > New Doc (Ctrl/Cmd+N) picks a folder
and a name and never replaces an existing file; File > New Doc in This Folder
(Ctrl/Cmd+Alt+N) creates `Untitled.md` (or `Untitled 2.md`, ...) next to the
open doc. File > Rename, or clicking the doc name, renames the doc and its
sidecar together, like `opendoc mv`, and the window stays open. Closing a
window waits for the last save. Settings are the same `settings.json` as
above, so they apply to every window and to `opendoc serve`. Recent docs and
the last window size are kept in `state.json` in the same folder.

There is one app for every launch: running `npm run desktop -- other.md`
while the app is open opens `other.md` in the running app. Drop a `.md` file
on any window to open it. The View menu switches focus mode, the outline, the
word count, theme, font and page width for every window; File > Show in File
Explorer (Reveal in Finder on macOS) shows the doc's folder. If the open doc is
moved or deleted outside the app, a banner says so and saving stops until you
click Save it here again (or the file comes back).

## CLI

```bash
opendoc comment plan.md --quote "ship all six features" "Is six realistic?" --as fzhan --kind human
opendoc comments plan.md                 # open threads, with line numbers
opendoc inbox plan.md --as claude        # threads waiting on claude
opendoc wait plan.md --as claude         # block until one is, mark it, print it
opendoc reply plan.md t_k3x9q2m7pa "Cut to three." --as claude
echo '{"body": "Cut to three.", "changes": [{"before": "six features", "after": "three features"}]}' \
  | opendoc propose plan.md t_k3x9q2m7pa --as claude   # suggest instead of editing
opendoc resolve plan.md t_k3x9q2m7pa --as fzhan --kind human   # humans only
opendoc mv plan.md q4-plan.md            # moves the sidecar too
```

Every command takes `--json`. `--as` defaults to `OPENDOC_AS`; `--kind`
defaults to `agent`. Exit codes: 0 ok, 1 error, 2 bad input, 3 `wait` timed
out, 4 sidecar busy. A thread is in someone's inbox when its latest message is
from a human and mentions them or no one. Only a human can resolve or reopen a thread;
`resolve` and `reopen` as an agent exit 2. In `propose`, each `before` is
markdown source that must appear exactly once in the doc.

## Core library

```js
import { project, findQuote, createAnchor, reanchorThreads } from 'opendoc';

const { text } = project(markdown);            // rendered text, markup removed
const range = findQuote(text, 'ship all six'); // or a selection from the editor
const anchor = createAnchor(text, range.start, range.end);

// After the doc changes:
const { threads } = reanchorThreads(project(newMarkdown).text, sidecar.threads);
```

Re-anchoring tries an exact match, then the unchanged text around the quote
(context bracket), then a fuzzy match, and otherwise marks the thread
`detached` without losing it. See [SPEC.md §3](spec/SPEC.md#3-anchors).

## Development

```bash
npm install
npm run build    # bundles the editor into dist/web
npm test

npm run pack:desktop    # the desktop app, unpacked, in release/
npm run dist:desktop    # its installer (Windows: NSIS) in release/
npm run smoke:desktop   # launch the built app (or this checkout's) and check it
```

The installer is not signed yet, so Windows SmartScreen warns before running
it. On Windows it adds OpenDoc to "Open with" for `.md` and `.markdown` and a
New > Markdown Document entry in Explorer, without making itself the default
app. `node_modules/.bin/electron scripts/make-icon.cjs` renders
`build/icon.svg` to the `build/icon.png` the installers use.

Requires Node 20 or later.
