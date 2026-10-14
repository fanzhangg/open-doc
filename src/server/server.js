// Local editor server for one doc: static editor assets, a four-endpoint JSON
// API, and a Server-Sent Events stream of change hashes. Single user, bound to
// 127.0.0.1, every API call carries a per-run token.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpError, applyOp } from '../core/index.js';
import { NAME_PATTERN } from '../core/mentions.js';
import { StoreError, hashBytes, load, readDoc, sidecarPath, update, writeAtomic } from '../store/files.js';
import { watchDoc } from '../store/watch.js';
import { splice } from './splice.js';
import { Dispatcher } from './agents/dispatcher.js';

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
 * a headless agent run whenever a comment mentions that agent.
 * @returns {Promise<{ url: string, port: number, token: string, dispatcher: Dispatcher | null, close: () => Promise<void> }>}
 */
export async function startServer(docPath, { port = 0, token = randomBytes(16).toString('hex'), assetsDir = DEFAULT_ASSETS, agent } = {}) {
  await readDoc(docPath); // fail early on a missing doc
  const clients = new Set();
  let dispatcher = null;
  let actualPort = port;
  let lastDocHash = null;
  let lastSidecarHash = null;

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
      case 'PUT /api/doc':
        return sendJson(...(await saveDoc(await readJson(req))));
      case 'POST /api/ops':
        return sendJson(res, 200, await applyBrowserOp(await readJson(req)));
      case 'GET /api/events':
        return openEvents(req, res);
      case 'GET /api/agent':
        if (!dispatcher) throw new HttpError(404, 'no_agent', 'no agent is configured');
        return sendJson(res, 200, { status: dispatcher.status(), log: dispatcher.log() });
      case 'POST /api/agent':
        return sendJson(res, 200, { status: await agentAction(await readJson(req)) });
      default:
        throw new HttpError(404, 'not_found', 'not found');
    }

    async function saveDoc(body) {
      if (typeof body.markdown !== 'string' || typeof body.baseHash !== 'string') {
        throw new HttpError(400, 'bad_input', 'expected { markdown, baseHash }');
      }
      const current = await readDoc(docPath);
      if (current.hash !== body.baseHash) {
        return [res, 409, { code: 'conflict', markdown: current.markdown, docHash: current.hash }];
      }
      const incoming = current.markdown.includes('\r\n') ? body.markdown.replace(/\r?\n/g, '\r\n') : body.markdown;
      const next = splice(current.markdown, incoming);
      if (next !== current.markdown) {
        await writeAtomic(docPath, next);
        await update(docPath, (s) => s); // refresh anchors against the saved doc
      }
      return [res, 200, { docHash: hashBytes(Buffer.from(next)) }];
    }
  }

  async function state() {
    const { doc, sidecar } = await load(docPath);
    return {
      doc: basename(docPath),
      markdown: doc.markdown,
      docHash: doc.hash,
      sidecar,
      defaultName: defaultName(),
      agent: dispatcher?.status() ?? null,
    };
  }

  async function agentAction(body) {
    if (!dispatcher) throw new HttpError(404, 'no_agent', 'no agent is configured');
    const action = body?.action;
    if (action === 'pause') dispatcher.pause();
    else if (action === 'resume') dispatcher.resume();
    else if (action === 'retry') await dispatcher.retry();
    else throw new HttpError(400, 'bad_input', 'action must be pause, resume or retry');
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
    res.write(`event: hello\ndata: ${JSON.stringify({ docHash: lastDocHash, sidecarHash: lastSidecarHash })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  }

  // Watch both files; refresh anchors when the doc changes (the agent may
  // have edited it directly) and tell the page what changed.
  async function onFilesChanged() {
    try {
      const doc = await readDoc(docPath);
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
  lastDocHash = (await readDoc(docPath)).hash;
  lastSidecarHash = await fileHash(sidecarPath(docPath));
  const stopWatching = watchDoc(docPath, onFilesChanged);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;

  if (agent) {
    dispatcher = new Dispatcher({ docPath, ...agent, onStatus: (status) => broadcast('agent', status) });
    await dispatcher.start();
  }

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    token,
    dispatcher,
    async close() {
      clearInterval(heartbeat);
      stopWatching();
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

// The browser speaks for a human. Timestamps come from the server clock.
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
    if (m.undoes !== undefined) {
      if (!ID.m.test(m.undoes ?? '')) throw new HttpError(400, 'bad_input', 'invalid undoes');
      out.undoes = m.undoes;
    }
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
      return { type: 'resolve', threadId: threadId(op.threadId), by: human({ name: op.by }).name, at: now };
    default:
      return { type: 'reopen', threadId: threadId(op.threadId) };
  }
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
  if (error instanceof OpError) return 400;
  if (error instanceof StoreError) return error.code === 'lock_timeout' ? 409 : 404;
  return 500;
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
