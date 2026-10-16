// The agents working on one doc: a dispatcher for each. Their runs go on at
// the same time; they share a Floor so they write the doc one at a time. The server says which agents should be
// here (`sync`): the ones started with `serve` flags, and the user's agents
// invited into the doc. The team starts, restarts and stops dispatchers to
// match, and finds the one a change on disk belongs to.

import { sameName } from '../../core/mentions.js';
import { Dispatcher, Floor } from './dispatcher.js';

export class Team {
  /**
   * `options(spec)` gives the dispatcher options every agent shares (where
   * to report status, the guard, …). `onChange()` runs when an agent joins
   * or leaves the team.
   */
  constructor({ docPath, options = () => ({}), onChange = () => {} }) {
    this.docPath = docPath;
    this.options = options;
    this.onChange = onChange;
    this.floor = new Floor(() => this.members.map((m) => m.dispatcher));
    this.members = []; // [{ key, dispatcher }]
    this.changes = Promise.resolve();
  }

  /**
   * Make the team the agents in `specs` (dispatcher options, each with a
   * `key` that changes whenever a restart is needed; a change of presence
   * (Auto Commenter) applies without one). An agent no longer wanted is
   * stopped at once, ending a run in progress; one whose settings changed
   * finishes its run first. Calls apply one at a time, in order.
   */
  sync(specs) {
    const run = this.changes.then(() => this.#sync(specs));
    this.changes = run.catch((error) => console.error('Could not update the agents:', error));
    return run;
  }

  async #sync(specs) {
    let changed = false;
    const keep = [];
    for (const member of this.members) {
      const spec = specs.find((s) => sameName(s.name, member.dispatcher.name));
      if (spec?.key === member.key) {
        const presence = spec.presence ?? 'online';
        if (presence !== member.presence) member.dispatcher.setPresence(presence);
        member.presence = presence;
        keep.push(member);
        continue;
      }
      if (spec) await member.dispatcher.drain();
      await member.dispatcher.stop();
      changed = true;
    }
    this.members = keep;
    const started = [];
    for (const spec of specs) {
      if (this.members.some((m) => sameName(m.dispatcher.name, spec.name))) continue;
      const { key, ...options } = spec;
      const dispatcher = new Dispatcher({
        docPath: this.docPath,
        floor: this.floor,
        others: () => this.members.map((m) => m.dispatcher.name).filter((n) => !sameName(n, spec.name)),
        ...this.options(spec),
        ...options,
      });
      this.members.push({ key, presence: dispatcher.presence, dispatcher });
      started.push(dispatcher);
    }
    if (changed || started.length > 0) this.onChange();
    await Promise.all(started.map((d) => d.start())); // each checks its program, which can take seconds
  }

  /** Every agent's status, in the order they joined. */
  statuses() {
    return this.members.map((m) => m.dispatcher.status());
  }

  get(name) {
    return this.members.find((m) => sameName(m.dispatcher.name, name))?.dispatcher ?? null;
  }

  /** The agent writing the doc right now (it holds the floor), if any. */
  editing() {
    const holder = this.floor.holder;
    return holder && this.members.some((m) => m.dispatcher === holder) ? holder : null;
  }

  /** The agent whose run ended last, if any. */
  lastToRun() {
    const ran = this.members.filter((m) => m.dispatcher.lastRun);
    ran.sort((a, b) => a.dispatcher.lastRun.endedAt.localeCompare(b.dispatcher.lastRun.endedAt));
    return ran.at(-1)?.dispatcher ?? null;
  }

  /** The human changed the ask of thread `threadId`: a run answering it starts over. */
  restart(threadId) {
    return this.members.some((m) => m.dispatcher.restart(threadId));
  }

  /** The sidecar changed: every agent looks for comments waiting on it. */
  notify() {
    for (const m of this.members) m.dispatcher.notify();
  }

  /** The human saved the doc from `before` to `after`: not any running agent's edit. */
  humanEdited(before, after) {
    this.floor.humanEdited(before, after);
  }

  /** Stop every agent (ending a run in progress) and forget them. */
  async stop() {
    await this.changes;
    const members = this.members;
    this.members = [];
    for (const m of members) await m.dispatcher.stop();
    if (members.length > 0) this.onChange();
  }
}
