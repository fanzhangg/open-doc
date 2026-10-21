// The page's client (web/client.js) against a real DocService: typing lands
// and is written; a doc host that starts again (a new epoch) loses nothing
// typed, and takes what changed on disk meanwhile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '../web/client.js';
import { openDoc } from '../src/host/doc-service.js';
import { fakeConfig, tempDoc, until } from './helpers.js';

const TEXT = 'Alpha one.\n\nBeta two.\n\nGamma three.\n';

// The doc host at `docPath`, called as its owner, as a window's port does.
async function openHost(docPath, options) {
  const doc = await openDoc(docPath, options);
  return { ...doc, call: async (type, arg) => doc.call(type, arg, await doc.owner()) };
}

// A view the test types into, and a client joining it to the doc host
// `host()`; its edits wait for `gate` on their way.
function page(host, gate = () => null) {
  const view = { text: TEXT, getText: () => view.text, selection: () => null };
  const client = createClient({
    view,
    call: async (type, arg) => {
      if (type === 'submit') await gate();
      return host().call(type, arg);
    },
    show: (text) => { view.text = text; },
    rules: () => [],
    onError: (error) => { throw error; },
  });
  return { view, client };
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
  await client.resync(); // the page's new connection says hello
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

test('an outside change that lands while typing is on its way yields to the typing, in the page and the doc alike', async () => {
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
  assert.equal(view.text, 'Alpha one.\n\nBeta typed.\n\nGamma pulled.\n', 'shown yielding to the typing');
  open();
  await client.landed();
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
  await until(async () => (await host.call('state')).rev === 1, 'the edit landed');
  await writeFile(docPath, (await host.call('state')).text.replace('Gamma three', 'Gamma pulled'));
  await until(() => view.text.includes('Gamma pulled'), 'the next edit shown');
  await client.landed();
  const expected = 'Alpha one.\n\nBeta two typed.\n\nGamma pulled.\n';
  assert.equal(view.text, expected);
  assert.equal((await host.call('state')).text, expected);
  await host.close();
});

test('a doc host that stops after writing an edit, before telling the page: started again, it says so, and the edit is not sent twice', async () => {
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
  await client.resync(); // the page's new connection says hello
  await client.landed();
  const expected = 'Alpha one.\n\nBeta two typed.\n\nGamma three.\n';
  assert.equal(view.text, expected);
  assert.equal((await host.call('state')).text, expected);
  assert.equal(await readFile(docPath, 'utf8'), expected);
  await host.close();
});
