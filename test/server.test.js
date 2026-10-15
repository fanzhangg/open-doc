import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { customAdapter } from '../src/server/agents/adapters.js';
import { main } from '../src/cli/main.js';
import { sidecarPath } from '../src/store/files.js';
import { SAMPLE, tempDoc } from './helpers.js';
import { applyProposal } from '../src/core/diff.js';

async function withServer(fn, content = SAMPLE) {
  const docPath = await tempDoc(content);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>opendoc</title>');
  const server = await startServer(docPath, { assetsDir });
  try {
    await fn({ server, docPath });
  } finally {
    await server.close();
  }
}

function call(server, method, path, { body, headers = {}, token = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      method,
      path,
      headers: {
        host: `127.0.0.1:${server.port}`,
        ...(token ? { 'x-opendoc-token': server.token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, raw: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const human = { name: 'fzhan', kind: 'human' };

test('the page and API require the token and our own Host', async () => {
  await withServer(async ({ server }) => {
    assert.equal((await call(server, 'GET', '/', { token: false })).status, 403);
    const page = await new Promise((resolve) => request({ port: server.port, path: `/?t=${server.token}`, headers: { host: `localhost:${server.port}` } }, resolve).end());
    assert.equal(page.statusCode, 200);
    assert.equal((await call(server, 'GET', '/api/state', { token: false })).status, 403);
    assert.equal((await call(server, 'GET', '/api/state', { headers: { host: 'evil.example:80' } })).status, 403);
    assert.equal((await call(server, 'GET', '/etc/passwd')).status, 404);
  });
});

test('bundled fonts are served from the assets fonts folder only', async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  await mkdir(join(assetsDir, 'fonts'));
  await writeFile(join(assetsDir, 'fonts', 'inter-latin-wght-normal.woff2'), 'wOF2');
  const server = await startServer(docPath, { assetsDir });
  const get = (path) => new Promise((resolve) => request({ port: server.port, path, headers: { host: `127.0.0.1:${server.port}` } }, resolve).end());
  try {
    const font = await get('/assets/fonts/inter-latin-wght-normal.woff2');
    assert.equal(font.statusCode, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal((await get('/assets/fonts/missing.woff2')).statusCode, 404);
    assert.equal((await get('/assets/fonts/..%2Findex.woff2')).statusCode, 404);
  } finally {
    await server.close();
  }
});

test('the app icon is served as the editor favicon', async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  await writeFile(join(assetsDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const server = await startServer(docPath, { assetsDir });
  try {
    const res = await new Promise((resolve) => request({ port: server.port, path: '/assets/icon.svg', headers: { host: `127.0.0.1:${server.port}` } }, resolve).end());
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/svg+xml');
  } finally {
    await server.close();
  }
});

test('state returns the doc, its hash and the sidecar', async () => {
  await withServer(async ({ server }) => {
    const { status, body } = await call(server, 'GET', '/api/state');
    assert.equal(status, 200);
    assert.equal(body.doc, 'plan.md');
    assert.equal(body.markdown, SAMPLE);
    assert.match(body.docHash, /^sha256:/);
    assert.deepEqual(body.sidecar.threads, []);
    assert.match(body.defaultName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

test('saves are conditional and byte-preserving', async () => {
  await withServer(async ({ server, docPath }) => {
    const { body: state } = await call(server, 'GET', '/api/state');
    const stale = await call(server, 'PUT', '/api/doc', { body: { markdown: 'x', baseHash: 'sha256:0' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.markdown, SAMPLE);

    // The editor reformats the link and joins the hard wrap, and edits one heading.
    const fromEditor = SAMPLE
      .replace('from the\nbeta cohort', 'from the beta cohort')
      .replace('## Risks', '## Main risks');
    const saved = await call(server, 'PUT', '/api/doc', { body: { markdown: fromEditor, baseHash: state.docHash } });
    assert.equal(saved.status, 200);
    const onDisk = await readFile(docPath, 'utf8');
    assert.equal(onDisk, SAMPLE.replace('## Risks', '## Main risks'));
    assert.notEqual(saved.body.docHash, state.docHash);
    assert.equal(saved.body.markdown, onDisk, 'the save says what is on disk now');
  });
});

test('CRLF docs stay CRLF', async () => {
  await withServer(async ({ server, docPath }) => {
    const { body: state } = await call(server, 'GET', '/api/state');
    await call(server, 'PUT', '/api/doc', { body: { markdown: '# Title\n\nNew text.\n', baseHash: state.docHash } });
    assert.equal(await readFile(docPath, 'utf8'), '# Title\r\n\r\nNew text.\r\n');
  }, '# Title\r\n\r\nOld text.\r\n');
});

test('writes need JSON from our own origin', async () => {
  await withServer(async ({ server }) => {
    const op = { type: 'join', participant: human };
    assert.equal((await call(server, 'POST', '/api/ops', { body: { op }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(server, 'POST', '/api/ops', { body: JSON.stringify({ op }), headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await call(server, 'POST', '/api/ops', { body: { op }, headers: { origin: `http://127.0.0.1:${server.port}` } })).status, 200);
  });
});

test('browser operations: always human, validated, persisted', async () => {
  await withServer(async ({ server, docPath }) => {
    const anchor = { exact: 'extra load', prefix: 'service cannot handle the ', suffix: '.', start: 150 };
    const created = await call(server, 'POST', '/api/ops', {
      body: { op: { type: 'addThread', id: 't_browser1', anchor, message: { id: 'm_browser1', author: { name: 'fzhan', kind: 'agent' }, body: '@claude?' } } },
    });
    assert.equal(created.status, 200);
    const thread = created.body.sidecar.threads[0];
    assert.equal(thread.messages[0].author.kind, 'human', 'the page cannot post as an agent');
    assert.equal(thread.anchor.exact, 'extra load');
    const stored = JSON.parse(await readFile(sidecarPath(docPath), 'utf8'));
    assert.equal(stored.threads[0].id, 't_browser1');

    const bad = [
      { type: 'setWorking', threadId: 't_browser1', by: 'fzhan', since: new Date().toISOString() },
      { type: 'addMessage', threadId: 'nope', message: { id: 'm_xxxxxx', author: human, body: 'x' } },
      { type: 'addThread', id: 't_browser2', anchor: { exact: '' }, message: { id: 'm_xxxxxx', author: human, body: 'x' } },
      { type: 'addMessage', threadId: 't_missing', message: { id: 'm_xxxxxx', author: human, body: 'x' } },
    ];
    for (const op of bad) assert.equal((await call(server, 'POST', '/api/ops', { body: { op } })).status, 400, op.type);
  });
});

test('browser operations: resolve and reopen as the human; an agent name is refused', async () => {
  await withServer(async ({ server, docPath }) => {
    await main(['comment', docPath, '@claude look', '--as', 'fzhan', '--kind', 'human'], { stdout: { write() {} }, stderr: { write() {} }, env: {} });
    await main(['reply', docPath, (await call(server, 'GET', '/api/state')).body.sidecar.threads[0].id, 'Done.', '--as', 'claude'], { stdout: { write() {} }, stderr: { write() {} }, env: {} });
    const threadId = (await call(server, 'GET', '/api/state')).body.sidecar.threads[0].id;
    const op = (body) => call(server, 'POST', '/api/ops', { body: { op: body } });
    assert.equal((await op({ type: 'resolve', threadId, by: 'claude' })).status, 400, 'claude is an agent');
    const resolved = await op({ type: 'resolve', threadId, by: 'fzhan' });
    assert.equal(resolved.body.sidecar.threads[0].status, 'resolved');
    assert.equal((await op({ type: 'reopen', threadId })).status, 400, 'reopen says who');
    assert.equal((await op({ type: 'reopen', threadId, by: 'claude' })).status, 400);
    assert.equal((await op({ type: 'reopen', threadId, by: 'fzhan' })).body.sidecar.threads[0].status, 'open');
  });
});

test('browser operations: an apply notice carries applies and edits', async () => {
  await withServer(async ({ server }) => {
    const op = (body) => call(server, 'POST', '/api/ops', { body: { op: body } });
    await op({ type: 'addThread', id: 't_apply01', anchor: null, message: { id: 'm_apply01', author: human, body: 'hello' } });
    const edit = { before: '', after: 'peak ', prefix: 'handle the extra ', suffix: 'load.', start: 126 };
    const posted = await op({ type: 'addMessage', threadId: 't_apply01', message: { id: 'm_apply02', author: human, body: "Applied claude's proposal", applies: 'm_apply01', edits: [edit] } });
    assert.equal(posted.status, 200);
    const notice = posted.body.sidecar.threads[0].messages[1];
    assert.equal(notice.applies, 'm_apply01');
    assert.deepEqual(notice.edits, [edit]);
    assert.equal(notice.author.kind, 'human');
    assert.equal((await op({ type: 'addMessage', threadId: 't_apply01', message: { id: 'm_apply03', author: human, body: 'x', applies: 'nope' } })).status, 400);
    assert.equal((await op({ type: 'addMessage', threadId: 't_apply01', message: { id: 'm_apply04', author: human, body: 'x', edits: [{ before: 'a' }] } })).status, 400);
  });
});

test('agent endpoints: statuses in state, retry, details; 404 for an agent not here', async () => {
  await withServer(async ({ server }) => {
    assert.deepEqual((await call(server, 'GET', '/api/state')).body.agents, []);
    assert.equal((await call(server, 'GET', '/api/agent?name=claude')).status, 404);
  });

  const docPath = await tempDoc();
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = customAdapter(`"${process.execPath}" -e "process.exit(0)"`);
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  try {
    const state = await call(server, 'GET', '/api/state');
    assert.equal(state.body.agents.length, 1);
    assert.equal(state.body.agents[0].name, 'claude');
    assert.equal(state.body.agents[0].state, 'ready');
    assert.equal(state.body.agents[0].presence, 'online');
    const retried = await call(server, 'POST', '/api/agent', { body: { name: 'claude', action: 'retry' } });
    assert.equal(retried.body.status.state, 'ready');
    assert.equal((await call(server, 'POST', '/api/agent', { body: { name: 'claude', action: 'pause' } })).status, 400, 'pause is gone');
    assert.equal((await call(server, 'POST', '/api/agent', { body: { name: 'claude', action: 'retry' }, token: false })).status, 403);
    const details = await call(server, 'GET', '/api/agent?name=CLAUDE');
    assert.equal(details.status, 200);
    assert.equal(typeof details.body.log, 'string');
  } finally {
    await server.close();
  }
});

test('events: hello, then sidecar and doc changes made by the CLI or on disk', { timeout: 15_000 }, async () => {
  await withServer(async ({ server, docPath }) => {
    const events = [];
    let notify = () => {};
    const req = request({ port: server.port, path: `/api/events?t=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const name = block.match(/^event: (.+)$/m)?.[1];
          if (name) events.push(name);
          notify();
        }
      });
    });
    req.end();
    const waitFor = (name) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${name} event; got ${events.join(', ')}`)), 5000);
      const check = () => {
        if (events.includes(name)) {
          clearTimeout(timer);
          resolve();
        }
      };
      notify = check;
      check();
    });

    await waitFor('hello');
    await main(['comment', docPath, 'General note', '--as', 'claude'], { stdout: { write() {} }, stderr: { write() {} }, env: {} });
    await waitFor('sidecar');
    await writeFile(docPath, SAMPLE.replace('Q4 Launch Plan', 'Q4 Plan'));
    await waitFor('doc');
    req.destroy();
  });
});

test('a doc renamed while open keeps serving from its new path', async () => {
  await withServer(async ({ server, docPath }) => {
    const { body: before } = await call(server, 'GET', '/api/state');
    const op = {
      type: 'addThread', id: 't_rename1', anchor: null,
      message: { id: 'm_rename1', author: human, body: 'keep me', createdAt: 'ignored' },
    };
    assert.equal((await call(server, 'POST', '/api/ops', { body: { op } })).status, 200);

    const newPath = join(dirname(docPath), 'launch.md');
    // A save sent while the rename runs waits for it, then lands in the new file.
    const [moved, saved] = await Promise.all([
      server.moveTo(newPath),
      call(server, 'PUT', '/api/doc', { body: { markdown: SAMPLE.replace('Q4', 'Q1'), baseHash: before.docHash } }),
    ]);
    assert.equal(moved, newPath);
    assert.equal(server.docPath(), newPath);
    assert.equal(saved.status, 200);
    assert.deepEqual((await readdir(dirname(docPath))).sort(), ['launch.md', 'launch.md.opendoc.json']);
    assert.match(await readFile(newPath, 'utf8'), /Q1 Launch Plan/);

    const { body: after } = await call(server, 'GET', '/api/state');
    assert.equal(after.doc, 'launch.md');
    assert.equal(after.sidecar.doc, 'launch.md');
    assert.equal(after.sidecar.threads[0].messages[0].body, 'keep me');
    await assert.rejects(server.moveTo(newPath), /already exists/);
  });
});

async function withSettingsServer(fn) {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html>\n<html lang="en"><title>opendoc</title></html>');
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  const server = await startServer(docPath, { assetsDir, settingsDir });
  try {
    await fn({ server, settingsDir });
  } finally {
    await server.close();
  }
}

test('settings: defaults until saved, then shared through the user file', async () => {
  await withSettingsServer(async ({ server, settingsDir }) => {
    const first = await call(server, 'GET', '/api/state');
    assert.equal(first.body.settings.font, 'sans');
    assert.equal(first.body.settings.name, null);
    assert.equal(first.body.settingsSaved, false);

    const saved = await call(server, 'PUT', '/api/settings', { body: { font: 'serif', name: 'fzhan' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.font, 'serif');
    assert.equal(saved.body.settings.name, 'fzhan');

    const again = await call(server, 'GET', '/api/settings');
    assert.equal(again.body.saved, true);
    assert.equal(again.body.settings.font, 'serif');
    const onDisk = JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8'));
    assert.equal(onDisk.font, 'serif');
  });
});

test('settings: bad patches are refused and cross-origin writes blocked', async () => {
  await withSettingsServer(async ({ server }) => {
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { font: 'comic' } })).status, 400);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { colour: 'red' } })).status, 400);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { font: 'serif' }, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { font: 'serif' }, token: false })).status, 403);
    assert.equal((await call(server, 'GET', '/api/settings')).body.saved, false);
  });
});

test('settings: the page arrives with the display settings on <html>', async () => {
  await withSettingsServer(async ({ server }) => {
    const page = () => new Promise((resolve) => request({ port: server.port, path: `/?t=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
      let html = '';
      res.on('data', (chunk) => { html += chunk; });
      res.on('end', () => resolve(html));
    }).end());
    assert.match(await page(), /<html data-font="sans" data-width="normal" lang="en">/);
    await call(server, 'PUT', '/api/settings', { body: { font: 'mono', theme: 'dark', width: 'wide', focus: true, outline: false } });
    assert.match(await page(), /<html data-font="mono" data-width="wide" data-theme="dark" data-focus data-no-outline lang="en">/);
  });
});

test('settings: a change saved by another window arrives as an event', { timeout: 15_000 }, async () => {
  await withSettingsServer(async ({ server, settingsDir }) => {
    const other = await startServer(await tempDoc(SAMPLE), { assetsDir: await mkdtemp(join(tmpdir(), 'opendoc-assets-')), settingsDir });
    const received = [];
    const req = request({ port: server.port, path: `/api/events?t=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        for (const block of chunk.split('\n\n')) {
          if (/^event: settings$/m.test(block)) received.push(JSON.parse(block.match(/^data: (.+)$/m)[1]));
        }
      });
    });
    req.end();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal((await call(other, 'PUT', '/api/settings', { body: { theme: 'light' } })).status, 200);
      const deadline = Date.now() + 5000;
      while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(received.at(-1)?.theme, 'light');
    } finally {
      req.destroy();
      await other.close();
    }
  });
});

test('a doc deleted while open: missing event, saves refused, recreate writes it back', { timeout: 15_000 }, async () => {
  await withServer(async ({ server, docPath }) => {
    const received = [];
    const req = request({ port: server.port, path: `/api/events?t=${server.token}`, headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (/^event: missing$/m.test(block)) received.push(JSON.parse(block.match(/^data: (.+)$/m)[1]));
        }
      });
    });
    req.end();
    const waitFor = async (missing) => {
      const deadline = Date.now() + 5000;
      while (received.at(-1)?.missing !== missing && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(received.at(-1)?.missing, missing);
    };
    try {
      const { body: state } = await call(server, 'GET', '/api/state');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rm(docPath);
      await waitFor(true);
      assert.equal(received.at(-1).doc, 'plan.md');

      const plain = await call(server, 'PUT', '/api/doc', { body: { markdown: '# Back\n', baseHash: state.docHash } });
      assert.equal(plain.status, 404);
      const back = await call(server, 'PUT', '/api/doc', { body: { markdown: '# Back\n', baseHash: state.docHash, recreate: true } });
      assert.equal(back.status, 200);
      assert.equal(await readFile(docPath, 'utf8'), '# Back\n');
      await waitFor(false);
    } finally {
      req.destroy();
    }
  });
});

