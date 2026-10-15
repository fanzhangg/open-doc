---
name: opendoc
description: Co-author a markdown doc with a human through opendoc comment threads. Use when the human asks you to work on, review, or answer comments in a markdown file "with opendoc", "in the editor", or "in the comments"; when a file has a sibling X.md.opendoc.json; or when they say they will leave comments for you. Covers opening the editor for the human, waiting for their comments, editing the doc or proposing edits, and replying to threads with the opendoc CLI.
---

# Co-authoring a doc with opendoc

The human reads and edits `X.md` in a browser editor and leaves comment threads
on it. You see their comments through the `opendoc` CLI, edit `X.md` directly
with your normal file tools (or propose edits for the human to apply), and
answer in the thread. Comments live in `X.md.opendoc.json` next to the doc;
**never edit that file yourself**. Every change to it goes through the CLI.

You are a collaborator like any human reviewer: you act on comments for
you, you always end with a reply that says what you did, and the
human decides when a thread is done. **Never resolve or reopen a thread**;
the CLI refuses it for agents.

## Setup

1. Check the CLI: `opendoc help`. If the command is missing, install it once
   from the opendoc repo (`npm install -g <path-to-opendoc>`), or ask the human
   where it is. Every command takes the doc path first; use an absolute path.
2. Pick your name and use it on every command: `--as claude` (or
   `export OPENDOC_AS=claude`). It is what the human sees and what they type
   after `@`.
3. If the human wants the editor and it is not running, start it as a
   long-running background process: `opendoc serve /abs/path/X.md`. It prints
   a `http://127.0.0.1:…/?t=…` link and opens the browser; give the human the
   link. Do not start a second one if it is already running.

## The loop

Repeat until the human says they are done.

1. **Wait.** Run `opendoc wait /abs/path/X.md --as claude --json` **in the
   background** so you are woken when it exits. It blocks until a comment is
   waiting on you, marks those threads as being answered (the human sees
   "claude is responding…"), prints them and exits.
   - Exit 0: threads are waiting, go to step 2.
   - Exit 3: timed out (15 minutes by default; `--timeout <seconds>` changes
     it, `0` waits forever) with nothing waiting. Run it again unless the
     human said they are done.
   - If you cannot run commands in the background, either run `wait` in the
     foreground with a short `--timeout` and stop when it times out, or run
     `opendoc inbox /abs/path/X.md --as claude --json` each time you are
     invoked. `inbox` lists the same threads without blocking or marking them.
2. **Read.** Read `X.md` with your file tools. Each thread in the output has an
   `anchor.exact` (the text it is about; `null` for a comment on the whole doc),
   a `line` hint, and its `messages`, oldest first. The last message is the
   human's request to you.
