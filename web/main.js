// The opendoc page: wires the editor, the comment margin, the agent's presence
// and the server together. Saves are debounced and conditional on the hash
// they were based on. Changes made on disk (usually by the agent) arrive as
// SSE events and are merged into the page like a collaborator's edits: only
// a change to the same paragraph the human changed asks them to choose.

import { api } from './api.js';
import { createDocEditor } from './editor.js';
import { avatar, createCommentMargin } from './threads.js';
import { createAgentPresence } from './agent.js';
import { createChrome } from './ui.js';
import { icon } from './icons.js';
import { merge3 } from './merge.js';
import { project } from '../src/core/project.js';
import { createAnchor, locate } from '../src/core/anchor.js';
import { revertEdits } from '../src/core/diff.js';
import { activeWorking, newId } from '../src/core/ops.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const SAVE_DELAY_MS = 800;
const NAME_KEY = 'opendoc.name';

const status = document.querySelector('.od-status');
const STATUS_ICONS = { saved: 'check', saving: null, error: 'alert', offline: 'alert', conflict: 'alert' };
const banner = document.querySelector('.od-banner');
const resolvedToggle = document.querySelector('.od-show-resolved');

let editor;
let chrome;
let margin;
let presence;
let me;
let sidecar;
let baseHash;
let synced; // the doc as last loaded or saved, in the editor's own markdown style
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

  editor = await createDocEditor({
    stage: document.querySelector('.od-stage'),
    markdown: initial.markdown,
    onChange: () => {
      dirty = true;
      version++;
      setStatus('Saving…', 'saving');
      scheduleSave();
    },
    onSelectThread: select,
    onCommentRequest: (hint) => {
      chrome?.hideBubble();
      pendingSelection = hint;
      editor.setDraft(hint);
      margin.startDraft(hint);
    },
  });
  synced = editor.getMarkdown();
  chrome = createChrome({ editor, onComment: () => editor.requestComment() });

  margin = createCommentMargin(document.querySelector('.od-margin'), {
    onCreate: createThread,
    onCancelDraft: () => {
      pendingSelection = null;
      editor.setDraft(null);
    },
    onReply: (threadId, body) => sendOp({ type: 'addMessage', threadId, message: newMessage(body) }),
    onResolve: (threadId) => sendOp({ type: 'resolve', threadId, by: me }),
    onReopen: (threadId) => sendOp({ type: 'reopen', threadId }),
    onUndo: undoEdit,
    onSelect: select,
    anchorTops: (items) => editor.anchorTops(items),
  });
  editor.onLayout(() => margin.layout());

  presence = createAgentPresence(document.querySelector('.od-agent'), document.querySelector('.od-panel'));
  presence.render(initial.agent);
  margin.setAgent(initial.agent);
  applySidecar(initial.sidecar);
  setStatus('Saved');
  setInterval(() => margin.rerender(), 30_000); // relative times, stale "working"

  resolvedToggle.addEventListener('click', () => {
    const on = resolvedToggle.getAttribute('aria-pressed') !== 'true';
    resolvedToggle.setAttribute('aria-pressed', String(on));
    margin.setShowResolved(on);
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyM') {
      event.preventDefault();
      editor.requestComment();
    }
  });
  // Clicking empty page space deselects the active comment, as in Docs.
  document.querySelector('.od-canvas').addEventListener('mousedown', (event) => {
    if (!event.target.closest('.od-card, [data-thread], .od-bubble')) select(null);
  });

  const events = api.events();
  events.addEventListener('doc', (event) => onDocEvent(JSON.parse(event.data).docHash));
  events.addEventListener('sidecar', refreshThreads);
  events.addEventListener('agent', (event) => {
    const next = JSON.parse(event.data);
    presence.render(next);
    margin.setAgent(next);
  });
  events.addEventListener('error', () => setStatus('Reconnecting…', 'offline'));
  events.addEventListener('hello', () => (dirty ? setStatus('Saving…', 'saving') : setStatus('Saved')));
}

// ---- saving ----

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save() {
  if (saving || !dirty || !banner.hidden) return;
  saving = true;
  const savedVersion = version;
  const markdown = editor.getMarkdown();
  let conflicted = false;
  setStatus('Saving…', 'saving');
  try {
    const { status: code, data } = await api.saveDoc(markdown, baseHash);
    if (code === 409) {
      conflicted = true;
    } else {
      baseHash = data.docHash;
      synced = markdown;
      if (version === savedVersion) dirty = false;
      if (dirty) setStatus('Saving…', 'saving');
      else setStatus('Saved');
    }
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, 'error');
  } finally {
    saving = false;
  }
  if (conflicted) {
    await syncFromDisk(); // the file changed under us: merge it in, then save again
    return;
  }
  if (dirty) scheduleSave();
  if (pendingExternal) {
    const hash = pendingExternal;
    pendingExternal = null;
    onDocEvent(hash);
  }
}

