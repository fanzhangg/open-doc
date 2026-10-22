// Smoke test for the desktop app: launch it on two fixture docs and a .js
// file, check that each window's editor loads its doc, that a buddy answers
// an @mention in each (the agent is a fake script), that comments and a
// buddy's revision show in the .js file's plain view, that Cmd+Z undoes only
// your typing and Undo on a reply the buddy's edit, that switching the
// Markdown view off and on turns the Markdown docs to the plain view and
// back without writing them, that its own settings apply at once, that the
// Markdown rule, apart from the view, refuses a page's merge of an outside
// change that would change how a line renders until it is switched off, that
// the app listens on no port, that a doc host that stops is started again, and
// that a setting survives a relaunch.
//
//   node scripts/smoke-desktop.js [path to Ponjo.exe]
//
// Without a path it tests the packaged app in release/ if there is one, else
// the app from this checkout. Settings and the Electron profile go to a temp
// folder, so a running Ponjo and the user's settings are not touched. The
// app is driven over the DevTools protocol, the one port it opens here.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from './devtools.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED = {
  win32: join(root, 'release', 'win-unpacked', 'Ponjo.exe'),
  linux: join(root, 'release', 'linux-unpacked', 'ponjo'),
  darwin: join(root, 'release', 'mac', 'Ponjo.app', 'Contents', 'MacOS', 'Ponjo'),
}[process.platform];

const given = process.argv[2] && resolve(process.argv[2]);
const packaged = given ?? (PACKAGED && existsSync(PACKAGED) ? PACKAGED : null);
const exe = packaged ?? createRequire(import.meta.url)('electron');
const appArgs = packaged ? [] : [join(root, 'desktop', 'main.js')];

const work = mkdtempSync(join(tmpdir(), 'ponjo-smoke-'));
const docs = ['plan.md', 'notes.md'].map((name) => {
  const doc = join(work, name);
  copyFileSync(join(root, 'test', 'fixtures', 'plan.md'), doc);
  return doc;
});
const code = join(work, 'app.js');
const CODE = "function greet(name) {\n\treturn 'Hello, ' + name;\n}\n\nconsole.log(greet('world'));\n";
writeFileSync(code, CODE);
// The fake agent runs every buddy: it makes the edit a comment asks for.
const config = join(work, 'config');
mkdirSync(join(config, 'agents'), { recursive: true });
const fake = join(root, 'test', 'fixtures', 'fake-agent.js');
writeFileSync(join(config, 'agents', 'fake'), `#!/bin/sh\nexec node "${fake}"\n`);
chmodSync(join(config, 'agents', 'fake'), 0o755);
writeFileSync(join(config, 'agents', 'fake.cmd'), `@node "${fake}"\r\n`);
writeFileSync(join(config, 'settings.json'), JSON.stringify({ agent: 'fake' }));
const hold = join(work, 'hold-saves'); // while it exists, the doc host holds back the answer to a save (desktop/doc-host.js)
const env = { ...process.env, PONJO_CONFIG_DIR: config, FAKE_DIR: work, PONJO_HOLD_SAVES: hold };
delete env.ELECTRON_RUN_AS_NODE;

