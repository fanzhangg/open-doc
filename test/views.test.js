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
<main class="od-canvas"><div class="od-stage"><article class="od-page"><div class="od-editor"></div></article></div></main>
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
    assert.equal(await drawn('[data-thread="t2"].od-hl-active'), 'A');
    assert.equal(await drawn('.od-mark-ins'), 'line');
    assert.equal(await drawn('del'), 'old row');
    await run(`document.querySelector('[data-thread="t1"]').click()`);
    assert.deepEqual(await run('contract.clicked'), ['t1']);
    await run('view.setMarks([])');
    assert.equal(await drawn('[data-thread], .od-mark-ins, del'), '');
  });

  test(`${name} view: setMarks draws a buddy's cursor after the text it stands at; its name shows while it works`, async () => {
    const text = 'Some **bold** words here.\n';
    await make(name, text);
    const mark = (working) => JSON.stringify([{ kind: 'cursor', at: text.indexOf(' here'), by: 'Clippy', working }]);
    const before = () => run(`(() => {
      const cursor = document.querySelector('.od-cursor');
      const range = document.createRange();
      range.setStart(cursor.parentElement.closest('[contenteditable]'), 0);
      range.setEndBefore(cursor);
      return range.toString().replaceAll('**', '');
    })()`);
    await run(`view.setMarks(${mark(false)})`);
    assert.equal(await before(), 'Some bold words');
    assert.equal(await run(`getComputedStyle(document.querySelector('.od-cursor-name')).display`), 'none');
    await run(`view.setMarks(${mark(true)})`);
    assert.equal(await run(`getComputedStyle(document.querySelector('.od-cursor-name')).display`), 'block');
    await run('view.setMarks([])');
    assert.equal(await run(`document.querySelectorAll('.od-cursor').length`), 0);
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
}

test('markdown view: a read-only view has no formatting tools and no Comment bubble', async () => {
  await make('markdown', 'Alpha beta.\n', { toolbar: true, editable: false });
  assert.equal(await run(`document.querySelectorAll('.od-toolbar [data-command]').length`), 0);
  await select('Alpha', 0, 5);
  assert.equal(await run(`document.querySelectorAll('.od-bubble').length`), 0);
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
  assert.equal(await run(`contract.drawn('.od-flash')`), ' two');
  assert.equal(await run(`contract.drawn('.od-flag')`), 'Ana');
});

test('plain view: line numbers and font size follow the settings; the status bar follows the caret', async () => {
  await make('plain', 'ab\ncd\n');
  assert.equal(await run(`document.querySelectorAll('.cm-lineNumbers').length`), 1);
  await select('cd', 1, 1);
  await waitFor(async () => (await run(`document.querySelector('.od-status-position').textContent`)) === 'Ln 2, Col 2', 5_000, 'the caret place');
  await select('cd', 0, 2);
  await waitFor(async () => (await run(`document.querySelector('.od-status-position').textContent`)).endsWith('2 selected'), 5_000, 'the selection size');
  await run(`view.applySettings({ lineNumbers: false, wrap: false, fontSize: 18 })`);
  assert.equal(await run(`document.querySelectorAll('.cm-lineNumbers').length`), 0);
  assert.equal(await run(`getComputedStyle(document.querySelector('.cm-scroller')).fontSize`), '18px');
  await make('plain', 'x\n');
  assert.equal(await run(`document.querySelectorAll('.od-statusbar').length`), 1, 'destroy takes the status bar away');
  await make('plain', 'x\n', { editable: false });
  assert.equal(await run(`document.querySelectorAll('.od-statusbar').length`), 0, 'a read-only view has none');
});

test('plain view: whitespace marks and guides draw over the text without changing it', async () => {
  const text = 'a\tb  \n    indented\n\t\ttabbed\n\n  trailing  ';
  await make('plain', text);
  assert.equal(await getText(), text);
  assert.equal(await run(`document.querySelectorAll('.od-ws-space, .od-ws-tab').length`), 0, 'nothing is selected');
  assert.ok(await run(`document.querySelectorAll('.od-guides').length`) >= 3, 'guides over the indented lines');
  await run(`view.applySettings({ lineNumbers: true, wrap: true, fontSize: 14, whitespace: 'all', guides: false })`);
  assert.equal(await run(`document.querySelectorAll('.od-ws-tab').length`), 3);
  assert.equal(await run(`document.querySelectorAll('.od-guides').length`), 0);
  await run(`view.applySettings({ lineNumbers: true, wrap: true, fontSize: 14, whitespace: 'selection', guides: true })`);
  await select('indented', 0, 8);
  await waitFor(async () => (await run(`document.querySelectorAll('.od-ws-space').length`)) === 0, 5_000, 'no marks inside text without space');
  await select('a\tb', 0, 3);
  await waitFor(async () => (await run(`document.querySelectorAll('.od-ws-tab').length`)) === 1, 5_000, 'the tab in the selection marked');
  assert.equal(await getText(), text);
});

// A key press, as typing is: keyDown (with the character it types, if any), then keyUp.
async function press(key, { modifiers = 0, text } = {}) {
  const codes = { Tab: 9, Enter: 13, ArrowDown: 40 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: codes[key], modifiers, ...(text ? { text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: codes[key], modifiers });
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
  assert.equal(await text('.od-status-indent'), 'Indent: 2 spaces', 'found in the file');
  await click('.od-status-indent');
  assert.equal(await run(`document.querySelector('.od-statusbar .od-block-menu').hidden`), false);
  assert.equal(await run(`document.querySelector('[aria-selected="true"]').textContent`), '2 spaces');
  await click('[data-indent="8"]');
  assert.equal(await run(`document.querySelector('.od-statusbar .od-block-menu').hidden`), true);
  await click('.od-status-indent');
  await click('[data-indent="tabs"]');
  await click('[data-setting="wrap"]');
  await click('[data-setting="whitespace"]');
  assert.deepEqual(await run('contract.saved'), [{ indent: 'spaces', tabWidth: 8 }, { indent: 'tabs' }, { wrap: false }, { whitespace: 'all' }]);
  assert.equal(await getText(), 'a\n  b\n    c\n', 'the file is not changed');
  await run(`view.applySettings({ lineNumbers: true, wrap: false, fontSize: 14, whitespace: 'all', guides: true, indent: 'tabs', tabWidth: 4, keepIndent: true })`);
  assert.equal(await text('.od-status-indent'), 'Indent: Tab');
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
  assert.equal(await run(`document.querySelectorAll('.od-guides-blank').length`), 1, 'only the blank line between two indented lines');
  assert.equal(await run(`document.querySelector('.od-guides-blank').style.getPropertyValue('--width')`), '4');
  assert.equal(await getText(), 'a\n    b\n\n    c\n\nd\n');
});
