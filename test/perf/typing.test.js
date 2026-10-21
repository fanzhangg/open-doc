// The typing promise (LATENCY.typed in web/views/index.js): a key the owner
// types in a view is shown on a teammate's page, through the relay run
// locally (test/relay/harness.js), within its bound while the owner types
// on, the network aside. The owner's view is the collab harness's
// (test/collab/page.js) in Electron, on a doc host started as the app starts
// it, with no delay of its own; the teammate's page is the browser build
// (dist/preview/team.html) in another Electron, whose line to the relay is
// LINE_MS slower each way, as over the internet: its client, applyText and
// marks are timed with the rest, up to the character in its page. Both in
// a small Markdown doc and in the plain view's longest, which the host
// writes whole on every key. A miss is measured once more. npm run
// test:perf.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { launchElectron, waitFor } from '../../scripts/devtools.js';
import { LATENCY } from '../../web/views/index.js';
import { plain } from '../../web/views/plain/index.js';
import { startRelay } from '../relay/harness.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const TEXT = '# Plan\n\nShip the preview first.\n';
// The doc the host costs most on: the plain view's longest, written whole on every key.
const LONGEST = (TEXT + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.\n'.repeat(plain.limits.chars / 80)).slice(0, plain.limits.chars);
const KEYS = 100;
const KEY_MS = 100; // ten keys a second, a fast typist
const LINE_MS = 40; // each way between the teammate and the relay

const electron = createRequire(import.meta.url)('electron');
const now = () => performance.timeOrigin + performance.now(); // the same clock in every process
let relay;
let dir;
let app;
let page;
const teammates = [];

before(async () => {
  relay = await startRelay();
  for (const script of [join(root, 'scripts', 'build.js'), join(root, 'preview', 'build.js')]) await promisify(execFile)(process.execPath, [script]);
  dir = await mkdtemp(join(tmpdir(), 'opendoc-typing-'));
  await build({
    entryPoints: [join(root, 'test', 'collab', 'page.js')], outfile: join(dir, 'page.js'),
    bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'error',
  });
  await copyFile(join(root, 'web', 'app.css'), join(dir, 'app.css'));
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>typing</title><link rel="stylesheet" href="app.css">
<div style="display:flex;flex-direction:column;height:100vh"><div class="od-toolbar"><span class="od-spacer"></span></div>
<main class="od-canvas"><div class="od-stage"><article class="od-page"><div class="od-editor"></div></article></div></main></div>
<script src="page.js"></script>`);
  const env = { ...process.env, VIEWS_PAGE: join(dir, 'index.html'), VIEWS_SEARCH: '?delay=0', OPENDOC_RELAY: relay.url };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchElectron(electron, [join(root, 'test', 'views', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  page = await app.page('typing');
  await waitFor(() => page.evaluate('Boolean(window.collab)'), 30_000, 'the typing page');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
});

after(async () => {
  for (const teammate of teammates) await teammate.quit();
  await app?.quit();
  await relay?.stop();
});

const run = (expression) => page.evaluate(`(async () => ${expression})()`);
const percentile = (ms, q) => [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(q * ms.length))];

// The page's WebSocket, `ms` slower each way.
const slowLine = (ms) => `{
  const Line = WebSocket;
  window.WebSocket = class extends Line {
    send(data) { setTimeout(() => this.readyState === 1 && super.send(data), ${ms}); }
    addEventListener(type, fn, ...rest) {
      super.addEventListener(type, type === 'message' ? (event) => setTimeout(() => fn(event), ${ms}) : fn, ...rest);
    }
  };
}`;

// The teammate Sam's page, in a browser of its own, on the doc `make` opened.
async function teammatePage({ room, key }) {
  const url = new URL(`file://${join(root, 'dist', 'preview', 'team.html')}`);
  url.search = new URLSearchParams({ relay: relay.url, room }).toString();
  const env = { ...process.env, RELAY_PAGE: url.href };
  delete env.ELECTRON_RUN_AS_NODE;
  const browser = await launchElectron(electron, [join(root, 'test', 'relay', 'main.js'), '--no-sandbox', `--user-data-dir=${await mkdtemp(join(dir, 'teammate-'))}`], { env });
  teammates.push(browser);
  const shown = await browser.page('opendoc');
  // Sam, on this browser, as the page keeps them; then the page again, on a slow line.
  await shown.send('Page.enable'); // for the script below
  await shown.send('Page.addScriptToEvaluateOnNewDocument', { source: slowLine(LINE_MS) });
  await shown.evaluate(`localStorage.setItem('opendoc.key', ${JSON.stringify(key)}); localStorage.setItem('opendoc.name', 'Sam'); location.reload()`);
  await waitFor(async () => (await shown.evaluate(`document.querySelector('.od-stage [contenteditable]')?.innerText ?? ''`).catch(() => '')).includes('Ship the preview'), 30_000, 'the teammate\'s page');
  // When each x is shown there.
  await shown.evaluate(`{
    window.shownAt = [];
    const editor = document.querySelector('.od-stage [contenteditable]');
    new MutationObserver(() => {
      const keys = (editor.textContent.match(/x/g) ?? []).length;
      const at = performance.timeOrigin + performance.now();
      while (shownAt.length < keys) shownAt.push(at);
    }).observe(editor, { subtree: true, childList: true, characterData: true });
  }`);
  return shown;
}

async function measure(view, text) {
  await run(`collab.make(${JSON.stringify(text)}, { view: '${view}' })`);
  const shown = await teammatePage(await run('collabHost.share()'));
  await run(`collab.select(0, 'first', 5, 5)`);
  const typedAt = [];
  for (let k = 0; k < KEYS; k++) {
    typedAt.push(now());
    await page.send('Input.insertText', { text: 'x' });
    await new Promise((done) => setTimeout(done, KEY_MS));
  }
  await waitFor(async () => (await shown.evaluate('shownAt.length')) === KEYS, 30_000, 'every key at the teammate');
  const ms = (await shown.evaluate('shownAt')).map((at, k) => at - typedAt[k] - LINE_MS);
  await teammates.pop().quit();
  return { median: percentile(ms, 0.5), p95: percentile(ms, 0.95) };
}

const misses = (got) => ['median', 'p95'].filter((q) => got[q] > LATENCY.typed[q]).map((q) => `${q} ${Math.round(got[q])} ms`);

for (const [view, text] of [['markdown', TEXT], ['plain', LONGEST]]) {
  test(`a key the owner types is shown on a teammate's page within the typing promise, while they type on: ${view} view, ${text.length.toLocaleString('en')} characters`, { timeout: 300_000 }, async () => {
    let got = await measure(view, text);
    if (misses(got).length > 0) got = await measure(view, text);
    console.log(`# typed, ${view} (the line's ${LINE_MS} ms aside): ${JSON.stringify(got)}`);
    assert.deepEqual(misses(got), [], `missed LATENCY.typed ${JSON.stringify(LATENCY.typed)}`);
  });
}
