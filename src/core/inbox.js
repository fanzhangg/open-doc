// Who answers (docs/architecture-v2.md): a thread waits on buddy X when its
// latest message from a human @mentions X and X has not replied since. A
// comment that mentions no one asks no one; a buddy's reply asks no one.

import { sameName } from './mentions.js';

/** The names the open `thread` waits on. */
export function askedOf(thread) {
  if (thread.status !== 'open') return [];
  const at = thread.messages.findLastIndex((m) => m.author.kind === 'human');
  if (at === -1) return [];
  const later = thread.messages.slice(at + 1);
  return thread.messages[at].mentions.filter((name) => !later.some((m) => sameName(m.author.name, name)));
}

/** Threads waiting on `name`. */
export function inbox(sidecar, name) {
  return sidecar.threads.filter((t) => askedOf(t).some((n) => sameName(n, name)));
}