const step = (text) => console.log(`smoke: ${text}`);
// In the page, the text of each element `selector` finds, as the person reads
// it: a buddy's cursor, and the name it shows while it works, are not text.
const textOf = (selector) => `[...document.querySelectorAll('${selector}')].map((node) => {
  const copy = node.cloneNode(true);
  for (const cursor of copy.querySelectorAll('.od-cursor')) cursor.remove();
  return copy.textContent;
})`;
let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? '  ok' : '  FAIL'}  ${text}`);
  if (!ok) failed = true;
};

step(`testing ${packaged ? exe : 'the app from this checkout'}`);

step('first launch, on two docs and a .js file');
let app = await launch([...docs, code]);
for (const [i, doc] of docs.entries()) {
  const name = doc.split(/[\\/]/).at(-1);
  const page = await app.page(name);
  const loaded = await page.evaluate(`(async () => {
    for (let i = 0; i < 100 && !document.querySelector('.ProseMirror'); i++) await new Promise((r) => setTimeout(r, 100));
    return { title: document.title, text: document.querySelector('.ProseMirror')?.textContent ?? '' };
  })()`);
  check(loaded.title === `${name} — Ponjo`, `a window shows ${name} (${loaded.title})`);
  check(loaded.text.includes('Q4 Launch Plan'), `the editor loaded ${name}`);
  check(await answers(page, 'Q4 Launch Plan', `Q${i + 1} Launch Plan`, doc), `a buddy answers in ${name} and its edit lands`);
}
step('undo');
const notes = await app.page('notes.md');
check(await undoesOwnOnly(notes, docs[1], 'Q2 Launch Plan', 'Q7 Launch Plan'), 'Cmd+Z after a buddy\'s edit undoes your typing, not the buddy\'s edit');
check(await undoesReply(notes, docs[1], 'Q2 Launch Plan'), 'Undo on the reply takes the buddy\'s edit back');

step('a .js file, in the plain view');
const plain = await app.page('app.js');
const lines = await plain.evaluate(`(async () => {
  for (let i = 0; i < 100 && !document.querySelector('.cm-content'); i++) await new Promise((r) => setTimeout(r, 100));
  return ${textOf('.od-stage .cm-line')}.join('\\n');
})()`);
check(lines === CODE, 'the plain view shows app.js as it is');
check(await commentShows(plain, CODE, 'greet'), 'a comment on its text is drawn over that text');
check(await bubbleComments(plain, 'world'), 'selecting text shows Comment, which opens a draft on it');
check(await answers(plain, 'Hello', 'Howdy', code), 'a buddy answers in app.js and its edit lands');
const revision = await waitFor(() => plain.evaluate(`document.querySelector('.od-stage .od-buddy-edit')?.textContent`), 15_000, 'the revision').catch(() => null);
check(revision === 'Howdy', `the buddy's revision shows (${revision})`);
check(await undoesOwnOnly(plain, code, 'Howdy', 'Hiya'), 'Cmd+Z after a buddy\'s edit undoes your typing, not the buddy\'s edit');
check(await undoesReply(plain, code, 'Howdy'), 'Undo on the reply takes the buddy\'s edit back');
const first = await app.page('plan.md');
const saved = await first.evaluate(`window.ponjoHost.call('saveSettings', { views: { markdown: { font: 'serif' } } }).then((r) => Boolean(r.result))`);
check(saved, 'a setting was saved');

step('the Markdown view, off and on');
const commented = await commentShows(first, readFileSync(docs[0], 'utf8'), 'gather feedback');
check(Boolean(commented), 'a comment on plan.md is drawn over its text');
const unswitched = { text: readFileSync(docs[0], 'utf8'), versions: await versionCount(first) };
await first.evaluate(`document.querySelector('.od-tool-history').click()`);
check(await switchesView(first, false, [first, notes], commented), 'off: both Markdown docs and the history show in the plain view, the comment still drawn, no outline');
check(await switchesView(first, true, [first, notes], commented), 'on: Markdown\'s view is back, with the comment and the outline');
await first.evaluate(`document.querySelector('.od-history-bar [data-action="close"]').click()`);
check(await ownSettingsApply(first), 'its Outline switch and the focus mode shortcut take effect at once');
check(readFileSync(docs[0], 'utf8') === unswitched.text && (await versionCount(first)) === unswitched.versions, 'switching wrote no file and recorded no version');

step('the Markdown rule, apart from the view');
await notes.evaluate(`document.querySelector('.od-settings [data-owner="markdown"][data-key="enabled"]').click()`);
await waitFor(() => notes.evaluate(`Boolean(document.querySelector('.od-stage .cm-content'))`), 15_000, 'the plain view');
// Taking out one `*` and adding another elsewhere would pair them into new emphasis.
const ruleOn = await mergesOutside(notes, docs[1]);
check(ruleOn === '1 *2* 3 4*\n', `on, with the view off: the line conflicts and your typing stays (${JSON.stringify(ruleOn)})`);
await notes.evaluate(`document.querySelector('.od-settings [data-owner="markdown-rule"][data-key="enabled"]').click()`);
const ruleOff = await mergesOutside(notes, docs[1]);
check(ruleOff === '1 *2 3 4*\n', `off: the line merges by character (${JSON.stringify(ruleOff)})`);

