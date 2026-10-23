// A player's page reaching the owner's doc host through the relay
// (docs/architecture.md, Sharing), run locally (test/relay/harness.js): the
// page as web/relay.js and web/client.js in Node, then the browser build
// itself in Electron.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '../web/client.js';
import { LATENCY } from '../web/views/index.js';
import { launchElectron, waitFor } from '../scripts/devtools.js';
import { until } from './helpers.js';
import { idOf, page as playerPage, player, project as newProject, roomOf, startHost as hostOn, startRelay } from './relay/harness.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEXT = '# Plan\n\nShip the preview first.\n';

// Every WebSocket this process opens, a page's included; one `cut` is half
// open: what it sends goes nowhere, and nothing it is sent arrives.
const Line = globalThis.WebSocket;
const sockets = [];
globalThis.WebSocket = class extends Line {
  constructor(url) {
    super(url);
    sockets.push(this);
  }
  send(data) {
    if (!this.cut) super.send(data);
  }
  addEventListener(type, fn, ...rest) {
    super.addEventListener(type, type === 'message' ? (event) => this.cut || fn(event) : fn, ...rest);
  }
};

// The line the page in `room` opened last.
const lineIn = (room) => sockets.filter((s) => s.url.endsWith(room)).at(-1);

let relay;
before(async () => {
  relay = await startRelay();
});
after(() => relay?.stop());

const project = () => newProject(TEXT);
const startHost = (shared) => hostOn(shared, relay.url);
const page = (host, who, doc) => playerPage(relay.url, host.room, who, doc);
const levelOf = (p) => p.events.filter((e) => e.event === 'level').at(-1)?.data.level;

test('anyone with the link is in at once, at Edit, and writes and reads through the relay; a name taken on the project gets a number', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const sam = player('Sam');
    const teammate = page(host, sam); // no doc named: the project's first
    const { result: state } = await teammate.call('state');
    assert.equal(state.text, TEXT);
    assert.equal(state.level, 'write');
    assert.deepEqual(state.me, { id: idOf(sam.key), name: 'Sam', kind: 'human' });
    assert.notEqual(state.settings.name, 'owner', 'the owner\'s settings stay theirs');
    assert.ok(teammate.events.some((e) => e.event === 'hello'));

    // One DocService for the owner's window and the page: each sees the other type.
    const owner = await host.call('state');
    assert.equal(owner.epoch, state.epoch);
    await host.call('submit', { ops: [{ from: TEXT.length, to: TEXT.length, insert: 'Then ask for feedback.\n' }], rev: owner.rev, epoch: owner.epoch, id: 'w.1' });
    const landed = await until(() => teammate.events.find((e) => e.event === 'ops'), 'the owner\'s edit');
    assert.deepEqual(landed.data.ops, [{ from: TEXT.length, to: TEXT.length, insert: 'Then ask for feedback.\n' }]);
    assert.ok(!teammate.events.some((e) => e.event === 'settings' || e.event === 'room'), 'the owner\'s alone');
    assert.ok((await teammate.call('submit', { ops: [{ from: 0, to: 0, insert: 'Sam: ' }], rev: landed.data.rev, epoch: state.epoch, id: 'sam.1' })).result);
    assert.equal(await readFile(join(shared.folder, 'plan.md'), 'utf8'), `Sam: ${TEXT}Then ask for feedback.\n`);

    // The project's paths are the owner's real ones only for the owner.
    assert.deepEqual((await teammate.call('open', { path: 'plan.md' })).result, { path: 'plan.md' });

    for (const [name, named] of [['owner', 'owner2'], ['Clippy', 'Clippy2'], ['sam', 'sam2'], ['Sam', 'Sam3']]) {
      assert.equal((await page(host, player(name)).call('state')).result.me.name, named, name);
    }
    assert.deepEqual((await host.call('room')).players.map((p) => `${p.name} ${p.level}`), ['Sam write', 'owner2 write', 'Clippy2 write', 'sam2 write', 'Sam3 write']);
    await assert.rejects(host.call('createBuddy', { buddy: { name: 'Sam' } }), (error) => error.message === 'the name Sam is taken');
  } finally {
    host.kill();
  }
});