test('recreate on a doc that is there is an ordinary conditional save', async () => {
  await withServer(async ({ server, docPath }) => {
    const stale = await call(server, 'PUT', '/api/doc', { body: { markdown: 'x', baseHash: 'sha256:0', recreate: true } });
    assert.equal(stale.status, 409);
    assert.equal(await readFile(docPath, 'utf8'), SAMPLE);
  });
});

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.js');

async function waitUntil(check, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// A server running the user's agents, from a settings.json written here (an
// agent's program can only be set outside the page): Pilot, with Auto Commenter,
// then `agents`, answering when @mentioned unless they say otherwise. Each
// runs the fake agent in `mode`, which logs to `runLog`.
async function withRoster(agents, fn, { mode = 'reply', agent, options = {} } = {}) {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  const runLog = join(settingsDir, 'runs.log');
  await writeFile(runLog, '');
  const command = `"${process.execPath}" "${FAKE_AGENT}" {threadsFile} ${mode} "${runLog}" {promptFile}`;
  const roster = [{ name: 'Pilot', autoComment: true, persona: 'You answer everything.' }, ...agents]
    .map((a, i) => ({ id: `a_test0${i}`, runtime: 'custom', command, autoComment: false, ...a }));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agents: roster }));
  const server = await startServer(docPath, { assetsDir, settingsDir, agentFromSettings: true, agent, ...options });
  const log = async () => (await readFile(runLog, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const state = async () => (await call(server, 'GET', '/api/state')).body;
  try {
    await fn({ server, docPath, settingsDir, command, log, state, runs: async () => (await log()).filter((e) => e.threads) });
  } finally {
    await server.close();
  }
}

const comment = (server, id, body) => call(server, 'POST', '/api/ops', { body: { op: { type: 'addThread', id, anchor: null, message: { id: `m_${id.slice(2)}`, author: human, body } } } });
const authorsOf = (thread) => thread.messages.slice(1).map((m) => m.author.name);

test('an agent with Auto Commenter is in every doc and answers what mentions no one; any other answers only its @mentions, which bring it in', { timeout: 30_000 }, async () => {
  await withRoster([{ name: 'helper', persona: 'You are terse.', tagline: 'Says it short' }], async ({ server, state, runs }) => {
    // The agent with Auto Commenter joins at once; the other is not in the doc yet.
    let now = await state();
    assert.deepEqual(now.agents.map((a) => [a.name, a.autoComment]), [['Pilot', true]]);
    assert.ok(now.sidecar.participants.some((p) => p.name === 'Pilot' && p.kind === 'agent'));

    // A comment for no one: the agent with Auto Commenter answers.
    await comment(server, 't_noone001', 'Is this clear?');
    assert.ok(await waitUntil(async () => (await state()).sidecar.threads[0].messages.length === 2), 'Pilot answered');
    assert.deepEqual(authorsOf((await state()).sidecar.threads[0]), ['Pilot']);

    // @helper brings it into the doc, and only it answers, in its persona.
    const posted = await comment(server, 't_helper01', '@helper shorten this');
    assert.equal(posted.status, 200);
    assert.ok(posted.body.sidecar.participants.some((p) => p.name === 'helper' && p.kind === 'agent'), 'it joined');
    assert.deepEqual(posted.body.sidecar.threads[1].messages[0].mentions, ['helper'], 'the mention counts');
    assert.ok(posted.body.agents.some((a) => a.name === 'helper' && a.autoComment === false && a.tagline === 'Says it short'));
    assert.ok(await waitUntil(async () => (await state()).sidecar.threads[1].messages.length === 2), 'helper answered');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(authorsOf((await state()).sidecar.threads[1]), ['helper'], 'Pilot left it to helper');
    assert.equal((await runs()).find((r) => r.as === 'helper').persona, 'You are terse.', 'the persona reaches the run');

    // A comment for no one still goes only to the agent with Auto Commenter.
    await comment(server, 't_noone002', 'And this?');
    assert.ok(await waitUntil(async () => (await state()).sidecar.threads[2].messages.length === 2));
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.deepEqual(authorsOf((await state()).sidecar.threads[2]), ['Pilot']);

    // Renamed: it stays in this doc under its new name.
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { name: 'editor' } } })).status, 200);
    assert.ok(await waitUntil(async () => (await state()).agents.some((a) => a.name === 'editor')), 'restarted under the new name');
    now = await state();
    assert.ok(now.sidecar.participants.some((p) => p.name === 'editor') && !now.sidecar.participants.some((p) => p.name === 'helper'));
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { name: 'fzhan' } } })).status, 400, "not the human's name");

    // Removed: it stops and leaves; its comment stays. An agent with Auto Commenter cannot be removed.
    const removed = await call(server, 'POST', '/api/agents/remove', { body: { name: 'editor' } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.agents.map((a) => a.name), ['Pilot']);
    assert.ok(!removed.body.sidecar.participants.some((p) => p.name === 'editor'));
    assert.equal(removed.body.sidecar.threads[1].messages[1].author.name, 'helper');
    assert.equal((await call(server, 'POST', '/api/agents/remove', { body: { name: 'Pilot' } })).status, 409);

    // Added back from the People panel.
    const added = await call(server, 'POST', '/api/agents/invite', { body: { id: 'a_test01' } });
    assert.equal(added.status, 200);
    assert.ok(added.body.agents.some((a) => a.name === 'editor'));
    assert.equal((await call(server, 'POST', '/api/agents/invite', { body: { id: 'a_nobody' } })).status, 404);
    assert.equal((await call(server, 'POST', '/api/agent', { body: { name: 'Pilot', action: 'presence', presence: 'dnd' } })).status, 400, 'presence is gone');
  });
});

