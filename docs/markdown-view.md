# Markdown view

The editor a `.md` doc opens in: the Markdown file, shown as formatted text.
It is one view ([Views](architecture.md#views)); switched
off, Markdown opens in the plain view as source. What is marked *planned* is
designed, not built.

## Principles

1. **The file is Markdown; the view is a way to see it.** Saving keeps the
   bytes of every block no one changed, so `git diff` shows only real edits.
2. **Format with the toolbar, or its keys.** Typed Markdown is text.
3. **The page is the writer's.** Tools sit at its edges; nothing but the
   text and the marks of others is drawn in it.
4. **Every mark is someone's.** A comment, a revision and a cursor each show
   whose it is, in that teammate's color.
5. **Text in, text out.** The view takes and gives the doc's text, and is
   told in offsets on it what to draw. It knows no one, no file and no rule.

## UX

### Writing

- CommonMark and GFM, as formatted text: headings, paragraphs, lists,
  quotes, code blocks, tables, rules, links, images, bold, italic,
  strikethrough, inline code and task lists, whose boxes tick with a click.
  Emphasis is read the CJK-friendly way: `**熟悉：**直接` is bold.
- **The toolbar** formats, and shows the formatting at the caret: undo and
  redo, the block style (Normal text, headings, code block), bold, italic,
  strikethrough, inline code, lists, quote, divider, table, link. The
  standard keys do the same: Mod+B bold, Mod+I italic, Mod+E inline code,
  Mod+Shift+X strikethrough, Mod+K a link.
- **Typed Markdown stays text**: `**x**`, `## ` or `- ` is what it says, and
  is saved escaped. **Pasted plain text stays text** too, a line a
  paragraph; pasted formatted text (from a web page or another editor)
  keeps its formatting, but not images held in the page itself (`data:`),
  which would put their bytes in the file.
- **Front matter** (YAML between `---` lines at the top) shows as its
  source, muted, typed into as text; nothing formats it.
- **Link definitions** (`[d]: https://…`) are kept as written, and so is
  every reference link (`[docs][d]`) in a block not changed but by typing.
- **Keys:** Undo, Redo, the formatting above, Comment, Find, and focus
  mode (Ctrl+Shift+F). Enter and Tab work in lists and tables; Tab in a
  table's last cell adds a row; in a code block Tab and Shift+Tab indent and
  outdent its lines by the block's own indent; elsewhere Tab stays in the page.
  Delete at the start of a list item deletes forward, as in any text.
- **Lines:** a block style (a heading, a list, a quote or a code block)
  given to a paragraph changes the lines the selection touches, not the rest
  of it: a line break in it (Shift+Enter, or one the file has between two
  lines of a paragraph) splits it there first. A heading is one line each; a
  code block keeps its lines as lines.
- **Links.** At the caret a card says where a link goes: open it, edit it or
  remove it. The link button opens a popover for the URL: Enter applies, an
  empty URL removes, Escape cancels. Pasting a URL over selected text links
  the text. Mod+click opens a link; `#heading` scrolls to that heading in the
  doc.
- **Diagrams.** A ` ```mermaid ` block shows as its diagram. Its source is
  hidden and cannot be typed into; a click selects the whole block, to
  comment on or delete. An AI buddy changes it, asked in a comment.
- Images in the file show; the view does not insert them. One on the web
  (`https:`) loads from there; one at a path comes from the doc host
  (`image`, as a link resolves, only what the project shows), up to 5 MB.
- **Find and replace** (Mod+F; Mod+Alt+F with Replace), as in every view: a
  bar at the page's top right finds what a reader sees, not the markup,
  ignoring case; every match is marked, the current one stronger, with how
  many there are. Enter or Mod+G goes to the next, Shift for the one before;
  Escape closes it and selects the match. Replace and Replace all are the
  person's own edit, undone with Cmd+Z. A view that cannot be edited finds
  only.
- **Right to left:** a block of Hebrew or Arabic runs the way its text starts.

### Reading

The view's settings, on its page in Settings > Views:

- **Page:** font (sans, serif or mono) and width (normal or wide).
- **Outline:** a tick per heading at the left edge; hover for the list,
  click to go.
- **Focus mode:** every block but the caret's fades.
- **Word count**, in the toolbar.

### Others in the doc

- **Comments:** commented text is yellow, the open thread's stronger. A
  bubble over a selection offers Comment.
- **An AI buddy's revision:** when its turn lands, its new text is in its
  color and what it removed is grey and struck through where it was, with
  its name over the change for a moment. It stays until you type, press
  Escape or another turn lands; the count under its reply shows it again.
- **Changes from outside** (`git pull`, another editor) glow for a moment,
  with who made them.
- **Cursors:** an AI buddy's, at the passage it was asked about, with its
  name while it works. A person's, where they type, with their name while
  they move or type.
- **Two people typing:** see [Many writers](#many-writers).

### Earlier versions

History shows a version in a read-only view, diagrams as their source, so a
change in one can be seen.

### Not here

Editing Markdown source (switch the view off: Ctrl+Shift+T), typed shortcuts and a slash
menu (the toolbar and its keys format), inserting images, and who typed which
characters.

## Architecture

### The shape

| Part | File | Does |
| --- | --- | --- |
| Declaration | `web/views/markdown/index.js` | id, extensions, settings; loads the view with the first Markdown doc |
| View | `web/views/markdown/view.js` | the editor; the contract below; marks; text in and out |
| Chrome | `web/views/markdown/chrome.js` | toolbar, bubble, link card and popover, outline, focus mode, word count |
| Schema | `web/markdown-schema.js` | how Markdown parses into the editor's document (Milkdown, ProseMirror) |
| Rendered text | `src/markdown/project.js`, `web/pm-text.js` | what a reader sees, from the source and from the document, each mapped back |
| Splice | `src/markdown/splice.js` | the text to save: changed blocks in the editor's style, the rest as written |
| Blocks | `web/views/markdown/blocks.js` | which top-level blocks differ, and replacing only those |
| Revision | `web/review.js`, `web/marks.js` | edits found in the text now, drawn as a revision |
| Diagrams | `web/diagrams.js` | a mermaid block as its diagram |
| Find | `web/find.js` | the find bar, the same in every view; the view finds and replaces |

### Two texts meet in a third

The source (the file's Markdown) and the editor's document never meet
directly. Both are reduced to the **rendered text**, what a reader sees:
`project.js` from the source, `pm-text.js` from the document, character for
character the same (`test/rendered-text.test.js`). Each keeps a map back:
rendered offset to source offset, rendered offset to document position.
Every mark, the selection and every anchor crosses through it, so the page
speaks only offsets on the source, and the editor only positions in its
document.

### Text in, text out

- **In:** `applyText(text, { by, ops })` parses the text, finds the
  top-level blocks that differ, and changes only those, by the smallest
  step: a block of the same kind from its first to its last differing
  character; one that keeps its text is made the other kind, wrapped (a
  list item, a quote) or split; any other only from the first to the last
  position that differs. It is outside the undo history: the caret stays,
  and the person's own steps map over it. `by` names who made the change,
  for its glow; `ops`, the operations that made it, are what the Plain text
  view applies, as they are. Whatever the editor then does on its own (a
  half-typed table row filled out) is no one's edit: `getText()` is `text`
  until the person types.
- **Out:** `getText()` keeps the original bytes of every top-level block
  whose meaning did not change (`splice`). A block only typed into or
  deleted from keeps its own bytes but for those characters, so its style
  holds (a setext heading, `*` bullets, a table's padding) and two people
  typing in it merge by character; that is checked by reading it back.
  Any other changed block is written in one common style. Worked out once
  per document.
- **When:** `onEdit` fires on every change the person makes; the page then
  reads `getText`, unless an edit of theirs is on its way to the host.
  `onChange` fires 200 ms after they last changed the document, for what
  can wait for a pause (the marks).

### The contract

What every view has, in offsets on the doc's text (`test/views.test.js`):
`getText`, `applyText`, `setMarks` (comments, a revision, cursors), the
selection, `tops` and `scrollTo` (for the margin), `focus`, `undo` and
`redo`, and a call when its settings change. Made with the text, whether it
is editable, whether to colour its syntax (the plain view), and the page's callbacks: `onEdit`, `onChange`, `onMarkClick`,
`onLayout`, and, given a toolbar, `onComment`.

### What it does not know

Who anyone is (a mark's `by` is only a name to color), how edits merge
(the doc host's, whatever view is on), the doc host, and files.

### Cost

The view keeps the latency promise ([Editing](architecture.md#editing), B) up
to 100,000 characters, with no block over 10,000; a longer doc opens in the
plain view, which offers this one anyway. A parse or a serialize of a long doc takes hundreds of milliseconds, so the
view works a few top-level blocks at a time (`blocks.js`): while each
block of the text it was given pairs with a block of its document,
`getText` writes only the blocks changed since and splices them in, and
`applyText` parses only the blocks where the new text differs, with a kept
block on either side that must read as before. Both projections are kept
per block. Link definitions lie between the blocks, as written; a doc
that has one is parsed and projected whole, since a block's links read by
them, and a block it changed other than by typing is saved by a splice of
the whole doc. A doc whose blocks do not pair up is worked out whole. Milkdown's own walks of the
whole doc on every change are left out (heading ids, unused) or kept to
the changed blocks (ordered list labels; `web/markdown-schema.js`), and
focus mode fades blocks by an attribute the chrome sets, not by the
editor's focus class, which would restyle every block on each focus
change. The word count runs a few times a second at most.

## Many writers

The host orders every edit as text operations on a revision
([Interfaces](architecture.md#interfaces)). Since the view already takes and
gives text, the operations live in the page (`web/client.js`), with the
contract as it is: plan A, in both views. The writers are the owner,
teammates who can edit ([Sharing](architecture.md#sharing)), AI buddies
and changes from outside.

### Plan A: the view stays as it is

1. **Typing out.** On each change, while no edit is on its way,
   `diffOps(the text the view last had, getText())`, trimmed to the edit,
   goes to the host on `{ epoch, rev }` and waits as pending. Changes made
   while one is on its way go out together when the host answers it.
2. **Others in.** Before applying operations from the host, the page reads
   `getText()` once more, so typing not read yet is pending too;
   transforms pending and incoming against each other; and shows the result
   with `applyText`.
3. **Cursors** are marks, as an AI buddy's is.
4. **Cmd+Z** is the editor's history, which holds only the person's own
   steps, mapped over what `applyText` put in. Its result is sent like
   typing.

### Where Markdown makes it hard

1. **Serialization noise.** A block written in another style (`__x__`, hard
   wraps, `*` lists) changes beyond the typed characters the first time it
   is touched, and two people touching it at once both send that change.
   Every page has the same serializer, so a block should change style once
   and then hold.
2. **Syntax split by a merge.** An insert lands between `*` and `*`, in a
   link's URL or in a table row, and the source parses to what neither
   meant. Accepted: nothing typed is lost, and people fix it by hand.
3. **Escapes.** A typed `*` is saved as `\*`; an operation can land next to
   the backslash.
4. **A block that changes kind** in a way that keeps its text (a
   paragraph made a heading, a list item or a quote, or split) keeps the
   caret and the undo history in it; one changed otherwise is replaced
   from its first to its last differing position.
5. **Undo across others' edits** in the same block.
6. **Cost:** `getText` once per edit sent (at most one a round trip to the
   host) and once per batch from the host.

### Plan B, if plan A fails

The view sends its own changes, ProseMirror steps mapped to source offsets,
and takes the host's operations as steps, as `prosemirror-collab` does.
Carets and undo are exact, but the view must know where in the source each
step lands, which neither the serializer nor `splice` tells it today. Much
more code, so only if plan A fails a must-pass case.

### The prototype

- **Core** (`src/core/ot.js`): `diffOps`, `transform`, `apply`, kept if the
  prototype passes; tested for convergence (random concurrent operations
  from two pages end in the host's text on both).
- **Harness** (`test/collab/page.js`): two
  views of one doc side by side, made as the app makes them (`viewFor`),
  each with the page's client, joined to the doc host (`test/views/main.js`)
  with 150 ms each way, and a script that types into both. No relay or
  permissions. The latency test (`test/perf/`) runs on it.

| # | Must pass | When |
| --- | --- | --- |
| 1 | Both type in different paragraphs | both texts whole; neither caret moves |
| 2 | Both type in one paragraph, apart | the same |
| 3 | Both type at one place | both kept, in one order in both views and the host |
| 4 | One deletes a sentence the other types in | the typed text stays |
| 5 | Cmd+Z after the other typed in the same paragraph | only one's own typing is undone |
| 6 | Random typing in both for five minutes | both views equal the host's text; no error |
| 7 | Both edit a block written in another style | no text doubled; `git diff` shows only edited blocks |

Measured, with no bar: how often merges break bold, links or tables; caret
moves when a block changes kind; `getText` time per batch on a 200 KB doc.

It passed (#214), so plan A is built: Core operations, the host's ordering,
and the page's side, the same for both views (#215). The seven cases run
against the real host (`test/collab.test.js`), with two more: the doc
changed outside, and a buddy's turn landing, while one types.
