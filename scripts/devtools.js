// Drive an Electron app over the DevTools protocol, the one port it opens:
// the desktop smoke test (scripts/smoke-desktop.js) and the view contract
// tests (test/views.test.js).

import { spawn } from 'node:child_process';

/** Start Electron app `exe` with `args`, the DevTools protocol on a port it picks. */
export async function launchElectron(exe, args, { env }) {
  const child = spawn(exe, [...args, '--remote-debugging-port=0'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise((done) => child.once('exit', done));
  let stderr = ''; // its last lines, to say why a window did not show
  const devtoolsPort = await new Promise((done, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error('the app did not start')), 30_000);
    child.stderr.on('data', (chunk) => {
      text += chunk;
      stderr = (stderr + chunk).slice(-4000);
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
    // The page whose title starts with `name`, once there, within `ms`;
    // if it is not, the error names the pages there and the app's stderr.
    async page(name, ms = 30_000) {
      const pages = async () => (await (await fetch(`${base}/json`)).json()).filter((t) => t.type === 'page');
      const target = await waitFor(async () => (await pages()).find((t) => t.title.startsWith(name)), ms, `the ${name} window`)
        .catch(async (error) => {
          const titles = await pages().then((all) => all.map((t) => JSON.stringify(t.title)).join(', ') || 'none', () => 'DevTools did not answer');
          throw new Error(`${error.message}\npages: ${titles}\nthe app's stderr, last lines:\n${stderr}`);
        });
      const cdp = await connect(target.webSocketDebuggerUrl);
      return {
        send: (method, params) => cdp.send(method, params),
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

export async function waitFor(probe, ms, what) {
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
