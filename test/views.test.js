// The view contract (web/views/): what every view of a doc must do,
// checked on each view in Electron, driven over the DevTools protocol.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from '../scripts/devtools.js';

const VIEWS = ['markdown', 'plain'];
const root = fileURLToPath(new URL('..', import.meta.url));
const MOD = process.platform === 'darwin' ? 4 : 2; // Meta : Ctrl

let app;
let page;

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ponjo-views-'));
  await build({
    entryPoints: [join(root, 'test', 'views', 'page.js')], outfile: join(dir, 'page.js'),
    bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'error',
  });
  await copyFile(join(root, 'web', 'app.css'), join(dir, 'app.css'));
  await writeFile(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>views</title><link rel="stylesheet" href="app.css">
<main class="pj-canvas"><div class="pj-stage"><article class="pj-page"><div class="pj-editor"></div></article></div></main>
<script src="page.js"></script>`);
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env, VIEWS_PAGE: join(dir, 'index.html') };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await launchElectron(electron, [join(root, 'test', 'views', 'main.js'), '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`], { env });
  page = await app.page('views');
  await waitFor(() => page.evaluate('Boolean(window.contract)'), 30_000, 'the contract page');
});

after(() => app?.quit());

const run = (expression) => page.evaluate(`(async () => ${expression})()`);
const make = (name, text, options = {}) => run(`contract.make(${JSON.stringify(name)}, ${JSON.stringify(text)}, ${JSON.stringify(options)})`);
const select = (quote, start, end) => run(`contract.select(${JSON.stringify(quote)}, ${start}, ${end})`);
const getText = () => run('view.getText()');
const type = (text) => page.send('Input.insertText', { text });
async function undo() {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, modifiers: MOD, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
}

