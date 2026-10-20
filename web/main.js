// The opendoc page: wires the editor, the comment margin, the people (the
// doc's buddies and you) and the doc in the doc host together. Saves are
// debounced and conditional on the hash they were based on. Changes made on
// disk (a buddy's merged edit, another program) arrive as events and are merged
// into the page like a collaborator's edits, a buddy's typed in by its
// caret. Where one overlaps what the human is typing, the human's text
// stays: no one is asked to choose.

import { api } from './api.js';
import { markdown } from './views/markdown/index.js';
import { viewFor } from './views/index.js';
import { avatar, createCommentMargin, namecardFor } from './threads.js';
import { createPeople, modeOf } from './agent.js';
import { setBuddies } from './faces.js';
import { createNameCards } from './namecard.js';
import { createChrome } from './ui.js';
import { createSettings } from './settings.js';
import { icon } from './icons.js';
import { viewSettings } from '../src/core/settings.js';
import { createAnchor, locate } from '../src/core/anchor.js';
import { merge3 } from '../src/core/merge.js';
import { rulesOf } from '../src/rules/index.js';
import { diffEdits, findEdit } from '../src/core/diff.js';
import { createHistory } from './history.js';
import { revisionMarks } from './marks.js';
import { createFileList } from './files.js';
import { NAME_PATTERN } from '../src/core/mentions.js';
import { FORMAT_VERSION } from '../src/core/comments.js';

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
const readOnlyBanner = document.querySelector('.od-read-only');
const noticeBanner = document.querySelector('.od-notice');
const resolvedToggle = document.querySelector('.od-show-resolved');
const commentsToggle = document.querySelector('.od-tool-comment');
// In a narrow window the comments rise from the bottom over the page: closed
// until the Comments button or commented text opens them. The highlights stay.
const narrow = window.matchMedia('(max-width: 900px)');

let editor;
let made; // what `editor` was made from: viewFor's { id, createView, settings }
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
let synced; // the doc's text as last loaded or saved
let docName; // the doc's file name
let dirty = false;
let saving = false;
let version = 0;
let saveTimer;
let pendingExternal = null;
let pendingSelection = null; // an anchor on the doc's text while a comment is written on it
let activeId = null; // the selected thread
let hoverId = null; // the thread whose card is under the pointer
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

  made = viewFor(docName, settings.get());
  editor = await makeView(made, initial.text);
  synced = initial.text;
  chrome = createChrome({
    getView: () => editor, settings, getName: () => me, setName,
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
      paintEmpty();
      paintMarks();
    },
    onReply: (thread, body) => send(api.comment({ thread, body })),
    onResolve: (thread) => send(api.comment({ thread, body: '', resolved: true })),
    onReopen: (thread) => send(api.comment({ thread, body: '' })),
    onUndo: undoReply,
    onShowEdits: (id) => (id ? showRun(id) : hideRun()),
    onSelect: (id) => {
      select(id);
      if (narrow.matches) revealText(id);
    },
    onHover: (id) => {
      if (id === hoverId) return;
      hoverId = id;
      paintMarks();
    },
    anchorTops,
    mentionChoices: (query) => people?.mentionChoices(query) ?? [],
    mentionable: () => people?.mentionable() ?? [],
  });

  people = createPeople({
    root: document.querySelector('.od-agents'),
    invite: document.querySelector('.od-invite'),
    panel: document.querySelector('.od-panel'),
    me: document.querySelector('.od-me'),
    getName: () => me,
    getId: () => settings.get().id,
    setName,
    getAbout: () => settings.get().about,
    setAbout: (about) => settings.set({ about }),
    project: () => inProject,
    onResult: takeAgentResult,
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
    paintEmpty();
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
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideRun(); // even when the editor took it
  });
  document.addEventListener('pointerdown', (event) => {
    if (!sheetOpen() || event.target.closest('.od-margin, .od-tool-comment, .od-show-resolved, [data-thread], .od-bubble')) return;
    openSheet(false);
  });
  history = createHistory({
    api,
    chooseView: () => viewFor(docName, settings.get()),
    commentOf: (id) => comments?.threads.find((t) => t.id === id)?.comments[0]?.body ?? null,
    onRestore: restoreVersion,
    onClose: () => editor.focus(),
  });
  settings.subscribe(followViews);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && event.code === 'KeyH') {
      event.preventDefault();
      history.toggle();
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyT') {
      event.preventDefault();
      settings.set({ views: { markdown: { enabled: !viewSettings(settings.get(), markdown).enabled } } }); // the Plain text view, and back
    } else if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyM' && !history.isOpen()) {
      event.preventDefault();
      requestComment();
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
  events.on('renamed', (data) => {
    showDocName(data.doc);
    followViews(); // a new extension may open in another view
  });
  events.on('missing', (data) => setMissing(data.missing));
  // First on the line: the doc may have gone missing, or runs started, since `state`.
  events.on('hello', (data) => {
    if (Boolean(data.missing) !== missing) setMissing(!missing);
    showAgents(data.agents);
  });
  await files.ready;
  if (startTyping) editor.focus();
}