async function flushSave() {
  clearTimeout(saveTimer);
  while (dirty || saving) {
    if (!banner.hidden) throw new Error('resolve the conflict first');
    if (!saving) await save();
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---- changes from disk ----

function onDocEvent(hash) {
  if (hash === baseHash) return; // our own save
  if (saving) {
    pendingExternal = hash;
    return;
  }
  syncFromDisk();
}

let syncing = null;
function syncFromDisk() {
  syncing ??= doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const fresh = await api.state();
  if (fresh.docHash === baseHash) return;
  const by = editorName(fresh.sidecar);
  const theirs = editor.normalize(fresh.markdown);
  // Compare the live text, not `dirty`: the editor reports typing on a debounce.
  const mine = editor.getMarkdown();
  const merged = merge3(synced, mine, theirs);
  if (merged.conflict) {
    showConflict(by);
    return;
  }
  editor.applyMarkdown(merged.text, by);
  synced = theirs;
  baseHash = fresh.docHash;
  applySidecar(fresh.sidecar);
  if (merged.text === theirs) {
    dirty = false;
    setStatus('Saved');
  } else {
    dirty = true;
    version++;
    scheduleSave();
  }
}

// Who most likely changed the file: the collaborator working on a comment.
function editorName(nextSidecar) {
  const agent = presence.status();
  if (agent?.state === 'running') return agent.name;
  const working = nextSidecar.threads.map((t) => activeWorking(t)).find(Boolean);
  return working?.by ?? 'Edited on disk';
}

function showConflict(by) {
  clearTimeout(saveTimer);
  setStatus('Needs your choice', 'conflict');
  banner.querySelector('.od-banner-text').textContent = by === 'Edited on disk'
    ? 'The file changed on disk in a paragraph you are editing.'
    : `${by} edited a paragraph you are editing.`;
  banner.hidden = false;
}

banner.querySelector('[data-action="reload"]').addEventListener('click', async () => {
  const fresh = await api.state();
  banner.hidden = true;
  dirty = false;
  editor.applyMarkdown(fresh.markdown, editorName(fresh.sidecar));
  synced = editor.normalize(fresh.markdown);
  baseHash = fresh.docHash;
  applySidecar(fresh.sidecar);
  setStatus('Saved');
});
banner.querySelector('[data-action="keep"]').addEventListener('click', async () => {
  const fresh = await api.state();
  baseHash = fresh.docHash; // overwrite what is on disk with this page's text
  synced = editor.normalize(fresh.markdown);
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
  margin.update(sidecar, me);
  chrome.setResolvedCount(margin.resolvedCount());
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
  editor.setDraft(null);
  select(id);
}

async function sendOp(op) {
  try {
    applySidecar((await api.op(op)).sidecar);
  } catch (error) {
    setStatus(`Could not save comment: ${error.message}`, 'error');
    throw error;
  }
}

// Revert what an agent reply changed in the doc (SPEC.md §2.5): only while its
// text is still there, saved like any edit, then reopen the thread with a
// notice that does not ask the agent to try again.
async function undoEdit(threadId, message) {
  await flushSave();
  let fresh = await api.state();
  if (fresh.docHash !== baseHash) {
    await syncFromDisk();
    await flushSave();
    fresh = await api.state();
  }
  const reverted = revertEdits(fresh.markdown, message.edits);
  if (reverted === null) throw new Error('Cannot undo: that text has changed since.');
  editor.applyMarkdown(reverted, 'Undo');
  dirty = true;
  version++;
  await flushSave();
  const body = `Undid ${message.author.name}'s edit`;
  await sendOp({ type: 'addMessage', threadId, message: { ...newMessage(body), undoes: message.id } });
}

function newMessage(body) {
  return { id: newId('m'), author: { name: me, kind: 'human' }, body };
}

function select(id) {
  editor.setActive(id);
  margin.setActive(id);
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
  const paint = () => chip.replaceChildren(avatar(me, 'human'));
  paint();
  chip.addEventListener('click', () => {
    const next = window.prompt('Your name in comments (letters, digits, . _ -)', me)?.trim();
    if (!next || !NAME_PATTERN.test(next)) return;
    me = next;
    paint();
    try {
      localStorage.setItem(NAME_KEY, me);
    } catch {
      // storage unavailable
    }
    margin.update(sidecar, me);
  });
}

// Save state beside the title: an icon plus text; "Saved" fades to just the
// icon after a moment, problems stay until they are fixed.
let quietTimer;
function setStatus(text, state = 'saved') {
  status.dataset.state = state;
  status.querySelector('.od-status-text').textContent = text;
  const glyph = STATUS_ICONS[state];
  status.querySelector('.od-status-icon').replaceChildren(...(glyph ? [icon(glyph)] : []));
  status.title = text;
  status.classList.remove('od-status-quiet');
  clearTimeout(quietTimer);
  if (state === 'saved') quietTimer = setTimeout(() => status.classList.add('od-status-quiet'), 2500);
}

start();