test('several agents with Auto Commenter each answer the open comments that fit them, and pass on the rest', { timeout: 30_000 }, async () => {
  await withRoster([{ name: 'second' }], async ({ server, state }) => {
    // Switching Auto Commenter on brings an agent into the doc.
    const switched = await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { autoComment: true } } });
    assert.equal(switched.status, 200);
    assert.ok(await waitUntil(async () => (await state()).agents.some((a) => a.name === 'second' && a.autoComment)), 'second joined');
    const thread = async (id) => (await state()).sidecar.threads.find((t) => t.id === id);

    // The fake agent takes an open comment only when it names it.
    await comment(server, 't_second01', 'A job for second');
    await comment(server, 't_both0001', 'A job for pilot and second');
    await comment(server, 't_nobody01', 'A job for nobody');
    assert.ok(await waitUntil(async () => (await thread('t_both0001')).messages.length === 3, 15_000), 'both answered');
    assert.ok(await waitUntil(async () => (await thread('t_nobody01')).passed?.length === 2, 15_000), 'both passed');
    assert.deepEqual(authorsOf(await thread('t_second01')), ['second']);
    assert.deepEqual(authorsOf(await thread('t_both0001')).sort(), ['Pilot', 'second']);
    assert.deepEqual(authorsOf(await thread('t_nobody01')), []);
    assert.deepEqual((await thread('t_second01')).passed, ['Pilot']);
    assert.ok((await state()).agents.every((a) => a.state === 'ready'), 'passing is not failing');

    // A new comment in the thread asks both again.
    await call(server, 'POST', '/api/ops', { body: { op: { type: 'addMessage', threadId: 't_nobody01', message: { id: 'm_nobody02', author: human, body: 'Now for second' } } } });
    assert.ok(await waitUntil(async () => authorsOf(await thread('t_nobody01')).includes('second'), 15_000), 'second took it this time');
    assert.ok(await waitUntil(async () => (await thread('t_nobody01')).passed?.length === 1, 15_000), 'Pilot passed again');
    assert.deepEqual((await thread('t_nobody01')).passed, ['Pilot']);

    // Any agent can be deleted, even one with Auto Commenter.
    assert.equal((await call(server, 'POST', '/api/roster/delete', { body: { id: 'a_test00' } })).status, 200);
    assert.ok(await waitUntil(async () => !(await state()).agents.some((a) => a.name === 'Pilot')), 'Pilot left');
  }, { mode: 'picky' });
});

