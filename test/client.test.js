// The page's client (web/client.js) against a real DocService: typing lands
// and is written; a doc host that starts again (a new epoch) loses nothing
// typed, and takes what changed on disk meanwhile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '../web/client.js';
import { openDoc } from '../src/host/doc-service.js';
import { fakeConfig, readOnly, tempDoc, until } from './helpers.js';

const TEXT = 'Alpha one.\n\nBeta two.\n\nGamma three.\n';

// The doc host at `docPath`, called as its owner, as a window's port does.
async function openHost(docPath, options) {
  const doc = await openDoc(docPath, options);
  return { ...doc, call: async (type, arg) => doc.call(type, arg, await doc.owner()) };
}

// A view the test types into, and a client joining it to the doc host
// `host()`; its edits wait for `gate` on their way. The errors it shows are
// in `errors`.
function page(host, gate = () => null, text = TEXT) {
  const view = { text, getText: () => view.text, selection: () => null };
  const errors = [];
  const client = createClient({
    view,
    call: async (type, arg) => {
      if (type === 'submit') await gate();
      return host().call(type, arg);
    },
    show: (text) => { view.text = text; },
    onError: (error) => errors.push(error),
  });
  return { view, client, errors };
}

// The doc host `host` through a line that can drop: while it is down, a
// call that reaches the host has its answer lost, and the host's events too.
function line(host) {
  const it = {
    up: true,
    call: async (type, arg) => {
      const result = await host.call(type, arg);
      if (!it.up) throw Object.assign(new Error('The host is offline'), { code: 'offline' });
      return result;
    },
    events: (receive) => (event) => it.up && receive(event),
  };
  return it;
}

test('typing lands and is written; a doc host started again loses nothing typed, and takes what changed on disk meanwhile', async () => {
  const docPath = await tempDoc(TEXT);
  const settingsDir = await fakeConfig();
  let receive = () => {};
  let host = await openHost(docPath, { settingsDir, emit: (name, data) => name === 'ops' && receive(data) });
  const { view, client } = page(() => host);
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));

  view.text = view.text.replace('one', 'one typed');
  await client.landed();
  assert.equal(await readFile(docPath, 'utf8'), 'Alpha one typed.\n\nBeta two.\n\nGamma three.\n');

  // The host stops with an edit on its way, never landed; the doc changes on disk.
  const old = host;
  host = { call: (type) => (type === 'state' ? old.call('state') : new Promise(() => {})) };
  view.text = view.text.replace('two', 'two typed');
  client.flush();
  await old.close();
  await writeFile(docPath, 'Alpha one typed.\n\nBeta two.\n\nGamma pulled.\n');
  host = await openHost(docPath, { settingsDir, emit: (name, data) => name === 'ops' && receive(data) });
  await client.catchUp(); // the page's new connection says hello
  await client.landed();
  const expected = 'Alpha one typed.\n\nBeta two typed.\n\nGamma pulled.\n';
  assert.equal(view.text, expected);
  assert.equal((await host.call('state')).text, expected);
  await until(async () => (await readFile(docPath, 'utf8')) === expected, 'the file written');
  await host.close();
});

test('two pages of one doc: each one\'s typing reaches the other, and the doc', async () => {
  const docPath = await tempDoc(TEXT);
  const pages = [];
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && pages.forEach((p) => p.client.receive(data)) });
  for (let i = 0; i < 2; i++) {
    pages.push(page(() => host));
    pages[i].client.start(await host.call('state'));
  }
  pages[0].view.text = pages[0].view.text.replace('Alpha one', 'Alpha one A');
  pages[1].view.text = pages[1].view.text.replace('Gamma three', 'Gamma three B');
  pages[0].client.flush();
  pages[1].client.flush();
  await Promise.all(pages.map((p) => p.client.landed()));
  const expected = 'Alpha one A.\n\nBeta two.\n\nGamma three B.\n';
  for (const p of pages) assert.equal(p.view.text, expected);
  assert.equal(await readFile(docPath, 'utf8'), expected);
  await host.close();
});

