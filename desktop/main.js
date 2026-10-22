// The Ponjo desktop app (Electron main process): app lifecycle, one app
// instance for every launch, the menus, the Open / Open Folder / New Doc /
// Rename dialogs, and the app state (recent docs and folders, last folder,
// window bounds). Each doc window shows the editor page (dist/web), which
// talks to its doc in a process of its own, the doc host (doc-host.js);
// settings are the user's settings.json, shared by every window.

import { BrowserWindow, Menu, Notification, app, clipboard, dialog, ipcMain, nativeTheme, safeStorage, session, shell, utilityProcess } from 'electron';
import { statSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_AGENTS, agentsDir, installAgents, listAgents, readAgent } from '../src/store/agents.js';
import { readSecrets, secretsSet, writeSecrets } from '../src/store/secrets.js';
import { configDir, readSettings, updateSettings, watchSettings } from '../src/store/settings.js';
import { readSidecarText, sidecarPath } from '../src/store/files.js';
import { parseSidecar } from '../src/core/comments.js';
import { NAME_PATTERN } from '../src/core/mentions.js';
import { moveHistory } from '../src/store/history.js';
import {
  cleanPaths, createDoc, createUntitled, docPathFor, freeUntitledPath, isDocName, isInside,
  moveFolder, nameParts, pathsFromArgs, renameFile, trashFile, withDocExtension,
} from './files.js';
import { createDocHost } from './doc-host-client.js';
import { resolve as resolveInProject } from '../src/host/project-service.js';
import { docInFolder, firstDoc, firstTextFile, linkURL, listDocs, neighbourDoc, relativeDoc } from './folder.js';
import { loginEnvPatch, readLoginEnv } from './shell-env.js';
import { addRecent, readState, rememberFolderDoc, removeRecent, renameRecent, writeState } from './state.js';
import * as windows from './windows.js';

const MARKDOWN = { name: 'Markdown', extensions: ['md', 'markdown'] };
const isMac = process.platform === 'darwin';
const REVEAL_LABEL = isMac ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in File Explorer' : 'Show in Folder';
const DOC_HOST = join(dirname(fileURLToPath(import.meta.url)), 'doc-host.js');

app.setName('Ponjo');
app.enableSandbox();

// One app for every launch: a second launch (double-clicking a doc while the
// app runs, `Ponjo x.md` in a shell) hands its docs to this one and quits.
const launchPaths = pathsFromArgs(process.argv, launchContext());
if (!app.requestSingleInstanceLock({ paths: launchPaths })) {
  app.exit(0);
  await new Promise(() => {}); // never go on to start a second app
}

// The user's login shell environment, for the doc host and the agents it
// runs; read while Electron gets ready (see shell-env.js).
const loginEnv = process.platform === 'win32' ? Promise.resolve(null) : readLoginEnv();

// macOS sends docs opened from Finder, the dock or "Open With" as open-file,
// possibly before the app is ready. Docs from launches that arrive before
// start() has run wait for it.
const earlyPaths = [];
let started = false;
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (started) openLaunched([path]);
  else earlyPaths.push(path);
});

app.on('second-instance', (_event, argv, workingDirectory, data) => {
  const paths = Array.isArray(data?.paths)
    ? cleanPaths(data.paths)
    : pathsFromArgs(argv, { packaged: app.isPackaged, cwd: workingDirectory });
  if (started) openLaunched(paths);
  else earlyPaths.push(...paths);
});

const state = await readState();
// The View menu shows the user's settings and changes them in settings.json;
// every open page follows that file.
let settings = (await readSettings()).settings;
watchSettings(async () => {
  try {
    settings = (await readSettings()).settings;
    buildMenu();
    windows.refreshSettings();
  } catch (error) {
    console.error('Could not read the settings:', error);
  }
});
let stateWrites = Promise.resolve();
let pendingStateWrites = 0;
let quitting = false;
let docHost = null; // the process the open docs run in, from start()
let docHostDown = false;

// ---- opening docs ----

/**
 * Open a doc from the shell, a dialog or the recent list. `create` asks to
 * create a doc that does not exist (a path typed in a shell).
 */
