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
import { idOf, page as teammatePage, pageAt, project as newProject, roomOf, startHost as hostOn, startRelay, teammate as newTeammate } from './relay/harness.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEXT = '# Plan\n\nShip the preview first.\n';

let relay;
before(async () => {
  relay = await startRelay();
});
after(() => relay?.stop());

const project = () => newProject(TEXT);
const startHost = (shared) => hostOn(shared, relay.url);
const page = (secret, who, doc) => teammatePage(relay.url, secret, who, doc);

// The owner's call `call` to the doc host, through a window of `doc`.
async function asOwner(host, shared, call, arg, doc = 'plan.md') {
  const { docId } = await host.request('open', { docPath: join(shared.folder, doc), folder: shared.folder });
  return host.request('call', { docId, call, arg });
}

test('a page reads a doc through the relay as a teammate who can read, and sees the owner type', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const teammate = page(shared.secret, shared.sam); // no doc named: the project's first
    const { result: state } = await teammate.call('state');
    assert.equal(state.text, TEXT);
    assert.equal(state.level, 'read');
    assert.deepEqual(state.me, { id: idOf(shared.sam.key), name: 'Sam', kind: 'human' });
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
    const teammate = page(shared.secret, shared.sam);
    const { result: state } = await teammate.call('state');
    const owner = { id: state.me.id, name: 'owner', kind: 'human', level: 'owner' };
    const calls = {
      submit: { ops: [{ from: 0, to: 0, insert: 'x' }], rev: state.rev, epoch: state.epoch, id: 'p.1' },
      recreate: {}, comment: { body: 'hi' }, restoreVersion: { id: 'x' }, undoReply: { id: 'x' },
      saveSettings: { name: 'mallory' }, createBuddy: { buddy: { name: 'Spy' } }, updateBuddy: { id: 'clippy', patch: {} },
      deleteBuddy: { id: 'x' }, scripts: {}, resetScript: { name: 'claude' },
      team: {}, allow: { id: 'x', level: 'write' }, remove: { id: 'x' }, setLevel: { id: state.me.id, level: 'write' }, link: {},
    };
    for (const [type, arg] of Object.entries(calls)) {
      for (const sent of [arg, { ...arg, who: owner }]) {
        const { error } = await teammate.call(type, sent);
        assert.equal(error?.code, 'forbidden', `${type} ${JSON.stringify(sent)}`);
      }
    }
    // A `who` beside the request, not in its arg, changes nothing either.
    const socket = new WebSocket(`${relay.url}/rooms/${roomOf(shared.secret)}?${new URLSearchParams({ doc: 'plan.md', ...shared.sam })}`);
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
      const turnedAway = page(shared.secret, shared.sam, doc);
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
    const teammate = page(shared.secret, shared.sam);
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
  const teammate = page('a secret no host has', newTeammate());
  let answered = false;
  teammate.call('state').then(() => { answered = true; });
  await until(() => teammate.lines.length > 0, 'the line');
  assert.deepEqual(teammate.lines, ['nohost']);
  assert.equal(answered, false, 'the call waits for a host');
});

test('a first join waits for the owner, who is told; Allow (Read) lets the page in at read', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const noor = newTeammate('Noor');
    const asking = page(shared.secret, noor);
    let answered = null;
    asking.call('state').then((answer) => { answered = answer; });
    await until(() => asking.lines.includes('waiting'), 'the page waiting');
    assert.deepEqual(host.joins, [{ folder: shared.folder, name: 'Noor' }]);
    const team = await asOwner(host, shared, 'team');
    assert.deepEqual(team.pending, [{ id: idOf(noor.key), name: 'Noor' }]);
    assert.equal(answered, null, 'nothing is served before Allow');

    await asOwner(host, shared, 'allow', { id: idOf(noor.key), level: 'read' });
    await until(() => answered, 'the page let in');
    assert.equal(answered.result.level, 'read');
    assert.equal(answered.result.me.name, 'Noor');
    assert.deepEqual(asking.lines, ['waiting', 'in']);
    // Allowed once: the next time it is let in at once.
    const again = page(shared.secret, noor);
    assert.equal((await again.call('state')).result.me.name, 'Noor');
    assert.deepEqual((await asOwner(host, shared, 'team')).members.map((m) => [m.name, m.level]), [['Sam', 'read'], ['Noor', 'read']]);
  } finally {
    host.kill();
  }
});

