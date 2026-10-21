// The Electron app the view contract tests (test/views.test.js) and the
// two-writer harness (test/collab/) drive: one window on the page at
// VIEWS_PAGE. Smooth scrolling is off, so a view's scrollTo lands at once:
// on a slow CI machine its animation can outlast the test's wait.
//
// For the harness it starts the doc host as the app does (desktop/doc-host.js,
// a utility process), with a config folder whose buddy Pilot runs the fake
// agent (test/fixtures/fake-agent.js). `collab:make` opens a doc of that
// text in a project folder and hands the page a port to it, as a window
// gets one; `collab:write` changes the file from outside; `collab:hold` and
// `collab:release` hold Pilot's turns and let them go.

import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeConfig, tempDoc } from '../helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

app.commandLine.appendSwitch('disable-smooth-scrolling');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false, preload: join(here, 'preload.cjs') } });
  window.loadFile(process.env.VIEWS_PAGE);

  const config = await fakeConfig();
  const host = utilityProcess.fork(join(here, '..', '..', 'desktop', 'doc-host.js'), [], { env: { ...process.env, OPENDOC_CONFIG_DIR: config, FAKE_DIR: config } });
  const ready = new Promise((done) => host.once('message', done)); // { type: 'ready' }
  const asked = new Map();
  let nextId = 0;
  host.on('message', ({ id, result, error }) => {
    asked.get(id)?.[error ? 1 : 0](error ?? result);
    asked.delete(id);
  });
  const request = async (type, arg = {}, ports = []) => {
    await ready;
    return new Promise((done, fail) => {
      const id = ++nextId;
      asked.set(id, [done, fail]);
      host.postMessage({ id, type, ...arg }, ports);
    });
  };

  let doc = null;
  ipcMain.handle('collab:make', async (event, text) => {
    if (doc) await request('close', { docId: doc.docId });
    const path = await tempDoc(text);
    await mkdir(join(dirname(path), '.opendoc', 'buddies'), { recursive: true });
    await writeFile(join(dirname(path), '.opendoc', 'buddies', 'Pilot.md'), '\n');
    const { docId } = await request('open', { docPath: path, folder: dirname(path) });
    doc = { docId, path };
    const { port1, port2 } = new MessageChannelMain();
    await request('attach', { docId }, [port1]);
    window.webContents.postMessage('collab:port', null, [port2]);
  });
  ipcMain.handle('collab:write', (event, text) => writeFile(doc.path, text));
  ipcMain.handle('collab:hold', () => rm(join(config, 'release-Pilot'), { force: true }));
  ipcMain.handle('collab:release', () => writeFile(join(config, 'release-Pilot'), ''));
});
