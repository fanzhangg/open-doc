// Smoke test for the desktop app: launch it on a fixture doc, check that the
// editor loads the doc, change a setting, relaunch and check that the setting
// stuck, then run the bundled `opendoc` CLI the way agent runs do.
//
//   node scripts/smoke-desktop.js [path to OpenDoc.exe]
//
// Without a path it tests the packaged app in release/ if there is one, else
// the app from this checkout. Settings and the Electron profile go to a temp
// folder, so a running OpenDoc and the user's settings are not touched.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
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
const cli = packaged
  ? join(process.platform === 'darwin' ? join(dirname(exe), '..', 'Resources') : join(dirname(exe), 'resources'), 'app', 'bin', 'opendoc.js')
  : join(root, 'bin', 'opendoc.js');

const work = mkdtempSync(join(tmpdir(), 'opendoc-smoke-'));
const doc = join(work, 'plan.md');
copyFileSync(join(root, 'spec', 'examples', 'plan.md'), doc);
const env = { ...process.env, OPENDOC_CONFIG_DIR: join(work, 'config') };
delete env.ELECTRON_RUN_AS_NODE;

const step = (text) => console.log(`smoke: ${text}`);
let failed = false;
const check = (ok, text) => {
  console.log(`${ok ? '  ok' : '  FAIL'}  ${text}`);
  if (!ok) failed = true;
};

step(`testing ${packaged ? exe : 'the app from this checkout'}`);

step('first launch');
let app = await launch();
const first = await app.evaluate(`(async () => {
  for (let i = 0; i < 100 && !document.querySelector('.ProseMirror'); i++) await new Promise((r) => setTimeout(r, 100));
  const token = new URLSearchParams(location.search).get('t');
  const saved = await fetch('/api/settings', {
    method: 'PUT', headers: { 'x-opendoc-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ font: 'serif' }),
  });
  return { title: document.title, text: document.querySelector('.ProseMirror')?.textContent ?? '', saved: saved.status };
})()`);
check(first.title === 'plan.md — opendoc', `window shows the doc (${first.title})`);
check(first.text.includes('Q4 Launch Plan'), 'the editor loaded the doc');
check(first.saved === 200, 'a setting was saved');
await app.quit();

step('relaunch');
app = await launch();
const second = await app.evaluate('document.documentElement.dataset.font');
check(second === 'serif', `the setting survived the relaunch (font: ${second})`);
await app.quit();

step('bundled CLI, as agent runs call it');
const run = spawnSync(exe, [cli, '--help'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 });
check(run.status === 0 && run.stdout.includes('opendoc'), `opendoc --help runs (exit ${run.status})`);

console.log(failed ? 'smoke: FAILED' : 'smoke: passed');
process.exit(failed ? 1 : 0);

// Start the app on the fixture doc with remote debugging, and wait for the
// doc's window.
async function launch() {
  const port = await freePort();
  const child = spawn(exe, [
    ...appArgs, `--remote-debugging-port=${port}`, `--user-data-dir=${join(work, 'profile')}`, doc,
  ], { env, stdio: 'ignore' });
  const exited = new Promise((done) => child.once('exit', done));
  const page = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return targets.find((t) => t.type === 'page' && t.title.startsWith('plan.md'));
  }, 30_000, 'the doc window');
  const cdp = await connect(page.webSocketDebuggerUrl);
  return {
    async evaluate(expression) {
      const res = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
      return res.result?.result?.value;
    },
    async quit() {
      cdp.close();
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
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

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
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
    close: () => ws.close(),
  };
}
