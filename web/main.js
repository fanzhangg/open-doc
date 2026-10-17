// The opendoc page: wires the editor, the comment margin, the people (the
// doc's buddies and you) and the doc in the doc host together. Saves are
// debounced and conditional on the hash they were based on. Changes made on
// disk (a buddy's merged edit, another program) arrive as events and are merged
// into the page like a collaborator's edits, a buddy's typed in by its
// caret. Where one overlaps what the human is typing, the human's text
// stays: no one is asked to choose.

import { api } from './api.js';
import { createDocEditor } from './editor.js';
import { avatar, createCommentMargin, namecardFor } from './threads.js';
import { createPeople } from './agent.js';
import { setBuddies } from './faces.js';
import { createNameCards } from './namecard.js';
import { createChrome } from './ui.js';
import { createSettings } from './settings.js';
import { icon } from './icons.js';
import { merge3 } from '../src/core/merge.js';
import { project } from '../src/core/project.js';
import { createAnchor, locate } from '../src/core/anchor.js';
import { createHistory } from './history.js';
import { createFileList } from './files.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const SAVE_DELAY_MS = 800;
const ON_DISK = 'Edited on disk'; // a change no collaborator is known to have made
// Changes from disk and comment updates wait for a pause in typing this long,
// but never longer than WAIT_FOR_PAUSE_MS: taking them in while keys arrive
// would stall the keys.
const TYPING_PAUSE_MS = 600;
const WAIT_FOR_PAUSE_MS = 3000;
const COMMENTS_KEY = 'opendoc.comments'; // 'hidden' while the human keeps comments out of view

const status = document.querySelector('.od-status');
const missingBanner = document.querySelector('.od-missing');
const noticeBanner = document.querySelector('.od-notice');
const resolvedToggle = document.querySelector('.od-show-resolved');
const commentsToggle = document.querySelector('.od-tool-comment');
// In a narrow window the comments rise from the bottom over the page: closed
// until the Comments button or commented text opens them. The highlights stay.
const narrow = window.matchMedia('(max-width: 900px)');

let editor;
let chrome;
let margin;
let people;
let history;
let settings;
let defaultName;
let inProject = false; // the doc was opened from a project folder
let me; // your name
let myId; // your id, which your comments carry
let comments; // the doc's threads, who wrote in them, and a notice about its sidecar (state())
let baseHash;
let synced; // the doc as last loaded or saved, in the editor's own markdown style
let dirty = false;
let saving = false;
let version = 0;
let saveTimer;
let pendingExternal = null;
let pendingSelection = null;
let typedAt = -Infinity; // when the human last typed in the doc
let shownAgents = ''; // the agent statuses on screen, as JSON
let shownComments = ''; // the comments on screen, as JSON
let missing = false; // the doc was moved or deleted on disk: nothing is saved
let files; // the folder sidebar (desktop folder windows)
let startTyping = false; // the doc was just made in the sidebar: the cursor starts in it

// The desktop app swaps one doc's page for another without a blank frame: it
// shows this page once `opendocReady` resolves (the doc and the sidebar are
// drawn), and before replacing it, or closing its window, asks it to let go
// of its doc (`opendocLeave`): save the last edit, stop taking input, and say
// how it was left, for the next page. `opendocStay` undoes that when the
// switch fails.
let markReady;
window.opendocReady = new Promise((resolve) => { markReady = resolve; });
window.opendocLeave = async () => {
  if (editor) {
    takeUnreportedTyping();
    await flushSave();
  }
  document.body.inert = true;
  return { ...files?.state(), commentsHidden: !commentsShown() };
};
window.opendocStay = () => {
  document.body.inert = false;
};