test('agents are created from the page, added at once, and deleted', { timeout: 30_000 }, async () => {
  await withRoster([], async ({ server, state }) => {
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { name: 'boss', role: 'pilot' } } })).status, 400, 'roles are gone');
    const created = await call(server, 'POST', '/api/roster', { body: { agent: { name: 'grammar', persona: 'Fix grammar only.', tagline: 'Fixes grammar' }, invite: true } });
    assert.equal(created.status, 200);
    const { agent } = created.body;
    assert.match(agent.id, /^a_/);
    assert.equal(agent.runtime, 'claude');
    assert.equal(agent.autoComment, false, 'a new agent answers when @mentioned');
    assert.ok(created.body.sidecar.participants.some((p) => p.name === 'grammar'));
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { name: 'grammar' } } })).body.agent.name, 'grammar-2', 'a free name');
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { maxTurns: 0 } } })).status, 400);

    const deleted = await call(server, 'POST', '/api/roster/delete', { body: { id: agent.id } });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.settings.agents.map((a) => a.name), ['Pilot', 'grammar-2']);
    assert.ok(!(await state()).sidecar.participants.some((p) => p.name === 'grammar'), 'it left this doc');
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agents: [] } })).status, 400, 'the roster changes only through /api/roster');
  });
});

