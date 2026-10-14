// The opendoc page: wires the editor, the thread pane and the server together.
// Saves are debounced and conditional on the hash they were based on; changes
// made on disk (usually by the agent) arrive as SSE events.

import { api } from './api.js';
import { createDocEditor } from './editor.js';
import { createThreadPane } from './threads.js';
import { project } from '../src/core/project.js';
import { createAnchor, locate } from '../src/core/anchor.js';
import { newId } from '../src/core/ops.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const SAVE_DELAY_MS = 800;
const NAME_KEY = 'opendoc.name';

const status = document.querySelector('.od-status');
const banner = document.querySelector('.od-banner');

let editor;
let pane;
let me;
let sidecar;
let baseHash;
let dirty = false;
let saving = false;
let version = 0;
let saveTimer;
let pendingExternal = null;
let pendingSelection = null;

async function start() {
  let initial;
  try {
    initial = await api.state();
  } catch (error) {
    document.body.textContent = `Could not load the doc: ${error.message}`;
    return;
  }
  baseHash = initial.docHash;
  me = loadName(initial.defaultName);
  document.title = `${initial.doc} — opendoc`;
  document.querySelector('.od-doc-name').textContent = initial.doc;
  setupNameChip();

  editor = await createDocEditor(document.querySelector('.od-doc'), {
    markdown: initial.markdown,
    onChange: () => {
      dirty = true;
      version++;
      setStatus('Unsaved');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DELAY_MS);
    },
    onSelectThread: select,
    onCommentRequest: (selection) => {
      pendingSelection = selection;
      pane.startDraft(selection.quote);
    },
  });

  pane = createThreadPane(document.querySelector('.od-pane'), {
    onCreate: createThread,
    onCancelDraft: () => { pendingSelection = null; },
    onReply: (threadId, body) => sendOp({ type: 'addMessage', threadId, message: newMessage(body) }),
    onResolve: (threadId) => sendOp({ type: 'resolve', threadId, by: me }),
    onReopen: (threadId) => sendOp({ type: 'reopen', threadId }),
    onSelect: select,
  });
  applySidecar(initial.sidecar);
  setStatus('Saved');
  setInterval(() => pane.update(sidecar, me), 30_000); // relative times, stale "responding"

  const events = api.events();
  events.addEventListener('doc', (event) => onDocEvent(JSON.parse(event.data).docHash));
  events.addEventListener('sidecar', refreshThreads);
  events.addEventListener('error', () => setStatus('Reconnecting…'));
  events.addEventListener('hello', () => setStatus(dirty ? 'Unsaved' : 'Saved'));
}

// ---- saving and external changes ----

async function save() {
  if (saving || !dirty) return;
  saving = true;
  const savedVersion = version;
  setStatus('Saving…');
  try {
    const { status: code, data } = await api.saveDoc(editor.getMarkdown(), baseHash);
    if (code === 409) {
      showConflict(data);
      return;
    }
    baseHash = data.docHash;
    if (version === savedVersion) dirty = false;
    setStatus(dirty ? 'Unsaved' : 'Saved');
  } catch (error) {
    setStatus(`Save failed: ${error.message}`);
  } finally {
    saving = false;
  }
  if (dirty) saveTimer = setTimeout(save, SAVE_DELAY_MS);
  if (pendingExternal) {
    const hash = pendingExternal;
    pendingExternal = null;
    onDocEvent(hash);
  }
}

async function flushSave() {
  clearTimeout(saveTimer);
  while (dirty || saving) {
    if (!saving) await save();
    else await new Promise((resolve) => setTimeout(resolve, 50));
    if (!banner.hidden) throw new Error('resolve the conflict first');
  }
}

function onDocEvent(hash) {
  if (hash === baseHash) return; // our own save
  if (saving) {
    pendingExternal = hash;
    return;
  }
  if (dirty) showConflict();
  else reloadFromDisk();
}

async function reloadFromDisk() {
  const fresh = await api.state();
  editor.setMarkdown(fresh.markdown);
  baseHash = fresh.docHash;
  dirty = false;
  banner.hidden = true;
  applySidecar(fresh.sidecar);
  setStatus('Updated from disk');
}

function showConflict() {
  clearTimeout(saveTimer);
  setStatus('Conflict');
  banner.hidden = false;
}

banner.querySelector('[data-action="reload"]').addEventListener('click', reloadFromDisk);
banner.querySelector('[data-action="keep"]').addEventListener('click', async () => {
  const fresh = await api.state();
  baseHash = fresh.docHash; // overwrite what is on disk with this page's text
  banner.hidden = true;
  dirty = true;
  await save();
});

// ---- threads ----

async function refreshThreads() {
  try {
    applySidecar((await api.state()).sidecar);
  } catch {
    // the next event retries
  }
}

function applySidecar(next) {
  sidecar = next;
  editor.setThreads(sidecar.threads);
  pane.update(sidecar, me);
}

async function createThread(body) {
  await flushSave();
  let anchor = null;
  if (pendingSelection) {
    // Canonical anchor: re-find the selection in the core projection of the
    // markdown that is now on disk.
    const { text } = project(editor.getMarkdown());
    const hint = { exact: pendingSelection.quote, prefix: pendingSelection.prefix, suffix: pendingSelection.suffix, start: pendingSelection.start };
    const found = locate(text, hint);
    anchor = found ? createAnchor(text, found.start, found.end) : hint;
  }
  const id = newId('t');
  await sendOp({ type: 'addThread', id, anchor, message: newMessage(body) });
  pendingSelection = null;
  select(id);
}

async function sendOp(op) {
  try {
    applySidecar((await api.op(op)).sidecar);
  } catch (error) {
    setStatus(`Could not save comment: ${error.message}`);
    throw error;
  }
}

function newMessage(body) {
  return { id: newId('m'), author: { name: me, kind: 'human' }, body };
}

function select(id) {
  editor.setActive(id);
  pane.setActive(id);
}

// ---- identity ----

function loadName(fallback) {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved && NAME_PATTERN.test(saved)) return saved;
  } catch {
    // storage unavailable
  }
  return fallback;
}

function setupNameChip() {
  const chip = document.querySelector('.od-me');
  chip.textContent = me;
  chip.addEventListener('click', () => {
    const next = window.prompt('Your name in comments (letters, digits, . _ -)', me)?.trim();
    if (!next || !NAME_PATTERN.test(next)) return;
    me = next;
    chip.textContent = me;
    try {
      localStorage.setItem(NAME_KEY, me);
    } catch {
      // storage unavailable
    }
    pane.update(sidecar, me);
  });
}

function setStatus(text) {
  status.textContent = text;
}

start();
