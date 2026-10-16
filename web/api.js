// Talks to the local opendoc server. The per-run token comes from the URL
// the CLI opened.

const token = new URLSearchParams(location.search).get('t') ?? '';

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: { 'x-opendoc-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 409) {
    throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { code: data.code, status: response.status });
  }
  return { status: response.status, data };
}

// A 409 is an answer for saves; elsewhere it is an error.
function okData({ status, data }) {
  if (status === 409) throw Object.assign(new Error(data.error ?? 'conflict'), { code: data.code, status });
  return data;
}

export const api = {
  state: async () => (await request('GET', '/api/state')).data,
  saveDoc: (markdown, baseHash, { recreate = false } = {}) => request('PUT', '/api/doc', { markdown, baseHash, ...(recreate ? { recreate } : {}) }),
  op: async (op) => (await request('POST', '/api/ops', { op })).data,
  events: () => new EventSource(`/api/events?t=${encodeURIComponent(token)}`),
  /** 'retry' agent `name`, or set its 'presence' ({ presence: 'online' | 'dnd' }); resolves to its status. */
  agentAction: async (name, action, extra = {}) => (await request('POST', '/api/agent', { name, action, ...extra })).data.status,
  /** Agent `name`'s status and last run log. */
  /** Whether Claude Code and Codex work: { claude, codex }, each from programStatus. */
  programs: async () => (await request('GET', '/api/programs')).data.programs,
  /** Check one program again; this doc's agents that could not start on it try again. */
  checkProgram: async (kind) => (await request('POST', '/api/programs/check', { kind })).data,
  agentDetails: async (name) => (await request('GET', `/api/agent?name=${encodeURIComponent(name)}`)).data,
  /** Invite agent `id` (from the user's agents) into the doc: { sidecar, agents }. */
  invite: async (id) => okData(await request('POST', '/api/agents/invite', { id })),
  /** Remove agent `name` from the doc: { sidecar, agents }. */
  removeAgent: async (name) => okData(await request('POST', '/api/agents/remove', { name })),
  /** A new agent for the user, invited into this doc with `invite`: { agent, settings, sidecar?, agents? }. */
  createAgent: async (agent, { invite = false } = {}) => okData(await request('POST', '/api/roster', { agent, invite })),
  /** Change the user's agent `id`: { settings, agents }. */
  updateAgent: async (id, patch) => okData(await request('PUT', '/api/roster', { id, patch })),
  /** Delete the user's agent `id` (it leaves this doc too): { settings, agents }. */
  deleteAgent: async (id) => okData(await request('POST', '/api/roster/delete', { id })),
  /** The human is typing in the block `anchor` points at (an anchor on the rendered text). */
  typing: (anchor) => request('POST', '/api/editing', { anchor }),
  /** The caret moved to the block `anchor` points at, or out of the doc (null). */
  caret: (anchor) => request('POST', '/api/caret', { anchor }),
  /** Offer back changes of agent `name` the human's text was kept over: [{ before, after }]. */
  agentOverwritten: async (name, changes) => (await request('POST', '/api/agent/overwritten', { name, changes })).data.offered,
  /** The doc's versions, oldest first (src/store/history.js). */
  history: async () => (await request('GET', '/api/history')).data.versions,
  /** One version: { version, markdown, before }. */
  version: async (id) => (await request('GET', `/api/history/version?id=${encodeURIComponent(id)}`)).data,
  /** Put the doc back to version `id`; 409 when the doc is no longer at `baseHash`. */
  restoreVersion: (id, baseHash) => request('POST', '/api/history/restore', { id, baseHash }),
  async saveSettings(patch) {
    const { status, data } = await request('PUT', '/api/settings', patch);
    if (status !== 200) throw Object.assign(new Error(data.error ?? 'settings are busy'), { code: data.code, status });
    return data.settings;
  },
};
