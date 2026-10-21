// Windows of the desktop app: one per open doc, keyed by the doc's real path,
// each with its doc open in the doc host (src/host/doc-service.js, run in
// doc-host.js, so its work never holds up the windows), plus the start
// window shown when no doc is open. A doc's page is a file (dist/web) that
// talks to its doc over a message port (`connectPage`). A window opened on
// a folder lists the folder's files in a sidebar and switches docs in
// place: it opens the next doc and closes the last one, and the buddies of
// the doc left behind stop.
//
// A doc's page lives in a view filling its window, not in the window itself,
// so a switch draws the next doc out of sight, under the one shown, and
// swaps it in only once it is drawn: the window never shows a blank page.

import { BrowserWindow, Menu, MessageChannelMain, WebContentsView, dialog, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeDoc, watchFolder } from './folder.js';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = join(here, '..', 'dist', 'web', 'index.html');
const DEFAULT_SIZE = { width: 1180, height: 820 };
const MIN_SIZE = { minWidth: 480, minHeight: 360 };
const CASCADE = 26;
const CLOSE_PATIENCE_MS = 5000;
const READY_PATIENCE_MS = 5000;
const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);
// Installed apps take their icon from the installer; this one shows in dev runs.
const ICON = join(here, '..', 'build', 'icon.png');
const WINDOW_ICON = existsSync(ICON) ? { icon: ICON } : {};

/**
 * `view` shows the doc's page. `folder` is the real path of the folder the
 * window was opened on (null for a single doc), `expanded` the subfolders
 * open in its sidebar, `sidebar` whether
 * the sidebar shows, and `carry` how the last page left it (the sidebar's
 * scroll, hidden comments), for the next. `pending` is the next doc's page
 * while it loads during a switch.
 * @type {Map<string, { win: BrowserWindow, view: WebContentsView, hosted: import('./doc-host-client.js').HostedDoc, docPath: string, folder: string | null, expanded: Set<string>, sidebar: boolean, carry: object | null, pending: { view: WebContentsView, docPath: string } | null, stopWatching: (() => void) | null, switching: Promise<object> | null }>}
 */
const docs = new Map();
const opening = new Map();
const hostedDocs = new WeakMap(); // a page's webContents → the HostedDoc of its doc
let startWindow = null;
let hooks = {
  openHostedDoc: null, onBounds: () => {}, onClosed: () => {}, lastBounds: () => null, background: () => '#ffffff',
};

/**
 * `openHostedDoc(docPath, { folder })` opens a doc in the doc host (doc-host-client.js),
 * `onBounds(bounds)` hears where a doc window was when it closed,
 * `lastBounds()` gives them back for the first window, `onClosed()` runs
 * after any window closed, and `background()` is the page's background
 * color in the user's theme, shown before a page draws.
 */
export function configure(options) {
  hooks = { ...hooks, ...options };
}

export const openDocs = () => [...docs.values()];
export const docFor = (win) => openDocs().find((entry) => entry.win === win) ?? null;
/** The window a doc page (`contents`, shown or loading) is in, if any. */
export const windowForContents = (contents) => openDocs()
  .find((entry) => entry.view.webContents === contents || entry.pending?.view.webContents === contents)?.win ?? null;
export const isStartWindow = (win) => win !== null && win === startWindow;
/** The window open on folder `folder` (a real path), if any. */
export const folderWindow = (folder) => openDocs().find((entry) => entry.folder === folder) ?? null;
/** The window `docPath` (a real path) is open in, if any. */
export const windowOf = (docPath) => docs.get(docPath) ?? null;

/**
 * Open `path` in its window, or focus the window it already has. With
 * `folder` (a real path), a new window lists that folder's docs; a window the
 * doc already has as a single doc starts listing them.
 * @returns {Promise<{ entry: object, created: boolean }>}
 */
