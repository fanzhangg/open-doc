// The latency promise (LATENCY in web/views/index.js), held at each view's
// limits: the longest doc a view opens, in the shape that costs it most. One
// person types in the doc while a teammate's edit arrives every 300 ms, as
// in the collab harness (test/collab/page.js); the doc opens, and keys, the
// teammate's edits and the longest task are timed. A case that misses is
// measured once more, so one slow moment of a shared CI machine does not
// fail it; a regression misses both times. npm run test:perf.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../../scripts/devtools.js';
import { LATENCY } from '../../web/views/index.js';
import { markdown } from '../../web/views/markdown/index.js';
import { plain } from '../../web/views/plain/index.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Docs of an exact length: blocks of every kind, or verses with no blank
// line between them (a Bible: one paragraph), from a seeded list of words.
const BLOCKS = `# Launch plan

We plan to **ship all six features** in week one, then gather
feedback from the [beta cohort](https://example.com/beta) before the public release.

## Risks

* The \`sync\` service may not handle the load.
* Some __old__ notes say _maybe_.

| Item | Owner | Due |
| --- | --- | --- |
| Sync | Ana | Friday |

> A quote, with a [link](https://example.com).

\`\`\`js
const x = 1;
\`\`\`

1. First
2. Second

`;
const blocks = (chars) => BLOCKS.repeat(Math.ceil(chars / BLOCKS.length)).slice(0, chars);
function verses(chars) {
  const words = 'and the of he unto they shall God people land son house that his was with for all said'.split(' ');
  let seed = 1;
  let text = '';
  for (let n = 0; text.length < chars; n++) {
    let verse = `Book ${(n / 30 | 0) + 1}:${n % 30 + 1}\t`;
    for (let k = 0; k < 20; k++) verse += `${words[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % words.length]} `;
    text += `${verse.trim()}.\n`;
  }
  return text.slice(0, chars);
}

const CASES = [
  ['markdown', 'blocks', blocks(markdown.limits.chars)],
  ['markdown', 'one long block', verses(markdown.limits.blockChars)],
  ['plain', 'blocks', blocks(plain.limits.chars)],
  ['plain', 'verses', verses(plain.limits.chars)],
  ['plain', 'one long coloured block', verses(plain.limits.colorBlockChars)],
];

let app;
let page;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-perf-'));
  await build({
    entryPoints: [join(root, 'test', 'collab', 'page.js')], outfile: join(dir, 'page.js'),
    bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'error',
  });
  await copyFile(join(root, 'web', 'app.css'), join(dir, 'app.css'));
  // One page as the app lays it out, with its comment margin.
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>perf</title><link rel="stylesheet" href="app.css">
<div style="display:flex;flex-direction:column;height:100vh"><div class="pj-toolbar"><span class="pj-spacer"></span></div>
<main class="pj-canvas"><div class="pj-stage"><article class="pj-page"><div class="pj-editor"></div></article></div></main></div>
<script src="page.js"></script>`);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, VIEWS_PAGE: join(dir, 'index.html') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchElectron(electron, [join(root, 'test', 'views', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  page = await app.page('perf');
  await waitFor(() => page.evaluate('Boolean(window.collab)'), 30_000, 'the perf page');
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
});

after(() => app?.quit());

const run = (expression) => page.evaluate(`(async () => ${expression})()`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const percentile = (ms, q) => [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.floor(q * ms.length))];

async function measure(view, text) {
  let start = Date.now();
  await run(`collab.make(${JSON.stringify(text)}, { view: '${view}' }).then(() => collab.clients[0].view.getText().length)`);
  const open = Date.now() - start;
  await run(`(() => { window.tasks = []; new PerformanceObserver((list) => tasks.push(...list.getEntries().map((e) => e.duration))).observe({ entryTypes: ['longtask'] }); })()`);
  await run('collab.caretAt(0, 0.001)');
  const keys = [];
  for (let k = 0; k < 40; k++) {
    start = Date.now();
    await page.send('Input.insertText', { text: 'x' });
    keys.push(Date.now() - start);
    if (k % 2) await run(`collab.inject([{ from: collab.host.text.length - 3, to: collab.host.text.length - 3, insert: 'y' }])`);
    await wait(150);
  }
  await run('collab.settle()');
  const teammate = (await run('collab.batches()')).map((b) => b.before + b.applyText);
  return {
    open,
    keystroke: { median: percentile(keys, 0.5), p95: percentile(keys, 0.95) },
    teammate: { median: percentile(teammate, 0.5), p95: percentile(teammate, 0.95) },
    task: Math.max(0, ...(await run('tasks'))),
  };
}

// What `got` misses of LATENCY, in words; empty when it keeps it.
function misses(got) {
  const out = [];
  if (got.open > LATENCY.open) out.push(`open ${got.open} ms`);
  for (const kind of ['keystroke', 'teammate']) {
    for (const q of ['median', 'p95']) if (got[kind][q] > LATENCY[kind][q]) out.push(`${kind} ${q} ${Math.round(got[kind][q])} ms`);
  }
  if (got.task > LATENCY.task) out.push(`a task of ${Math.round(got.task)} ms`);
  return out;
}

for (const [view, shape, text] of CASES) {
  test(`B1 B2 B4 B7: ${view} view, ${shape}, ${text.length.toLocaleString('en')} characters: keeps the latency promise`, { timeout: 600_000 }, async () => {
    let got = await measure(view, text);
    if (misses(got).length > 0) got = await measure(view, text);
    console.log(`# ${view} ${shape}: ${JSON.stringify(got)}`);
    assert.deepEqual(misses(got), [], `LATENCY is ${JSON.stringify(LATENCY)}`);
  });
}