// ---- the doc's view ----

// The doc's text in the view `chosen` (from viewFor), in the page's stage.
function makeView(chosen, text) {
  return chosen.createView({
    stage: document.querySelector('.od-stage'),
    text,
    name: docName,
    toolbar: document.querySelector('.od-toolbar'),
    onComment: requestComment,
    onChange: () => {
      hideRun();
      paintMarks();
      dirty = true;
      version++;
      setStatus('Saving…', 'saving');
      scheduleSave();
    },
    // Clicking commented text selects its thread but keeps the caret in the doc.
    onMarkClick: (id) => {
      if (id === 'draft') return;
      if (narrow.matches) {
        openSheet(true);
        select(id, { focus: false });
        revealText(id);
      } else if (commentsShown()) select(id, { focus: false });
    },
    onLayout: () => margin.layout(),
    settings: chosen.settings,
    saveSettings: (patch) => settings.set({ views: { [chosen.id]: patch } }),
  });
}

// The view follows the Views settings. Switching one on or off makes the doc's
// view again from the same text, typing not saved yet saved first, comments
// and a revision drawn again; a view's own setting reaches it as it is.
// One change at a time, each against the settings as they are by then.
let following = Promise.resolve();
function followViews() {
  following = following.then(async () => {
    const chosen = viewFor(docName, settings.get());
    if (chosen.id !== made.id) await remakeView(chosen);
    else if (chosen.settings && JSON.stringify(chosen.settings) !== JSON.stringify(made.settings)) {
      editor.applySettings(chosen.settings);
      await history.viewChanged(); // an open history view follows too
    }
    made = chosen;
  }).catch((error) => setStatus(`Could not switch the view: ${error.message}`, 'error'));
}

