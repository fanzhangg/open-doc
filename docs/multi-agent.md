# Agents as collaborators

Status: built. Supersedes the single "AI co-author" of Settings > Agent
described in `desktop-app.md`.

## The idea

An agent is a collaborator, set up and treated like a person in a shared doc:

- It has an **identity**: a name you @mention, an avatar with its own colour,
  and an **introduction** of a few words that says what it is for.
- It has a **persona**: instructions in the human's words for who it is and how
  it works ("a strict copy editor; fix grammar only").
- It has **permissions**, as narrow as its job, each a switch the human flips
  right on the agent's card:

| Permission | Field | The agent… |
| --- | --- | --- |
| Editor | `editMode` 'approve' or 'auto' | changes the doc; without Auto Editor, by proposing each change for the human to apply. Off ('none'), it only replies |
| Auto Editor | `editMode` 'auto' | edits directly, without asking first. Needs Editor: switching it on turns Editor on, and switching Editor off turns it off |
| Auto Commenter | `autoComment` | is in every doc and looks at every new comment that @mentions no one, answering the ones that fit its persona |
| Web Searcher | `webAccess` | searches and fetches the web |
| File Searcher | `fileAccess` | reads the user's other files, never secrets |

A switch that is on is granted: the next run gets the tools, with nothing
asked mid-run. Only humans resolve threads.

The app comes with six agents, named in parody of the Office Assistants.
Each owns one part of the work, so no two do the same job, and has exactly
the permissions that part needs:

| Agent | Introduction | Owns | Editor | Auto Editor | Auto Commenter | Web Searcher | File Searcher |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Clippy | Drafts and reshapes your doc | Content and structure | ✓ | ✓ | ✓ | | |
| Rocky | Fixes grammar and typos | Correctness | ✓ | ✓ | | | |
| Will | Polishes style and flow | Style | ✓ | | | | |
| Genius | Checks facts against sources | Facts | ✓ | | | ✓ | |
| Merlin | Finds it in your files | The author's material | ✓ | | | | ✓ |
| Links | Critiques like a tough reader | Feedback | | | | | |

The permissions follow the job: mechanical, safe fixes (Rocky) and the
co-author the human talks to most (Clippy) edit directly; judgement calls
(style, facts, material from elsewhere) are proposed; a critique changes
nothing. Only Clippy has Auto Commenter, so an open comment gets one answer
by default. Every persona has the same four parts: who it is, its job, what
it leaves alone and to whom (by @name, so the human knows whom to ask), and
how it replies. An agent without an introduction is shown by the first
sentence of its persona (`introOf`).

No built-in agent has both Web Searcher and File Searcher: an agent that
reads your files could be tricked by a web page into sending them out.
Switching either on asks for confirmation, with a warning when the agent has
the other.

The persona and identity are decoupled from what executes the agent: the
**runtime**. Today an agent runs on Claude Code (`claude -p`), on OpenAI
Codex (`codex exec`) or on any command line; a local open model is one more
runtime.

### The card

Clicking an agent's avatar opens its card, kept to what the human acts on:
avatar, name, introduction, a pencil to edit the profile, and the five
permissions as toggle chips (filled when on). A problem (the
agent cannot start, its last run failed, it hit its hourly limit) adds a box
with the reason, Try again and the run log; a healthy agent shows no status.
The green dot on the avatar means Auto Commenter.

## What the UX borrows, and from where

Researched Oct 2026 (ChatGPT GPT mentions and group chats, Grok agents,
Microsoft Copilot agents in Word, Gemini Gems in Docs, Notion custom agents,
Slack agents, VS Code chat participants and tool approval, Poe multi-bot
chat, Google Docs and Figma sharing, Android permissions):