async function start() {
  let initial;
  try {
    initial = await api.state();
  } catch (error) {
    document.body.textContent = `Could not load the doc: ${error.message}`;
    return;
  }
  baseHash = initial.docHash;
  defaultName = initial.defaultName;
  myId = initial.me.id;
  inProject = initial.project;
  settings = createSettings(initial.settings, {
    save: api.saveSettings,
    onError: (error) => setStatus(`Settings not saved: ${error.message}`, 'error'),
  });
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
    onSelectThread: (id) => {
      if (narrow.matches) {
        openSheet(true);
        select(id, { focus: false });
        revealText(id);
      } else if (commentsShown()) select(id, { focus: false });
    },
    onCommentRequest: (hint) => {
      chrome?.hideBubble();
      if (narrow.matches) openSheet(true);
      else if (!commentsShown()) showComments(true);
      pendingSelection = hint;
      editor.setDraft(hint);
      margin.startDraft(hint);
    },
  });
  synced = editor.getMarkdown();
  chrome = createChrome({
    editor, onComment: () => editor.requestComment(), settings, getName: () => me, setName, onAgentResult: takeAgentResult,
    buddies: () => people?.statuses() ?? [], project: () => inProject,
  });
  window.opendocDesktop?.onCommand((name) => chrome.command(name));
  files = createFileList({
    onError: (message) => setStatus(message, 'error'),
    onCarry: (carry) => {
      if (carry.commentsHidden) showComments(false);
      if (carry.startTyping) startTyping = true;
    },
  });

  margin = createCommentMargin(document.querySelector('.od-margin'), {
    onCreate: createThread,
    onCancelDraft: () => {
      pendingSelection = null;
      editor.setDraft(null);
    },
    onReply: (thread, body) => send(api.reply(thread, body)),
    onResolve: (thread) => send(api.resolve(thread)),
    onReopen: (thread) => send(api.reopen(thread)),
    onDelete: (id) => send(api.deleteComment(id)),
    onUndo: undoReply,
    onLight: (hash) => editor.lightEdits(hash),
    onSelect: (id) => {
      select(id);
      if (narrow.matches) revealText(id);
    },
    anchorTops: (items) => editor.anchorTops(items),
    mentionChoices: (query) => people?.mentionChoices(query) ?? [],
    mentionable: () => people?.mentionable() ?? [],
  });
  editor.onLayout(() => margin.layout());

  people = createPeople({
    root: document.querySelector('.od-agents'),
    invite: document.querySelector('.od-invite'),
    panel: document.querySelector('.od-panel'),
    me: document.querySelector('.od-me'),
    getName: () => me,
    getId: () => settings.get().id,
    setName,
    openSettings: (section, name) => (section === 'agents' ? chrome.openAgent(name) : chrome.command('settings')),
    newAgent: () => chrome.newAgent(),
    project: () => inProject,
  });
  const who = (chip) => [chip.dataset.mention, chip.dataset.mentionKind, chip];
  createNameCards({
    card: document.querySelector('.od-panel'),
    peek: (chip) => people.peek(...who(chip)),
    pin: (chip) => people.pin(...who(chip)),
    unpeek: () => people.unpeek(),
  });
  setBuddies(initial.agents.map((a) => a.name));
  people.render({ agents: initial.agents });
  chrome.refreshAgents();
  margin.setAgents(initial.agents);
  shownAgents = JSON.stringify(initial.agents);
  applyComments(initial);
  setStatus('Saved');
  setInterval(() => margin.rerender(), 30_000); // relative times, stale "working"

  let hidden = false;
  try {
    hidden = localStorage.getItem(COMMENTS_KEY) === 'hidden';
  } catch {
    // no storage: comments start shown
  }
  if (hidden) showComments(false);
  paintCommentsToggle();
  commentsToggle.addEventListener('click', () => {
    if (narrow.matches) openSheet(!sheetOpen());
    else showComments(!commentsShown());
  });
  resolvedToggle.addEventListener('click', () => {
    const on = resolvedToggle.getAttribute('aria-pressed') !== 'true';
    resolvedToggle.setAttribute('aria-pressed', String(on));
    if (on && narrow.matches) openSheet(true);
    else if (on && !commentsShown()) showComments(true);
    margin.setShowResolved(on);
  });
  narrow.addEventListener('change', () => {
    openSheet(false);
    paintCommentsToggle();
  });
  // Escape or a click outside closes the sheet; a click on commented text picks another thread.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !sheetOpen()) return;
    openSheet(false);
    commentsToggle.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!sheetOpen() || event.target.closest('.od-margin, .od-tool-comment, .od-show-resolved, [data-thread], .od-bubble')) return;
    openSheet(false);
  });
  history = createHistory({
    api,
    commentOf: (id) => comments?.threads.find((t) => t.id === id)?.comments[0]?.body ?? null,
    onRestore: restoreVersion,
    onClose: () => editor.focus(),
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && event.code === 'KeyH') {
      event.preventDefault();
      history.toggle();
    } else if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyM' && !history.isOpen()) {
      event.preventDefault();
      editor.requestComment();
    }
  });
  // Clicking empty page space deselects the active comment, as in Docs.
  document.querySelector('.od-canvas').addEventListener('mousedown', (event) => {
    if (!event.target.closest('.od-card, [data-thread], .od-bubble')) select(null);
  });

  document.querySelector('.od-editor').addEventListener('beforeinput', () => { typedAt = performance.now(); }, true);
  const events = api.events();
  events.on('doc', (data) => onDocEvent(data.docHash));
  events.on('sidecar', () => afterTyping('sidecar', refreshThreads));
  events.on('history', () => history.changed());
  events.on('agents', (data) => showAgents(data));
  events.on('settings', (data) => settings.receive(data));
  events.on('renamed', (data) => showDocName(data.doc));
  events.on('missing', (data) => setMissing(data.missing));
  // First on the line: the doc may have gone missing, or runs started, since `state`.
  events.on('hello', (data) => {
    if (Boolean(data.missing) !== missing) setMissing(!missing);
    showAgents(data.agents);
  });
  await files.ready;
  if (startTyping) editor.focus();
}

