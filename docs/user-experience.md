# User Experience

How people and AI buddies write together in OpenDoc. For why, see the
[product vision](product-vision.md); for how it is built, see
[architecture](architecture.md). What is marked *planned* is designed, not
built: today one person writes with AI buddies.

## Teammates

*Planned.* A project is written by its team at the same time. Everyone on it
is the **owner** (you), a **teammate** (another person) or an **AI buddy**,
and in a doc they are alike: a face and a unique name, each edits and
comments, can be @mentioned, and is named wherever the doc says who did
something.

- **Teammates** are the people you share the project with. They are trusted:
  one who can **Edit** does in a doc whatever you do (edit, comment,
  resolve, ask AI buddies); one who can only **Read** sees it all and
  changes nothing.
- **AI buddies** are a name and who it is, in one markdown file. An agent on
  your computer does their work, when asked. They always edit and comment;
  each resolves only if you turn its switch on.
- Only you rename, move, delete or create files, and change settings, AI
  buddies and agents.

The **Team** button (after the faces) opens the panel: You, your Teammates (a
request to join waits at the top), then the AI buddies, ending with **New AI
buddy** (it starts with a random first name, which you can type over: Enter
makes it and opens its card). Click a face anywhere for its card: a name that
edits in place (yours, or an AI buddy's but not Clippy's; a renamed AI buddy
keeps its comments, face and color), for an AI buddy who it is, a field right
under it saved when you leave it, then Read or Edit for a teammate, Resolve
for an AI buddy. A teammate and an AI buddy each have **Remove from this
project** (an AI buddy's file is deleted; Clippy stays). Today the panel is
the **Buddies** list: the AI buddies, their cards and New AI buddy.

## The basic loop

1. **Open a doc.** Any `.md` file: File > Open, a double-click in the OS,
   or a drag onto the app. Each doc gets its own window. The home page
   opens a **project** (a folder, or a new one made in the dialog) with its
   files in a sidebar, and lists the recent ones. A doc opened on its own is a
   quick editor for you and Clippy: no team, no sharing.
2. **Write.** A WYSIWYG editor over plain markdown. Saving is automatic and
   keeps the bytes of every block you did not touch, so `git diff` stays clean.
   Any other text file (code, config, notes) opens as plain text, and
   comments and AI buddies work the same there. The WYSIWYG editor is a
   view (see Views and rules below): switched off, Markdown opens as plain text too.
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

*Planned.* **Invite link**, in the Team panel, gives one link for the
project, permanent until you make a new one. Whoever opens it, in a browser
with no install and no account, picks a name (not one already on the
project) and waits. You get a notification; in the Team panel you pick Read
or Edit (Edit to start) and **Allow**, or **Deny**. That is only the first
time: then they see what you see, the file tree and every doc in the
project. A new link ends every old one; **Remove** ends one person.

Your computer is the host, so the project is there only while it is awake and
the app is open. The app keeps the computer awake while teammates are in. A
teammate whose host is away sees whom it is waiting for, and is back in the
doc by itself when the host returns, keeping what they typed meanwhile.

## AI buddies

An AI buddy is a name and who it is, in one markdown file, `<Name>.md`. The
file name is its name; its text, given to its agent as is, says who it is,
and the first line shows next to its name.

- **Clippy**, a general writing assistant, answers in every doc. Who it is
  is yours to change, once for all your docs (`buddies/Clippy.md` in your
  config folder); clear it for Clippy as it ships. Its name stays, and it
  cannot be removed.
- **A project's** AI buddies live in its `.opendoc/buddies/` and travel with
  the folder (commit them). They answer only in that project's docs.
- A doc opened on its own (from Finder, say) reaches only Clippy, even if it
  sits inside a project folder.
- Each has its own face and color, the same on every machine: Clippy is
  yellow, and up to seven project AI buddies get seven other colors.

Editing the files by hand works too: the app picks up changes at once. What
runs every AI buddy is the agent picked in Settings > Agent (Claude Code,
Codex, or the OpenDoc agent, which runs any model, a local one included): a
script in `agents/` in your config folder that you may edit (see
[agent config](agent-config.md)).

## Who asks whom

- `@name` in a comment asks that AI buddy.
- A reply with no `@` asks the AI buddies already in its **thread**: a first
  comment on a passage and the replies under it.
- Resolving a thread stops its AI buddies at once, and nothing they did
  lands. Reopening asks no one.
- Only people's comments ask: yours, and a teammate's who can edit
  (*planned*). An AI buddy's reply asks no one, and neither does an `@name`
  typed in the doc's text.
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
  resolves only if the owner allows it. Its comments ask no one.
- Under its reply the app shows how many places the run edited; clicking
  it shows them in the text again (and scrolls to them), clicking again
  hides them. Edits changed since are left out. The reply only says why,
  or what you need to decide, and may be empty.
- **Nothing a person types is lost** (*planned*). When two people change the same place
  at once, both edits stay, in the order they reached the host. Text one
  deletes while the other types inside it keeps what was typed. If both
  replace the same word, both new words stay, to fix by hand.
- **A person's typing is trusted** (*planned*). It is not marked by who typed it, and
  when two people disagree they settle it outside the app, in a call.
- **People win over AI buddies.** Where a person changed the same text while
  an AI buddy worked (or a change came from outside), theirs stays, the
  other change there is dropped, and an AI buddy's reply says so. @mention it
  again to redo it.
- **Undo is one thing**, for your typing and for an AI buddy's run: it takes
  those edits back, all at once, and keeps everything written since; where
  someone changed that text since, their text stays. **Cmd+Z** (Ctrl+Z)
  undoes your own typing, never anyone else's. **Undo** on an AI buddy's
  reply undoes its run; its comments stay. Today it works on the computer
  that ran the AI buddy; *planned*, in every window.
- **A failed run** replies with the end of its output, marked failed.
  @mention the AI buddy again to retry.

## Seeing teammates work

- **Presence.** People's avatars are circles; each AI buddy's is a soft blob
  with a face. They sit side by side in the header. A face shows its state
  wherever it appears, the same for everyone: while an AI buddy works it
  grows and its body rolls, where an AI buddy cannot answer or a person is
  offline it is greyed out, and when a run fails it shakes and flashes red
  once. No dots or badges.
- **Cursor.** Every teammate in the doc (people: *planned*) has a cursor in their color, with
  their name beside it while they work or type; otherwise it is a plain line.
  A person's stands where they are typing. An AI buddy asked to work stays
  in the doc until it is closed or the AI buddy is gone: at the passage it was
  asked about, and at the end of its last edit when its run lands. A cursor
  follows the text as it changes, and is hidden where its text is gone. It is
  only drawn: never in the file, and it takes no clicks.

## Around the doc

- **Version history** (clock button, Ctrl+Alt+Shift+H): every version with
  who made it (a teammate, an AI buddy with the comment it answered, or a
  program outside OpenDoc), a diff against the one before, and Restore. A version is
  saved before and after each buddy edit, before each change from outside
  OpenDoc, and for each undo and restore, so any of them can be restored.
  History is kept in the config folder, never next to the doc.
- **Changes from outside** (a `git pull`, another editor) show up live and
  merge with your typing. Where they overlap what you are typing, your typing
  stays and their version is in history.
- **Settings** (name and theme, views, rules, shortcuts, agent) are
  the same dialog in every window, the home page too (it has no Views or
  Rules: those come with a doc), and a change applies at once to all of
  them. How a doc looks and what its editor offers are its view's
  settings, not global ones. Buddies are not in Settings: they are changed
  on their cards.
- **Views and rules.** A doc has a **view**, its editor, and **rules**, how
  changes to it are merged. They are separate, and each is switched on or off
  alone in Settings > Views and Settings > Rules (each lists its items with
  their files, what they do and whether they are on; an item's page has its
  switch and, for a view, its own settings). Every text file opens in the
  Plain text view (always on) unless a view gives its format a WYSIWYG
  editor, and merges changes as plain text unless a rule gives it rules of its
  own. Both built-in ones are for Markdown and on by default.
  The **Markdown view** ([design](markdown-view.md)): its toolbar, outline and focus mode (Ctrl+Shift+F)
  are part of it. The toolbar is the only way to format: typed Markdown such
  as `## `, `**x**` or `- ` stays text (saved escaped), and the only
  shortcuts are Undo, Redo and Comment. To write Markdown by hand, switch the
  view off (Ctrl+Shift+T, again to switch back); `.md` then opens in the plain
  editor. Pasted Markdown is still
  formatted.
  The **Markdown rule**: a buddy's edit or a change from outside merges
  into a line you changed too only where that keeps how the line renders;
  where it would not, your text stays, as when you both change the same
  words. It applies whatever view the doc is in.
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
  Switching a rule applies from the next merge.
- **Files.** New Doc and Rename (the comments move too). Opening an already
  open doc focuses its window. If the file is moved or deleted outside the
  app, a banner says so and saving pauses.
- **A project's sidebar** shows every file and folder as it is on disk,
  except names starting with `.` and comment files, each folder read as you
  open it. Everyone on the team sees the same tree. A doc opens in the
  editor; any other file shows read only in its place (Escape goes back).
  Its menu, the same for every row and only yours: New File (in a folder; `/`
  in the name makes folders), Rename (F2), Copy Path (relative to the
  project, as AI buddies read it), Reveal, and Delete (to the Trash). Drag a
  row onto a folder to move it. A file's comments go with it when it is
  renamed, moved or deleted here.
- **Comments** are in `X.md.opendoc.jsonl` next to the doc, one per line, so
  they merge in git ([format](../spec/SPEC.md)). Moving a doc outside the app,
  move this file with it. A sidecar from OpenDoc 1
  (`X.md.opendoc.json`) is not read; a banner says so and the file is left
  as it is.
