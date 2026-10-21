// A teammate's page reaching the owner's doc host through the relay
// (docs/architecture.md, Sharing), run locally (test/relay/harness.js): the
// page as web/relay.js and web/client.js in Node, then the browser build
// itself in Electron.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '../web/client.js';
import { launchElectron, waitFor } from '../scripts/devtools.js';
import { until } from './helpers.js';
import { page as teammatePage, project as newProject, roomOf, startHost as hostOn, startRelay } from './relay/harness.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEXT = '# Plan\n\nShip the preview first.\n';

let relay;
before(async () => {
  relay = await startRelay();
});
after(() => relay?.stop());

const project = () => newProject(TEXT);
const startHost = (shared) => hostOn(shared, relay.url);
const page = (secret, doc) => teammatePage(relay.url, secret, doc);

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
    const socket = new WebSocket(`${relay.url}/rooms/${roomOf(shared.secret)}?doc=plan.md`);
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

test('a page reaches only what the project shows, and is told why not; only with the host\'s secret is anyone the host', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    for (const doc of ['.opendoc/secret.md', '../plan.md', 'nothing.md']) {
      const turnedAway = page(shared.secret, doc);
      const { error } = await turnedAway.call('state');
      assert.equal(error.code, 'not_found', doc);
      assert.equal(error.message, 'This doc is not in the shared project');
      assert.deepEqual(turnedAway.lines, ['refused']);
      assert.deepEqual(turnedAway.events, [], doc);
    }
    const room = roomOf(shared.secret);
    const impostor = new WebSocket(`${relay.url}/rooms/${room}?secret=guess`);
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
    await until(() => teammate.lines.includes('host'), 'the page told the host went away');
    await writeFile(join(shared.folder, 'plan.md'), `${TEXT}Changed while the host was away.\n`);
    host = await startHost(shared);
    await until(() => hellos() > 0, 'hello from the new host');
    await client.resync();
    assert.equal(shown, `${TEXT}Changed while the host was away.\n`);
    assert.deepEqual(teammate.lines, ['host', 'in']);
  } finally {
    host.kill();
  }
});

test('a link no host is in says so, and the page waits for one', async () => {
  const teammate = page('a secret no host has');
  let answered = false;
  teammate.call('state').then(() => { answered = true; });
  await until(() => teammate.lines.length > 0, 'the line');
  assert.deepEqual(teammate.lines, ['nohost']);
  assert.equal(answered, false, 'the call waits for a host');
});

test('the browser build shows the doc read only, live', async () => {
  await promisify(execFile)(process.execPath, [join(root, 'preview', 'build.js')]);
  const shared = await project();
  const host = await startHost(shared);
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-relay-page-'));
  const room = roomOf(shared.secret);
  const url = new URL(`file://${join(root, 'dist', 'preview', 'team.html')}`);
  url.search = new URLSearchParams({ relay: relay.url, room, doc: 'plan.md' }).toString();
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, RELAY_PAGE: url.href };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron(electron, [join(root, 'test', 'relay', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  try {
    const shown = await app.page('plan.md');
    const text = () => shown.evaluate(`document.querySelector('.od-stage [contenteditable]')?.innerText ?? ''`);
    await waitFor(async () => (await text()).includes('Ship the preview first.'), 30_000, 'the doc');
    assert.equal(await shown.evaluate(`document.querySelector('.od-stage [contenteditable]').contentEditable`), 'false');
    assert.equal(await shown.evaluate(`document.querySelectorAll('.od-toolbar [data-command]').length`), 0, 'no formatting tools');

    const { docId } = await host.request('open', { docPath: join(shared.folder, 'plan.md'), folder: shared.folder });
    const owner = await host.request('call', { docId, call: 'state' });
    await host.request('call', { docId, call: 'submit', arg: { ops: [{ from: TEXT.length, to: TEXT.length, insert: '\nThen ask for feedback.\n' }], rev: owner.rev, epoch: owner.epoch, id: 'w.1' } });
    await waitFor(async () => (await text()).includes('Then ask for feedback.'), 10_000, 'the owner\'s typing');
  } finally {
    await app.quit();
    host.kill();
  }
});
