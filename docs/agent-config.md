# Agent Config

An agent is the CLI that does a buddy's work (Claude Code, Codex, any
other), started by a script. OpenDoc runs the script and knows nothing
else about it.

## The contract

An agent is a filter ([architecture v2](architecture-v2.md#a-run)):

| | |
| --- | --- |
| Working folder | new and private; holds only a copy of the doc, under the doc's name |
| stdin | the prompt: the buddy's persona and instructions, the thread, the rules |
| `OPENDOC_DOC` | the copy's path |
| `OPENDOC_PROJECT` | the project folder; empty in doc mode |
| `OPENDOC_BUDDY` | the buddy's name |
| stdout | the reply |
| Exit 0 | success; the app merges the copy's edits into the doc. Otherwise the reply is marked `failed`, with the end of the output. |

The program needs no OpenDoc tool: it reads a file, edits it and prints.

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