test('a player at Read is told so, and every write and owner-only call from a page is forbidden, whatever who it names', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const sam = player('Sam');
    const teammate = page(host, sam);
    const { result: state } = await teammate.call('state');
    await host.call('setLevel', { id: idOf(sam.key), level: 'read' });
    await until(() => levelOf(teammate) === 'read', 'the page told');
    const owner = { id: state.me.id, name: 'owner', kind: 'human', level: 'owner' };
    const calls = {
      submit: { ops: [{ from: 0, to: 0, insert: 'x' }], rev: state.rev, epoch: state.epoch, id: 'p.1' },
      recreate: {}, comment: { body: 'hi' }, restoreVersion: { id: 'x' }, undo: { id: 'x' },
      saveSettings: { name: 'mallory' }, createBuddy: { buddy: { name: 'Spy' } }, updateBuddy: { id: 'clippy', patch: {} },
      deleteBuddy: { id: 'x' }, scripts: {}, resetScript: { name: 'claude' },
      room: {}, openRoom: {}, closeRoom: {}, lockRoom: { locked: true }, setLevel: { id: state.me.id, level: 'write' }, kick: { id: state.me.id },
    };
    for (const [type, arg] of Object.entries(calls)) {
      for (const sent of [arg, { ...arg, who: owner }]) {
        const { error } = await teammate.call(type, sent);
        assert.equal(error?.code, 'forbidden', `${type} ${JSON.stringify(sent)}`);
      }
    }
    // A `who` beside the request, not in its arg, changes nothing either.
    const socket = new WebSocket(`${relay.url}/rooms/${host.room}`);
    const answers = [];
    socket.addEventListener('message', ({ data }) => answers.push(JSON.parse(data)));
    await new Promise((done) => socket.addEventListener('open', done));
    socket.send(JSON.stringify({ doc: 'plan.md', ...sam }));
    socket.send(JSON.stringify({ id: 1, type: 'comment', arg: { body: 'hi' }, who: owner }));
    const answer = await until(() => answers.find((a) => a.id === 1), 'an answer');
    assert.equal(answer.error.code, 'forbidden');
    socket.close();
    assert.equal(await readFile(join(shared.folder, 'plan.md'), 'utf8'), TEXT);

    await host.call('setLevel', { id: idOf(sam.key), level: 'write' });
    await until(() => levelOf(teammate) === 'write', 'the page told');
    assert.ok((await teammate.call('submit', calls.submit)).result);
  } finally {
    host.kill();
  }
});

test('no credential is in an address: the host proves its secret, and a page says who it is, in its first message', async () => {
  // A relay that only notes where the host connects: the room cannot open.
  const asked = [];
  const fake = createServer();
  fake.on('upgrade', (request, socket) => {
    asked.push(request.url);
    socket.destroy();
  });
  await new Promise((done) => fake.listen(0, '127.0.0.1', done));
  try {
    await assert.rejects(hostOn(await project(), `ws://127.0.0.1:${fake.address().port}`), { code: 'offline', message: 'Cannot reach the relay: try again' });
    assert.match(asked[0], /^\/rooms\/[0-9a-f]{64}\?host$/);
  } finally {
    fake.close();
  }

  const shared = await project();
  const host = await startHost(shared);
  try {
    await page(host, player('Sam'), 'plan.md').call('state');
    assert.deepEqual(sockets.filter((s) => s.url.includes(host.room)).map((s) => s.url), [`${relay.url}/rooms/${host.room}`]);
    assert.equal(new URL(host.link).search, `?room=${host.room}`, 'the link names the room alone');

    // Only with the room's secret is anyone its host.
    const impostor = new WebSocket(`${relay.url}/rooms/${host.room}?host`);
    const closed = new Promise((done) => impostor.addEventListener('close', ({ code }) => done(code)));
    impostor.addEventListener('open', () => impostor.send(JSON.stringify({ secret: 'guess' })));
    assert.equal(await closed, 4003);
    assert.equal((await page(host, player('Ada')).call('state')).result.me.name, 'Ada', 'the host still in');
  } finally {
    host.kill();
  }
});