3. **Act** on each thread, in order:
   - **An edit was asked for:** make it in `X.md` with small, targeted edits.
     Change only what the comment is about. Keep plain markdown and the doc's
     existing style; do not reformat or rewrite untouched text (the human may
     be typing elsewhere in the doc, and small edits keep their view stable).
     If the thread asks for a proposal first, or you were told the human
     approves every change, propose it instead (see
     [Proposing edits](#proposing-edits)). If your `Edit` fails because the
     file changed since you read it (the human saves as they type), read it
     again and retry once.
   - **A question:** answer it in the thread; edit the doc only if asked.
   - **Partly doable:** do the parts you can, and in the same reply say what
     you did and ask about the rest. Never present invented facts (names,
     numbers, dates) as the doc's own; ask for them. If the human explicitly
     asks you to assume or propose something, do it, label it as your
     assumption in the reply, and leave the thread open for them to confirm.
   - **Unclear:** ask one short question in the thread instead of guessing.
4. **Reply** to every thread you were handed, once, always, even when the
   edit was trivial:
   `opendoc reply /abs/path/X.md <thread-id> "<what you changed, or your answer>" --as claude`
   (or a proposal with `opendoc propose`, which is your reply). Say what you
   did in a sentence or two; the edit itself is visible in the doc. Replying
   hands the turn back to the human: the editor shows the thread as waiting
   for them, and they resolve it, undo your edit, apply your proposal, or
   reply again. Do not resolve the thread. (`reply` and `propose`
   print the updated thread; you do not need to check it.)
5. Go back to step 1 right away. Re-arm `wait` after every round so the human
   never waits on you.

## When `opendoc serve` started you

The human may run `opendoc serve X.md --agent claude`. Then the server waits
for comments itself and starts you once per batch, with the waiting threads
already claimed and passed to you as JSON. In that case skip step 1 and step 5
of the loop: handle exactly the threads you were given (steps 2 to 4), then
stop. Do not run `opendoc wait` or `opendoc serve`. Your tools are limited to
reading files, editing this one doc, and running `opendoc`. When the human
has chosen to approve every change, you cannot edit the doc at all: answer
edit requests with `opendoc propose`.

## Which threads are yours

`wait` and `inbox` already apply these rules, so normally just handle what they
print:

- A thread waits on you when its latest message is from a human and mentions
  `@claude` or mentions no one.
- A comment that mentions only someone else (`@alex …`) is for them. Do not
  answer it unless the human asks you to.
- Your own reply hands the turn back; you are woken again only when a human
  adds a message. Undoing your edit or applying your proposal does not wake you.

## Proposing edits

Instead of editing `X.md`, you can reply with the changes you suggest; the
human sees them struck through and inserted in the text and clicks Apply.
Pipe JSON to `propose` with `echo` (a heredoc is refused when the
editor starts you, so always use this form):

```bash
echo '{"body": "Cut the list to the three features we can ship in week one.", "changes": [{"before": "ship all six features", "after": "ship three features"}]}' | opendoc propose /abs/path/X.md <thread-id> --as claude
```

Inside the single quotes, write an apostrophe as `'\''`, and a line break
in `before` or `after` as `\n` (JSON escapes work as usual).

- `before` and `after` are **markdown source**, copied exactly from `X.md`
  (with its `**`, `[links](…)` and line breaks), not the rendered text.
- Each `before` must appear exactly once in the doc. If `propose` exits 2
  saying it appears more than once, quote more of the surrounding text; if it
  does not appear, copy it again from the file. Changes must not overlap.
- To insert, quote the text next to the insertion point and repeat it in
  `after` with the new text added. To delete, use an empty `after`.
- `body` says what you suggest and why, like a reply. A proposal is your one
  reply to the thread; do not also `reply`.

## Starting threads yourself

You may raise something the human should decide (a risky edit, a missing fact):

```bash
opendoc comment /abs/path/X.md --quote "exact text from the doc" "Should this be Q3 or Q4? @fzhan" --as claude
opendoc comment /abs/path/X.md "General: the intro and summary disagree on the date." --as claude
```

`--quote` must match the rendered text (markdown syntax is ignored, so
`**ship** it` matches `ship it`). If it appears more than once, the command
fails with exit 2 and says how many times; add `--occurrence <n>` or quote more
words. Mention the human with `@<name>` when you need them. Use comments
sparingly; prefer doing what was asked.

## Detached threads

A thread shows `detached: true` when the text it was attached to is gone, for
example because someone rewrote or deleted that passage. Its `anchor.exact`
still holds the old quoted text; when you refer to it, quote exactly that and
do not reconstruct the words around it. Read the doc and look for where that
content went:

- **Moved or reworded:** do what the comment asks at the new place and say
  where in your reply.
- **Deleted:** you cannot tell whether that was deliberate. Reply that the
  text is gone and ask whether to restore it. Leave the thread open; the human
  decides.
- **You deleted it yourself** while handling this same thread: say so in
  your reply.

## Reading the state

- `opendoc comments /abs/path/X.md` lists open threads with line numbers.
  Add `--status all` to include resolved ones and `--json` for exact fields.
- `opendoc inbox /abs/path/X.md --as claude` shows what is waiting on you
  without blocking.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | OK | Continue |
| 2 | Bad input: quote not found or ambiguous, a proposal's `before` not found or not unique, unknown thread, missing `--as`, resolving as an agent | Fix the arguments; the message says what is wrong |
| 3 | `wait` timed out | Run `wait` again unless the human is done |
| 4 | The comments file was busy for 5 seconds | Retry once |
| 1 | Unexpected error | Report the message to the human |

## Rules

- Never edit, rewrite, or delete `X.md.opendoc.json`; use the CLI.
- Never rename `X.md` with plain file tools; use `opendoc mv old.md new.md` so
  its comments move with it.
- Keep `X.md` plain markdown. Do not add comment markers, HTML comments, or
  metadata to it.
- Reply in the thread, not only in chat. The human is in the editor, not
  necessarily watching the chat.
- One reply per thread per round, every round. Do not answer threads that
  are not yours.
- Never resolve or reopen a thread. The human decides when it is done.
