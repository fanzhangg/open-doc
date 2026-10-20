# opendoc format — version 3

The sidecar holds a doc's comments and nothing else. Buddies, their runs
and versions are not part of the format (see
[architecture](../docs/architecture.md)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Files

- A doc is a text file `X`, of any format. Its comments live in
  `X.opendoc.jsonl` next to it; nothing of them goes into the doc.
- A doc's **text** is its bytes decoded as UTF-8, without a leading byte
  order mark, with every CRLF or lone CR as LF. Anchors (§3) are on this
  text. A tool MUST NOT write a doc whose bytes are not UTF-8. It SHOULD
  write a doc back with the byte order mark it had, and with CRLF throughout
  if it had any CRLF ([fixtures](conformance/doc-text.json)).
- The sidecar is created with the first comment. A sidecar whose doc is
  missing is orphaned: tools report it and MUST NOT delete it on their own.
- Renaming a doc renames its sidecar.
- Comments may be private and a repo public. A tool SHOULD, before writing a
  sidecar inside a git work tree, add `*.opendoc.jsonl` to the repo's
  `info/exclude`, so a stray `git add .` does not publish them. Sharing
  comments is then a choice: add `!*.opendoc.jsonl` after it.
- Sidecars of earlier versions are not converted: a version 1 sidecar
  (`X.opendoc.json`) is not read, and a version 2 one, whose anchors were on
  a markdown doc's rendered text, is another version (§2).
- In git, `*.opendoc.jsonl merge=union` SHOULD be set.

## 2. Comments

UTF-8 text, one JSON object per line, `\n` after each. The first line is
`{"opendoc":3}`; a tool MUST NOT write a sidecar whose first line is not,
and MAY show its comments read-only. Every other line is a comment. A tool
MUST keep fields it does not understand.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `c_` + at least 6 characters from `[A-Za-z0-9_-]`. The first comment's id is also its thread's id. |
| `thread` | string, optional | The first comment of the thread this one replies in. Absent on a first comment. |
| `anchor` | object or null, optional | First comments only: the text it is about (§3). Absent or `null` for a comment on the whole doc. |
| `by` | object | `{ "id", "name", "kind": "human" \| "ai" }`. A human's `id` is random and stays when the name changes; a buddy's `id` is its name. |
| `at` | string | When it was written, RFC 3339 UTC. A buddy's reply and comments: just after the latest comment of the thread it answered, as its run saw it. |
| `body` | string | Plain text; may be empty on a reply (a human's resolves or reopens), or when `resolved` is set. |
| `resolved` | `true`, optional | Humans only: resolves the thread. |
| `conflict` | `true`, optional | Buddies only: part of its edit was dropped because a human changed the same text meanwhile. |
| `failed` | `true`, optional | Buddies only: its run failed; `body` is the end of the program's output. |

A comment never changes once written.

## 3. Anchors

An anchor is `{ "exact", "prefix", "suffix", "start" }` on the doc's text
(§1): the quote, non-empty; up to 32 characters before and after it; and its
offset when made, a hint. This follows the W3C Web
Annotation `TextQuoteSelector` plus a `TextPositionSelector` start hint.

An anchor is never rewritten. Where it is now is found by each reader
(§3.2). A comment whose anchor is not found stays, shown as detached.

### 3.1 Creating an anchor

Given a selection `[start, end)` in the doc's text, `exact` is
`text[start:end]`, `prefix` is the up to 32 characters before it, `suffix` the
up to 32 after it, and `start` is `start`.

### 3.2 Finding an anchor

A reader finds each anchor in the doc's text as it is now. A
candidate range from step 1 or step 3 is **acceptable** only if all of these
hold, where quote similarity is `sim(exact, candidate)` and context
similarity is the mean of prefix and suffix similarity (§3.3):

- its quote similarity is at least 0.5;
- when its quote similarity is below 0.8, its context similarity is at
  least 0.5;
- when `exact` is shorter than 8 characters, its context similarity is at
  least 0.5, whatever its quote similarity, so a short quote that was
  deleted does not jump to an unrelated copy elsewhere.

Step 2's candidates have their full `prefix` and `suffix` exactly, so they
need no such check. The steps, in order:

1. **Exact.** Find every occurrence of `exact`; among the acceptable ones,
   pick the one with the best score (§3.3).
2. **Context bracket.** If `prefix` and `suffix` are each at least 8
   characters long, find places where `prefix` occurs exactly and is followed
   by an exact `suffix` after a gap of between `ceil(len(exact) / 2)` and
   `2 * len(exact) + 16` characters. The gap is the new span; if there are
   several, pick the one whose start is closest to `start` (ties: earliest).
   This follows edits that grow or shrink the quote itself, such as
   "extra load" becoming "extra peak load".
   Text typed right after the quote also falls in the gap, so when the last
   16 characters of `exact` still occur in it, the span ends after their last
   occurrence.
3. **Fuzzy.** Search for approximate matches of `exact` allowing up to
   `floor(len(exact) / 2)` edits (insertions, deletions, substitutions),
   first in a window around `start`, then in the whole text; among the
   acceptable matches, pick the best score. Quotes shorter than 4 characters
   are never fuzzy-matched.
4. **Detached.** Otherwise the anchor is not found.

Finding is deterministic: the same doc and anchor always give the same
result.

### 3.3 Scoring

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
3. A thread is resolved when its latest human comment has `resolved`:
   only people resolve and reopen.
4. A human is shown by the name in their latest comment.
5. A line that is not valid JSON or not a valid comment is reported, skipped
   and kept as it is.

## 5. Writing

- The file is written whole: to a temporary file in the same folder,
  renamed over it.
- Comments are never removed: a thread ends by being resolved.

## 6. Mentions

`@name` in a body, where the `@` starts the body or follows a character that
is not a letter, digit, `.`, `_` or `-`, and the name is followed by none of
a letter, digit, `_` or `-`. It mentions the buddy of that name, compared
case-insensitively, among the buddies the doc reaches.

## 7. Trust

A sidecar is plain shared text: anyone who can change the file can write
anything in it, and `by` is only what its writer says. A tool runs a buddy
only for a comment whose `by.id` is its own user's.
