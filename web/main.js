// The opendoc page: wires the editor, the comment margin, the people (the
// doc's agents and you) and the server together. Saves are debounced and conditional on the hash
// they were based on. Changes made on disk (usually by the agent) arrive as
// SSE events and are merged into the page like a collaborator's edits, an
// agent's typed in by its caret: only a change that overlaps what the human
// changed in the same paragraph asks them to choose.

import { api } from './api.js';
import { createDocEditor } from './editor.js';
import { avatar, createCommentMargin, namecardFor, setFaces } from './threads.js';
import { createPeople } from './agent.js';
import { createNameCards } from './namecard.js';
import { createChrome } from './ui.js';
import { createSettings, forgetLegacySettings, legacySettings } from './settings.js';
import { icon } from './icons.js';
import { followLines, merge3 } from '../src/core/merge.js';
import { project } from '../src/core/project.js';
import { createAnchor, locate } from '../src/core/anchor.js';
import { applyProposal, diffEdits, revertEdits } from '../src/core/diff.js';
import { canApply, editItems, openProposal, previewItems } from './review.js';
import { createHistory } from './history.js';
import { createFileList } from './files.js';
import { activeWorking, newId } from '../src/core/ops.js';
import { NAME_PATTERN, sameName } from '../src/core/mentions.js';
import { availableIn } from '../src/core/agents.js';

const SAVE_DELAY_MS = 800;
const ON_DISK = 'Edited on disk'; // a change no collaborator is known to have made
const TYPING_REPORT_MS = 1000;
// Changes from disk and comment updates wait for a pause in typing this long,
// but never longer than WAIT_FOR_PAUSE_MS: taking them in while keys arrive
// would stall the keys.
const TYPING_PAUSE_MS = 600;
const WAIT_FOR_PAUSE_MS = 3000;
const COMMENTS_KEY = 'opendoc.comments'; // 'hidden' while the human keeps comments out of view

const status = document.querySelector('.od-status');
const banner = document.querySelector('.od-banner');
const missingBanner = document.querySelector('.od-missing');
const resolvedToggle = document.querySelector('.od-show-resolved');
const commentsToggle = document.querySelector('.od-tool-comment');