test('C3: an outside change that lands while typing is on its way: both land, merged by character, in the page and the doc alike', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  let open;
  const held = new Promise((done) => { open = done; });
  const { view, client } = page(() => host, () => held);
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  view.text = view.text.replace('Beta two', 'Beta typed');
  client.flush(); // on its way, held
  await writeFile(docPath, TEXT.replace('Beta two', 'Beta pulled').replace('Gamma three', 'Gamma pulled'));
  await until(() => view.text.includes('Gamma pulled'), 'the outside change shown');
  // The typing replaced "wo" of "two" with "yped", and the pull all of "two" with "pulled".
  assert.match(view.text, /^Alpha one\.\n\nBeta pulledyped\.\n\nGamma pulled\.\n$/, 'the typing on its way stays shown, over the pull');
  open();
  await client.landed();
  assert.equal(view.text, 'Alpha one.\n\nBeta pulledyped.\n\nGamma pulled.\n');
  assert.equal((await host.call('state')).text, view.text);
  assert.equal(await readFile(docPath, 'utf8'), view.text);
  await host.close();
});

test('a page that missed the event of its own edit landing takes the text again, and sends nothing twice', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  let drop = 1; // the first event never reaches the page
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && (drop-- > 0 || receive(data)) });
  const { view, client } = page(() => host);
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  view.text = view.text.replace('Beta two', 'Beta two typed'); // an insert: two of them would both stay
  client.flush();
  // The answer alone tells it, with no other edit after.
  await until(() => client.idle(), 'the page told its edit landed');
  await writeFile(docPath, (await host.call('state')).text.replace('Gamma three', 'Gamma pulled'));
  await until(() => view.text.includes('Gamma pulled'), 'the next edit shown');
  await client.landed();
  const expected = 'Alpha one.\n\nBeta two typed.\n\nGamma pulled.\n';
  assert.equal(view.text, expected);
  assert.equal((await host.call('state')).text, expected);
  await host.close();
});

test('C1: a doc host that stops after writing an edit, before telling the page: started again, it says so, and the edit is not sent twice', async () => {
  const docPath = await tempDoc(TEXT);
  const settingsDir = await fakeConfig();
  let receive = () => {};
  const old = await openHost(docPath, { settingsDir }); // it stops before telling anything, or answering
  let host = { call: (type, arg) => (type === 'submit' ? (old.call(type, arg), new Promise(() => {})) : old.call(type, arg)) };
  const { view, client } = page(() => host);
  client.start(await old.call('state'));
  view.text = view.text.replace('Beta two', 'Beta two typed'); // an insert: two of them would both stay
  client.flush();
  await until(async () => (await readFile(docPath, 'utf8')).includes('typed'), 'the edit written');
  await old.close();
  host = await openHost(docPath, { settingsDir, emit: (name, data) => name === 'ops' && receive(data) });
  receive = (event) => client.receive(event);
  await client.catchUp(); // the page's new connection says hello
  await client.landed();
  const expected = 'Alpha one.\n\nBeta two typed.\n\nGamma three.\n';
  assert.equal(view.text, expected);
  assert.equal((await host.call('state')).text, expected);
  assert.equal(await readFile(docPath, 'utf8'), expected);
  await host.close();
});

test('a key goes out at once when nothing is on its way; keys typed meanwhile go out together once it is answered', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const sent = [];
  let release = null;
  const { view, client } = page(() => ({
    call: async (type, arg) => {
      if (type === 'submit') {
        sent.push(arg.ops.map((op) => op.insert).join(''));
        await new Promise((done) => { release = done; });
      }
      return host.call(type, arg);
    },
  }));
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));

  view.text = view.text.replace('Alpha', 'Alpha!');
  client.edited();
  await until(() => sent.length === 1, 'the first key, at once');
  view.text = view.text.replace('one', 'one x');
  client.edited();
  view.text = view.text.replace('one x', 'one xy');
  client.edited();
  await new Promise((done) => setTimeout(done, 50));
  assert.deepEqual(sent, ['!'], 'nothing more while one is on its way');
  release();
  await until(() => sent.length === 2, 'the keys typed meanwhile');
  assert.equal(sent[1], ' xy');
  release();
  await client.landed();
  assert.equal(await readFile(docPath, 'utf8'), 'Alpha! one xy.\n\nBeta two.\n\nGamma three.\n');
  await host.close();
});

