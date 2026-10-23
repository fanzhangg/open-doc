# Ponjo buddies and projects

A **buddy** is someone you @mention in a doc: a name and who it is, in a
markdown file. What does the work is an agent CLI
(Claude Code, Codex) chosen on each machine
([agent config](../docs/agent-config.md)); a buddy only says who it is.

The **user's** buddies are in `buddies/` in their config folder and in
every doc. A **project's** buddies are in its `.ponjo/buddies/`, in its
docs only, and travel with it.
A doc's comments are not here; they stay in its sidecar ([SPEC](SPEC.md)).

## 1. Projects

A **project** is a folder opened from the app's home page.

```
.ponjo/
  buddies/
    <Name>.md
```

- Only the opened folder's own `.ponjo/` counts, not one above or below it.
- `.ponjo/` is created when the first buddy is added. It holds nothing
  machine-local: all of it may be committed.

## 2. Buddy files

`<Name>.md`:

- **The file name is the buddy's name.** It starts with a letter
  or digit, then letters, digits, `.`, `_`, `-`; unique in its folder,
  compared case-insensitively. Renaming the file renames the buddy.
- **Its id is a line at the top of the file**, `id: b_…` between two `---`
  lines, made when the buddy is created and kept when it is renamed. The
  app finds a buddy, its comments and its face by the id; the name is only
  what it is called. A file without one is a buddy whose id is its name;
  renaming it in the app writes its old name as its id. Move or copy the
  file whole, id included.
- **The text says who it is**, given to its agent as is, without the id
  lines. The first line shows next to its name: on its card and in the @ menu.

```markdown
Checks every claim against the code.

Read the project before you answer. Quote the file and line you rely on.
```

A doc reaches the user's buddies and, in a project, the project's; a
project's buddy wins over one of the user's with its name. A buddy's face
is made from its id. Its color is one of eight, evenly apart in hue: the
one its id picks or, when a buddy before it by id has that one, the next
free one. So up to eight buddies in a doc look different, and the same
buddies look the same on every machine.

The app's first run, when the config folder has no `buddies/`, writes
the user's first buddy, `Clippy.md`, a general writing assistant whose id
is `Clippy`. Then it is the user's like any other.

## 3. What a buddy may do

It edits the doc it answers in, and comments there as a human does, but
cannot resolve; each run's edits can be undone. On the machine, it
does whatever its agent CLI's own config allows; Ponjo only tells it
where the project folder is
([agent config](../docs/agent-config.md#permissions)).