test('a page reaches only what the project shows, and is told why not', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    for (const [doc, code, message] of [
      ['.ponjo/secret.md', 'hidden', 'Names starting with . and paths out of the project are never shared'],
      ['../plan.md', 'hidden'], ['/etc/hosts', 'hidden'],
      ['nothing.md', 'not_found', 'This doc is not in the shared project'],
    ]) {
      const turnedAway = page(host, player(), doc);
      const { error } = await turnedAway.call('state');
      assert.equal(error.code, code, doc);
      if (message) assert.equal(error.message, message);
      assert.deepEqual(turnedAway.lines, [`refused ${code}`]);
      assert.deepEqual(turnedAway.events, [], doc);
    }
  } finally {
    host.kill();
  }
});

test('C5: a page whose line drops is offline at once, keeps nothing to send, and once its line is back catches up', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const teammate = page(host, player('Sam'));
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
    });
    client.start(state);
    const hellos = () => teammate.events.filter((e) => e.event === 'hello').length;

    lineIn(host.room).close();
    await until(() => teammate.lines.includes('relay'), 'the page told its line dropped');
    assert.equal((await teammate.call('state')).error.code, 'offline', 'at once, not kept for later');
    const owner = await host.call('state');
    await host.call('submit', { ops: [{ from: TEXT.length, to: TEXT.length, insert: 'Typed while Sam was away.\n' }], rev: owner.rev, epoch: owner.epoch, id: 'w.1' });
    await until(() => hellos() > 1, 'hello on the new line', 10_000);
    await client.catchUp();
    assert.equal(shown, `${TEXT}Typed while Sam was away.\n`);
    assert.deepEqual(teammate.lines, ['relay', 'in']);
  } finally {
    host.kill();
  }
});

test('C6: a half-open line is noticed within 15 s, and made again', { timeout: 60_000 }, async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const teammate = page(host, player('Sam'));
    await teammate.call('state');
    await new Promise((done) => setTimeout(done, 1000));
    const cutAt = Date.now();
    lineIn(host.room).cut = true;
    await until(() => teammate.lines.includes('relay'), 'the page told', 20_000);
    assert.ok(Date.now() - cutAt < 15_000, `noticed after ${Date.now() - cutAt} ms`);
    await until(() => teammate.lines.at(-1) === 'in', 'the line made again', 10_000);
    assert.equal((await teammate.call('state')).result.text, TEXT);
  } finally {
    host.kill();
  }
});

test('a link no host is in says so, and the page waits for one', async () => {
  const teammate = playerPage(relay.url, roomOf('a secret no host has'), player());
  let answered = false;
  teammate.call('state').then(() => { answered = true; });
  await until(() => teammate.lines.length > 0, 'the line');
  assert.deepEqual(teammate.lines, ['nohost']);
  assert.equal(answered, false, 'the call waits for a host');
});

test('Kick turns a player\'s pages away at once, and that browser cannot come back; a locked room lets no one new in, but its players back', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const sam = player('Sam');
    const kicked = page(host, sam);
    await kicked.call('state');
    await host.call('kick', { id: idOf(sam.key) });
    await until(() => kicked.lines.includes('refused kicked'), 'the page turned away');
    assert.equal((await kicked.call('state')).error.message, 'The host removed you from this room');
    assert.equal((await page(host, sam).call('state')).error.code, 'kicked', 'not again, from a new page');

    const ada = player('Ada');
    await page(host, ada).call('state');
    assert.deepEqual(await host.call('lockRoom', { locked: true }), { link: host.link, locked: true, players: [{ id: idOf(ada.key), name: 'Ada', level: 'write' }] });
    assert.equal((await page(host, player('Bo')).call('state')).error.code, 'locked');
    assert.equal((await page(host, ada).call('state')).result.me.name, 'Ada', 'a player comes back');
    await host.call('lockRoom', { locked: false });
    assert.equal((await page(host, player('Bo')).call('state')).result.me.name, 'Bo');
  } finally {
    host.kill();
  }
});

