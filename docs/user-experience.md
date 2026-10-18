# User Experience

How a person writes with buddies in OpenDoc. For why, see the
[product vision](product-vision.md); for how it is built, see
[architecture](architecture.md).

## The basic loop

1. **Open a doc.** Any `.md` file: File > Open, a double-click in the OS,
   or a drag onto the app. Each doc gets its own window. The home page
   opens a **project** (a folder, or a new one made in the dialog) with its
   files in a sidebar, and lists the recent ones.
2. **Write.** A WYSIWYG editor over plain markdown. Saving is automatic and
   keeps the bytes of every block you did not touch, so `git diff` stays clean.
3. **Comment.** Select text and click the comment button at the page edge
   (Ctrl+Alt+M). The comment sits in the margin beside its text and follows
   it as the text changes.
4. **A buddy answers.** `@Clippy` in a comment asks Clippy. It edits the doc,
   may comment on other passages, and replies in the thread.
5. **You decide.** Keep the edit, undo it from the reply, reply again, or
   resolve the thread. Only people resolve threads.

## Buddies

A buddy is someone you @mention: a name and who it is, in one markdown file,
`<Name>.md`. The file name is its name; its text, given to its agent as is,
says who it is, and the first line shows next to its name.

- **Clippy**, a general writing assistant, answers in every doc. Who it is
  is yours to change, once for all your docs (`buddies/Clippy.md` in your
  config folder); clear it for Clippy as it ships. Its name stays, and it
  cannot be deleted.
- **A project's** buddies live in its `.opendoc/buddies/` and travel with the
  folder (commit them). They answer only in that project's docs.
- A doc opened on its own (from Finder, say) reaches only Clippy, even if it
  sits inside a project folder.
- Each buddy has its own face and color, the same on every machine: Clippy
  is yellow, and up to seven project buddies get seven other colors.

A card is who someone is; the Buddies list is who is here. Click a face for
its card: a buddy's name edits in place (not Clippy's), and who it is is a
field right under it, saved when you leave it. Your own card edits your name,
which can be no buddy's here. The **Buddies** list (the button after the
faces) has every buddy here, each opening its card; in a project, a
buddy's trash icon deletes it, and **New buddy** is a name to type: Enter
makes it and opens its card.
Editing the files by hand works too: the app picks up changes at once.

What runs every buddy is the agent picked in Settings > Agent (Claude Code or
Codex): a script in `agents/` in your config folder that you may edit (see
[agent config](agent-config.md)).

## Who answers what

- Only your own comments ask. A comment that @mentions a buddy asks only
  it. One that mentions no one asks the thread's buddies: the one that
  opened it, and each you @mentioned there. A comment you write while a
  buddy works asks it again once it replies. To stop, resolve the thread:
  its buddies stop at once, and nothing they did lands. Reopening asks no
  one. A buddy's reply asks no one, and neither does an `@name` typed in
  the doc's text.
- A comment that mentions several buddies asks each of them; they work at
  the same time.
- Every run starts fresh with the doc, who the buddy is and the thread. Nothing
  is remembered in private; anything worth keeping is written in the doc or
  the thread.

## Buddies always edit, and every edit can be undone

- A buddy edits a copy of the doc; when it is done, its changes are merged
  into the doc as it is then, at once, and shown as a revision: new text in
  its color, removed text grey and struck through where it was, until you
  type, press Escape or another run's edits land.
- A buddy comments as you do: on any passage, or in any thread. It cannot
  resolve. Its comments ask no one.
- Under its reply the app shows how many places the run edited; clicking
  it shows them in the text again (and scrolls to them), clicking again
  hides them. Edits changed since are left out. The reply only says why,
  or what you need to decide, and may be empty.
- **Your text wins.** Where you changed the same text while it worked, yours
  stays, its change there is dropped, and its reply says so. @mention it
  again to redo it.
- **Undo** on the reply takes the run's edits back, all at once, keeping
  everything written since; where you or another buddy changed its text
  since, that text stays. Its comments stay. It works on the computer that
  ran the buddy.
- **Cmd+Z** (Ctrl+Z) undoes only your own typing, never a buddy's edit.
- **A failed run** replies with the end of its output, marked failed.
  @mention the buddy again to retry.

## Seeing buddies work

- **Presence.** People's avatars are circles; each buddy's is a soft blob
  with a face. They sit side by side in the header. A buddy's face shows its
  state wherever it appears: while it works it grows and its body rolls,
  where it cannot answer it is greyed out, and when a run fails it shakes
  and flashes red once.
- **Buddies** button (after the avatars): the Buddies list.

## Around the doc

- **Version history** (clock button, Ctrl+Alt+Shift+H): every version with
  who made it (you, a buddy and the comment it answered, or a program
  outside OpenDoc), a diff against the one before, and Restore. A version is
  saved before and after each buddy edit, before each change from outside
  OpenDoc, and for each undo and restore, so any of them can be restored.
  History is kept in the config folder, never next to the doc.
- **Changes from outside** (a `git pull`, another editor) show up live and
  merge with your typing. Where they overlap what you are typing, your typing
  stays and their version is in history.
- **Settings** (name, theme, font, width, outline, word count, focus mode,
  agent) are the same dialog in every window, the home page too, and a
  change applies at once to all of them. Buddies are not in Settings: they
  are changed on their cards.
- **Files.** New Doc and Rename (the comments move too). Opening an already
  open doc focuses its window. If the file is moved or deleted outside the
  app, a banner says so and saving pauses.
- **A project's sidebar** shows every file and folder as it is on disk
  (`.git`, `.DS_Store` and comment files aside), each folder read as you open
  it. A doc opens in the editor; any other file shows read only in its place
  (Escape goes back). Its menu, the same for every row: New File (in a
  folder; `/` in the name makes folders), Rename (F2), Copy Path (relative
  to the project, as buddies read it), Reveal, and Delete (to the Trash).
  Drag a row onto a folder to move it. A
  file's comments go with it when it is renamed, moved or deleted here.
- **Comments** are in `X.md.opendoc.jsonl` next to the doc, one per line, so
  they merge in git ([format](../spec/SPEC.md)). Moving a doc outside the app,
  move this file with it. A sidecar from OpenDoc 1
  (`X.md.opendoc.json`) is not read; a banner says so and the file is left
  as it is.
