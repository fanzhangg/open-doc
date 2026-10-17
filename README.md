# <img src="build/logo.svg" alt="OpenDoc" width="280" height="80">

Co-author plain markdown with AI agents. Comments live in a sidecar file next
to the doc (`plan.md` → `plan.md.opendoc.json`), anchored to the text so they
survive edits by either side.

Status: early, but complete end to end: the format spec, the core library,
the CLI, the local editor and the agent skill.

## Agents that answer on their own

Agents are collaborators, like people in a shared doc. Each has a name you
@mention, a **persona** (one line in your own words that defines it, such as
"a strict copy editor", shown on its card and in the People panel), optional
**instructions** (the details and rules behind the persona) and only the
permissions you give it. Both go into the agent's prompt as one block.
OpenDoc comes with one agent, **Clippy**, starred, with a
generic persona: a general writing assistant that drafts and edits whatever
the doc needs. The product has no built-in
roles; make a grammar checker, a fact checker or a tough reader by writing
its persona, and rewrite or delete any agent.

Agents are light. **New agent** in the People panel pops one into the doc and
opens its card, ready to name: type a name, Enter, then its persona. Click the
name or the persona on any card to edit it in place; the Agents panel holds
the finer settings, such as instructions. A new agent is the doc's own: it
shows only in that doc, its name, persona and instructions are saved in the
doc's sidecar, and it is back whenever you open the doc. Removing it from the
doc (×) deletes it. **Star** it to put it in your agents, for every doc;
unstarring one keeps it in the docs that use it. A doc you get from someone
else (a cloned repo) brings its agents: they are set up as its own, proposing
edits and with no web or file access until you switch more on, since
permissions never come from the doc.

A new doc starts with **Clippy**: the first time a doc with no agents yet is
opened, Clippy joins it (under whatever name you gave it). Add any other agent
in the doc, from the People panel or by @mentioning it. A doc that already
has agents keeps its own.

Every agent reads the doc it works on. Everything else is a switch on the
agent's card (click its avatar) and in the **Agents** panel; flip one and
it holds from the agent's next run:

| Permission | The agent… |
| --- | --- |
| **Editor** | changes the doc. Without Auto Editor it proposes each change: shown struck through and inserted in the text while the thread is selected, applied when you click Apply. Off, it only replies. |
| **Auto Editor** | edits the doc directly and replies with what it changed, which you can undo. Needs Editor. On for every new agent. |
| **Auto Commenter** | looks at every new comment that @mentions no one, in the docs it is in, answering the ones that fit its persona. The first agent in a doc (Clippy, in a new one) starts with it, as the lead. |
| **Web Searcher** | searches the web and opens web pages. |
| **File Searcher** | reads your other files, never keys or `.env` files. |

An agent with both Web Searcher and File Searcher could be tricked by a web
page into sending your files out, so switching on either asks you to
confirm, with a warning when the agent has the other.

Who answers what:

- A comment that mentions no one goes to every agent with **Auto Commenter**. Each
  answers it only if it fits its persona, and leaves it otherwise. Out of
  the box only Clippy has it; an agent you add to a doc with no lead yet
  gets it too.
- An agent without Auto Commenter answers only when you @mention it. Type
  `@` in a comment: the menu lists the agents in the doc and the ones you can
  bring in, each with its persona. Mentioning one that is not in the doc
  yet brings it in, as mentioning a person in a shared doc shares it with
  them.
- `@name` typed in the doc itself works too. Once you are done writing it
  (you move on to another paragraph, or finish the sentence and pause), it
  becomes your comment on the text from the `@` to the end of its paragraph,
  and the agent answers there; when it is done it removes that text (or
  proposes removing it). Reword it before the agent answers and the agent
  takes the new words. Mentions in code do not count.
- A reply that mentions no one continues with the agent that answered last in
  that thread. A comment that mentions several agents waits on each of them.
- Agents work at the same time: a comment that mentions several agents gets
  all of them answering at once. Only their edits to the doc take turns, so
  they never collide and each one's changes are recorded on its own reply.
- Every run starts fresh. An agent remembers nothing between runs except what
  is in the doc and its threads, so anything worth keeping is written where
  you can see it.

The header shows you and the doc's agents side by side (people are circles,
each agent a little face of its own; those with Auto Commenter first), then a
round **People** button that opens a panel like a shared doc's, one line per
person or agent:
you, the agents here (× to remove one), and
the ones you can add (+). Click an agent for its card: name, persona,
permission switches, a star, and a button for more settings; click the
name or the persona to edit it in place.
A **grey** agent cannot answer here: it is not running, still starting, or
something needs fixing, such as a failed run, Claude Code not signed in, or
the hourly run limit; the card then says what is wrong and offers Try again.
Leave a comment and the agent's face wobbles while it works, and the comment
card pulses; its edits appear in
the page highlighted with its name, merged with anything you are typing
elsewhere. Agents end with a reply in every thread addressed to them. Only you
resolve threads: resolve it, reply again, or Undo its edit.

