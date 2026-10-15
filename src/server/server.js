// Local editor server for one doc: static editor assets, a small JSON API,
// and a Server-Sent Events stream of changes (doc, sidecar, agent, settings).
// Single user, bound to 127.0.0.1, every API call carries a per-run token.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpError, applyOp } from '../core/index.js';
import { NAME_PATTERN } from '../core/mentions.js';
import { AGENT_PROGRAM_KEYS, SettingsError } from '../core/settings.js';
import { StoreError, hashBytes, load, moveDoc, readDoc, sidecarPath, update, writeAtomic } from '../store/files.js';
import { configDir, readSettings, updateSettings, watchSettings } from '../store/settings.js';
import { watchDoc } from '../store/watch.js';
import { splice } from './splice.js';
import { Dispatcher } from './agents/dispatcher.js';
import { agentFromSettings } from './agents/config.js';

export const DEFAULT_ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/assets/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const FONT_PATH = /^\/assets\/fonts\/([a-z0-9-]+\.woff2)$/;
const BROWSER_OPS = new Set(['join', 'addThread', 'addMessage', 'resolve', 'reopen']);
const ID = { t: /^t_[A-Za-z0-9_-]{6,}$/, m: /^m_[A-Za-z0-9_-]{6,}$/ };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * `agent`, when given, is `{ name, adapter, limits }`: the server then starts
 * a headless agent run whenever a comment waits on that agent. Without it,
 * `agentFromSettings: true` takes the agent from the user's settings
 * (Settings > Agent) and restarts it whenever they change.
 * `settingsDir` is the folder of the user's settings file (default: the
 * per-user config folder).
 * `moveTo(newPath, move)` renames the doc while it is open (`move` defaults
 * to moveDoc and may return the final path); the page is told its new name.
 * @returns {Promise<{ url: string, port: number, token: string, dispatcher: Dispatcher | null, docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, close: () => Promise<void> }>}
 */