let editor;
let chrome;
let margin;
let people;
let history;
let settings;
let defaultName;
let docKey; // the doc's full path: which of your unstarred agents are its own
let folderName = null; // the folder the doc was opened from, whose files its agents may read
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
let typedAt = -Infinity; // when the human last typed in the doc
let shownAgents = ''; // the agent statuses on screen, as JSON
let shownSidecar = ''; // the sidecar on screen, as JSON
// An agent's text the last merge left out for the human's, offered back on
// its comment once the human's is saved: { by: the agent, text: the merged
// markdown, items: [{ at, count, theirs }] } (lines of `text` and the agent's version).
let overwritten = null;
let missing = false; // the doc was moved or deleted on disk: nothing is saved
let files; // the folder sidebar (desktop folder windows)

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
  disk = initial.markdown;
  defaultName = initial.defaultName;
  docKey = initial.docKey;
  folderName = initial.folder ?? null;
  settings = createSettings(initial.settings, {
    save: api.saveSettings,
    onError: (error) => setStatus(`Settings not saved: ${error.message}`, 'error'),
  });
  if (!initial.settingsSaved) adoptLegacySettings();
  me = settings.get().name ?? defaultName;
  setFaces(faceOf);
  settings.subscribe((next, prev) => {
    renameMe(next.name ?? defaultName); // before the dialog's, which shows `me`
    if (facesOf(next) !== facesOf(prev)) repaintFaces();
  });
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
      reportTyping();
    },
    // Clicking commented text selects its thread but keeps the caret in the doc.
    onSelectThread: (id) => {
      if (commentsShown()) select(id, { focus: false });
    },
    onCommentRequest: (hint) => {
      chrome?.hideBubble();
      if (!commentsShown()) showComments(true);
      pendingSelection = hint;
      editor.setDraft(hint);
      margin.startDraft(hint);
    },
  });
  synced = editor.getMarkdown();
  editor.onUi(reportCaret);
  chrome = createChrome({
    editor, onComment: () => editor.requestComment(), settings, getName: () => me, setName, onAgentResult: takeAgentResult,
    docKey: () => docKey,
    folder: () => folderName,
    settingsFile: () => initial.settingsFile ?? null,
    mentionChoices: (query) => people?.mentionChoices(query, me) ?? [],
  });
  window.opendocDesktop?.onCommand((name) => chrome.command(name));
  files = createFileList({
    onError: (message) => setStatus(message, 'error'),
    onCarry: (carry) => {
      if (carry.commentsHidden) showComments(false);
    },
  });

  margin = createCommentMargin(document.querySelector('.od-margin'), {
    onCreate: createThread,
    onCancelDraft: () => {
      pendingSelection = null;
      editor.setDraft(null);
    },
    onReply: (threadId, body) => sendOp({ type: 'addMessage', threadId, message: newMessage(body) }),
    onResolve: (threadId) => sendOp({ type: 'resolve', threadId, by: me }),
    onReopen: (threadId) => sendOp({ type: 'reopen', threadId, by: me }),
    onRetry: (threadId, name) => sendOp({ type: 'retry', threadId, name }),
    onCancelRequest: (threadId, name) => sendOp({ type: 'cancel', threadId, name }),
    onUndo: undoEdit,
    onApply: applyProposalEdit,
    canApply: (message) => canApply(disk, message),
    onReview: review,
    reviewing: () => reviewing,
    onSelect: select,
    anchorTops: (items) => editor.anchorTops(items),
    mentionChoices: (query, name) => people?.mentionChoices(query, name) ?? [],
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
    setFace: (face) => settings.set({ face }),
    docKey: () => docKey,
    openSettings: (section, agentId) => (section === 'agents' ? chrome.openAgent(agentId) : chrome.command('settings')),
    newAgent: () => chrome.newAgent({ invite: true }),
    onSidecar: applySidecar,
    onSettings: (next) => settings.receive(next),
    onError: (message) => setStatus(message, 'error'),
    onPeople: () => editor.setMentionNames(people.mentionable()),
  });
  const who = (chip) => [chip.dataset.mention, chip.dataset.mentionKind, chip];
  createNameCards({
    card: document.querySelector('.od-panel'),
    peek: (chip) => people.peek(...who(chip)),
    pin: (chip) => people.pin(...who(chip)),
    unpeek: () => people.unpeek(),
  });
  people.render({ agents: initial.agents, roster: settings.get().agents });
  settings.subscribe((next) => people.render({ roster: next.agents }));
  chrome.agentStatus(initial.agents);
  margin.setAgents(initial.agents);
  shownAgents = JSON.stringify(initial.agents);
  applySidecar(initial.sidecar);
  setStatus('Saved');
  setInterval(() => margin.rerender(), 30_000); // relative times, stale "working"

  let hidden = false;
  try {
    hidden = localStorage.getItem(COMMENTS_KEY) === 'hidden';
  } catch {
    // no storage: comments start shown
  }
  if (hidden) showComments(false);
  commentsToggle.addEventListener('click', () => showComments(!commentsShown()));
  resolvedToggle.addEventListener('click', () => {
    const on = resolvedToggle.getAttribute('aria-pressed') !== 'true';
    resolvedToggle.setAttribute('aria-pressed', String(on));
    if (on && !commentsShown()) showComments(true);
    margin.setShowResolved(on);
  });
  history = createHistory({
    api,
    commentOf: (id) => sidecar?.threads.find((t) => t.id === id)?.messages[0]?.body ?? null,
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
  events.addEventListener('doc', (event) => onDocEvent(JSON.parse(event.data).docHash));
  events.addEventListener('sidecar', () => afterTyping('sidecar', refreshThreads));
  events.addEventListener('history', () => history.changed());
  // The running agent is about to edit there: its caret goes there first.
  events.addEventListener('agentTarget', (event) => {
    const { quote } = JSON.parse(event.data);
    const agent = people.running();
    if (agent && quote) editor.agentLooking(agent.name, [{ exact: quote, prefix: '', suffix: '', start: 0 }]);
  });
  events.addEventListener('agents', (event) => showAgents(JSON.parse(event.data)));
  events.addEventListener('settings', (event) => settings.receive(JSON.parse(event.data)));
  events.addEventListener('renamed', (event) => {
    const data = JSON.parse(event.data);
    showDocName(data.doc);
    docKey = data.docKey ?? docKey; // its own agents moved with it
    people?.render({ roster: settings.get().agents });
  });
  events.addEventListener('folder', (event) => {
    folderName = JSON.parse(event.data).folder ?? null;
  });
  events.addEventListener('error', () => setStatus('Reconnecting…', 'offline'));
  events.addEventListener('missing', (event) => setMissing(JSON.parse(event.data).missing));
  events.addEventListener('hello', (event) => {
    if (Boolean(JSON.parse(event.data).missing) !== missing) setMissing(!missing);
    else if (!missing) setStatus(dirty ? 'Saving…' : 'Saved', dirty ? 'saving' : 'saved');
  });
  await files.ready;
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
  takeUnreportedTyping();
  if (!dirty && !saving) return;
  event.preventDefault();
  event.returnValue = true;
  flushSave().catch(() => {});
});