export async function openDoc(path, { folder = null } = {}) {
  const docPath = await realpath(path);
  const open = docs.get(docPath);
  if (open) {
    if (folder && !open.folder) await attachFolder(open, folder);
    reveal(open.win);
    return { entry: open, created: false };
  }
  if (!opening.has(docPath)) {
    opening.set(docPath, createDocWindow(docPath, folder).finally(() => opening.delete(docPath)));
  }
  return { entry: await opening.get(docPath), created: true };
}

async function createDocWindow(docPath, folder) {
  const hosted = await hooks.openHostedDoc(docPath, { folder });
  const win = new BrowserWindow({
    ...nextBounds(),
    ...MIN_SIZE,
    show: false,
    title: basename(docPath),
    backgroundColor: hooks.background(),
    ...WINDOW_ICON,
    webPreferences: securePreferences(),
  });
  const entry = {
    win, view: null, hosted, docPath, folder: null, expanded: new Set(), sidebar: true, carry: null, pending: null, stopWatching: null, switching: null, left: false,
  };
  entry.view = createView(entry, hosted);
  win.contentView.addChildView(entry.view);
  docs.set(docPath, entry);
  if (folder) watch(entry, folder);
  if (process.platform === 'darwin') win.setRepresentedFilename(docPath);
  win.on('resize', () => {
    for (const view of [entry.view, entry.pending?.view]) if (view) fit(win, view);
  });
  win.on('focus', () => entry.view.webContents.focus());
  closeAfterLeaving(entry);
  win.on('closed', () => {
    docs.delete(entry.docPath);
    entry.stopWatching?.();
    for (const view of [entry.view, entry.pending?.view]) if (view && !view.webContents.isDestroyed()) view.webContents.close();
    entry.hosted.close().catch((error) => console.error(error));
    hooks.onClosed();
  });
  try {
    await entry.view.webContents.loadFile(PAGE);
  } catch (error) {
    win.destroy();
    throw error;
  }
  await drawn(entry.view); // shown once drawn, in the user's theme
  win.show();
  closeStartWindow();
  return entry;
}

// A view for the page of the doc `hosted`, the size of the window.
// It takes the window's title while it is the one shown, and loads the page
// again once a doc host that stopped has the doc open again.
function createView(entry, hosted) {
  const view = new WebContentsView({ webPreferences: securePreferences() });
  view.setBackgroundColor(hooks.background());
  restrictNavigation(view.webContents, PAGE);
  editMenu(view.webContents);
  hostedDocs.set(view.webContents, hosted);
  hosted.onRestart = () => {
    if (!view.webContents.isDestroyed()) view.webContents.reload();
  };
  view.webContents.on('page-title-updated', (_event, title) => {
    if (entry.view === view) entry.win.setTitle(title);
  });
  fit(entry.win, view);
  return view;
}

function fit(win, view) {
  const { width, height } = win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
}

/**
 * Show `path` in the folder window `entry` in place of its doc. The shown
 * page saves its last edit and stops taking input; the next doc opens and
 * its page loads under the shown one; once that page has drawn the doc and
 * the sidebar, it is uncovered and the last doc's page closes, and the doc
 * with it. A doc open in another window is shown there instead.
 * @returns {Promise<object>} the entry that shows the doc
 */
export async function switchDoc(entry, path) {
  await entry.switching?.catch(() => {});
  const docPath = await realpath(path);
  if (docPath === entry.docPath) return entry;
  const other = docs.get(docPath) ?? (await opening.get(docPath)?.catch(() => null));
  if (other) {
    reveal(other.win);
    return other;
  }
  entry.switching = switchTo(entry, docPath).finally(() => {
    entry.switching = null;
  });
  opening.set(docPath, entry.switching.finally(() => opening.delete(docPath)));
  return entry.switching;
}

