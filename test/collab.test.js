// The M0 prototype (docs/markdown-view.md, Many writers, The prototype): two
// Markdown views of one doc, joined by an in-memory host 150 ms away, typed
// into over the DevTools protocol as test/views.test.js does. Each test is a
// must-pass case of plan A, or a measurement it logs. Thrown away once the
// plan is decided. COLLAB_SECONDS sets how long the random typing runs (300
// for the five minutes of case 6); COLLAB_MEASURE=1 runs the measurements.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../scripts/devtools.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const MOD = process.platform === 'darwin' ? 4 : 2; // Meta : Ctrl
const SECONDS = Number(process.env.COLLAB_SECONDS ?? 20);
const MEASURE = { skip: !process.env.COLLAB_MEASURE && 'set COLLAB_MEASURE=1 to measure' };

// A doc with most of what Markdown has, some of it written in another style
// than the view's.
const SAMPLE = `# Launch plan

We plan to **ship all six features** in week one, then gather
feedback from the [beta cohort](https://example.com/beta) before the public release.

## Risks

* The \`sync\` service may not handle the load.
* Some __old__ notes say _maybe_.

| Item | Owner | Due |
| --- | --- | --- |
| Sync | Ana | Friday |
| Docs | Ben | Monday |

> A quote, with a [link](https://example.com).

\`\`\`js
const x = 1;
\`\`\`

1. First
2. Second
`;

let app;
let page;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-collab-'));
  await build({
    entryPoints: [join(root, 'test', 'collab', 'page.js')], outfile: join(dir, 'page.js'),
    bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'error',
  });
  await copyFile(join(root, 'web', 'app.css'), join(dir, 'app.css'));
  // Two pages side by side, each without the comment margin, as with comments hidden.
  const column = '<div style="flex:1;min-width:0;--margin-w:0px;--stage-gap:0px"><div class="od-toolbar"><span class="od-spacer"></span></div><main class="od-canvas"><div class="od-stage"><article class="od-page"><div class="od-editor"></div></article></div></main></div>';
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>collab</title><link rel="stylesheet" href="app.css">
<div style="display:flex;height:100vh">${column}${column}</div>
<script src="page.js"></script>`);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, VIEWS_PAGE: join(dir, 'index.html') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchElectron(electron, [join(root, 'test', 'views', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  page = await app.page('collab');
  await waitFor(() => page.evaluate('Boolean(window.collab)'), 30_000, 'the collab page');
});

after(() => app?.quit());

const run = (expression) => page.evaluate(`(async () => ${expression})()`);
const VIEW = process.env.COLLAB_VIEW ?? 'markdown'; // the random typing (case 6) can run in the plain view too
const make = (text, view = 'markdown') => run(`collab.make(${JSON.stringify(text)}, { view: '${view}' })`);
const select = (i, quote, start, end) => run(`collab.select(${i}, ${JSON.stringify(quote)}, ${start}, ${end})`);
const focus = (i) => run(`collab.focus(${i})`);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function key(key, { modifiers = 0, text } = {}) {
  const codes = { Backspace: 8, Enter: 13, z: 90, b: 66 };
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: codes[key], modifiers, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: codes[key], modifiers });
}
const type = (text) => page.send('Input.insertText', { text });

// Both views equal the host, with no error: what every case ends in.
async function settled() {
  const state = await run('collab.settle()');
  assert.deepEqual(state.errors, []);
  assert.equal(state.texts[0], state.host, 'view a equals the host');
  assert.equal(state.texts[1], state.host, 'view b equals the host');
  return state.host;
}

// Type `a` in view 0 and `b` in view 1 a character at a time, taking turns,
// with pauses long enough for each one's typing to reach the other mid-word.
async function typeBoth(a, b, pause = 120) {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    if (k < a.length) {
      await focus(0);
      await type(a[k]);
    }
    if (k < b.length) {
      await focus(1);
      await type(b[k]);
    }
    await wait(pause);
  }
}

test('1. both type in different paragraphs: both texts whole, neither caret moves', async () => {
  await make('Alpha one.\n\nBeta two.\n\nGamma three.\n');
  await select(0, 'Alpha one.', 9);
  await select(1, 'Gamma three.', 11);
  await typeBoth(' typed by a', ' typed by b');
  assert.equal(await settled(), 'Alpha one typed by a.\n\nBeta two.\n\nGamma three typed by b.\n');
});

test('2. both type in one paragraph, apart: both texts whole, neither caret moves', async () => {
  await make('The quick brown fox jumps over the lazy dog.\n');
  await select(0, 'quick', 5);
  await select(1, 'lazy', 4);
  await typeBoth(' and nimble', ' and sleepy');
  assert.equal(await settled(), 'The quick and nimble brown fox jumps over the lazy and sleepy dog.\n');
});

test('3. both type at one place: both kept, in one order in both views and the host', async () => {
  await make('The quick brown fox.\n');
  await select(0, 'brown', 5);
  await select(1, 'brown', 5);
  await typeBoth(' AAAA', ' BBBB');
  const text = await settled();
  const middle = text.slice('The quick brown'.length, -' fox.\n'.length);
  assert.equal([...middle].sort().join(''), '  AAAABBBB', `both typed, nothing lost: ${JSON.stringify(text)}`);
  console.log(`# case 3: merged as ${JSON.stringify(middle)}`);
});

