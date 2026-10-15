// The inbox rule (SPEC.md §5).

import { sameName } from './mentions.js';
import { activeWorking } from './ops.js';

/**
 * Threads waiting on participant `name`: open, and the latest message from a
 * human (the ask) is addressed to `name` and `name` has not answered it yet,
 * or is addressed to no one and no one has answered it yet.
 *
 * The ask is addressed to the participants it mentions; one that mentions no
 * one, in a thread an agent has already answered, continues that conversation
 * and is addressed to the agent that answered last. A message addressed only
 * to someone else is for them; one addressed to several agents waits on each
 * until each has answered. Notices are skipped: undoing an edit (`undoes`) or
 * applying a proposal (`applies`) asks nobody to act. A thread `name` is
 * already working on (and not stale) is left out, so a re-armed `wait` does
 * not hand back the thread the agent is in the middle of answering.
 *
 * With `mentionsOnly`, the ask must be addressed to `name` itself: an agent
 * that answers only when called (a co-pilot) leaves open comments to others.
 */
export function inbox(sidecar, name, now = Date.now(), { mentionsOnly = false } = {}) {
  return sidecar.threads.filter((thread) => {
    if (thread.status !== 'open') return false;
    const said = thread.messages.filter((m) => !m.undoes && !m.applies);
    const at = said.findLastIndex((m) => m.author.kind === 'human');
    if (at === -1) return false;
    const since = said.slice(at + 1);
    const to = addressees(said, at);
    if (to.some((m) => sameName(m, name))) {
      if (since.some((m) => sameName(m.author.name, name))) return false;
    } else if (mentionsOnly || to.length > 0 || since.length > 0) {
      return false;
    }
    const working = activeWorking(thread, now);
    return !(working && sameName(working.by, name));
  });
}

/**
 * Whom message `at` of `said` (a thread's messages, notices left out) is
 * addressed to: the names it mentions, or else the agent that answered last
 * before it, or else no one ([]).
 */
export function addressees(said, at) {
  const ask = said[at];
  if (ask.mentions.length > 0) return ask.mentions;
  const answered = said.slice(0, at).findLast((m) => m.author.kind === 'agent');
  return answered ? [answered.author.name] : [];
}