test('A3: a line that drops after the host took an edit, before it answered, never lands the edit twice', async () => {
  const docPath = await tempDoc('world.\n');
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const wire = line(host);
  const { view, client } = page(() => wire, () => null, 'world.\n');
  receive = wire.events((event) => client.receive(event));
  client.start(await host.call('state'));
  wire.up = false;
  view.text = 'Hello world.\n';
  client.flush();
  await until(async () => (await readFile(docPath, 'utf8')) === 'Hello world.\n', 'the edit written');
  wire.up = true;
  await client.catchUp(); // the host's hello on the line made again
  await client.landed();
  assert.equal(view.text, 'Hello world.\n');
  assert.equal(await readFile(docPath, 'utf8'), 'Hello world.\n');
  await host.close();
});

test('A3 A6 C4: a write that fails says Not saved; once the file can be written, the typing is saved once', async () => {
  const docPath = await tempDoc('Hello world.\n');
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const { view, client, errors } = page(() => host, () => null, 'Hello world.\n');
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  await readOnly(docPath, true);
  try {
    view.text = 'Hello big world.\n';
    client.flush();
    await until(() => errors.some((error) => error.code === 'not_saved'), 'Not saved shown');
    view.text = 'Hello big, bright world.\n';
    client.edited();
    assert.equal(await readFile(docPath, 'utf8'), 'Hello world.\n');
  } finally {
    await readOnly(docPath, false);
  }
  await client.landed();
  assert.equal(view.text, 'Hello big, bright world.\n');
  assert.equal(await readFile(docPath, 'utf8'), 'Hello big, bright world.\n');
  await host.close();
});

test('A6 C4: the doc host tells every page why the file is not saved, and when it is again', async () => {
  const docPath = await tempDoc('Hello world.\n');
  const told = [];
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => (name === 'saved' ? told.push(data.error) : name === 'ops' && receive(data)) });
  const { view, client } = page(() => host, () => null, 'Hello world.\n');
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  await readOnly(docPath, true);
  try {
    view.text = 'Hello big world.\n';
    client.flush();
    await until(() => told.length === 1, 'Not saved told');
    assert.equal(told[0], 'the file or its folder cannot be written', 'why, with no path: teammates hear it too');
    assert.equal((await host.call('state')).notSaved, told[0], 'a page that opens now is told too');
  } finally {
    await readOnly(docPath, false);
  }
  await client.landed();
  await until(() => told.length === 2, 'saved told');
  assert.equal(told[1], null);
  assert.equal((await host.call('state')).notSaved, null);
  await host.close();
});

test('A2 C1: typing not written when the file changed outside, then the host started again, is kept and written once', { skip: process.platform === 'win32' && 'a read-only file there cannot be changed outside either' }, async () => {
  const docPath = await tempDoc(TEXT);
  const settingsDir = await fakeConfig();
  let receive = () => {};
  let host = await openHost(docPath, { settingsDir, emit: (name, data) => name === 'ops' && receive(data) });
  const { view, client, errors } = page(() => host);
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  await readOnly(docPath, true);
  try {
    view.text = view.text.replace('one', 'one typed');
    client.flush();
    await until(() => errors.some((error) => error.code === 'not_saved'), 'Not saved');
    await writeFile(docPath, TEXT.replace('Gamma', 'Gamma pulled')); // in place, as the folder allows
    await until(async () => (await host.call('state')).text.includes('Gamma pulled'), 'the outside change taken');
    await host.close().catch(() => {}); // its last write fails too
  } finally {
    await readOnly(docPath, false);
  }
  host = await openHost(docPath, { settingsDir, emit: (name, data) => name === 'ops' && receive(data) });
  await client.catchUp();
  await client.landed();
  const expected = 'Alpha one typed.\n\nBeta two.\n\nGamma pulled three.\n';
  assert.equal(view.text, expected);
  assert.equal(await readFile(docPath, 'utf8'), expected);
  await host.close();
});

test('A3 C5: an edit whose answer was lost, sent again after more edits landed than the log holds, lands once', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const wire = line(host);
  const { view, client } = page(() => wire);
  receive = wire.events((event) => client.receive(event));
  client.start(await host.call('state'));
  wire.up = false;
  view.text = view.text.replace('one', 'one typed');
  client.flush();
  await until(async () => (await host.call('state')).text.includes('typed'), 'the edit landed');
  for (let i = 0; i < 1001; i++) {
    const now = await host.call('state');
    await host.call('submit', { ops: [{ from: now.text.length, to: now.text.length, insert: i % 2 ? '' : '.' }], rev: now.rev, epoch: now.epoch, id: `other.${i}` });
  }
  wire.up = true;
  await client.catchUp();
  await client.landed();
  const text = (await host.call('state')).text;
  assert.equal(text.split('typed').length, 2, 'once');
  assert.equal(view.text, text);
  await host.close();
});

