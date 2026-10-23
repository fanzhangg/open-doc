# User Experience

How people and AI buddies write together in Ponjo. For why, see the
[product vision](product-vision.md); for how it is built, see
[architecture](architecture.md).

## Teammates

A project is written by its team at the same time. Everyone on it
is the **owner** (you), a **teammate** (another person) or an **AI buddy**,
and in a doc they are alike: a face and a unique name, each edits and
comments, can be @mentioned, and is named wherever the doc says who did
something.

- **Teammates** are the friends in the project's room while you host it
  (Sharing a project). They are trusted:
  one who can **Edit** does in a doc whatever you do (edit, comment,
  resolve, ask AI buddies); one who can only **Read** sees it all and
  changes nothing.
- **AI buddies** are a name and who it is, in one markdown file. An agent on
  your computer does their work, when asked. They edit, comment and
  resolve as whoever asked them may, and resolve a thread only when asked to.
- Only you rename, move, delete or create files, and change settings, AI
  buddies and agents.

The **Team** button (after the faces) opens the panel: in a project, **Open
room** or, once it is open, the room's link and **Lock** and **Close room**;
You, the room's players, then the AI buddies, ending with **New AI
buddy** (it starts with a random first name, which you can type over: Enter
makes it and opens its card). Click a face anywhere for its card: a name that
edits in place (yours, or an AI buddy's; a renamed AI buddy
keeps its comments, face and color), for an AI buddy who it is, a field right
under it saved when you leave it, then Read or Edit for a teammate. A teammate has **Kick**;
an AI buddy has a delete button (its file is deleted). In a doc
opened on its own the panel has only you and your AI buddies, and a new
one is yours; on a teammate's page, only the owner changes the team and the
AI buddies.

## The basic loop

1. **Open a doc.** Any `.md` file: File > Open, a double-click in the OS,
   or a drag onto the app. Each doc gets its own window. The home page
   opens a **project** (a folder, or a new one made in the dialog) with its
   files in a sidebar, and lists the recent ones. A doc opened on its own is a
   quick editor for you and your AI buddies: no team, no sharing.
2. **Write.** A WYSIWYG editor over plain markdown. Saving is automatic and
   keeps the bytes of every block you did not touch, so `git diff` stays clean.
   Any other text file (code, config, notes) opens as plain text, and
   comments and AI buddies work the same there. The WYSIWYG editor is a
   view (see Views below): switched off, Markdown opens as plain text too.
   A doc too long to write in smoothly in a view opens in the next one, and
   says so in a banner: past 100,000 characters (or a paragraph past
   10,000), Markdown opens as plain text, and the banner offers the Markdown
   view anyway, warning that typing may lag; past 5,000,000, any doc opens
   read-only.
3. **Comment.** Select text and click the comment button at the page edge
   (Ctrl+Alt+M). The comment sits in the margin beside its text and follows
   it as the text changes.
4. **Someone answers.** A person replies in the thread. `@Clippy` in a
   comment asks the AI buddy Clippy: it edits the doc, may comment on other
   passages, and replies in the thread.
5. **Anyone allowed decides.** Keep the edit, undo it from the reply, reply
   again, or resolve the thread, whoever asked and whoever answered.

## Sharing a project

Sharing is hosting a room, as for an online game. In a project window,
**Open room** in the Team panel gives a link; **Copy link** copies it.
Whoever opens it, in a browser with no install and no account, picks a
name once (one already on the project gets a number: `Alice2`) and is in
at once, at Edit, on the project's first doc, with the project's sidebar:
the same tree you see, where a click opens any doc in it (another file
shows read only) and nothing can be renamed, moved, deleted or made.
Which folders are open, and whether the sidebar shows, are kept in their
browser.

The panel lists who is in, live. For each you pick Read or Edit, or
**Kick**: their pages close and that browser cannot come back to this
room. **Lock** lets no one new in, once everyone is: those in can still
come back after a dropped line. **Close room**, or closing the project,
ends the room at once: every page is cleared and says only "The host
closed the room". The next room has a new link; an old one never works
again. Nothing about who was in is kept.

A page turned away says why: the room closed, kicked, the room locked, a
doc not in the project, a name the project never shares (starting with
`.`, or out of it). A teammate who can only read sees no tool that would
be refused: no formatting, no reply box, Resolve, Undo or Restore.

