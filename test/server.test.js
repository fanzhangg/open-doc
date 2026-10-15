import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';
import { customAdapter } from '../src/server/agents/adapters.js';
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

test('agent endpoints: status in state, presence from settings, retry, details; 404 without an agent', async () => {
  await withServer(async ({ server }) => {
    assert.equal((await call(server, 'GET', '/api/state')).body.agent, null);
    assert.equal((await call(server, 'GET', '/api/agent')).status, 404);
  });

  const docPath = await tempDoc();
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const adapter = customAdapter(`"${process.execPath}" -e "process.exit(0)"`);
  const server = await startServer(docPath, { assetsDir, agent: { name: 'claude', adapter } });
  try {
    const state = await call(server, 'GET', '/api/state');
    assert.equal(state.body.agent.name, 'claude');
    assert.equal(state.body.agent.state, 'ready');
    assert.equal(state.body.agent.presence, 'online');
    // Presence is the user's setting; saving it applies at once, without a restart.
    await call(server, 'PUT', '/api/settings', { body: { agent: { presence: 'dnd' } } });
    assert.equal(server.dispatcher.status().presence, 'dnd');
    assert.equal((await call(server, 'GET', '/api/state')).body.agent.presence, 'dnd');
    await call(server, 'PUT', '/api/settings', { body: { agent: { presence: 'online' } } });
    assert.equal(server.dispatcher.status().presence, 'online');
    const retried = await call(server, 'POST', '/api/agent', { body: { action: 'retry' } });
    assert.equal(retried.body.status.state, 'ready');
    assert.equal((await call(server, 'POST', '/api/agent', { body: { action: 'pause' } })).status, 400, 'pause is gone');
    assert.equal((await call(server, 'POST', '/api/agent', { body: { action: 'retry' }, token: false })).status, 403);
    const details = await call(server, 'GET', '/api/agent');
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

test('agent from settings: starts when on, follows changes, stops when off', { timeout: 30_000 }, async () => {
  const docPath = await tempDoc(SAMPLE);
  const assetsDir = await mkdtemp(join(tmpdir(), 'opendoc-assets-'));
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  const runLog = join(settingsDir, 'runs.log');
  // The program can only be set outside the page: here, in settings.json.
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({
    agent: { enabled: true, kind: 'custom', name: 'helper', command: `"${process.execPath}" "${FAKE_AGENT}" {threadsFile} reply "${runLog}"` },
  }));
  const server = await startServer(docPath, { assetsDir, settingsDir, agentFromSettings: true });
  try {
    let state = (await call(server, 'GET', '/api/state')).body;
    assert.equal(state.agentSource, 'settings');
    assert.equal(state.agent.name, 'helper');
    assert.equal(state.agent.kind, 'custom');

    // A comment wakes the agent configured in settings, which replies through the shim.
    await call(server, 'POST', '/api/ops', { body: { op: { type: 'addThread', id: 't_settings1', anchor: null, message: { id: 'm_settings1', author: human, body: '@helper please look' } } } });
    assert.ok(await waitUntil(async () => (await call(server, 'GET', '/api/state')).body.sidecar.threads[0].messages.length === 2), 'the agent replied');

    // Changing an agent setting restarts it with the new options.
    await call(server, 'PUT', '/api/settings', { body: { agent: { name: 'helper2', editMode: 'approve' } } });
    assert.ok(await waitUntil(async () => (await call(server, 'GET', '/api/state')).body.agent?.name === 'helper2'), 'restarted with the new name');
    state = (await call(server, 'GET', '/api/state')).body;
    assert.equal(state.agent.editMode, 'approve');

    // Turning it off stops it.
    await call(server, 'PUT', '/api/settings', { body: { agent: { enabled: false } } });
    assert.ok(await waitUntil(async () => (await call(server, 'GET', '/api/state')).body.agent === null), 'stopped');
    assert.equal((await call(server, 'GET', '/api/agent')).status, 404);
  } finally {
    await server.close();
  }
});

test("agent settings: the page cannot set the agent's program, only clear it", async () => {
  await withSettingsServer(async ({ server, settingsDir }) => {
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agent: { command: 'evil --do-things' } } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agent: { bin: 'C:\evil.exe' } } })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agent: { enabled: true, maxTurns: 9 } } })).status, 200);
    await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ agent: { command: 'mybot {promptFile}' } }));
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agent: { command: 'mybot {promptFile}', kind: 'custom' } } })).status, 200, 'unchanged is fine');
    assert.equal((await call(server, 'PUT', '/api/settings', { body: { agent: { command: null } } })).status, 200, 'clearing is fine');
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

    assert.ok(await waitUntil(async () => server.dispatcher.status().state === 'ready' && server.dispatcher.status().lastRun), 'the run ended');
    const thread = (await call(server, 'GET', '/api/state')).body.sidecar.threads[0];
    const reply = thread.messages.at(-1);
    assert.equal(reply.author.name, 'claude');
    assert.deepEqual(reply.edits.map((e) => [e.before, e.after]), [['', 'peak ']]);
    assert.match(await readFile(docPath, 'utf8'), /seven features[\s\S]*extra peak load/);
  } finally {
    await server.close();
  }
});
