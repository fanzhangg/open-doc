// @mentions (spec/SPEC.md §6): `@name` where the `@` starts the body or
// follows a character that is not a letter, digit, `.`, `_` or `-`, and the
// name is followed by none of a letter, digit, `_` or `-`. Names compare
// case-insensitively.

export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Where `body` mentions one of `names`: [{ start, end, name }], `start` at
 * the `@`, `name` spelled as in `names`; the longest name wins.
 */
export function mentionSpans(body, names) {
  const longestFirst = [...names].sort((a, b) => b.length - a.length);
  const spans = [];
  for (let at = body.indexOf('@'); at !== -1; at = body.indexOf('@', at + 1)) {
    if (at > 0 && /[A-Za-z0-9._-]/.test(body[at - 1])) continue;
    const rest = body.slice(at + 1);
    const name = longestFirst.find((n) => sameName(rest.slice(0, n.length), n) && !/[A-Za-z0-9_-]/.test(rest[n.length] ?? ''));
    if (name) spans.push({ start: at, end: at + 1 + name.length, name });
  }
  return spans;
}

/** Which of `names` `body` mentions, each once, in order of first appearance. */
export function parseMentions(body, names) {
  return [...new Set(mentionSpans(body, names).map((s) => s.name))];
}

export function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
