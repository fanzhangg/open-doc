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
//
// A project's room (src/host/room.js) opens when the owner asks it at the
// door (`openRoom`), and ends when they close it, or close the project's
// last window: every page is turned away, `closed`. The relay is at
// PONJO_RELAY (a ws: or wss: URL; empty: no sharing), by default the one
// deployed (relay/wrangler.toml), and a link opens the player's page it
// serves, at the same origin, with the room.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { openDoc } from '../src/host/doc-service.js';
import { projectService } from '../src/host/project-service.js';
import { createRoom } from '../src/host/room.js';
import { renameFile } from './files.js';
import { firstDoc, listDocs } from './folder.js';

const RELAY = process.env.PONJO_RELAY ?? 'wss://share.ponjo.app';

// An Electron utility process; plain Node's child_process.fork in the tests.
const channel = process.parentPort
  ? { listen: (fn) => process.parentPort.on('message', (event) => fn(event.data, event.ports)), send: (message) => process.parentPort.postMessage(message) }
  : { listen: (fn) => process.on('message', (message) => fn(message, [])), send: (message) => process.send(message) };

// For the smoke test: while the file `PONJO_HOLD_SAVES` names exists, the answer
// to an edit waits, so the test can type while one is on its way.
const holdSaves = process.env.PONJO_HOLD_SAVES;
const held = async () => {
  while (holdSaves && existsSync(holdSaves)) await new Promise((done) => setTimeout(done, 50));
};

// docId → { service, folder, ports: Map(port → its who), opens: how many
// times the app has it open }. A doc is open once however many reach it:
// the app's windows and players' pages share it, and it closes when
// neither has it.
const docs = new Map();
let nextId = 0;
let secrets = {};
// The real path of each project folder a doc was opened in → its Room.
const rooms = new Map();

// Docs open and close one at a time, so a doc is never open twice.
let opening = Promise.resolve();
const oneAtATime = (fn) => {
  const run = opening.then(fn);
  opening = run.catch(() => {});
  return run;
};

// The doc at `docPath`, open: the one already open at that real path, or
// opened now.
function docAt(docPath, folder) {
  return oneAtATime(async () => {
    const real = await realpath(docPath).catch(() => docPath);
    for (const [docId, entry] of docs) {
      if (await realpath(entry.service.docPath()).catch(() => null) === real) return docId;
    }
    const docId = ++nextId;
    const entry = { service: null, folder, ports: new Map(), opens: 0 };
    entry.service = await openDoc(docPath, { folder, room: folder && roomOf(folder), secrets: () => secrets, emit: (event, data) => {
      for (const [port, { level }] of entry.ports) if ((event !== 'settings' && event !== 'room') || level === 'owner') port.postMessage({ event, data });
    } });
    docs.set(docId, entry);
    return docId;
  });
}

// The Room of the project at real path `folder`, made once.
function roomOf(folder) {
  if (!rooms.has(folder)) {
    const room = createRoom(folder, { host: RELAY ? (secret) => share(folder, room, secret) : null });
    rooms.set(folder, room);
  }
  return rooms.get(folder);
}

// The room of the project at `folder` ends once the app has none of its docs open.
function closeRoomIfLeft(folder) {
  if (folder && ![...docs.values()].some((entry) => entry.folder === folder && entry.opens > 0)) rooms.get(folder)?.close();
}

const hash = (text) => createHash('sha256').update(text).digest('hex');

// Close doc `docId` once neither the app nor a page has it.
function release(docId) {
  return oneAtATime(async () => {
    const found = docs.get(docId);
    if (!found || found.opens > 0 || found.ports.size > 0) return;
    docs.delete(docId);
    await found.service.close();
  });
}

const docOf = (docId) => {
  const found = docs.get(docId);
  if (!found) throw new Error('that doc is not open');
  return found;
};

