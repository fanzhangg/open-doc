// The typing promise (LATENCY.typed in web/views/index.js): a key the owner
// types in a view reaches a teammate's page through the relay, run locally
// (test/relay/harness.js), within its bound while the owner types on. The
// owner's view is the collab harness's (test/collab/page.js) in Electron,
// on a doc host started as the app starts it, with no delay of its own; the
// teammate's page is web/relay.js and web/client.js in Node, so its view's
// own cost, kept by latency.test.js, is left out. A miss is measured once
// more. npm run test:perf.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../../scripts/devtools.js';
import { createClient } from '../../web/client.js';
import { LATENCY } from '../../web/views/index.js';
import { until } from '../helpers.js';
import { page as teammatePage, startRelay } from '../relay/harness.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const TEXT = '# Plan\n\nShip the preview first.\n';
const KEYS = 100;
const KEY_MS = 100; // ten keys a second, a fast typist

let relay;
let app;
let page;

before(async () => {
  relay = await startRelay();
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-typing-'));
  await build({
    entryPoints: [join(root, 'test', 'collab', 'page.js')], outfile: join(dir, 'page.js'),
    bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'error',
  });
  await copyFile(join(root, 'web', 'app.css'), join(dir, 'app.css'));
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>typing</title><link rel="stylesheet" href="app.css">
<div style="display:flex;flex-direction:column;height:100vh"><div class="od-toolbar"><span class="od-spacer"></span></div>
<main class="od-canvas"><div class="od-stage"><article class="od-page"><div class="od-editor"></div></article></div></main></div>
<script src="page.js"></script>`);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, VIEWS_PAGE: join(dir, 'index.html'), VIEWS_SEARCH: '?delay=0', OPENDOC_RELAY: relay.url };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchElectron(electron, [join(root, 'test', 'views', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  page = await app.page('typing');
  await waitFor(() => page.evaluate('Boolean(window.collab)'), 30_000, 'the typing page');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
});

after(async () => {
  await app?.quit();
  await relay?.stop();
});

const run = (expression) => page.evaluate(`(async () => ${expression})()`);
const percentile = (ms, q) => [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(q * ms.length))];

async function measure() {
  await run(`collab.make(${JSON.stringify(TEXT)}, { view: 'markdown' })`);
  const { secret, key } = await run('collabHost.share()');

  // The teammate's page: when each key's character is shown there.
  const teammate = teammatePage(relay.url, secret, { key, name: 'Sam' });
  const typedAt = [];
  const ms = [];
  let text = null;
  const client = createClient({
    view: { getText: () => text, selection: () => null },
    call: async (type, arg) => {
      const { result, error } = await teammate.call(type, arg);
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return result;
    },
    show: (next) => {
      text = next;
      const now = performance.now();
      const keys = (text.match(/x/g) ?? []).length;
      while (ms.length < keys) ms.push(now - typedAt[ms.length]);
    },
    rules: () => [],
  });
  teammate.onEvent((event, data) => event === 'ops' && client.receive(data));
  const state = (await teammate.call('state')).result;
  text = state.text;
  client.start(state);

  await run(`collab.select(0, 'first', 5, 5)`);
  for (let k = 0; k < KEYS; k++) {
    typedAt.push(performance.now());
    await page.send('Input.insertText', { text: 'x' });
    await new Promise((done) => setTimeout(done, KEY_MS));
  }
  await until(() => ms.length === KEYS, 'every key at the teammate');
  return { median: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
}

const misses = (got) => ['median', 'p95'].filter((q) => got[q] > LATENCY.typed[q]).map((q) => `${q} ${Math.round(got[q])} ms`);

test('a key the owner types is shown at a teammate within the typing promise, while they type on', { timeout: 120_000 }, async () => {
  let got = await measure();
  if (misses(got).length > 0) got = await measure();
  console.log(`# typed: ${JSON.stringify(got)}`);
  assert.deepEqual(misses(got), [], `missed LATENCY.typed ${JSON.stringify(LATENCY.typed)}`);
});
