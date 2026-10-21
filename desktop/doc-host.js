// The doc host: one process, apart from the app's windows, that holds every
// open doc's DocService (src/host/doc-service.js), buddy runs included.
// Electron's main process pumps the input of every window, so anything slow
// a doc does there (starting a program blocks the thread for most of a
// second on Windows) would freeze them all; here it holds up only the other
// docs. doc-host-client.js starts it and talks to it.
//
// Requests from the app carry an `id`, answered with `{ id, result }` or
// `{ id, error }`:
//   open { docPath, folder }  → { docId }
//   close { docId }
//   moveTo { docId, toPath, moved } → the doc's final path (renamed with
//     its sidecar, or, with `moved`, already there)
//   running { docId } → the names of the doc's buddies at work
//   setFolder { docId, folder }
//   secrets { secrets }: the agents' secrets for the runs, decrypted by the
//     app, whose main process alone has the keychain: { <agent>: { <key>: value } }
//   call { docId, call, arg } → the doc's answer to `call`, asked as the
//     owner: the app's own calls, as the sidebar's `open`
//   attach { docId }, with a message port: a window's page talks to the doc
//     over it (`serve`)
//   closeAll
// The host says `{ type: 'ready' }` once it can take them.

import { existsSync } from 'node:fs';
import { openDoc } from '../src/host/doc-service.js';
import { renameFile } from './files.js';

// An Electron utility process; plain Node's child_process.fork in the tests.
const channel = process.parentPort
  ? { listen: (fn) => process.parentPort.on('message', (event) => fn(event.data, event.ports)), send: (message) => process.parentPort.postMessage(message) }
  : { listen: (fn) => process.on('message', (message) => fn(message, [])), send: (message) => process.send(message) };

// For the smoke test: while the file `OPENDOC_HOLD_SAVES` names exists, the answer
// to an edit waits, so the test can type while one is on its way.
const holdSaves = process.env.OPENDOC_HOLD_SAVES;
const held = async () => {
  while (holdSaves && existsSync(holdSaves)) await new Promise((done) => setTimeout(done, 50));
};

const docs = new Map(); // docId → { service, ports: Set }
let nextId = 0;
let secrets = {};

const docOf = (docId) => {
  const found = docs.get(docId);
  if (!found) throw new Error('that doc is not open');
  return found;
};

const handlers = {
  async open({ docPath, folder = null }) {
    const docId = ++nextId;
    const entry = { service: null, ports: new Set() };
    docs.set(docId, entry);
    try {
      entry.service = await openDoc(docPath, { folder, secrets: () => secrets, emit: (event, data) => { for (const port of entry.ports) port.postMessage({ event, data }); } });
    } catch (error) {
      docs.delete(docId);
      throw error;
    }
    return { docId };
  },
  async close({ docId }) {
    const found = docs.get(docId);
    docs.delete(docId);
    for (const port of found?.ports ?? []) port.close();
    await found?.service.close();
  },
  // `moved`: the doc is already at `toPath` (its folder moved); the doc follows it.
  moveTo: ({ docId, toPath, moved }) => docOf(docId).service.moveTo(toPath, moved ? async () => toPath : renameFile),
  running: ({ docId }) => docOf(docId).service.runner.statuses().map((s) => s.name),
  setFolder: ({ docId, folder }) => docOf(docId).service.setFolder(folder),
  secrets({ secrets: next }) {
    secrets = next;
  },
  async call({ docId, call, arg }) {
    const { service } = docOf(docId);
    return service.call(call, arg, await service.owner());
  },
  attach({ docId }, ports) {
    serve(docOf(docId), ports[0]);
  },
  async closeAll() {
    const all = [...docs.values()];
    docs.clear();
    await Promise.allSettled(all.map((d) => d.service.close()));
  },
};

/**
 * A page's requests over `port`, each as the owner (a window is theirs):
 * `{ id, type, arg }`, answered with
 * `{ id, result }` or `{ id, error: { message, code } }`. Events go to it as
 * `{ event, data }`, starting with `hello`.
 */
function serve(entry, port) {
  entry.ports.add(port);
  port.on('message', async ({ data: { id, type, arg } }) => {
    try {
      const result = (await entry.service.call(type, arg, await entry.service.owner())) ?? null;
      if (type === 'submit') await held();
      port.postMessage({ id, result });
    } catch (error) {
      if (!error.code) console.error(error);
      port.postMessage({ id, error: { message: String(error?.message ?? error), code: error?.code } });
    }
  });
  port.on('close', () => entry.ports.delete(port));
  port.start();
  port.postMessage({ event: 'hello', data: entry.service.hello() });
}

channel.listen(async ({ id, type, ...arg }, ports) => {
  try {
    if (!Object.hasOwn(handlers, type)) throw new Error(`unknown request: ${type}`);
    channel.send({ id, result: (await handlers[type](arg, ports)) ?? null });
  } catch (error) {
    // The fields the app shows; `code` and `path` name a doc that already exists.
    channel.send({ id, error: { message: String(error?.message ?? error), code: error?.code, path: error?.path } });
  }
});

// A promise nobody waits on is logged rather than taking every open doc down.
process.on('unhandledRejection', (error) => console.error(error));

channel.send({ type: 'ready' });