async function switchTo(entry, docPath) {
  const { win } = entry;
  entry.carry = await leave(entry.view);
  let hosted = null;
  let view = null;
  try {
    hosted = await hooks.openHostedDoc(docPath, { folder: entry.folder });
    view = createView(entry, hosted);
    entry.pending = { view, docPath };
    expandTo(entry, docPath);
    win.contentView.addChildView(view, 0); // under the page shown, until it is drawn
    await view.webContents.loadFile(PAGE);
    await drawn(view);
  } catch (error) {
    if (view) {
      win.contentView.removeChildView(view);
      view.webContents.close();
    }
    await hosted?.close().catch(() => {});
    stay(entry.view);
    throw error;
  } finally {
    entry.pending = null;
  }
  const previous = { view: entry.view, hosted: entry.hosted };
  docs.delete(entry.docPath);
  Object.assign(entry, { view, hosted, docPath });
  docs.set(docPath, entry);
  win.contentView.removeChildView(previous.view);
  previous.view.webContents.close();
  win.setTitle(view.webContents.getTitle());
  if (process.platform === 'darwin') win.setRepresentedFilename(docPath);
  if (win.isFocused()) view.webContents.focus();
  previous.hosted.close().catch((error) => console.error(error));
  return entry;
}

// Ask the page in `view` to let go of its doc: it saves the last edit and
// stops taking input, and says how it was left (see `carry`). A page that
// cannot save in time keeps its doc, and the error says why.
async function leave(view) {
  if (view.webContents.isDestroyed()) return null;
  let timer;
  const late = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('the last edit is still being saved')), CLOSE_PATIENCE_MS);
  });
  try {
    return await Promise.race([view.webContents.executeJavaScript('window.opendocLeave ? window.opendocLeave() : null', true), late]);
  } catch (error) {
    stay(view);
    throw new Error(`The last edit is not saved yet: ${String(error.message ?? error).replace(/^.*Error: /, '')}.`);
  } finally {
    clearTimeout(timer);
  }
}

// The page keeps its doc after all: it takes input again.
function stay(view) {
  if (!view.webContents.isDestroyed()) view.webContents.executeJavaScript('window.opendocStay?.()', true).catch(() => {});
}

// Wait until the page in `view` has drawn its doc and sidebar; a page that
// never says so (it could not load the doc) is shown after a while anyway.
async function drawn(view) {
  let timer;
  await Promise.race([
    view.webContents.executeJavaScript('window.opendocReady ?? null', true).catch(() => {}),
    new Promise((resolve) => { timer = setTimeout(resolve, READY_PATIENCE_MS); }),
  ]);
  clearTimeout(timer);
}

/**
 * The sidebar of the doc page `contents` in `win`: the folder's name, the
 * doc open there, and how the last page left the sidebar; null for a
 * single doc.
 */
export function folderView(win, contents) {
  const entry = docFor(win);
  if (!entry?.folder) return null;
  const docPath = entry.pending?.view.webContents === contents ? entry.pending.docPath : entry.docPath;
  return {
    name: basename(entry.folder),
    current: relativeDoc(entry.folder, docPath),
    expanded: [...entry.expanded],
    sidebar: entry.sidebar,
    carry: entry.carry,
  };
}

/** Show or hide the sidebar of `win`. */
export function setSidebar(win, open) {
  const entry = docFor(win);
  if (entry?.folder) entry.sidebar = open;
}

/** Open or close subfolder `rel` in the sidebar of `win`. */
export function setExpanded(win, rel, open) {
  const entry = docFor(win);
  if (!entry?.folder) return;
  if (open) entry.expanded.add(rel);
  else entry.expanded.delete(rel);
}

/**
 * Tell the pages of `entry` that its folder changed now, rather than when
 * the watch notices: the sidebar shows a change it made at once.
 */
export function relist(entry) {
  if (!entry.folder || entry.win.isDestroyed()) return;
  for (const view of [entry.view, entry.pending?.view]) if (view && !view.webContents.isDestroyed()) view.webContents.send('opendoc:folder-changed');
}

