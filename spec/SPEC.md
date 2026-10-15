# opendoc format — version 1 (draft)

opendoc lets humans and AI agents co-author a plain markdown file through
comment threads anchored to its text. This document specifies the file layout,
the sidecar format, how anchors are computed and re-found, and the rules every
tool that reads or writes opendoc files must follow.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Files

A doc is any markdown file `X.md`. Its opendoc data lives in exactly one
**sidecar** file next to it:

```
docs/
  plan.md
  plan.md.opendoc.json
```

- The sidecar path is the doc path with `.opendoc.json` appended. The doc path
  is the sidecar path with `.opendoc.json` removed. No other mapping exists.
- The doc file MUST stay plain markdown. opendoc never writes markers,
  comments or metadata into it.
- A sidecar is created on the first write (for example, the first comment). A
  doc without a sidecar is valid and has no threads.
- The sidecar's `doc` field MUST equal the doc's file name. A tool that finds a
  mismatch (for example after the pair was copied under a new name) MUST NOT
  silently use the threads; it SHOULD ask whether to adopt them or start fresh.
- A sidecar whose doc is missing is **orphaned**. Tools SHOULD report it and
  MUST NOT delete it automatically.
- Renaming a doc MUST rename its sidecar and update `doc`.

## 2. Sidecar format

The sidecar is a UTF-8 JSON object. The JSON Schema is
[`opendoc.schema.json`](./opendoc.schema.json).

```json
{
  "opendoc": 1,
  "doc": "plan.md",
  "docHash": "sha256:9f2c…",
  "participants": [
    { "name": "fzhan", "kind": "human" },
    { "name": "claude", "kind": "agent" }
  ],
  "threads": [
    {
      "id": "t_8f3k2a9x",
      "anchor": { "exact": "ship all six features", "prefix": "We plan to ", "suffix": " in week one, then gather", "start": 26 },
      "detached": false,
      "status": "open",
      "resolvedBy": null,
      "resolvedAt": null,
      "working": null,
      "messages": [
        {
          "id": "m_q81xk2pd",
          "author": { "name": "fzhan", "kind": "human" },
          "body": "@claude is six realistic?",
          "mentions": ["claude"],
          "createdAt": "2026-10-14T18:20:00Z"
        }
      ]
    }
  ]
}
```

### 2.1 Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `opendoc` | integer | Format major version. This spec is `1`. |
| `doc` | string | File name of the doc (no directory). |
| `docHash` | string or null | `sha256:` + lowercase hex SHA-256 of the doc's bytes at the moment the anchors were last computed. `null` before any anchor exists. |
| `participants` | array | The @mention directory (§2.4). |
| `threads` | array | Comment threads (§2.2). |

### 2.2 Thread

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique in the sidecar, `t_` + at least 6 characters from `[A-Za-z0-9_-]`. |
| `anchor` | object or null | Where the thread is attached (§3). `null` is a doc-level thread. |
| `detached` | boolean | `true` when the anchor could not be re-found in the current doc. The last known anchor is kept so it can be re-found later. |
| `status` | `"open"` or `"resolved"` | |
| `resolvedBy` | string or null | Participant name that resolved the thread. |
| `resolvedAt` | string or null | RFC 3339 UTC timestamp. |
| `working` | object or null | `{ "by": <name>, "since": <timestamp> }` while an agent is responding. Tools MUST treat a value older than 5 minutes as `null`. |
| `messages` | array | At least one message, oldest first. |

Only a participant with `kind: "human"` may resolve or reopen a thread;
tools MUST refuse a resolve or reopen made as an agent. An agent answers by
replying, and the human decides whether the thread is done. (Sidecars
written before this rule may have threads resolved by an agent; they stay
valid as they are.) Reopening sets `resolvedBy` and `resolvedAt` to `null`. Adding a message to a resolved thread reopens it. A
message from the participant named in `working` clears `working`; resolving
clears it too.

### 2.3 Message

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique in the sidecar, `m_` + at least 6 characters from `[A-Za-z0-9_-]`. |
| `author` | object | `{ "name": <participant name>, "kind": "human" \| "agent" }` |
| `body` | string | Plain text. Tools MUST NOT interpret it as markup. |
| `mentions` | array of strings | Participant names mentioned in `body` (§4). |
| `createdAt` | string | RFC 3339 UTC timestamp. |
| `edits` | array, optional | What the author changed in the doc while answering this thread (§2.5). |
| `undoes` | string, optional | Id of a message whose `edits` this message reverted. Such a message is an **undo notice** (§5). |
| `proposal` | array, optional | Changes the author suggests instead of making them (§2.6). |
| `applies` | string, optional | Id of a message whose `proposal` this message applied. Such a message is an **apply notice** (§2.6); it carries the resulting `edits`. |

### 2.4 Participants

Each entry is `{ "name", "kind" }`. A name matches
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and is unique, compared case-insensitively.
A participant is added the first time they post, or when an agent starts
waiting for comments. Editors use this list for @ autocompletion.

