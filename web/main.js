// The opendoc page: wires the editor, the comment margin, the agent's presence
// and the server together. Saves are debounced and conditional on the hash
// they were based on. Changes made on disk (usually by the agent) arrive as
// SSE events and are merged into the page like a collaborator's edits, the
// agent's typed in by its caret: only a change that overlaps what the human
// changed in the same paragraph asks them to choose.

import { api } from './api.js';
import { createDocEditor } from './editor.js';
import { avatar, createCommentMargin } from './threads.js';
import { createAgentPresence } from './agent.js';
import { createChrome } from './ui.js';
import { createSettings, forgetLegacySettings, legacySettings } from './settings.js';
import { icon } from './icons.js';
import { followLines, merge3 } from '../src/core/merge.js';
import { project } from '../src/core/project.js';
import { createAnchor, locate } from '../src/core/anchor.js';
import { applyProposal, diffEdits, revertEdits } from '../src/core/diff.js';
import { canApply, editItems, openProposal, previewItems } from './review.js';
import { activeWorking, newId } from '../src/core/ops.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const SAVE_DELAY_MS = 800;
const ON_DISK = 'Edited on disk'; // a change no collaborator is known to have made

const status = document.querySelector('.od-status');
const banner = document.querySelector('.od-banner');
const missingBanner = document.querySelector('.od-missing');
const resolvedToggle = document.querySelector('.od-show-resolved');

let editor;
let chrome;
let margin;
let presence;
let settings;
let defaultName;
let me;
let sidecar;
let baseHash;
let synced; // the doc as last loaded or saved, in the editor's own markdown style
let disk; // the doc's bytes on disk as last seen, which proposals are applied to
let activeId = null;
let reviewing = null; // id of the message whose change is shown in the text (clicked in its card)
let dirty = false;
let saving = false;
let version = 0;
let saveTimer;
let pendingExternal = null;
let pendingSelection = null;
// The agent's text the last merge left out for the human's, offered back on
// its comment once the human's is saved: { text: the merged markdown,
// items: [{ at, count, theirs }] } (lines of `text` and the agent's version).
let overwritten = null;
let missing = false; // the doc was moved or deleted on disk: nothing is saved

async function start() {
  let initial;
  try {
    initial = await api.state();
  } catch (error) {
    document.body.textContent = `Could not load the doc: ${error.message}`;
    return;
  }
  baseHash = initial.docHash;
  disk = initial.markdown;
  defaultName = initial.defaultName;
  settings = createSettings(initial.settings, {
    save: api.saveSettings,
    onError: (error) => setStatus(`Settings not saved: ${error.message}`, 'error'),
  });
  if (!initial.settingsSaved) adoptLegacySettings();
  me = settings.get().name ?? defaultName;
  settings.subscribe((next) => renameMe(next.name ?? defaultName)); // before the dialog's, which shows `me`
  showDocName(initial.doc);
  offerRename();
  paintNameChip();

  editor = await createDocEditor({
    stage: document.querySelector('.od-stage'),
    markdown: initial.markdown,
    onChange: () => {
      dirty = true;
      version++;
      setStatus('Saving…', 'saving');
      scheduleSave();
    },
    // Clicking commented text selects its thread but keeps the caret in the doc.
    onSelectThread: (id) => select(id, { focus: false }),
    onCommentRequest: (hint) => {
      chrome?.hideBubble();
      pendingSelection = hint;
      editor.setDraft(hint);
      margin.startDraft(hint);
    },
  });
  synced = editor.getMarkdown();
  chrome = createChrome({
    editor, onComment: () => editor.requestComment(), settings, getName: () => me, setName, agentSource: initial.agentSource,
  });
  window.opendocDesktop?.onCommand((name) => chrome.command(name));

  margin = createCommentMargin(document.querySelector('.od-margin'), {
    onCreate: createThread,
    onCancelDraft: () => {
      pendingSelection = null;
      editor.setDraft(null);
    },
    onReply: (threadId, body) => sendOp({ type: 'addMessage', threadId, message: newMessage(body) }),
    onResolve: (threadId) => sendOp({ type: 'resolve', threadId, by: me }),
    onReopen: (threadId) => sendOp({ type: 'reopen', threadId, by: me }),
    onUndo: undoEdit,
    onApply: applyProposalEdit,
    canApply: (message) => canApply(disk, message),
    onReview: review,
    reviewing: () => reviewing,
    onSelect: select,
    anchorTops: (items) => editor.anchorTops(items),
  });
  editor.onLayout(() => margin.layout());

  presence = createAgentPresence({
    root: document.querySelector('.od-agent'),
    panel: document.querySelector('.od-panel'),
    me: document.querySelector('.od-me'),
    getName: () => me,
    setPresence: (value) => settings.set({ agent: { presence: value } }),
    openSettings: (section) => chrome.command(section === 'agent' ? 'agent-settings' : 'settings'),
  });
  presence.render(initial.agent);
  chrome.agentStatus(initial.agent);
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
    showAgentCaret(presence.status(), next);
    presence.render(next);
    chrome.agentStatus(next);
  });
  events.addEventListener('settings', (event) => settings.receive(JSON.parse(event.data)));
  events.addEventListener('renamed', (event) => showDocName(JSON.parse(event.data).doc));
  events.addEventListener('error', () => setStatus('Reconnecting…', 'offline'));
  events.addEventListener('missing', (event) => setMissing(JSON.parse(event.data).missing));
  events.addEventListener('hello', (event) => {
    if (Boolean(JSON.parse(event.data).missing) !== missing) setMissing(!missing);
    else if (!missing) setStatus(dirty ? 'Saving…' : 'Saved', dirty ? 'saving' : 'saved');
  });
}

