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

export const api = {
  state: async () => (await request('GET', '/api/state')).data,
  saveDoc: (markdown, baseHash) => request('PUT', '/api/doc', { markdown, baseHash }),
  op: async (op) => (await request('POST', '/api/ops', { op })).data,
  events: () => new EventSource(`/api/events?t=${encodeURIComponent(token)}`),
};
