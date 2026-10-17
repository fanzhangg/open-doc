# opendoc buddies and projects — version 2 (draft)

A **buddy** is someone you @mention in a doc: a name, a persona and
instructions, in a markdown file. What does the work is an agent CLI
(Claude Code, Codex) chosen on each machine
([agent config](../docs/agent-config.md)); a buddy only says who it is.

The user's buddies live in the config folder's `buddies/`; a project's live
in its `.opendoc/buddies/` and travel with it. A doc's comments are not
here; they stay in its sidecar ([SPEC v2](SPEC-v2.md)).

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
  compared case-insensitively. Renaming the file renames the buddy.
- **The first line is its persona**, shown in the @ menu.
- **The rest is its instructions.**

```markdown
Checks every claim against the code.

Read the project before you answer. Quote the file and line you rely on.
```

A doc reaches the user's buddies and, in a project, the project's. When
both have a name, the project's buddy gets it. A buddy's avatar is made
from its name, so everyone sees the same face.

## 3. What a buddy may do

It edits the doc it answers in; each edit can be undone. On the machine, it
does whatever its agent CLI's own config allows; OpenDoc only tells it
where the project folder is
([agent config](../docs/agent-config.md#permissions)).
