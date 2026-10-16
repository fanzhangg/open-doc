# User Experience

How a person writes with agents in OpenDoc today. For why, see the
[product vision](product-vision.md); for how it is built, see [architecture](architecture.md).

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
persona, and only the permissions you give it. The **persona** is one line in
your own words that defines it ("a strict copy editor who never changes
meaning"), shown on its card and in the People panel; it stays blank until
you write one. **Instructions** (Agents panel) hold the details and rules
behind it. Both go into the agent's prompt as one block, and anyone can
rewrite them. OpenDoc comes with one agent,
**Clippy**, starred, with a generic persona (a general writing assistant
that helps draft and edit docs), and Editor, Auto Editor and
Auto Commenter switched on. There are no built-in roles: a grammar checker, a
fact checker or a tough reader is an agent whose persona you wrote.

Agents are light, and belong to the doc unless you star them:

- **New agent** (People panel) pops a new agent into the doc and opens its
  card, ready to name: type a name, Enter, then its persona. On any card,
  click the name or the persona to edit it in place; Enter or leaving the
  field saves, Escape cancels. The settings button opens the Agents panel.
- A new agent is the doc's own. It shows only in that doc, is saved with it
  (name, persona and instructions in the sidecar), and is back whenever you
  open the doc. Removing it from the doc deletes it; its comments stay under
  its name.
- **Star** an agent to put it in your agents, for every doc. Unstarring keeps
  it in the docs that use it. Agents made before stars existed count as
  starred.
- A doc from someone else brings its agents, set up as its own with the
  safest permissions (proposes edits, answers only when @mentioned, no web or
  files). Permissions never come from the doc.
- A new doc starts with **Clippy**. The first time a doc with no agents yet
  is opened, Clippy joins it (under whatever name you gave it), so a new doc
  always has someone to answer. Add any other agent in the doc: the People
  panel, or an @mention. A doc that already has agents keeps its own.

**Permissions** are plain switches on the agent's card:

- **Editor**: may change the doc. Without Auto Editor it *proposes* each change.
- **Auto Editor**: edits directly and replies with what it changed (undoable).
  On for every new agent, as for a co-author; switch it off to review each change.
- **Auto Commenter**: answers comments that mention no one, if they fit its persona.
  The first agent in a doc (Clippy, in a new one) starts with it and leads; the
  ones after it answer when @mentioned.
- **Web Searcher** / **File Searcher**: may use the web / read your other files
  (never secrets). Turning one on asks to confirm, with a warning if the agent
  already has the other.

**Who answers what:**

- A comment that mentions no one goes to every agent with Auto Commenter
  (by default the first one, Clippy for a new user). Each answers only if it
  fits its persona.
- `@name` calls a specific agent. Mentioning one that is not in the doc yet
  brings it in.
- `@name` in the doc's text works like a comment. Type
  `@Clippy add the risks here` in a paragraph; once you are done writing it,
  it becomes your comment on the text from the `@` to the end of the
  paragraph, and the agent answers there and removes that text when it is
  done (or proposes removing it). There is nothing to press: you are done
  when you move on (your caret goes to another paragraph, you type
  elsewhere, or you leave the editor), when the ask ends a sentence
  (`.` `!` `?` `。` …) and you pause for 3 seconds, or when the paragraph has
  been still for 15 seconds. Stopping mid-sentence to think does not cut the
  ask short, and typing elsewhere does not hold it back. A bare `@Clippy`
  with nothing after it waits until you move on.
- Until the agent answers, the comment follows the text. Reword the ask
  while the agent waits its turn and it gets the new words; reword it while
  the agent is working on it and that run stops and starts over with them
  once you are done again.
- Each mention counts once: editing around an old one, moving text before
  it, or a mention in code asks nothing new.
- A follow-up with no mention continues with the agent that answered last.
- Agents hand work to each other in the thread, so you never pass messages
  between them. An agent that needs another to act next hands it the thread
  (its reply starts with `@Scorer` and wakes Scorer); an agent that only
  mentions another, such as a score reply to `@claude`, wakes no one. After
  four handoffs in a row the thread waits for you, and your next message lets
  them go on.
- Agents work at the same time: a comment that mentions three agents gets
  all three working on it at once, each shown typing in the thread. Only
  their edits to the doc take turns, so each agent's changes are recorded on
  its own reply and undo on their own.
- Nothing is remembered in private. Every run starts a fresh session that
  reads the doc and its threads; anything worth keeping is written there.

## Seeing and steering agent work

- **Presence.** People's avatars are circles; each agent's is a soft blob
  with a face, its shape, colour and expression drawn from its name, so it
  looks the same everywhere. They sit side by side in the header. While an
  agent works its body rolls under its face like a spinner
  and the comment card pulses; an agent that is not running, still starting
  or failing is greyed out.
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

- **People** button (round, after the avatars): who is in this doc. New
  agent, add (+) or remove (×) agents.
- **Agent card** (click an avatar): name and persona (click either to edit),
  permission switches, a star to keep it, and a button for more settings.
- **Agents** panel: every agent, with the finer settings. Name, persona,
  starred, permissions, instructions, and under Advanced the runtime (Claude Code,
  Codex, or a custom command), model and limits.

## Around the doc

- **Version history** (clock button): every version with who made it, a diff
  against the one before, and Restore. Kept in the config folder, not in the
  doc's folder.
- **Settings** (name, theme, font, width, outline, word count, focus mode)
  are global and apply at once to every open window, the start window too
  (its gear, or Ctrl+,).
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
