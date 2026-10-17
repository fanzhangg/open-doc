# opendoc format — version 2

The sidecar holds a doc's comments and nothing else. Buddies, their runs
and versions are not part of the format (see
[architecture](../docs/architecture.md)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Files

- A doc is a markdown file `X.md`. Its comments live in `X.md.opendoc.jsonl`
  next to it. The doc MUST stay plain markdown.
- The sidecar is created with the first comment. A sidecar whose doc is
  missing is orphaned: tools report it and MUST NOT delete it on their own.
- Renaming a doc renames its sidecar.
- A version 1 sidecar (`X.md.opendoc.json`) is not read.
- In git, `*.opendoc.jsonl merge=union` SHOULD be set.

## 2. Comments

UTF-8 text, one JSON object per line, `\n` after each. The first line is
`{"opendoc":2}`; a tool MUST refuse a major version it does not know. Every
other line is a comment. A tool MUST keep fields it does not understand.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `c_` + at least 6 characters from `[A-Za-z0-9_-]`. The first comment's id is also its thread's id. |
| `thread` | string, optional | The first comment of the thread this one replies in. Absent on a first comment. |
| `anchor` | object or null, optional | First comments only: the text it is about (§3). Absent or `null` for a comment on the whole doc. |
| `by` | object | `{ "id", "name", "kind": "human" \| "ai" }`. A human's `id` is random and stays when the name changes; a buddy's `id` is its name. |
| `at` | string | When it was written, RFC 3339 UTC. |
| `body` | string | Plain text; may be empty when `resolved` is set, or on a buddy's reply. |
| `resolved` | `true`, optional | Humans only: resolves the thread. |
| `conflict` | `true`, optional | Buddies only: part of its edit was dropped because a human changed the same text meanwhile. |
| `failed` | `true`, optional | Buddies only: its run failed; `body` is the end of the program's output. |

A comment never changes once written.

## 3. Anchors

An anchor is `{ "exact", "prefix", "suffix", "start" }` on the doc's
rendered text (§3.1): the quote, non-empty; up to 32 characters before and
after it; and its offset when made, a hint. This follows the W3C Web
Annotation `TextQuoteSelector` plus a `TextPositionSelector` start hint.

An anchor is never rewritten. Where it is now is found by each reader
(§3.3). A comment whose anchor is not found stays, shown as detached.

### 3.1 Rendered text

The rendered text is what a reader sees, with markdown syntax removed. It is
built from the CommonMark + GFM syntax tree, with emphasis delimiters read
by the CJK-friendly amendment
([markdown-cjk-friendly](https://github.com/tats-u/markdown-cjk-friendly)), so
`**熟悉：**直接` is bold as a Chinese writer means it:

1. Each **text block** contributes one line. Text blocks are: paragraphs,
   headings, table cells, code blocks and raw HTML blocks. Blocks nested in
   lists, block quotes and footnotes contribute their own text blocks.
   List markers, quote markers and table pipes contribute nothing.
2. Text blocks are joined with a single `\n`. Blocks whose text is empty
   (for example thematic breaks) are skipped.
3. Inside a text block, inline content contributes: text (escapes and
   entities decoded), inline code (its content), inline raw HTML (as
   written), and the children of emphasis, strong, strikethrough and links.
   Images, footnote references and link reference definitions contribute
   nothing. A hard line break contributes one space.
4. Inside every text block except code blocks, each run of whitespace becomes
   one space, and leading and trailing whitespace is removed. Code block
   content is kept as written.

### 3.2 Creating an anchor

Given a selection `[start, end)` in the rendered text, `exact` is
`text[start:end]`, `prefix` is the up to 32 characters before it, `suffix` the
up to 32 after it, and `start` is `start`.

### 3.3 Finding an anchor

A reader finds each anchor in the doc's rendered text as it is now. A
candidate range from step 1 or step 3 is **acceptable** only if all of these
hold, where quote similarity is `sim(exact, candidate)` and context
similarity is the mean of prefix and suffix similarity (§3.4):

- its quote similarity is at least 0.5;
- when its quote similarity is below 0.8, its context similarity is at
  least 0.5;
- when `exact` is shorter than 8 characters, its context similarity is at
  least 0.5, whatever its quote similarity, so a short quote that was
  deleted does not jump to an unrelated copy elsewhere.

Step 2's candidates have their full `prefix` and `suffix` exactly, so they
need no such check. The steps, in order:

1. **Exact.** Find every occurrence of `exact`; among the acceptable ones,
   pick the one with the best score (§3.4).
2. **Context bracket.** If `prefix` and `suffix` are each at least 8
   characters long, find places where `prefix` occurs exactly and is followed
   by an exact `suffix` after a gap of between `ceil(len(exact) / 2)` and
   `2 * len(exact) + 16` characters. The gap is the new span; if there are
   several, pick the one whose start is closest to `start` (ties: earliest).
   This follows edits that grow or shrink the quote itself, such as
   "extra load" becoming "extra peak load".
3. **Fuzzy.** Search for approximate matches of `exact` allowing up to
   `floor(len(exact) / 2)` edits (insertions, deletions, substitutions),
   first in a window around `start`, then in the whole text; among the
   acceptable matches, pick the best score. Quotes shorter than 4 characters
   are never fuzzy-matched.
4. **Detached.** Otherwise the anchor is not found.

Finding is deterministic: the same doc and anchor always give the same
result.

### 3.4 Scoring

For a candidate range, with `sim(a, b) = 1 - edits / len(a)` (1 when `a` is
empty) computed by approximate search of `a` within `b`:

```
score = 50 * quoteSim
      + 20 * sim(prefix, 32 chars before the candidate)
      + 20 * sim(suffix, 32 chars after the candidate)
      +  2 * (1 - |candidateStart - start| / len(text))
```

## 4. Reading

1. Lines with the same `id` are the same comment (a git merge may keep two);
   keep the first.
2. A thread is its first comment and the comments whose `thread` is its id,
   ordered by `at`, then `id`. A reply whose first comment is missing is
   hidden.
3. A thread is resolved when its latest comment has `resolved`.
4. A human is shown by the name in their latest comment.
5. A line that is not valid JSON or not a valid comment is reported, skipped
   and kept as it is.

## 5. Writing

- The file is written whole: to a temporary file in the same folder,
  renamed over it.
- Deleting a comment removes its line; deleting a first comment also
  removes its replies.
- A human deletes their own comments and any buddy's.

## 6. Mentions

`@name` in a body, where the `@` starts the body or follows a character that
is not a letter, digit, `.`, `_` or `-`, and the name is followed by none of
a letter, digit, `_` or `-`. It mentions the buddy of that name, compared
case-insensitively, among the buddies the doc reaches.

## 7. Trust

A sidecar is plain shared text: anyone who can change the file can write
anything in it, and `by` is only what its writer says. A tool runs a buddy
only for a comment whose `by.id` is its own user's.
