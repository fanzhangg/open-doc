// A buddy (spec/PROJECT.md §2): Clippy, built into the app, or a project's
// `<Name>.md` file. The file name is its name, the first line its persona,
// the rest its instructions. Pure, so the doc host and the page check them
// the same way.

import { NAME_PATTERN, sameName } from './mentions.js';

export const MAX_PERSONA = 120;

/** Clippy: in every doc, and no one can change it. */
export const CLIPPY = Object.freeze({
  name: 'Clippy',
  persona: 'A general writing assistant that helps draft and edit docs',
  instructions: '',
  where: 'app',
});

export const BUDDY_RULES = Object.freeze({
  name: (v) => typeof v === 'string' && NAME_PATTERN.test(v),
  persona: (v) => typeof v === 'string' && v.length <= MAX_PERSONA && !/[\0\r\n]/.test(v),
  instructions: (v) => typeof v === 'string' && !v.includes('\0'),
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

/** Buddy `name` from its file's text. */
export function parseBuddy(name, text) {
  const [first, ...rest] = text.replace(/\r\n/g, '\n').split('\n');
  return { name, persona: first.trim(), instructions: rest.join('\n').trim() };
}

/** A buddy's file text. */
export function buddyText({ persona = '', instructions = '' }) {
  return instructions.trim() ? `${persona.trim()}\n\n${instructions.trim()}\n` : `${persona.trim()}\n`;
}

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

/** The buddies a doc reaches: Clippy, then the project's by name. A project's `Clippy.md` is not one. */
export function buddiesHere(project) {
  const theirs = project.filter((b) => !sameName(b.name, CLIPPY.name)).map((b) => ({ ...b, where: 'project' }));
  return [CLIPPY, ...theirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))];
}