**Runs on** picks the program behind the agent; the persona works the same on
any of them. Today: **Claude Code** (`claude -p`, a new session every run, in
an empty private folder of its own, with only `Read`, `Edit` on this doc
(with Auto Editor), and `opendoc` allowed, plus the web tools with Web
Searcher and `Read` anywhere with File Searcher; it cannot read `.env*`,
`*.pem` or `*.key` files anywhere, or `~/.ssh` and `~/.aws`), **Codex** (OpenAI's
`codex exec`, installed with `npm install -g @openai/codex` and signed in once
with `codex login`; a new session every run, in an empty private folder of
its own, without your Codex config or MCP servers, under a Codex permission
profile: in the doc's folder it reads only the doc and its comments and
cannot edit the doc without Auto Editor, secrets are denied, and its commands
have no network; it can still read other files on the disk, so it has no File
Searcher; Web Searcher turns on Codex's web search; see
[docs/architecture.md](docs/architecture.md#agents)), or a **Custom command** that receives the task (persona and
instructions included) in `{promptFile}`. Supporting another agent program (a local open
model) is one more runtime in `src/server/agents/config.js`. A failed run takes the agent offline (its card
has the log) and is not retried until you reply or click Try again.

The **Agents** panel (People > Manage agents, or the settings button on an
agent's card) lists your agents on the left and edits the one you pick on the
right, in the order you are likely to change things: name and persona,
whether it is starred, what it can do (the same switches as its card), its
instructions, and under **Advanced**
how it runs: runtime, model (Claude agents default to haiku, which is fast),
effort (low, medium or high; low by default), limits (turns and minutes per run, runs per hour,
budget) and isolated runs (Codex agents have model, minutes and runs per
hour). A problem (it cannot start, its last run failed) shows at the top only
when there is one. **Programs** at the foot of the list holds where Claude
Code and Codex are, for all agents (empty: found on `PATH`). Changes restart the agent in every open doc once a
run in progress finishes. An agent's program (a custom command, or the
Claude Code or Codex path) can only be set in the desktop app, which asks you to
confirm the exact command, or in `settings.json`; the browser editor can only
clear it.

`serve` flags add one more agent for that run, next to yours; it answers
comments that mention it or no one:

```bash
opendoc serve plan.md --agent claude --persona "A strict copy editor: fix grammar only"
```

with `--edit-mode auto|approve|none`, `--max-turns 30`, `--run-timeout 10`
(minutes), `--runs-per-hour 20`, optional `--max-budget-usd`. `--model` picks
the model (haiku by default) and `--effort low|medium|high` how hard it
thinks (low by default); `--agent-bin` points at `claude` if it is not found;
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
([architecture](docs/architecture.md#desktop-app)). Build the Windows installer with
`npm run dist:desktop` (it lands in `release/`), or run it from a checkout:

```bash
npm install
npm run desktop                      # start window: New doc, Open, Open Folder, recent docs, Settings
npm run desktop -- path/to/plan.md   # open a doc (asks before creating a missing one)
npm run desktop -- path/to/docs      # open a folder: its docs in a sidebar
```

Each doc opens in its own window; opening a doc that is already open focuses
its window. File > Open (Ctrl/Cmd+O) takes `.md` and `.markdown` files, or a
doc's `.md.opendoc.json` sidecar. File > New Doc (Ctrl/Cmd+N) picks a folder
and a name and never replaces an existing file; File > New Doc in This Folder
(Ctrl/Cmd+Alt+N) creates `Untitled.md` (or `Untitled 2.md`, ...) next to the
open doc (in a folder window it asks for the name in the sidebar instead). File > Rename, or clicking the doc name, renames the doc and its
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

File > Open Folder (Ctrl/Cmd+Shift+O), or a folder dropped on a window or
named on the command line, opens one window with a sidebar listing every
`.md` and `.markdown` file in the folder and its subfolders (hidden folders
and `node_modules` are left out). It starts on the doc last open there, else
the README. Clicking a doc shows it in the same window: the last doc is saved
first, and its agents stop, since each doc still has its own server and agents
that work only on it. While a doc is open from a folder, its agents may also
read the other files in that folder, but never edit them; a Web Searcher agent
there could be tricked by a web page into sending them out. The sidebar button
in the header hides and shows the list.

The sidebar also manages the folder's files (see
[docs/file-management.md](docs/file-management.md)). The buttons by the
folder name start a new doc or folder, named in the tree before anything is
created (`notes/kickoff` makes the folder too); a new doc opens ready to type
in. Each row's `⋯` button, or a right-click, has Rename (F2), Move To…,
Reveal, Copy Path and Delete; drag a row onto a folder to move it. A doc
always moves with its comments, history and own agents, and a window showing
it follows. Delete asks first and puts the doc and its sidecar, or the folder
with everything in it, in the Trash. The tree takes the arrow keys, Enter,
F2, Delete (Cmd+Backspace on macOS) and Shift+F10 for the menu. Empty folders
show, so a new one has a place; folders holding no docs at all stay hidden.

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
opendoc export plan.md --to pdf --comments open   # plan.pdf next to the doc
opendoc export plan.md --to html --out ~/share/plan.html
```

Every command takes `--json`. `--as` defaults to `OPENDOC_AS`; `--kind`
defaults to `agent`. Exit codes: 0 ok, 1 error, 2 bad input, 3 `wait` timed
out, 4 sidecar busy. A thread is in someone's inbox when its latest message is
from a human and mentions them or no one, or when an agent handed it to them
with `reply --to <agent>` (an agent's plain @mention wakes no one; at most 4
handoffs in a row before a human writes again). Only a human can resolve or reopen a thread;
`resolve` and `reopen` as an agent exit 2. In `propose`, each `before` is
markdown source that must appear exactly once in the doc. `export` takes
`--to pdf|html`, `--comments none|open|all` (none by default), `--paper
a4|letter` and `--font sans|serif|mono` (your editor font by default); a PDF
needs Chrome, Edge or Chromium installed (`OPENDOC_BROWSER` points at one).

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
app. `npm run icon:desktop` draws the app icon (Clippy on a paper tile, also
the favicon and the logo's mark), the logo and the document icons from
`web/faces.js` into `build/`, as SVG, PNG, ICO and ICNS.

Requires Node 20 or later.
