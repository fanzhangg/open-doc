// window.opendocDesktop: the few things a page may ask the desktop app to do,
// all started by the user (a click or a key). The page never passes a path;
// the app shows its own dialog or looks the doc up by its place in the list.

const { contextBridge, ipcRenderer } = require('electron');

function act(action, arg) {
  if (!navigator.userActivation.isActive) return Promise.reject(new Error('needs a click or a key press'));
  return ipcRenderer.invoke('opendoc:action', action, arg);
}

contextBridge.exposeInMainWorld('opendocDesktop', {
  newDoc: () => act('new'),
  open: () => act('open'),
  rename: () => act('rename'),
  openRecent: (index) => act('openRecent', Number(index)),
  recent: () => ipcRenderer.invoke('opendoc:action', 'recent'),
  onRecentChanged: (callback) => {
    ipcRenderer.on('opendoc:recent-changed', () => callback());
  },
});