for (const name of VIEWS) {
  test(`${name} view: getText gives back the text it was made with`, async () => {
    const plan = await readFile(join(root, 'test', 'fixtures', 'plan.md'), 'utf8');
    for (const text of [plan, 'Some __bold__ and _slanted_ text\n\n* one\n* two\n', '']) {
      await make(name, text);
      assert.equal(await getText(), text);
    }
    assert.equal(await run(`document.querySelectorAll('[contenteditable]').length`), 1, 'destroy takes a view away');
  });

  test(`D5: ${name} view: after applyText(t), getText() is t, as someone types Markdown a key at a time; nothing is sent as the person's edit`, async () => {
    const steps = (from, typed) => [...typed].map((_, k) => from + typed.slice(0, k + 1));
    for (const [start, typed] of [
      ['Intro.\n\n| a | b |\n| --- | --- |\n', '| 1 | 2 |\n'], // a table row
      ['Intro.\n\n', '```js\nconst x = 1;\n'], // a fence not closed yet
      ['Intro.\n\n', '- one\n- \n-'], // a list marker on its own
      ['Intro.\n\n', '# Title\n\n> a quote\n'],
    ]) {
      await make(name, start);
      let text = start;
      for (text of steps(start, typed)) {
        await run(`view.applyText(${JSON.stringify(text)}, { by: 'Someone' })`);
        await new Promise((done) => setTimeout(done, 10)); // what the editor does after it
        assert.equal(await getText(), text);
      }
      assert.deepEqual(await run('contract.edits'), [], 'nothing sent as the person\'s edit');
      // The person types elsewhere: that alone is their edit.
      await select('Intro.', 0, 0);
      await type('X');
      assert.deepEqual(await run('contract.edits'), [`X${text}`]);
    }
  });

  test(`D1: ${name} view: others' edits never move the caret off the character it is next to`, async () => {
    for (const by of [null, 'Clippy', 'Edited on disk']) { // a teammate's typing, a buddy's edit, another program's
      await make(name, 'A wonderful day.\n');
      await select('wonderful', 6, 6); // wonder|ful
      const at = 'A wonderful'.length;
      await run(`view.applyText('A wonderfully good day.\\n', { by: ${JSON.stringify(by)}, ops: [{ from: ${at}, to: ${at}, insert: 'ly good' }] })`);
      await type('X');
      assert.equal(await getText(), 'A wonderXfully good day.\n', by ?? 'a teammate');
    }
  });

  test(`D3: ${name} view: Cmd+Z undoes only my typing, after others split or restyle the paragraph I typed in`, async () => {
    for (const [theirs, after] of [
      ['# Beta. X\n', '# Beta.\n'], // a heading
      ['- Beta. X\n', '- Beta.\n'], // a list
      ['> Beta. X\n', '> Beta.\n'], // a quote
      ['Be\n\nta. X\n', 'Be\n\nta.\n'], // split in two
    ]) {
      await make(name, 'Alpha.\n\nBeta.\n');
      await select('Beta.', 5, 5);
      await type(' X');
      await run(`view.applyText(${JSON.stringify(`Alpha.\n\n${theirs}`)}, { by: 'Someone' })`);
      await undo();
      assert.equal(await getText(), `Alpha.\n\n${after}`, theirs);
    }
  });

  test(`D6: ${name} view: a buddy's change is flagged with its name before the word it changed, and its revision drawn whole`, async () => {
    await make(name, 'Say Hello to all.\n');
    const at = 'Say H'.length;
    await run(`view.applyText('Say Howdy to all.\\n', { by: 'Clippy', buddy: true, ops: [{ from: ${at}, to: ${at + 4}, insert: 'owdy' }] })`);
    await run(`view.setMarks([{ kind: 'edit', from: 4, to: 9, removed: 'Hello', by: 'Clippy', replay: 1 }])`);
    assert.equal(await run(`document.querySelector('.pj-buddy-edit').textContent`), 'Howdy');
  });

  test(`D2: ${name} view: when others add lines above, the line on top of the page keeps its place`, async () => {
    const lines = Array.from({ length: 300 }, (_, k) => `Line ${k}.\n\n`).join('');
    await run(`document.querySelector('.pj-canvas').style.height = '100vh'`); // the window's own scroller, as in the app
    await make(name, lines);
    const top = () => run(`(() => {
      const canvas = document.querySelector('.pj-canvas');
      const top = canvas.getBoundingClientRect().top;
      return [...canvas.querySelectorAll('.ProseMirror p, .cm-line')].find((line) => line.textContent && line.getBoundingClientRect().bottom > top)?.textContent ?? null;
    })()`);
    await run(`(() => {
      const canvas = document.querySelector('.pj-canvas');
      canvas.scrollTop = canvas.scrollHeight / 2;
    })()`);
    const seen = await waitFor(top, 5000, 'the lines in view drawn');
    const added = Array.from({ length: 40 }, (_, k) => `Added ${k}.\n\n`).join('');
    await run(`view.applyText(${JSON.stringify(added + lines)}, { by: 'Someone', ops: [{ from: 0, to: 0, insert: ${JSON.stringify(added)} }] })`);
    assert.match(seen, /^Line \d+\.$/);
    assert.equal(await waitFor(top, 5000, 'the lines in view drawn again'), seen);
    await run(`document.querySelector('.pj-canvas').style.height = ''`);
  });

  test(`D4: ${name} view: nothing is sent mid-composition; others' edits arriving meanwhile lose or double nothing`, async () => {
    await make(name, 'Say hi.\n\nAnd more.\n');
    await select('hi', 2, 2);
    for (const typed of ['n', 'ni', 'nih', 'nihao']) await page.send('Input.imeSetComposition', { text: typed, selectionStart: typed.length, selectionEnd: typed.length });
    assert.deepEqual(await run('contract.edits'), [], 'pinyin is not the person\'s edit');
    assert.equal(await run('view.composing()'), true);
    // Another's edit lands while the person composes, in another paragraph.
    const text = await getText();
    await run(`view.applyText(${JSON.stringify(text.replace('more', 'much more'))}, { by: 'Someone', ops: [{ from: ${text.indexOf('more')}, to: ${text.indexOf('more')}, insert: 'much ' }] })`);
    await page.send('Input.insertText', { text: '你好' });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(await getText(), 'Say hi你好.\n\nAnd much more.\n');
    assert.deepEqual(await run('contract.edits'), ['Say hi你好.\n\nAnd much more.\n'], 'only what was composed is the edit');
  });

  test(`${name} view: applyText is outside the undo history and keeps the caret`, async () => {
    await make(name, 'Alpha.\n\nBeta.\n');
    await select('Beta.', 5, 5);
    await type(' X');
    assert.equal(await getText(), 'Alpha.\n\nBeta. X\n');
    await run(`view.applyText('Alpha one.\\n\\nBeta. X\\n', { by: 'Someone' })`);
    await type(' Y');
    assert.equal(await getText(), 'Alpha one.\n\nBeta. X Y\n');
    for (let i = 0; i < 3; i++) await undo();
    assert.equal(await getText(), 'Alpha one.\n\nBeta.\n');
  });

  test(`${name} view: setMarks draws comments and a revision over their text`, async () => {
    const text = 'Some **bold** words here.\n\nA new line.\n';
    const at = (quote, from) => text.indexOf(quote, from);
    // What is drawn over the text, whether or not the view shows its markup.
    const drawn = async (selector) => (await run(`contract.drawn(${JSON.stringify(selector)})`)).replaceAll('**', '');
    await make(name, text);
    await run(`view.setMarks(${JSON.stringify([
      { kind: 'comment', id: 't1', from: at('bold'), to: at(' here'), active: false },
      { kind: 'comment', id: 't2', from: at('A new'), to: at(' new'), active: true },
      { kind: 'edit', from: at('line'), to: at('.\n', at('line')), removed: 'old **row**', by: null, replay: 0 },
    ])})`);
    assert.equal(await drawn('[data-thread="t1"]'), 'bold words');
    assert.equal(await drawn('[data-thread="t2"].pj-hl-active'), 'A');
    assert.equal(await drawn('.pj-mark-ins'), 'line');
    assert.equal(await drawn('del'), 'old row');
    await run(`document.querySelector('[data-thread="t1"]').click()`);
    assert.deepEqual(await run('contract.clicked'), ['t1']);
    await run('view.setMarks([])');
    assert.equal(await drawn('[data-thread], .pj-mark-ins, del'), '');
  });

  test(`${name} view: setMarks draws a buddy's cursor after the text it stands at; its name shows while it works`, async () => {
    const text = 'Some **bold** words here.\n';
    await make(name, text);
    const mark = (working) => JSON.stringify([{ kind: 'cursor', at: text.indexOf(' here'), by: 'Clippy', working }]);
    const before = () => run(`(() => {
      const cursor = document.querySelector('.pj-cursor');
      const range = document.createRange();
      range.setStart(cursor.parentElement.closest('[contenteditable]'), 0);
      range.setEndBefore(cursor);
      return range.toString().replaceAll('**', '');
    })()`);
    await run(`view.setMarks(${mark(false)})`);
    assert.equal(await before(), 'Some bold words');
    assert.equal(await run(`getComputedStyle(document.querySelector('.pj-cursor-name')).display`), 'none');
    await run(`view.setMarks(${mark(true)})`);
    assert.equal(await run(`getComputedStyle(document.querySelector('.pj-cursor-name')).display`), 'block');
    await run('view.setMarks([])');
    assert.equal(await run(`document.querySelectorAll('.pj-cursor').length`), 0);
  });

  test(`${name} view: selection is in offsets on the text`, async () => {
    const text = 'Some **bold** words.\n';
    await make(name, text);
    await select('bold');
    assert.deepEqual(await run('view.selection()'), { from: text.indexOf('bold'), to: text.indexOf('bold') + 4 });
    await select('words', 2, 2);
    assert.deepEqual(await run('view.selection()'), { from: text.indexOf('words') + 2, to: text.indexOf('words') + 2 });
  });

  test(`${name} view: tops places offsets outside the viewport, and scrollTo brings one in`, async () => {
    const text = Array.from({ length: 300 }, (_, i) => `Paragraph ${i}.`).join('\n\n') + '\n';
    const last = text.indexOf('Paragraph 299');
    await make(name, text);
    const [first, end] = await run(`view.tops([0, ${last}])`);
    const height = await run('innerHeight');
    assert.ok(first < height && end > height, `tops ${first}, ${end} in a viewport ${height} high`);
    await run(`view.scrollTo(${last})`);
    await waitFor(async () => {
      const [top] = await run(`view.tops([${last}])`);
      return top >= 0 && top < height;
    }, 5_000, 'the offset to scroll into view');
  });

  test(`${name} view: onEdit fires on each change the person makes, with getText holding it; onChange once they pause`, async () => {
    await make(name, 'Alpha.\n');
    await select('Alpha', 5, 5);
    for (const key of 'xyz') await type(key);
    assert.deepEqual(await run('contract.edits'), ['Alphax.\n', 'Alphaxy.\n', 'Alphaxyz.\n']);
    assert.equal(await run('contract.changes'), 0);
    await waitFor(() => run('contract.changes === 1'), 2_000, 'onChange after the pause');
    await run(`view.applyText('Beta.\\n')`);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal((await run('contract.edits')).length, 3, 'not for a change applied from outside');
  });

  test(`${name} view: a read-only view cannot be edited`, async () => {
    await make(name, 'Alpha.\n', { editable: false });
    await select('Alpha', 2, 2);
    await type('Z');
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(await getText(), 'Alpha.\n');
  });

  test(`${name} view: Mod+F finds what a reader sees and steps through it; Replace all is the person's own edit, undone by Cmd+Z`, async () => {
    const text = 'One **cat** and a Cat.\n\nThe cat sat.\n';
    await make(name, text);
    await select('One', 0, 0);
    await shortcut('f');
    assert.equal(await run(`!document.querySelector('.pj-find').hidden && document.activeElement.matches('.pj-find-input')`), true);
    await type('cat');
    const count = () => run(`document.querySelector('.pj-find-count').textContent`);
    assert.equal(await count(), '3 found');
    assert.equal(await run(`document.querySelectorAll('.pj-found').length`), 3);
    await press('Enter');
    assert.equal(await count(), '1 of 3');
    await press('Enter', { modifiers: 8 }); // Shift: the one before, round to the last
    assert.equal(await count(), '3 of 3');
    assert.equal(await run(`document.querySelectorAll('.pj-found-current').length`), 1);
    // What a reader sees: no markup.
    await run(`(() => { const input = document.querySelector('.pj-find-input'); input.value = '**'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await count(), name === 'markdown' ? 'No results' : '2 found');
    await press('Escape');
    assert.equal(await run(`document.querySelector('.pj-find').hidden && document.querySelectorAll('.pj-found').length === 0`), true);
    assert.equal(await run(`Boolean(document.activeElement.closest('.pj-editor'))`), true, 'the text has the focus back');

    await select('The cat', 4, 7);
    await run('contract.edits = []');
    await shortcut('f', MOD | 1); // Alt: with Replace
    assert.equal(await run(`document.querySelector('.pj-find-input').value`), 'cat', 'the selection is what to find');
    await type('dog'); // the Replace field has the focus
    await run(`document.querySelector('.pj-find [data-action="all"]').click()`);
    const replaced = name === 'markdown' ? 'One **dog** and a dog.\n\nThe dog sat.\n' : text.replace(/cat/gi, 'dog');
    assert.equal(await getText(), replaced);
    assert.equal(await count(), 'No results');
    assert.deepEqual(await run('contract.edits'), [replaced], 'sent as the person\'s edit');
    await run('view.focus()');
    await undo();
    assert.equal(await getText(), text);
  });

  test(`${name} view: a find bar in a read-only view finds, and has no Replace`, async () => {
    await make(name, 'Alpha beta.\n', { editable: false });
    await select('Alpha', 0, 5);
    await shortcut('f', MOD | 1);
    assert.equal(await run(`!document.querySelector('.pj-find').hidden && document.querySelector('.pj-find [data-replace]').hidden`), true);
    assert.equal(await run(`document.querySelector('.pj-find-count').textContent`), '1 of 1', 'the selection is the match');
  });

  test(`${name} view: a line or paragraph of right-to-left text runs right to left`, async () => {
    await make(name, 'שלום עולם, hello.\n\nHello, עולם.\n');
    const directions = () => run(`[...document.querySelectorAll('.ProseMirror > p, .cm-line')].map((el) => getComputedStyle(el).direction)`);
    assert.deepEqual(await directions(), name === 'markdown' ? ['rtl', 'ltr'] : ['rtl', 'ltr', 'ltr', 'ltr']);
  });
}

test('markdown view: a read-only view has no formatting tools and no Comment bubble', async () => {
  await make('markdown', 'Alpha beta.\n', { toolbar: true, editable: false });
  assert.equal(await run(`document.querySelectorAll('.pj-toolbar [data-command]').length`), 0);
  await select('Alpha', 0, 5);
  assert.equal(await run(`document.querySelectorAll('.pj-bubble').length`), 0);
});

test('markdown view: typed Markdown stays text and saves escaped', async () => {
  await make('markdown', 'Start.\n');
  await select('Start.', 6, 6);
  // One key press per character, as typing is: input rules run on those.
  const typeKeys = async (text) => {
    for (const char of text) await page.send('Input.dispatchKeyEvent', { type: 'char', text: char, key: char, unmodifiedText: char });
  };
  for (const line of ['## x', '**x**', '- x']) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await typeKeys(line);
  }
  assert.equal(await getText(), 'Start.\n\n\\## x\n\n\\*\\*x\\*\\*\n\n\\- x\n');
  assert.equal(await run(`document.querySelectorAll('.ProseMirror h2, .ProseMirror strong, .ProseMirror ul').length`), 0);
});

test('markdown view: the standard keys format the selection, and Mod+K opens the link popover', async () => {
  for (const [letter, modifiers, saved] of [['b', MOD, '**beta**'], ['i', MOD, '*beta*'], ['e', MOD, '`beta`'], ['x', MOD | 8, '~~beta~~']]) {
    await make('markdown', 'Alpha beta.\n', { toolbar: true });
    await select('beta', 0, 4);
    await shortcut(letter, modifiers);
    assert.equal(await getText(), `Alpha ${saved}.\n`, letter);
  }
  await make('markdown', 'Alpha beta.\n', { toolbar: true });
  await select('beta', 0, 4);
  await shortcut('k');
  assert.equal(await run(`!document.querySelector('.pj-link').hidden && document.activeElement.matches('.pj-link-input')`), true);
  await type('https://example.com');
  await press('Enter');
  assert.equal(await getText(), 'Alpha [beta](https://example.com).\n');
});

test('markdown view: a block someone else makes a list or a heading keeps the caret at its character', async () => {
  await make('markdown', 'Alpha beta gamma.\n\nOther.\n');
  await select('Alpha beta', 10, 10);
  await run(`view.applyText('- Alpha beta gamma.\\n\\nOther.\\n')`);
  await type('X');
  assert.equal(await getText(), '- Alpha betaX gamma.\n\nOther.\n');
  await run(`view.applyText('## Alpha betaX gamma.\\n\\nOther.\\n')`);
  await type('Y');
  assert.equal(await getText(), '## Alpha betaXY gamma.\n\nOther.\n');
});

test('markdown view: the toolbar switches a numbered list to bullets and back', async () => {
  await make('markdown', '1. one\n2. two\n', { toolbar: true });
  await select('two', 3, 3);
  await run(`contract.tool('bullets')`);
  assert.equal(await getText(), '- one\n- two\n');
  await run(`contract.tool('numbers')`);
  assert.equal(await getText(), '1. one\n2. two\n');
});

test('markdown view: a change applied with who made it glows, with their name', async () => {
  await make('markdown', 'Alpha.\n\nBeta.\n');
  await run(`view.applyText('Alpha.\\n\\nBeta two.\\n', { by: 'Ana' })`);
  assert.equal(await run(`contract.drawn('.pj-flash')`), ' two');
  assert.equal(await run(`contract.drawn('.pj-flag')`), 'Ana');
});

test('markdown view: the link card hides while its link is scrolled out of view', async () => {
  await make('markdown', `See [the plan](plan.md).\n\n${'More.\n\n'.repeat(80)}`, { toolbar: true });
  await select('the plan', 3, 3);
  // After a frame; the query outside its callback, so a card not found fails the test, not hangs it.
  const cardShown = async () => {
    await run('new Promise(requestAnimationFrame)');
    return run(`!document.querySelector('.pj-link-card').hidden`);
  };
  assert.equal(await cardShown(), true);
  await run(`document.querySelector('.pj-canvas').scrollTop = 2000`);
  assert.equal(await cardShown(), false);
  await run(`document.querySelector('.pj-canvas').scrollTop = 0`);
  assert.equal(await cardShown(), true);
});

test('markdown view: pasting a URL over selected text links the text; other pastes are unchanged', async () => {
  const paste = (text) => run(`(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', ${JSON.stringify(text)});
    document.querySelector('.ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  })()`);
  await make('markdown', 'See the plan here.\n');
  await select('the plan', 0, 8);
  await paste(' https://example.com/plan ');
  assert.equal(await getText(), 'See [the plan](https://example.com/plan) here.\n');
  await select('here', 0, 4);
  await paste('not a link');
  assert.equal(await getText(), 'See [the plan](https://example.com/plan) not a link.\n');
});

test('markdown view: a task list item shows its box; clicking it ticks the item, saved as written otherwise', async () => {
  await make('markdown', '* [ ] one\n* [X] two\n\nAfter.\n');
  // A press in the box, in the item's gutter.
  const tick = async (quote) => {
    const { x, y } = await run(`(() => {
      const item = [...document.querySelectorAll('.ProseMirror li')].find((li) => li.textContent === ${JSON.stringify(quote)});
      const box = getComputedStyle(item, '::before');
      const rect = item.getBoundingClientRect();
      return { x: rect.left + parseFloat(box.left) + parseFloat(box.width) / 2, y: rect.top + parseFloat(box.top) + parseFloat(box.height) / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  assert.deepEqual(await run(`[...document.querySelectorAll('.ProseMirror li')].map((li) => [li.dataset.checked, getComputedStyle(li).listStyleType])`), [['false', 'none'], ['true', 'none']]);
  await tick('one');
  assert.equal(await getText(), '* [x] one\n* [X] two\n\nAfter.\n');
  await tick('two');
  assert.equal(await getText(), '* [x] one\n* [ ] two\n\nAfter.\n');
});

test('plain view: line numbers and font size follow the settings; the status bar follows the caret', async () => {
  await make('plain', 'ab\ncd\n');
  assert.equal(await run(`document.querySelectorAll('.cm-lineNumbers').length`), 1);
  await select('cd', 1, 1);
  await waitFor(async () => (await run(`document.querySelector('.pj-status-position').textContent`)) === 'Ln 2, Col 2', 5_000, 'the caret place');
  await select('cd', 0, 2);
  await waitFor(async () => (await run(`document.querySelector('.pj-status-position').textContent`)).endsWith('2 selected'), 5_000, 'the selection size');
  await run(`view.applySettings({ lineNumbers: false, wrap: false, fontSize: 18 })`);
  assert.equal(await run(`document.querySelectorAll('.cm-lineNumbers').length`), 0);
  assert.equal(await run(`getComputedStyle(document.querySelector('.cm-scroller')).fontSize`), '18px');
  await make('plain', 'x\n');
  assert.equal(await run(`document.querySelectorAll('.pj-statusbar').length`), 1, 'destroy takes the status bar away');
  await make('plain', 'x\n', { editable: false });
  assert.equal(await run(`document.querySelectorAll('.pj-statusbar').length`), 0, 'a read-only view has none');
});

test('plain view: whitespace marks and guides draw over the text without changing it', async () => {
  const text = 'a\tb  \n    indented\n\t\ttabbed\n\n  trailing  ';
  await make('plain', text);
  assert.equal(await getText(), text);
  assert.equal(await run(`document.querySelectorAll('.pj-ws-space, .pj-ws-tab').length`), 0, 'nothing is selected');
  assert.ok(await run(`document.querySelectorAll('.pj-guides').length`) >= 3, 'guides over the indented lines');
  await run(`view.applySettings({ lineNumbers: true, wrap: true, fontSize: 14, whitespace: 'all', guides: false })`);
  assert.equal(await run(`document.querySelectorAll('.pj-ws-tab').length`), 3);
  assert.equal(await run(`document.querySelectorAll('.pj-guides').length`), 0);
  await run(`view.applySettings({ lineNumbers: true, wrap: true, fontSize: 14, whitespace: 'selection', guides: true })`);
  await select('indented', 0, 8);
  await waitFor(async () => (await run(`document.querySelectorAll('.pj-ws-space').length`)) === 0, 5_000, 'no marks inside text without space');
  await select('a\tb', 0, 3);
  await waitFor(async () => (await run(`document.querySelectorAll('.pj-ws-tab').length`)) === 1, 5_000, 'the tab in the selection marked');
  assert.equal(await getText(), text);
});

// A key press, as typing is: keyDown (with the character it types, if any), then keyUp.
async function press(key, { modifiers = 0, text } = {}) {
  const codes = { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key], modifiers, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key], modifiers });
}
// A shortcut: `letter` with `modifiers` (Mod unless given).
async function shortcut(letter, modifiers = MOD) {
  const key = { key: letter, code: `Key${letter.toUpperCase()}`, windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0), modifiers };
  for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, ...key });
}
const SETTINGS = { lineNumbers: true, wrap: true, fontSize: 14, whitespace: 'selection', guides: true, indent: 'auto', tabWidth: 4, keepIndent: true };

test('plain view: Enter keeps the indent, Tab types the file\'s indent', async () => {
  await make('plain', 'a\n  b\n    c');
  await select('c', 1, 1);
  await press('Enter', { text: '\r' });
  await type('d');
  assert.equal(await getText(), 'a\n  b\n    c\n    d', 'Enter keeps the indent');
  await press('Tab');
  await type('e');
  assert.equal(await getText(), 'a\n  b\n    c\n    d  e', 'the file steps by 2');
  await run(`view.applySettings(${JSON.stringify({ ...SETTINGS, keepIndent: false, indent: 'tabs' })})`);
  await press('Enter', { text: '\r' });
  await type('f');
  await press('Tab');
  await type('g');
  assert.equal(await getText(), 'a\n  b\n    c\n    d  e\nf\tg', 'no kept indent; Tab types a tab');
});

test('plain view: Tab indents and Shift+Tab outdents the lines of a selection', async () => {
  await make('plain', 'x\n    one\n    two\n');
  await run(`view.applySettings(${JSON.stringify({ ...SETTINGS, indent: 'spaces', tabWidth: 2 })})`);
  await select('one', 0, 0);
  await press('ArrowDown', { modifiers: 8 });
  await press('Tab');
  assert.equal(await getText(), 'x\n      one\n      two\n');
  await press('Tab', { modifiers: 8 });
  await press('Tab', { modifiers: 8 });
  assert.equal(await getText(), 'x\n  one\n  two\n');
  for (let i = 0; i < 2; i++) await press('Tab', { modifiers: 8 });
  assert.equal(await getText(), 'x\none\ntwo\n');
});

test('plain view: the status bar shows the indent and saves what its menu and toggles pick', async () => {
  await make('plain', 'a\n  b\n    c\n');
  const text = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  assert.equal(await text('.pj-status-indent'), 'Indent: 2 spaces', 'found in the file');
  await click('.pj-status-indent');
  assert.equal(await run(`document.querySelector('.pj-statusbar .pj-block-menu').hidden`), false);
  assert.equal(await run(`document.querySelector('[aria-selected="true"]').textContent`), '2 spaces');
  await click('[data-indent="8"]');
  assert.equal(await run(`document.querySelector('.pj-statusbar .pj-block-menu').hidden`), true);
  await click('.pj-status-indent');
  await click('[data-indent="tabs"]');
  await click('[data-setting="wrap"]');
  await click('[data-setting="whitespace"]');
  assert.deepEqual(await run('contract.saved'), [{ indent: 'spaces', tabWidth: 8 }, { indent: 'tabs' }, { wrap: false }, { whitespace: 'all' }]);
  assert.equal(await getText(), 'a\n  b\n    c\n', 'the file is not changed');
  await run(`view.applySettings({ lineNumbers: true, wrap: false, fontSize: 14, whitespace: 'all', guides: true, indent: 'tabs', tabWidth: 4, keepIndent: true })`);
  assert.equal(await text('.pj-status-indent'), 'Indent: Tab');
  assert.equal(await run(`document.querySelector('[data-setting="wrap"]').getAttribute('aria-pressed')`), 'false');
  assert.equal(await run(`document.querySelector('[data-setting="whitespace"]').getAttribute('aria-pressed')`), 'true');
});

test('plain view: a text with "\\r\\n" line breaks is written back with them, and offsets are in that text', async () => {
  const text = 'one\r\ntwo\r\nthree\r\n';
  await make('plain', text);
  assert.equal(await getText(), text);
  await select('two', 3, 3);
  await type('!');
  assert.equal(await getText(), 'one\r\ntwo!\r\nthree\r\n', 'typing keeps the line breaks');
  assert.deepEqual(await run('view.selection()'), { from: 9, to: 9 }, 'the caret is an offset in the text');
  const typed = 'one\r\ntwo!\r\nthree\r\n';
  await run(`view.setMarks([{ kind: 'comment', id: 't', from: ${typed.indexOf('three') + 1}, to: ${typed.indexOf('three') + 4}, active: false }])`);
  assert.equal(await run(`contract.drawn('[data-thread="t"]')`), 'hre', 'a mark is drawn over the characters it names');
  const [two, three] = await run(`view.tops([${typed.indexOf('two')}, ${typed.indexOf('three')}])`);
  assert.ok(three > two, 'tops finds the line an offset is on');
  await run(`view.applyText('one\\r\\ntwo!\\r\\nthree\\r\\nfour\\r\\n')`);
  assert.equal(await getText(), 'one\r\ntwo!\r\nthree\r\nfour\r\n', 'a change from disk keeps them too');
  await make('plain', 'a\nb\r\n');
  assert.equal(await getText(), 'a\nb\r\n', 'mixed line breaks are left as they were until edited');
});

test('plain view: indent guides run on over blank lines', async () => {
  await make('plain', 'a\n    b\n\n    c\n\nd\n');
  assert.equal(await run(`document.querySelectorAll('.pj-guides-blank').length`), 1, 'only the blank line between two indented lines');
  assert.equal(await run(`document.querySelector('.pj-guides-blank').style.getPropertyValue('--width')`), '4');
  assert.equal(await getText(), 'a\n    b\n\n    c\n\nd\n');
});
