# Agent Config

An agent is the CLI that does a buddy's work (Claude Code, Codex, any
other), started by a script. Ponjo runs the script and knows nothing
else about it.

## The contract

An agent is a filter ([architecture](architecture.md#a-run)):

| | |
| --- | --- |
| Working folder | new and private; holds only copies of the doc and its sidecar, under their names |
| stdin | the prompt: who the buddy is, the thread, the rules |
| `PONJO_DOC` | the doc copy's path |
| `PONJO_COMMENTS` | the sidecar copy's path |
| `PONJO_PROJECT` | the run's own copy of the project (see [Permissions](#permissions)); empty in doc mode |
| `PONJO_BUDDY` | the buddy's name |
| `PONJO_SETTING_<KEY>` | each of the agent's [settings](#settings) |
| stdout | the reply; may be empty |
| Exit 0 | success; the app merges the doc copy's edits into the doc and adds the appended comments. Otherwise the reply is marked `failed`, with the end of the output. |

The program needs no Ponjo tool: it reads files, edits them and prints.

## Comments

The sidecar copy holds every thread of the doc
([SPEC](../spec/SPEC.md)). To comment, the agent appends lines; the
app fills in `id`, `by` and `at`.

| Line | Makes |
| --- | --- |
| `{"anchor":{"exact":"…"},"body":"…"}` | a thread on that text |
| `{"body":"…"}` | a thread on the whole doc |
| `{"thread":"c_…","body":"…"}` | a reply in that thread |
| `{"thread":"c_…","resolved":true}` | the run's reply resolves its thread; only the thread the run answers |

- `exact` quotes the doc copy as the agent left it, as written in the file
  (markup included), and must be found exactly once (any run of whitespace
  may stand for another); the app makes the rest of the anchor. Otherwise
  the thread is on the whole doc.
- Any other change to the copy is ignored: changed or removed lines,
  `resolved` on another thread, lines that are not valid.

The rules on stdin tell the agent to comment only where the user has
something to decide, to resolve only when asked to, and not to repeat in its reply what the app shows: its
edits and comments.

## Agents

An agent is a plugin: a **manifest** says what can be set, a
**program** does the work. Settings live apart from both, so a program can be
replaced (Reset to Default, a new version) without losing them.

| In `agents/` of the config folder | |
| --- | --- |
| `<name>` (`<name>.cmd` on Windows) | the program, under the contract above |
| `<name>.json` | its manifest: `{ name, about, settings }`; optional |

- The config folder is `~/Library/Application Support/Ponjo/` on macOS.
  Never in a project: a shared folder must not decide what runs here.
- Claude Code, Codex and the [Ponjo agent](ponjo-agent.md) ship, written
  when missing. A newer version replaces one you have not edited
  (`agents/.shipped.json` holds the hash of what was written); once edited,
  it is yours. Reset to Default writes one again.
- An agent without a manifest is shown by its file name, with no settings.
- One agent runs every buddy: Settings > Agents lists them, one picked. The
  picked one shows the fields of its manifest under it, and for a shipped
  agent, Reset to Default. To give one buddy another program, branch on
  `PONJO_BUDDY` in it.

### Settings

`settings` is an ordered list of fields, as a view's
([architecture](architecture.md#views)), with two more types:

| `type` | Holds | Stored |
| --- | --- | --- |
| `switch`, `choice`, `number` | as for a view | `settings.json`: `agents: { <name>: { <key>: value } }` |
| `text` | a line of text, such as a model | the same |
| `secret` | an API key | encrypted with the system keychain (Electron `safeStorage`), in the config folder; never in `settings.json` or a log, and shown only by its last 4 characters |

A key is lower case letters, digits and `_`. Only the app's main process
can decrypt a secret; it hands the secrets to the doc host, which runs the
agents. A manifest that is not valid
is ignored, as if there were none. A run gets each field as
`PONJO_SETTING_<KEY>` (`model` → `PONJO_SETTING_MODEL`): the stored
value or the default, a secret decrypted, empty when there is none. A shell
script needs nothing to read them:

```sh
#!/bin/sh
exec claude -p "@\"$PONJO_DOC\"" --permission-mode acceptEdits --no-session-persistence \
  ${PONJO_SETTING_MODEL:+--model "$PONJO_SETTING_MODEL"} \
  ${PONJO_PROJECT:+--add-dir "$PONJO_PROJECT" --disallowedTools "Edit(/$PONJO_PROJECT/**)"}
```

`@"…"` attaches the doc copy to the prompt as already read, so Claude Code
edits it without first spending a round trip to read it. The Windows script
does not do this yet.

## Permissions

Ponjo sets only what the contract needs: the working folder, the copy,
a copy of the project in project mode. The script makes the run unattended
and lets it edit the copy. The shipped scripts keep the project read only:
an edit there would skip the merge, the receipt and Undo.

The mirror is a copy of what the project shows to everyone on it
(ProjectService: no name starting with `.`, no link out of the project),
without `node_modules` and holding only text files of 20 MB or less. It is
in the config folder, brought up to date before each run by size and
mtime, and each run gets a clone of it of its own, gone when the run
ends, with copy-on-write clones where the file system has them. So what a
run reads never changes while it works, and what it writes there reaches
no one. What an agent reads can land in a doc teammates read, so the
agent is never told the real project folder. That fully limits Claude Code, which reads only
its working folder and the `--add-dir` it is given. Codex is not
sandboxed: its `workspace-write` sandbox reads the whole disk, and the
copy only keeps the real path from it.

Everything else (web, shell, which files it may read or write) is the CLI's
own config (`~/.claude/settings.json`, `~/.codex/config.toml`), as when you
run it yourself. Ponjo neither grants nor blocks it.

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