/**
 * The subfolder `from` of the sidebar of `entry` is now `to` (`/` between
 * folders): whichever of it and its subfolders were open stay open.
 */
export function moveExpanded(entry, from, to) {
  for (const rel of [...entry.expanded]) {
    if (rel !== from && !rel.startsWith(`${from}/`)) continue;
    entry.expanded.delete(rel);
    entry.expanded.add(to + rel.slice(from.length));
  }
}

/** Open subfolder `rel` and the folders above it in the sidebar of `entry`. */
export function expandFolder(entry, rel) {
  const parts = rel ? rel.split('/') : [];
  for (let i = 1; i <= parts.length; i++) entry.expanded.add(parts.slice(0, i).join('/'));
}

/**
 * Close the window of `entry` once its page has saved its last edit; throws
 * (and the window stays) when it can't save.
 */
export async function closeDocWindow(entry) {
  const { win } = entry;
  if (win.isDestroyed()) return;
  await entry.switching?.catch(() => {});
  await leave(entry.view);
  entry.left = true;
  await new Promise((resolve) => {
    win.once('closed', resolve);
    win.close();
  });
}

// A single-doc window starts listing `folder`: its doc learns the folder
// (the agents may read it) and the page shows the sidebar.
async function attachFolder(entry, folder) {
  await entry.hosted.setFolder(folder);
  watch(entry, folder);
  entry.view.webContents.send('opendoc:folder-changed');
}

function watch(entry, folder) {
  entry.folder = folder;
  expandTo(entry);
  entry.stopWatching = watchFolder(folder, () => relist(entry));
}

// Open the subfolders down to the doc, so the sidebar shows it.
function expandTo(entry, docPath = entry.docPath) {
  const rel = relativeDoc(entry.folder, docPath);
  if (!rel) return;
  const parts = rel.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) entry.expanded.add(parts.slice(0, i).join('/'));
}

/**
 * Rename the doc open in `entry` and its sidecar to `toPath` (`.md` added
 * if missing), never over another file; its doc switches to the new path
 * and the page shows the new name. With `moved`, the doc is already there
 * (its folder was moved) and the doc only follows it.
 */
export async function renameOpenDoc(entry, toPath, { moved = false } = {}) {
  const docPath = await realpath(await entry.hosted.moveTo(toPath, { moved }));
  docs.delete(entry.docPath);
  entry.docPath = docPath;
  docs.set(docPath, entry);
  if (process.platform === 'darwin') entry.win.setRepresentedFilename(docPath);
  return docPath;
}

/** Show the app: the front doc window, else the start window. */
export function bringToFront() {
  const front = BrowserWindow.getFocusedWindow() ?? openDocs().at(-1)?.win ?? startWindow;
  if (front && !front.isDestroyed()) reveal(front);
  else showStartWindow();
}

export function showStartWindow() {
  if (startWindow) {
    reveal(startWindow);
    return startWindow;
  }
  startWindow = new BrowserWindow({
    width: 440,
    height: 420,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    title: 'Ponjo',
    ...WINDOW_ICON,
    webPreferences: securePreferences(),
  });
  restrictNavigation(startWindow.webContents, null);
  startWindow.once('ready-to-show', () => startWindow?.show());
  startWindow.on('closed', () => {
    startWindow = null;
    hooks.onClosed();
  });
  startWindow.loadFile(join(here, 'start.html'));
  return startWindow;
}

/** Tell the start window its recent list changed. */
export function refreshStartWindow() {
  startWindow?.webContents.send('opendoc:recent-changed');
}

/** Tell the start window the user's settings changed (how it looks). */
export function refreshSettings() {
  startWindow?.webContents.send('opendoc:settings-changed');
}

function closeStartWindow() {
  startWindow?.close();
}