test('4. one deletes a sentence the other types in: the typed text stays', async () => {
  await make('First sentence. The second sentence goes here. Third.\n');
  await select(1, 'second', 3);
  await focus(1);
  await type('X');
  await select(0, 'The second', 0, 'The second sentence goes here. '.length);
  await key('Backspace');
  await typeBoth('', 'YZ'); // b types on, inside what a deleted
  const text = await settled();
  assert.equal(text, 'First sentence. XYZThird.\n', 'the typed text stays where the sentence was');
  console.log(`# case 4: ${JSON.stringify(text)}`);
});

test('5. Cmd+Z after the other typed in the same paragraph: only one\'s own typing is undone', async () => {
  await make('One paragraph to share.\n\nAnother.\n');
  await select(0, 'One', 3);
  await focus(0);
  await type(' mine');
  await wait(600); // a pause: its own step in the history
  await select(1, 'share', 5);
  await type(' theirs');
  assert.equal(await settled(), 'One mine paragraph to share theirs.\n\nAnother.\n');
  await focus(0);
  await key('z', { modifiers: MOD });
  assert.equal(await settled(), 'One paragraph to share theirs.\n\nAnother.\n');
});

test('6. random typing in both: both views equal the host; no error', { timeout: SECONDS * 1000 + 120_000 }, async () => {
  await make(Array(4).fill(SAMPLE).join('\n'), VIEW);
  let seed = 11;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const end = Date.now() + SECONDS * 1000;
  let actions = 0;
  while (Date.now() < end) {
    const i = random(2);
    await run(`collab.caretAt(${i}, ${random(1000) / 1000})`);
    for (let k = random(6); k >= 0; k--) {
      const pick = random(11);
      if (pick < 6) await type('abc de*[]|_'.slice(random(11)).slice(0, 1 + random(3)));
      else if (pick < 8) await key('Backspace');
      else if (pick < 9) await key('Enter', { text: '\r' });
      else if (pick < 10) await key('z', { modifiers: MOD });
      else if (VIEW === 'markdown') await run(`collab.tool(${i}, '${['bold', 'italic', 'bullets', 'quote'][random(4)]}')`);
      actions++;
    }
    await wait(random(300));
    if (random(20) === 0) {
      const state = await run('collab.state()');
      assert.deepEqual(state.errors, []);
    }
  }
  const text = await settled();
  const { drifts } = await run('collab.state()');
  console.log(`# case 6: ${actions} actions in ${SECONDS} s, ${text.length} characters; ${drifts.length} times a view rewrote the text it was given, first: ${JSON.stringify(drifts.slice(0, 3))}`);
});

// Both type in each block of `blocks` at once, the first edit there for
// both: b at the start of the block's `quote`, a `at` characters into it.
async function bothTouch(blocks, touches) {
  await make(blocks.join('\n\n') + '\n');
  for (const [quote, at] of touches) {
    await select(0, quote, at);
    await select(1, quote, 0);
    await typeBoth('A', 'B');
  }
  const merged = await settled();
  console.log(`# case 7: ${JSON.stringify(blocks.join('\n\n'))} became ${JSON.stringify(merged)}`);
  return merged;
}

test('7. both edit blocks written in another style: no text doubled; only edited blocks change', async () => {
  const merged = await bothTouch(
    ['Some __bold__ and _slanted_ words here.', '* one\n* two', 'A hard\nwrapped line.', '1) first\n2) second', 'Untouched __x__ text.', '+ kept\n+ list'],
    [['words', 5], ['two', 3], ['wrapped', 7], ['second', 6]],
  );
  assert.equal(merged, 'Some __bold__ and _slanted_ BwordsA here.\n\n* one\n* BtwoA\n\nA hard\nBwrappedA line.\n\n1) first\n2) BsecondA\n\nUntouched __x__ text.\n\n+ kept\n+ list\n', 'each block typed into keeps its style');
});

test('7b. both edit a setext heading or a table: no text doubled', async () => {
  const merged = await bothTouch(['Title\n=====', 'Between.', '|a|b|\n|-|-|\n|cell|d|'], [['Title', 5], ['cell', 4]]);
  assert.equal(merged, 'BTitleA\n=====\n\nBetween.\n\n|a|b|\n|-|-|\n|BcellA|d|\n');
});

// Measured, with no bar (docs/markdown-view.md, The prototype).

