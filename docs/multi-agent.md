# Agents as collaborators

Status: built. Supersedes the single "AI co-author" of Settings > Agent
described in `desktop-app.md`.

## The idea

An agent is a collaborator, set up and treated like a person in a shared doc:

- It has an **identity**: a name you @mention, an avatar with its own colour,
  a **slogan** of a few words that says what it is for, and a status (Ready,
  Working…, Waiting for its turn, Offline).
- It has a **persona**: instructions in the human's words for who it is and how
  it works ("a strict copy editor; fix grammar only").
- It has a **role**. The **pilot** is in every doc and answers every comment
  not addressed to someone else, so a comment never goes unanswered.
  **Co-pilots** are specialists that answer only when @mentioned; mentioning
  one brings it into the doc, as mentioning a person in Google Docs shares the
  doc with them.
- It has **permissions**, as narrow as its job. Can edit or Can suggest is a
  fixed role in the doc. Web and Your files are risky, so they are **asked
  for at first use**: the profile says which of them the agent may ask for,
  and the human answers when a run first needs one (see "Permissions at first
  use"). Only humans resolve threads.

The app comes with five agents, named in parody of the Office Assistants:

| Agent | Slogan | Role | Can edit / suggest | Web (asks) | Your files (asks) |
| --- | --- | --- | --- | --- | --- |
| Clippy | Your all-round co-author | Pilot | Can edit | ✓ | |
| Rocky | Sniffs out grammar slips | Co-pilot | Can edit | | |
| Will | Makes your prose sing | Co-pilot | Can suggest | | |
| Genius | Checks every fact | Co-pilot | Can suggest | ✓ | |
| Merlin | Finds it in your files | Co-pilot | Can suggest | | ✓ |

No built-in agent may ask for both Web and Your files: an agent that reads
your files could be tricked by a web page into sending them out. Turning both
on in Settings asks for confirmation, and a request for one while the agent
holds the other carries a warning. Only the grammar fixer and the pilot edit
directly; the others suggest.

The persona and identity are decoupled from what executes the agent: the
**runtime**. Today an agent runs on Claude Code (`claude -p`), on OpenAI
Codex (`codex exec`) or on any command line; a local open model is one more
runtime.

## What the UX borrows, and from where

Researched Oct 2026 (ChatGPT GPT mentions and group chats, Grok agents,
Microsoft Copilot agents in Word, Gemini Gems in Docs, Notion custom agents,
Slack agents, VS Code chat participants and tool approval, Poe multi-bot
chat, Google Docs and Figma sharing, Android permissions):

| Pattern | From | Here |
| --- | --- | --- |
| `@` summons a bot mid-conversation, picker shows recent ones with a description | ChatGPT GPT mentions, Poe, Slack, Copilot in Word | `@` menu grouped *Co-pilots in this doc* / *Bring in (joins this doc)* / *People*, each with slogan and permission chips; matches names, and slogans from two letters ("@gram" finds Rocky) |
| A default assistant that speaks without being called | ChatGPT in group chats | The pilot; it is left out of the `@` menu since it answers anyway |
| Mentioning someone without access offers to share | Google Docs | Mentioning a co-pilot brings it in; the line under the comment box says so before you post |
| A share panel listing people with roles | Google Docs, Figma, Notion | People panel: you (Owner), the pilot, co-pilots with Remove, co-pilots to add |
| Roles in the doc's own words | Google Docs Editor / Suggesting | Can edit / Can suggest |
| Agents get their own, narrow access | Notion custom agents, Android least privilege | Per-agent permissions; greyed chips show what an agent may not do, outlined ones what it asks for first |
| Risky access is asked for when first needed, with a scope, and can be revoked | Android runtime permissions (Only this time / While using / Don't allow), VS Code tool approval (Allow once / in this session / in this workspace / always) | A card in the thread: Allow once (this reply), Allow in this doc, Always, Deny (this reply); grants listed with Revoke |
| Agents are labelled as apps | Slack | `AI` badge, Pilot / Co-pilot pill |
| Who will answer is visible before sending | (gap in most products) | "Clippy will reply", "Genius will reply · Genius (Can suggest · Web) joins this doc" |

Where the research and this design differ: the research suggested plain job
titles for names; the agents keep fun names, with the slogan carrying the job.

## Model

| Concept | Where it lives | What it is |
| --- | --- | --- |
| Agent (profile) | User settings, `agents[]` (`src/core/agents.js`) | `id`, `name`, `role`, `tagline` (slogan), `persona`, `runtime`, `editMode`, `webAccess`, `fileAccess`, limits, `command` |
| Membership | The doc's sidecar, `participants` | The pilot joins every doc it opens; a co-pilot joins when @mentioned or added; `leave` (SPEC §6) removes it |
| Runtime | `src/server/agents/config.js` `RUNTIMES` | Turns an agent profile into an adapter (`adapters.js`) |
| Team | `src/server/agents/team.js` | One dispatcher per agent working on the open doc, sharing one turn |
| Grant | User settings, `grants[]` (`src/core/grants.js`) | `id`, `agent` (the agent's id), `permission` (`web`, `files`), `doc` (absolute path, or null for every doc), `folder` (files only, or null), `at` |
| Request | Server memory (`src/server/agents/permissions.js`) | A run's tool call waiting on the human; Allow once and Deny are kept on the run itself |

A roster always has exactly one pilot; making another agent the pilot makes
the old one a co-pilot, and the pilot cannot be deleted. Until the user
changes it, the roster is the five built-ins; a roster with no pilot gets
Clippy back.

Membership is in the sidecar so it travels with the doc: a collaborator who
opens it sees the same agents in the header. An agent in the doc that none of
your agents matches (someone else's, or one driven by a chat session through
`opendoc wait`) shows greyed out as "not here", with Set up and Remove.

## Who answers what (SPEC §5)

- A comment that mentions no one goes to the pilot (co-pilots leave it alone).
- A comment that mentions agents waits on each of them until each replied.
- A reply that mentions no one continues with the agent that answered last in
  that thread, pilot or co-pilot.
- Agents do not wake each other: only human messages ask for work, so two
  agents cannot loop.

## Permissions at first use

Researched against Android runtime permissions and VS Code's tool approval:
ask in context, when the access is first needed, with a choice of how long a
yes lasts, and one place to take it back.

The agent's profile (`webAccess`, `fileAccess` in `src/core/agents.js`) is
its manifest: what it may ask for. Off, the run never gets the tools at all.
On, a Claude Code run gets them only through the human:

1. The tools (`WebSearch`, `WebFetch`; `Read`, `Glob`, `Grep` beyond the doc)
   stay out of `--allowedTools`. A PreToolUse hook on them runs
   `opendoc guard`, which posts the tool call to the server's `/api/guard`
   with the agent's own guard token (one per agent, so a request names its
   agent and a run cannot act as another).
2. The server (`Permissions.decide`) answers at once when it can: the doc
   itself or the run's working folder (left to the run's rules); a permit
   from earlier in this run (Allow once, Deny); a grant that covers it (this
   agent, this permission, this doc or every doc, for files within its folder).
3. Otherwise it adds a request (who, what, which file or query, the run's
   threads, a warning when the agent holds the other risky permission) and
   sends the list to the page (SSE `permissions`). The card appears in the
   first thread of the run: Allow once, Allow in this doc, Always, Deny, and
   for files "Only files in <folder>" (on by default). Parallel calls of the
   same kind share one card.
4. The hook waits. The answer becomes a permit on the run (once, deny) or a
   grant in the settings (in this doc, always). No answer within
   `ASK_TIMEOUT_MS` (5 min) is a Deny; a run that is stopped ends the wait.
   The model reads why a call was denied, and the prompt asks it to say in its
   reply what it needed.

It fails closed. Verified with Claude Code 2.1.300 in `--permission-mode
dontAsk`: a hook's `allow` lets through a tool that is not in
`--allowedTools`; a hook that crashes, cannot reach the server or times out
leaves it denied; and the deny rules for secrets (`.env*`, keys, `~/.ssh`)
win over the hook, which is not even asked about them. The hook's own timeout
is longer than the server's wait, so the model learns the reason.

Grants are listed with Revoke in the People panel (**Access you allowed**) and
in the agent's card (**Beyond this doc**). Deleting an agent deletes its
grants; renaming the doc moves its "in this doc" grants along. The page cannot
write grants through settings, only answer requests, revoke, or allow in
advance.

A **Codex** run cannot ask mid-run (no hook), so a Codex agent that may ask
for the web searches only with a grant given in advance: its card offers
Allow in this doc / Always, and the grant restarts it with `web_search="live"`.
A **custom command** may ask the same way a Claude run does, by running
`opendoc guard` with a hook-style request on stdin (as `test/fixtures/fake-agent.js`
does in mode `ask`). Agents from `serve` flags (`--agent-web`,
`--agent-read-files`) have their access granted outright on the command line.

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
`src/core/agents.js` and a button under "Runs on" in Settings > Agents.

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
| Access | Permission rules: `Read`/`Edit` of the doc only, `opendoc` commands, secrets denied; web and file tools through the `opendoc guard` hook, which asks the human | A permission profile (`default_permissions="opendoc"`) that `prepare` writes to the private folder's `.codex/config.toml`, a trusted project config: in the doc's folder every file but the doc (read-only in Ask first) and its sidecar is denied; `.env*`, `*.pem`, `*.key` in the folders above, `~/.ssh`, `~/.aws` and `~/.codex` are denied; no network; `approval_policy="never"` |
| Web | `WebSearch`, `WebFetch`, asked for at first use | `-c web_search="live"` once allowed in advance (else `"disabled"`) |
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
  renaming another one over it. That also means Ask first stops edits but not
  a deliberate rename over the doc.
- On Windows the profile needs Codex's `elevated` sandbox (set up once by
  Codex) or `windows.sandbox = "mxc"`; `unelevated` refuses it. The elevated
  sandbox's setup fails while the Codex desktop app holds its own runtime
  open ("setup refresh had errors"), for every Codex sandbox, not only
  opendoc's; `mxc` is not affected.

