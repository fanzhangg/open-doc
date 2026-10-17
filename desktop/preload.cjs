// window.opendocDesktop: the few things a page may ask the desktop app to do,
// all started by the user (a click or a key). The page never passes a full
// path; the app shows its own dialog or looks the doc up in its own list (the
// recent docs, or the docs of a folder window, which the app checks). A
// folder window's sidebar names a new doc or folder, or a new place for one,
// inside that folder; the app makes sure it stays there. The one
// path that reaches the app from a window is a file or folder the user
// dropped on it, read here from the drop itself, never from the page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const DROPPABLE = /\.(md|markdown)(\.opendoc\.json)?$/i;
const carriesFiles = (event) => Boolean(event.dataTransfer?.types.includes('Files'));

// Dropping a doc or a folder on any window opens it. Other files are ignored
// (the app tells a folder from a file); the browser never navigates to a
// dropped file.
window.addEventListener('dragover', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}, true);
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (!event.isTrusted) return;
  const paths = [...event.dataTransfer.files].map((file) => webUtils.getPathForFile(file))
    .filter((path) => path && (DROPPABLE.test(path) || !/\.[^\\/.]+$/.test(path)));
  if (paths.length === 0) return;
  event.stopPropagation();
  ipcRenderer.invoke('opendoc:action', 'drop', paths).catch(() => {});
}, true);

// A drop that ends a drag in the sidebar leaves no user activation behind,
// so a trusted release of the pointer just before counts too; the page
// can't make one.
let released = 0;
window.addEventListener('pointerup', (event) => {
  if (event.isTrusted) released = Date.now();
}, true);

function act(action, arg) {
  const user = navigator.userActivation.isActive || Date.now() - released < 1000;
  if (!user) return Promise.reject(new Error('needs a click or a key press'));
  return ipcRenderer.invoke('opendoc:action', action, arg);
}

contextBridge.exposeInMainWorld('opendocDesktop', {
  newDoc: () => act('new'),
  open: () => act('open'),
  openFolder: () => act('openFolder'),
  /**
   * The folder window's sidebar: { name, docs (paths in the folder, `/`
   * between folders), truncated, current, expanded (open subfolders) }, or
   * null in a window with a single doc.
   */
  folder: () => ipcRenderer.invoke('opendoc:action', 'folder'),
  /** Show the folder's doc `path` (one of `folder().docs`) in this window. */
  openInFolder: (path) => act('openInFolder', String(path)),
  folderExpand: (path, open) => act('folderExpand', { path: String(path), open: Boolean(open) }),
  /**
   * A new doc ('doc', which then opens here) or folder ('folder') `name` in
   * the sidebar folder `parent` ('' for the top). Resolves to { rel } (its
   * path in the folder) or { error } (why the name can't be used).
   */
  folderCreate: (parent, name, kind) => act('folderCreate', { parent: String(parent), name: String(name), kind: String(kind) }),
  /** Rename or move the sidebar's doc or folder `from` into `folder` as `name`; { rel } or { error }. */
  folderMove: (from, kind, folder, name) => act('folderMove', { from: String(from), kind: String(kind), folder: String(folder), name: String(name) }),
  /** Delete the sidebar's doc or folder, once the user confirms; { trashed }. */
  folderTrash: (rel, kind) => act('folderTrash', { rel: String(rel), kind: String(kind) }),
  /**
   * The menu of a sidebar row ('doc', 'folder') or of the blank space under
   * the tree ('root', rel ''), at `x`, `y` in the page, or at the pointer.
   */
  folderMenu: (rel, kind, x = null, y = null) => act('folderMenu', {
    rel: String(rel), kind: String(kind), x: x === null ? null : Number(x), y: y === null ? null : Number(y),
  }),
  /** A command from a sidebar menu: { action: 'rename' | 'move' | 'newDoc' | 'newFolder', rel, kind }. */
  onFolderCommand: (callback) => {
    ipcRenderer.on('opendoc:folder-command', (_event, { action, rel, kind }) => callback({ action: String(action), rel: String(rel), kind: String(kind) }));
  },
  showSidebar: (open) => act('folderSidebar', Boolean(open)),
  /** The folder's docs changed, or this window started listing a folder. */
  onFolderChanged: (callback) => {
    ipcRenderer.on('opendoc:folder-changed', () => callback());
  },
  rename: () => act('rename'),
  /**
   * Export the doc ({ format: 'pdf' | 'docx' | 'html', comments: 'none' | 'open' | 'all', paper: 'a4' | 'letter' })
   * where the user picks in a Save dialog; resolves to { name } of the file, or null when cancelled.
   */
  exportDoc: (options) => act('export', { format: String(options?.format), comments: String(options?.comments), paper: String(options?.paper) }),
  /** Open the file exported last, or show it in its folder. */
  openExport: () => act('openExport'),
  revealExport: () => act('revealExport'),
  /**
   * Set agent `id`'s `command`, or `claudeBin` or `codexBin` for every agent, after the user
   * confirms it; resolves to whether it was set.
   */
  setAgentProgram: (key, value, id = null) => act('agentProgram', { key: String(key), value: value === null ? null : String(value), id: id === null ? null : String(id) }),
  /** Pick where Claude Code ('claudeBin') or Codex ('codexBin') is in a native dialog. */
  chooseProgram: (key) => act('chooseProgram', String(key)),
  openRecent: (index) => act('openRecent', Number(index)),
  recent: () => ipcRenderer.invoke('opendoc:action', 'recent'),
  onRecentChanged: (callback) => {
    ipcRenderer.on('opendoc:recent-changed', () => callback());
  },
  /** The start window's settings (name and look), and saving a change to them. */
  settings: () => ipcRenderer.invoke('opendoc:action', 'settings'),
  saveSettings: (patch) => act('saveSettings', patch),
  /** The settings changed, here or in another window. */
  onSettingsChanged: (callback) => {
    ipcRenderer.on('opendoc:settings-changed', () => callback());
  },
  /** Menu commands for the page: 'settings' or 'shortcuts'. */
  onCommand: (callback) => {
    ipcRenderer.on('opendoc:command', (_event, name) => callback(String(name)));
  },
});
