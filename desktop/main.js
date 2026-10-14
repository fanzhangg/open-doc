// The OpenDoc desktop app (Electron main process): app lifecycle, the File
// menu, the Open / New Doc / Rename dialogs, and the app state (recent docs,
// last folder, window bounds). Each doc window runs the same editor page and
// local server as `opendoc serve`; settings are the user's settings.json,
// shared by every window.

import { BrowserWindow, Menu, app, dialog, ipcMain, session } from 'electron';
import { statSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';
import { createDoc, createUntitled, docPathFor, freeUntitledPath, renameDoc, withDocExtension } from './files.js';
import { addRecent, readState, removeRecent, renameRecent, writeState } from './state.js';
import * as windows from './windows.js';

const MARKDOWN = { name: 'Markdown', extensions: ['md', 'markdown'] };
const isMac = process.platform === 'darwin';

app.setName('OpenDoc');
app.enableSandbox();

const state = await readState();
let stateWrites = Promise.resolve();
let pendingStateWrites = 0;
let quitting = false;

// ---- opening docs ----

/**
 * Open a doc from the shell, a dialog or the recent list. `create` asks to
 * create a doc that does not exist (a path typed in a shell).
 */
async function openPath(path, { create = false, parent = null } = {}) {
  const docPath = docPathFor(path);
  if (!docPath) {
    await warn(parent, `OpenDoc can't open ${basename(path)}.`,
      'It opens Markdown docs (.md or .markdown) and their comment files (.md.opendoc.json).');
    return false;
  }
  if (!isFile(docPath)) {
    if (!create) {
      forget(docPath);
      await warn(parent, `${basename(docPath)} could not be found.`,
        `It was in ${dirname(docPath)}. It may have been moved, renamed or deleted.`);
      return false;
    }
    const folder = dirname(docPath);
    const detail = isDirectory(folder)
      ? `There is no doc with that name in ${folder}.`
      : `The folder ${folder} does not exist yet; it will be created too.`;
    if (!(await ask(parent, `Create ${basename(docPath)} in ${basename(folder) || folder}?`, detail, 'Create'))) return false;
    try {
      await createDoc(docPath);
    } catch (error) {
      if (error.code !== 'exists') return failed(parent, `Could not create ${basename(docPath)}.`, error);
    }
  }
  return show(docPath, parent);
}

async function show(docPath, parent) {
  try {
    const { entry } = await windows.openDoc(docPath);
    remember(entry.docPath);
    return true;
  } catch (error) {
    return failed(parent, `Could not open ${basename(docPath)}.`, error);
  }
}

async function openDialog(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(...withParent(parent, {
    title: 'Open',
    defaultPath: startFolder(parent),
    filters: [MARKDOWN, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections'],
  }));
  if (canceled) return;
  for (const path of filePaths) await openPath(path, { parent });
}

// ---- creating and renaming docs ----

/** File > New Doc: the OS save dialog picks the folder (or makes one) and the name. */
async function newDocDialog(parent) {
  const { canceled, filePath } = await dialog.showSaveDialog(...withParent(parent, {
    title: 'New Doc',
    buttonLabel: 'Create',
    defaultPath: await freeUntitledPath(startFolder(parent)),
    filters: [MARKDOWN],
    properties: ['createDirectory'],
  }));
  if (canceled || !filePath) return;
  const path = withDocExtension(filePath);
  try {
    await createDoc(path);
  } catch (error) {
    if (error.code !== 'exists') return failed(parent, `Could not create ${basename(path)}.`, error);
    const open = await ask(parent, `${basename(path)} already exists.`,
      `OpenDoc never replaces a file. Open the existing doc in ${dirname(path)} instead?`, 'Open');
    if (open) await openPath(path, { parent });
    return;
  }
  await show(path, parent);
}

/** File > New Doc in This Folder: `Untitled.md` (or the next free name) next to the open doc. */
async function newDocHere(win) {
  const entry = windows.docFor(win);
  if (!entry) return newDocDialog(win);
  try {
    await show(await createUntitled(dirname(entry.docPath)), win);
  } catch (error) {
    await failed(win, 'Could not create a doc in this folder.', error);
  }
}

/** File > Rename: the doc and its comments move together, and the window stays open. */
async function renameDialog(win) {
  const entry = windows.docFor(win);
  if (!entry) return;
  const from = entry.docPath;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: `Rename ${basename(from)}`,
    buttonLabel: 'Rename',
    defaultPath: from,
    filters: [MARKDOWN],
    properties: ['createDirectory'],
  });
  if (canceled || !filePath || withDocExtension(filePath) === from) return;
  try {
    const to = await windows.renameOpenDoc(entry, filePath, renameDoc);
    state.recent = renameRecent(state.recent, from, to);
    state.lastFolder = dirname(to);
    saveState();
    recentChanged();
  } catch (error) {
    const detail = error.code === 'exists'
      ? `${basename(error.path)} already exists in ${dirname(error.path)}. OpenDoc never replaces a file; pick another name.`
      : error.message;
    await warn(win, `Could not rename ${basename(from)}.`, detail);
  }
}

// The open doc's folder, else the last folder used, else Documents.
function startFolder(win) {
  const entry = windows.docFor(win);
  if (entry) return dirname(entry.docPath);
  if (state.lastFolder && isDirectory(state.lastFolder)) return state.lastFolder;
  return app.getPath('documents');
}

// ---- recent docs and app state ----