| Pattern | From | Here |
| --- | --- | --- |
| `@` summons a bot mid-conversation, picker shows recent ones with a description | ChatGPT GPT mentions, Poe, Slack, Copilot in Word | `@` menu grouped *Agents in this doc* / *Bring in (joins this doc)* / *People*, each with its introduction; matches names, and introductions from two letters ("@gram" finds Rocky) |
| Assistants that speak without being called | ChatGPT in group chats | Auto Commenter, for any number of agents, each answering what fits its persona |
| Mentioning someone without access offers to share | Google Docs | Mentioning an agent brings it in; the line under the comment box says so before you post |
| A share panel listing people with roles | Google Docs, Figma, Notion | People panel, one line each: you, the agents here (× to remove), agents to add (+); permissions are on each agent's card |
| Agents get their own, narrow access | Notion custom agents, Android least privilege | Per-agent permissions, switched on and off in place on the agent's card |
| Who will answer is visible before sending | (gap in most products) | "Clippy will reply if it fits", "Genius will reply · Genius joins this doc" |

Where the research and this design differ: the research suggested plain job
titles for names; the agents keep fun names, with the introduction carrying
the job. An earlier version asked for Web and Your files at first use (Allow
once / in this doc / always / deny, as Android and VS Code do); it was
dropped for plain switches, which are simpler to understand and to undo.

## Model

| Concept | Where it lives | What it is |
| --- | --- | --- |
| Agent (profile) | User settings, `agents[]` (`src/core/agents.js`) | `id`, `name`, `tagline` (introduction), `persona`, `runtime`, `editMode`, `autoComment`, `webAccess`, `fileAccess`, limits, `command` |
| Permissions | `PERMISSIONS`, `permissionsOf`, `permissionPatch` (`src/core/agents.js`) | The five switches, and the profile change each one makes |
| Membership | The doc's sidecar, `participants` | An agent with Auto Commenter joins every doc it opens; another joins when @mentioned or added; `leave` (SPEC §6) removes it |
| Runtime | `src/server/agents/config.js` `RUNTIMES` | Turns an agent profile into an adapter (`adapters.js`) |
| Team | `src/server/agents/team.js` | One dispatcher per agent working on the open doc, sharing one turn |
| Pass | The thread's `passed` (SPEC §2.2) | Agents with Auto Commenter that left the thread's open ask to others; emptied by the human's next ask |

Any number of agents may have Auto Commenter, none included (then a comment
needs an @mention to be answered), and any agent can be deleted. Until the
user changes it, the roster is the five built-ins. An agent saved as the old
single pilot (`role: "pilot"`) comes back with Auto Commenter on.

Membership is in the sidecar so it travels with the doc: a collaborator who
opens it sees the same agents in the header. An agent in the doc that none of
your agents matches (someone else's, or one driven by a chat session through
`opendoc wait`) shows greyed out as "not here", with Set up and Remove.

## Who answers what (SPEC §5)

- A comment that mentions no one (an **open ask**) goes to every agent with
  Auto Commenter. Each run gets it marked `"open": true` and the instruction to
  answer only if it fits its persona and no earlier reply already does what it
  asks. An agent that leaves it without a reply has passed: the dispatcher
  records it in the thread's `passed` (SPEC §2.2), where a failure to reply to
  a comment addressed to it would take it offline. The open ask is then out
  of that agent's inbox until the human asks again in the thread.
- A comment that mentions agents waits on each of them until each replied.
- A reply that mentions no one continues with the agent that answered last in
  that thread.
- Agents do not wake each other: only human messages ask for work, so two
  agents cannot loop.

Every agent with Auto Commenter looks at every open ask, so each one costs a run
per agent; deciding that a comment does not fit is a short run, but not a
free one. The runs take turns, so an agent that comes second sees the first
one's reply and can leave the comment to it.

## Permissions in a run

A permission that is on is in the run's command line; one that is off is
not, so the tools are never there to misuse:

- Claude Code: `--allowedTools` holds `Read` of the doc (`Read` anywhere with
  File Searcher, which also starts the run in the doc's folder instead of a
  private one), `Edit` of the doc with Auto Editor, and `WebSearch` and
  `WebFetch` with Web Searcher. `--permission-mode dontAsk` denies the rest,
  and the deny rules for secrets (`.env*`, keys, `~/.ssh`) win over any
  allow. With Auto Editor, a PreToolUse hook on `Edit` runs `opendoc guard`,
  which refuses an edit where the human is typing.
- Codex: the doc is writable in its permission profile only with Auto
  Editor; Web Searcher sets `web_search="live"`. Codex reads the whole disk,
  so it has no File Searcher.
- Every runtime: the prompt says what the agent may do (edit, propose, or
  only reply; the web; the human's files).

A change to a permission other than Auto Commenter restarts the agent once its
run in progress ends; switching Auto Commenter only changes which comments it
answers. Agents from `serve` flags (`--edit-mode`, `--agent-web`,
`--agent-read-files`) show their permissions read-only.

## Taking turns

The agents of a doc share a `Floor` (`dispatcher.js`): only one runs at a
time; the others wait in state `queued` ("waiting for its turn") and look
again when the turn is released. This keeps the existing guarantees exact
with several agents: what changed on disk during a run is that run's edit
(recorded on its reply, undoable), the version history names the right agent,
and the human's typing is merged against one agent's change at a time. The
cost is latency when several agents have work; edits by parallel agents would
need per-run attribution of concurrent file changes first.

## Runtimes

A runtime is an entry in `RUNTIMES` that builds an adapter from an agent:

```js
codex: {
  label: 'Codex',
  adapter: (agent, { codexBin }) => codexAdapter({ bin: codexBin ?? undefined, agentName: agent.name, model: agent.model ?? undefined }),
},
```

An adapter (see the top of `adapters.js`) says how to check the program
(`preflight`), the command line for a run (`command`), where it runs
(`workdir`), what to set up there before each run (`prepare`), and how to
read the result (`parse`). The dispatcher hands every
runtime the same prompt (`buildPrompt`: the task, the persona, the other
agents in the doc, the rules) and the same JSON threads, and the agent acts
through the `opendoc` CLI, so a new runtime needs no changes to the
dispatcher, the persona, or the page. Add its name to `RUNTIMES` in
`src/core/agents.js` and a button under "Runs on" in the Agents panel (Advanced).

Each Claude Code or Codex agent gets its own private working folder per doc
(`privateWorkdir(doc, name)`) and its own resumed session, so agents do not
share memory.

| | Claude Code (`claude`) | Codex (`codex`) |
| --- | --- | --- |
| Run | `claude -p <prompt> --output-format json` | `codex exec --json … <prompt>`; the threads JSON on stdin arrives as a `<stdin>` block |
| Skill | `--append-system-prompt-file` | `-c developer_instructions=<skill as a TOML string>` |
| Found | `PATH`, `~/.local/bin`, the desktop app's copy, or Settings (`claudeBin`) | `PATH` (on Windows the native `codex.exe` inside the npm package, since `codex.cmd` cannot be spawned without a shell), or Settings (`codexBin`) |
| Config | The user's, unless isolated (`--bare`) | `--ignore-user-config`: a `sandbox_mode` there would switch the profile off, and its MCP servers and plugins run outside the sandbox. Only its `model` and `[windows] sandbox` carry over |
| Preflight | `claude auth status` → `loggedIn` | `codex login status` exits 0 (or `CODEX_API_KEY` is set) |
| Access | Permission rules: `Read` of the doc (anywhere with File Searcher), `Edit` of the doc with Auto Editor, `opendoc` commands, secrets denied | A permission profile (`default_permissions="opendoc"`) that `prepare` writes to the private folder's `.codex/config.toml`, a trusted project config: in the doc's folder every file but the doc (read-only without Auto Editor) and its sidecar is denied; `.env*`, `*.pem`, `*.key` in the folders above, `~/.ssh`, `~/.aws` and `~/.codex` are denied; no network; `approval_policy="never"` |
| Web | `WebSearch`, `WebFetch` with Web Searcher | `-c web_search="live"` with Web Searcher (else `"disabled"`) |
| Resume | `--resume <session_id>` | `codex exec … resume <thread_id> <prompt>` (from `thread.started`) |
| Result | Last JSON line: `is_error`, cost, turns, denials | JSONL events: `turn.completed` is success; `turn.failed`/`error` give the reason |
| Limits | Model, turns, minutes, runs per hour, budget, isolated | Model, minutes, runs per hour |

The edit guard (refusing an edit where the human is typing) is a Claude Code
hook; a Codex run only gets the prompt's note about where the human is typing.

What a Codex run can touch (checked against Codex 0.162 on Windows):

- `opendoc` runs inside the sandbox. Codex never lifts a profile that denies
  reads, not even for commands its rules allow, so `opendoc reply` has to lock
  and replace the sidecar from inside it. Grants cover only files that exist,
  and the lock and temp files are new, so the doc's folder is writable and
  each file already in it is denied by name.
- So, unlike a Claude run, a Codex run can read files elsewhere on the disk
  (Codex's elevated Windows sandbox refuses a profile that does not let it
  read the whole disk), read a file added next to the doc during the run,
  create files in the doc's folder, and replace (not read) a file there by
  renaming another one over it. That also means turning Auto Editor off stops edits but not
  a deliberate rename over the doc.
- On Windows the profile needs Codex's `elevated` sandbox (set up once by
  Codex) or `windows.sandbox = "mxc"`; `unelevated` refuses it. The elevated
  sandbox's setup fails while the Codex desktop app holds its own runtime
  open ("setup refresh had errors"), for every Codex sandbox, not only
  opendoc's; `mxc` is not affected.