// ---- saving ----

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save() {
  if (saving || !dirty || !banner.hidden || missing) return;
  if (editor.replaying()) {
    // The text is between versions; the replay reports any typing when it ends.
    scheduleSave();
    return;
  }
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
      setDisk(data.markdown ?? disk);
      offerOverwritten(markdown);
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
  editor.finishReplay();
  while (dirty || saving) {
    if (!banner.hidden) throw new Error('resolve the conflict first');
    if (missing) throw new Error('the doc is missing from disk');
    if (!saving) await save();
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Leaving with an edit not saved yet: hold the page and save it. A browser
// asks before leaving; the desktop app retries closing until the save is in.
window.addEventListener('beforeunload', (event) => {
  editor?.finishReplay(); // what is on disk is the whole change: show it, then save any typing
  if (editor && !dirty && editor.getMarkdown() !== synced) {
    // Typing the editor has not reported yet (it does so on a debounce).
    dirty = true;
    version++;
  }
  if (!dirty && !saving) return;
  event.preventDefault();
  event.returnValue = true;
  flushSave().catch(() => {});
});

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
  // A replay still running is part of what is already on disk: complete it
  // so its partial text is not taken for the human's.
  editor.finishReplay();
  // Compare the live text, not `dirty`: the editor reports typing on a debounce.
  const mine = editor.getMarkdown();
  // Where the agent changed text the human is still typing in, the human's
  // stays and the agent's goes back to its comment as a proposal. Other
  // changes (another program, a collaborator the page does not know) still
  // ask the human to choose.
  const agent = presence.status();
  const fromAgent = Boolean(agent) && by === agent.name;
  const merged = merge3(synced, mine, theirs, fromAgent ? { prefer: 'ours' } : {});
  if (merged.conflict) {
    showConflict(by);
    return;
  }
  keepOverwritten(merged);
  // The agent's changes are typed in; anything else just appears.
  editor.applyMarkdown(merged.text, by, { animate: by !== ON_DISK });
  synced = theirs;
  baseHash = fresh.docHash;
  disk = fresh.markdown;
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

// Remember what a merge left out of the agent's change, following anything
// remembered from an earlier merge into this one's text.
function keepOverwritten(merged) {
  const items = [];
  if (overwritten) {
    for (const item of overwritten.items) {
      const range = followLines(overwritten.text, merged.text, item.at, item.count);
      if (range) items.push({ ...item, at: range.start, count: range.end - range.start });
    }
  }
  for (const d of merged.dropped ?? []) items.push({ at: d.at, count: d.count, theirs: d.theirs });
  overwritten = items.length > 0 ? { text: merged.text, items } : null;
}

// The human's text is saved: offer the agent's version of each region it was
// kept over, as it reads now (`saved`, the markdown just saved).
function offerOverwritten(saved) {
  if (!overwritten) return;
  const { text, items } = overwritten;
  overwritten = null;
  const lines = saved.split('\n');
  const trim = (s) => s.replace(/^\n+|\n+$/g, '');
  const changes = [];
  for (const item of items) {
    const range = followLines(text, saved, item.at, item.count);
    if (!range) continue;
    const before = trim(lines.slice(range.start, range.end).join('\n'));
    const after = trim(item.theirs);
    if (before && before !== after) changes.push({ before, after });
  }
  if (changes.length > 0) api.agentOverwritten(changes).catch(() => {});
}

// A run starting puts the agent's caret on the comment it is reading, as a
// collaborator would scroll there; when it stops, the caret stays and fades.
function showAgentCaret(before, after) {
  if (!after) {
    editor.agentLooking(null);
    return;
  }
  const running = after.state === 'running';
  if (running && before?.state !== 'running') {
    const ids = after.threadIds ?? [];
    const anchors = ids.map((id) => sidecar?.threads.find((t) => t.id === id)?.anchor).filter(Boolean);
    editor.agentLooking(after.name, anchors);
  } else if (!running && before?.state === 'running') {
    editor.agentResting();
  }
}

// Who most likely changed the file: the collaborator working on a comment.
function editorName(nextSidecar) {
  const agent = presence.status();
  if (agent?.state === 'running') return agent.name;
  const working = nextSidecar.threads.map((t) => activeWorking(t)).find(Boolean);
  return working?.by ?? ON_DISK;
}

function showConflict(by) {
  clearTimeout(saveTimer);
  setStatus('Needs your choice', 'conflict');
  banner.querySelector('.od-banner-text').textContent = by === ON_DISK
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
  disk = fresh.markdown;
  applySidecar(fresh.sidecar);
  setStatus('Saved');
});
// Keep the human's text where both changed it, and the other side's
// changes everywhere else.
banner.querySelector('[data-action="keep"]').addEventListener('click', async () => {
  const fresh = await api.state();
  const theirs = editor.normalize(fresh.markdown);
  const merged = merge3(synced, editor.getMarkdown(), theirs, { prefer: 'ours' });
  editor.applyMarkdown(merged.text, editorName(fresh.sidecar));
  baseHash = fresh.docHash;
  synced = theirs;
  disk = fresh.markdown;
  applySidecar(fresh.sidecar);
  banner.hidden = true;
  dirty = true;
  version++;
  await save();
});

// ---- the doc moved or deleted outside the app ----

// Saving stops (a save would recreate the file where the user removed it);
// the page keeps its text and offers to write it back. If the doc comes back
// on its own (an undo in Explorer, a git checkout), saving resumes and any
// difference arrives as a normal change from disk.
function setMissing(on) {
  missing = on;
  missingBanner.hidden = !on;
  if (on) {
    clearTimeout(saveTimer);
    const name = document.querySelector('.od-doc-name').textContent;
    missingBanner.querySelector('.od-banner-text').textContent = `${name} was moved or deleted outside OpenDoc. Changes here are not being saved.`;
    setStatus('Not saved: the doc is missing', 'error');
    return;
  }
  setStatus(dirty ? 'Saving…' : 'Saved', dirty ? 'saving' : 'saved');
  if (dirty) scheduleSave();
}

missingBanner.querySelector('[data-action="recreate"]').addEventListener('click', async () => {
  const savedVersion = version;
  const markdown = editor.getMarkdown();
  try {
    const { status: code, data } = await api.saveDoc(markdown, baseHash, { recreate: true });
    if (code === 409) {
      setMissing(false); // it is back already: merge what is there
      await syncFromDisk();
      return;
    }
    baseHash = data.docHash;
    synced = markdown;
    setDisk(data.markdown ?? markdown);
    if (version === savedVersion) dirty = false;
    setMissing(false);
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, 'error');
  }
});

