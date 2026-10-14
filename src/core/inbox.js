// The inbox rule (SPEC.md §5).

import { sameName } from './mentions.js';
import { activeWorking } from './ops.js';

/**
 * Threads waiting on participant `name`: open, latest message from a human,
 * and that message mentions `name` or no one. A thread `name` is already
 * working on (and not stale) is left out, so a re-armed `wait` does not hand
 * back the thread the agent is in the middle of answering.
 *
 * With `mentionsOnly`, a message must mention `name` explicitly; this is what
 * starts an unattended agent run, so a note-to-self costs nothing.
 */
export function inbox(sidecar, name, now = Date.now(), { mentionsOnly = false } = {}) {
  return sidecar.threads.filter((thread) => {
    if (thread.status !== 'open') return false;
    const last = thread.messages.at(-1);
    if (!last || last.author.kind !== 'human') return false;
    const mentioned = last.mentions.some((m) => sameName(m, name));
    const addressed = mentioned || (!mentionsOnly && last.mentions.length === 0);
    if (!addressed) return false;
    const working = activeWorking(thread, now);
    return !(working && sameName(working.by, name));
  });
}
