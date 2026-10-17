# opendoc format — version 2 (draft)

The sidecar holds a doc's comments and nothing else. Buddies, their runs
and versions are not part of the format (see
[architecture v2](../docs/architecture-v2.md)).

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
| `body` | string | Plain text; may be empty when `resolved` is set. |
| `resolved` | `true`, optional | Humans only: resolves the thread. |
| `conflict` | `true`, optional | Buddies only: part of its edit was dropped because a human changed the same text meanwhile. |
| `failed` | `true`, optional | Buddies only: its run failed; `body` is the end of the program's output. |

A comment never changes once written.

## 3. Anchors

An anchor is `{ "exact", "prefix", "suffix", "start" }` on the doc's
rendered text: the quote, up to 32 characters before and after it, and its
offset when made (a hint). Rendered text, creating an anchor and finding it
again are as in version 1 (SPEC.md §3.1–3.4).

An anchor is never rewritten. Where it is now is found by each reader. A
comment whose anchor is not found stays, shown as detached.

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