// ---- threads ----

async function refreshThreads() {
  try {
    const fresh = await api.state();
    disk = fresh.markdown;
    applySidecar(fresh.sidecar);
  } catch {
    // the next event retries
  }
}

function applySidecar(next) {
  sidecar = next;
  editor.setThreads(sidecar.threads);
  margin.update(sidecar, me);
  refreshPreview();
}

// Whether a proposal can still be applied depends on the text on disk.
function setDisk(markdown) {
  if (markdown === disk) return;
  disk = markdown;
  if (sidecar?.threads.some((t) => t.messages.some((m) => m.proposal))) {
    margin.rerender();
    refreshPreview();
  }
}

// ---- proposals ----

// While a thread is selected, its open proposal shows in the text as a suggestion.
// While a thread is selected, the text shows the change clicked in its card,
// or else its open proposal, as a suggestion.
function refreshPreview({ replay = false } = {}) {
  const thread = sidecar?.threads.find((t) => t.id === activeId);
  const clicked = thread?.messages.find((m) => m.id === reviewing);
  if (reviewing && !clicked) reviewing = null;
  const proposal = clicked ?? (thread?.status === 'open' ? openProposal(thread) : null);
  const items = !proposal ? []
    : proposal.proposal && !proposal.applies ? previewItems(disk, proposal.proposal)
    : editItems(disk, proposal.edits ?? []);
  editor.setPreview(items, { replay });
}

