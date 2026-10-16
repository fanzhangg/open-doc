// window.opendocDesktop: the few things a page may ask the desktop app to do,
// all started by the user (a click or a key). The page never passes a path;
// the app shows its own dialog or looks the doc up by its place in the list.
// The one path that reaches the app from a window is a file the user dropped
// on it, read here from the drop itself, never from the page.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const DROPPABLE = /\.(md|markdown)(\.opendoc\.json)?$/i;
const carriesFiles = (event) => Boolean(event.dataTransfer?.types.includes('Files'));

// Dropping a doc on any window opens it. Other files are ignored; the
// browser never navigates to a dropped file.
window.addEventListener('dragover', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
}, true);
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (!event.isTrusted) return;
  const paths = [...event.dataTransfer.files].map((file) => webUtils.getPathForFile(file)).filter((path) => DROPPABLE.test(path));
  if (paths.length === 0) return;
  event.stopPropagation();
  ipcRenderer.invoke('opendoc:action', 'drop', paths).catch(() => {});
}, true);

function act(action, arg) {
  if (!navigator.userActivation.isActive) return Promise.reject(new Error('needs a click or a key press'));
  return ipcRenderer.invoke('opendoc:action', action, arg);
}

contextBridge.exposeInMainWorld('opendocDesktop', {
  newDoc: () => act('new'),
  open: () => act('open'),
  rename: () => act('rename'),
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
  /** The start window's crew: your starred agents, and who every new doc starts with. */
  crew: () => ipcRenderer.invoke('opendoc:action', 'crew'),
  setCrew: (id, on) => act('setCrew', { id: String(id), on: on === true }),
  addCrewAgent: (name, persona = '') => act('addCrew', { name: String(name), persona: String(persona) }),
  onCrewChanged: (callback) => {
    ipcRenderer.on('opendoc:crew-changed', () => callback());
  },
  /** Menu commands for the page: 'settings' or 'shortcuts'. */
  onCommand: (callback) => {
    ipcRenderer.on('opendoc:command', (_event, name) => callback(String(name)));
  },
});
