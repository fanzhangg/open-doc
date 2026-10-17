// Talks to the doc in the doc host (src/host/doc-service.js) through the
// line the desktop app's preload gives the page (window.opendocHost).

async function call(type, arg) {
  const { result, error } = await window.opendocHost.call(type, arg);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return result;
}

// A save or a restore answers `conflict` when the doc is no longer at the
// hash it was based on: { status: 409 }, with the doc as it is.
const saved = (result) => ({ status: result.conflict ? 409 : 200, data: result });

export const api = {
  state: () => call('state'),
  saveDoc: async (markdown, baseHash, { recreate = false } = {}) => saved(await call('saveDoc', { markdown, baseHash, ...(recreate ? { recreate } : {}) })),
  op: (op) => call('op', { op }),
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
  /** Invite agent `id` (from the user's agents) into the doc: { sidecar, agents }. */
  invite: (id) => call('invite', { id }),
  /** Remove agent `name` from the doc: { sidecar, agents }. */
  removeAgent: (name) => call('removeAgent', { name }),
  /** A new agent for the user, invited into this doc with `invite`: { agent, settings, sidecar?, agents? }. */
  createAgent: (agent, { invite = false } = {}) => call('createAgent', { agent, invite }),
  /** Change the user's agent `id`: { settings, agents }. */
  updateAgent: (id, patch) => call('updateAgent', { id, patch }),
  /** Delete the user's agent `id` (it leaves this doc too): { settings, agents }. */
  deleteAgent: (id) => call('deleteAgent', { id }),
  /** The doc's versions, oldest first (src/store/history.js). */
  history: async () => (await call('history')).versions,
  /** One version: { version, markdown, before }. */
  version: (id) => call('version', { id }),
  /** Put the doc back to version `id`; 409 when the doc is no longer at `baseHash`. */
  restoreVersion: async (id, baseHash) => saved(await call('restoreVersion', { id, baseHash })),
  saveSettings: async (patch) => (await call('saveSettings', patch)).settings,
};
