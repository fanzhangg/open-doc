// The main process's side of the doc host (doc-host.js): it starts the host,
// hands it the docs to open and keeps track of them, so that a host that
// stops opens them again in a new one. Plain Node (no Electron): main.js
// passes in how to start the host, so the tests run under `node --test`.

/**
 * @typedef {{ attach: (port: object) => Promise<void>, close: () => Promise<void>, moveTo: (toPath: string, options?: { moved?: boolean }) => Promise<string>, running: () => Promise<string[]>, setFolder: (folder: string | null) => Promise<void>, onRestart: (() => void) | null }} HostedDoc
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
 * `openHostedDoc(docPath, { folder })` opens a doc and resolves to a
 * HostedDoc: `attach(port)` (a window's page talks to the doc over the
 * message port), `close()`, `moveTo(toPath, { moved })` (renames the doc
 * and its sidecar, never over another file, or with `moved` follows a doc
 * already there; resolves to the final path), `running()` (the names of
 * the doc's buddies at work), `setFolder(folder)`, and `onRestart`, called
 * once a host that stopped has the doc open again (its pages attach again).
 * `setSecrets(secrets)` hands the host the agents' secrets, decrypted
 * (doc-host.js), and every host started after it; it resolves once the host
 * has them. `shutdown()` closes every doc and stops the host, for quitting.
 */
export function createDocHost({ fork, log = console.error }) {
  let child = null;
  let ready = false;
  let queue = [];
  const pending = new Map();
  let nextId = 0;
  const served = new Set(); // HostedDocs open, to serve again after a restart
  const stops = [];
  let shuttingDown = null;
  let gaveUp = false;
  let secrets = null;

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
    if (secrets) request('secrets', { secrets }).catch(log); // before any doc opens
  }

  function onMessage(message) {
    if (message?.type === 'ready') {
      ready = true;
      for (const queued of queue.splice(0)) child.postMessage(...queued);
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

  // `transfer`: message ports that go with the request.
  function request(type, arg = {}, transfer = []) {
    if (gaveUp) return Promise.reject(new Error('The doc host keeps stopping. Restart OpenDoc.'));
    if (shuttingDown && !child) return Promise.reject(new Error('OpenDoc is quitting.'));
    if (!child) launch();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const message = [{ id, type, ...arg }, transfer];
      if (ready) child.postMessage(...message);
      else queue.push(message);
    });
  }

  async function openHostedDoc(docPath, { folder = null } = {}) {
    if (shuttingDown) throw new Error('OpenDoc is quitting.');
    let docId = (await request('open', { docPath, folder })).docId;
    let started = Promise.resolve();
    let closed = false;
    const doc = {
      onRestart: null,
      async attach(port) {
        await started;
        await request('attach', { docId }, [port]);
      },
      async close() {
        if (closed) return;
        closed = true;
        served.delete(doc);
        await started.catch(() => {});
        if (docId !== null) await request('close', { docId });
      },
      async moveTo(toPath, { moved = false } = {}) {
        await started;
        docPath = await request('moveTo', { docId, toPath, moved });
        return docPath;
      },
      async running() {
        await started;
        return request('running', { docId });
      },
      async setFolder(next) {
        await started;
        folder = next;
        await request('setFolder', { docId, folder });
      },
      // Open the doc again in a new host; its pages then attach again.
      restart() {
        docId = null;
        started = request('open', { docPath, folder }).then((result) => {
          docId = result.docId;
          if (closed) return; // close() closes it once this is done
          doc.onRestart?.();
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

  function setSecrets(next) {
    secrets = next;
    return request('secrets', { secrets });
  }

  launch();
  return { openHostedDoc, setSecrets, shutdown };
}

// An error as the host sent it, with the fields the app's dialogs read.
function revive({ message, code, path }) {
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  if (path !== undefined) error.path = path;
  return error;
}
