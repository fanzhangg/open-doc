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
//   share { folder }: teammates' pages reach the project in `folder` (a
//     real path) through the relay, if it has a link (`share`); answered
//     once the host is in its room. Opening a doc of the project does it too.
//   closeAll
// The host says `{ type: 'ready' }` once it can take them, and
// `{ type: 'join', folder, name }` when someone asks to join a project.
//
// The relay is at OPENDOC_RELAY (a ws: or wss: URL; none: no sharing), and
// a link opens the teammate's page at OPENDOC_TEAM_PAGE (by default the
// one the site publishes) with the relay and the room.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { openDoc } from '../src/host/doc-service.js';
import { projectService } from '../src/host/project-service.js';
import { createTeam } from '../src/host/team.js';
import { renameFile } from './files.js';
import { firstDoc, listDocs } from './folder.js';

const RELAY = process.env.OPENDOC_RELAY || null;
const TEAM_PAGE = process.env.OPENDOC_TEAM_PAGE || 'https://fanzhangg.github.io/open-doc/preview/team.html';

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

// docId → { service, ports: Map(port → its who's level), opens: how many
// times the app has it open }. A doc is open once however many reach it:
// the app's windows and teammates' pages share it, and it closes when
// neither has it.
const docs = new Map();
let nextId = 0;
let secrets = {};
// The real path of each project folder a doc was opened in → { team, sharing },
// `sharing` while teammates' pages reach it (`share`).
const projects = new Map();

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
    const entry = { service: null, ports: new Map(), opens: 0 };
    entry.service = await openDoc(docPath, { folder, team: folder && teamOf(folder), secrets: () => secrets, emit: (event, data) => {
      for (const [port, level] of entry.ports) if ((event !== 'settings' && event !== 'team') || level === 'owner') port.postMessage({ event, data });
    } });
    docs.set(docId, entry);
    if (folder) startSharing(folder).catch((error) => console.error(error));
    return docId;
  });
}

// The Team of the project at real path `folder`, made once; a new link
// shares the project at it, ending the one before.
function teamOf(folder) {
  if (!projects.has(folder)) {
    const team = createTeam(folder, { linkOf: RELAY && ((secret) => `${TEAM_PAGE}?${new URLSearchParams({ relay: RELAY, room: roomOf(secret) })}`) });
    projects.set(folder, { team, sharing: null });
    team.onChange(() => startSharing(folder).catch((error) => console.error(error)));
  }
  return projects.get(folder).team;
}

// Share the project at real path `folder`, whose team is made, at its
// link, unless it has none, there is no relay, or it is shared there
// already; resolves once the host is in the room.
async function startSharing(folder) {
  const project = projects.get(folder);
  const secret = await project.team.secret();
  if (!RELAY || !secret) return;
  if (project.sharing?.secret !== secret) {
    project.sharing?.stop('link_replaced');
    project.sharing = share(folder, project.team, secret);
  }
  await project.sharing.joined;
}