step('typing while a save is on its way');
const midSave = await typesDuringSave(notes, docs[1]);
check(midSave === 'one A B\ntwo\nTHREE\n', `what is typed while a save is on its way stays, with the change from outside (${JSON.stringify(midSave)})`);

if (process.platform === 'linux') {
  const all = listening(app.pid);
  const ports = all.filter((port) => port !== app.devtoolsPort);
  check(all.includes(app.devtoolsPort) && ports.length === 0, `the app listens on no port but this test's DevTools one${ports.length ? ` (it does on ${ports.join(', ')})` : ''}`);
  step('the doc host stops');
  const host = descendants(app.pid).find((pid) => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('utility-sub-type=node.mojom.NodeService'));
  check(Boolean(host), 'found the doc host');
  if (host) {
    process.kill(host, 'SIGKILL');
    await new Promise((done) => setTimeout(done, 3000));
    const again = await app.page('plan.md');
    check(await answers(again, 'Q1 Launch Plan', 'Q9 Launch Plan', docs[0]), 'after a new doc host starts, the page works again and a buddy answers');
  }
}
await app.quit();

step('relaunch');
app = await launch([docs[0]]);
const relaunched = await app.page('plan.md');
// From the settings the page got, not from how the editor shows them: the editor is off by now.
const second = await waitFor(() => relaunched.evaluate(`window.ponjoHost.call('state').then((r) => r.result.settings.views.markdown?.font)`), 15_000, 'the settings').catch(() => undefined);
check(second === 'serif', `the setting survived the relaunch (font: ${second})`);
await app.quit();

console.log(failed ? 'smoke: FAILED' : 'smoke: passed');
process.exit(failed ? 1 : 0);