test('measure: how often merges break bold, links or tables', MEASURE, async () => {
  const count = () => run(`['strong', 'a', 'table', 'tr', 'td', 'th'].map((s) => document.querySelector('.ProseMirror').querySelectorAll(s).length).join()`);
  let seed = 5;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const typed = () => Array.from({ length: 1 + random(3) }, () => 'ab *|[]_'[random(8)]).join('');
  const results = {};
  for (const [name, quote] of [['bold', 'ship all six features'], ['link', 'beta cohort'], ['table', 'Friday']]) {
    for (const touched of [false, true]) {
      let broken = 0;
      const trials = 10;
      for (let t = 0; t < trials; t++) {
        await make(SAMPLE);
        if (touched) { // the block already in the view's style
          await select(0, quote, 0);
          await type('x');
          await settled();
        }
        const before = await count();
        await select(0, quote, random(quote.length + 1));
        await select(1, quote, random(quote.length + 1));
        await typeBoth(typed(), typed(), 60);
        await settled();
        if ((await count()) !== before) broken++;
      }
      results[`${name}${touched ? ', touched before' : ''}`] = `${broken}/${trials}`;
    }
  }
  // One makes a word bold while the other types inside it.
  let broken = 0;
  for (let t = 0; t < 10; t++) {
    await make(SAMPLE);
    const before = (await count()).split(',').map(Number);
    await select(1, 'gather', 1 + random(5));
    await type('Q');
    await select(0, 'gather', 0, 6);
    await run(`collab.tool(0, 'bold')`);
    const text = await settled();
    const after = (await count()).split(',').map(Number);
    if (after[0] !== before[0] + 1 || !/\*\*g[a-z]*Q[a-z]*\*\*/.test(text)) broken++;
  }
  results['bold made while typed in'] = `${broken}/10`;
  // One makes a word a link while the other types inside it.
  broken = 0;
  for (let t = 0; t < 10; t++) {
    await make(SAMPLE);
    const before = (await count()).split(',').map(Number);
    await select(1, 'gather', 1 + random(5));
    await type('Q');
    await select(0, 'gather', 0, 6);
    await run(`collab.tool(0, 'link')`);
    await type('https://example.org');
    await key('Enter', { text: '\r' });
    const text = await settled();
    const after = (await count()).split(',').map(Number);
    if (after[1] !== before[1] + 1 || !/\[g[a-z]*Q[a-z]*\]\(https:\/\/example\.org\)/.test(text)) broken++;
  }
  results['link made while typed in'] = `${broken}/10`;
  console.log(`# measure: merges that changed the bold, links or tables: ${JSON.stringify(results)}`);
});

test('measure: the caret when another changes the kind of its block', MEASURE, async () => {
  // a's caret is after "beta"; the change comes from b's toolbar, or from a third writer's text.
  const moves = {};
  for (const [kind, change, text = 'Alpha beta gamma.\n\nOther.\n'] of [
    ['b: bulleted list', 'bullets'], ['b: numbered list', 'numbers'], ['b: quote', 'quote'],
    ['text: "- "', [{ from: 0, to: 0, insert: '- ' }]], ['text: "# "', [{ from: 0, to: 0, insert: '# ' }]],
    ['text: list item to paragraph', [{ from: 0, to: 2, insert: '' }], '- Alpha beta gamma.\n\nOther.\n'],
  ]) {
    await make(text);
    await select(0, 'beta', 4);
    if (typeof change === 'string') {
      await select(1, 'gamma', 2);
      await run(`collab.tool(1, '${change}')`);
      await focus(0);
    } else await run(`collab.inject(${JSON.stringify(change)})`);
    const host = await settled();
    const now = await run('collab.selection(0)');
    moves[kind] = now ? `${now.from - (host.indexOf('beta') + 4)}: ${JSON.stringify(host.slice(0, now.from))}|` : 'not in the text';
  }
  console.log(`# measure: how far a's caret moved (characters), and the text before it: ${JSON.stringify(moves)}`);
});

test('measure: getText per batch from the host on a 200 KB doc', { ...MEASURE, timeout: 600_000 }, async () => {
  for (const size of [20_000, 50_000, 200_000]) {
    const doc = Array(Math.ceil(size / SAMPLE.length)).fill(SAMPLE).join('\n');
    await make(doc);
    await select(0, 'week one', 4);
    await select(1, 'Second', 6);
    for (let k = 0; k < 20; k++) {
      await focus(k % 2);
      await type('x');
      await wait(150);
    }
    await settled();
    const batches = await run('collab.batches()');
    const stats = (key) => {
      const ms = batches.map((b) => b[key]).sort((a, b) => a - b);
      const at = (q) => Math.round(ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]);
      return `median ${at(0.5)}, max ${at(1)}`;
    };
    console.log(`# measure: ${doc.length} characters, ${batches.length} batches, ms: getText before ${stats('before')}; applyText ${stats('applyText')}; getText after ${stats('after')}`);
  }
});