Your computer is the host, so the room is there only while it is awake
and the project is open. A teammate whose line drops goes read only at
once and says so; what they typed that had not reached you is shown as
they left it, to copy, and never sent later. Their page reconnects by
itself and, caught up, edits again (after a reload, if it shows such
typing).

## AI buddies

An AI buddy is a name and who it is, in one markdown file, `<Name>.md`. The
file name is its name; its text, given to its agent as is, says who it is,
and the first line shows next to its name.

- **Yours** live in `buddies/` in your config folder and answer in every
  doc. The first run makes one, **Clippy**, a general writing assistant;
  rename, change or delete it like any other.
- **A project's** AI buddies live in its `.ponjo/buddies/` and travel with
  the folder (commit them). They answer only in that project's docs, and
  win over one of yours with the same name.
- A doc opened on its own (from Finder, say) reaches only yours, even if it
  sits inside a project folder.
- Each has its own face and color, the same on every machine with the same
  AI buddies: up to eight in a doc get eight colors.

Editing the files by hand works too: the app picks up changes at once. What
runs every AI buddy is the agent picked in Settings > Agents (Claude Code,
Codex, or the Ponjo agent, which runs a cloud model you pick): a
program in `agents/` in your config folder that you may edit (see
[agent config](agent-config.md)). The one picked shows its settings there,
under it (a model, an API key), kept apart from its program; an API key
shows only its last 4 characters.

## Who asks whom

- `@name` in a comment asks that AI buddy.
- A reply with no `@` asks the AI buddies already in its **thread**: a first
  comment on a passage and the replies under it.
- Resolving a thread stops its AI buddies at once, and nothing they did
  lands. Reopening asks no one.
- Only people's comments ask: yours, and a teammate's who can edit. A
  turn acts as whoever asked it may when it ends: if they were removed or
  set to Read meanwhile, nothing it did lands. An AI buddy's reply asks no one, and neither does an `@name`
  typed in the doc's text.
- A comment that reached the file from outside Ponjo (a `git pull`, another
  editor, another computer) asks no one.
- A comment that mentions several AI buddies asks each; they work at once.
- Every run starts fresh with the doc, who the AI buddy is, who asked and the
  thread. Nothing is remembered in private; anything worth keeping is written
  in the doc or the thread.

## Everyone edits, and every edit can be undone

- A person's typing lands in the doc as they type. An AI buddy edits a copy
  of the doc; when it is done, its changes are merged into the doc as it is
  then, at once, and shown as a revision: new text in its color, removed text
  grey and struck through where it was, until you type, press Escape or
  another run's edits land.
- An AI buddy comments as people do: on any passage, or in any thread. It
  resolves the thread it answers when asked to ("…and resolve"). Its
  comments ask no one.
- Under its reply the app shows how many places the run edited; clicking
  it shows them in the text again (and scrolls to them), clicking again
  hides them. Edits changed since are left out. The reply only says why,
  or what you need to decide, and may be empty.
- **Nothing a person types is lost.** When two people change the same place
  at once, both edits stay, in the order they reached the host. Text one
  deletes while the other types inside it keeps what was typed. If both
  replace the same word, both new words stay, to fix by hand.
- **A person's typing is trusted.** It is not marked by who typed it, and
  when two people disagree they settle it outside the app, in a call.
- **People win over AI buddies.** Where a person changed the same lines
  while an AI buddy worked, the buddy does its turn once more on the doc as
  it is then, told what changed. If it collides again, the person's lines
  stay, the rest of its change lands, and its reply says part of it was not
  applied: @mention it again to redo it. A change from outside merges the
  same way, without the second try.
- **Undo is one thing**, for your typing, an AI buddy's run, a teammate's
  change or one from outside: it takes those edits back, all at once, and
  keeps everything written since; where someone changed those lines since,
  their lines stay. **Cmd+Z** (Ctrl+Z) undoes your own typing, never anyone
  else's. **Undo** on an AI buddy's reply undoes its run; its comments stay.
  **Undo this change** in history undoes any version, or a burst of typing.
  It works in every window of the team.
- **A failed run** replies with the end of its output, marked failed.
  @mention the AI buddy again to retry.

## Seeing teammates work

- **Presence.** People's avatars are circles; each AI buddy's is a soft blob
  with a face. They sit side by side in the header: the people in the doc
  with you, then the AI buddies. A face shows its state wherever it
  appears, the same for everyone: while an AI buddy works it grows and its
  body rolls, where an AI buddy cannot answer or a person is away (not in
  the project now) it is greyed out, and when a run fails it shakes and
  flashes red once. No dots or badges. In the Team panel you see which
  teammates are here; a teammate sees who is here with them.
