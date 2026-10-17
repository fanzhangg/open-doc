# Agent Config

An agent is the CLI that does a buddy's work (Claude Code, Codex, any
other), started by a script. OpenDoc runs the script and knows nothing
else about it.

## The contract

An agent is a filter ([architecture](architecture.md#a-run)):

| | |
| --- | --- |
| Working folder | new and private; holds only copies of the doc and its sidecar, under their names |
| stdin | the prompt: the buddy's persona and instructions, the thread, the rules |
| `OPENDOC_DOC` | the doc copy's path |
| `OPENDOC_COMMENTS` | the sidecar copy's path |
| `OPENDOC_PROJECT` | the project folder; empty in doc mode |
| `OPENDOC_BUDDY` | the buddy's name |
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

- `exact` quotes the doc copy as the agent left it, without markdown marks,
  and must be found exactly once; the app makes the rest of the anchor.
  Otherwise the thread is on the whole doc.
- Any other change to the copy is ignored: changed or removed lines,
  `resolved`, lines that are not valid.

The rules on stdin tell the agent to comment only where the user has
something to decide, and not to repeat in its reply what the app shows: its
edits and comments.

## Agent scripts

- In `agents/` of the config folder
  (`~/Library/Application Support/OpenDoc/agents/` on macOS): `<name>` on
  macOS and Linux, `<name>.cmd` on Windows. Never in a project: a shared
  folder must not decide what runs here.
- Claude Code and Codex ship as two, written once when missing; then they
  are yours. Reset to Default writes one again.
- One agent runs every buddy; Settings picks which. To give one buddy
  another program, branch on `OPENDOC_BUDDY` in the script.
- Everything about the program (model, flags, cleaning up its output) is in
  the script:

```sh
#!/bin/sh
exec claude -p --permission-mode acceptEdits --no-session-persistence \
  ${OPENDOC_PROJECT:+--add-dir "$OPENDOC_PROJECT"}
```

## Permissions

OpenDoc sets only what the contract needs: the working folder, the copy,
the project folder in project mode. The script makes the run unattended and
lets it edit the copy.

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
