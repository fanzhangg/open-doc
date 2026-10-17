# File Management in the Sidebar

Light file management in a folder window's sidebar: new doc, new folder,
rename, move and delete, without leaving the tree. Before it, the sidebar
only listed and opened docs; New Doc and Rename lived in the File menu and a
native dialog, which still work. See [user experience](user-experience.md)
for the rest of the app.

## Scope

In: new doc, new folder, rename, move (drag and Move to…), delete, for docs
and folders, in the desktop app's folder window.

Out, for now: multi-select, duplicate, sort options, dragging files in from
Finder or Explorer, and rewriting links in other docs (see
[Later](#later)). The browser (`opendoc serve`) has no sidebar and gets none.

## What others do

| | Obsidian | VS Code | Notion | Finder / Google Drive |
| --- | --- | --- | --- | --- |
| **New** | `+` or Ctrl+N creates `Untitled.md` at once, cursor in the inline title | Inline name field in the tree; nothing exists until Enter. `a/b.md` makes the folder too | New page, named by its title | Finder: `untitled folder` at once, in rename mode |
| **Rename** | F2, the inline title, or the tree; links to it are updated | F2 (Windows), Enter (macOS), inline in the tree | Edit the title | Click the selected name, or Enter |
| **Move** | Drag onto a folder; **Move file to…** opens a folder picker | Drag, with a confirm dialog by default | Drag in the sidebar; **Move to** picker | Drag; Drive: **Move to** picker, then an Undo toast |
| **Delete** | To system Trash (or `.trash`, or permanent), confirm dialog | To Trash, confirm dialog; Ctrl+Z in the tree undoes file operations | To Trash, no confirm | Finder: Trash, Cmd+Z. Drive: Undo toast |

What carries over:

- **Names are edited in place, in the tree.** Nobody uses a dialog for a name.
- **Drag to move, plus a picker for the keyboard.** Obsidian, Notion and
  Drive all pair the drag with a **Move to…** list of folders.
- **Trash, never a permanent delete.** The split is how they guard it:
  Obsidian and VS Code ask first; Finder, Drive and Notion act and offer Undo.
  OpenDoc asks first: getting a doc back from the Trash by hand means finding
  two files (the doc and its sidecar) and putting both back in the right
  folder, so the mistake should be stopped before it happens.
- **Creating `Untitled.md` before it has a name leaves strays.** This repo
  has one right now (`docs/Untitled.md`, empty). VS Code's "name first, then
  create" avoids it.
- **Renames that fix links are loved in Obsidian**, but they change other
  files, which matters more here (see [Later](#later)).

## Principles

1. **A doc and its comments move as one.** Every operation carries the
   sidecar (`plan.md.opendoc.json`), the version history and any open window
   with the doc. The user never sees a sidecar in the tree.
2. **Nothing is created until it is named.** New doc and new folder ask for
   the name first, in the tree.
3. **Delete asks first, then goes to the Trash.** Docs and folders go to the
   system Trash, never deleted for good, after a confirm.
4. **No Undo, no toasts.** Every operation shows its result in the tree
   itself: the renamed or moved row, focused and scrolled into view, or the
   row gone. A move or rename is undone by doing it again the other way;
   a delete is guarded by its confirm instead.
5. **Three ways to everything:** the row's `⋯` button (or right-click), the
   keyboard, and dragging for moves.
6. **The disk is the truth.** The tree redraws from the folder watch, as
   today; a redraw never throws away a name being typed.

## Where the actions are

**Sidebar header.** Next to the folder name, two icon buttons that show on
hover and on focus: **New doc** and **New folder**. Both go in the folder of
the open doc. File > New Doc in This Folder (⌘⌥N / Ctrl+Alt+N) starts the
same name field, in the folder focused in the tree, else the open doc's.

**Each row.** A `⋯` button at the right end on hover or focus, and the same
menu (the OS's own) on right-click or Shift+F10.

| Doc row | Folder row | Blank space below the tree |
| --- | --- | --- |
| Open in New Window | New Doc | New Doc |
| Rename… (F2) | New Folder | New Folder |
| Move to… | Rename… (F2) | |
| Reveal in Finder / Show in Explorer | Move to… | |
| Copy Path | Reveal in Finder / Show in Explorer | |
| — | — | |
| Delete… (Del / ⌘⌫) | Delete… | |

Delete sits last, after a divider, in the text colour of danger.

## New doc

1. A new row appears at the top of the folder's docs (after its subfolders),
   with an empty name field, placeholder **Untitled**. The folder expands if
   it was closed.
2. Type a name. `.md` is added unless it ends in `.md` or `.markdown`.
   A `/` in the name makes the folders too: `notes/kickoff` → `notes/kickoff.md`.
3. **Enter** creates it, opens it in this window and puts the cursor in the
   editor. Enter on an empty field creates the next free `Untitled N.md`, as
   the File menu does.
4. **Escape**, or clicking away while the field is empty, cancels: no file.
   Clicking away with a name typed creates it, as Enter does.

The new doc gets Clippy the first time it opens, as every new doc does.

## New folder

Same field, folder icon, placeholder **New folder**. Enter creates it,
expanded and empty, and immediately offers its first doc: the empty folder
shows one faint row, **No docs yet · New doc**.

This needs one change to the list: today the tree lists only docs, so a
folder without docs never shows. Empty folders (no entries but hidden ones)
show too; folders that hold only other files (`src/`, `images/`) still
don't, so a code repo's tree stays clean.

## Rename

- **F2** on the focused row, or **Rename…** in its menu. The label turns into
  a field with the name selected, extension hidden (`plan`, not `plan.md`);
  `.markdown` stays `.markdown`.
- **Enter** or clicking away saves; **Escape** cancels. An unchanged name does
  nothing; a change of case only (`plan` → `Plan`) works on every disk.
- A `/` in the new name moves it, as in New doc.
- The row moves to its new sorted place, stays focused and is scrolled into
  view.
- Clicking the doc name in the page header keeps its current behaviour; in a
  folder window it could focus the tree row in rename mode instead (open
  question).

**Folders** rename the same way. Every doc inside moves with its comments and
history, and every open window of those docs follows its doc.

**Errors stay in the field** and Enter does nothing until they are fixed: a
small line under it, such as *plan.md is already here* or *Names can't
contain : on Windows*. A leading `.` is refused (hidden docs are not listed,
so the doc would vanish). Clicking away from a name with an error closes the
field unchanged, and the status line says why.

A folder open in a window of its own (opened as a folder, or holding one)
can't be renamed, moved or deleted from another window's sidebar; the
message says so.

## Move

**Drag.** Press on a row and move 4px to start (a click still opens). While
dragging:

- A folder under the pointer highlights as the target. Over the folder
  name in the header, or the blank space below the tree, the target is the
  top of the folder.
- Hovering on a closed folder for 700ms opens it. Near the top or bottom
  edge, the tree scrolls.
- The doc's own folder, the folder itself or one inside it are not targets:
  no highlight, a not-allowed cursor.
- **Escape** cancels.

Dropping moves it. The target folder opens if it was closed, and the moved
row is focused and scrolled into view, so the tree itself shows where it
went.

**Move to…** (the keyboard path). A small popover under the row: a filter
field and the folders, the top of the folder first as **‹folder name›**, the
current one greyed. Type to filter, arrows and Enter to pick, Escape to close.

**A name already at the target** stops the move; nothing is overwritten.
The status line in the header says *archive already has plan.md*, as it
does today when a doc in the sidebar fails to open.

## Delete

Delete always asks first, in a native dialog with **Delete** as the button
and **Cancel** the default (Enter or Escape cancels; the button must be
clicked or tabbed to). It is the same from the menu or from Delete / ⌘⌫ on
the focused row.

**A doc** goes to the system Trash together with its sidecar, so its
comments go too. The dialog says so:

> Delete "plan.md"?
> It and its 3 comments go to the Trash.
> [Cancel] [Delete]

A doc without comments leaves out "and its 3 comments".

**A folder** goes to the Trash whole, with every file in it, including the
ones the tree does not show:

> Delete "archive"?
> Its 12 docs and 5 other files go to the Trash.
> [Cancel] [Delete]

**An agent at work** on the doc (a request in progress) adds a line:
*Clippy is working on plan.md; its work stops.*

Nothing is shown afterwards: the doc leaves the tree, and that is the
feedback. Anything deleted can still be restored from the Trash. The
doc's version history stays in the config folder, as for a doc deleted
outside the app.

## Open windows and the open doc

- **Rename or move the doc this window shows:** the window stays, its
  server follows the doc (as File > Rename does), the header name updates.
- **The same for a doc open in another window:** that window follows too.
- **Delete the doc this window shows:** the window opens its neighbour (the
  next doc below, else above, in the same folder, else the folder's first
  doc). With no other doc to show, the window closes and the start window
  opens.
- **Delete a doc open in another window:** that window closes after its last
  edit is saved, rather than showing the "moved or deleted outside OpenDoc"
  banner, which is for changes made outside the app.

## Keyboard

The tree becomes a real tree (`role="tree"`): one Tab stop, then arrows.

| Key | Action |
| --- | --- |
| ↑ ↓ | Previous / next row |
| → ← | Open / close a folder, or go to its first child / its parent |
| Enter | Open the doc, or open/close the folder |
| F2 | Rename |
| Delete, ⌘⌫ | Delete (asks first) |
| Shift+F10, context-menu key | The row's menu |
| ⌘⌥N / Ctrl+Alt+N | New doc in the focused folder, or the open doc's |

## Later

- **Updating links.** A rename or move breaks relative links to the doc in
  other docs, and its own relative links and images (`![](img/a.png)`) when
  it changes folder. Obsidian rewrites them silently. Here, rewriting other
  docs changes files other people and agents are working in and shows in
  their `git diff`, so it should be offered, not done: after the move, a
  question such as *3 docs link to plan.md. Update the links?*, with the
  updates in the version history. Where that question shows is left for
  then, since the sidebar has no toasts.
- **Multi-select** (Shift- and ⌘-click) for moving and deleting several.
- **Duplicate**, with or without comments.
- **Drag in from Finder/Explorer** to copy a `.md` file into a folder.

## Open questions

- Should clicking the header doc name rename in the tree when the sidebar is
  open, instead of the native dialog?

## How it is built

- The page asks the app over the preload bridge (`desktop/preload.cjs`):
  `folderCreate(parent, name, kind)`, `folderMove(from, kind, to)` (rename
  and move are one operation), `folderTrash(rel, kind)` and
  `folderMenu(rel, kind, x, y)`. Paths are relative to the folder window's
  root; the app (`desktop/main.js`) checks each against its own listing, or
  that a new name stays inside the folder. The confirm before a delete is
  the app's own dialog, so a page cannot delete without it. Menu choices
  that happen in the page (Rename, Move To…, New Doc, New Folder) come back
  as `onFolderCommand`.
- Like every bridge call these need a click or a key press. A drop ends a
  drag, which leaves no user activation in Chromium, so a trusted pointer
  release just before counts too.
- Docs reuse `renameDoc` and `moveHistory`, and move the doc's own agents in
  `settings.json`; an open doc's server does that itself. A folder move is
  one rename of the folder (`moveFolder`); then each open doc's server
  follows its doc (`moveTo(path, { moved: true })`) and each other doc's
  history and agents follow. Trash is Electron's `shell.trashItem`, doc then
  sidecar (`trashDoc`).
- `listDocs` also returns the empty folders; the sidebar draws them.
- While a name is being typed, a redraw of the tree waits for it.