test('Close room, or closing the project\'s last window, turns every page away within 1 s and lets go of the docs only pages had; an old link never opens a later room', async () => {
  const shared = await project();
  await mkdir(join(shared.folder, 'notes'));
  await writeFile(join(shared.folder, 'notes', 'b.md'), 'B\n');
  const host = await startHost(shared);
  try {
    // The ids the next docs opened get.
    const { docId: before } = await host.request('open', { docPath: join(shared.folder, 'notes', 'b.md'), folder: shared.folder });
    await host.request('close', { docId: before });
    const pages = [page(host, player('Sam')), page(host, player('Ada'), 'notes/b.md')];
    for (const p of pages) await p.call('state'); // b.md opens again, for the page: before + 1
    const oldRoom = host.room;
    let closedAt = performance.now();
    assert.equal(await host.call('closeRoom'), null);
    await until(() => pages.every((p) => p.lines.includes('refused closed')), 'every page turned away');
    assert.ok(performance.now() - closedAt < 1000, `within 1 s: ${performance.now() - closedAt} ms`);
    assert.equal((await pages[0].call('state')).error.message, 'The host closed the room');
    assert.equal((await host.request('open', { docPath: join(shared.folder, 'notes', 'b.md'), folder: shared.folder })).docId, before + 2, 'b.md let go, and opened anew');

    const { link } = await host.call('openRoom');
    const room = new URL(link).searchParams.get('room');
    assert.notEqual(room, oldRoom);
    const old = playerPage(relay.url, oldRoom, player('Sam'));
    old.call('state');
    await until(() => old.lines.length > 0, 'the old link');
    assert.deepEqual(old.lines, ['nohost']);
    assert.deepEqual(await host.call('room'), { link, locked: false, players: [] }, 'no one from before');

    const late = playerPage(relay.url, room, player('Sam'));
    await late.call('state');
    await host.request('close', { docId: before + 2 });
    assert.ok(!late.lines.includes('refused closed'), 'the project still has a window');
    closedAt = performance.now();
    await host.request('close', { docId: host.docId });
    await until(() => late.lines.includes('refused closed'), 'the page turned away');
    assert.ok(performance.now() - closedAt < 1000, `within 1 s: ${performance.now() - closedAt} ms`);
  } finally {
    host.kill();
  }
});

test('a player sees the owner\'s tree and opens any doc in it at once, nothing hidden', async () => {
  const shared = await project();
  await mkdir(join(shared.folder, 'notes'));
  await writeFile(join(shared.folder, 'notes', 'b.md'), 'B\n');
  const host = await startHost(shared);
  try {
    const sam = player('Sam');
    const first = (await page(host, sam).call('state')).result;
    assert.deepEqual(first.place, { name: basename(shared.folder), path: 'plan.md' });
    const teammate = page(host, sam);
    for (const path of ['', 'notes']) assert.deepEqual((await teammate.call('list', { path })).result, await host.call('list', { path }), path);
    assert.deepEqual((await teammate.call('list', { path: '' })).result.map((e) => e.name), ['notes', 'plan.md']);

    // Another doc: the same link on it.
    const { result } = await page(host, sam, 'notes/b.md').call('state');
    assert.equal(result.text, 'B\n');
    assert.equal(result.place.path, 'notes/b.md');

    for (const path of ['.ponjo', '.ponjo/secret.md', '../', 'notes/../.ponjo/secret.md']) {
      assert.equal((await teammate.call('list', { path })).error?.code, 'not_found', path);
      assert.equal((await teammate.call('read', { path })).error?.code, 'not_found', path);
    }
  } finally {
    host.kill();
  }
});

