// Talks to the doc in the doc host (src/host/doc-service.js) through the
// line the desktop app's preload gives the page (window.ponjoHost), or in
// a plain browser through the relay (relay.js).

import { identity } from './join.js';
import { relayHost } from './relay.js';

const host = window.ponjoHost ?? relayHost(location.origin.replace(/^http/, 'ws'), new URLSearchParams(location.search), identity);

async function call(type, arg) {
  const { result, error } = await host.call(type, arg);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return result;
}

export const api = {
  /** The doc as this page may see it; with `since` ({ epoch, rev }), the `events` missed since. */
  state: ({ since } = {}) => call('state', { since }),
  /** An edit: operations `ops` on rev `rev` of `epoch`, named `id` in the `ops` event that tells it landed. */
  submit: ({ ops, rev, epoch, id }) => call('submit', { ops, rev, epoch, id }),
  /** The person's cursor is at offset `at` of the text at rev `rev` of `epoch`. */
  cursor: ({ at, rev, epoch }) => call('cursor', { at, rev, epoch }),
  /** Write a doc that went missing back as it is in the doc host. */
  recreate: () => call('recreate'),
  /**
   * A comment: on `anchor` (or the whole doc, for null), or a reply in `thread`.
   * Resolving a thread is an empty reply with `resolved: true`, reopening an
   * empty reply. The comments now, and its `id`.
   */
  comment: ({ thread, anchor, body, resolved }) => call('comment', { thread, anchor, body, resolved }),
  /**
   * The doc's events: `on(name, fn)`, fn getting the event's data. Those
   * that came before are handed over once the handlers set up with it, in
   * the same task, are on.
   */
  events() {
    const handlers = new Map();
    queueMicrotask(() => host.onEvent((name, data) => {
      for (const fn of handlers.get(name) ?? []) fn(data);
    }));
    return { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]) };
  },
  /** How the line to the host is, for a page in a browser (relay.js `onLine`); the app's is always there. */
  line: (fn) => host.onLine?.(fn),
  /**
   * The agents: { agents: [{ id, name, about, settings }], shipped: the ids
   * Ponjo comes with, folder, secrets: which are set, { <agent>: [<key>] } }.
   */
  scripts: () => call('scripts'),
  /** Write shipped agent `name` (its program and manifest) again as it came. */
  resetScript: (name) => call('resetScript', { name }),
  /** A new buddy, the project's: { agents }. */
  createBuddy: (buddy) => call('createBuddy', { buddy }),
  /** Change buddy `name` here: { agents }. */
  updateBuddy: (id, patch) => call('updateBuddy', { id, patch }),
  /** Delete buddy `name`'s file: { agents }. */
  deleteBuddy: (id) => call('deleteBuddy', { id }),
  /** Undo version `id`, or the versions from `from` to it: the comments now. */
  undo: (id, from) => call('undo', { id, ...(from ? { from } : {}) }),
  /** What changed since you last looked: { edits, authors, head }. */
  since: () => call('since'),
  /** You have looked at the doc as version `id`. */
  seen: (id) => call('seen', { id }),
  /** The doc's versions, oldest first (src/store/history.js). */
  history: async () => (await call('history')).versions,
  /** One version: { version, text, before }. */
  version: (id) => call('version', { id }),
  /** Put the doc back to version `id`. */
  restoreVersion: (id) => call('restoreVersion', { id }),
  saveSettings: async (patch) => (await call('saveSettings', patch)).settings,
  /** What the project's folder `path` ('' for the top) holds: [{ name, folder }], subfolders first. */
  list: (path) => call('list', { path }),
  /** The project's file `path` to show read only: { text } or { problem: 'large' | 'binary' }. */
  read: (path) => call('read', { path }),
  /**
   * The owner's: the project's room, { link, locked, players: [{ id, name,
   * level }] } while it is open, else null, and changing it, each answered
   * with the room then. `level` is 'read' or 'write'.
   */
  room: () => call('room'),
  /** Open the room, with a new link. */
  openRoom: () => call('openRoom'),
  /** End the room: every page on it closes. */
  closeRoom: () => call('closeRoom'),
  lockRoom: (locked) => call('lockRoom', { locked }),
  setLevel: (id, level) => call('setLevel', { id, level }),
  /** Turn player `id` out of the room, for as long as it is open. */
  kick: (id) => call('kick', { id }),
};