## API

| Request | Does |
| --- | --- |
| `POST /api/ops` (a comment) | Co-pilots it @mentions that are not in the doc join first; the answer includes `agents` then |
| `POST /api/agents/invite { id }` | Add one of your co-pilots to the doc (People panel) |
| `POST /api/agents/remove { name }` | Stop it here (ending its run) and `leave`; not the pilot |
| `POST /api/roster { agent, invite? }` | New co-pilot (not its program); optionally add it here |
| `PUT /api/roster { id, patch }` | Change an agent (`role: "pilot"` hands over the pilot); a rename moves its membership in this doc |
| `POST /api/roster/delete { id }` | Delete an agent (not the pilot); it leaves this doc |
| `POST /api/agent { name, action: "retry" }` | Try an offline agent again |
| `POST /api/guard { tool, input }` (guard token) | From `opendoc guard`: an edit (is the human typing there?) or a tool that needs a permission; may wait for the human. Answers `{ decision: allow \| deny \| null, reason }` |
| `POST /api/permissions/answer { id, answer, folderOnly }` | The human's answer: `once`, `doc`, `always` or `deny` |
| `POST /api/grants { agentId, permission, scope }` | Allow before it asks (`doc` or `always`), only what its profile may ask for |
| `POST /api/grants/revoke { id }` | Take a grant back |
| `GET /api/agent?name=` | Status and last run log |
| SSE `agents` | Every agent's status, on any change |
| SSE `permissions`, `grants` | The requests waiting on the human; the grants that hold in this doc (also in `GET /api/state`) |

An agent's program (`command`, and `claudeBin` or `codexBin` for all Claude
or Codex agents) is set
only in the desktop app, which asks the user to confirm it, or in
`settings.json`; the page can only clear it.

## Not yet

- Picking folders for Your files up front; today a grant can be kept to the folder of the file the agent first asked for.
- Codex agents asking mid-run (a Codex hook), and the page showing requests from agents run elsewhere (`opendoc wait`).
- Roles per doc (an agent that may edit one doc and only suggest in another), as Docs roles are per file.
- Muting the pilot in one thread.

- Agents asking each other (an agent's @mention waking another agent), with a
  loop guard.
- Parallel runs for agents that only propose.
- Per-agent caret colours in the text (avatars already differ).
- Codex agents: reads outside the doc are not confined (Codex reads the disk), so Your files is not offered for them.
- More runtimes: OpenAI-compatible local models.
- Codex: replies posted by the dispatcher from the run's final message
  (`--output-schema`), so the doc's folder need not be writable and Ask first
  holds against renames; the edit guard as a Codex hook.