test('A5: a page that missed an event and could not catch up at once changes nothing, and later types where it means', async () => {
  const text = 'a\u{20000}b\n';
  const docPath = await tempDoc(text);
  let receive = () => {};
  let drop = 1; // the page's own edit's event is lost
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && (drop-- > 0 || receive(data)) });
  let fail = 0; // the next `state` calls that fail
  const { view, client } = page(() => ({
    call: (type, arg) => (type === 'state' && fail-- > 0 ? Promise.reject(Object.assign(new Error('The host is offline'), { code: 'offline' })) : host.call(type, arg)),
  }), () => null, text);
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  fail = 1;
  view.text = `x${text}`;
  client.flush();
  await until(() => client.idle() || fail === 0, 'the catch-up tried');
  view.text = view.text.replace('b', 'yb'); // after the pair
  client.edited();
  await client.catchUp(); // the next connection
  await client.landed();
  assert.equal(view.text, 'xa\u{20000}yb\n');
  assert.equal(await readFile(docPath, 'utf8'), 'xa\u{20000}yb\n');
  await host.close();
});

test('C5: a page that connects again to the same host catches up on the text it missed, and its cursors', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const wire = line(host);
  const { view, client } = page(() => wire);
  receive = wire.events((event) => client.receive(event));
  client.start(await host.call('state'));
  wire.up = false;
  const now = await host.call('state');
  await host.call('submit', { ops: [{ from: 0, to: 0, insert: '> ' }], rev: now.rev, epoch: now.epoch, id: 'other.1' });
  await host.call('cursor', { at: 4, rev: now.rev + 1, epoch: now.epoch });
  wire.up = true;
  await client.catchUp();
  assert.equal(view.text, `> ${TEXT}`);
  assert.deepEqual(client.cursorsShown().map((c) => c.at), [4]);
  await host.close();
});

test('A3: the edits a host wrote and never told of stay known through any number of restarts', async () => {
  const docPath = await tempDoc(TEXT);
  const settingsDir = await fakeConfig();
  const first = await openHost(docPath, { settingsDir }); // it stops before telling anything, or answering
  let host = { call: (type, arg) => (type === 'submit' ? (first.call(type, arg), new Promise(() => {})) : first.call(type, arg)) };
  const { view, client } = page(() => host);
  client.start(await first.call('state'));
  view.text = view.text.replace('Beta two', 'Beta two typed'); // an insert: two of them would both stay
  client.flush();
  await until(async () => (await readFile(docPath, 'utf8')).includes('typed'), 'the edit written');
  await first.close();
  // Started again, it writes another window's edit, and starts again.
  const second = await openHost(docPath, { settingsDir });
  const at = await second.call('state');
  await second.call('submit', { ops: [{ from: 0, to: 0, insert: '> ' }], rev: at.rev, epoch: at.epoch, id: 'other.1' });
  await second.close();
  let receive = () => {};
  host = await openHost(docPath, { settingsDir, emit: (name, data) => name === 'ops' && receive(data) });
  receive = (event) => client.receive(event);
  await client.catchUp();
  await client.landed();
  const expected = '> Alpha one.\n\nBeta two typed.\n\nGamma three.\n';
  assert.equal(view.text, expected);
  assert.equal(await readFile(docPath, 'utf8'), expected);
  await host.close();
});

test('C7: a page set to Read while away learns it as it catches up; its typing is kept, not dropped, and saved once it may write again', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const doc = await openDoc(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const sam = { id: 'p_sam', name: 'Sam', kind: 'human', level: 'write' };
  const view = { text: TEXT, getText: () => view.text, selection: () => null };
  const levels = [];
  const client = createClient({
    view,
    call: (type, arg) => doc.call(type, arg, sam),
    show: (text) => { view.text = text; },
    caughtUp: (state) => levels.push(state.level),
  });
  receive = (event) => client.receive(event);
  client.start(await doc.call('state', {}, sam));
  sam.level = 'read'; // the page never told
  view.text = view.text.replace('Beta two', 'Beta two typed');
  client.flush();
  await until(() => levels.includes('read'), 'the page told it may only read');
  assert.equal(client.idle(), false, 'the typing kept');
  assert.equal(await readFile(docPath, 'utf8'), TEXT);
  sam.level = 'write';
  await client.catchUp(); // the `level` event, or the next connection
  await client.landed();
  assert.equal(await readFile(docPath, 'utf8'), TEXT.replace('Beta two', 'Beta two typed'));
  await doc.close();
});

