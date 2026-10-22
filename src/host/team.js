// Team (docs/architecture.md, Sharing): who is on a project and what each
// may do. The owner allows, removes and sets teammates and makes the link;
// a request to join comes from the relay. The teammates are stored
// (src/store/team.js); requests waiting on the owner live in memory.

import { randomBytes } from 'node:crypto';
import { buddiesHere } from '../core/buddies.js';
import { NAME_PATTERN, sameName } from '../core/mentions.js';
import { projectBuddiesDir, readBuddies, userBuddiesDir } from '../store/buddies.js';
import { configDir, ownerOf } from '../store/settings.js';
import { readTeam, writeTeam } from '../store/team.js';

/** A Team call refused: `code` says why ('bad_input', 'not_found', 'name_taken', 'no_relay'). */
export class TeamError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const LEVELS = ['read', 'write'];

/**
 * The team of the project at real path `folder`. `linkOf(secret)` is the
 * link that names the room of `secret`; without it no link can be made.
 */
export function createTeam(folder, { settingsDir = configDir(), linkOf = null } = {}) {
  let loaded = null;
  const load = () => (loaded ??= readTeam(folder, settingsDir));
  const pending = new Map(); // id → name: asked to join, waiting on the owner
  const listeners = new Set();
  let writes = Promise.resolve();

  // Change the stored team with `fn(team)`, one change at a time, then tell the listeners.
  function change(fn) {
    const run = writes.then(async () => {
      const team = await load();
      fn(team);
      await writeTeam(folder, team, settingsDir);
    }).then(changed);
    writes = run.catch(() => {});
    return run;
  }

  function changed() {
    for (const fn of listeners) fn();
  }

  const member = async (id) => (await load()).members.find((m) => m.id === id) ?? null;

  function checkLevel(level) {
    if (!LEVELS.includes(level)) throw new TeamError('bad_input', 'a level is read or write');
  }

  // The names on the project but those of `id`: its owner's, its AI buddies', its teammates' and those asking to join.
  async function namesBut(id) {
    const buddies = buddiesHere(await readBuddies(projectBuddiesDir(folder)), await readBuddies(userBuddiesDir(settingsDir)));
    const people = [...(await load()).members, ...[...pending].map(([id, name]) => ({ id, name }))];
    return [(await ownerOf(settingsDir)).name, ...buddies.map((b) => b.name), ...people.filter((p) => p.id !== id).map((p) => p.name)];
  }

  return {
    /** { members: [{ id, name, level }], pending: [{ id, name }], link: the link, or null before the first }. */
    async list() {
      const { secret, members } = await load();
      return { members, pending: [...pending].map(([id, name]) => ({ id, name })), link: secret && linkOf ? linkOf(secret) : null };
    },
    /** The secret the link's room is made from, or null. */
    secret: async () => (await load()).secret,
    /** Teammate `id`'s level, or null for anyone not on the team. */
    levelOf: async (id) => (await member(id))?.level ?? null,
    nameOf: async (id) => (await member(id))?.name ?? null,
    isPending: (id) => pending.has(id),
    /** The teammates' names and those asking to join, which no one else on the project may take. */
    names: async () => [...(await load()).members.map((m) => m.name), ...pending.values()],
    /**
     * Someone opened the link as `id` (made once in their browser), called
     * `name`: 'member' when they are on the team, 'waiting' when they asked
     * before, else 'asked': they wait on the owner. A name taken on the
     * project is refused.
     */
    async join({ id, name }) {
      if (typeof id !== 'string' || !id) throw new TeamError('bad_input', 'a teammate needs an id');
      if (await member(id)) return 'member';
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new TeamError('bad_input', 'a teammate needs a name');
      if ((await namesBut(id)).some((n) => sameName(n, name))) throw new TeamError('name_taken', `the name ${name} is taken here`);
      const before = pending.get(id);
      pending.set(id, name);
      if (before !== name) changed();
      return before === undefined ? 'asked' : 'waiting';
    },
    /** Let in `id`, who asked to join, at `level`. */
    async allow(id, level) {
      checkLevel(level);
      if (!pending.has(id)) throw new TeamError('not_found', 'no one by that id asks to join');
      const name = pending.get(id);
      await change((team) => {
        pending.delete(id);
        team.members = [...team.members.filter((m) => m.id !== id), { id, name, level }];
      });
    },
    /** Take `id` off the team, or turn down their request. */
    async remove(id) {
      if (pending.delete(id)) return changed();
      if (!(await member(id))) throw new TeamError('not_found', 'no teammate by that id');
      await change((team) => {
        team.members = team.members.filter((m) => m.id !== id);
      });
    },
    async set(id, { level } = {}) {
      checkLevel(level);
      if (!(await member(id))) throw new TeamError('not_found', 'no teammate by that id');
      await change((team) => {
        team.members = team.members.map((m) => (m.id === id ? { ...m, level } : m));
      });
    },
    /** A new link: every one before it ends. */
    async link() {
      if (!linkOf) throw new TeamError('no_relay', 'sharing needs a relay: set PONJO_RELAY');
      await change((team) => {
        team.secret = randomBytes(24).toString('base64url');
      });
    },
    /** Call `fn()` whenever the team changes; returns how to stop. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
