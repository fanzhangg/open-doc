// The relay run locally by wrangler (relay/; `npm ci --prefix relay` first),
// a doc host forked as the app starts one, hosting a project's room
// through it, and a player's page reaching it as web/relay.js does, in
// Node: for the relay test (test/relay.test.js) and the typing promise
// (test/perf/typing.test.js).

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relayHost } from '../../web/relay.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The relay, started, serving the player's page from dist/web (`npm run
 * build` first): { url, its ws: URL; origin, its http: one; stop() }.
 */
export async function startRelay() {
  const wrangler = createRequire(join(root, 'relay', 'package.json')).resolve('wrangler');
  process.env.WRANGLER_LOG ??= 'error'; // not every request
  const { unstable_startWorker } = await import(pathToFileURL(wrangler).href);
  // Nothing kept on disk: each relay starts with no rooms counted against the limit.
  const worker = await unstable_startWorker({ config: join(root, 'relay', 'wrangler.toml'), dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false, persist: false } });
  const { host } = await worker.url;
  return { url: `ws://${host}`, origin: `http://${host}`, stop: () => worker.dispose() };
}

/** The relay's room for `secret`. */
export const roomOf = (secret) => createHash('sha256').update(secret).digest('hex');

/** A player's browser: its key, made once, and their name. */
export const player = (name = 'Sam') => ({ key: `k-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, name });

/** The id the host knows the player of `key` by (desktop/doc-host.js). */
export const idOf = (key) => `p_${roomOf(key).slice(0, 24)}`;

/**
 * A project folder holding `doc` with `text` (and a hidden
 * .ponjo/secret.md), and a config folder for its owner.
 */
export async function project(text, doc = 'plan.md') {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  await writeFile(join(folder, doc), text);
  await mkdir(join(folder, '.ponjo'));
  await writeFile(join(folder, '.ponjo', 'secret.md'), 'hidden\n');
  const config = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
  await writeFile(join(config, 'settings.json'), JSON.stringify({ name: 'owner', agents: [] }));
  await mkdir(join(config, 'buddies'));
  await writeFile(join(config, 'buddies', 'Clippy.md'), 'Helps.\n'); // the owner's, from their first run
  return { folder, config, doc };
}

/**
 * The owner's doc host, as the app starts it, with the relay at `relay`,
 * and the owner's window on the project's doc, whose room is open:
 * `request(type, arg)` asks the host as the app does, `call(type, arg)`
 * asks the doc as that window does (`docId`); `room` names the room in the
 * link (`link`).
 */
export async function startHost({ folder, config, doc }, relay) {
  const child = fork(join(root, 'desktop', 'doc-host.js'), [], { env: { ...process.env, PONJO_CONFIG_DIR: config, PONJO_RELAY: relay }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const asked = new Map();
  let nextId = 0;
  const ready = new Promise((done) => child.once('message', done));
  child.on('message', ({ id, result, error }) => {
    asked.get(id)?.[error ? 1 : 0](error ?? result);
    asked.delete(id);
  });
  const request = async (type, arg = {}) => {
    await ready;
    return new Promise((done, fail) => {
      const id = ++nextId;
      asked.set(id, [done, fail]);
      child.send({ id, type, ...arg });
    });
  };
  const { docId } = await request('open', { docPath: join(folder, doc), folder });
  const call = (type, arg) => request('call', { docId, call: type, arg });
  const { link } = await call('openRoom').catch((error) => {
    child.kill();
    throw error;
  });
  return { request, call, docId, link, room: new URL(link).searchParams.get('room'), kill: () => child.kill() };
}

/**
 * The page of player `who` ({ key, name }) in room `room` on `doc` (none:
 * the project's first): `call` resolves to { result } or { error },
 * `events` holds what it heard, `lines` how its line was, each change, and
 * `onEvent(fn)` hears each event.
 */
export function page(relay, room, who, doc = null) {
  const host = relayHost(relay, new URLSearchParams({ room, ...(doc ? { doc } : {}) }), () => who);
  const events = [];
  const lines = [];
  const listeners = [];
  host.onEvent((event, data) => {
    events.push({ event, data });
    for (const fn of listeners) fn(event, data);
  });
  host.onLine((line) => lines.push(line?.reason === 'refused' ? `refused ${line.code}` : line?.reason ?? 'in'));
  return { call: host.call, events, lines, onEvent: (fn) => listeners.push(fn) };
}