const roomOf = (secret) => createHash('sha256').update(secret).digest('hex');

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
    for (const [port, level] of found.ports) {
      if (level !== 'owner') continue;
      found.ports.delete(port);
      port.close();
    }
    await release(docId);
  },
  // `moved`: the doc is already at `toPath` (its folder moved); the doc follows it.
  moveTo: ({ docId, toPath, moved }) => docOf(docId).service.moveTo(toPath, moved ? async () => toPath : renameFile),
  running: ({ docId }) => docOf(docId).service.runner.statuses().map((s) => s.name),
  setFolder({ docId, folder }) {
    docOf(docId).service.setFolder(folder, folder && teamOf(folder));
    if (folder) startSharing(folder).catch((error) => console.error(error));
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
  async share({ folder }) {
    const real = await realpath(folder);
    teamOf(real);
    await startSharing(real);
  },
  async closeAll() {
    for (const project of projects.values()) project.sharing?.stop();
    projects.clear();
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
 * owner's.
 */
async function serve(entry, port, who) {
  entry.ports.set(port, (await who()).level);
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
  port.on('close', () => entry.ports.delete(port));
  port.start();
  port.postMessage({ event: 'hello', data: entry.service.hello() });
}

/**
 * Share the project in `folder` through the relay in the room of `secret`:
 * one WebSocket for every teammate's page, each a peer the relay numbers. A
 * page names its doc by its path in the project (`?doc=`; none: the
 * project's first doc), and who it is: `key`, made once in its browser
 * (the teammate's id is its hash, so no one who sees an id can pose as
 * them), and `name`. A teammate on `team` is served as a window is, at
 * their level (read or write); anyone else asks to join and waits, told
 * `waiting`, until the owner allows them. A page whose teammate is removed,
 * or turned down, is turned away at once. A connection that drops is made
 * again. `joined` resolves once the host is first in the room; `stop(reason)`
 * ends it, turning every page away with `reason` if one is given (else the
 * relay tells them the host is offline).
 */
function share(folder, team, secret) {
  const project = projectService(folder);
  const peers = new Map(); // peer → { port, id, doc, admitted }
  let socket = null;
  let stopped = false;
  let join;
  const joined = new Promise((done) => { join = done; });

  function connect() {
    socket = new WebSocket(`${RELAY}/rooms/${roomOf(secret)}?secret=${encodeURIComponent(secret)}`);
    socket.addEventListener('open', () => join());
    socket.addEventListener('message', ({ data }) => take(JSON.parse(data)));
    // A connection refused fires `error` alone, one that drops `close` too.
    let lost = false;
    const drop = () => {
      if (lost) return;
      lost = true;
      for (const peer of [...peers.keys()]) gone(peer);
      if (!stopped) setTimeout(connect, RECONNECT_MS);
    };
    socket.addEventListener('error', drop);
    socket.addEventListener('close', drop);
  }

  async function take({ peer, open, data, close }) {
    if (close) return gone(peer);
    if (!open) return peers.get(peer)?.port.receive(data);
    const port = peerPort((frame) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ peer, ...frame })));
    const id = typeof open.key === 'string' && open.key.length >= 16 ? `p_${roomOf(open.key).slice(0, 24)}` : null;
    const entry = { port, id, doc: open.doc ?? '', admitted: false, level: null };
    peers.set(peer, entry);
    let joining;
    try {
      joining = await team.join({ id, name: open.name });
    } catch (error) {
      return turnAway(peer, error.code ?? 'bad_input');
    }
    entry.level = await team.levelOf(id);
    if (joining === 'member') return admit(peer);
    if (joining === 'asked') channel.send({ type: 'join', folder, name: open.name });
    port.postMessage({ event: 'waiting' });
  }

  // Serve the page of `peer`, whose teammate is on the team, its doc.
  async function admit(peer) {
    const entry = peers.get(peer);
    if (!entry || entry.admitted) return;
    entry.admitted = true;
    // A name no project shares: a part starting with `.` (`..` too), or empty (an absolute path).
    if (entry.doc && entry.doc.split('/').some((part) => !part || part.startsWith('.'))) return turnAway(peer, 'hidden');
    try {
      const path = entry.doc || firstDoc(await listDocs(folder)) || '';
      const docId = await docAt((await project.open(path)).path, folder);
      entry.port.docId = docId;
      if (peers.get(peer) !== entry) return release(docId); // gone meanwhile
      await serve(docs.get(docId), entry.port, async () => ({
        id: entry.id, name: await team.nameOf(entry.id), kind: 'human', level: await team.levelOf(entry.id),
      }));
    } catch {
      turnAway(peer, 'not_found'); // no such doc in the project
    }
  }

  // The team changed: a page whose teammate was allowed is served, one whose
  // teammate's level changed is told `level`, and one whose teammate is no
  // longer on it, or was turned down, is turned away.
  const stopFollowing = team.onChange(async () => {
    for (const [peer, entry] of [...peers]) {
      const level = await team.levelOf(entry.id);
      if (peers.get(peer) !== entry) continue;
      if (level && entry.level && level !== entry.level) entry.port.postMessage({ event: 'level', data: { level } });
      entry.level = level;
      if (level) admit(peer);
      else if (!team.isPending(entry.id)) turnAway(peer, entry.admitted ? 'removed' : 'denied');
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
    secret,
    joined,
    stop(reason) {
      stopped = true;
      stopFollowing();
      if (reason) for (const peer of [...peers.keys()]) turnAway(peer, reason);
      socket.close();
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

// How long a host whose relay connection dropped waits to connect again.
const RECONNECT_MS = 1000;

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