test('several agents take turns: a comment for two gets both answers, never two runs at once', { timeout: 30_000 }, async () => {
  await withRoster([{ name: 'muse', persona: 'You are a poet.' }, { name: 'checker', persona: 'You check facts.' }], async ({ server, state, log, runs }) => {
    await comment(server, 't_both0001', '@muse @checker what do you make of this?');
    assert.ok(await waitUntil(async () => (await state()).sidecar.threads[0].messages.length === 3, 15_000), 'both answered');
    assert.deepEqual(authorsOf((await state()).sidecar.threads[0]).sort(), ['checker', 'muse']);

    // The runs did not overlap, and each had its own persona.
    const entries = await log();
    const spans = (await runs()).map((run) => ({ as: run.as, start: run.start, end: entries.find((e) => e.end && e.as === run.as && e.end >= run.start).end, persona: run.persona }));
    assert.equal(spans.length, 2);
    spans.sort((a, b) => a.start - b.start);
    assert.ok(spans[0].end <= spans[1].start, 'the second run started after the first ended');
    assert.deepEqual(spans.map((s) => [s.as, s.persona]).sort(), [['checker', 'You check facts.'], ['muse', 'You are a poet.']]);
  }, { mode: 'slow' });
});

test('an agent from flags works next to yours and cannot be removed from the page', { timeout: 30_000 }, async () => {
  await withRoster([], async ({ server, state }) => {
    assert.deepEqual((await state()).agents.map((a) => [a.name, a.source]).sort(), [['Pilot', 'roster'], ['flagbot', 'flags']]);
    assert.equal((await call(server, 'POST', '/api/agents/remove', { body: { name: 'flagbot' } })).status, 409);
  }, { agent: { name: 'flagbot', adapter: customAdapter(`"${process.execPath}" -e "process.exit(0)"`) } });
});