// ---- saving ----

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

async function save() {
  if (saving || !dirty || missing) return;
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
    if (missing) throw new Error('the doc is missing from disk');
    if (!saving) await save();
    else await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Leaving with an edit not saved yet: hold the page and save it. A browser
// asks before leaving; the desktop app retries closing until the save is in.
window.addEventListener('beforeunload', (event) => {
  takeUnreportedTyping();
  if (!dirty && !saving) return;
  event.preventDefault();
  event.returnValue = true;
  flushSave().catch(() => {});
});

// Typing the editor has not reported yet (it does so on a debounce) is an
// edit to save too.
function takeUnreportedTyping() {
  if (editor && !dirty && editor.getMarkdown() !== synced) {
    dirty = true;
    version++;
  }
}

// ---- changes from disk ----

function onDocEvent(hash) {
  if (hash === baseHash) return; // our own save
  if (saving) {
    pendingExternal = hash;
    return;
  }
  afterTyping('doc', syncFromDisk);
}

// Run `fn` once the human pauses typing (or WAIT_FOR_PAUSE_MS after it was
// first asked for); asking again for the same `key` meanwhile runs it once.
const waiting = new Map(); // key → { since, timer }
function afterTyping(key, fn) {
  const now = performance.now();
  const entry = waiting.get(key) ?? { since: now, timer: 0 };
  waiting.set(key, entry);
  clearTimeout(entry.timer);
  const pause = TYPING_PAUSE_MS - (now - typedAt);
  const left = WAIT_FOR_PAUSE_MS - (now - entry.since);
  if (pause <= 0 || left <= 0) {
    waiting.delete(key);
    fn();
    return;
  }
  entry.timer = setTimeout(() => afterTyping(key, fn), Math.min(pause, left));
}

let syncing = null;
function syncFromDisk() {
  syncing ??= doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const fresh = await api.state();
  if (fresh.docHash === baseHash) return;
  // A buddy's run wrote this doc when its version is the doc on disk.
  const run = Object.values(fresh.edits ?? {}).find((e) => e.hash === fresh.docHash && e.state === 'edited');
  const theirs = editor.normalize(fresh.markdown);
  // Compare the live text, not `dirty`: the editor reports typing on a debounce.
  // Where the change overlaps what the human typed since, the human's stays.
  const merged = merge3(synced, editor.getMarkdown(), theirs, { prefer: 'ours' });
  // A buddy's changes are marked in its colour; anything else glows.
  editor.applyMarkdown(merged.text, run?.by ?? ON_DISK, { buddy: Boolean(run), tag: run?.hash });
  synced = theirs;
  baseHash = fresh.docHash;
  applyComments(fresh);
  if (merged.text === theirs) {
    dirty = false;
    setStatus('Saved');
  } else {
    dirty = true;
    version++;
    scheduleSave();
  }
}

// The doc's agents changed (a status, or who is here).
function showAgents(next) {
  // The server repeats statuses (each connection starts with them); redrawing
  // the faces and panels for the same ones is wasted work.
  const json = JSON.stringify(next);
  if (json === shownAgents) return;
  shownAgents = json;
  setBuddies(next.map((a) => a.name));
  people.render({ agents: next });
  chrome.refreshAgents();
  margin.setAgents(next);
}

// What a request about buddies answers with.
function takeAgentResult(result) {
  if (result.agents) showAgents(result.agents);
}

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
    if (version === savedVersion) dirty = false;
    setMissing(false);
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, 'error');
  }
});

// ---- threads ----

// One refresh at a time; events during one bring one more after it.
let refreshing = null;
let refreshAgain = false;
async function refreshThreads() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      try {
        applyComments(await api.state());
      } catch {
        // the next event retries
      }
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Show the doc's comments (from state() or a comment request). Redrawing
// every card for the same ones would stall typing.
function applyComments({ threads, people: writers, edits, notice }) {
  const json = JSON.stringify({ threads, writers, edits, notice });
  if (json === shownComments) return;
  shownComments = json;
  comments = { threads, people: writers, edits, notice };
  editor.setThreads(threads);
  margin.update(threads, { id: myId, name: me }, edits);
  people?.render({ people: writers });
  noticeBanner.hidden = !notice;
  noticeBanner.querySelector('.od-banner-text').textContent = notice ?? '';
  const open = threads.filter((t) => !t.resolved).length;
  commentsToggle.querySelector('.od-comment-count').textContent = open > 0 ? String(open) : '';
}