test('B6: two writers see each other\'s cursor move, within the promise, following the text, and who is here', async () => {
  const shared = await project();
  const host = await startHost(shared);
  try {
    const samKey = player('Sam');
    const noor = page(host, player('Noor'));
    await noor.call('state');
    const sam = page(host, samKey);
    const state = (await sam.call('state')).result;
    assert.deepEqual(state.cursors, []);

    // Who is here: each person once, on this doc.
    const here = (p) => p.events.filter((e) => e.event === 'here').at(-1)?.data.map(({ name, doc }) => `${name}${doc ? '' : ' (elsewhere)'}`).sort();
    await until(() => here(noor)?.length === 2, 'Noor told who is here');
    assert.deepEqual(here(noor), ['Noor', 'Sam']);

    // Sam's cursor reaches Noor, at once, again and again.
    const ms = [];
    for (let k = 1; k <= 20; k++) {
      const seen = noor.events.length;
      const sent = performance.now();
      await sam.call('cursor', { at: k, rev: state.rev, epoch: state.epoch });
      const told = await until(() => noor.events.slice(seen).find((e) => e.event === 'cursors'), 'the cursor');
      ms.push(performance.now() - sent);
      assert.deepEqual(told.data.cursors, [{ id: idOf(samKey.key), name: 'Sam', at: k }]);
      assert.equal(told.data.by, idOf(samKey.key));
    }
    ms.sort((a, b) => a - b);
    assert.ok(ms[18] < LATENCY.cursor.p95, `a cursor seen within LATENCY.cursor: ${ms.map(Math.round)}`);

    // The owner types before it: it moves with the text, at the host and in a page's state.
    const owner = await host.call('state');
    await host.call('submit', { ops: [{ from: 0, to: 0, insert: '> ' }], rev: owner.rev, epoch: owner.epoch, id: 'o.1' });
    assert.equal((await noor.call('state')).result.cursors[0].at, 22);
    // From a rev before the owner's edit, it is moved over it.
    await sam.call('cursor', { at: 3, rev: state.rev, epoch: state.epoch });
    assert.equal((await noor.call('state')).result.cursors[0].at, 5);
    assert.equal((await sam.call('cursor', { at: -1, rev: state.rev, epoch: state.epoch })).error.code, 'bad_input');

    // Sam is kicked, and so go their cursor and face.
    const seen = noor.events.length;
    await host.call('kick', { id: idOf(samKey.key) });
    await until(() => noor.events.slice(seen).find((e) => e.event === 'cursors' && e.data.cursors.length === 0), 'the cursor gone');
    await until(() => here(noor)?.length === 1, 'Sam gone');
  } finally {
    host.kill();
  }
});