async function openPath(path, { create = false, parent = null } = {}) {
  if (isDirectory(path)) return openFolder(path, parent);
  const docPath = await docPathFor(path);
  if (!docPath) {
    await warn(parent, `Ponjo can't open ${basename(path)}.`,
      'It opens text files (UTF-8, up to 20 MB) and their comment files (.comments.jsonl).');
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

/**
 * Docs from a launch: the command line, a second launch, or Finder. With
 * nothing opened, bring the app forward instead.
 */
async function openLaunched(paths) {
  let opened = false;
  for (const path of paths) {
    if (await openPath(path, { create: true })) opened = true;
  }
  if (!opened) windows.bringToFront();
}

// A doc inside the folder of the folder window it is opened from takes that
// window's place; any other gets a window of its own.
async function show(docPath, parent) {
  try {
    const here = windows.docFor(parent);
    const real = await realpath(docPath);
    if (here?.folder && relativeDoc(here.folder, real) && !windows.windowOf(real)) {
      const entry = await windows.switchDoc(here, real);
      rememberIn(entry);
      return true;
    }
    const { entry } = await windows.openDoc(real);
    rememberIn(entry);
    return true;
  } catch (error) {
    return failed(parent, `Could not open ${basename(docPath)}.`, error);
  }
}

/**
 * Open a folder: a window that lists its docs, showing the one last open
 * there (or its README, or with no Markdown, a text file). A folder without
 * any offers to start a doc.
 */
async function openFolder(path, parent = null) {
  let folder;
  try {
    folder = await realpath(path);
  } catch (error) {
    forget(path);
    return failed(parent, `${basename(path)} could not be found.`, error);
  }
  const open = windows.folderWindow(folder);
  if (open) return show(open.docPath, parent);
  const docs = await listDocs(folder);
  // A doc another window has open stays there; start with one that is free.
  const free = docs.filter((rel) => !windows.windowOf(docInFolder(folder, rel)));
  const remembered = Object.hasOwn(state.folderDocs, folder) ? state.folderDocs[folder] : null;
  // Any doc, Markdown or not, the project still shows.
  const last = remembered && (await resolveInProject(folder, remembered).then(() => docInFolder(folder, remembered), () => null));
  const lastFree = last && isFile(last) && !windows.windowOf(last) && (await docPathFor(last)) === last;
  let rel = (lastFree ? remembered : firstDoc(free)) ?? firstDoc(docs) ?? (await firstTextFile(folder));
  if (!rel) {
    const name = basename(folder) || folder;
    if (!(await ask(parent, `${name} has no docs yet.`, `Start one in ${folder}?`, 'New Doc'))) return false;
    try {
      rel = relativeDoc(folder, await createUntitled(folder));
    } catch (error) {
      return failed(parent, `Could not create a doc in ${name}.`, error);
    }
  }
  try {
    const { entry } = await windows.openDoc(docInFolder(folder, rel), { folder });
    rememberIn(entry);
    return true;
  } catch (error) {
    return failed(parent, `Could not open ${basename(folder)}.`, error);
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

/** File > Open Folder: a folder's docs in one window, with a sidebar. */
async function openFolderDialog(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(...withParent(parent, {
    title: 'Open Folder',
    buttonLabel: 'Open',
    defaultPath: startFolder(parent),
    properties: ['openDirectory', 'createDirectory'],
  }));
  if (canceled || filePaths.length === 0) return;
  await openFolder(filePaths[0], parent);
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
      `Ponjo never replaces a file. Open the existing doc in ${dirname(path)} instead?`, 'Open');
    if (open) await openPath(path, { parent });
    return;
  }
  await show(path, parent);
}

/**
 * File > Rename: the doc and its comments move together, and the window
 * stays open. A Markdown doc stays one (.md added if left off).
 */
async function renameDialog(win) {
  const entry = windows.docFor(win);
  if (!entry) return;
  const from = entry.docPath;
  const markdown = isDocName(from);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: `Rename ${basename(from)}`,
    buttonLabel: 'Rename',
    defaultPath: from,
    filters: markdown ? [MARKDOWN] : [],
    properties: ['createDirectory'],
  });
  const toPath = filePath && markdown ? withDocExtension(filePath) : filePath;
  if (canceled || !toPath || toPath === from) return;
  try {
    const to = await windows.renameOpenDoc(entry, toPath);
    state.recent = renameRecent(state.recent, from, to);
    app.addRecentDocument(to);
    state.lastFolder = dirname(to);
    if (entry.folder) rememberIn(entry);
    saveState();
    recentChanged();
  } catch (error) {
    const detail = error.code === 'exists'
      ? `${basename(error.path)} already exists in ${dirname(error.path)}. Ponjo never replaces a file; pick another name.`
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

// Docs and folders.
function recentDocs() {
  const present = state.recent.filter((path) => isFile(path) || isDirectory(path));
  if (present.length !== state.recent.length) {
    state.recent = present;
    saveState();
  }
  return present;
}

// Recent docs live in the app state and in the OS lists (the dock menu on
// macOS, the taskbar jump list on Windows once the app is installed).
function remember(docPath) {
  state.recent = addRecent(state.recent, docPath);
  app.addRecentDocument(docPath);
  state.lastFolder = dirname(docPath);
  saveState();
  recentChanged();
}

// A folder window is remembered as its folder, and the doc it shows as the
// one to open there next time.
function rememberIn(entry) {
  if (!entry.folder) return remember(entry.docPath);
  const rel = relativeDoc(entry.folder, entry.docPath);
  if (rel) state.folderDocs = rememberFolderDoc(state.folderDocs, entry.folder, rel);
  state.recent = addRecent(state.recent, entry.folder);
  app.addRecentDocument(entry.folder);
  state.lastFolder = dirname(entry.docPath);
  saveState();
  recentChanged();
}

function forget(docPath) {
  state.recent = removeRecent(state.recent, docPath);
  saveState();
  recentChanged();
}

// The home page lists folders only: projects.
const recentProjects = () => recentDocs().filter(isDirectory);

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

// The page handles its own shortcuts (Ctrl+, settings, Ctrl+/ shortcuts) on
// Windows and Linux, where a menu accelerator would take the key away from
// it, so there the menu only shows them. On macOS a menu key equivalent
// comes first, so the menu does the work. A view's settings and shortcuts
// (focus mode, the outline) are its own, in the page: the menu knows no
// view.
const PAGE_KEY = { registerAccelerator: isMac };

function buildMenu() {
  const focused = BrowserWindow.getFocusedWindow();
  const doc = windows.docFor(focused);
  // Settings and Keyboard Shortcuts open in the start window too.
  const page = Boolean(doc) || windows.isStartWindow(focused);
  const settingsItem = {
    label: 'Settings…', accelerator: 'CmdOrCtrl+,', ...PAGE_KEY, enabled: page,
    click: (_item, win) => pageCommand(win, 'settings'),
  };
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: isMac ? 'File' : '&File',
      submenu: [
        { label: 'New Doc…', accelerator: 'CmdOrCtrl+N', click: (_item, win) => newDocDialog(win) },
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: (_item, win) => openDialog(win) },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: (_item, win) => openFolderDialog(win) },
        { label: 'Open Recent', submenu: recentMenu() },
        { type: 'separator' },
        { label: 'Rename…', enabled: Boolean(doc), click: (_item, win) => renameDialog(win) },
        { label: REVEAL_LABEL, enabled: Boolean(doc), click: (_item, win) => revealDoc(win) },
        { type: 'separator' },
        ...(isMac ? [] : [settingsItem, { type: 'separator' }]),
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    // On Windows and Linux the page handles copy, paste and undo itself; a
    // menu accelerator would take Ctrl+Z away from the editor's own history.
    // On macOS, Undo and Redo go to the page too: the browser's own undo
    // loses track whenever the editor redraws text it did not type.
    ...(isMac ? [{
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'Cmd+Z', click: (_item, win) => pageCommand(win, 'undo') },
        { label: 'Redo', accelerator: 'Shift+Cmd+Z', click: (_item, win) => pageCommand(win, 'redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' },
      ],
    }] : []),
    {
      label: isMac ? 'View' : '&View',
      submenu: [
        { label: 'Theme', submenu: choices('theme', [['system', 'Match System'], ['light', 'Light'], ['dark', 'Dark']]) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', ...PAGE_KEY, enabled: page,
          click: (_item, win) => pageCommand(win, 'shortcuts'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A radio group for one setting.
function choices(key, options) {
  return options.map(([value, label]) => ({
    label, type: 'radio', checked: settings[key] === value, click: () => setSettings({ [key]: value }),
  }));
}

function setSettings(patch) {
  settings = { ...settings, ...patch };
  buildMenu();
  updateSettings(patch).catch((error) => console.error('Could not save the settings:', error));
}

// Ask the doc page in `win` to open part of its own UI.
function pageCommand(win, name) {
  const page = windows.docFor(win)?.view ?? (windows.isStartWindow(win) ? win : null);
  page?.webContents.send('ponjo:command', name);
}

// Someone asks to join the project in `folder`: a notification, whose click
// opens the Team panel of the project's window, where they wait at the top.
const notices = new Set(); // shown, kept until clicked or closed
function askedToJoin({ folder, name }) {
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title: `${name} asks to join ${basename(folder)}`, body: 'Allow them in the Team panel.' });
  notices.add(notice);
  notice.on('close', () => notices.delete(notice));
  notice.on('click', () => {
    notices.delete(notice);
    const entry = windows.folderWindow(folder);
    if (!entry) return;
    entry.win.show();
    entry.win.focus();
    pageCommand(entry.win, 'team');
  });
  notice.show();
}

// Settings > Agents > Show folder: where the agents are, to edit them.
function showAgents() {
  shell.openPath(agentsDir()).catch(() => {});
}

function revealDoc(win) {
  const entry = windows.docFor(win);
  if (entry) shell.showItemInFolder(entry.docPath);
}

function recentMenu() {
  const recent = recentDocs();
  if (recent.length === 0) return [{ label: 'No Recent Docs', enabled: false }];
  const label = (path) => `${basename(path)}${isDirectory(path) ? sep : ''}  —  ${dirname(path)}`.replaceAll('&', '&&');
  return [
    ...recent.map((path) => ({ label: label(path), click: (_item, win) => openPath(path, { parent: win }) })),
    { type: 'separator' },
    {
      label: 'Clear Recent',
      click: () => {
        state.recent = [];
        app.clearRecentDocuments();
        saveState();
        recentChanged();
      },
    },
  ];
}

// ---- the start window's settings ----

// The settings the start window shows and changes (its Settings dialog, a
// doc's but Views and Rules): your name, how things look and the agents, never buddies.
const PAGE_SETTING_KEYS = ['name', 'theme', 'agent', 'agents'];

// Settings > Agents: the agents, as a doc's page gets them from its doc host.
const agentScripts = async () => ({ agents: await listAgents(), shipped: SHIPPED_AGENTS, folder: agentsDir(), secrets: secretsSet(secrets) });

async function resetAgentScript(name) {
  if (!SHIPPED_AGENTS.includes(name)) throw new Error('not a shipped agent');
  await installAgents(undefined, { reset: name });
}
const pageSettings = (all) => Object.fromEntries(PAGE_SETTING_KEYS.map((key) => [key, all[key]]));

async function saveStartSettings(patch) {
  const isPlainObject = typeof patch === 'object' && patch !== null && !Array.isArray(patch);
  if (!isPlainObject || !Object.keys(patch).every((key) => PAGE_SETTING_KEYS.includes(key))) throw new Error('not allowed');
  return pageSettings(await updateSettings(patch));
}

// ---- the agents' secrets ----

// API keys and the like (src/store/secrets.js), decrypted here, the one
// process with the keychain, and handed to the doc host for the runs. A
// page learns only which are set.
let secrets = {};

// Set agent `agent`'s secret `key`, one its manifest declares, or clear it with ''.
async function saveSecret({ agent, key, value }) {
  const declared = NAME_PATTERN.test(agent) && (await readAgent(agent)).settings.some((field) => field.key === key && field.type === 'secret');
  if (!declared) throw new Error('not allowed');
  const own = { ...secrets[agent], [key]: value };
  if (!value) delete own[key];
  const next = { ...secrets, [agent]: own };
  await writeSecrets(safeStorage, next);
  secrets = next;
  await docHost.setSecrets(secrets); // before the page asks the doc host which are set
}

// ---- the sidebar's file operations ----

// A folder window's sidebar names files and folders by their place in the
// folder (`/` between folders, '' for the folder itself); the app checks
// that the project shows each (src/host/project-service.js) and its kind.
// The sidebar reads them through the doc's ProjectService; these are only
// the owner's.

function sidebarOf(win) {
  const entry = windows.docFor(win);
  if (!entry?.folder) throw new Error('not allowed');
  return entry;
}

// The path of `rel`: a 'file' or 'folder' of the sidebar of `entry`, or its
// 'root'. The path itself, not where a link there leads: renaming or
// deleting a link is the link's.
async function checkInFolder(entry, rel, kind) {
  const real = await resolveInProject(entry.folder, rel).catch(() => null);
  const ok = real !== null && (kind === 'root' ? rel === ''
    : rel !== '' && (kind === 'file' ? isFile(real) : kind === 'folder' && isDirectory(real)));
  if (!ok) throw new Error('not allowed');
  return docInFolder(entry.folder, rel);
}

// A name typed in the sidebar (nameParts), but none the sidebar would not show.
function sidebarName(typed) {
  const named = nameParts(String(typed ?? ''));
  if (!named.problem && named.parts.some((part) => part.startsWith('.'))) return { problem: 'Names starting with . are hidden here; pick another.' };
  return named;
}

const parentRel = (rel) => rel.split('/').slice(0, -1).join('/');

/**
 * A new, empty file named `name` (as typed; `/` makes folders) in the
 * sidebar folder `parent`. A new doc opens in this window.
 * @returns {Promise<{ rel: string } | { error: string }>}
 */
async function sidebarCreate(win, { parent, name } = {}) {
  const entry = sidebarOf(win);
  const dir = await checkInFolder(entry, parent, parent ? 'folder' : 'root');
  const named = sidebarName(name);
  if (named.problem) return { error: named.problem };
  let path;
  try {
    path = await createDoc(join(dir, ...named.parts));
  } catch (error) {
    if (error.code === 'exists') return { error: `${basename(error.path)} is already here.` };
    throw error;
  }
  const rel = relativeDoc(entry.folder, path);
  windows.expandFolder(entry, parentRel(rel));
  windows.relist(entry);
  if (await docPathFor(path)) await show(path, win);
  return { rel };
}

/**
 * Rename the sidebar's file or folder `from` to `to` (its new place, as
 * typed). A file's comments and history go with it, and any window showing
 * it, or a doc in the folder, follows.
 * @returns {Promise<{ rel: string } | { error: string }>}
 */
async function sidebarRename(win, { from, kind, to } = {}) {
  const entry = sidebarOf(win);
  if (kind !== 'file' && kind !== 'folder') throw new Error('not allowed');
  const fromPath = await checkInFolder(entry, from, kind);
  const named = sidebarName(to);
  if (named.problem) return { error: named.problem };
  const toPath = join(entry.folder, ...named.parts);
  if (toPath === fromPath) return { rel: from };
  try {
    if (kind === 'file') await moveFile(fromPath, toPath);
    else await moveFolderOf(fromPath, toPath);
  } catch (error) {
    if (error.code === 'exists') {
      const where = dirname(toPath) === dirname(fromPath) ? null : basename(dirname(toPath));
      return { error: where ? `${where} already has ${basename(toPath)}.` : `${basename(toPath)} is already here.` };
    }
    if (error.code === 'inside' || error.code === 'busy') return { error: `${error.message}.` };
    throw error;
  }
  const rel = relativeDoc(entry.folder, toPath);
  if (kind === 'folder') windows.moveExpanded(entry, from, rel);
  windows.expandFolder(entry, parentRel(rel));
  rememberIn(entry); // its doc may have moved
  windows.relist(entry);
  return { rel };
}

// A file and its comments and history; an open doc does
// all of that itself.
async function moveFile(fromPath, toPath) {
  const open = windows.windowOf(await realpath(fromPath));
  await mkdir(dirname(toPath), { recursive: true });
  if (open) {
    await windows.renameOpenDoc(open, toPath);
  } else {
    await renameFile(fromPath, toPath);
    await followDoc(fromPath, toPath);
  }
  movedInRecent(fromPath, toPath);
}

// A folder with everything in it. A folder window open on it, or inside it,
// would lose its folder, so that is refused.
async function moveFolderOf(fromPath, toPath) {
  const inFolder = (path) => isInside(fromPath, path);
  if (windows.openDocs().some((other) => other.folder && inFolder(other.folder))) {
    throw Object.assign(new Error(`${basename(fromPath)} is open in its own window`), { code: 'busy' });
  }
  const files = await listDocs(fromPath, { max: Infinity, isDoc: () => true });
  const open = windows.openDocs().filter((other) => inFolder(other.docPath));
  const openPaths = new Set(open.map((other) => other.docPath));
  await moveFolder(fromPath, toPath);
  const target = (path) => join(toPath, relative(fromPath, path));
  await Promise.all(open.map((other) => windows.renameOpenDoc(other, target(other.docPath), { moved: true })
    .catch((error) => console.error(error))));
  for (const rel of files) {
    const before = docInFolder(fromPath, rel);
    if (!openPaths.has(before)) await followDoc(before, target(before));
  }
  movedInRecent(fromPath, toPath);
}

// What a file that is not open leaves outside its folder, moved with it: its
// version history, if it is a doc.
async function followDoc(fromPath, toPath) {
  try {
    await moveHistory(fromPath, toPath, configDir());
  } catch (error) {
    console.error(`Could not move what belongs to ${basename(fromPath)}:`, error);
  }
}

// Recent docs and folders at or inside `fromPath` are now under `toPath`.
function movedInRecent(fromPath, toPath) {
  const moved = state.recent.map((path) => (isInside(fromPath, path) ? join(toPath, relative(fromPath, path)) : path));
  if (moved.every((path, i) => path === state.recent[i])) return;
  state.recent = [...new Set(moved)];
  saveState();
  recentChanged();
}

// How many comments the doc at `path` has (0 when its sidecar cannot be read).
async function countComments(path) {
  try {
    const text = await readSidecarText(path);
    return text === null ? 0 : parseSidecar(text).lines.filter((l) => l.comment).length;
  } catch {
    return 0;
  }
}

/**
 * Put the sidebar's file (with its comments) or folder (with everything in
 * it) in the Trash, after the user confirms. This window shows another doc
 * first if it showed one of them; other windows showing one close.
 * @returns {Promise<{ trashed: boolean }>}
 */
async function sidebarTrash(win, { rel, kind } = {}) {
  const entry = sidebarOf(win);
  if (kind !== 'file' && kind !== 'folder') throw new Error('not allowed');
  const path = await checkInFolder(entry, rel, kind);
  const name = basename(path);
  const real = await realpath(path);
  const gone = (docPath) => (kind === 'file' ? docPath === real : isInside(real, docPath));
  if (kind === 'folder' && windows.openDocs().some((other) => other.folder && isInside(real, other.folder))) {
    await warn(win, `Could not delete ${name}.`, `${name} is open in its own window. Close that window first.`);
    return { trashed: false };
  }
  const open = windows.openDocs().filter((other) => gone(other.docPath));
  let detail;
  if (kind === 'file') {
    const comments = await countComments(path);
    detail = comments ? `It and its ${count(comments, 'comment')} go to the Trash.` : 'It goes to the Trash.';
  } else {
    detail = 'It and everything in it go to the Trash.';
  }
  const working = (await Promise.all(open.map((other) => other.hosted.running().catch(() => [])))).flat();
  if (working.length) {
    detail += `\n\n${listNames(working)} ${working.length === 1 ? 'is' : 'are'} working on ${kind === 'file' ? name : 'a doc in it'}; that work stops.`;
  }
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', message: `Delete "${name}"?`, detail, buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1,
  });
  if (response !== 0) return { trashed: false };
  try {
    for (const other of open) {
      if (other !== entry) {
        await windows.closeDocWindow(other);
        continue;
      }
      const docs = await listDocs(entry.folder);
      const free = (doc) => {
        const docPath = docInFolder(entry.folder, doc);
        return !gone(docPath) && (!windows.windowOf(docPath) || windows.windowOf(docPath) === entry);
      };
      const next = neighbourDoc(docs, rel, free);
      if (next) {
        rememberIn(await windows.switchDoc(entry, docInFolder(entry.folder, next)));
      } else {
        windows.showStartWindow();
        await windows.closeDocWindow(entry);
      }
    }
  } catch (error) {
    await failed(win, `Could not delete ${name}.`, error);
    return { trashed: false };
  }
  try {
    if (kind === 'file') await trashFile(path, (item) => shell.trashItem(item));
    else await shell.trashItem(path);
  } catch (error) {
    await failed(win.isDestroyed() ? null : win, `Could not move ${name} to the Trash.`, error);
    return { trashed: false };
  }
  const left = state.recent.filter((recent) => !isInside(path, recent));
  if (left.length !== state.recent.length) {
    state.recent = left;
    saveState();
    recentChanged();
  }
  if (!win.isDestroyed()) windows.relist(entry);
  return { trashed: true };
}

const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const listNames = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * The menu of a sidebar row (`kind` 'file' or 'folder') or of the blank space
 * below the tree ('root'), at `x`, `y` in the window, or at the pointer.
 * Rename and New File happen in the page, which hears them as folder commands.
 */
async function sidebarMenu(win, contents, { rel, kind, x, y } = {}) {
  const entry = sidebarOf(win);
  const path = await checkInFolder(entry, rel, kind);
  const command = (action) => () => contents.send('ponjo:folder-command', { action, rel, kind });
  const report = (promise) => promise.catch((error) => failed(win, 'Could not do that.', error));
  const newFile = { label: 'New File', click: command('newFile') };
  const template = kind === 'root' ? [newFile] : [
    ...(kind === 'folder' ? [newFile, { type: 'separator' }] : []),
    { label: 'Rename…', accelerator: 'F2', registerAccelerator: false, click: command('rename') },
    { label: 'Copy Path', click: () => clipboard.writeText(rel) },
    { label: REVEAL_LABEL, click: () => shell.showItemInFolder(path) },
    { type: 'separator' },
    {
      label: 'Delete…',
      accelerator: isMac ? 'Cmd+Backspace' : 'Delete',
      registerAccelerator: false,
      click: () => report(sidebarTrash(win, { rel, kind })),
    },
  ];
  const at = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {};
  Menu.buildFromTemplate(template).popup({ window: win, ...at });
}

// ---- requests from pages (preload.cjs) ----

// A doc page asks for a message port to its doc (windows.connectPage).
ipcMain.on('ponjo:connect', (event) => {
  if (event.senderFrame !== event.sender.mainFrame) return;
  windows.connectPage(event.sender).catch((error) => console.error(error));
});

ipcMain.handle('ponjo:action', async (event, action, arg) => {
  // A doc's page is in a view of its window; the start window's is the window's own.
  const win = windows.windowForContents(event.sender) ?? BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame) throw new Error('not allowed');
  const fromStart = windows.isStartWindow(win);
  const fromDoc = Boolean(windows.docFor(win));
  if (action === 'openFolder' && fromStart) return void (await openFolderDialog(win));
  if (action === 'folder' && fromDoc) return windows.folderView(win, event.sender);
  if (action === 'openInFolder' && fromDoc) return openInFolder(win, arg);
  if (action === 'openLink' && fromDoc) return void (await openLink(win, arg));
  if (action === 'folderExpand' && fromDoc) {
    if (typeof arg?.path === 'string') windows.setExpanded(win, arg.path, Boolean(arg.open));
    return undefined;
  }
  if (action === 'folderSidebar' && fromDoc) return void windows.setSidebar(win, Boolean(arg));
  if (action === 'rename' && fromDoc) return void (await renameDialog(win));
  if (action === 'revealSidecar' && fromDoc) return void shell.showItemInFolder(sidecarPath(windows.docFor(win).docPath));
  if (action === 'trashSidecar' && fromDoc) return void (await shell.trashItem(sidecarPath(windows.docFor(win).docPath)));
  if (action === 'folderCreate' && fromDoc) return sidebarCreate(win, arg);
  if (action === 'folderRename' && fromDoc) return sidebarRename(win, arg);
  if (action === 'folderTrash' && fromDoc) return sidebarTrash(win, arg);
  if (action === 'folderMenu' && fromDoc) return void (await sidebarMenu(win, event.sender, arg));
  if (action === 'showAgents' && (fromStart || fromDoc)) return void showAgents();
  if (action === 'agentScripts' && fromStart) return agentScripts();
  if (action === 'resetAgentScript' && fromStart) return void (await resetAgentScript(arg));
  if (action === 'saveSecret' && (fromStart || fromDoc)) return void (await saveSecret(arg));
  if (action === 'recent' && fromStart) {
    return recentProjects().map((path) => ({ name: basename(path), folder: shortFolder(path) }));
  }
  if (action === 'drop' && (fromStart || fromDoc)) {
    // Docs and folders; any other file dropped is ignored.
    for (const path of cleanPaths(arg, 20)) {
      if (isDirectory(path) || (await docPathFor(path))) await openPath(path, { parent: win });
    }
    return undefined;
  }
  if (action === 'settings' && fromStart) return pageSettings((await readSettings()).settings);
  if (action === 'saveSettings' && fromStart) return saveStartSettings(arg);
  if (action === 'openRecent' && fromStart) {
    const path = recentProjects()[arg];
    if (path) await openPath(path, { parent: win });
    return undefined;
  }
  throw new Error(`not allowed: ${action}`);
});