export async function startServer(docPath, {
  port = 0, token = randomBytes(16).toString('hex'), assetsDir = DEFAULT_ASSETS, agent: fixedAgent, agentFromSettings: useSettings = false,
  settingsDir = configDir(),
} = {}) {
  let agent = fixedAgent;
  const agentSource = fixedAgent ? 'flags' : useSettings ? 'settings' : 'none';
  await readDoc(docPath); // fail early on a missing doc
  const clients = new Set();
  let dispatcher = null;
  let actualPort = port;
  let lastDocHash = null;
  let lastSidecarHash = null;
  let lastSettings = null;
  let missing = false; // the doc was moved or deleted on disk while open
  // Writes to the doc and its sidecar run one at a time, so a rename never
  // lands in the middle of a save.
  let writes = Promise.resolve();
  const serial = (fn) => {
    const run = writes.then(fn);
    writes = run.catch(() => {});
    return run;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error.status ?? statusFor(error);
      if (status >= 500) console.error(error);
      sendJson(res, status, { error: error.message, code: error.code ?? 'internal' });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    checkHost(req, actualPort);

    const font = req.method === 'GET' && url.pathname.match(FONT_PATH);
    if (font) {
      let body;
      try {
        body = await readFile(join(assetsDir, 'fonts', font[1]));
      } catch {
        throw new HttpError(404, 'not_found', 'not found');
      }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400', ...SECURITY_HEADERS });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && ASSETS[url.pathname]) {
      if (url.pathname === '/' && !tokenMatches(url.searchParams.get('t'), token)) {
        throw new HttpError(403, 'forbidden', 'Open the link printed by "opendoc serve".');
      }
      const [file, type] = ASSETS[url.pathname];
      let body;
      try {
        body = await readFile(join(assetsDir, file));
      } catch {
        throw new HttpError(500, 'no_assets', 'Editor assets are missing; run "npm run build".');
      }
      if (file === 'index.html') body = withSettings(body.toString('utf8'), (await readSettings(settingsDir)).settings);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(body);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'not found');
    if (!tokenMatches(req.headers['x-opendoc-token'] ?? url.searchParams.get('t'), token)) {
      throw new HttpError(403, 'forbidden', 'missing or wrong token');
    }
    const route = `${req.method} ${url.pathname}`;
    if (req.method !== 'GET') checkWriteRequest(req, actualPort);

    switch (route) {
      case 'GET /api/state':
        return sendJson(res, 200, await state());
      case 'PUT /api/doc': {
        const body = await readJson(req);
        return sendJson(...(await serial(() => saveDoc(body))));
      }
      case 'POST /api/ops': {
        const body = await readJson(req);
        return sendJson(res, 200, await serial(() => applyBrowserOp(body)));
      }
      case 'GET /api/events':
        return openEvents(req, res);
      case 'GET /api/settings':
        return sendJson(res, 200, await readSettings(settingsDir));
      case 'PUT /api/settings': {
        const patch = await readJson(req);
        await checkAgentProgram(patch);
        const settings = await updateSettings(patch, settingsDir);
        setPresence(settings.agent.presence); // at once, without waiting for the file watcher
        return sendJson(res, 200, { settings });
      }
      case 'GET /api/agent':
        if (!dispatcher) throw new HttpError(404, 'no_agent', 'no agent is configured');
        return sendJson(res, 200, { status: dispatcher.status(), log: dispatcher.log() });
      case 'POST /api/agent':
        return sendJson(res, 200, { status: await agentAction(await readJson(req)) });
      case 'POST /api/agent/overwritten': {
        const changes = validChanges((await readJson(req))?.changes);
        if (!dispatcher) throw new HttpError(404, 'no_agent', 'no agent is configured');
        const offered = await serial(() => dispatcher.overwritten(changes));
        return sendJson(res, 200, { offered });
      }
      default:
        throw new HttpError(404, 'not_found', 'not found');
    }

    // `recreate: true` writes the page's text back when the doc has gone
    // missing from disk; otherwise a save needs the doc to be there.
    async function saveDoc(body) {
      if (typeof body.markdown !== 'string' || typeof body.baseHash !== 'string') {
        throw new HttpError(400, 'bad_input', 'expected { markdown, baseHash }');
      }
      let current;
      try {
        current = await readDoc(docPath);
      } catch (error) {
        if (body.recreate !== true || error.code !== 'no_doc') throw error;
        await mkdir(dirname(docPath), { recursive: true });
        await writeAtomic(docPath, body.markdown);
        await update(docPath, (s) => s); // refresh anchors if the sidecar is still there
        return [res, 200, { docHash: hashBytes(Buffer.from(body.markdown)), markdown: body.markdown }];
      }
      if (current.hash !== body.baseHash) {
        return [res, 409, { code: 'conflict', markdown: current.markdown, docHash: current.hash }];
      }
      const incoming = current.markdown.includes('\r\n') ? body.markdown.replace(/\r?\n/g, '\r\n') : body.markdown;
      const next = splice(current.markdown, incoming);
      if (next !== current.markdown) {
        await writeAtomic(docPath, next);
        dispatcher?.humanEdited(current.markdown, next); // not the agent's edit
        await update(docPath, (s) => s); // refresh anchors against the saved doc
      }
      return [res, 200, { docHash: hashBytes(Buffer.from(next)), markdown: next }];
    }
  }

  // The agent's program (a custom command, or where Claude Code is) decides
  // what runs on this machine, so a page can only clear it. Setting one takes
  // the desktop app, which asks the user first, or editing settings.json.
  async function checkAgentProgram(patch) {
    if (!patch?.agent || typeof patch.agent !== 'object') return;
    const current = (await readSettings(settingsDir)).settings.agent;
    for (const key of AGENT_PROGRAM_KEYS) {
      if (Object.hasOwn(patch.agent, key) && patch.agent[key] !== null && patch.agent[key] !== current[key]) {
        throw new HttpError(403, 'forbidden', "the agent's program can be set in the desktop app or in settings.json, not from the page");
      }
    }
  }

  async function state() {
    const { doc, sidecar } = await load(docPath);
    const { settings, saved } = await readSettings(settingsDir);
    return {
      doc: basename(docPath),
      markdown: doc.markdown,
      docHash: doc.hash,
      sidecar,
      settings,
      settingsSaved: saved,
      defaultName: defaultName(),
      agent: dispatcher?.status() ?? null,
      agentSource,
    };
  }

  async function agentAction(body) {
    if (!dispatcher) throw new HttpError(404, 'no_agent', 'no agent is configured');
    const action = body?.action;
    if (action === 'retry') await dispatcher.retry();
    else throw new HttpError(400, 'bad_input', 'action must be retry');
    return dispatcher.status();
  }

  async function applyBrowserOp(body) {
    const op = validateOp(body?.op);
    const sidecar = await update(docPath, (s) => applyOp(s, op));
    return { sidecar };
  }

  function openEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ docHash: lastDocHash, sidecarHash: lastSidecarHash, missing })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  }

  // Watch both files; refresh anchors when the doc changes (the agent may
  // have edited it directly) and tell the page what changed, including the
  // doc going missing (moved or deleted outside the app) and coming back.
  async function onFilesChanged() {
    try {
      let doc;
      try {
        doc = await readDoc(docPath);
      } catch (error) {
        if (error.code !== 'no_doc') throw error;
        if (!missing) {
          missing = true;
          broadcast('missing', { missing: true, doc: basename(docPath) });
        }
        return;
      }
      if (missing) {
        missing = false;
        broadcast('missing', { missing: false, doc: basename(docPath) });
      }
      if (doc.hash !== lastDocHash) {
        lastDocHash = doc.hash;
        await load(docPath);
        broadcast('doc', { docHash: doc.hash });
      }
      const sidecarHash = await fileHash(sidecarPath(docPath));
      if (sidecarHash !== lastSidecarHash) {
        lastSidecarHash = sidecarHash;
        broadcast('sidecar', { hash: sidecarHash });
        dispatcher?.notify();
      }
    } catch (error) {
      if (!(error instanceof StoreError)) console.error(error);
    }
  }
  // Settings are shared with every other window and `serve` run: pass on
  // changes from any of them.
  async function onSettingsChanged() {
    try {
      const { settings } = await readSettings(settingsDir);
      const json = JSON.stringify(settings);
      if (json === lastSettings) return;
      lastSettings = json;
      broadcast('settings', settings);
      setPresence(settings.agent.presence);
      if (useSettings) configureAgent(settings.agent);
    } catch (error) {
      console.error(error);
    }
  }

  async function startDispatcher() {
    dispatcher = new Dispatcher({ docPath, ...agent, presence, onStatus: (status) => broadcast('agent', status) });
    await dispatcher.start();
  }

  // Presence (online / do not disturb) is the user's, from settings, for the
  // agent of every doc (one started with flags too); it applies at once.
  let presence = 'online';
  function setPresence(next) {
    presence = next;
    dispatcher?.setPresence(next);
  }

  // Agent settings changed (or the server starts): let a run in progress
  // finish, then stop the old agent and start the new one, if any. Changes
  // apply one at a time, and settings that do not touch the agent (or only
  // its presence) do nothing.
  let agentSettings = null;
  let agentChanges = Promise.resolve();
  let closed = false;
  function configureAgent(next) {
    const json = JSON.stringify({ ...next, presence: undefined });
    if (json === agentSettings) return agentChanges;
    agentSettings = json;
    agentChanges = agentChanges.then(async () => {
      if (dispatcher) {
        const old = dispatcher;
        await old.drain();
        await old.stop();
        if (dispatcher === old) dispatcher = null;
      }
      if (closed) return;
      agent = agentFromSettings(next, docPath);
      if (agent) await startDispatcher();
      else broadcast('agent', null);
    }).catch((error) => console.error('Could not start the agent:', error));
    return agentChanges;
  }

  async function moveTo(newPath, move = moveDoc) {
    return serial(async () => {
      const target = (await move(docPath, newPath)) ?? newPath;
      stopWatching();
      await dispatcher?.stop();
      docPath = target;
      missing = false;
      stopWatching = watchDoc(docPath, onFilesChanged);
      if (useSettings && agentSettings) agent = agentFromSettings(JSON.parse(agentSettings), docPath); // hooks depend on the folder
      if (agent) await startDispatcher();
      broadcast('renamed', { doc: basename(docPath) });
      return docPath;
    });
  }

  lastDocHash = (await readDoc(docPath)).hash;
  lastSidecarHash = await fileHash(sidecarPath(docPath));
  lastSettings = JSON.stringify((await readSettings(settingsDir)).settings);
  presence = JSON.parse(lastSettings).agent.presence;
  let stopWatching = watchDoc(docPath, onFilesChanged);
  const stopWatchingSettings = watchSettings(onSettingsChanged, settingsDir);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;

  if (fixedAgent) await startDispatcher();
  else if (useSettings) await configureAgent((await readSettings(settingsDir)).settings.agent);

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    token,
    get dispatcher() {
      return dispatcher;
    },
    docPath: () => docPath,
    moveTo,
    async close() {
      clearInterval(heartbeat);
      stopWatching();
      stopWatchingSettings();
      closed = true;
      await dispatcher?.stop(); // ends a run in progress, which a pending agent change may be waiting on
      await agentChanges;
      await dispatcher?.stop();
      for (const res of clients) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

// DNS rebinding: only answer requests addressed to the loopback name we serve.
function checkHost(req, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host)) throw new HttpError(403, 'forbidden', 'unexpected Host header');
}

