// Talks to the doc in the doc host (src/host/doc-service.js) through the
// line the desktop app's preload gives the page (window.opendocHost).

async function call(type, arg) {
  const { result, error } = await window.opendocHost.call(type, arg);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return result;
}

export const api = {
  state: () => call('state'),
  /** An edit: operations `ops` on rev `rev` of `epoch`, named `id` in the `ops` event that tells it landed. */
  submit: ({ ops, rev, epoch, id }) => call('submit', { ops, rev, epoch, id }),
  /** Write a doc that went missing back as it is in the doc host. */
  recreate: () => call('recreate'),
  /**
   * A comment: on `anchor` (or the whole doc, for null), or a reply in `thread`.
   * Resolving a thread is an empty reply with `resolved: true`, reopening an
   * empty reply. The comments now, and its `id`.
   */
  comment: ({ thread, anchor, body, resolved }) => call('comment', { thread, anchor, body, resolved }),
  /** The doc's events: `on(name, fn)`, fn getting the event's data. */
  events() {
    const handlers = new Map();
    window.opendocHost.onEvent((name, data) => {
      for (const fn of handlers.get(name) ?? []) fn(data);
    });
    return { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]) };
  },
  /** The agent scripts: { agents: names, shipped: the names OpenDoc comes with, folder }. */
  scripts: () => call('scripts'),
  /** Write shipped agent script `name` again as it came. */
  resetScript: (name) => call('resetScript', { name }),
  /** A new buddy, the project's: { agents }. */
  createBuddy: (buddy) => call('createBuddy', { buddy }),
  /** Change buddy `name` here: { agents }. */
  updateBuddy: (id, patch) => call('updateBuddy', { id, patch }),
  /** Delete buddy `name`'s file: { agents }. */
  deleteBuddy: (id) => call('deleteBuddy', { id }),
  /** Undo the edit of buddy reply `id`: the comments now. */
  undoReply: (id) => call('undoReply', { id }),
  /** The doc's versions, oldest first (src/store/history.js). */
  history: async () => (await call('history')).versions,
  /** One version: { version, text, before }. */
  version: (id) => call('version', { id }),
  /** Put the doc back to version `id`. */
  restoreVersion: (id) => call('restoreVersion', { id }),
  saveSettings: async (patch) => (await call('saveSettings', patch)).settings,
};