// The Comments button shows or hides the margin and the highlights in the
// text; with them hidden the page sits in the middle of the window.
function commentsShown() {
  return !document.documentElement.hasAttribute('data-hide-comments');
}

function showComments(on) {
  if (!on) select(null);
  document.documentElement.toggleAttribute('data-hide-comments', !on);
  paintCommentsToggle();
  try {
    localStorage.setItem(COMMENTS_KEY, on ? 'shown' : 'hidden');
  } catch {
    // not remembered: fine
  }
  if (on) margin.rerender();
}

function sheetOpen() {
  return document.documentElement.hasAttribute('data-comments-open');
}

function openSheet(on) {
  if (on === sheetOpen()) return;
  if (!on) select(null);
  document.documentElement.toggleAttribute('data-comments-open', on);
  paintCommentsToggle();
  if (on) margin.rerender();
}

function paintCommentsToggle() {
  const on = narrow.matches ? sheetOpen() : commentsShown();
  commentsToggle.setAttribute('aria-pressed', String(on));
  commentsToggle.dataset.tip = on ? 'Hide comments' : 'Show comments';
}

// Bring a thread's text into view above the sheet.
function revealText(id) {
  document.querySelector(`.od-page [data-thread="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function createThread(body) {
  await flushSave();
  // Canonical anchor: re-find the selection in the core projection of the
  // markdown that is now on disk.
  const { text } = project(editor.getMarkdown());
  const hint = { exact: pendingSelection.quote, prefix: pendingSelection.prefix, suffix: pendingSelection.suffix, start: pendingSelection.start };
  const found = locate(text, hint);
  const anchor = found ? createAnchor(text, found.start, found.end) : hint;
  const { id } = await send(api.comment(anchor, body));
  pendingSelection = null;
  editor.setDraft(null);
  select(id);
}

// A comment request: its answer shows the comments as they are now.
async function send(request) {
  try {
    const result = await request;
    applyComments(result);
    return result;
  } catch (error) {
    setStatus(`Could not save the comment: ${error.message}`, 'error');
    throw error;
  }
}

// Undo a buddy's edit. What you typed is saved first; the doc host merges
// the undo into it, and the page takes the result as any change on disk.
async function undoReply(id) {
  await flushSave();
  try {
    applyComments(await api.undoReply(id));
  } catch (error) {
    setStatus(`Could not undo: ${error.message}`, 'error');
    throw error;
  }
  await syncFromDisk();
}

// Put the doc back the way it was in an earlier version (web/history.js). The
// server writes that version's exact bytes; the page then shows them,
// holding back the change event of the restore itself as it does for a save.
async function restoreVersion(id) {
  await flushSave();
  if ((await api.state()).docHash !== baseHash) {
    await syncFromDisk();
    await flushSave();
  }
  saving = true;
  let result;
  try {
    result = await api.restoreVersion(id, baseHash);
  } finally {
    saving = false;
  }
  if (result.status === 409) {
    await syncFromDisk();
    throw new Error('the doc changed just now. Try again.');
  }
  const { markdown, docHash } = result.data;
  editor.applyMarkdown(markdown, 'Restore');
  synced = editor.normalize(markdown);
  baseHash = docHash;
  dirty = false;
  setStatus('Saved');
  if (pendingExternal) {
    const hash = pendingExternal;
    pendingExternal = null;
    onDocEvent(hash);
  }
}

function select(id, { focus = true } = {}) {
  editor.setActive(id);
  margin.setActive(id, { focus });
}

// ---- identity ----

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
  const button = document.querySelector('.od-me');
  button.replaceChildren(avatar(me, 'human'));
  namecardFor(button, me, 'human', 'instant');
  button.setAttribute('aria-label', `You (${me})`);
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
  if (comments) margin?.update(comments.threads, { id: myId, name: me }, comments.edits);
  people?.renameMe();
}

// Saving is automatic and local, so the header says nothing while it works;
// it speaks up only when something fails.
function setStatus(text, state = 'saved') {
  const problem = state === 'error';
  status.hidden = !problem;
  status.dataset.state = state;
  status.querySelector('.od-status-text').textContent = problem ? text : '';
  status.querySelector('.od-status-icon').replaceChildren(...(problem ? [icon('alert')] : []));
  status.title = problem ? text : '';
}

// Ready once drawn: two frames after the page is built. A hidden page (a new
// window, shown only once ready) draws no frames, so it is ready once built.
start().finally(() => (document.hidden ? markReady() : requestAnimationFrame(() => requestAnimationFrame(markReady))));