### 2.5 Edits

A tool that runs an agent on a thread MAY record what the agent changed in
the doc as `edits` on the agent's reply, so a human can review and undo it.
Each edit is a change to the doc's **markdown source** (not the rendered
text):

| Field | Type | Meaning |
| --- | --- | --- |
| `before` | string | The source text that was replaced. Empty for an insertion. |
| `after` | string | The source text that replaced it. Empty for a deletion. |
| `prefix` | string | Up to 32 characters of source immediately before `after`, just after the change. |
| `suffix` | string | Up to 32 characters of source immediately after `after`, just after the change. |
| `start` | integer | Offset of `after` in the source just after the change. A hint. |
| `scope` | `"thread"` or `"run"`, optional | `"run"` when the change could not be tied to this thread because one agent run answered several threads; it is then recorded on each of them. Default `"thread"`. |

`before` and `after` differ. A change is usually trimmed to the characters
that differ and widened to whole words where it splits one: `extra load`
becoming `extra peak load` is recorded as an insertion of `peak `, and
`colour` becoming `color` as `colour` → `color`. A change is tied to
the thread whose anchor it overlaps or touches; when a run answered one
thread, every change in it belongs to that thread.

To **undo** an edit, a tool finds `after` in the current source as if it
were an anchor (`exact` = `after`, §3.3 step 1 only), requiring that the
match also keeps `prefix` or `suffix` next to it; an empty `after` is found
as the place where `prefix` is directly followed by `suffix` (closest to
`start`). If any edit of the message cannot be found this way, the text has
changed since and the tool MUST NOT undo. Otherwise it replaces each match
with `before` and posts an undo notice: a human message with `undoes` set
to the reverted message's id, which reopens the thread.

### 2.6 Proposals

