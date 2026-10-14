// @mentions (SPEC.md §4).

const TOKEN = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Participant names mentioned in `body`, canonical spelling, each once, in
 * order of first appearance. `@name` that is not a participant is ignored.
 */
export function parseMentions(body, participants) {
  const byLower = new Map(participants.map((p) => [p.name.toLowerCase(), p.name]));
  const found = [];
  for (const match of body.matchAll(TOKEN)) {
    let token = match[2];
    // Sentence punctuation after a name ("@claude.") is not part of it.
    while (!byLower.has(token.toLowerCase()) && token.endsWith('.')) token = token.slice(0, -1);
    const name = byLower.get(token.toLowerCase());
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

export function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}
