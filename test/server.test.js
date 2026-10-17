import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { main } from '../src/cli/main.js';
import { sidecarPath } from '../src/store/files.js';
import { SAMPLE, tempDoc } from './helpers.js';

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

test('browser operations: resolve and reopen as the human, whatever name the page sends', async () => {
  await withServer(async ({ server, docPath }) => {
    await main(['comment', docPath, 'look', '--as', 'fzhan'], { stdout: { write() {} }, stderr: { write() {} }, env: {} });
    const threadId = (await call(server, 'GET', '/api/state')).body.sidecar.threads[0].id;
    const op = (body) => call(server, 'POST', '/api/ops', { body: { op: body } });
    const resolved = await op({ type: 'resolve', threadId, by: 'claude' });
    assert.equal(resolved.body.sidecar.threads[0].status, 'resolved');
    const { settings, defaultName } = (await call(server, 'GET', '/api/state')).body;
    assert.equal(resolved.body.sidecar.threads[0].resolvedBy, settings.name ?? defaultName, 'the human, not the name the page sent');
    assert.equal((await op({ type: 'reopen', threadId })).body.sidecar.threads[0].status, 'open');
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

// A server running the user's agents, from a settings.json written here:
// Pilot, then `agents`, each answering when @mentioned, run by the fake
// agent script.
async function withRoster(agents, fn, { options = {} } = {}) {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  process.env.FAKE_DIR = settingsDir;
  await mkdir(join(settingsDir, 'agents'));
  await writeFile(join(settingsDir, 'agents', 'fake'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGENT}"\n`, { mode: 0o755 });
  await writeFile(join(settingsDir, 'agents', 'fake.cmd'), `@"${process.execPath}" "${FAKE_AGENT}"\r\n`);
  const roster = [{ name: 'Pilot', persona: 'You answer everything.' }, ...agents].map((a, i) => ({ id: `a_test0${i}`, ...a }));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agent: 'fake', agents: roster }));
  // Pilot is in the doc already; the others come in when added or @mentioned.
  await writeFile(sidecarPath(docPath), JSON.stringify({ opendoc: 1, doc: 'plan.md', docHash: null, threads: [], participants: [{ name: 'Pilot', kind: 'agent' }] }));
  const server = await startServer(docPath, { assetsDir, settingsDir, ...options });
  const state = async () => (await call(server, 'GET', '/api/state')).body;
  const runs = async () => (await readFile(join(settingsDir, 'runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    await fn({ server, docPath, settingsDir, state, runs });
  } finally {
    await server.close();
  }
}

const comment = (server, id, body) => call(server, 'POST', '/api/ops', { body: { op: { type: 'addThread', id, anchor: null, message: { id: `m_${id.slice(2)}`, author: human, body } } } });
const authorsOf = (thread) => thread.messages.slice(1).map((m) => m.author.name);

test('the doc\'s agents answer only their @mentions, which bring them in; they can be renamed, removed and added back', { timeout: 30_000 }, async () => {
  await withRoster([{ name: 'helper', persona: 'Says it short', instructions: 'You are terse.' }], async ({ server, state, runs }) => {
    let now = await state();
    assert.deepEqual(now.agents.map((a) => [a.name, a.state]), [['Pilot', 'ready']]);

    // A comment for no one: no one answers.
    await comment(server, 't_noone001', 'Is this clear?');

    // @helper brings it into the doc, and only it answers, in its persona.
    const posted = await comment(server, 't_helper01', '@helper shorten this');
    assert.equal(posted.status, 200);
    assert.ok(posted.body.sidecar.participants.some((p) => p.name === 'helper' && p.kind === 'agent'), 'it joined');
    assert.deepEqual(posted.body.sidecar.threads[1].messages[0].mentions, ['helper'], 'the mention counts');
    assert.ok(posted.body.agents.some((a) => a.name === 'helper' && a.persona === 'Says it short'));
    assert.ok(await waitUntil(async () => (await state()).sidecar.threads[1].messages.length === 2), 'helper answered');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(authorsOf((await state()).sidecar.threads[1]), ['helper']);
    assert.deepEqual(authorsOf((await state()).sidecar.threads[0]), [], 'a comment for no one asks no one');
    assert.match((await runs())[0].prompt, /Says it short[\s\S]*You are terse\./, 'persona and instructions reach the run');

    // Renamed: it stays in this doc under its new name.
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { name: 'editor' } } })).status, 200);
    assert.ok(await waitUntil(async () => (await state()).agents.some((a) => a.name === 'editor')), 'under the new name');
    now = await state();
    assert.ok(now.sidecar.participants.some((p) => p.name === 'editor') && !now.sidecar.participants.some((p) => p.name === 'helper'));
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_test01', patch: { name: 'fzhan' } } })).status, 400, "not the human's name");

    // Removed: it leaves; its comment stays.
    const removed = await call(server, 'POST', '/api/agents/remove', { body: { name: 'editor' } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.agents.map((a) => a.name), ['Pilot']);
    assert.ok(!removed.body.sidecar.participants.some((p) => p.name === 'editor'));
    assert.equal(removed.body.sidecar.threads[1].messages[1].author.name, 'helper');

    // Added back from the People panel.
    const added = await call(server, 'POST', '/api/agents/invite', { body: { id: 'a_test01' } });
    assert.equal(added.status, 200);
    assert.ok(added.body.agents.some((a) => a.name === 'editor'));
    assert.equal((await call(server, 'POST', '/api/agents/invite', { body: { id: 'a_nobody' } })).status, 404);
  });
});