// Typing the editor has not reported yet (it does so on a debounce) is an
// edit to save too. What is on disk is the whole change: a replay still
// running is shown first.
function takeUnreportedTyping() {
  editor?.finishReplay();
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
  const by = editorName(fresh.sidecar);
  const theirs = editor.normalize(fresh.markdown);
  // A replay still running is part of what is already on disk: complete it
  // so its partial text is not taken for the human's.
  editor.finishReplay();
  // Compare the live text, not `dirty`: the editor reports typing on a debounce.
  const mine = editor.getMarkdown();
  // Where an agent changed text the human is still typing in, the human's
  // stays and the agent's goes back to its comment as a proposal. Other
  // changes (another program, a collaborator the page does not know) still
  // ask the human to choose.
  const fromAgent = people.statuses().some((a) => a.name === by);
  const merged = merge3(synced, mine, theirs, fromAgent ? { prefer: 'ours' } : {});
  if (merged.conflict) {
    showConflict(by);
    return;
  }
  keepOverwritten(merged, by);
  // The agent's changes are typed in; anything else just appears.
  editor.applyMarkdown(merged.text, by, { animate: by !== ON_DISK });
  synced = theirs;
  baseHash = fresh.docHash;
  if (JSON.stringify(fresh.sidecar) !== shownSidecar) {
    disk = fresh.markdown;
    applySidecar(fresh.sidecar);
  } else {
    setDisk(fresh.markdown); // the cards change only if a proposal's fate does
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

// Tell the server which paragraph the human is typing in, at most once a
// second, so agents' runs keep out of it (the server forgets it 15 seconds
// after the last report).
let typingTimer = null;
let typingSentAt = 0;
function reportTyping() {
  if (typingTimer || !people?.statuses().length) return;
  typingTimer = setTimeout(() => {
    typingTimer = null;
    typingSentAt = Date.now();
    const anchor = editor.caretBlock();
    if (anchor) api.typing(anchor).catch(() => {});
  }, Math.max(0, TYPING_REPORT_MS - (Date.now() - typingSentAt)));
}

// Tell the server when the caret moves to another paragraph, or out of the
// doc, so an @mention typed in the text is sent once the human moves on from
// it (src/server/text-asks.js).
let caretAt; // index of the block last reported, null for none
let blurTimer = null;
function reportCaret() {
  const at = editor.caretIndex();
  if (at === caretAt) return;
  if (at === null) {
    // Clicking the @ menu takes the focus for a moment: wait for it to come back.
    blurTimer ??= setTimeout(() => {
      blurTimer = null;
      if (editor.caretIndex() !== null || caretAt === null) return;
      caretAt = null;
      api.caret(null).catch(() => {});
    }, 300);
    return;
  }
  caretAt = at;
  api.caret(editor.caretBlock()).catch(() => {});
}

// Remember what a merge left out of agent `by`'s change, following anything
// remembered from an earlier merge (of the same agent) into this one's text.
function keepOverwritten(merged, by) {
  const items = [];
  if (overwritten && overwritten.by === by) {
    for (const item of overwritten.items) {
      const range = followLines(overwritten.text, merged.text, item.at, item.count);
      if (range) items.push({ ...item, at: range.start, count: range.end - range.start });
    }
  }
  for (const d of merged.dropped ?? []) items.push({ at: d.at, count: d.count, theirs: d.theirs });
  overwritten = items.length > 0 ? { by, text: merged.text, items } : null;
}

// The human's text is saved: offer the agent's version of each region it was
// kept over, as it reads now (`saved`, the markdown just saved).
function offerOverwritten(saved) {
  if (!overwritten) return;
  const { by, text, items } = overwritten;
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
  if (changes.length > 0) api.agentOverwritten(by, changes).catch(() => {});
}

// The doc's agents changed (a status, or who is here).
function showAgents(next) {
  // The server repeats statuses (each connection starts with them); redrawing
  // the faces and panels for the same ones is wasted work.
  const json = JSON.stringify(next);
  if (json === shownAgents) return;
  shownAgents = json;
  showAgentCaret(people.running(), next.find((a) => a.state === 'running') ?? null);
  people.render({ agents: next });
  chrome.agentStatus(next);
  margin.setAgents(next);
}

// What an agent request (invite, remove, change an agent) answers with.
function takeAgentResult(result) {
  if (result.settings) settings.receive(result.settings);
  if (result.sidecar) applySidecar(result.sidecar);
  if (result.agents) showAgents(result.agents);
}

// A run starting puts its agent's caret on the comment it is reading, as a
// collaborator would scroll there; when it stops, the caret stays and fades.
// Agents run one at a time.
function showAgentCaret(before, after) {
  if (after && after.name !== before?.name) {
    const ids = after.threadIds ?? [];
    const anchors = ids.map((id) => sidecar?.threads.find((t) => t.id === id)?.anchor).filter(Boolean);
    editor.agentLooking(after.name, anchors);
  } else if (!after && before) {
    editor.agentResting();
  }
}

// Who most likely changed the file: the agent running, or the collaborator
// working on a comment.
function editorName(nextSidecar) {
  const agent = people.running();
  if (agent) return agent.name;
  const working = nextSidecar.threads.flatMap((t) => activeWorking(t));
  return working[0]?.by ?? ON_DISK;
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
        const fresh = await api.state();
        setDisk(fresh.markdown);
        // A sidecar event can leave the threads as they are (an agent's
        // working marker renewed, say); redrawing every card for that stalls typing.
        if (JSON.stringify(fresh.sidecar) !== shownSidecar) applySidecar(fresh.sidecar);
      } catch {
        // the next event retries
      }
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function applySidecar(next) {
  sidecar = next;
  shownSidecar = JSON.stringify(next);
  editor.setThreads(sidecar.threads);
  margin.update(sidecar, me);
  people?.render({ participants: sidecar.participants });
  refreshPreview();
  const open = sidecar.threads.filter((t) => t.status === 'open').length;
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
  commentsToggle.setAttribute('aria-pressed', String(on));
  commentsToggle.dataset.tip = on ? 'Hide comments' : 'Show comments';
  try {
    localStorage.setItem(COMMENTS_KEY, on ? 'shown' : 'hidden');
  } catch {
    // not remembered: fine
  }
  if (on) margin.rerender();
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
  // Canonical anchor: re-find the selection in the core projection of the
  // markdown that is now on disk.
  const { text } = project(editor.getMarkdown());
  const hint = { exact: pendingSelection.quote, prefix: pendingSelection.prefix, suffix: pendingSelection.suffix, start: pendingSelection.start };
  const found = locate(text, hint);
  const anchor = found ? createAnchor(text, found.start, found.end) : hint;
  const id = newId('t');
  await sendOp({ type: 'addThread', id, anchor, message: newMessage(body) });
  pendingSelection = null;
  editor.setDraft(null);
  select(id);
}

async function sendOp(op) {
  try {
    takeAgentResult(await api.op(op)); // an @mention may have brought an agent in
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
  setDisk(markdown);
  dirty = false;
  setStatus('Saved');
  if (pendingExternal) {
    const hash = pendingExternal;
    pendingExternal = null;
    onDocEvent(hash);
  }
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
  const button = document.querySelector('.od-me');
  button.replaceChildren(avatar(me, 'human'));
  namecardFor(button, me, 'human', 'instant');
  button.setAttribute('aria-label', `You (${me})`);
}

/** Rename the human in comments, in every doc; false when the name is not allowed. Your face stays. */
function setName(next) {
  if (!NAME_PATTERN.test(next)) return false;
  if (next !== me) settings.set({ name: next, face: settings.get().face ?? me });
  return true;
}

// The seed of a face (see setFaces): yours and your agents' as saved, so a
// new name keeps the old face.
function faceOf(name, kind) {
  const saved = settings.get();
  if (kind !== 'agent') return sameName(name, me) ? saved.face ?? me : name;
  const mine = saved.agents.filter((a) => sameName(a.name, name));
  const agent = mine.find((a) => availableIn(a, docKey)) ?? mine[0];
  return agent?.face ?? name;
}

const facesOf = (saved) => JSON.stringify([saved.face, ...saved.agents.map((a) => [a.id, a.face])]);

// A face changed: everywhere it shows. (People's own repaint comes with the roster.)
function repaintFaces() {
  paintNameChip();
  margin?.rerender();
  people?.renameMe();
}

function renameMe(next) {
  if (next === me) return;
  me = next;
  paintNameChip();
  margin?.update(sidecar, me);
  people?.renameMe();
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

// Ready once drawn: two frames after the page is built.
start().finally(() => requestAnimationFrame(() => requestAnimationFrame(markReady)));
