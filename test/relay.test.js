// A teammate's page reaching the owner's doc host through the relay
// (docs/architecture.md, Sharing): the relay run locally by wrangler
// (relay/; `npm ci --prefix relay` first), the doc host forked as in
// test/doc-host.test.js, and the page as web/relay.js and web/client.js in
// Node, then the browser build itself in Electron.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { relayHost } from '../web/relay.js';
import { createClient } from '../web/client.js';
import { launchElectron, waitFor } from '../scripts/devtools.js';
import { until } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOST = join(root, 'desktop', 'doc-host.js');
const TEXT = '# Plan\n\nShip the preview first.\n';

let relay;
let relayUrl;

before(async () => {
  const wrangler = createRequire(join(root, 'relay', 'package.json')).resolve('wrangler');
  process.env.WRANGLER_LOG ??= 'error'; // not every request
  const { unstable_startWorker } = await import(pathToFileURL(wrangler).href);
  relay = await unstable_startWorker({ config: join(root, 'relay', 'wrangler.toml'), dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false } });
  relayUrl = `ws://${(await relay.url).host}`;
});

after(() => relay?.dispose());

// A project folder holding plan.md, and a config folder for its owner.
async function project() {
  const folder = await mkdtemp(join(tmpdir(), 'opendoc-project-'));
  await writeFile(join(folder, 'plan.md'), TEXT);
  await mkdir(join(folder, '.opendoc'));
  await writeFile(join(folder, '.opendoc', 'secret.md'), 'hidden\n');
  const config = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  await writeFile(join(config, 'settings.json'), JSON.stringify({ name: 'owner', agents: [] }));
  return { folder, config, secret: `s-${Math.random().toString(36).slice(2)}` };
}

// A doc host, as the app starts it, sharing `folder`: `request(type, arg)`
// asks it as the app does.
async function startHost({ folder, config, secret }) {
  const child = fork(HOST, [], { env: { ...process.env, OPENDOC_CONFIG_DIR: config }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const asked = new Map();
  let nextId = 0;
  const ready = new Promise((done) => child.once('message', done));
  child.on('message', ({ id, result, error }) => {
    asked.get(id)?.[error ? 1 : 0](error ?? result);
    asked.delete(id);
  });
  const request = async (type, arg = {}) => {
    await ready;
    return new Promise((done, fail) => {
      const id = ++nextId;
      asked.set(id, [done, fail]);
      child.send({ id, type, ...arg });
    });
  };
  await request('share', { folder, relay: relayUrl, secret });
  return { request, kill: () => child.kill() };
}

// A teammate's page on `doc`, as web/relay.js reaches the host: `call`
// resolves to { result } or { error }, and `events` holds what it heard.
function page(secret, doc = 'plan.md') {
  const room = createHash('sha256').update(secret).digest('hex');
  const host = relayHost(new URLSearchParams({ relay: relayUrl, room, doc }));
  const events = [];
  host.onEvent((event, data) => events.push({ event, data }));
  return { call: host.call, events };
}

test('a page reads a doc through the relay as a teammate who can read, and sees the owner type', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const teammate = page(shared.secret);
    const { result: state } = await teammate.call('state');
    assert.equal(state.text, TEXT);
    assert.equal(state.level, 'read');
    assert.equal(state.me.name, 'Teammate');
    assert.notEqual(state.settings.name, 'owner', 'the owner\'s settings stay theirs');
    assert.ok(teammate.events.some((e) => e.event === 'hello'));

    // The app opens the same doc: one DocService, so the owner's typing reaches the page.
    const { docId } = await host.request('open', { docPath: join(shared.folder, 'plan.md'), folder: shared.folder });
    const owner = await host.request('call', { docId, call: 'state' });
    assert.equal(owner.epoch, state.epoch);
    await host.request('call', { docId, call: 'submit', arg: { ops: [{ from: TEXT.length, to: TEXT.length, insert: 'Then ask for feedback.\n' }], rev: owner.rev, epoch: owner.epoch, id: 'w.1' } });
    const landed = await until(() => teammate.events.find((e) => e.event === 'ops'), 'the owner\'s edit');
    assert.deepEqual(landed.data.ops, [{ from: TEXT.length, to: TEXT.length, insert: 'Then ask for feedback.\n' }]);
    assert.ok(!teammate.events.some((e) => e.event === 'settings'));

    // The project's paths are the owner's real ones only for the owner.
    assert.deepEqual((await teammate.call('open', { path: 'plan.md' })).result, { path: 'plan.md' });
  } finally {
    host.kill();
  }
});