function reveal(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function securePreferences() {
  return {
    preload: join(here, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: true,
  };
}

/**
 * A doc page (`contents`) asks for its doc: it gets a message port to it.
 * Asked again after a reload, it gets a new one.
 */
export async function connectPage(contents) {
  const hosted = hostedDocs.get(contents);
  if (!hosted) return;
  const { port1, port2 } = new MessageChannelMain();
  await hosted.attach(port1);
  if (!contents.isDestroyed()) contents.postMessage('opendoc:port', null, [port2]);
}

// A page stays on its own file (`page`); links elsewhere open in the
// default browser, and nothing opens a second Electron window.
function restrictNavigation(contents, page) {
  const away = (event, url) => {
    if (page && samePage(url, page)) return;
    event.preventDefault();
    openExternal(url);
  };
  contents.on('will-navigate', away);
  contents.on('will-redirect', away);
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
}

// Electron shows no context menu of its own. Right-clicking text offers the
// spell checker's corrections for a misspelled word, and cut, copy and paste.
function editMenu(contents) {
  contents.on('context-menu', (_event, { misspelledWord, dictionarySuggestions, isEditable, selectionText, editFlags }) => {
    const items = [];
    if (misspelledWord) {
      for (const word of dictionarySuggestions) items.push({ label: word, click: () => contents.replaceMisspelling(word) });
      if (!dictionarySuggestions.length) items.push({ label: 'No Guesses Found', enabled: false });
      items.push({ label: 'Learn Spelling', click: () => contents.session.addWordToSpellCheckerDictionary(misspelledWord) }, { type: 'separator' });
    }
    if (isEditable) items.push({ role: 'cut', enabled: editFlags.canCut }, { role: 'copy', enabled: editFlags.canCopy }, { role: 'paste', enabled: editFlags.canPaste });
    else if (selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}

function samePage(url, page) {
  try {
    const at = new URL(url);
    return at.protocol === 'file:' && fileURLToPath(at) === page;
  } catch {
    return false;
  }
}

export function openExternal(url) {
  try {
    if (EXTERNAL.has(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    // not a URL
  }
}

// Saving is automatic, so closing never asks "Save changes?". The window
// holds the close while the page saves an edit still on its way, and asks
// only if that fails or takes too long.
function closeAfterLeaving(entry) {
  const { win } = entry;
  let left = false;
  let leaving = false;
  win.on('close', (event) => {
    if (left || entry.left) {
      hooks.onBounds(win.getNormalBounds());
      return;
    }
    event.preventDefault();
    if (leaving) return;
    leaving = true;
    (async () => {
      await entry.switching?.catch(() => {});
      try {
        await leave(entry.view);
        left = true;
      } catch (error) {
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          message: `Some changes to ${basename(entry.docPath)} are not saved yet.`,
          detail: `${error.message} Close the window anyway and lose them?`,
          buttons: ['Keep Open', 'Close Anyway'],
          defaultId: 0,
          cancelId: 0,
        });
        left = response === 1;
      }
    })().finally(() => {
      leaving = false;
      if (left && !win.isDestroyed()) win.close();
    });
  });
}

// New windows reuse the last window's size and sit a little below and to the
// right of the window in front, inside the screen.
function nextBounds() {
  const front = BrowserWindow.getFocusedWindow() ?? openDocs().at(-1)?.win;
  const base = front && !front.isDestroyed() && front !== startWindow
    ? { ...front.getNormalBounds(), x: front.getNormalBounds().x + CASCADE, y: front.getNormalBounds().y + CASCADE }
    : hooks.lastBounds();
  if (!base) return { ...DEFAULT_SIZE, center: true };
  const area = screen.getDisplayMatching(base).workArea;
  const width = Math.min(base.width, area.width);
  const height = Math.min(base.height, area.height);
  const x = clamp(base.x, area.x, area.x + area.width - width);
  const y = clamp(base.y, area.y, area.y + area.height - height);
  return { x, y, width, height };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