// Writes must come from our own page: same origin (when the browser sends
// one) and a JSON body, which a cross-site form cannot produce.
function checkWriteRequest(req, port) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    throw new HttpError(403, 'forbidden', 'cross-origin write refused');
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'bad_input', 'expected application/json');
  }
}

function tokenMatches(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

// The browser speaks for a human. Timestamps come from the server clock. A
// message may carry `edits` and `undoes` (undoing an edit) or `applies`
// (applying a proposal); the core validates their shape.
function validateOp(op) {
  if (!op || !BROWSER_OPS.has(op.type)) throw new HttpError(400, 'bad_input', `operation not allowed: ${op?.type}`);
  const now = new Date().toISOString();
  const human = (who) => {
    if (!who || !NAME_PATTERN.test(who.name ?? '')) throw new HttpError(400, 'bad_input', 'invalid name');
    return { name: who.name, kind: 'human' };
  };
  const message = (m) => {
    if (!m || !ID.m.test(m.id ?? '') || typeof m.body !== 'string') throw new HttpError(400, 'bad_input', 'invalid message');
    const out = { id: m.id, author: human(m.author), body: m.body, createdAt: now };
    for (const key of ['undoes', 'applies']) {
      if (m[key] === undefined) continue;
      if (!ID.m.test(m[key] ?? '')) throw new HttpError(400, 'bad_input', `invalid ${key}`);
      out[key] = m[key];
    }
    if (m.edits !== undefined) out.edits = m.edits;
    return out;
  };
  const threadId = (id) => {
    if (!ID.t.test(id ?? '')) throw new HttpError(400, 'bad_input', 'invalid thread id');
    return id;
  };
  switch (op.type) {
    case 'join':
      return { type: 'join', participant: human(op.participant) };
    case 'addThread':
      return { type: 'addThread', id: threadId(op.id), anchor: validAnchor(op.anchor), message: message(op.message) };
    case 'addMessage':
      return { type: 'addMessage', threadId: threadId(op.threadId), message: message(op.message) };
    case 'resolve':
      return { type: 'resolve', threadId: threadId(op.threadId), by: human({ name: op.by }).name, kind: 'human', at: now };
    default:
      return { type: 'reopen', threadId: threadId(op.threadId), by: human({ name: op.by }).name, kind: 'human' };
  }
}

// What the editor kept of the human's where the agent had changed the same
// text: [{ before: the human's text, after: the agent's }].
function validChanges(changes) {
  const text = (v) => typeof v === 'string' && v.length <= 200_000;
  const ok = Array.isArray(changes) && changes.length > 0 && changes.length <= 20
    && changes.every((c) => c && text(c.before) && c.before.length > 0 && text(c.after) && c.before !== c.after);
  if (!ok) throw new HttpError(400, 'bad_input', 'expected { changes: [{ before, after }] }');
  return changes.map(({ before, after }) => ({ before, after }));
}

function validAnchor(anchor) {
  if (anchor === null || anchor === undefined) return null;
  const ok = typeof anchor.exact === 'string' && anchor.exact.length > 0
    && typeof anchor.prefix === 'string' && anchor.prefix.length <= 32
    && typeof anchor.suffix === 'string' && anchor.suffix.length <= 32
    && Number.isInteger(anchor.start) && anchor.start >= 0;
  if (!ok) throw new HttpError(400, 'bad_input', 'invalid anchor');
  return { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix, start: anchor.start };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'bad_input', 'request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_input', 'invalid JSON');
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function statusFor(error) {
  if (error instanceof OpError || error instanceof SettingsError) return 400;
  if (error instanceof StoreError) return error.code === 'lock_timeout' ? 409 : 404;
  return 500;
}

// Put the display settings on <html> as the page would, so its first paint
// already uses them (the CSP allows no inline script to do it earlier).
// Values are validated settings, from a fixed set of words.
function withSettings(html, settings) {
  const attrs = [`data-font="${settings.font}"`, `data-width="${settings.width}"`];
  if (settings.theme !== 'system') attrs.push(`data-theme="${settings.theme}"`);
  if (settings.focus) attrs.push('data-focus');
  if (!settings.outline) attrs.push('data-no-outline');
  return html.replace(/<html\b/i, `<html ${attrs.join(' ')}`);
}

async function fileHash(path) {
  try {
    return 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

let cachedName;
function defaultName() {
  if (cachedName !== undefined) return cachedName;
  let name = '';
  try {
    name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // no git, or no name configured
  }
  if (!name) name = userInfo().username;
  cachedName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'me';
  return cachedName;
}