// Comment on the doc in `page`, asking Clippy (made on first run)
// to change the title from `from` to `title`; true once the
// reply is in and the doc on disk has the new title.
async function answers(page, from, title, doc) {
  const replied = await page.evaluate(`(async () => {
    const call = async (type, arg) => (await window.ponjoHost.call(type, arg)).result;
    const { id } = await call('comment', { anchor: null, body: '@Clippy replace "${from}" with "${title}"' });
    for (let i = 0; i < 200; i++) {
      const thread = (await call('state'))?.threads.find((t) => t.id === id);
      if (thread?.comments.length === 2) return !thread.comments[1].failed;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  return replied && readFileSync(doc, 'utf8').includes(title);
}

// Comment on the first `quote` in `text`, the doc in `page`: its thread's id
// once its highlight covers just that, else false.
async function commentShows(page, text, quote) {
  const start = text.indexOf(quote);
  const end = start + quote.length;
  const anchor = { exact: quote, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start };
  const id = await page.evaluate(`window.ponjoHost.call('comment', ${JSON.stringify({ anchor, body: 'A better name?' })}).then((r) => r.result.id)`);
  return waitFor(() => page.evaluate(`document.querySelector('.od-stage [data-thread="${id}"]')?.textContent === ${JSON.stringify(quote)}`), 15_000, 'the highlight')
    .then(() => id, () => false);
}

// Switch the Markdown view `on` or off in Settings in `page`, which shows
// its history and comment `id`: true once every page in `pages` shows its
// doc in the view that goes with that (Markdown's, with its outline, or the
// plain one), and `page` its history too, with the comment drawn as before.
async function switchesView(page, on, pages, id) {
  await page.evaluate(`document.querySelector('.od-settings [data-owner="markdown"][data-key="enabled"]').click()`);
  const [shown, gone] = on ? ['.ProseMirror', '.cm-content'] : ['.cm-content', '.ProseMirror'];
  const inView = (stage) => `Boolean(document.querySelector('${stage} ${shown}')) && !document.querySelector('${stage} ${gone}')`;
  const doc = `${inView('.od-stage:not(.od-history-stage)')} && Boolean(document.querySelector('.od-outline')) === ${on}`;
  const drawn = `document.querySelector('.od-stage [data-thread="${id}"]')?.textContent === 'gather feedback'`;
  const own = `document.querySelector('.od-settings [data-key="outline"]').closest('.od-setting').parentElement.hidden === ${!on}`;
  const probes = pages.map((p) => [p, p === page ? `${doc} && ${inView('.od-history-stage')} && ${drawn} && ${own}` : doc]);
  for (const [p, probe] of probes) {
    if (!(await waitFor(() => p.evaluate(probe), 15_000, 'the view').catch(() => false))) return false;
  }
  return true;
}

// In `page`, a Markdown doc: true when the Markdown view's Outline switch
// hides the outline and Mod+Shift+F turns focus mode on, each at once and
// back again.
async function ownSettingsApply(page) {
  const has = (attr) => page.evaluate(`document.documentElement.hasAttribute('${attr}')`);
  const outline = () => page.evaluate(`document.querySelector('.od-settings [data-owner="markdown"][data-key="outline"]').click()`);
  const modifiers = (process.platform === 'darwin' ? 4 : 2) | 8; // Meta or Ctrl, and Shift
  const focusKey = async () => {
    for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, modifiers, key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70 });
  };
  await outline();
  const hidden = await has('data-no-outline');
  await outline();
  await focusKey();
  const focused = await has('data-focus');
  await focusKey();
  return hidden && !(await has('data-no-outline')) && focused && !(await has('data-focus'));
}

// How many versions of its doc the history of `page` holds.
function versionCount(page) {
  return page.evaluate(`window.ponjoHost.call('history').then((r) => r.result.versions.length)`);
}

// Select `quote` in the doc in `page` and click the bubble's Comment: true
// once the draft card shows, then the draft is cancelled.
async function bubbleComments(page, quote) {
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // the window may be behind another
  const shown = await page.evaluate(`(async () => {
    const editor = document.querySelector('.od-stage [contenteditable="true"]');
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.data.includes('${quote}')) node = walker.nextNode();
    editor.focus();
    const range = document.createRange();
    range.setStart(node, node.data.indexOf('${quote}'));
    range.setEnd(node, node.data.indexOf('${quote}') + ${quote.length});
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((r) => setTimeout(r, 200));
    const button = document.querySelector('.od-stage .od-bubble:not([hidden]) [data-action="comment"]');
    button?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return Boolean(button);
  })()`);
  const draft = shown && (await waitFor(() => page.evaluate(`Boolean(document.querySelector('.od-card[data-thread="draft"]'))`), 5_000, 'the draft').catch(() => false));
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  return draft;
}

// Type at the end of the doc in `page`, have a buddy change `from` to `to`,
// then press Cmd+Z (Ctrl+Z): true when the typing is gone and the change stays.
async function undoesOwnOnly(page, doc, from, to) {
  await page.evaluate(`(async () => {
    const editor = document.querySelector('.od-stage [contenteditable="true"]');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents([...editor.querySelectorAll('p, .cm-line')].at(-1));
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((r) => setTimeout(r, 100)); // the editor takes in the selection
  })()`);
  await page.send('Input.insertText', { text: ' Typed here.' });
  const onDisk = (text) => readFileSync(doc, 'utf8').includes(text);
  await waitFor(() => onDisk('Typed here.'), 15_000, 'the typing to be saved');
  if (!(await answers(page, from, to, doc))) return false;
  await waitFor(() => page.evaluate(`${textOf('.od-stage .od-editor')}[0].includes('${to}')`), 15_000, 'the edit to show');
  await new Promise((done) => setTimeout(done, 2000)); // its typing-in ends
  const modifiers = process.platform === 'darwin' ? 4 : 2; // Meta : Ctrl
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, modifiers, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
  await waitFor(() => !onDisk('Typed here.'), 15_000, 'the undo to be saved').catch(() => {});
  return !onDisk('Typed here.') && onDisk(to);
}

// Click Undo on the latest buddy reply in `page`: true once `before`, the
// text it changed, is back on disk.
async function undoesReply(page, doc, before) {
  const clicked = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.od-receipt-undo')].at(-1);
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) return false;
  return waitFor(() => readFileSync(doc, 'utf8').includes(before), 15_000, 'the undo').catch(() => false);
}

// In `page`, `doc` in the plain view: type " 4*" at the end of "1 *2* 3"
// while a change from outside takes out its second `*`. The doc once the page
// has merged the two and saved it.
async function mergesOutside(page, doc) {
  const shown = `${textOf('.od-stage .cm-line')}.join('\\n')`;
  writeFileSync(doc, '1 *2* 3\n');
  await waitFor(async () => (await page.evaluate(shown)) === '1 *2* 3\n', 15_000, 'the doc from disk');
  await page.evaluate(`document.querySelector('.od-stage [contenteditable="true"]').focus()`);
  // The End key, not a DOM selection: the editor's own caret is where typing goes.
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await page.send('Input.insertText', { text: ' 4*' });
  writeFileSync(doc, '1 *2 3\n'); // before the typing is saved
  return waitFor(async () => {
    const text = await page.evaluate(shown);
    return text.includes('4*') && readFileSync(doc, 'utf8') === text && text;
  }, 15_000, 'the merge to be saved').catch(() => null);
}

// The doc is changed from outside right after ' A' is typed, and the save's answer is
// held back while ' B' is typed: the page ends with all three, saved.
async function typesDuringSave(page, doc) {
  const shown = `${textOf('.od-stage .cm-line')}.join('\\n')`;
  // The end of the first line: the caret may be anywhere after the doc was read from disk.
  const endOfFirstLine = async () => {
    const mac = process.platform === 'darwin';
    const keys = [
      { modifiers: mac ? 4 : 2, ...(mac ? { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 } : { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 }) }, // the top of the doc
      { modifiers: 0, key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
    ];
    for (const key of keys) for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, ...key });
  };
  writeFileSync(doc, 'one\ntwo\nthree\n');
  await waitFor(async () => (await page.evaluate(shown)) === 'one\ntwo\nthree\n', 15_000, 'the doc from disk');
  await page.evaluate(`document.querySelector('.od-stage [contenteditable="true"]').focus()`);
  writeFileSync(hold, '');
  try {
    await endOfFirstLine();
    await page.send('Input.insertText', { text: ' A' });
    writeFileSync(doc, 'one\ntwo\nTHREE\n'); // before the typing is saved
    await waitFor(() => readFileSync(doc, 'utf8').includes(' A'), 15_000, 'the save to reach the doc');
    await endOfFirstLine();
    await page.send('Input.insertText', { text: ' B' });
  } finally {
    rmSync(hold, { force: true });
  }
  return waitFor(async () => {
    const text = await page.evaluate(shown);
    return readFileSync(doc, 'utf8') === text && text;
  }, 15_000, 'the typing to be saved').catch(() => null);
}

// Start the app on `paths`.
function launch(paths) {
  return launchElectron(exe, [...appArgs, `--user-data-dir=${join(work, 'profile')}`, ...paths], { env });
}

// Linux: `pid` and every process under it.
function descendants(pid) {
  const children = new Map();
  for (const entry of readdirSync('/proc').filter((e) => /^\d+$/.test(e))) {
    try {
      const parent = Number(readFileSync(`/proc/${entry}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]);
      children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
    } catch {
      // gone
    }
  }
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all;
}

// Linux: the TCP ports the processes under `pid` listen on.
function listening(pid) {
  const inodes = new Set();
  for (const p of descendants(pid)) {
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) {
        const link = readlinkSync(`/proc/${p}/fd/${fd}`, { encoding: 'utf8' });
        const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
        if (inode) inodes.add(inode);
      }
    } catch {
      // gone, or not ours to read
    }
  }
  const ports = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6'].filter((t) => existsSync(t))) {
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === '0A' && inodes.has(cols[9])) ports.push(parseInt(cols[1].split(':')[1], 16)); // 0A: LISTEN
    }
  }
  return ports;
}
