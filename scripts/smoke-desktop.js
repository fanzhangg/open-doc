// Smoke test for the desktop app: launch it on two fixture docs, check that
// each window's editor loads its doc, that a buddy answers an @mention in
// each (the agent is a fake script), that the app listens on no port, that
// a doc host that stops is started again, and that a setting survives a
// relaunch.
//
//   node scripts/smoke-desktop.js [path to OpenDoc.exe]
//
// Without a path it tests the packaged app in release/ if there is one, else
// the app from this checkout. Settings and the Electron profile go to a temp
// folder, so a running OpenDoc and the user's settings are not touched. The
// app is driven over the DevTools protocol, the one port it opens here.

import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  copyFileSync(join(root, 'spec', 'examples', 'plan.md'), doc);
  return doc;
});
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

step('first launch, on two docs');
let app = await launch(docs);
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

// Comment on the doc in `page`, asking Clippy (the buddy every new doc
// starts with) to change the title from `from` to `title`; true once the
// reply is in and the doc on disk has the new title.
async function answers(page, from, title, doc) {
  const replied = await page.evaluate(`(async () => {
    const call = async (type, arg) => (await window.opendocHost.call(type, arg)).result;
    const id = 't_' + Math.random().toString(36).slice(2, 12);
    const body = '@Clippy replace "${from}" with "${title}"';
    await call('op', { op: { type: 'addThread', id, anchor: null, message: { id: 'm_' + id.slice(2), author: { name: 'me', kind: 'human' }, body } } });
    for (let i = 0; i < 200; i++) {
      const thread = (await call('state'))?.sidecar.threads.find((t) => t.id === id);
      if (thread?.messages.length === 2) return !thread.messages[1].failed;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  })()`);
  return replied && readFileSync(doc, 'utf8').includes(`# ${title}`);
}

// Start the app on `paths` with the DevTools protocol on a port it picks.
async function launch(paths) {
  const child = spawn(exe, [...appArgs, '--remote-debugging-port=0', `--user-data-dir=${join(work, 'profile')}`, ...paths], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((done) => child.once('exit', done));
  const devtoolsPort = await new Promise((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('the app did not start')), 30_000);
    child.stderr.on('data', (chunk) => {
      text += chunk;
      const found = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (found) {
        clearTimeout(timer);
        done(Number(found[1]));
      }
    });
  });
  const base = `http://127.0.0.1:${devtoolsPort}`;
  return {
    pid: child.pid,
    devtoolsPort,
    // The page whose title starts with `name`, once there.
    async page(name) {
      const target = await waitFor(async () => (await (await fetch(`${base}/json`)).json())
        .find((t) => t.type === 'page' && t.title.startsWith(name)), 30_000, `the ${name} window`);
      const cdp = await connect(target.webSocketDebuggerUrl);
      return {
        async evaluate(expression) {
          const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
          if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
          return res.result?.result?.value;
        },
      };
    },
    async quit() {
      const { webSocketDebuggerUrl } = await (await fetch(`${base}/json/version`)).json();
      const browser = await connect(webSocketDebuggerUrl);
      browser.send('Browser.close').catch(() => {});
      const code = await Promise.race([exited, new Promise((done) => setTimeout(() => done('timeout'), 15_000))]);
      if (code === 'timeout') {
        child.kill();
        throw new Error('the app did not quit');
      }
    },
  };
}

async function waitFor(probe, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((done, fail) => {
    ws.onopen = done;
    ws.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const n = ++id;
        pending.set(n, done);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
  };
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
