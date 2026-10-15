# opendoc

Co-author plain markdown with AI agents. Comments live in a sidecar file next
to the doc (`plan.md` → `plan.md.opendoc.json`), anchored to the text so they
survive edits by either side.

Status: early, but complete end to end: the format spec, the core library,
the CLI, the local editor and the agent skill.

## Agents that answer on their own

Agents are collaborators, like people in a shared doc. Each has a name you
@mention, a slogan that says what it is for, a **persona** (instructions in
your own words for who it is and how it works) and only the permissions its
job needs. OpenDoc comes with five, named after the Office Assistants of old:

| Agent | Slogan | Role | Permissions (Web and Your files: asks first) |
| --- | --- | --- | --- |
| **Clippy** | Your all-round co-author | Pilot | Can edit · Web |
| **Rocky** | Sniffs out grammar slips | Co-pilot | Can edit |
| **Will** | Makes your prose sing | Co-pilot | Can suggest |
| **Genius** | Checks every fact | Co-pilot | Can suggest · Web |
| **Merlin** | Finds it in your files | Co-pilot | Can suggest · Your files |

Who answers what:

- The **pilot** (Clippy, unless you pick another) is in every doc and answers
  every comment that does not @mention someone else, so a comment never goes
  unanswered.
- **Co-pilots** answer only when you @mention them. Type `@` in a comment: the
  menu lists the co-pilots in the doc and the ones you can bring in, each with
  its slogan and permissions. Mentioning one that is not in the doc yet brings
  it in, as mentioning a person in a shared doc shares it with them; the line
  under the comment box says so before you post ("Genius will reply · Genius
  (Can suggest · Web · asks) joins this doc").
- A reply that mentions no one continues with the agent that answered last in
  that thread. A comment that mentions several agents waits on each of them.
- Agents take turns: only one runs at a time in a doc, so their edits never
  collide and each one's changes are recorded on its own reply.

The header shows the doc's agents (the pilot first) and a **People** button
that opens a panel like a shared doc's: you as Owner, the pilot, the
co-pilots here (with Remove), the ones you can add, each with its
permissions (the ones it lacks greyed out, the ones it asks for outlined), and
**Access you allowed**: every grant, with Revoke. Click an avatar for that
agent's card: slogan, role, permissions and grants, persona, what it is doing
and its last run.
**Offline** (grey) means it cannot answer until something is fixed, for
example a failed run, Claude Code not signed in, or the hourly run limit; the
card says what is wrong and offers Try again. Leave a comment and the agent's
avatar and the comment card pulse while it works; its edits appear in the
page highlighted with its name, merged with anything you are typing
elsewhere. Agents always end with a reply in the thread. Only you resolve
threads: resolve it, reply again, or Undo its edit.

Permissions, as in a shared doc: **Can edit** (`auto`, or `--edit-mode`) lets
an agent change the doc and reply with what it changed, which you can undo;
**Can suggest** (`approve`) keeps it out of the doc: it replies with proposed
changes, shown struck through and inserted in the text while the thread is
selected, and nothing changes until you click Apply. That role is fixed per
agent.

**Web** (search and open web pages) and **Your files** (read files other than
the doc, never keys or `.env` files) are asked for at first use, like an app's
permissions on a phone or a tool in VS Code: an agent's profile says which of
the two it may ask for, and the first time a run needs one, a card appears in
the comment it is working on: "Merlin wants to read a file outside this doc
…/notes/q3.md · Only files in …/notes · **Allow once** / **Allow in this
doc** / **Always** / **Deny**". The run waits for your answer. Allow once and
Deny last for the rest of that reply; Allow in this doc and Always are kept
(in your settings, by agent) and listed with Revoke in the People panel and
the agent's card. No answer within 5 minutes counts as Deny, and a denied
agent says in its reply what it needed. No built-in agent may ask for both,
since one that reads your files could be tricked by a web page into sending
them out; turning both on asks you to confirm, and a request for one while
the agent holds the other carries a warning.

**Runs on** picks the program behind the agent; the persona works the same on
any of them. Today: **Claude Code** (`claude -p`, one session per agent per
doc, in a private folder of its own, with only `Read`, `Edit` on this doc (not
in Ask first), and `opendoc` allowed; web and file tools go through an
`opendoc guard` hook that asks you, and stay denied if it cannot; it cannot
read `.env*`, `*.pem` or `*.key` files anywhere, or `~/.ssh` and
`~/.aws`), **Codex** (OpenAI's
`codex exec`, installed with `npm install -g @openai/codex` and signed in once
with `codex login`; one resumed session per agent per doc, in a private folder
of its own, without your Codex config or MCP servers, under a Codex permission
profile: in the doc's folder it reads only the doc and its comments and
cannot edit the doc in Ask first, secrets are denied, and its commands have
no network; it can still read other files on the disk; Codex cannot ask
during a run, so it searches the web only once you allow it in its card; see
[docs/multi-agent.md](docs/multi-agent.md#runtimes)), or a **Custom command** that receives the task (persona
included) in `{promptFile}`. Supporting another agent program (a local open
model) is one more runtime in `src/server/agents/config.js`. A failed run takes the agent offline (its card
has the log) and is not retried until you reply or click Try again.

Settings > Agents lists your agents and edits each one: name, slogan,
persona, role (Make pilot), permissions, runtime, model, limits (turns and minutes per run, runs per
hour, budget), isolated runs (Codex agents have
model, minutes, runs per hour and web search); plus where Claude Code and Codex
are, for all of them (empty: found on `PATH`). Changes restart the agent in every open doc once a
run in progress finishes. An agent's program (a custom command, or the
Claude Code or Codex path) can only be set in the desktop app, which asks you to
confirm the exact command, or in `settings.json`; the browser editor can only
clear it.

`serve` flags add one more agent for that run, next to yours; it answers
comments that mention it or no one:

```bash
opendoc serve plan.md --agent claude --persona "A strict copy editor: fix grammar only"
```

with `--edit-mode auto|approve`, `--max-turns 30`, `--run-timeout 10`
(minutes), `--runs-per-hour 20`, optional `--max-budget-usd`. `--model` picks
the model; `--agent-bin` points at `claude` if it is not found;
`--agent-isolated` adds `--bare` (needs `ANTHROPIC_API_KEY`). Other agents:
`--agent <name> --agent-cmd "<command with {promptFile} {threadsFile} {doc}>"`.

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

Version history (the clock button, or Ctrl+Alt+Shift+H) lists every version
of the doc, newest first: who made it (you, the agent and the comment it was
answering, or a program outside OpenDoc), when, and how many characters it
added and removed. Pick one to read it, with what it changed from the version
before marked in the text, and click Restore this version to put the doc back.
A restore adds a new version, so it can be undone the same way; comments stay
and follow the restored text. Changes by the same author within two minutes
are one version. History is kept on this computer, in `history/` in the config
folder below, never next to the doc, and follows the doc when you rename it in
OpenDoc.

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
