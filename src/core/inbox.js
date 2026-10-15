// The inbox rule (SPEC.md §5).

import { sameName } from './mentions.js';
import { activeWorking } from './ops.js';

/**
 * Threads waiting on participant `name`: open, and the latest message is from
 * a human and mentions `name` or no one; a message addressed only to someone
 * else is for them. Notices are skipped: undoing an edit (`undoes`) or
 * applying a proposal (`applies`) asks nobody to act. A thread `name` is
 * already working on (and not stale) is left out, so a re-armed `wait` does
 * not hand back the thread the agent is in the middle of answering.
 *
 * With `mentionsOnly`, the message must mention `name` itself: an agent set
 * to "do not disturb" answers only when it is called by name.
 */
export function inbox(sidecar, name, now = Date.now(), { mentionsOnly = false } = {}) {
  return sidecar.threads.filter((thread) => {
    if (thread.status !== 'open') return false;
    const last = thread.messages.findLast((m) => !m.undoes && !m.applies);
    if (!last || last.author.kind !== 'human') return false;
    const mentioned = last.mentions.some((m) => sameName(m, name));
    if (!mentioned && (mentionsOnly || last.mentions.length > 0)) return false;
    const working = activeWorking(thread, now);
    return !(working && sameName(working.by, name));
  });
}