async function remakeView(chosen) {
  takeUnreportedTyping();
  await flushSave().catch(() => {}); // a missing doc keeps its typing in the page
  const old = editor;
  const text = old.getText();
  const next = await makeView(chosen, text);
  // A change from disk taken in while the new view was made.
  if (old.getText() !== text) next.applyText(old.getText(), { by: ON_DISK });
  editor = next;
  await old.destroy();
  paintMarks();
  margin.layout();
  await history.viewChanged();
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
  const text = editor.getText();
  let behind = false; // the doc has changes this save did not have
  setStatus('Saving…', 'saving');
  try {
    const { status: code, data } = await api.saveDoc(text, baseHash);
    if (code === 409) {
      behind = true;
    } else if (data.text !== text) {
      synced = text; // the doc host merged the doc's changes into this save: carry on from what was sent
      behind = true;
    } else {
      baseHash = data.docHash;
      synced = text;
      if (version === savedVersion) dirty = false;
      if (dirty) setStatus('Saving…', 'saving');
      else setStatus('Saved');
    }
  } catch (error) {
    setStatus(`Save failed: ${error.message}`, 'error');
  } finally {
    saving = false;
  }
  if (behind) {
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
  if (editor && !dirty && editor.getText() !== synced) {
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

// `by` flags a change no buddy's run made: ON_DISK, or what the human did.
let syncing = null;
function syncFromDisk(by = ON_DISK) {
  syncing ??= doSync(by).finally(() => { syncing = null; });
  return syncing;
}

async function doSync(by) {
  const fresh = await api.state();
  if (fresh.docHash === baseHash) return;
  // A buddy's run wrote this doc when its version is the doc on disk.
  const [reply, run] = Object.entries(fresh.edits ?? {}).find(([, e]) => e.hash === fresh.docHash && e.state === 'edited') ?? [];
  const theirs = fresh.text;
  // Compare the live text, not `dirty`: the editor reports typing on a debounce.
  // Where the change overlaps what the human typed since, the human's stays.
  const merged = merge3(synced, editor.getText(), theirs, { prefer: 'ours', rules: rulesOf(docName, settings.get()) });
  // A buddy's changes show as its revision; anything else glows.
  editor.applyText(merged.text, { by: run?.by ?? by, buddy: Boolean(run) });
  paintMarks();
  synced = theirs;
  baseHash = fresh.docHash;
  applyComments(fresh);
  if (run) {
    standAtLastEdit(run.by, synced, theirs);
    showRun(reply, { scroll: false });
  }
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
  standAtWork(next);
  setBuddies(next.map((a) => a.name));
  people.render({ agents: next });
  margin.setAgents(next);
  paintMarks();
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
  const text = editor.getText();
  try {
    const { status: code, data } = await api.saveDoc(text, baseHash, { recreate: true });
    if (code === 409) {
      setMissing(false); // it is back already: merge what is there
      await syncFromDisk();
      return;
    }
    baseHash = data.docHash;
    synced = text;
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
let failedShown = null; // ids of the failed replies on screen; null until the first update
function applyComments({ threads, people: writers, edits, notice, readOnly }) {
  const json = JSON.stringify({ threads, writers, edits, notice, readOnly });
  if (json === shownComments) return;
  shownComments = json;
  // A failed run's reply that is new since the last update: its buddy flinches.
  const failed = threads.flatMap((t) => t.comments).filter((c) => c.failed);
  if (failedShown) for (const c of failed.filter((c) => !failedShown.has(c.id))) people?.failed(c.by.name);
  failedShown = new Set(failed.map((c) => c.id));
  comments = { threads, people: writers, edits, notice, readOnly };
  showReadOnly(readOnly);
  paintMarks();
  margin.update(threads, { id: myId, name: me }, edits);
  people?.render({ people: writers });
  noticeBanner.hidden = !notice;
  noticeBanner.querySelector('.od-banner-text').textContent = notice ?? '';
  const open = threads.filter((t) => !t.resolved).length;
  commentsToggle.querySelector('.od-comment-count').textContent = open > 0 ? String(open) : '';
  paintEmpty();
}

// A sidecar this app must not write (spec/SPEC.md §2): its comments show,
// nothing adds to them, and the banner says how to fix it, or offers to put
// it in the Trash and start new comments. Once fixed, the sidecar's change
// event brings the comments back to normal.
const REVEAL_LABEL = /Mac/.test(navigator.platform) ? 'Reveal in Finder' : /Win/.test(navigator.platform) ? 'Show in File Explorer' : 'Show in Folder';
function showReadOnly(problem) {
  document.documentElement.toggleAttribute('data-read-only', Boolean(problem));
  readOnlyBanner.hidden = !problem;
  if (!problem) return;
  readOnlyBanner.querySelector('.od-banner-text').textContent = {
    older: 'These comments are from an older OpenDoc, so they are read-only here.',
    newer: 'These comments are from a newer OpenDoc, so they are read-only here. Update OpenDoc to add comments.',
    invalid: `This doc's comments file does not start with {"opendoc":${FORMAT_VERSION}}, so comments are read-only. Fix the file to add comments.`,
  }[problem];
  readOnlyBanner.querySelector('[data-action="update"]').hidden = problem !== 'newer';
  readOnlyBanner.querySelector('[data-action="start-over"]').hidden = !window.opendocDesktop;
  const reveal = readOnlyBanner.querySelector('[data-action="reveal"]');
  reveal.textContent = REVEAL_LABEL;
  reveal.hidden = problem === 'newer' || !window.opendocDesktop;
}

readOnlyBanner.querySelector('[data-action="update"]').addEventListener('click', () => {
  window.open('https://github.com/fanzhangg/open-doc/releases/tag/nightly');
});
readOnlyBanner.querySelector('[data-action="start-over"]').addEventListener('click', () => {
  if (!window.confirm('Move this doc\'s comments file to the Trash and start new comments?\n\nIts comments are no longer shown here. You can put the file back from the Trash.')) return;
  window.opendocDesktop.trashSidecar().catch((error) => setStatus(`Could not move the comments file: ${error.message}`, 'error'));
});
readOnlyBanner.querySelector('[data-action="reveal"]').addEventListener('click', () => {
  window.opendocDesktop.revealSidecar().catch(() => {});
});

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

// With no open comment, no draft and no resolved list, the margin folds away
// and the Comments button rests; the next comment brings them back.
function noComments() {
  return document.documentElement.hasAttribute('data-no-comments');
}

function paintEmpty() {
  const empty = !comments?.threads.some((t) => !t.resolved) && !pendingSelection && resolvedToggle.getAttribute('aria-pressed') !== 'true';
  document.documentElement.toggleAttribute('data-no-comments', empty);
  if (empty) openSheet(false);
  paintCommentsToggle();
}

function paintCommentsToggle() {
  const on = !noComments() && (narrow.matches ? sheetOpen() : commentsShown());
  commentsToggle.disabled = noComments();
  commentsToggle.setAttribute('aria-pressed', String(on));
  commentsToggle.dataset.tip = noComments() ? 'No comments' : on ? 'Hide comments' : 'Show comments';
}

// Bring a thread's text into view above the sheet.
function revealText(id) {
  document.querySelector(`.od-page [data-thread="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Comments are on selected text only.
function requestComment() {
  if (comments?.readOnly) return;
  const selection = editor.selection();
  if (!selection || selection.from === selection.to) return;
  if (narrow.matches) openSheet(true);
  else if (!commentsShown()) showComments(true);
  pendingSelection = createAnchor(editor.getText(), selection.from, selection.to);
  paintEmpty();
  paintMarks();
  margin.startDraft(pendingSelection);
}

async function createThread(body) {
  await flushSave();
  // The selection on the doc's text that is now on disk; if it is gone, the
  // comment is on the whole doc.
  const text = editor.getText();
  const found = locate(text, pendingSelection);
  const { id } = await send(api.comment({ anchor: found && createAnchor(text, found.start, found.end), body }));
  pendingSelection = null;
  paintEmpty();
  paintMarks();
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
  if (shownRun === id) hideRun();
  await flushSave();
  try {
    applyComments(await api.undoReply(id));
  } catch (error) {
    setStatus(`Could not undo: ${error.message}`, 'error');
    throw error;
  }
  await syncFromDisk('Undo');
}

// ---- where each buddy stands in the text ----

// A buddy asked to work in this window stays in the doc with its cursor, at
// the end of its last edit, or at the passage it was asked about until it
// edits. The place is an anchor, so it follows the text; the cursor goes with
// the page, and with the buddy once it is no longer here.
const cursors = new Map(); // buddy name -> anchor of the character before its cursor
let working = new Set();

function standAtWork(statuses) {
  const names = new Set(statuses.map((a) => a.name));
  for (const name of cursors.keys()) if (!names.has(name)) cursors.delete(name);
  const now = new Set(statuses.filter((a) => modeOf(a) === 'working').map((a) => a.name));
  for (const a of statuses) {
    const thread = !working.has(a.name) && now.has(a.name) && comments?.threads.find((t) => a.threadIds.includes(t.id) && t.anchor && !t.detached);
    if (thread) cursors.set(a.name, thread.anchor);
  }
  working = now;
}

function standAtLastEdit(by, before, after) {
  const last = diffEdits(before, after).at(-1);
  const text = editor.getText();
  const range = last && findEdit(text, last.edit);
  if (range && text) cursors.set(by, createAnchor(text, Math.max(range.end, 1) - 1, Math.max(range.end, 1)));
}

// ---- a buddy's run as a revision in the text ----

// The edits of the run that wrote reply `id`, marked in the text until the
// human types, presses Escape or toggles them off on the reply; `scroll`
// brings the first into view. An edit changed since is left out.
let shownRun = null;
let preview = null; // { edits, by, replay } of the run shown
let replays = 0;
async function showRun(id, { scroll = true } = {}) {
  const run = comments?.edits?.[id];
  if (run?.state !== 'edited') return;
  shownRun = id;
  margin.setShownEdits(id);
  const found = await api.version(run.version).catch(() => null);
  if (shownRun !== id) return;
  if (!found?.before) return hideRun();
  const edits = diffEdits(found.before, found.text).map((change) => change.edit);
  preview = { edits, by: run.by, replay: ++replays };
  const marks = paintMarks().filter((m) => m.kind === 'edit');
  if (scroll && marks.length > 0) editor.scrollTo(marks[0].from);
}

function hideRun() {
  if (shownRun === null) return;
  shownRun = null;
  preview = null;
  margin.setShownEdits(null);
  paintMarks();
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
  const { text, docHash } = result.data;
  editor.applyText(text, { by: 'Restore' });
  paintMarks();
  synced = text;
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
  activeId = id;
  paintMarks();
  margin.setActive(id, { focus });
}

// ---- marks in the text ----

// Where each anchor is in the doc's text, worked out once per text: comment
// and agent events that leave the text alone cost next to nothing.
let locatedIn = null;
let located = new Map();
function where(text, anchor) {
  if (text !== locatedIn) {
    locatedIn = text;
    located = new Map();
  }
  const key = JSON.stringify(anchor);
  if (!located.has(key)) located.set(key, locate(text, anchor));
  return located.get(key);
}

// Draw the open threads' text, the draft's and the run shown; returns the marks.
function paintMarks() {
  const text = editor.getText();
  const marks = [];
  const comment = (id, anchor, active) => {
    const found = where(text, anchor);
    if (found) marks.push({ kind: 'comment', id, from: found.start, to: found.end, active });
  };
  for (const t of comments?.threads ?? []) {
    if (t.anchor && !t.detached && !t.resolved) comment(t.id, t.anchor, t.id === activeId || t.id === hoverId);
  }
  if (pendingSelection) comment('draft', pendingSelection, true);
  if (preview) marks.push(...revisionMarks(text, preview.edits, preview));
  for (const [by, anchor] of cursors) {
    const found = where(text, anchor);
    if (found) marks.push({ kind: 'cursor', at: found.end, by, working: working.has(by) });
  }
  editor.setMarks(marks);
  return marks;
}

// The viewport top of each margin card's text, by thread id.
function anchorTops(items) {
  const text = editor.getText();
  const placed = items.map(({ id, anchor }) => [id, where(text, anchor)]).filter(([, found]) => found);
  const tops = editor.tops(placed.map(([, found]) => found.start));
  return new Map(placed.map(([id], i) => [id, tops[i]]).filter(([, top]) => top !== null));
}

// ---- identity ----

function showDocName(name) {
  docName = name;
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
