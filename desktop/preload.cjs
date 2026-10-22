// window.ponjoDesktop: the few things a page may ask the desktop app to do,
// all started by the user (a click or a key). The page never passes a full
// path; the app shows its own dialog or looks the doc up in its own list (the
// recent docs, or the docs of a folder window, which the app checks). A
// folder window's sidebar names a new doc or folder, or a new place for one,
// inside that folder; the app makes sure it stays there. The one
// path that reaches the app from a window is a file or folder the user
// dropped on it, read here from the drop itself, never from the page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const carriesFiles = (event) => Boolean(event.dataTransfer?.types.includes('Files'));

// Dropping a doc or a folder on any window opens it. Other files are ignored
// (the app tells a doc or a folder from another file); the browser never
// navigates to a dropped file.
window.addEventListener('dragover', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}, true);
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (!event.isTrusted) return;
  const paths = [...event.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter(Boolean);
  if (paths.length === 0) return;
  event.stopPropagation();
  ipcRenderer.invoke('ponjo:action', 'drop', paths).catch(() => {});
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
  return ipcRenderer.invoke('ponjo:action', action, arg);
}

// window.ponjoHost: a doc page's line to its doc in the doc host
// (src/host/doc-service.js), over a message port the app hands the page
// (windows.connectPage). `call(type, arg)` resolves to { result } or
// { error: { message, code } }; `onEvent(fn)` hears the doc's events, and
// those that came before it. When the doc host starts again the page gets
// a new port: the calls on the old one fail as `offline`, and the doc's
// `hello` on the new one catches the page up. The start window has no doc:
// its ask goes unanswered.
let port = null;
let unsent = [];
let nextCall = 0;
const calls = new Map();
let listener = null;
let early = [];
ipcRenderer.on('ponjo:port', (event) => {
  // A new port: the doc host started again, and the calls on the old one are lost.
  for (const resolve of calls.values()) resolve({ error: { message: 'The doc host stopped', code: 'offline' } });
  calls.clear();
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (data.event) {
      if (listener) listener(data.event, data.data);
      else early.push([data.event, data.data]);
      return;
    }
    const resolve = calls.get(data.id);
    calls.delete(data.id);
    resolve?.(data.error ? { error: data.error } : { result: data.result });
  };
  for (const message of unsent.splice(0)) port.postMessage(message);
});
ipcRenderer.send('ponjo:connect');

contextBridge.exposeInMainWorld('ponjoHost', {
  call: (type, arg) => new Promise((resolve) => {
    const id = ++nextCall;
    calls.set(id, resolve);
    const message = { id, type: String(type), arg };
    if (port) port.postMessage(message);
    else unsent.push(message);
  }),
  onEvent: (fn) => {
    listener = fn;
    for (const [event, data] of early.splice(0)) fn(event, data);
  },
});

contextBridge.exposeInMainWorld('ponjoDesktop', {
  /** The home page: a folder, picked or made in the OS dialog, opens as a project. */
  openFolder: () => act('openFolder'),
  /**
   * The folder window's sidebar: { name, current (the doc's path in the
   * folder, `/` between folders), expanded (open subfolders), sidebar,
   * carry }, or null in a window with a single doc.
   */
  folder: () => ipcRenderer.invoke('ponjo:action', 'folder'),
  /** Show the folder's file `path` in this window if it is a doc; false if it is not. */
  openInFolder: (path) => act('openInFolder', String(path)),
  /** Follow a link in this doc: a URL, or a path from the doc's folder. */
  openLink: (href) => act('openLink', String(href)),
  folderExpand: (path, open) => act('folderExpand', { path: String(path), open: Boolean(open) }),
  /**
   * A new, empty file `name` (`/` makes folders) in the sidebar folder
   * `parent` ('' for the top); a doc then opens here. Resolves to { rel }
   * (its path in the folder) or { error } (why the name can't be used).
   */
  folderCreate: (parent, name) => act('folderCreate', { parent: String(parent), name: String(name) }),
  /** Rename the sidebar's file or folder `from` to `to`; { rel } or { error }. */
  folderRename: (from, kind, to) => act('folderRename', { from: String(from), kind: String(kind), to: String(to) }),
  /** Delete the sidebar's file or folder, once the user confirms; { trashed }. */
  folderTrash: (rel, kind) => act('folderTrash', { rel: String(rel), kind: String(kind) }),
  /**
   * The menu of a sidebar row ('file', 'folder') or of the blank space under
   * the tree ('root', rel ''), at `x`, `y` in the page, or at the pointer.
   */
  folderMenu: (rel, kind, x = null, y = null) => act('folderMenu', {
    rel: String(rel), kind: String(kind), x: x === null ? null : Number(x), y: y === null ? null : Number(y),
  }),
  /** A command from a sidebar menu: { action: 'rename' | 'newFile', rel, kind }. */
  onFolderCommand: (callback) => {
    ipcRenderer.on('ponjo:folder-command', (_event, { action, rel, kind }) => callback({ action: String(action), rel: String(rel), kind: String(kind) }));
  },
  showSidebar: (open) => act('folderSidebar', Boolean(open)),
  /** Files in the folder came or went, or this window started listing a folder. */
  onFolderChanged: (callback) => {
    ipcRenderer.on('ponjo:folder-changed', () => callback());
  },
  rename: () => act('rename'),
  /** Show the doc's sidecar in Finder, to fix it by hand. */
  revealSidecar: () => act('revealSidecar'),
  /** Put the doc's sidecar in the Trash, to start new comments. */
  trashSidecar: () => act('trashSidecar'),
  /** Show the folder of the agent scripts. */
  showAgents: () => act('showAgents'),
  /** The start window's Settings > Agents: { agents, shipped, folder, secrets }, and resetting a shipped agent. */
  agentScripts: () => ipcRenderer.invoke('ponjo:action', 'agentScripts'),
  resetAgentScript: (name) => act('resetAgentScript', String(name)),
  /** Settings > Agents in any window: set agent `agent`'s secret `key` (an API key), or clear it with ''. */
  saveSecret: (agent, key, value) => act('saveSecret', { agent: String(agent), key: String(key), value: String(value) }),
  openRecent: (index) => act('openRecent', Number(index)),
  recent: () => ipcRenderer.invoke('ponjo:action', 'recent'),
  onRecentChanged: (callback) => {
    ipcRenderer.on('ponjo:recent-changed', () => callback());
  },
  /** The start window's settings (name and look), and saving a change to them. */
  settings: () => ipcRenderer.invoke('ponjo:action', 'settings'),
  saveSettings: (patch) => act('saveSettings', patch),
  /** The settings changed, here or in another window. */
  onSettingsChanged: (callback) => {
    ipcRenderer.on('ponjo:settings-changed', () => callback());
  },
  /** Commands for the page: 'settings' or 'shortcuts' from the menu, 'team' from a notification. */
  onCommand: (callback) => {
    ipcRenderer.on('ponjo:command', (_event, name) => callback(String(name)));
  },
});