test('a doc opened with no agents starts with Clippy, under its name now; one with agents keeps its own', { timeout: 30_000 }, async () => {
  const fresh = await tempDoc(SAMPLE);
  const settled = await tempDoc(SAMPLE);
  const without = await tempDoc(SAMPLE);
  await writeFile(sidecarPath(settled), JSON.stringify({ opendoc: 1, doc: 'plan.md', docHash: null, threads: [], participants: [{ name: 'solo', kind: 'agent' }] }));
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  const others = [
    { id: 'a_scout01', name: 'scout', starred: true, persona: 'Reads first' },
    { id: 'a_auto01', name: 'chatty', starred: true, autoComment: true },
  ];
  const roster = (agents) => writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agents }));
  const participants = async (doc) => JSON.parse(await readFile(sidecarPath(doc), 'utf8')).participants.map((p) => p.name);
  const open = async (doc) => (await startServer(doc, { assetsDir, settingsDir })).close();

  await roster([{ id: 'a_default_clippy', name: 'Paperclip', starred: true, persona: 'Helps' }, ...others]);
  for (const doc of [fresh, settled]) await open(doc);
  assert.deepEqual(await participants(fresh), ['Paperclip'], 'Clippy renamed, and none of the other agents');
  assert.deepEqual(JSON.parse(await readFile(sidecarPath(fresh), 'utf8')).participants[0], { name: 'Paperclip', kind: 'agent', persona: 'Helps' });
  assert.deepEqual(await participants(settled), ['solo'], 'a doc with agents keeps them');

  await roster(others); // Clippy deleted
  await open(without);
  assert.deepEqual(await participants(without).catch(() => []), [], 'no Clippy, no one');
});

