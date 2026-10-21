// The harness page's line to the doc host test/views/main.js starts: a
// message port to its doc, as desktop/preload.cjs gives a window, a new one
// for each doc `make` opens.

const { contextBridge, ipcRenderer } = require('electron');

let port = null;
let arrived = null;
let listener = () => {};
let nextCall = 0;
const calls = new Map();
ipcRenderer.on('collab:port', (event) => {
  port = event.ports[0];
  port.onmessage = ({ data }) => {
    if (data.event) return listener(data.event, data.data);
    calls.get(data.id)?.(data.error ? { error: data.error } : { result: data.result });
    calls.delete(data.id);
  };
  arrived?.();
});

contextBridge.exposeInMainWorld('collabHost', {
  make: (text) => new Promise((done) => {
    arrived = done;
    ipcRenderer.invoke('collab:make', text);
  }),
  call: (type, arg) => new Promise((done) => {
    const id = ++nextCall;
    calls.set(id, done);
    port.postMessage({ id, type, arg });
  }),
  write: (text) => ipcRenderer.invoke('collab:write', text),
  hold: () => ipcRenderer.invoke('collab:hold'),
  release: () => ipcRenderer.invoke('collab:release'),
  onEvent: (fn) => { listener = fn; },
});