test("the page cannot set an agent's program, only clear it", async () => {
  await withRoster([{ name: 'helper' }], async ({ server, settingsDir, command }) => {
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { name: 'evil', runtime: 'custom', command: 'evil --do-things' } } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { command: 'evil --do-things' } } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { command } } })).status, 200, 'unchanged is fine');
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { command: null } } })).status, 200, 'clearing is fine');
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { claudeBin: 'C:\\evil.exe' } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { claudeBin: null } })).status, 200);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { codexBin: 'C:\\evil.exe' } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { codexBin: null } })).status, 200);
    assert.equal(JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8')).agents[1].command, null);
  });
});

test("what the human saves during a run is not recorded as the agent's edit", { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const runLog = join(dirname(docPath), 'runs.log');
  const adapter = customAdapter(`"${process.execPath}" "${FAKE_AGENT}" {threadsFile} edit-slow "${runLog}"`);
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  try {
    await call(server, 'POST', '/api/ops', { body: { op: { type: 'addThread', id: 't_during01', anchor: null, message: { id: 'm_during01', author: human, body: 'Mention the peak.' } } } });
    // The agent has edited; the human saves a change elsewhere before it replies.
    assert.ok(await waitUntil(async () => (await readFile(docPath, 'utf8')).includes('extra peak load')), 'the agent edited');
    const { markdown, docHash } = (await call(server, 'GET', '/api/state')).body;
    const saved = await call(server, 'PUT', '/api/doc', { body: { markdown: markdown.replace('six features', 'seven features'), baseHash: docHash } });
    assert.equal(saved.status, 200);

    assert.ok(await waitUntil(async () => server.team.get('claude').status().state === 'ready' && server.team.get('claude').status().lastRun), 'the run ended');
    const thread = (await call(server, 'GET', '/api/state')).body.sidecar.threads[0];
    const reply = thread.messages.at(-1);
    assert.equal(reply.author.name, 'claude');
    assert.deepEqual(reply.edits.map((e) => [e.before, e.after]), [['', 'peak ']]);
    assert.match(await readFile(docPath, 'utf8'), /seven features[\s\S]*extra peak load/);
  } finally {
    await server.close();
  }
});

