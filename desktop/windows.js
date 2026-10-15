// Windows of the desktop app: one per open doc, keyed by the doc's real path,
// each with its own local server (src/server/server.js), plus the start
// window shown when no doc is open.

import { BrowserWindow, dialog, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SIZE = { width: 1180, height: 820 };
const MIN_SIZE = { minWidth: 480, minHeight: 360 };
const CASCADE = 26;
const CLOSE_RETRY_MS = 200;
const CLOSE_PATIENCE_MS = 5000;
const EXTERNAL = new Set(['http:', 'https:', 'mailto:']);
// Installed apps take their icon from the installer; this one shows in dev runs.
const ICON = join(here, '..', 'build', 'icon.png');
const WINDOW_ICON = existsSync(ICON) ? { icon: ICON } : {};

/** @type {Map<string, { win: BrowserWindow, server: Awaited<ReturnType<typeof startServer>>, docPath: string }>} */
const docs = new Map();
const opening = new Map();
let startWindow = null;
let hooks = { onBounds: () => {}, onClosed: () => {}, lastBounds: () => null };

/**
 * `onBounds(bounds)` hears where a doc window was when it closed,
 * `lastBounds()` gives them back for the first window, and `onClosed()` runs
 * after any window closed.
 */
export function configure(options) {
  hooks = { ...hooks, ...options };
}

export const openDocs = () => [...docs.values()];
export const docFor = (win) => openDocs().find((entry) => entry.win === win) ?? null;
export const isStartWindow = (win) => win !== null && win === startWindow;

/**
 * Open `path` in its window, or focus the window it already has.
 * @returns {Promise<{ entry: object, created: boolean }>}
 */
export async function openDoc(path) {
  const docPath = await realpath(path);
  const open = docs.get(docPath);
  if (open) {
    reveal(open.win);
    return { entry: open, created: false };
  }
  if (!opening.has(docPath)) {
    opening.set(docPath, createDocWindow(docPath).finally(() => opening.delete(docPath)));
  }
  return { entry: await opening.get(docPath), created: true };
}

async function createDocWindow(docPath) {
  const server = await startServer(docPath, { agentFromSettings: true });
  const win = new BrowserWindow({
    ...nextBounds(),
    ...MIN_SIZE,
    show: false,
    title: basename(docPath),
    ...WINDOW_ICON,
    webPreferences: securePreferences(),
  });
  const entry = { win, server, docPath };
  docs.set(docPath, entry);
  if (process.platform === 'darwin') win.setRepresentedFilename(docPath);
  restrictNavigation(win, new URL(server.url).origin);
  closeAfterSaving(win, () => basename(entry.docPath));
  win.once('ready-to-show', () => win.show());
  win.on('close', () => hooks.onBounds(win.getNormalBounds()));
  win.on('closed', () => {
    docs.delete(entry.docPath);
    server.close().catch((error) => console.error(error));
    hooks.onClosed();
  });
  try {
    await win.loadURL(server.url);
  } catch (error) {
    win.destroy();
    throw error;
  }
  closeStartWindow();
  return entry;
}

/**
 * Rename the doc open in `entry` with `move(from, to)` (which returns the
 * final path); its server switches to the new path and the page shows the
 * new name.
 */
export async function renameOpenDoc(entry, toPath, move) {
  const moved = await entry.server.moveTo(toPath, move);
  const docPath = await realpath(moved);
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
    width: 560,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    title: 'OpenDoc',
    ...WINDOW_ICON,
    webPreferences: securePreferences(),
  });
  restrictNavigation(startWindow, null);
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

// A window stays on its own server; links elsewhere open in the default
// browser, and nothing opens a second Electron window.
function restrictNavigation(win, origin) {
  const leave = (event, url) => {
    if (origin && sameOrigin(url, origin)) return;
    event.preventDefault();
    openExternal(url);
  };
  win.webContents.on('will-navigate', leave);
  win.webContents.on('will-redirect', leave);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function openExternal(url) {
  try {
    if (EXTERNAL.has(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    // not a URL
  }
}

// Saving is automatic, so closing never asks "Save changes?". While an edit
// is still on its way the page holds the close (beforeunload) and saves it;
// keep retrying until it lets go, and ask only if that takes too long.
function closeAfterSaving(win, name) {
  let closing = false;
  let since = 0;
  let timer = null;
  win.on('close', () => {
    closing = true;
  });
  win.webContents.on('will-prevent-unload', (event) => {
    if (!closing) return; // a reload: the page saves; reloading again works
    closing = false;
    since ||= Date.now();
    if (Date.now() - since < CLOSE_PATIENCE_MS) {
      clearTimeout(timer);
      timer = setTimeout(() => !win.isDestroyed() && win.close(), CLOSE_RETRY_MS);
      return;
    }
    since = 0;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      message: `Some changes to ${name()} are not saved yet.`,
      detail: 'The last save did not finish. Close the window anyway and lose them?',
      buttons: ['Keep Open', 'Close Anyway'],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice === 1) event.preventDefault(); // let the page unload
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
