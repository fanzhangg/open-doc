# opendoc buddies and projects

A **buddy** is someone you @mention in a doc: a name, a persona and
instructions, in a markdown file. What does the work is an agent CLI
(Claude Code, Codex) chosen on each machine
([agent config](../docs/agent-config.md)); a buddy only says who it is.

**Clippy** is built into the app and is in every doc. Every other buddy
belongs to a project, lives in its `.opendoc/buddies/` and travels with it.
A doc's comments are not here; they stay in its sidecar ([SPEC](SPEC.md)).

## 1. Projects

A **project** is a folder opened from the app's home page.

```
.opendoc/
  buddies/
    <Name>.md
```

- Only the opened folder's own `.opendoc/` counts, not one above or below it.
- `.opendoc/` is created when the first buddy is added. It holds nothing
  machine-local: all of it may be committed.

## 2. Buddy files

`<Name>.md`:

- **The file name is the buddy's name and its id.** It starts with a letter
  or digit, then letters, digits, `.`, `_`, `-`; unique in its folder,
  compared case-insensitively; not `Clippy`. Renaming the file renames
  the buddy.
- **The first line is its persona**, shown in the @ menu.
- **The rest is its instructions.**

```markdown
Checks every claim against the code.

Read the project before you answer. Quote the file and line you rely on.
```

A doc reaches Clippy and, in a project, the project's buddies. Clippy's
persona, instructions, face and color are the app's and cannot be changed;
its color is the yellow of eight, evenly apart in hue. A project buddy's
face is made from its name. Its color is one of the other seven: the one
its name picks or, when a buddy before it by name has that one, the next
free one. So Clippy and up to seven buddies look different, and a project
looks the same on every machine.

## 3. What a buddy may do

It edits the doc it answers in, and comments there as a human does, but
cannot resolve or delete; each run's edits can be undone. On the machine, it
does whatever its agent CLI's own config allows; OpenDoc only tells it
where the project folder is
([agent config](../docs/agent-config.md#permissions)).