test("the agent's text the human typed over comes back as a proposal on its comment", { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const runLog = join(dirname(docPath), 'runs.log');
  const adapter = customAdapter(`"${process.execPath}" "${FAKE_AGENT}" {threadsFile} edit-slow "${runLog}"`);
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  const agentLine = 'The main risk is that the `sync` service cannot handle the extra peak load.';
  const humanLine = 'The main risk is that the `sync` service cannot handle the extra holiday load.';
  try {
    assert.equal((await call(server, 'POST', '/api/agent/overwritten', { body: { changes: [] } })).status, 400);
    await call(server, 'POST', '/api/ops', { body: { op: { type: 'addThread', id: 't_overwr01', anchor: null, message: { id: 'm_overwr01', author: human, body: 'Mention the peak.' } } } });
    // While the run goes on, the human's unsaved line wins over the agent's and is saved.
    assert.ok(await waitUntil(async () => (await readFile(docPath, 'utf8')).includes(agentLine)), 'the agent edited');
    const { markdown, docHash } = (await call(server, 'GET', '/api/state')).body;
    assert.equal((await call(server, 'PUT', '/api/doc', { body: { markdown: markdown.replace(agentLine, humanLine), baseHash: docHash } })).status, 200);
    const offered = await call(server, 'POST', '/api/agent/overwritten', { body: { changes: [{ before: humanLine, after: agentLine }] } });
    assert.deepEqual(offered.body, { offered: true });

    // The proposal follows the agent's own reply, once the run has ended.
    assert.ok(await waitUntil(async () => (await call(server, 'GET', '/api/state')).body.sidecar.threads[0].messages.length === 3), 'the proposal was posted');
    const [, reply, offer] = (await call(server, 'GET', '/api/state')).body.sidecar.threads[0].messages;
    assert.equal(reply.body, 'Handled by fake agent');
    assert.equal(reply.edits, undefined, 'the overwritten change is not recorded as an edit');
    assert.deepEqual(offer.author, { name: 'claude', kind: 'agent' });
    assert.deepEqual(offer.proposal.map((c) => [c.before, c.after]), [[humanLine, agentLine]]);
    assert.ok(applyProposal(await readFile(docPath, 'utf8'), offer.proposal).includes(agentLine), 'applying it brings the agent\'s line back');

    // After the run, a change whose text is gone is dropped, and nothing is posted.
    assert.deepEqual((await call(server, 'POST', '/api/agent/overwritten', { body: { changes: [{ before: 'not in the doc', after: 'x' }] } })).body, { offered: true });
    assert.equal((await call(server, 'GET', '/api/state')).body.sidecar.threads[0].messages.length, 3);
  } finally {
    await server.close();
  }
});

