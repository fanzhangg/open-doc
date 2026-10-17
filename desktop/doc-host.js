// The doc host: one process, apart from the app's windows, that runs the
// local server of every open doc (src/server/server.js), agent runs included.
// Electron's main process pumps the input of every window, so anything slow
// a server does there (starting an agent's program blocks the thread for most
// of a second on Windows) would freeze them all; here it holds up only the
// other servers. doc-host-client.js starts it and talks to it.
//
// Requests carry an `id`, answered with `{ id, result }` or `{ id, error }`:
//   start { docPath, folder }  → { serverId, url }
//   close { serverId }
//   moveTo { serverId, toPath, moved } → the doc's final path (renamed with
//     its sidecar, or, with `moved`, already there)
//   setFolder { serverId, folder }
//   closeAll
// The host says `{ type: 'ready' }` once it can take them.

import { startServer } from '../src/server/server.js';
import { renameDoc } from './files.js';

// An Electron utility process; plain Node's child_process.fork in the tests.
const channel = process.parentPort
  ? { listen: (fn) => process.parentPort.on('message', (event) => fn(event.data)), send: (message) => process.parentPort.postMessage(message) }
  : { listen: (fn) => process.on('message', fn), send: (message) => process.send(message) };

const servers = new Map();
let nextId = 0;

const server = (serverId) => {
  const found = servers.get(serverId);
  if (!found) throw new Error('that doc is not open');
  return found;
};

const handlers = {
  async start({ docPath, folder = null }) {
    const started = await startServer(docPath, { agentFromSettings: true, folder });
    const serverId = ++nextId;
    servers.set(serverId, started);
    return { serverId, url: started.url };
  },
  async close({ serverId }) {
    const found = servers.get(serverId);
    servers.delete(serverId);
    await found?.close();
  },
  // `moved`: the doc is already at `toPath` (its folder moved); the server follows it.
  moveTo: ({ serverId, toPath, moved }) => server(serverId).moveTo(toPath, moved ? async () => toPath : renameDoc),
  setFolder: ({ serverId, folder }) => server(serverId).setFolder(folder),
  async closeAll() {
    const all = [...servers.values()];
    servers.clear();
    await Promise.allSettled(all.map((s) => s.close()));
  },
};

channel.listen(async ({ id, type, ...arg }) => {
  try {
    if (!Object.hasOwn(handlers, type)) throw new Error(`unknown request: ${type}`);
    channel.send({ id, result: (await handlers[type](arg)) ?? null });
  } catch (error) {
    // The fields the app shows; `code` and `path` name a doc that already exists.
    channel.send({ id, error: { message: String(error?.message ?? error), code: error?.code, path: error?.path } });
  }
});

// A promise nobody waits on is logged rather than taking every open doc down.
process.on('unhandledRejection', (error) => console.error(error));

channel.send({ type: 'ready' });
