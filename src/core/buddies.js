// A buddy (spec/PROJECT.md §2): Clippy, in every doc, or a project's
// `<Name>.md` file. The file name is its name, its text who it is (`about`),
// the first line shown where there is room for one. Pure, so the doc host
// and the page check them the same way.

import { NAME_PATTERN, sameName } from './mentions.js';

/** Clippy as it ships: in every doc. Who it is is the user's to change (their own `Clippy.md`); its name is not. */
export const CLIPPY = Object.freeze({
  id: 'Clippy',
  name: 'Clippy',
  about: 'A general writing assistant that helps draft and edit docs',
  where: 'app',
});

export const BUDDY_RULES = Object.freeze({
  name: (v) => typeof v === 'string' && NAME_PATTERN.test(v),
  about: (v) => typeof v === 'string' && !v.includes('\0'),
});

export class BuddyError extends Error {
  constructor(message, code = 'bad_input') {
    super(message);
    this.code = code;
  }
}

/** Throws a BuddyError unless every key of `patch` is a buddy field with an allowed value. */
export function checkBuddyPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new BuddyError('a buddy must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(BUDDY_RULES, key)) throw new BuddyError(`unknown buddy field: ${key}`);
    if (!BUDDY_RULES[key](value)) throw new BuddyError(`invalid value for ${key}`);
  }
  return patch;
}

const FRONT = /^---\nid: (\S+)\n---\n/;

/**
 * Buddy `name` from its file's text. Its id is the one in the file's front
 * matter (`id: b_…`); a file without one is a buddy by its name.
 */
export function parseBuddy(name, text) {
  const body = text.replace(/\r\n/g, '\n');
  const id = FRONT.exec(body)?.[1];
  return { id: id ?? name, name, about: body.replace(FRONT, '').trim() };
}

const FIRST_NAMES = ['Alice', 'Ben', 'Chloe', 'Daniel', 'Emma', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack', 'Kate', 'Leo', 'Maya', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rose', 'Sam', 'Tina', 'Victor', 'Wendy', 'Zoe', 'John'];

/** A name for a new buddy: a common first name that is not in `taken`, else one with a number. */
export function defaultName(taken, random = Math.random) {
  const free = FIRST_NAMES.filter((n) => !taken.some((t) => sameName(t, n)));
  if (free.length > 0) return free[Math.floor(random() * free.length)];
  const base = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)];
  for (let i = 2; ; i++) if (!taken.some((t) => sameName(t, base + i))) return base + i;
}

/** The first line of who `buddy` is, for a name card or the @ menu. */
export const tagline = (buddy) => buddy.about.split('\n')[0];

/** A buddy's file text; its id is written unless it is its name (an old file, or Clippy). */
export const buddyText = ({ id, name, about = '' }) => `${id && id !== name ? `---\nid: ${id}\n---\n` : ''}${about.trim()}\n`;

/**
 * Each buddy's color, one of eight (spec/PROJECT.md §2), by lower-case
 * name: Clippy's is 0; another's is the one of 1–7 its name picks or, when
 * a buddy before it by name has that one, the next free one.
 */
export function colorSlots(names) {
  const slots = new Map([[CLIPPY.name.toLowerCase(), 0]]);
  const taken = new Set([0]);
  const others = [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => !slots.has(n)).sort();
  for (const name of others) {
    let slot = 1 + (fnv(name) % 7);
    for (let i = 0; i < 7 && taken.has(slot); i++) slot = 1 + (slot % 7);
    taken.add(slot);
    slots.set(name, slot);
  }
  return slots;
}

// FNV-1a, so similar names still land far apart.
function fnv(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

/**
 * The buddies a doc reaches: Clippy, as the user's `Clippy.md` among `mine`
 * says (when it says anything), then the project's by name. A project's
 * `Clippy.md` is not one.
 */
export function buddiesHere(project, mine = []) {
  const about = mine.find((b) => sameName(b.name, CLIPPY.name))?.about;
  const theirs = project.filter((b) => !sameName(b.name, CLIPPY.name)).map((b) => ({ ...b, where: 'project' }));
  return [about ? { ...CLIPPY, about } : CLIPPY, ...theirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))];
}