A participant who should not change the doc directly (for example an agent
whose edits need the human's approval) MAY reply with a **proposal**: the
changes it suggests, which a human applies or ignores. Each change is to the
doc's markdown source:

| Field | Type | Meaning |
| --- | --- | --- |
| `before` | string | The source text to replace, non-empty. |
| `after` | string | The source text to put in its place. Empty for a deletion. |
| `prefix` | string | Up to 32 characters of source immediately before `before`, when the proposal was made. |
| `suffix` | string | Up to 32 characters of source immediately after `before`, when the proposal was made. |
| `start` | integer | Offset of `before` in the source when the proposal was made. A hint. |

`before` and `after` differ. When a proposal is made, each `before` MUST
occur exactly once in the doc's source and no two may overlap; a tool
refuses the proposal otherwise, so the author can quote more text. To insert,
quote the text next to the insertion point and repeat it in `after`.

To **apply** a proposal, a tool finds each `before` in the current source by
the undo rule of §2.5 run the other way (`exact` = `before`, §3.3 step 1
only, keeping `prefix` or `suffix` next to it). If any change cannot be found
this way, the text has changed since and the tool MUST NOT apply. Otherwise
it replaces each match with `after`, saves the doc, and posts an apply
notice: a human message with `applies` set to the proposal's message id and
`edits` (§2.5) recording what changed, so it can be undone like any edit.
Applying a proposal does not resolve the thread.

## 3. Anchors

An anchor identifies a span of the doc's **rendered text** (§3.1):

| Field | Type | Meaning |
| --- | --- | --- |
| `exact` | string | The quoted text, non-empty. |
| `prefix` | string | Up to 32 characters immediately before `exact`. |
| `suffix` | string | Up to 32 characters immediately after `exact`. |
| `start` | integer | Offset of `exact` in the rendered text when the anchor was last computed. A hint, not a guarantee. |

This follows the W3C Web Annotation `TextQuoteSelector` plus a
`TextPositionSelector` start hint.

### 3.1 Rendered text

The rendered text is what a reader sees, with markdown syntax removed. Both
the Node and the browser implementations MUST produce identical text for the
same doc. It is built from the CommonMark + GFM syntax tree, with emphasis
delimiters read by the CJK-friendly amendment
([markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly)), so
`**熟悉：**直接` is bold as a Chinese writer means it, although plain
CommonMark leaves the asterisks as text:

1. Each **text block** contributes one line. Text blocks are: paragraphs,
   headings, table cells, code blocks and raw HTML blocks. Blocks nested in
   lists, block quotes and footnotes contribute their own text blocks.
   List markers, quote markers and table pipes contribute nothing.
2. Text blocks are joined with a single `\n`. Blocks whose text is empty
   (for example thematic breaks) are skipped.
3. Inside a text block, inline content contributes: text (escapes and
   entities decoded), inline code (its content), inline raw HTML (as
   written), and the children of emphasis, strong, strikethrough and links. Images, footnote references and
   link reference definitions contribute nothing. A hard line break
   contributes one space.
4. Inside every text block except code blocks, each run of whitespace becomes
   one space, and leading and trailing whitespace is removed. Code block
   content is kept as written.

### 3.2 Creating an anchor

Given a selection `[start, end)` in the rendered text, `exact` is
`text[start:end]`, `prefix` is the up to 32 characters before it, `suffix` the
up to 32 after it, and `start` is `start`.

An agent may give a quote instead of a range. Tools find the quote in the
rendered text; if it is not found, they render the quote itself by §3.1 (so
`**ship** it` becomes `ship it`) and search again. A quote that matches more
than once MUST be refused unless the caller picks an occurrence.

### 3.3 Re-finding an anchor

When the doc changes, a tool re-finds each anchor in the new rendered text:

1. **Exact.** Find every occurrence of `exact` and pick the one with the best
   score (§3.4). When `exact` is shorter than 8 characters, an occurrence
   counts only if its context similarity (the mean of prefix and suffix
   similarity) is at least 0.5, so a short quote that was deleted does not
   jump to an unrelated copy elsewhere.
2. **Context bracket.** If `prefix` and `suffix` are each at least 8
   characters long, find places where `prefix` occurs exactly and is followed
   by an exact `suffix` after a gap of between `ceil(len(exact) / 2)` and
   `2 * len(exact) + 16` characters. The gap is the new span; if there are
   several, pick the one whose start is closest to `start` (ties: earliest).
   This follows edits that grow or shrink the quote itself, such as
   "extra load" becoming "extra peak load".
3. **Fuzzy.** Search for approximate matches of `exact` allowing up to
   `floor(len(exact) / 2)` edits (insertions, deletions, substitutions),
   first in a window around `start`, then in the whole text. Pick the best
   score. Accept it only if its quote similarity is at least 0.5 and, when the
   quote similarity is below 0.8, its context similarity is at least 0.5.
   Quotes shorter than 4 characters are never fuzzy-matched.
4. **Detach.** Otherwise set `detached: true` and keep the anchor unchanged.

A re-found anchor is rewritten from the new range (§3.2) and `detached` is set
to `false`. Re-finding is deterministic: the same doc and sidecar always
produce the same result.

### 3.4 Scoring

For a candidate range, with `sim(a, b) = 1 - edits / len(a)` (1 when `a` is
empty) computed by approximate search of `a` within `b`:

```
score = 50 * quoteSim
      + 20 * sim(prefix, 32 chars before the candidate)
      + 20 * sim(suffix, 32 chars after the candidate)
      +  2 * (1 - |candidateStart - start| / len(text))
```

### 3.5 Keeping anchors fresh

`docHash` records which version of the doc the anchors describe. A tool that
reads a sidecar whose `docHash` differs from the current doc's hash SHOULD
re-find all anchors and write the result (with the new `docHash`) using the
write protocol (§6). Because re-finding is deterministic, concurrent tools
writing the refreshed result agree.

## 4. Mentions

A mention is `@` followed by a participant name, where the `@` is at the start
of the body or follows a character that is not a letter, digit, `.`, `_` or
`-`, and the name is not followed by a letter, digit, `_` or `-`. Matching is
case-insensitive. `mentions` lists the canonical names, each once, in order of
first appearance. `@` followed by a name that is not a participant is not a
mention.

## 5. Inbox

A thread is in participant `P`'s inbox when all of these hold:

- `status` is `"open"`;
- its latest message that is not an undo notice or an apply notice (§2.3)
  has an author with `kind: "human"`;
- that message mentions `P`, or mentions no one;
- it is not marked `working` by `P` (a stale value does not count).

A comment addressed only to someone else does not wake `P`, and undoing an
edit or applying a proposal does not ask the agent to act again. A tool MAY
let a participant narrow its inbox to messages that mention it (for example
an agent set to "do not disturb"). The last rule
keeps a participant who is still answering a thread from being handed it
again. The inbox is
computed from the sidecar alone; tools need no cursor or other state.

## 6. Writing

Writers MUST NOT lose each other's changes:

1. Take an exclusive lock by creating `X.md.opendoc.json.lock` with
   exclusive-create semantics. A lock file older than 2 seconds is stale and
   MAY be removed. A writer that cannot take the lock within 5 seconds gives
   up and reports a conflict.
2. Re-read the sidecar and apply the change to the latest content.
3. Write the result to a temporary file in the same directory and rename it
   over the sidecar.
4. Remove the lock.

Changes are expressed as operations (add thread, add message, resolve, reopen,
set working, join, attach edits) carrying client-generated ids, so a retried operation is
applied at most once. A proposal or an apply notice is an add-message
operation whose message carries `proposal` or `applies`.

## 7. Compatibility

- A tool MUST refuse a sidecar whose `opendoc` major version it does not know.
- A tool MUST preserve top-level sections and fields it does not understand,
  at every level, when it rewrites a sidecar.
- Third-party additions use keys that start with `x-` (for example
  `"x-acme": { … }`).
