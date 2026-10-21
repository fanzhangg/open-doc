# Agent Config

An agent is the CLI that does a buddy's work (Claude Code, Codex, any
other), started by a script. OpenDoc runs the script and knows nothing
else about it.

## The contract

An agent is a filter ([architecture](architecture.md#a-run)):

| | |
| --- | --- |
| Working folder | new and private; holds only copies of the doc and its sidecar, under their names |
| stdin | the prompt: who the buddy is, the thread, the rules |
| `OPENDOC_DOC` | the doc copy's path |
| `OPENDOC_COMMENTS` | the sidecar copy's path |
| `OPENDOC_PROJECT` | the project folder; empty in doc mode |
| `OPENDOC_BUDDY` | the buddy's name |
| `OPENDOC_SETTING_<KEY>` | each of the agent's [settings](#settings) (*planned*) |
| stdout | the reply; may be empty |
| Exit 0 | success; the app merges the doc copy's edits into the doc and adds the appended comments. Otherwise the reply is marked `failed`, with the end of the output. |

The program needs no OpenDoc tool: it reads files, edits them and prints.

## Comments

The sidecar copy holds every thread of the doc
([SPEC](../spec/SPEC.md)). To comment, the agent appends lines; the
app fills in `id`, `by` and `at`.

| Line | Makes |
| --- | --- |
| `{"anchor":{"exact":"…"},"body":"…"}` | a thread on that text |
| `{"body":"…"}` | a thread on the whole doc |
| `{"thread":"c_…","body":"…"}` | a reply in that thread |

- `exact` quotes the doc copy as the agent left it, as written in the file
  (markup included), and must be found exactly once (any run of whitespace
  may stand for another); the app makes the rest of the anchor. Otherwise
  the thread is on the whole doc.
- Any other change to the copy is ignored: changed or removed lines,
  `resolved`, lines that are not valid.

The rules on stdin tell the agent to comment only where the user has
something to decide, and not to repeat in its reply what the app shows: its
edits and comments.

## Agents

*Planned.* An agent is a plugin: a **manifest** says what can be set, a
**program** does the work. Settings live apart from both, so a program can be
replaced (Reset to Default, a new version) without losing them.

| In `agents/` of the config folder | |
| --- | --- |
| `<name>` (`<name>.cmd` on Windows) | the program, under the contract above |
| `<name>.json` | its manifest: `{ name, about, settings }`; optional |

- The config folder is `~/Library/Application Support/OpenDoc/` on macOS.
  Never in a project: a shared folder must not decide what runs here.
- Claude Code, Codex and the [OpenDoc agent](opendoc-agent.md) ship, written
  once when missing; then they are yours. Reset to Default writes one again.
- An agent without a manifest is shown by its file name, with no settings.
- One agent runs every buddy; Settings > Agents picks which, and each agent
  with a manifest has its own page there, as a view does in Settings > Views.
  To give one buddy another program, branch on `OPENDOC_BUDDY` in it.

### Settings

`settings` is an ordered list of fields, as a view's
([architecture](architecture.md#views-and-rules)), with two more types:

| `type` | Holds | Stored |
| --- | --- | --- |
| `switch`, `choice`, `number` | as for a view | `settings.json`: `agents: { <name>: { <key>: value } }` |
| `text` | a line of text, such as a model | the same |
| `secret` | an API key | encrypted with the system keychain (Electron `safeStorage`), in the config folder; never in `settings.json` or a log, and shown only as set or not |

A run gets each field as `OPENDOC_SETTING_<KEY>` (`model` →
`OPENDOC_SETTING_MODEL`): the stored value or the default, a secret
decrypted. A shell script needs nothing to read them:

```sh
#!/bin/sh
exec claude -p "@\"$OPENDOC_DOC\"" --permission-mode acceptEdits --no-session-persistence \
  ${OPENDOC_SETTING_MODEL:+--model "$OPENDOC_SETTING_MODEL"} \
  ${OPENDOC_PROJECT:+--add-dir "$OPENDOC_PROJECT" --disallowedTools "Edit(/$OPENDOC_PROJECT/**)"}
```

`@"…"` attaches the doc copy to the prompt as already read, so Claude Code
edits it without first spending a round trip to read it. The Windows script
does not do this yet.

## Permissions

OpenDoc sets only what the contract needs: the working folder, the copy,
the project folder in project mode. The script makes the run unattended and
lets it edit the copy. The shipped scripts keep the project read only: its
files are the user's, and an edit there would skip the merge, the receipt
and Undo.

Everything else (web, shell, which files it may read or write) is the CLI's
own config (`~/.claude/settings.json`, `~/.codex/config.toml`), as when you
run it yourself. OpenDoc neither grants nor blocks it.

An agent is not told where the real doc is. If its CLI lets it write there
anyway, the app sees an outside change and merges it; a broken sidecar line
is skipped, and history keeps every version.

What a prompt hidden in a doc can make an agent do is what your CLI's
config allows.

## Errors

A run that does not exit 0 is answered with a reply marked `failed`: the
end of the program's own output, as is, and the script that ran, to run
yourself. To retry, @mention the buddy again.

## Open

- Check the shipped scripts on macOS, Windows and Linux; Codex's needs
  `--output-last-message` to print only its reply.
