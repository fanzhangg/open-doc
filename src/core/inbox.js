// The inbox rule (SPEC.md §5).

import { sameName } from './mentions.js';
import { activeWorking } from './ops.js';

/**
 * Threads waiting on participant `name`: open, latest message from a human,
 * and that message mentions `name` or no one. A thread `name` is already
 * working on (and not stale) is left out, so a re-armed `wait` does not hand
 * back the thread the agent is in the middle of answering.
 */
export function inbox(sidecar, name, now = Date.now()) {
  return sidecar.threads.filter((thread) => {
    if (thread.status !== 'open') return false;
    const last = thread.messages.at(-1);
    if (!last || last.author.kind !== 'human') return false;
    const addressed = last.mentions.length === 0 || last.mentions.some((m) => sameName(m, name));
    if (!addressed) return false;
    const working = activeWorking(thread, now);
    return !(working && sameName(working.by, name));
  });
}