test('typed over after the run ended: the edit leaves the reply and comes back as a proposal', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const runLog = join(dirname(docPath), 'runs.log');
  const adapter = customAdapter(`"${process.execPath}" "${FAKE_AGENT}" {threadsFile} edit "${runLog}"`);
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  const agentLine = 'The main risk is that the `sync` service cannot handle the extra peak load.';
  const humanLine = 'The main risk is that the `sync` service cannot handle the extra holiday load.';
  try {
    await call(server, 'POST', '/api/ops', { body: { op: { type: 'addThread', id: 't_overwr02', anchor: null, message: { id: 'm_overwr02', author: human, body: 'Mention the peak.' } } } });
    const thread = async () => (await call(server, 'GET', '/api/state')).body.sidecar.threads[0];
    assert.ok(await waitUntil(async () => (await thread()).messages.at(-1).edits?.length === 1 && server.team.get('claude').status().state === 'ready'), 'the run recorded its edit');
    const { markdown, docHash } = (await call(server, 'GET', '/api/state')).body;
    await call(server, 'PUT', '/api/doc', { body: { markdown: markdown.replace(agentLine, humanLine), baseHash: docHash } });
    assert.deepEqual((await call(server, 'POST', '/api/agent/overwritten', { body: { changes: [{ before: humanLine, after: agentLine }] } })).body, { offered: true });
    const [, reply, offer] = (await thread()).messages;
    assert.equal(reply.edits, undefined, 'the replaced edit is gone from the reply');
    assert.deepEqual(offer.proposal.map((c) => [c.before, c.after]), [[humanLine, agentLine]]);
  } finally {
    await server.close();
  }
});

test('the guard refuses an agent edit where the human is typing, until they stop', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = customAdapter(`"${process.execPath}" -e "process.exit(0)"`);
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter }, typingMs: 1500 });
  const { url, token } = server.team.get('claude').guard;
  const guard = async (oldString) => {
    let out = '';
    const stdout = { write: (s) => { out += s; } };
    const stdin = Readable.from([JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: docPath, old_string: oldString, new_string: 'x' } })]);
    const code = await main(['guard'], { stdout, stderr: { write() {} }, stdin, env: { OPENDOC_GUARD_URL: url, OPENDOC_GUARD_TOKEN: token } });
    assert.equal(code, 0);
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };
  try {
    // The page reports the paragraph the human is typing in, as they see it.
    const anchor = { exact: 'The main risk is that the sync service cannot handle the extra loa', prefix: 'Risks\n', suffix: '', start: 0 };
    assert.equal((await call(server, 'POST', '/api/editing', { body: { anchor } })).status, 200);

    const refused = await guard('cannot handle the extra load');
    assert.equal(refused.permissionDecision, 'deny');
    assert.match(refused.permissionDecisionReason, /typing in the paragraph that starts "The main risk is that/);
    assert.equal(await guard('ship all six features'), null, 'elsewhere is fine');
    assert.equal(await guard('not in the doc at all'), null);
    assert.equal(await server.team.get('claude').typingIn(), 'The main risk is that the sync service cannot handle the ext');

    // Only the guard token opens the guard, and the page's token does not.
    assert.equal((await call(server, 'POST', '/api/guard', { body: { oldString: 'x' } })).status, 403);

    // The human stops typing: the paragraph is free again.
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal(await guard('cannot handle the extra load'), null);
    assert.equal(await server.team.get('claude').typingIn(), null);
  } finally {
    await server.close();
  }
});
