// The main process's side of the doc host (doc-host.js): it starts the host,
// hands it the docs to serve and keeps track of them, so that a host that
// stops serves them again from a new one. Plain Node (no Electron): main.js
// passes in how to start the host, so the tests run under `node --test`.

/**
 * @typedef {{ url: string, close: () => Promise<void>, moveTo: (toPath: string, options?: { moved?: boolean }) => Promise<string>, running: () => Promise<string[]>, setFolder: (folder: string | null) => Promise<void>, onRestart: ((url: string) => void) | null }} DocServer
 */

const SHUTDOWN_PATIENCE_MS = 5000;
// A host that keeps stopping this often is not started again.
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/**
 * Start the doc host now, with `fork()`, which starts a host process and
 * returns it as `{ postMessage(message), on('message' | 'exit', fn), kill() }`
 * (an Electron UtilityProcess). Requests wait until the host is ready.
 *
 * `startDocServer(docPath, { folder })` serves a doc and resolves to a
 * DocServer: `url`, `close()`, `moveTo(toPath, { moved })` (renames the doc
 * and its sidecar, never over another file, or with `moved` follows a doc
 * already there; resolves to the final path), `running()` (the names of
 * the doc's agents at work), `setFolder(folder)`, and `onRestart`, called with the new `url` once a
 * host that stopped serves the doc again. `shutdown()` closes every doc and
 * stops the host, for quitting.
 */
export function createDocHost({ fork, log = console.error }) {
  let child = null;
  let ready = false;
  let queue = [];
  const pending = new Map();
  let nextId = 0;
  const served = new Set(); // DocServers open, to serve again after a restart
  const stops = [];
  let shuttingDown = null;
  let gaveUp = false;

  function launch() {
    const started = fork();
    child = started;
    ready = false;
    started.on('message', (message) => {
      if (started === child) onMessage(message);
    });
    started.on('exit', (code) => {
      if (started === child) onExit(code);
    });
  }

  function onMessage(message) {
    if (message?.type === 'ready') {
      ready = true;
      for (const queued of queue.splice(0)) child.postMessage(queued);
      return;
    }
    const call = pending.get(message?.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(revive(message.error));
    else call.resolve(message.result);
  }

  function onExit(code) {
    child = null;
    ready = false;
    queue = [];
    const lost = new Error('The doc host stopped.');
    for (const call of pending.values()) call.reject(lost);
    pending.clear();
    if (shuttingDown) return;
    const now = Date.now();
    stops.push(now);
    while (stops.length > 0 && stops[0] < now - RESTART_WINDOW_MS) stops.shift();
    if (stops.length > MAX_RESTARTS) {
      gaveUp = true;
      log(new Error(`The doc host stopped (exit code ${code}) ${stops.length} times in a minute; not starting it again.`));
      return;
    }
    log(new Error(`The doc host stopped (exit code ${code}); starting it again.`));
    launch();
    for (const doc of served) doc.restart();
  }

  function request(type, arg = {}) {
    if (gaveUp) return Promise.reject(new Error('The doc host keeps stopping. Restart OpenDoc.'));
    if (!child) launch();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const message = { id, type, ...arg };
      if (ready) child.postMessage(message);
      else queue.push(message);
    });
  }

  async function startDocServer(docPath, { folder = null } = {}) {
    if (shuttingDown) throw new Error('OpenDoc is quitting.');
    const first = await request('start', { docPath, folder });
    let serverId = first.serverId;
    let started = Promise.resolve();
    let closed = false;
    const doc = {
      url: first.url,
      onRestart: null,
      async close() {
        if (closed) return;
        closed = true;
        served.delete(doc);
        await started.catch(() => {});
        if (serverId !== null) await request('close', { serverId });
      },
      async moveTo(toPath, { moved = false } = {}) {
        await started;
        docPath = await request('moveTo', { serverId, toPath, moved });
        return docPath;
      },
      async running() {
        await started;
        return request('running', { serverId });
      },
      async setFolder(next) {
        await started;
        folder = next;
        await request('setFolder', { serverId, folder });
      },
      // Serve the doc again from a new host; the page then loads the new url.
      restart() {
        serverId = null;
        started = request('start', { docPath, folder }).then((result) => {
          serverId = result.serverId;
          if (closed) return; // close() closes it once this is done
          doc.url = result.url;
          doc.onRestart?.(result.url);
        });
        started.catch((error) => log(error));
      },
    };
    served.add(doc);
    return doc;
  }

  function shutdown() {
    shuttingDown ??= (async () => {
      const host = child;
      if (!host) return;
      let timer;
      await Promise.race([
        request('closeAll').catch(() => {}),
        new Promise((resolve) => { timer = setTimeout(resolve, SHUTDOWN_PATIENCE_MS); }),
      ]);
      clearTimeout(timer);
      served.clear();
      if (host === child) host.kill();
    })();
    return shuttingDown;
  }

  launch();
  return { startDocServer, shutdown };
}

// An error as the host sent it, with the fields the app's dialogs read.
function revive({ message, code, path }) {
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  if (path !== undefined) error.path = path;
  return error;
}