const handlers = {
  async open({ docPath, folder = null }) {
    const docId = await docAt(docPath, folder);
    docs.get(docId).opens++;
    return { docId };
  },
  async close({ docId }) {
    const found = docs.get(docId);
    if (!found || --found.opens > 0) return;
    for (const [port, { level }] of found.ports) {
      if (level !== 'owner') continue;
      found.ports.delete(port);
      port.close();
    }
    closeRoomIfLeft(found.folder);
    await release(docId);
  },
  // `moved`: the doc is already at `toPath` (its folder moved); the doc follows it.
  moveTo: ({ docId, toPath, moved }) => docOf(docId).service.moveTo(toPath, moved ? async () => toPath : renameFile),
  running: ({ docId }) => docOf(docId).service.runner.statuses().map((s) => s.name),
  setFolder({ docId, folder }) {
    const was = docOf(docId).folder;
    docOf(docId).folder = folder;
    docOf(docId).service.setFolder(folder, folder && roomOf(folder));
    closeRoomIfLeft(was);
  },
  secrets({ secrets: next }) {
    secrets = next;
  },
  async call({ docId, call, arg }) {
    const { service } = docOf(docId);
    return service.call(call, arg, await service.owner());
  },
  attach({ docId }, ports) {
    const entry = docOf(docId);
    return serve(entry, ports[0], () => entry.service.owner());
  },
  async closeAll() {
    await Promise.allSettled([...rooms.values()].map((room) => room.close()));
    rooms.clear();
    const all = [...docs.values()];
    docs.clear();
    await Promise.allSettled(all.map((d) => d.service.close()));
  },
};

/**
 * A page's requests over `port`, each as `who()`, the `who` the host gave
 * the connection (a window's is the owner): `{ id, type, arg }`, answered
 * with `{ id, result }` or `{ id, error: { message, code } }`. Events go to
 * it as `{ event, data }`, starting with `hello`; the settings, only to the
 * owner's. Everyone on the project hears who is here (`here`) as it changes.
 */
async function serve(entry, port, who) {
  const person = await who();
  entry.ports.set(port, person);
  tellHere(entry.folder);
  port.on('message', async ({ data: { id, type, arg } }) => {
    try {
      const result = (await entry.service.call(type, arg, await who())) ?? null;
      if (type === 'submit') await held();
      port.postMessage({ id, result });
    } catch (error) {
      if (!error.code) console.error(error);
      port.postMessage({ id, error: { message: String(error?.message ?? error), code: error?.code } });
    }
  });
  port.on('close', () => {
    entry.ports.delete(port);
    if (![...entry.ports.values()].some((p) => p.id === person.id)) entry.service.leave(person.id);
    tellHere(entry.folder);
  });
  port.start();
  port.postMessage({ event: 'hello', data: entry.service.hello() });
}

/**
 * Tell everyone on the project in `folder` (none: a doc on its own) who has
 * a window or page on any of its docs: [{ id, name, owner, doc: whether on
 * the doc they are on }], each person once.
 */
function tellHere(folder) {
  if (!folder) return;
  const entries = [...docs.values()].filter((entry) => entry.folder === folder);
  for (const entry of entries) {
    for (const port of entry.ports.keys()) {
      const here = new Map();
      for (const other of entries) {
        for (const { id, name, level } of other.ports.values()) {
          here.set(id, { id, name, owner: level === 'owner', doc: here.get(id)?.doc || other === entry });
        }
      }
      port.postMessage({ event: 'here', data: [...here.values()] });
    }
  }
}

/**
 * Put `room`, the project in `folder`'s, on the relay, in the relay's room
 * named by the SHA-256 of `secret`: one WebSocket for every player's page,
 * each a peer the relay numbers. The host's first message proves it holds
 * `secret`. A page's first names its doc by its path in the project (`doc`;
 * none: the project's first) and who it is: `key`, made once in its browser
 * (the player's id is its hash, so no one who sees an id can pose as them),
 * and `name`. The page joins the room (room.js) and is served as a window
 * is, at its player's level; one the room refuses (`locked`, `kicked`) is
 * turned away, and so is one whose player is kicked. A connection that
 * drops is made again. Returns { link, joined: resolves once the host is
 * first in the room, rejects if its line drops before; stop(reason): ends
 * it, turning every page away with `reason` if one is given, and resolves
 * once the line is closed }.
 */