test('a name taken on the project is refused, a request turned down is told so', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    for (const name of ['owner', 'Clippy', 'sam']) {
      const { error } = await page(shared.secret, newTeammate(name)).call('state');
      assert.equal(error.code, 'name_taken', name);
    }
    const ada = newTeammate('Ada');
    const asking = page(shared.secret, ada);
    const answer = asking.call('state');
    await until(() => asking.lines.includes('waiting'), 'the page waiting');
    assert.equal((await page(shared.secret, newTeammate('ADA')).call('state')).error.code, 'name_taken', 'a name asking to join is taken too');
    await assert.rejects(asOwner(host, shared, 'createBuddy', { buddy: { name: 'Sam' } }), (error) => error.message === 'the name Sam is taken');
    await asOwner(host, shared, 'remove', { id: idOf(ada.key) });
    assert.equal((await answer).error.code, 'denied');
    assert.deepEqual((await asOwner(host, shared, 'team')).pending, []);
  } finally {
    host.kill();
  }
});

test('a teammate set to Edit writes through the relay; a page is told when its level changes', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const sam = page(shared.secret, shared.sam);
    const { result: state } = await sam.call('state');
    const edit = { ops: [{ from: 0, to: 0, insert: 'Sam: ' }], rev: state.rev, epoch: state.epoch, id: 'sam.1' };
    assert.equal((await sam.call('submit', edit)).error.code, 'forbidden');
    await asOwner(host, shared, 'setLevel', { id: idOf(shared.sam.key), level: 'write' });
    await until(() => sam.events.find((e) => e.event === 'level'), 'the page told');
    assert.deepEqual(sam.events.find((e) => e.event === 'level').data, { level: 'write' });
    assert.equal((await sam.call('state')).result.level, 'write');
    assert.ok((await sam.call('submit', edit)).result);
    assert.equal(await readFile(join(shared.folder, 'plan.md'), 'utf8'), `Sam: ${TEXT}`);
  } finally {
    host.kill();
  }
});

test('Remove turns a teammate\'s page away at once; a new link ends every old one', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const sam = page(shared.secret, shared.sam);
    await sam.call('state');
    await asOwner(host, shared, 'remove', { id: idOf(shared.sam.key) });
    await until(() => sam.lines.includes('refused'), 'the page turned away');
    assert.equal((await sam.call('state')).error.code, 'removed');

    const noor = newTeammate('Noor');
    const asking = page(shared.secret, noor);
    asking.call('state');
    await until(() => asking.lines.includes('waiting'), 'the page waiting');
    await asOwner(host, shared, 'allow', { id: idOf(noor.key), level: 'write' });
    const before = page(shared.secret, noor);
    await before.call('state');
    const { link } = await asOwner(host, shared, 'link');
    const room = new URL(link).searchParams.get('room');
    assert.notEqual(room, roomOf(shared.secret));
    assert.equal(new URL(link).searchParams.get('relay'), relay.url);
    await until(() => before.lines.includes('refused'), 'the old link\'s page turned away');
    assert.equal((await before.call('state')).error.code, 'link_replaced');
    const old = page(shared.secret, noor);
    old.call('state');
    await until(() => old.lines.length > 0, 'the old link');
    assert.deepEqual(old.lines, ['nohost']);
    // Teammates stay on the project, and join from the new link at once.
    assert.equal((await pageAt(relay.url, room, noor).call('state')).result.me.name, 'Noor');
  } finally {
    host.kill();
  }
});

test('the browser build asks a name, waits for Allow, then shows the doc read only, live', async () => {
  await promisify(execFile)(process.execPath, [join(root, 'preview', 'build.js')]);
  const shared = await project();
  const host = await startHost(shared);
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-relay-page-'));
  const room = roomOf(shared.secret);
  const url = new URL(`file://${join(root, 'dist', 'preview', 'team.html')}`);
  url.search = new URLSearchParams({ relay: relay.url, room }).toString(); // as the Invite link names it
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, RELAY_PAGE: url.href };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron(electron, [join(root, 'test', 'relay', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  try {
    const shown = await app.page('opendoc');
    await waitFor(() => shown.evaluate(`!document.querySelector('.od-join').hidden`), 30_000, 'the name asked');
    await shown.evaluate(`document.querySelector('.od-join input').value = 'Noor'; document.querySelector('.od-join').requestSubmit()`);
    await until(() => host.joins.length > 0, 'the owner told');
    const status = () => shown.evaluate(`document.querySelector('.od-status-text').textContent`);
    await waitFor(async () => (await status()) === 'Waiting for the owner to let you in', 10_000, 'the page waiting');
    const { pending } = await asOwner(host, shared, 'team');
    await asOwner(host, shared, 'allow', { id: pending[0].id, level: 'read' });
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
