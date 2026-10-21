# Ponjo Agent

An agent of our own, run like Claude Code and Codex: a script in
`agents/` under the same [contract](agent-config.md#the-contract). Inside,
an LLM reads and proposes; the program checks and applies.

Claude Code and Codex are black boxes (their prompts, shell and web tools,
permissions, start-up time) for work that is narrow: read, comment, edit
text. Our own loop for only that is small enough to read whole, and runs a
cloud model of your choice. Local models are not a goal for now: the ones a
laptop runs (an 8B model tried) claim edits they did not make.

## Principles

1. **Read and propose, never write.** The model's only effect is a
   proposal; the program checks it and applies it to the copies.
2. **The tools are the permissions.** `read` and `propose` only: no shell,
   no network but the model's API. Text a teammate wrote can at worst make an undoable proposal.
3. **Stateless.** A turn remembers nothing after. Within it, all state is
   the messages, and their log replays it.
4. **The model asks for context.** The first message is small; the model
   reads what it needs.
5. **Read by line number, write by quote.** Never count characters.

## Interfaces

| Interface | Called by |
| --- | --- |
| `turn({ prompt, doc, sidecar }, { infer, readFile }) → { edits, reply }` | the program's `main` |
| `infer(messages, tools) → { calls: [{ id, name, args }], sent }` | `turn`, for each step |
| `read`, `propose` | the model, as tools |

**`main`** is all the I/O, and all of the contract: it reads the prompt on
stdin, the paths in `OPENDOC_DOC`, `OPENDOC_COMMENTS` and `OPENDOC_PROJECT`
and its settings in `OPENDOC_SETTING_*`, calls `turn`, applies the edits to
the copies, prints the reply and exits 0. A run without a key fails at once,
saying where to set it.

**`turn`** is one buddy answering one thread, with no I/O of its own: it
thinks, and checks what it proposes. `prompt` is stdin as is; `doc` and
`sidecar` are the copies' paths. It throws when the turn fails.

**`readFile(path)`** gives a file's text, a folder's entries, or null, and
is all the turn can see: the copies, and in project mode the project's files
(inside the folder, not starting with `.`, sidecars included).

**`infer`** is one step of the model, one implementation per provider,
over plain HTTP (the program runs from the config folder, with no
dependencies). `turn` keeps the messages in one neutral form (the prompt,
each step's calls with the model's message as its API sent it, and each
call's result), and each `infer` translates them:

| `provider` | API | Its own |
| --- | --- | --- |
| `anthropic` | Messages (`/v1/messages`) | `output_config.effort`, the model thinking as it needs; its messages sent back as they came, thinking included; prompt caching of the tools and the prompt; a refusal or a cut-off answer fails the turn |
| `openai` | Chat Completions at `endpoint` (OpenAI, OpenRouter and others) | `reasoning_effort` |

Both send `tool_choice: "auto"`: current Claude models refuse a forced tool
call, and a reply without one is sent back anyway.

**`read({ path, lines? })`** returns the text with line numbers, from line
`lines[0]` to `lines[1]`. A file over 20,000 characters without `lines`
returns its outline instead (Markdown headings with their line ranges); a
folder, its files.

**`propose({ edits: [{ path, old, new }], reply })`** ends the turn. On the
doc, `old` must be found exactly once. On its sidecar, `old` is empty and
`new` appends comment lines ([agent config](agent-config.md#comments)). Any
other path is refused. One bad edit sends the whole proposal back, saying
what to fix. `reply` is printed, and may be empty.

## The loop

```
step(messages, budget):
  call = infer(messages, tools)
  if call is a valid propose: return its args
  if budget is 0: fail
  return step(messages + call + result(call), budget - 1)
```

The first message is the prompt, as is: its rules are every agent's. The
tools match the contract it describes: `propose` edits the doc and appends
to the sidecar, and its `reply` is what the prompt says to print. Twenty
steps, and the turn fails.

## Architecture

```mermaid
flowchart LR
  runner["Runner"] -- "the contract" --> main["main<br>agents/opendoc"]
  main --> turn["turn()"]
  turn -- "infer" --> api["Anthropic or<br>OpenAI-compatible API"]
  turn -- "readFile" --> files["the copies, the project"]
```

- **Shipped, then the user's,** like the other scripts: theirs to read,
  change, or rewrite in any language that keeps the contract.
- **Its settings** are in its [manifest](agent-config.md#agents), not in
  the program:

| Key | Type | Default |
| --- | --- | --- |
| `provider` | choice: Anthropic, OpenAI-compatible | `anthropic` |
| `endpoint` | text, for OpenAI-compatible only | `https://api.openai.com/v1` |
| `model` | text | `claude-opus-5-5` |
| `key` | secret | none: a run without one fails, saying where to set it |
| `effort` | choice: low, medium, high | `low`: scoped edits; higher thinks longer before it answers |

- **Tests** call `turn` with a fake `infer`, and each `infer` on a fake
  server of its API.
- **Each turn's messages are logged** to a file the script names.

## Open questions

- A step waits for the whole answer, at most 16,000 tokens, with no
  streaming: Node's `fetch` gives up on a reply that takes over five
  minutes to start, which a high effort could reach.
- No fallback model when Anthropic's safeguards refuse: the turn fails,
  saying so.
- Later: `search`, if models spend steps finding things; web access, off by
  default, the one tool that could send a doc out.
