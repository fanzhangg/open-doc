// The relay run locally by wrangler (relay/; `npm ci --prefix relay` first),
// a doc host forked as the app starts one, sharing a project through it, and
// a teammate's page reaching it as web/relay.js does, in Node: for the relay
// test (test/relay.test.js) and the typing promise (test/perf/typing.test.js).

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relayHost } from '../../web/relay.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The relay, started: { url, room(secret), stop() }. */
export async function startRelay() {
  const wrangler = createRequire(join(root, 'relay', 'package.json')).resolve('wrangler');
  process.env.WRANGLER_LOG ??= 'error'; // not every request
  const { unstable_startWorker } = await import(pathToFileURL(wrangler).href);
  const worker = await unstable_startWorker({ config: join(root, 'relay', 'wrangler.toml'), dev: { server: { hostname: '127.0.0.1', port: 0 }, inspector: false, watch: false } });
  return { url: `ws://${(await worker.url).host}`, stop: () => worker.dispose() };
}

/** The room of `secret`, as a link names it. */
export const roomOf = (secret) => createHash('sha256').update(secret).digest('hex');

/**
 * A project folder holding `doc` with `text` (and a hidden
 * .opendoc/secret.md), a config folder for its owner, and a secret to share
 * it with.
 */
export async function project(text, doc = 'plan.md') {
  const folder = await mkdtemp(join(tmpdir(), 'opendoc-project-'));
  await writeFile(join(folder, doc), text);
  await mkdir(join(folder, '.opendoc'));
  await writeFile(join(folder, '.opendoc', 'secret.md'), 'hidden\n');
  const config = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  await writeFile(join(config, 'settings.json'), JSON.stringify({ name: 'owner', agents: [] }));
  return { folder, config, secret: `s-${Math.random().toString(36).slice(2)}` };
}

/**
 * A doc host, as the app starts it, sharing `folder` through the relay at
 * `relay`: `request(type, arg)` asks it as the app does; `owner(doc)` is the
 * owner's line to `doc` in the project, as a window's `call(type, arg)` and
 * the `ops` events it hears.
 */
export async function startHost({ folder, config, secret }, relay) {
  const child = fork(join(root, 'desktop', 'doc-host.js'), [], { env: { ...process.env, OPENDOC_CONFIG_DIR: config }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
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
  await request('share', { folder, relay, secret });
  return { request, kill: () => child.kill() };
}

/**
 * A teammate's page on `doc`: `call` resolves to { result } or { error },
 * `events` holds what it heard, `lines` how its line was, each change, and
 * `onEvent(fn)` hears each event.
 */
export function page(relay, secret, doc = 'plan.md') {
  const host = relayHost(new URLSearchParams({ relay, room: roomOf(secret), doc }));
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