test('C8: a doc too big for the relay: its page says so, alone; the host and the other pages stay', async () => {
  const shared = await project();
  await writeFile(join(shared.folder, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(9 * 2 ** 20 / 100));
  const host = await startHost(shared);
  try {
    const sam = player('Sam');
    const other = page(host, sam);
    await other.call('state');
    const big = page(host, sam, 'big.txt');
    assert.deepEqual((await big.call('state')).error, { message: 'This doc is too big to open through sharing', code: 'too_big' });
    assert.equal((await other.call('state')).result.text, TEXT, 'the other page still in');
    assert.ok(!other.lines.includes('host'), 'the host never went away');
  } finally {
    host.kill();
  }
});

test('the relay serves the player\'s page from its own origin, and only it', async () => {
  const served = await fetch(`${relay.origin}/team?room=${'0'.repeat(64)}`);
  assert.equal(served.status, 200);
  const html = await served.text();
  assert.match(html, /connect-src 'self';/, 'the page may reach the relay at its origin, nothing else');
  assert.match(html, /src="app.js"/);
  assert.equal((await fetch(`${relay.origin}/app.js`)).status, 200);
  assert.equal((await fetch(`${relay.origin}/`)).status, 404, 'not the app\'s own window');
  assert.equal((await fetch(`${relay.origin}/rooms/${'0'.repeat(64)}`)).status, 404, 'a room is reached only by a WebSocket');
});

test('the relay limits pages, message sizes, hosts and pages an address opens, so it is no free pipe', { timeout: 120_000 }, async () => {
  const limited = await startRelay(); // its own, for what an address opens a minute
  const opened = [];
  const connect = (path, first) => new Promise((done) => {
    const socket = new WebSocket(`${limited.url}${path}`);
    opened.push(socket);
    const closed = new Promise((gone) => socket.addEventListener('close', ({ code, reason }) => gone({ code, reason })));
    socket.addEventListener('open', () => {
      if (first) socket.send(JSON.stringify(first));
      done({ socket, closed });
    });
    socket.addEventListener('error', () => done({ socket, closed, refused: true }));
  });
  try {
    const secret = 'a-secret';
    const host = await connect(`/rooms/${roomOf(secret)}?host`, { secret });
    await new Promise((done) => host.socket.addEventListener('message', done)); // { hosting: true }
    const pages = [];
    for (let k = 0; k < 20; k++) pages.push(await connect(`/rooms/${roomOf(secret)}`, { name: `p${k}` }));
    const over = await connect(`/rooms/${roomOf(secret)}`);
    assert.deepEqual(await over.closed, { code: 4001, reason: 'full' });

    pages[0].socket.send('x'.repeat(8 * 2 ** 20 + 1));
    assert.equal((await pages[0].closed).code, 1009);
    host.socket.send(JSON.stringify({ peer: 1, data: 'x'.repeat(8 * 2 ** 20) }));
    assert.equal((await host.closed).code, 1009, 'a host too');
    assert.equal((await pages[1].closed).code, 4000, 'its pages told the host is gone');

    // The limits count in minutes on the clock, so what opens across the
    // turn of one fills two of them: twice the limit and one more overflow one.
    let refused = false;
    for (let k = 0; k <= 2 * 60 && !refused; k++) refused = Boolean((await connect(`/rooms/${roomOf(`s${k}`)}?host`)).refused);
    assert.ok(refused, 'an address connects at most 60 hosts a minute');
    refused = false;
    for (let k = 0; k <= 2 * 120 && !refused; k++) refused = Boolean((await connect(`/rooms/${roomOf(secret)}`)).refused);
    assert.ok(refused, 'and at most 120 pages');
  } finally {
    for (const socket of opened) socket.close();
    await limited.stop();
  }
});

test('C2 C6 D7: the browser build asks a name, then shows the doc live at Edit: its tree, the owner\'s cursor, read only at Read; a comment draft stays, typing lands before it lets go; a dropped line is read only; a closed room leaves nothing', { timeout: 240_000 }, async () => {
  const shared = await project();
  const host = await startHost(shared);
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-relay-page-'));
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, RELAY_PAGE: host.link }; // the page as the link opens it, from the relay
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchElectron(electron, [join(root, 'test', 'relay', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  try {
    const shown = await app.page('Ponjo');
    // Its WebSockets, each one that can be cut half open, and how many hellos each heard.
    await shown.send('Page.enable');
    await shown.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
      const Line = WebSocket;
      window.sockets = [];
      window.WebSocket = class extends Line {
        constructor(url) {
          super(url);
          this.hellos = 0;
          sockets.push(this);
          super.addEventListener('message', (event) => { if (!this.cut && String(event.data).includes('"event":"hello"')) this.hellos++; });
        }
        send(data) { if (!this.cut) super.send(data); }
        addEventListener(type, fn, ...rest) { super.addEventListener(type, type === 'message' ? (event) => this.cut || fn(event) : fn, ...rest); }
      };
    }` });
    await shown.send('Page.navigate', { url: host.link });
    await waitFor(() => shown.evaluate(`Boolean(window.sockets) && document.querySelector('.pj-join')?.hidden === false`).catch(() => false), 30_000, 'the name asked');
    await shown.evaluate(`document.querySelector('.pj-join input').value = 'Noor'; document.querySelector('.pj-join').requestSubmit()`);
    const editable = () => shown.evaluate(`document.querySelector('.pj-stage [contenteditable]')?.contentEditable`).catch(() => '');
    const text = () => shown.evaluate(`document.querySelector('.pj-stage [contenteditable]')?.innerText ?? ''`);
    const status = () => shown.evaluate(`document.querySelector('.pj-status-text').textContent`);
    await waitFor(async () => (await editable()) === 'true', 30_000, 'the doc, at Edit at once');
    assert.ok((await text()).includes('Ship the preview first.'));
    const [noor] = (await host.call('room')).players;
    assert.equal(noor.name, 'Noor');

    await host.call('setLevel', { id: noor.id, level: 'read' });
    await waitFor(async () => (await editable()) === 'false', 30_000, 'the page at Read');
    assert.equal(await shown.evaluate(`document.querySelectorAll('.pj-toolbar [data-command]').length`), 0, 'no formatting tools');

    const owner = await host.call('state');
    await host.call('submit', { ops: [{ from: TEXT.length, to: TEXT.length, insert: '\nThen ask for feedback.\n' }], rev: owner.rev, epoch: owner.epoch, id: 'w.1' });
    await waitFor(async () => (await text()).includes('Then ask for feedback.'), 10_000, 'the owner\'s typing');
    assert.equal(await shown.evaluate(`document.querySelectorAll('.pj-flag, .pj-flash, .pj-flash-block').length`), 0, 'typing shows by its cursor, with no glow');

    // The project's tree, the doc marked, and no file menu: the files are the owner's.
    await mkdir(join(shared.folder, 'notes'));
    await writeFile(join(shared.folder, 'notes', 'b.md'), 'Notes on the plan\n');
    const rows = () => shown.evaluate(`[...document.querySelectorAll('.pj-files-row')].filter((r) => !r.closest('[hidden]')).map((r) => r.dataset.path)`).catch(() => []);
    await shown.evaluate('window.dispatchEvent(new Event("focus"))'); // back in front: the tree read again
    await waitFor(async () => JSON.stringify(await rows()) === '["notes","plan.md"]', 10_000, 'the tree');
    assert.equal(await shown.evaluate(`document.querySelector('[aria-current="page"]').dataset.path`), 'plan.md');
    assert.ok(await shown.evaluate(`document.querySelector('[data-path="plan.md"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`), 'no menu');
    await shown.evaluate(`document.querySelector('[data-path="notes"]').click()`);
    await waitFor(async () => (await rows()).includes('notes/b.md'), 10_000, 'the folder open');
    await shown.evaluate(`document.querySelector('[data-path="notes/b.md"]').click()`);
    await waitFor(async () => (await text().catch(() => '')).includes('Notes on the plan'), 30_000, 'the other doc');
    assert.equal(new URL(await shown.evaluate('location.href')).searchParams.get('doc'), 'notes/b.md');
    await waitFor(async () => (await rows()).includes('notes/b.md'), 10_000, 'the folder still open');
    await shown.evaluate(`document.querySelector('[data-path="plan.md"]').click()`);
    await waitFor(async () => (await text().catch(() => '')).includes('Then ask for feedback.'), 30_000, 'back');

    // A thread: a reader sees it, with nothing to reply, resolve or undo with.
    await host.call('comment', { anchor: null, body: 'Shall we?' });
    await waitFor(() => shown.evaluate(`document.querySelector('.pj-margin').textContent.includes('Shall we?')`), 10_000, 'the comment');
    const visible = (selector) => shown.evaluate(`[...document.querySelectorAll('${selector}')].filter((node) => node.offsetParent).length`);
    for (const selector of ['.pj-composer', '.pj-resolve', '.pj-toolbar [data-command]']) assert.equal(await visible(selector), 0, selector);

    // The owner's cursor, named, in their colour; a writer's goes to the owner.
    const now = await host.call('state');
    await host.call('cursor', { at: 6, rev: now.rev, epoch: now.epoch });
    await waitFor(() => shown.evaluate(`document.querySelector('.pj-cursor')?.textContent === 'owner'`), 10_000, 'the owner\'s cursor');
    await host.call('setLevel', { id: noor.id, level: 'write' });
    await waitFor(async () => (await editable()) === 'true', 30_000, 'the page at Edit');
    await shown.evaluate(`{
      const editor = document.querySelector('.pj-stage [contenteditable]');
      editor.focus();
      const paragraph = [...editor.querySelectorAll('p')].find((p) => p.textContent.startsWith('Then'));
      const text = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode(); // in its mark: changed since Noor last looked
      getSelection().collapse(text, 4);
    }`);
    await until(async () => (await host.call('state')).cursors.some((c) => c.name === 'Noor'), 'Noor\'s cursor at the host');

    // D7: a comment being written, and its anchor, stay while the owner types above it.
    await shown.evaluate(`{
      const text = document.createTreeWalker([...document.querySelectorAll('.pj-stage [contenteditable] p')].find((p) => p.textContent.startsWith('Then')), NodeFilter.SHOW_TEXT).nextNode();
      getSelection().setBaseAndExtent(text, 5, text, 12);
    }`);
    await new Promise((done) => setTimeout(done, 100)); // the editor takes in the selection
    await shown.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', ctrlKey: true, altKey: true, bubbles: true }))`);
    await waitFor(() => shown.evaluate(`Boolean(document.querySelector('.pj-card-draft textarea'))`), 10_000, 'the draft');
    await shown.evaluate(`document.querySelector('.pj-card-draft textarea').value = 'Which feedback?'`);
    const before = await host.call('state');
    await host.call('submit', { ops: [{ from: 0, to: 0, insert: 'Draft: ' }], rev: before.rev, epoch: before.epoch, id: 'w.2' });
    await waitFor(async () => (await text()).startsWith('Draft: '), 10_000, 'the owner\'s edit');
    assert.equal(await shown.evaluate(`document.querySelector('.pj-card-draft textarea').value`), 'Which feedback?');
    assert.equal(await shown.evaluate(`[...document.querySelectorAll('.pj-stage [contenteditable] [data-thread="draft"]')].map((m) => m.textContent).join('')`), 'ask for');

    // C2: typing not landed lands before the page lets go of its doc.
    const typeAt = (start) => shown.evaluate(`{
      const editor = document.querySelector('.pj-stage [contenteditable]');
      editor.focus();
      getSelection().collapse(document.createTreeWalker([...editor.querySelectorAll('p')].find((p) => p.textContent.startsWith('${start}')), NodeFilter.SHOW_TEXT).nextNode(), 0);
    }`);
    await typeAt('Ship');
    await shown.send('Input.insertText', { text: 'Now: ' });
    await shown.evaluate('window.ponjoLeave()');
    assert.match((await host.call('state')).text, /Now: Ship the preview/);
    await shown.evaluate('window.ponjoStay()');

    // C6: a line that goes half open is read only within 15 s; once it is
    // made again the page edits again.
    const cut = () => shown.evaluate('sockets.at(-1).cut = true; sockets.length');
    const lineBack = (after) => waitFor(() => shown.evaluate(`sockets.slice(${after}).some((s) => s.hellos > 0)`), 20_000, 'the line made again');
    let cutAt = Date.now();
    let lines = await cut();
    await waitFor(async () => (await editable()) === 'false', 20_000, 'read only');
    assert.ok(Date.now() - cutAt < 15_000, `within 15 s: ${Date.now() - cutAt} ms`);
    assert.equal(await status(), 'Cannot reach the relay: read only until it is back');
    await lineBack(lines);
    await waitFor(async () => (await editable()) === 'true', 10_000, 'editable again');

    // Typing not sent when it drops is shown as it was left, to copy, and never sent.
    await typeAt('Then');
    cutAt = Date.now();
    lines = await cut();
    await shown.send('Input.insertText', { text: 'Lost: ' });
    await waitFor(async () => (await editable()) === 'false', 20_000, 'read only');
    assert.ok(Date.now() - cutAt < 15_000, `within 15 s: ${Date.now() - cutAt} ms`);
    assert.match(await status(), /^Not saved: the line dropped\./);
    assert.match(await text(), /Lost: Then ask/);
    await lineBack(lines);
    await new Promise((done) => setTimeout(done, 1000));
    assert.equal(await editable(), 'false', 'still shown, to copy');
    assert.doesNotMatch((await host.call('state')).text, /Lost/);

    // Close room: the page is cleared and says only why.
    const closedAt = performance.now();
    await host.call('closeRoom');
    await waitFor(() => shown.evaluate(`document.body.innerText.trim() === 'The host closed the room'`).catch(() => false), 10_000, 'the page cleared');
    assert.ok(performance.now() - closedAt < 1000, `within 1 s: ${performance.now() - closedAt} ms`);
    assert.equal(new URL(await shown.evaluate('location.href')).search, '?gone=closed');
  } finally {
    await app.quit();
    host.kill();
  }
});
