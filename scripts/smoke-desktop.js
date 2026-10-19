// Smoke test for the desktop app: launch it on two fixture docs and a .js
// file, check that each window's editor loads its doc, that a buddy answers
// an @mention in each (the agent is a fake script), that comments and a
// buddy's revision show in the .js file's plain view, that Cmd+Z undoes only
// your typing and Undo on a reply the buddy's edit, that the app listens on
// no port, that a doc host that stops is started again, and that a setting
// survives a relaunch.
//
//   node scripts/smoke-desktop.js [path to OpenDoc.exe]
//
// Without a path it tests the packaged app in release/ if there is one, else
// the app from this checkout. Settings and the Electron profile go to a temp
// folder, so a running OpenDoc and the user's settings are not touched. The
// app is driven over the DevTools protocol, the one port it opens here.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchElectron, waitFor } from './devtools.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED = {
  win32: join(root, 'release', 'win-unpacked', 'OpenDoc.exe'),
  linux: join(root, 'release', 'linux-unpacked', 'opendoc'),
  darwin: join(root, 'release', 'mac', 'OpenDoc.app', 'Contents', 'MacOS', 'OpenDoc'),
}[process.platform];

const given = process.argv[2] && resolve(process.argv[2]);
const packaged = given ?? (PACKAGED && existsSync(PACKAGED) ? PACKAGED : null);
const exe = packaged ?? createRequire(import.meta.url)('electron');
const appArgs = packaged ? [] : [join(root, 'desktop', 'main.js')];

const work = mkdtempSync(join(tmpdir(), 'opendoc-smoke-'));
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
const env = { ...process.env, OPENDOC_CONFIG_DIR: config, FAKE_DIR: work };
delete env.ELECTRON_RUN_AS_NODE;

const step = (text) => console.log(`smoke: ${text}`);
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
  check(loaded.title === `${name} — opendoc`, `a window shows ${name} (${loaded.title})`);
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
  return [...document.querySelectorAll('.od-stage .cm-line')].map((line) => line.textContent).join('\\n');
})()`);
check(lines === CODE, 'the plain view shows app.js as it is');
check(await commentShows(plain, CODE, 'greet'), 'a comment on its text is drawn over that text');
check(await answers(plain, 'Hello', 'Howdy', code), 'a buddy answers in app.js and its edit lands');
const revision = await waitFor(() => plain.evaluate(`document.querySelector('.od-stage .od-buddy-edit')?.textContent`), 15_000, 'the revision').catch(() => null);
check(revision === 'Howdy', `the buddy's revision shows (${revision})`);
check(await undoesOwnOnly(plain, code, 'Howdy', 'Hiya'), 'Cmd+Z after a buddy\'s edit undoes your typing, not the buddy\'s edit');
check(await undoesReply(plain, code, 'Howdy'), 'Undo on the reply takes the buddy\'s edit back');
const first = await app.page('plan.md');
const saved = await first.evaluate(`window.opendocHost.call('saveSettings', { font: 'serif' }).then((r) => Boolean(r.result))`);
check(saved, 'a setting was saved');

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
const second = await (await app.page('plan.md')).evaluate('document.documentElement.dataset.font');
check(second === 'serif', `the setting survived the relaunch (font: ${second})`);
await app.quit();

console.log(failed ? 'smoke: FAILED' : 'smoke: passed');
process.exit(failed ? 1 : 0);

// Comment on the doc in `page`, asking Clippy (made on first run)
// to change the title from `from` to `title`; true once the
// reply is in and the doc on disk has the new title.
async function answers(page, from, title, doc) {
  const replied = await page.evaluate(`(async () => {
    const call = async (type, arg) => (await window.opendocHost.call(type, arg)).result;
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

// Comment on the first `quote` in `text`, the doc in `page`: true once its
// thread's highlight covers just that.
async function commentShows(page, text, quote) {
  const start = text.indexOf(quote);
  const end = start + quote.length;
  const anchor = { exact: quote, prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start };
  const id = await page.evaluate(`window.opendocHost.call('comment', ${JSON.stringify({ anchor, body: 'A better name?' })}).then((r) => r.result.id)`);
  return waitFor(() => page.evaluate(`document.querySelector('.od-stage [data-thread="${id}"]')?.textContent === ${JSON.stringify(quote)}`), 15_000, 'the highlight')
    .catch(() => false);
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
  await waitFor(() => page.evaluate(`document.querySelector('.od-stage .od-editor').textContent.includes('${to}')`), 15_000, 'the edit to show');
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