// The sidebar of a folder window names one of its files (`/` between
// folders), which its doc's ProjectService opens; a doc opens, and false
// says the file is not one.
async function openInFolder(win, rel) {
  const { path } = await sidebarOf(win).hosted.call('open', { path: String(rel) });
  if ((await docPathFor(path)) !== path) return false;
  await openPath(path, { parent: win });
  return true;
}

// A link followed in a doc: the web goes to the browser; a path (linkURL)
// opens as a doc or folder dropped on the app would.
async function openLink(win, href) {
  const { docPath, folder } = windows.docFor(win);
  const url = linkURL(String(href), docPath, folder);
  if (url.protocol === 'file:') await openPath(fileURLToPath(url), { parent: win });
  else windows.openExternal(url.href);
}

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

// Let the last state write (window bounds, recent docs) finish first, and the
// open docs close (they stop their buddies' runs).
app.on('will-quit', (event) => {
  if (pendingStateWrites === 0 && (docHostDown || !docHost)) return;
  event.preventDefault();
  Promise.all([stateWrites, docHost?.shutdown()]).then(() => {
    docHostDown = true;
    app.quit();
  });
});

// Electron fires `ready` only once this module has finished loading, so
// starting up must not be awaited at the top level.
app.whenReady().then(start);

async function start() {
  // First, as loading it takes a while: the doc host, in a process of its
  // own so that what the docs do never holds up the windows. It takes its
  // environment from this process, so the login shell's goes in first.
  Object.assign(process.env, loginEnvPatch(process.env, await loginEnv));
  docHost = createDocHost({ fork: () => utilityProcess.fork(DOC_HOST, [], { serviceName: 'Ponjo Docs' }), onJoin: askedToJoin });
  secrets = await readSecrets(safeStorage).catch((error) => {
    console.error('Could not read the agents\' secrets:', error.message);
    return {};
  });
  docHost.setSecrets(secrets).catch((error) => console.error(error.message));
  // Clipboard writes are the only permission a page gets.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  windows.configure({
    openHostedDoc: docHost.openHostedDoc,
    lastBounds: () => state.bounds,
    onBounds: (bounds) => {
      state.bounds = bounds;
      saveState();
    },
    onClosed: buildMenu,
    // A new page's background until it draws: the editor's canvas in the user's theme.
    background: () => ((settings.theme === 'dark' || (settings.theme !== 'light' && nativeTheme.shouldUseDarkColors)) ? '#1c1b19' : '#ffffff'),
  });
  buildMenu();
  app.on('browser-window-focus', buildMenu);

  const first = [...launchPaths, ...earlyPaths.splice(0)];
  started = true;
  await openLaunched(first);
}

// ---- helpers ----

// `npm run desktop -- x.md` runs in the package folder, so relative paths
// on the command line resolve against the folder npm was run in.
function launchContext() {
  return { packaged: app.isPackaged, cwd: (!app.isPackaged && process.env.INIT_CWD) || process.cwd() };
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