## API

| Request | Does |
| --- | --- |
| `POST /api/ops` (a comment) | Agents it @mentions that are not in the doc join first; the answer includes `agents` then |
| `POST /api/agents/invite { id }` | Add one of your agents to the doc (People panel) |
| `POST /api/agents/remove { name }` | Stop it here (ending its run) and `leave`; not one with Auto Commenter |
| `POST /api/roster { agent, invite? }` | New agent (not its program); optionally add it here |
| `PUT /api/roster { id, patch }` | Change an agent, a permission switch included (`permissionPatch`); a rename moves its membership in this doc |
| `POST /api/roster/delete { id }` | Delete an agent; it leaves this doc |
| `POST /api/agent { name, action: "retry" }` | Try an offline agent again |
| `POST /api/guard { tool, oldString }` (guard token) | From `opendoc guard` before an edit: is the human typing there? Answers `{ allow, reason? }` |
| `GET /api/agent?name=` | Status and last run log |
| SSE `agents` | Every agent's status, on any change |

An agent's program (`command`, and `claudeBin` or `codexBin` for all Claude
or Codex agents) is set
only in the desktop app, which asks the user to confirm it, or in
`settings.json`; the page can only clear it.

## Not yet

- File Searcher kept to chosen folders.
- Permissions per doc (an agent that may edit one doc and only suggest in another), as Docs roles are per file.
- Muting Auto Commenter in one thread.
- A cheaper first look for Auto Commenter (one small model deciding who an open comment fits) instead of a run per agent.

- Agents asking each other (an agent's @mention waking another agent), with a
  loop guard.
- Parallel runs for agents that only propose.
- Per-agent caret colours in the text (avatars already differ).
- Codex agents: reads outside the doc are not confined (Codex reads the disk), so File Searcher is not offered for them.
- More runtimes: OpenAI-compatible local models.
- Codex: replies posted by the dispatcher from the run's final message
  (`--output-schema`), so the doc's folder need not be writable and turning Auto Editor off
  holds against renames; the edit guard as a Codex hook.