- **Cursor.** Every teammate in the doc has a cursor in their color, with
  their name beside it while they work or type; otherwise it is a plain line.
  A person's stands where they are typing. An AI buddy asked to work stays
  in the doc until it is closed or the AI buddy is gone: at the passage it was
  asked about, and at the end of its last edit when its run lands. A cursor
  follows the text as it changes, and is hidden where its text is gone. It is
  only drawn: never in the file, and it takes no clicks.

## Around the doc

- **Find and replace** (Ctrl+F; Ctrl+Alt+F with Replace), in every view and
  in history: what a reader sees, every match marked, Enter for the next.
  Replacing is your own edit, undone with Ctrl+Z.
- **Version history** (clock button, Ctrl+Alt+Shift+H): every version with
  who made it (you, a teammate, both when you typed together, an AI buddy
  with the comment it answered, or a program outside Ponjo), a diff against the one before, Undo this change and
  Restore. A version is saved each time typing pauses (a burst of typing
  shows as one), before and after each buddy edit, before each change from
  outside Ponjo, and for each undo and restore, so any of them can be undone
  or restored.
  History is kept in the config folder, never next to the doc.
- **Changes from outside** (a `git pull`, another editor) show up live and
  merge with your typing, line by line. Where they changed a line you
  changed too, your line stays and their version is in history.
- **Settings** (name and theme, views, shortcuts, agent) are
  the same dialog in every window, the home page too (it has no Views:
  those come with a doc), and a change applies at once to all of
  them. How a doc looks and what its editor offers are its view's
  settings, not global ones. Buddies are not in Settings: they are changed
  on their cards.
- **Views.** A doc has a **view**, its editor, switched on or off in
  Settings > Views (it lists the views with their files, what they do and
  whether they are on; a view's page has its switch and its own settings).
  Every text file opens in the Plain text view (always on) unless a view
  gives its format a WYSIWYG editor; the built-in one is for Markdown and on
  by default. How changes merge is the same in every view.
  The **Markdown view** ([design](markdown-view.md)): its toolbar, outline and focus mode (Ctrl+Shift+F)
  are part of it. The toolbar formats, and so do the standard keys (Mod+B,
  Mod+I, Mod+E, Mod+Shift+X, Mod+K); typed Markdown such as `## `, `**x**`
  or `- ` stays text (saved escaped). To write Markdown by hand, switch the
  view off (Ctrl+Shift+T, again to switch back); `.md` then opens in the plain
  editor. Pasted plain text stays text too; pasted formatted text keeps
  its formatting.
  The plain editor's settings: line numbers, wrapping, font size, whitespace
  marks (in the selection, everywhere or off) and indent guides, and
  indentation: Tab types the file's indent (found from the file, or tabs or
  spaces as set), Tab and Shift+Tab indent and outdent selected lines, and
  Enter keeps the line's indent; it has a status bar with the caret's line
  and column, the size of the selection, the indent Tab types (a menu of
  others, for what you type next, never the file) and Wrap and Whitespace
  toggles that change the same settings. The Markdown view's: the page's font
  and width, Outline, Focus mode and Word count (shown in its toolbar).
  Switching a view applies at once to every open doc: a Markdown doc turns to
  plain text and back, comments still in the margin, and nothing is written.
- **Files.** New Doc and Rename (the comments move too). Opening an already
  open doc focuses its window. If the file is moved or deleted outside the
  app, a banner says so and saving pauses.
- **A project's sidebar** shows every file and folder as it is on disk,
  except names starting with `.` and comment files, each folder read as you
  open it. What git ignores (build output, installed packages) is dimmed,
  and the filter leaves it out. Everyone on the team sees the same tree. A
  doc opens in the editor; any other file shows read only in its place
  (Escape goes back).
  Its menu, the same for every row and only yours: New File (in a folder; `/`
  in the name makes folders), Rename (F2), Copy Path (relative to the
  project, as AI buddies read it), Reveal, and Delete (to the Trash). Drag a
  row onto a folder to move it. A file's comments go with it when it is
  renamed, moved or deleted here.
- **Comments** are in `X.md.comments.jsonl` next to the doc, one per line, so
  they merge in git ([format](../spec/SPEC.md)). Moving a doc outside the app,
  move this file with it.