// Saves the doc as the human, and tells the server where their caret is.
function writer(server, state) {
  return {
    save: async (markdown) => {
      const { docHash } = await state();
      assert.equal((await call(server, 'PUT', '/api/doc', { body: { markdown, baseHash: docHash } })).status, 200);
    },
    typingIn: async (exact) => assert.equal((await call(server, 'POST', '/api/editing', { body: { anchor: { exact, prefix: '', suffix: '', start: 0 } } })).status, 200),
    caretIn: async (exact) => assert.equal((await call(server, 'POST', '/api/caret', { body: { anchor: exact && { exact, prefix: '', suffix: '', start: 0 } } })).status, 200),
  };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('an @mention typed in the doc is sent as the human\'s comment once they are done writing it, and the agent answers it', { timeout: 30_000 }, async () => {
  await withRoster([{ name: 'helper' }], async ({ server, state }) => {
    const { save, typingIn, caretIn } = writer(server, state);
    const threads = async () => (await state()).sidecar.threads;

    // Written over several saves: a bare @name, then an ask still being
    // written, wait; the sentence ending sends it once the paragraph is still.
    await save(`${SAMPLE}\nShip it. @helper\n`);
    await typingIn('Ship it.');
    await pause(500);
    assert.equal((await threads()).length, 0, 'a bare @name waits');
    await save(`${SAMPLE}\nShip it. @helper add the risks here\n`);
    await pause(500);
    assert.equal((await threads()).length, 0, 'not while the sentence is unfinished');
    await save(`${SAMPLE}\nShip it. @helper add the risks here.\n`);
    assert.ok(await waitUntil(async () => (await threads()).length === 1), 'sent once the sentence ends');
    let [thread] = await threads();
    assert.equal(thread.anchor.exact, '@helper add the risks here.');
    assert.deepEqual([thread.messages[0].author, thread.messages[0].mentions], [{ name: 'fzhan', kind: 'human', id: thread.messages[0].author.id }, ['helper']]);
    assert.ok((await state()).sidecar.participants.some((p) => p.name === 'helper' && p.kind === 'agent'), 'the mention brought it in');
    assert.ok(await waitUntil(async () => (await threads())[0].messages.length === 2), 'helper answered');
    assert.equal((await threads())[0].messages[1].author.name, 'helper');

    // Moving the caret to another paragraph sends an unfinished one at once.
    let doc = `${SAMPLE}\nShip it. @helper add the risks here.\n\nAlso. @helper check the dates\n`;
    await save(doc);
    await typingIn('Also.');
    await pause(400);
    assert.equal((await threads()).length, 1, 'still writing it');
    await caretIn('Q4 Launch Plan');
    assert.ok(await waitUntil(async () => (await threads()).length === 2), 'sent on moving on');
    assert.equal((await threads())[1].messages[0].body, '@helper check the dates');

    // So does a change the human saves in another paragraph.
    doc = `${doc}\nLater.\n`;
    await save(doc);
    await typingIn('Later.');
    doc = doc.replace('Later.', 'Later. @helper fix the table');
    await save(doc);
    await pause(400);
    assert.equal((await threads()).length, 2);
    doc = doc.replace('# Q4 Launch Plan', '# Q4 Launch Plan v2');
    await save(doc);
    assert.ok(await waitUntil(async () => (await threads()).length === 3), 'sent on typing elsewhere');

    // Leaving the editor sends one too.
    doc = `${doc}\nLast. @helper sum up\n`;
    await save(doc);
    await typingIn('Last.');
    await pause(400);
    assert.equal((await threads()).length, 3);
    await caretIn(null);
    assert.ok(await waitUntil(async () => (await threads()).length === 4), 'sent on leaving the editor');

    // Editing around one, or a mention in code, asks nothing new.
    await save(doc.replace('Ship it.', 'Ship it soon.').replace('risks here.', 'risks here, please.') + '\nSee `@helper` in code.\n');
    await pause(600);
    assert.equal((await threads()).length, 4);
  }, { options: { mentionSettleMs: 200, mentionIdleMs: 60_000 } });
});

test('an unfinished @mention in the doc is sent once its paragraph has been still for a while', { timeout: 30_000 }, async () => {
  await withRoster([{ name: 'helper' }], async ({ server, state }) => {
    const { save, typingIn } = writer(server, state);
    await save(`${SAMPLE}\nShip it. @helper add the risks here\n`);
    await typingIn('Ship it.');
    await pause(400);
    assert.equal((await state()).sidecar.threads.length, 0);
    assert.ok(await waitUntil(async () => (await state()).sidecar.threads.length === 1), 'sent once the paragraph is still');
  }, { options: { mentionSettleMs: 200, mentionIdleMs: 1200 } });
});

test('a new agent is its doc\'s own: saved with the doc, back when it opens, gone when removed; a cloned doc brings its agents', { timeout: 30_000 }, async () => {
  const docA = await tempDoc(SAMPLE);
  const docB = await tempDoc(SAMPLE);
  const docC = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agents: [{ id: 'a_kept01', name: 'kept', starred: true }] }));
  const roster = async () => JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8')).agents;
  const open = (doc) => startServer(doc, { assetsDir, settingsDir });
  const participant = async (doc, name) => JSON.parse(await readFile(sidecarPath(doc), 'utf8')).participants.find((p) => p.name === name);

  // Made in A: A's own, and A's sidecar says who it is.
  let server = await open(docA);
  let id;
  try {
    const made = await call(server, 'POST', '/api/roster', { body: { agent: {}, invite: true } });
    assert.equal(made.status, 200);
    id = made.body.agent.id;
    assert.deepEqual([made.body.agent.name, made.body.agent.starred], ['agent', false]);
    assert.equal((await call(server, 'GET', '/api/state')).body.docKey, made.body.agent.doc, 'it belongs to this doc');
    await call(server, 'PUT', '/api/roster', { body: { id, patch: { name: 'critic', persona: 'A tough reader' } } });
    assert.deepEqual(await participant(docA, 'critic'), { name: 'critic', kind: 'agent', persona: 'A tough reader' });
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { doc: '/x.md' } } })).status, 400, 'the page cannot pick a doc');
  } finally {
    await server.close();
  }
  assert.ok((await roster()).some((a) => a.name === 'critic'), 'closing the doc keeps it');

  // Not in B.
  server = await open(docB);
  try {
    assert.ok(!(await call(server, 'GET', '/api/state')).body.agents.some((a) => a.name === 'critic'));
    assert.equal((await call(server, 'POST', '/api/agents/invite', { body: { id } })).status, 404, 'another doc\'s own cannot be added');
    // Unstarring a starred agent not in this doc takes it out of your agents.
    assert.equal((await call(server, 'PUT', '/api/roster', { body: { id: 'a_kept01', patch: { starred: false } } })).status, 200);
    assert.ok(!(await roster()).some((a) => a.name === 'kept'));
  } finally {
    await server.close();
  }

  // Back in A, then removed: deleted.
  server = await open(docA);
  try {
    assert.ok((await call(server, 'GET', '/api/state')).body.agents.some((a) => a.name === 'critic'), 'back with the doc');
    assert.equal((await call(server, 'POST', '/api/agents/remove', { body: { name: 'critic' } })).status, 200);
    assert.ok(!(await roster()).some((a) => a.name === 'critic'), 'removing a doc\'s own deletes it');
  } finally {
    await server.close();
  }

  // A doc from elsewhere has agents this machine does not have: each is set
  // up as that doc's own, described or not.
  await writeFile(sidecarPath(docC), JSON.stringify({ opendoc: 1, doc: 'plan.md', docHash: null, threads: [],
    participants: [{ name: 'helper', kind: 'agent', persona: 'Says it short', instructions: 'Be terse.' }, { name: 'bare', kind: 'agent' }] }));
  server = await open(docC);
  try {
    const helper = (await roster()).find((a) => a.name === 'helper');
    assert.deepEqual([helper.persona, helper.instructions, helper.starred], ['Says it short', 'Be terse.', false]);
    const docKey = (await call(server, 'GET', '/api/state')).body.docKey;
    assert.equal(helper.doc, docKey);
    const bare = (await roster()).find((a) => a.name === 'bare');
    assert.deepEqual([bare.persona, bare.instructions, bare.doc], ['', '', docKey]);

    // Changed in OpenDoc: the doc says so.
    const put = (patch) => call(server, 'PUT', '/api/roster', { body: { id: helper.id, patch } });
    const mine = async () => (await roster()).find((a) => a.id === helper.id);
    assert.equal((await put({ persona: 'Says it shorter' })).status, 200);
    await new Promise((done) => setTimeout(done, 500)); // the watcher sees the sidecar change
    assert.deepEqual(await participant(docC, 'helper'), { name: 'helper', kind: 'agent', persona: 'Says it shorter', instructions: 'Be terse.' });

    // Changed outside OpenDoc: it follows the doc.
    const sidecar = JSON.parse(await readFile(sidecarPath(docC), 'utf8'));
    sidecar.participants.find((p) => p.name === 'helper').instructions = 'Say less.';
    await writeFile(sidecarPath(docC), JSON.stringify(sidecar));
    assert.ok(await waitUntil(async () => (await mine()).instructions === 'Say less.'), 'it follows the doc');
  } finally {
    await server.close();
  }
});

