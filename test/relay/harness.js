// The relay run locally by wrangler (relay/; `npm ci --prefix relay` first),
// a doc host forked as the app starts one, sharing a project through it, and
// a teammate's page reaching it as web/relay.js does, in Node: for the relay
// test (test/relay.test.js) and the typing promise (test/perf/typing.test.js).

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeTeam } from '../../src/store/team.js';
import { relayHost } from '../../web/relay.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The relay, started, serving the teammate's page from dist/web (`npm run
 * build` first): { url, its ws: URL; origin, its http: one; stop() }.
 */
export async function startRelay() {
  const wrangler = createRequire(join(root, 'relay', 'package.json')).resolve('wrangler');
  process.env.WRANGLER_LOG ??= 'error'; // not every request
  const { unstable_startWorker } = await import(pathToFileURL(wrangler).href);
  const worker = await unstable_startWorker({ config: join(root, 'relay', 'wrangler.toml'), dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false } });
  const { host } = await worker.url;
  return { url: `ws://${host}`, origin: `http://${host}`, stop: () => worker.dispose() };
}

/** The room of `secret`, as a link names it. */
export const roomOf = (secret) => createHash('sha256').update(secret).digest('hex');

/** A teammate's browser: its key, made once, and their name. */
export const teammate = (name = 'Sam') => ({ key: `k-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, name });

/** The id the host knows the teammate of `key` by (desktop/doc-host.js). */
export const idOf = (key) => `p_${roomOf(key).slice(0, 24)}`;

/**
 * A project folder holding `doc` with `text` (and a hidden
 * .ponjo/secret.md), a config folder for its owner, and its team: a link
 * (`secret`) and `sam`, a teammate who can read.
 */
export async function project(text, doc = 'plan.md') {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  await writeFile(join(folder, doc), text);
  await mkdir(join(folder, '.ponjo'));
  await writeFile(join(folder, '.ponjo', 'secret.md'), 'hidden\n');
  const config = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
  await writeFile(join(config, 'settings.json'), JSON.stringify({ name: 'owner', agents: [] }));
  const secret = `s-${Math.random().toString(36).slice(2)}`;
  const sam = teammate('Sam');
  await writeTeam(folder, { secret, members: [{ id: idOf(sam.key), name: sam.name, level: 'read' }] }, config);
  return { folder, config, secret, sam };
}

/**
 * The owner's doc host, as the app starts it, sharing `folder` through the
 * relay at `relay`: `request(type, arg)` asks it as the app does; `joins`
 * holds who asked to join, as the app hears it.
 */
export async function startHost({ folder, config }, relay) {
  const child = fork(join(root, 'desktop', 'doc-host.js'), [], { env: { ...process.env, PONJO_CONFIG_DIR: config, PONJO_RELAY: relay }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const joins = [];
  const asked = new Map();
  let nextId = 0;
  const ready = new Promise((done) => child.once('message', done));
  child.on('message', ({ id, type, result, error, ...said }) => {
    if (type === 'join') joins.push(said);
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
  await request('share', { folder });
  return { request, joins, kill: () => child.kill() };
}

/**
 * The page of teammate `who` ({ key, name }) on `doc` (none: the project's
 * first): `call` resolves to { result } or { error }, `events` holds what
 * it heard, `lines` how its line was, each change, and `onEvent(fn)` hears
 * each event.
 */
export const page = (relay, secret, who, doc = null) => pageAt(relay, roomOf(secret), who, doc);

/** The same, in room `room`. */
export function pageAt(relay, room, who, doc = null) {
  const host = relayHost(relay, new URLSearchParams({ room, ...(doc ? { doc } : {}) }), () => who);
  const events = [];
  const lines = [];
  const listeners = [];
  host.onEvent((event, data) => {
    events.push({ event, data });
    for (const fn of listeners) fn(event, data);
  });
  host.onLine((line) => lines.push(line?.reason ?? 'in'));
  return { call: host.call, events, lines, onEvent: (fn) => listeners.push(fn) };
}