test('A4: a line deleted outside while two people each have an edit on it on its way: each edit lands once, and every page ends as the file', async () => {
  const text = 'One two.\nThree four.\nFive.\n';
  const docPath = await tempDoc(text);
  const pages = [];
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && pages.forEach((p) => p.client.receive(data)) });
  const gates = [];
  for (let k = 0; k < 2; k++) {
    let open;
    gates.push(new Promise((done) => { open = done; }));
    pages.push({ ...page(() => host, () => gates[k], text), open });
    pages[k].client.start(await host.call('state'));
  }
  pages[0].view.text = text.replace('Three', 'A Three');
  pages[0].client.flush();
  pages[1].view.text = text.replace('four.', 'four. B');
  pages[1].client.flush(); // both on their way, held
  await writeFile(docPath, 'One two.\nFive.\n');
  await until(async () => (await host.call('state')).text === 'One two.\nFive.\n', 'the outside change taken');
  pages[0].open();
  await until(() => pages[1].view.text.includes('A '), 'the first edit shown at the other page');
  pages[1].open();
  await Promise.all(pages.map((p) => p.client.landed()));
  const written = await readFile(docPath, 'utf8');
  assert.equal(written.split('A ').length, 2, written);
  assert.equal(written.split(' B').length, 2, written);
  assert.match(written, /^One two\.\n.*Five\.\n$/s);
  for (const p of pages) assert.equal(p.view.text, written);
  await host.close();
});

test('D4: nothing goes out during an IME composition, though others\' edits arrive; what it made goes out as one edit', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const sent = [];
  let composing = false;
  const view = { text: TEXT, getText: () => view.text, selection: () => null, composing: () => composing };
  const client = createClient({
    view,
    call: (type, arg) => {
      if (type === 'submit') sent.push(arg.ops.map((op) => op.insert).join(''));
      return host.call(type, arg);
    },
    show: (text) => { view.text = text; },
  });
  receive = (event) => client.receive(event);
  client.start(await host.call('state'));
  composing = true;
  let was = 'Alpha';
  for (const typed of ['n', 'ni', 'nihao']) {
    view.text = view.text.replace(was, `Alpha ${typed}`);
    was = `Alpha ${typed}`;
    client.edited();
    // Another's edit lands meanwhile: the page reads what is composed so far.
    const now = await host.call('state');
    await host.call('submit', { ops: [{ from: now.text.length, to: now.text.length, insert: '.' }], rev: now.rev, epoch: now.epoch, id: `other.${typed}` });
  }
  assert.deepEqual(sent, [], 'pinyin sent');
  view.text = view.text.replace('nihao', '你好');
  composing = false;
  client.edited();
  await client.landed();
  assert.deepEqual(sent.map((typed) => typed.trim()), ['你好'], 'one edit, what was composed');
  assert.equal(await readFile(docPath, 'utf8'), `${TEXT.replace('Alpha', 'Alpha 你好')}...`);
  await host.close();
});

test('C6: a page whose line drops says it is offline, stays editable, and is back once it has caught up', async () => {
  const docPath = await tempDoc(TEXT);
  let receive = () => {};
  const host = await openHost(docPath, { settingsDir: await fakeConfig(), emit: (name, data) => name === 'ops' && receive(data) });
  const wire = line(host);
  const view = { text: TEXT, getText: () => view.text, selection: () => null };
  const lines = [];
  const client = createClient({ view, call: wire.call, show: (text) => { view.text = text; }, onLine: (online) => lines.push(online) });
  receive = wire.events((event) => client.receive(event));
  client.start(await host.call('state'));
  wire.up = false;
  view.text = view.text.replace('one', 'one typed');
  client.edited();
  await until(() => lines.includes(false), 'the page told it is offline');
  view.text = view.text.replace('two', 'two typed'); // still editable
  client.edited();
  wire.up = true;
  await client.catchUp(); // the host's hello on the line made again
  await client.landed();
  assert.equal(lines.at(-1), true);
  assert.equal(await readFile(docPath, 'utf8'), TEXT.replace('one', 'one typed').replace('two', 'two typed'));
  await host.close();
});
