// Room (docs/architecture.md, Sharing): a project's room while its owner
// hosts it, in the doc host's memory only: whether it is locked, its
// players and the ids kicked out of it. It dies when it closes; nothing of
// it is ever written.

import { randomBytes } from 'node:crypto';
import { buddiesHere } from '../core/buddies.js';
import { NAME_PATTERN, sameName } from '../core/mentions.js';
import { projectBuddiesDir, readBuddies, userBuddiesDir } from '../store/buddies.js';
import { configDir, ownerOf } from '../store/settings.js';

/** A Room call refused: `code` says why ('bad_input', 'not_found', 'no_relay', 'offline', 'closed', 'locked', 'kicked'). */
export class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const LEVELS = ['read', 'write'];

/**
 * The room of the project at real path `folder`, closed until `open()`.
 * `host(secret)` puts a room on the relay (desktop/doc-host.js): { link,
 * joined: resolves once the host is in, rejects if it cannot get in;
 * stop(reason) }; without it no room opens.
 */
export function createRoom(folder, { settingsDir = configDir(), host = null } = {}) {
  let room = null; // { line, locked, players: Map(id → { name, level }), kicked: Set(id) } while open
  const listeners = new Set();
  const changed = () => {
    for (const fn of listeners) fn();
  };
  const playerOf = (id) => {
    const player = room?.players.get(id);
    if (!player) throw new RoomError('not_found', 'no player by that id');
    return player;
  };

  // The names on the project that are no player's: its owner's and its AI buddies'.
  async function othersNames() {
    const buddies = buddiesHere(await readBuddies(projectBuddiesDir(folder)), await readBuddies(userBuddiesDir(settingsDir)));
    return [(await ownerOf(settingsDir)).name, ...buddies.map((b) => b.name)];
  }

  return {
    /** { link, locked, players: [{ id, name, level }] } while open, else null. */
    list: () => room && { link: room.line.link, locked: room.locked, players: [...room.players].map(([id, p]) => ({ id, ...p })) },
    /** Open the room, with a new secret, once the host is in it on the relay. */
    async open() {
      if (room) return;
      if (!host) throw new RoomError('no_relay', 'sharing needs a relay: set PONJO_RELAY');
      const opening = { line: host(randomBytes(24).toString('base64url')), locked: false, players: new Map(), kicked: new Set() };
      room = opening;
      try {
        await opening.line.joined;
      } catch {
        if (room === opening) room = null;
        opening.line.stop();
        throw new RoomError('offline', 'Cannot reach the relay: try again');
      }
      changed();
    },
    /** End the room: every page is turned away, `closed`; resolves once the relay has that. */
    close() {
      if (!room) return;
      const stopping = room.line.stop('closed');
      room = null;
      changed();
      return stopping;
    },
    /** Lock the room (no one new gets in) or unlock it. */
    lock(locked) {
      if (!room) throw new RoomError('closed', 'no room is open');
      room.locked = Boolean(locked);
      changed();
    },
    setLevel(id, level) {
      if (!LEVELS.includes(level)) throw new RoomError('bad_input', 'a level is read or write');
      playerOf(id).level = level;
      changed();
    },
    /** Turn player `id` out: their pages close, and that id cannot come back to this room. */
    kick(id) {
      playerOf(id);
      room.players.delete(id);
      room.kicked.add(id);
      changed();
    },
    /**
     * A page opened the link as `id` (made once in its browser), called
     * `name`: a player already is in at once, even in a locked room; anyone
     * else joins at Edit, unless the room is locked or kicked them, their
     * name numbered if someone on the project has it (`Alice2`).
     */
    async join({ id, name }) {
      if (typeof id !== 'string' || !id) throw new RoomError('bad_input', 'a player needs an id');
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new RoomError('bad_input', 'a player needs a name');
      const taken = await othersNames();
      if (!room) throw new RoomError('closed', 'no room is open');
      if (room.kicked.has(id)) throw new RoomError('kicked', 'kicked out of this room');
      if (room.players.has(id)) return;
      if (room.locked) throw new RoomError('locked', 'the room is locked');
      taken.push(...[...room.players.values()].map((p) => p.name));
      let free = name;
      for (let k = 2; taken.some((n) => sameName(n, free)); k++) free = `${name.slice(0, 64 - String(k).length)}${k}`;
      room.players.set(id, { name: free, level: 'write' });
      changed();
    },
    /** Player `id`'s level, or null for anyone not in the room. */
    levelOf: (id) => room?.players.get(id)?.level ?? null,
    nameOf: (id) => room?.players.get(id)?.name ?? null,
    /** The players' names, which no one else on the project may take. */
    names: () => (room ? [...room.players.values()].map((p) => p.name) : []),
    /** Call `fn()` whenever the room changes; returns how to stop. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