function recentDocs() {
  const present = state.recent.filter(isFile);
  if (present.length !== state.recent.length) {
    state.recent = present;
    saveState();
  }
  return present;
}

function remember(docPath) {
  state.recent = addRecent(state.recent, docPath);
  state.lastFolder = dirname(docPath);
  saveState();
  recentChanged();
}

function forget(docPath) {
  state.recent = removeRecent(state.recent, docPath);
  saveState();
  recentChanged();
}

function recentChanged() {
  buildMenu();
  windows.refreshStartWindow();
}

function saveState() {
  const snapshot = structuredClone(state);
  pendingStateWrites++;
  stateWrites = stateWrites
    .then(() => writeState(snapshot))
    .catch((error) => console.error('Could not save the app state:', error))
    .finally(() => pendingStateWrites--);
}

// ---- menu ----

function buildMenu() {
  const doc = windows.docFor(BrowserWindow.getFocusedWindow());
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: isMac ? 'File' : '&File',
      submenu: [
        { label: 'New Doc…', accelerator: 'CmdOrCtrl+N', click: (_item, win) => newDocDialog(win) },
        { label: 'New Doc in This Folder', accelerator: 'CmdOrCtrl+Alt+N', enabled: Boolean(doc), click: (_item, win) => newDocHere(win) },
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (_item, win) => openDialog(win) },
        { label: 'Open Recent', submenu: recentMenu() },
        { type: 'separator' },
        { label: 'Rename…', enabled: Boolean(doc), click: (_item, win) => renameDialog(win) },
        { type: 'separator' },
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    // On Windows and Linux the page handles copy, paste and undo itself; a
    // menu accelerator would take Ctrl+Z away from the editor's own history.
    ...(isMac ? [{ role: 'editMenu' }] : []),
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function recentMenu() {
  const recent = recentDocs();
  if (recent.length === 0) return [{ label: 'No Recent Docs', enabled: false }];
  const label = (path) => `${basename(path)}  —  ${dirname(path)}`.replaceAll('&', '&&');
  return [
    ...recent.map((path) => ({ label: label(path), click: (_item, win) => openPath(path, { parent: win }) })),
    { type: 'separator' },
    {
      label: 'Clear Recent',
      click: () => {
        state.recent = [];
        saveState();
        recentChanged();
      },
    },
  ];
}

// ---- requests from pages (preload.cjs) ----

ipcMain.handle('opendoc:action', async (event, action, arg) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame) throw new Error('not allowed');
  const fromStart = windows.isStartWindow(win);
  const fromDoc = Boolean(windows.docFor(win));
  if (action === 'new' && (fromStart || fromDoc)) return void (await newDocDialog(win));
  if (action === 'open' && (fromStart || fromDoc)) return void (await openDialog(win));
  if (action === 'rename' && fromDoc) return void (await renameDialog(win));
  if (action === 'recent' && fromStart) {
    return recentDocs().map((path) => ({ name: basename(path), folder: shortFolder(path) }));
  }
  if (action === 'openRecent' && fromStart) {
    const path = recentDocs()[arg];
    if (path) await openPath(path, { parent: win });
    return undefined;
  }
  throw new Error(`not allowed: ${action}`);
});

// ---- lifecycle ----

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (!isMac || quitting) app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) windows.showStartWindow();
});

// Let the last state write (window bounds, recent docs) finish first.
app.on('will-quit', (event) => {
  if (pendingStateWrites === 0) return;
  event.preventDefault();
  stateWrites.then(() => app.quit());
});

// Electron fires `ready` only once this module has finished loading, so
// starting up must not be awaited at the top level.
app.whenReady().then(start);

async function start() {
  // Clipboard writes are the only permission a page gets.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  windows.configure({
    lastBounds: () => state.bounds,
    onBounds: (bounds) => {
      state.bounds = bounds;
      saveState();
    },
    onClosed: buildMenu,
  });
  buildMenu();
  app.on('browser-window-focus', buildMenu);

  let opened = false;
  for (const path of pathsFromArgs(process.argv)) {
    if (await openPath(path, { create: true })) opened = true;
  }
  if (!opened) windows.showStartWindow();
}

// ---- helpers ----

// Doc paths given on the command line. `npm run desktop -- x.md` runs in the
// package folder, so relative paths resolve against the folder npm was run in.
function pathsFromArgs(argv) {
  const args = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  if (!app.isPackaged) args.shift(); // electron's own argument: this app's main.js
  const cwd = (!app.isPackaged && process.env.INIT_CWD) || process.cwd();
  return args.map((arg) => resolve(cwd, arg));
}

// The doc's folder, with the home folder shown as ~.
function shortFolder(path) {
  const folder = dirname(path);
  const home = app.getPath('home');
  return folder === home || folder.startsWith(home + sep) ? `~${folder.slice(home.length)}` : folder;
}

const withParent = (parent, options) => (parent ? [parent, options] : [options]);

async function warn(parent, message, detail) {
  await dialog.showMessageBox(...withParent(parent, { type: 'warning', message, detail, buttons: ['OK'] }));
}

async function ask(parent, message, detail, yes) {
  const { response } = await dialog.showMessageBox(...withParent(parent, {
    type: 'question', message, detail, buttons: [yes, 'Cancel'], defaultId: 0, cancelId: 1,
  }));
  return response === 0;
}

async function failed(parent, message, error) {
  console.error(error);
  await warn(parent, message, error.message);
  return false;
}

function isFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isDirectory(path) {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}