// Clicking a change in a card plays it in the text; clicking it again hides it.
function review(threadId, message) {
  const again = reviewing === message.id;
  if (activeId !== threadId) select(threadId, { focus: false });
  reviewing = again ? null : message.id;
  margin.rerender();
  refreshPreview({ replay: !again });
}

// Apply what a reply proposed (SPEC.md §2.6): only while its original text is
// still there, saved like any edit, then post an apply notice carrying the
// edits so it can be undone. The thread stays open for the human to resolve.
async function applyProposalEdit(threadId, message) {
  await flushSave();
  let fresh = await api.state();
  if (fresh.docHash !== baseHash) {
    await syncFromDisk();
    await flushSave();
    fresh = await api.state();
  }
  const next = applyProposal(fresh.markdown, message.proposal);
  if (next === null) throw new Error('Cannot apply: the original text has changed since.');
  // Played in as if the agent typed it, then saved.
  editor.applyMarkdown(next, message.author.name, { animate: true });
  await editor.replayDone();
  dirty = true;
  version++;
  await flushSave();
  const edits = diffEdits(fresh.markdown, disk).map((change) => change.edit);
  if (edits.length === 0) throw new Error('Applying the proposal changed nothing.');
  const body = `Applied ${message.author.name}'s proposal`;
  await sendOp({ type: 'addMessage', threadId, message: { ...newMessage(body), applies: message.id, edits } });
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

function select(id, { focus = true } = {}) {
  if (id !== activeId) reviewing = null;
  if (id) editor.clearReview(); // the human is looking at the comments now
  activeId = id;
  editor.setActive(id);
  margin.setActive(id, { focus });
  refreshPreview();
}

// ---- identity ----

// Before settings had a file, this browser kept them for one port only;
// carry them over the first time, then forget them.
function adoptLegacySettings() {
  const patch = legacySettings();
  if (Object.keys(patch).length > 0) settings.set(patch);
  forgetLegacySettings();
}

function showDocName(name) {
  document.title = `${name} — opendoc`;
  document.querySelector('.od-doc-name').textContent = name;
}

// In the desktop app, clicking the doc name renames the doc (File > Rename).
function offerRename() {
  const desktop = window.opendocDesktop;
  if (!desktop) return;
  const name = document.querySelector('.od-doc-name');
  Object.assign(name, { tabIndex: 0, title: 'Rename' });
  name.setAttribute('role', 'button');
  name.classList.add('od-renamable');
  const rename = () => desktop.rename().catch(() => {});
  name.addEventListener('click', rename);
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      rename();
    }
  });
}

function paintNameChip() {
  document.querySelector('.od-me').replaceChildren(avatar(me, 'human'));
}

/** Rename the human in comments, in every doc; false when the name is not allowed. */
function setName(next) {
  if (!NAME_PATTERN.test(next)) return false;
  if (next !== me) settings.set({ name: next });
  return true;
}

function renameMe(next) {
  if (next === me) return;
  me = next;
  paintNameChip();
  margin?.update(sidecar, me);
  presence?.renameMe();
}

// Saving is automatic and local, so the header says nothing while it works;
// it speaks up only when a save fails, the server is unreachable or a
// conflict needs a choice.
function setStatus(text, state = 'saved') {
  const problem = state === 'error' || state === 'offline' || state === 'conflict';
  status.hidden = !problem;
  status.dataset.state = state;
  status.querySelector('.od-status-text').textContent = problem ? text : '';
  status.querySelector('.od-status-icon').replaceChildren(...(problem ? [icon('alert')] : []));
  status.title = problem ? text : '';
}

start();
