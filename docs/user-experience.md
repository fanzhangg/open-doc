# User Experience

How a person writes with agents in OpenDoc today. For why, see the
[vision](产品愿景.md); for how it is built, see [architecture](architecture.md).

## The basic loop

1. **Open a doc.** Any `.md` file: from the start window, File > Open, a
   double-click in the OS, a drag onto the app, or `opendoc serve plan.md`
   for a browser tab. Each doc gets its own window.
2. **Write.** A WYSIWYG editor over plain markdown. Saving is automatic and
   keeps the bytes of every block you did not touch, so `git diff` stays clean.
3. **Comment.** Select text and click the comment button at the page edge
   (Ctrl+Alt+M). The comment sits in the margin beside its text and stays
   attached as the text is edited by anyone.
4. **An agent answers.** It works on the comment, edits or proposes, and
   always ends with a reply in the thread.
5. **You decide.** Resolve the thread, reply again, apply a proposal, or undo
   the agent's edit. Only humans resolve threads.

## Agents are collaborators

Each agent is set up like a person in a shared doc: a name you @mention, a
short introduction, a persona written in your own words, and only the
permissions its job needs. OpenDoc ships six, each owning one part of the work:

| Agent | Job | Permissions |
| --- | --- | --- |
| Clippy | Drafts and reshapes your doc | Editor, Auto Editor, Auto Commenter |
| Rocky | Fixes grammar and typos | Editor, Auto Editor |
| Will | Polishes style and flow | Editor |
| Genius | Checks facts against sources | Editor, Web Searcher |
| Merlin | Finds it in your files | Editor, File Searcher |
| Links | Critiques like a tough reader | replies only |

**Permissions** are plain switches on the agent's card:

- **Editor**: may change the doc. Without Auto Editor it *proposes* each change.
- **Auto Editor**: edits directly and replies with what it changed (undoable).
- **Auto Commenter**: answers comments that mention no one, if they fit its persona.
- **Web Searcher** / **File Searcher**: may use the web / read your other files
  (never secrets). Turning one on asks to confirm, with a warning if the agent
  already has the other.

**Who answers what:**

- A comment that mentions no one goes to every agent with Auto Commenter
  (by default only Clippy). Each answers only if it fits its job.
- `@name` calls a specific agent. Mentioning one that is not in the doc yet
  brings it in. The line under the comment box says who will reply.
- A follow-up with no mention continues with the agent that answered last.
- Agents never wake each other, and take turns: one runs at a time per doc.

## Seeing and steering agent work

- **Presence.** While an agent works, its avatar and the comment card pulse.
  Its edits are typed into the page as a collaborator would, highlighted with
  its name, merged with whatever you are typing elsewhere.
- **Proposals.** An agent without Auto Editor replies with suggested changes.
  Selecting the thread previews them in the text (old struck through, new
  inserted). Click Apply to make them; Apply is disabled if the text changed
  since.
- **Undo.** Every agent edit is recorded on its reply and can be undone from
  there. The record holds only the agent's own changes, never your typing.
- **You keep priority.** An agent will not edit the paragraph you are typing
  in. If you both change the same paragraph, your text is kept and the
  agent's version comes back as a proposal. Nothing is silently lost.
- **Offline agents.** A failed run, a missing sign-in, or the hourly limit
  greys the agent out; its card says why and offers Try again.

## Managing agents

- **People** panel (header): who is in this doc. Add (+) or remove (×) agents.
- **Agent card** (click an avatar): introduction, permission switches, and a
  pencil to edit the profile.
- **Agents** panel: create, edit or delete agents. Name, introduction,
  permissions, persona, and under Advanced the runtime (Claude Code, Codex, or
  a custom command), model and limits.

## Around the doc

- **Version history** (clock button): every version with who made it, a diff
  against the one before, and Restore. Kept in the config folder, not in the
  doc's folder.
- **Settings** (name, theme, font, width, outline, word count, focus mode)
  are global and apply at once to every open window.
- **Files.** New Doc, New Doc in This Folder, and Rename (moves the comments
  too). Opening an already open doc focuses its window. If the file is moved
  or deleted outside the app, a banner says so and saving pauses.

## Agents outside the app

Any agent that can run a command line can join through the CLI, for example a
Claude Code chat session with the `opendoc` skill:

```bash
opendoc wait plan.md --as claude      # block until a thread needs claude
opendoc reply plan.md <thread> "Done." --as claude
```

It reads and edits `plan.md` with its own tools (or uses `opendoc propose`),
replies, and waits again. Big rewrites can go through a chat agent; small,
targeted changes through comments in the doc.