test('agents are created from the page, added at once, and deleted', { timeout: 30_000 }, async () => {
  await withRoster([], async ({ server, state }) => {
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { name: 'boss', role: 'pilot' } } })).status, 400, 'roles are gone');
    const created = await call(server, 'POST', '/api/roster', { body: { agent: { name: 'grammar', persona: 'Fixes grammar', instructions: 'Fix grammar only.' }, invite: true } });
    assert.equal(created.status, 200);
    const { agent } = created.body;
    assert.match(agent.id, /^a_/);
    assert.ok(created.body.sidecar.participants.some((p) => p.name === 'grammar'));
    const taken = await call(server, 'POST', '/api/roster', { body: { agent: { name: 'grammar' }, invite: true } });
    assert.deepEqual([taken.status, taken.body.error], [400, 'the name grammar is taken'], 'a name asked for is refused, not changed');
    assert.equal((await state()).settings.agents.filter((a) => a.name.startsWith('grammar')).length, 1, 'nothing saved');
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { name: 'grammar-2' } } })).body.agent.name, 'grammar-2');
    assert.equal((await call(server, 'POST', '/api/roster', { body: { agent: { editMode: 'auto' } } })).status, 400, 'permissions are gone');

    const deleted = await call(server, 'POST', '/api/roster/delete', { body: { id: agent.id } });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.settings.agents.map((a) => a.name), ['Pilot', 'grammar-2']);
    assert.ok(!(await state()).sidecar.participants.some((p) => p.name === 'grammar'), 'it left this doc');

    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agents: [] } })).status, 400, 'the roster changes only through /api/roster');
  });
});

