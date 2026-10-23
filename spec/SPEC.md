# Comments format — version 3

Ponjo is the reference implementation.

The sidecar holds a doc's comments and nothing else. Buddies, their runs
and versions are not part of the format (see
[architecture](../docs/architecture.md)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Files

- A doc is a text file `X`, of any format. Its comments live in
  `X.comments.jsonl` next to it; nothing of them goes into the doc.
- A doc's **text** is its bytes decoded as UTF-8, without a leading byte
  order mark, with every CRLF or lone CR as LF. Anchors (§3) are on this
  text. A tool MUST NOT write a doc whose bytes are not UTF-8. It SHOULD
  write a doc back with the byte order mark it had, each line it kept
  ending as it did and a new line as the line before it
  ([fixtures](conformance/doc-text.json)).
- The sidecar is created with the first comment. A sidecar whose doc is
  missing is orphaned: tools report it and MUST NOT delete it on their own.
- Renaming a doc renames its sidecar.
- Comments may be private and a repo public. A tool SHOULD, before writing a
  sidecar inside a git work tree, add `*.comments.jsonl` to the repo's
  `info/exclude`, so a stray `git add .` does not publish them. Sharing
  comments is then a choice: add `!*.comments.jsonl` after it.
- A sidecar of another version is not converted (§2).
- In git, `*.comments.jsonl merge=union` SHOULD be set.

## 2. Comments

UTF-8 text, one JSON object per line, `\n` after each. The first line is
`{"comments":3}`; a tool MUST NOT write a sidecar whose first line is not,
and MAY show its comments read-only. Every other line is a comment. A tool
MUST keep fields it does not understand.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `c_` + at least 6 characters from `[A-Za-z0-9_-]`. The first comment's id is also its thread's id. |
| `thread` | string, optional | The first comment of the thread this one replies in. Absent on a first comment. |
| `anchor` | object or null, optional | On a first comment: the text it is about (§3); absent or `null` for a comment on the whole doc. On a buddy's reply whose edit rewrote that text: where the text is now (§3). |
| `by` | object | `{ "id", "name", "kind": "human" \| "ai" }`. The `id` is random and stays when the name changes: a human's is in their settings, a buddy's in its file ([PROJECT §2](PROJECT.md)); a buddy file without one is a buddy whose `id` is its name. The `name` is only what it was called then. |
| `at` | string | When it was written, RFC 3339 UTC. A buddy's reply and comments: just after the latest comment of the thread it answered, as its run saw it. |
| `body` | string | Plain text; may be empty on a reply (it resolves or reopens), or when `resolved` is set. |
| `resolved` | `true`, optional | Resolves the thread. Who may is not in the file: the app that writes it decides. |
| `failed` | `true`, optional | Buddies only: its run failed; `body` is the end of the program's output. |

A comment never changes once written.

## 3. Anchors

An anchor is `{ "exact", "prefix", "suffix", "start" }` on the doc's text
(§1): the quote, non-empty; up to 32 characters before and after it; and its
offset when made, a hint. This follows the W3C Web
Annotation `TextQuoteSelector` plus a `TextPositionSelector` start hint.

An anchor is never rewritten. Each reader finds it in the doc's text as
it is now, in its own way: the format does not say how. A thread is on
the latest anchor among its comments: a buddy's reply whose edit rewrote
the thread's text carries one on the text it put there, as found right
after its edit, since its quote alone may no longer be found. A comment
whose anchor is not found stays, shown as detached.

### 3.1 Creating an anchor

Given a selection `[start, end)` in the doc's text, `exact` is
`text[start:end]`, `prefix` is the up to 32 characters before it, `suffix` the
up to 32 after it, and `start` is `start`.

## 4. Reading

1. Lines with the same `id` are the same comment (a git merge may keep two);
   keep the first.
2. A thread is its first comment and the comments whose `thread` is its id,
   ordered by `at`, then `id`. A reply whose first comment is missing is
   hidden.
3. A thread is resolved when its latest comment has `resolved`: any comment
   without it reopens the thread, whoever writes it. (Before, only a
   human's comment counted, so in an older file a buddy's reply in a
   resolved thread now reopens it.)
4. A human is shown by the name in their latest comment; a buddy, by the name of its file now (the `name` in its comment when it has none here).
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
case-insensitively, among the buddies the doc reaches, as it is now called: a mention
is read as that buddy's `id`, so an `@name` of a name it no longer has mentions no one.

## 7. Trust

A sidecar is plain shared text: anyone who can change the file can write
anything in it, and `by` is only what its writer says. A tool runs a buddy
only for a comment whose `by.id` is its own user's.