function share(folder, room, secret) {
  const project = projectService(folder);
  const peers = new Map(); // peer → { port, id, doc, level: null until it is served }
  let socket = null;
  let stopped = false;
  let hosting = false; // the relay took the host in once
  let join;
  let fail;
  const joined = new Promise((done, failed) => {
    join = done;
    fail = failed;
  });

  let retry = RECONNECT_MS;

  function connect() {
    if (stopped) return;
    const line = new WebSocket(`${RELAY}/rooms/${hash(secret)}?host`);
    socket = line;
    line.addEventListener('open', () => line.send(JSON.stringify({ secret })));
    line.addEventListener('message', ({ data }) => take(JSON.parse(data)));
    // A connection refused fires `error` alone, one that drops `close` too.
    let lost = false;
    const drop = () => {
      if (lost) return;
      lost = true;
      for (const peer of [...peers.keys()]) gone(peer);
      if (!hosting) return fail(new Error('the relay cannot be reached'));
      setTimeout(connect, retry);
      retry = Math.min(2 * retry, MAX_RECONNECT_MS);
    };
    line.addEventListener('error', drop);
    line.addEventListener('close', drop);
  }

  async function take({ hosting: taken, peer, open, data, close }) {
    if (taken) {
      hosting = true;
      retry = RECONNECT_MS;
      return join();
    }
    if (close) return gone(peer);
    if (!open) return peers.get(peer)?.port.receive(data);
    const port = peerPort((frame) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      let text = JSON.stringify({ peer, ...frame });
      // A frame too big for the relay would close the host's line, and every
      // page's with it: an answer goes as an error instead; an event is left
      // out, and the page catches up when it sees one missed.
      if (text.length > MAX_FRAME) {
        const { id } = JSON.parse(frame.data);
        if (id === undefined) return;
        text = JSON.stringify({ peer, data: JSON.stringify({ id, error: { message: 'This doc is too big to open through sharing', code: 'too_big' } }) });
      }
      socket.send(text);
    });
    const id = typeof open.key === 'string' && open.key.length >= 16 ? `p_${hash(open.key).slice(0, 24)}` : null;
    const entry = { port, id, doc: typeof open.doc === 'string' ? open.doc : '', level: null };
    peers.set(peer, entry);
    try {
      await room.join({ id, name: open.name });
    } catch (error) {
      return turnAway(peer, error.code ?? 'bad_input');
    }
    if (peers.get(peer) !== entry) return; // gone meanwhile
    entry.level = room.levelOf(id);
    // A name no project shares: a part starting with `.` (`..` too), or empty (an absolute path).
    if (entry.doc && entry.doc.split('/').some((part) => !part || part.startsWith('.'))) return turnAway(peer, 'hidden');
    try {
      const path = entry.doc || firstDoc(await listDocs(folder)) || '';
      const docId = await docAt((await project.open(path)).path, folder);
      entry.port.docId = docId;
      if (peers.get(peer) !== entry) return release(docId); // gone meanwhile
      await serve(docs.get(docId), entry.port, () => ({ id, name: room.nameOf(id), kind: 'human', level: room.levelOf(id) }));
    } catch {
      turnAway(peer, 'not_found'); // no such doc in the project
    }
  }

  // The room changed: a page whose player's level changed is told `level`,
  // and one whose player was kicked is turned away.
  const stopFollowing = room.onChange(() => {
    for (const [peer, entry] of [...peers]) {
      if (entry.level === null) continue;
      const level = room.levelOf(entry.id);
      if (!level) turnAway(peer, 'kicked');
      else if (level !== entry.level) {
        entry.level = level;
        entry.port.postMessage({ event: 'level', data: { level } });
      }
    }
  });

  function turnAway(peer, reason) {
    const entry = peers.get(peer);
    peers.delete(peer);
    entry?.port.close(reason);
  }

  function gone(peer) {
    const entry = peers.get(peer);
    peers.delete(peer);
    entry?.port.closed();
  }

  connect();
  return {
    link: `${RELAY.replace(/^ws/, 'http')}/team?room=${hash(secret)}`,
    joined,
    stop(reason) {
      stopped = true;
      stopFollowing();
      if (reason) for (const peer of [...peers.keys()]) turnAway(peer, reason);
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      return new Promise((done) => {
        socket.addEventListener('close', done);
        socket.close(); // after the frames that turn the pages away
      });
    },
  };
}

// A page reached through the relay, as a message port: messages taken
// before `start()` wait for it. `send(frame)` sends a frame to the relay;
// `receive(text)` takes a message from the page, `closed()` the page gone;
// `close(reason)` turns the page away.
function peerPort(send) {
  const handlers = {};
  let waiting = [];
  const port = {
    docId: null,
    on: (event, fn) => { handlers[event] = fn; },
    start() {
      for (const message of waiting) handlers.message({ data: message });
      waiting = null;
    },
    postMessage: (message) => send({ data: JSON.stringify(message) }),
    receive(text) {
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        return; // not a request
      }
      if (waiting) waiting.push(message);
      else handlers.message({ data: message });
    },
    close(reason) {
      send({ close: reason });
      port.closed();
    },
    closed() {
      if (port.docId === null) return;
      const { docId } = port;
      port.docId = null;
      handlers.close?.();
      release(docId);
    },
  };
  return port;
}

// How long a host whose relay connection dropped waits to connect again:
// twice as long each time it is not made, up to MAX_RECONNECT_MS.
const RECONNECT_MS = 1000;
const MAX_FRAME = 8 * 2 ** 20; // characters: MAX_MESSAGE in relay/worker.js
const MAX_RECONNECT_MS = 30_000;

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