test('a rename keeps the human one person in the doc: their comments follow the new name', async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  await writeFile(join(assetsDir, 'index.html'), '<!doctype html><title>opendoc</title>');
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  // Comments from before ids, under the name they had before renaming to Frank (kept as their face's seed).
  await main(['comment', docPath, 'first thoughts', '--as', 'fanzhang'], { stdout: { write() {} }, stderr: { write() {} }, env: {} });
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'Frank', face: 'fanzhang' }));
  const server = await startServer(docPath, { assetsDir, settingsDir });
  try {
    const humans = async () => (await call(server, 'GET', '/api/state')).body.sidecar.participants.filter((p) => p.kind === 'human');
    const [frank] = await humans();
    assert.equal(frank.name, 'Frank');
    assert.match(frank.id, /^u_/);
    assert.equal((await humans()).length, 1, 'one person, not two');

    assert.equal((await call(server, 'PUT', '/api/settings', { body: { id: 'u_someone' } })).status, 400, 'the id stays');
    await call(server, 'PUT', '/api/settings', { body: { name: 'Fan' } });
    for (let i = 0; i < 50 && (await humans())[0].name !== 'Fan'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await humans(), [{ name: 'Fan', kind: 'human', id: frank.id }]);
    const thread = (await call(server, 'GET', '/api/state')).body.sidecar.threads[0];
    assert.deepEqual(thread.messages[0].author, { name: 'Fan', kind: 'human', id: frank.id });
  } finally {
    await server.close();
  }
});

