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

/** The buddies a doc reaches: Clippy, then the project's by name. A project's `Clippy.md` is not one. */
export function buddiesHere(project) {
  const theirs = project.filter((b) => !sameName(b.name, CLIPPY.name)).map((b) => ({ ...b, where: 'project' }));
  return [CLIPPY, ...theirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))];
}