test('every write and owner-only call from a page is forbidden, whatever who it names', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const teammate = page(shared.secret);
    const { result: state } = await teammate.call('state');
    const owner = { id: state.me.id, name: 'owner', kind: 'human', level: 'owner' };
    const calls = {
      submit: { ops: [{ from: 0, to: 0, insert: 'x' }], rev: state.rev, epoch: state.epoch, id: 'p.1' },
      recreate: {}, comment: { body: 'hi' }, restoreVersion: { id: 'x' }, undoReply: { id: 'x' },
      saveSettings: { name: 'mallory' }, createBuddy: { buddy: { name: 'Spy' } }, updateBuddy: { id: 'clippy', patch: {} },
      deleteBuddy: { id: 'x' }, scripts: {}, resetScript: { name: 'claude' },
    };
    for (const [type, arg] of Object.entries(calls)) {
      for (const sent of [arg, { ...arg, who: owner }]) {
        const { error } = await teammate.call(type, sent);
        assert.equal(error?.code, 'forbidden', `${type} ${JSON.stringify(sent)}`);
      }
    }
    // A `who` beside the request, not in its arg, changes nothing either.
    const socket = new WebSocket(`${relayUrl}/rooms/${createHash('sha256').update(shared.secret).digest('hex')}?doc=plan.md`);
    const answers = [];
    socket.addEventListener('message', ({ data }) => answers.push(JSON.parse(data)));
    await new Promise((done) => socket.addEventListener('open', done));
    socket.send(JSON.stringify({ id: 1, type: 'comment', arg: { body: 'hi' }, who: owner }));
    const answer = await until(() => answers.find((a) => a.id === 1), 'an answer');
    assert.equal(answer.error.code, 'forbidden');
    socket.close();
    assert.equal(await readFile(join(shared.folder, 'plan.md'), 'utf8'), TEXT);
  } finally {
    host.kill();
  }
});

test('a page reaches only what the project shows, and only with the host\'s secret is anyone the host', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    for (const doc of ['.opendoc/secret.md', '../plan.md', 'nothing.md']) {
      const socket = new WebSocket(`${relayUrl}/rooms/${createHash('sha256').update(shared.secret).digest('hex')}?doc=${encodeURIComponent(doc)}`);
      const messages = [];
      socket.addEventListener('message', ({ data }) => messages.push(data));
      await new Promise((done) => {
        socket.addEventListener('close', done);
        socket.addEventListener('error', done);
      });
      assert.deepEqual(messages, [], doc);
    }
    const room = createHash('sha256').update(shared.secret).digest('hex');
    const impostor = new WebSocket(`${relayUrl}/rooms/${room}?secret=guess`);
    const opened = await new Promise((done) => {
      impostor.addEventListener('open', () => done(true));
      impostor.addEventListener('error', () => done(false));
    });
    assert.equal(opened, false);
  } finally {
    host.kill();
  }
});

test('when the host goes away the page waits, and once it is back resyncs with state', async () => {
  const shared = await project();
  let host = await startHost(shared);
  try {
    const teammate = page(shared.secret);
    const { result: state } = await teammate.call('state');
    let shown = state.text;
    const client = createClient({
      view: { getText: () => shown, selection: () => null },
      call: async (type, arg) => {
        const { result, error } = await teammate.call(type, arg);
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
        return result;
      },
      show: (text) => { shown = text; },
      rules: () => [],
    });
    client.start(state);
    const hellos = () => teammate.events.filter((e) => e.event === 'hello').length;
    teammate.events.length = 0;

    host.kill();
    await until(() => teammate.events.some((e) => e.event === 'offline'), 'offline');
    await writeFile(join(shared.folder, 'plan.md'), `${TEXT}Changed while the host was away.\n`);
    host = await startHost(shared);
    await until(() => hellos() > 0, 'hello from the new host');
    await client.resync();
    assert.equal(shown, `${TEXT}Changed while the host was away.\n`);
  } finally {
    host.kill();
  }
});

test('the browser build shows the doc read only, live', async () => {
  await promisify(execFile)(process.execPath, [join(root, 'preview', 'build.js')]);
  const shared = await project();
  const host = await startHost(shared);
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-relay-page-'));
  const room = createHash('sha256').update(shared.secret).digest('hex');
  const url = new URL(`file://${join(root, 'dist', 'preview', 'team.html')}`);
  url.search = new URLSearchParams({ relay: relayUrl, room, doc: 'plan.md' }).toString();
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, RELAY_PAGE: url.href };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron(electron, [join(root, 'test', 'relay', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  try {
    const shown = await app.page('plan.md');
    const text = () => shown.evaluate(`document.querySelector('.od-stage [contenteditable]')?.innerText ?? ''`);
    await waitFor(async () => (await text()).includes('Ship the preview first.'), 30_000, 'the doc');
    assert.equal(await shown.evaluate(`document.querySelector('.od-stage [contenteditable]').contentEditable`), 'false');

    const { docId } = await host.request('open', { docPath: join(shared.folder, 'plan.md'), folder: shared.folder });
    const owner = await host.request('call', { docId, call: 'state' });
    await host.request('call', { docId, call: 'submit', arg: { ops: [{ from: TEXT.length, to: TEXT.length, insert: '\nThen ask for feedback.\n' }], rev: owner.rev, epoch: owner.epoch, id: 'w.1' } });
    await waitFor(async () => (await text()).includes('Then ask for feedback.'), 10_000, 'the owner\'s typing');
  } finally {
    await app.quit();
    host.kill();
  }
});
