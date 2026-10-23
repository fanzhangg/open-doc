// Version history: every version of the doc (src/store/history.js), who made
// it and what it changed, a burst of typing as one row. A row shows
// read-only in a second view, with what it changed marked as a revision
// (added text highlighted, removed text struck through); any earlier one can
// be restored, and any change undone, each adding a new version, so either
// can be undone the same way.

import { diffEdits } from '../src/core/diff.js';
import { revisionMarks } from './marks.js';
import { icon } from './icons.js';
import { avatar } from './threads.js';
import { nameOf } from './faces.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A burst of typing is one row: versions typed by the same people, each
// within BURST_GAP_MS of the one before, over at most BURST_SPAN_MS.
const BURST_GAP_MS = 2 * 60 * 1000;
const BURST_SPAN_MS = 30 * 60 * 1000;
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dateWithYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * `api` is web/api.js; `chooseView(text)` is the view a version of text
 * `text` is shown in (viewFor in web/views/index.js); `commentOf(threadId)`
 * is the text of the comment a buddy's version answered, or null; `onRestore(id)` puts the doc back to
 * version `id` and resolves once the page shows it; `onUndo(id, from)` takes back the change of
 * the versions from `from` to `id`.
 */
export function createHistory({ api, chooseView, commentOf, onRestore, onUndo, onClose }) {
  const root = document.documentElement;
  const stage = document.querySelector('.pj-history-stage');
  const list = stage.querySelector('.pj-history-list');
  const bar = document.querySelector('.pj-history-bar');
  const heading = bar.querySelector('.pj-history-heading');
  const restoreButton = bar.querySelector('[data-action="restore"]');
  const undoButton = bar.querySelector('[data-action="undo"]');
  const changesToggle = bar.querySelector('.pj-history-changes input');
  const toggleButton = document.querySelector('.pj-tool-history');

  let view = null; // the read-only view, made when history first opens
  let viewId; // the view `view` is of (null: the plain view)
  let versions = []; // the rows, oldest first: each its last version, with `first` and `startedAt` of its first
  let selected = null;
  let shown = null; // { version, text, before } of the selected version
  let loads = 0;
  let restoring = false;
  let replays = 0;

  const isOpen = () => root.hasAttribute('data-history');
  const latest = () => versions.at(-1) ?? null;

  async function open() {
    if (isOpen()) return;
    root.setAttribute('data-history', '');
    toggleButton.setAttribute('aria-pressed', 'true');
    await makeView();
    await refresh();
    await select(latest()?.id ?? null);
    list.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    root.removeAttribute('data-history');
    toggleButton.setAttribute('aria-pressed', 'false');
    onClose?.();
  }

  // The view, made again when the doc opens in another one (a view was
  // switched), or given the view's settings again; one at a time.
  let making = Promise.resolve();
  function makeView() {
    making = making.catch(() => {}).then(remakeView);
    return making;
  }

  async function remakeView() {
    const chosen = chooseView(shown?.text ?? '');
    if (view && chosen.id === viewId) return view.applySettings?.(chosen.settings);
    const old = view;
    view = await chosen.createView({ stage, text: '', editable: false, settings: chosen.settings });
    viewId = chosen.id;
    await old?.destroy();
    view.applyText(shown?.text ?? ''); // the version picked by now
    showChanges();
  }

  async function refresh() {
    try {
      versions = rowsOf(await api.history());
    } catch (error) {
      heading.textContent = `Could not load the history: ${error.message}`;
      return;
    }
    render();
  }

  // A new version, or the latest one grew: keep showing the version the
  // human picked, or follow the latest if that is what they were looking at.
  async function changed() {
    if (!isOpen()) return;
    const wasLatest = selected === latest()?.id;
    const before = shown?.version;
    await refresh();
    const now = versions.find((v) => v.id === selected);
    if (wasLatest || !now) await select(latest()?.id ?? null);
    else if (now.hash !== before?.hash) await select(selected);
  }

  // ---- the list ----

  function render() {
    const items = [];
    let day = null;
    const current = latest();
    for (const version of [...versions].reverse()) {
      const label = dayLabel(version.at);
      if (label !== day) {
        day = label;
        items.push(el('li', 'pj-history-day', label, { role: 'presentation' }));
      }
      items.push(row(version, version === current));
    }
    if (items.length === 0) items.push(el('li', 'pj-history-empty', 'No versions yet.'));
    list.replaceChildren(...items);
    markSelected();
  }

  function row(version, current) {
    const li = el('li', 'pj-version', null, { role: 'option', 'data-id': version.id });
    const face = version.author ? avatar(version.author.name, version.author.kind, true, version.author.id) : el('span', 'pj-avatar pj-avatar-small pj-version-outside');
    if (!version.author) face.append(icon(version.kind === 'opened' ? 'file' : 'history'));
    const who = el('span', 'pj-version-who', authorLabel(version));
    const when = el('span', 'pj-version-time', timeRange(version));
    const top = el('span', 'pj-version-top');
    top.append(who);
    if (current) top.append(el('span', 'pj-version-tag', 'Current'));
    const stats = el('span', 'pj-version-stats');
    if (version.kind !== 'opened') { // the first version counts the whole doc as added
      if (version.added) stats.append(el('span', 'pj-plus', `+${version.added}`));
      if (version.removed) stats.append(el('span', 'pj-minus', `−${version.removed}`));
    }
    stats.title = 'Characters added and removed';
    li.append(face, top, when);
    const note = describe(version);
    if (note || stats.childNodes.length) {
      const what = el('span', 'pj-version-what');
      if (note) what.append(el('span', 'pj-version-note', note));
      what.append(stats);
      li.append(what);
    }
    li.addEventListener('click', () => select(version.id));
    return li;
  }

  function markSelected() {
    for (const li of list.querySelectorAll('.pj-version')) {
      const on = li.dataset.id === selected;
      li.setAttribute('aria-selected', String(on));
      if (on) list.setAttribute('aria-activedescendant', li.id = `pj-version-${li.dataset.id}`);
    }
  }

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [...list.querySelectorAll('.pj-version')];
    const at = rows.findIndex((li) => li.dataset.id === selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next && next.dataset.id !== selected) {
      next.scrollIntoView({ block: 'nearest' });
      select(next.dataset.id);
    }
  });

  // ---- the selected version ----

  async function select(id) {
    selected = id;
    markSelected();
    const load = ++loads;
    if (!id) {
      shown = null;
      view.applyText('');
      showChanges();
      showHeading();
      return;
    }
    let data;
    try {
      data = await api.version(id);
    } catch (error) {
      if (load === loads) heading.textContent = `Could not load this version: ${error.message}`;
      return;
    }
    const first = versions.find((v) => v.id === id)?.first;
    if (first && first !== id) data = { ...data, before: (await api.version(first).catch(() => ({ before: null }))).before };
    if (load !== loads) return; // another version was picked meanwhile
    shown = data;
    await makeView(); // the view for this version's length
    if (load !== loads) return;
    view.applyText(data.text);
    showChanges({ replay: true });
    showHeading();
  }

  function showChanges({ replay = false } = {}) {
    const edits = shown?.before != null && changesToggle.checked
      ? diffEdits(shown.before, shown.text).map((change) => change.edit)
      : [];
    view.setMarks(revisionMarks(shown?.text ?? '', edits, { replay: replay ? ++replays : 0 }));
  }

  // The selected row says which version this is; the bar offers to undo
  // its change (one with a version before it) and to restore it (not the
  // current one), and speaks up when something fails.
  function showHeading() {
    const version = shown?.version;
    heading.textContent = '';
    restoreButton.hidden = !version || version.id === latest()?.id;
    undoButton.hidden = shown?.before == null;
    restoreButton.disabled = undoButton.disabled = restoring;
  }

  changesToggle.addEventListener('change', () => showChanges({ replay: changesToggle.checked }));

  restoreButton.addEventListener('click', async () => {
    const version = shown?.version;
    if (!version || restoring) return;
    restoring = true;
    restoreButton.disabled = true;
    restoreButton.textContent = 'Restoring…';
    try {
      await onRestore(version.id);
      close();
    } catch (error) {
      heading.textContent = `Could not restore: ${error.message}`;
    } finally {
      restoring = false;
      restoreButton.textContent = 'Restore this version';
      showHeading();
    }
  });

  undoButton.addEventListener('click', async () => {
    const version = shown?.version;
    if (!version || restoring) return;
    restoring = true;
    showHeading();
    try {
      await onUndo(version.id, versions.find((v) => v.id === version.id)?.first);
      close();
    } catch (error) {
      heading.textContent = `Could not undo: ${error.message}`;
    } finally {
      restoring = false;
      showHeading();
    }
  });

  bar.querySelector('[data-action="close"]').addEventListener('click', close);
  toggleButton.addEventListener('click', () => (isOpen() ? close() : open()));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen() && !document.querySelector('dialog[open]')) {
      event.preventDefault();
      close();
    }
  });

  // ---- words ----

  function authorLabel(version) {
    if (version.authors) return version.authors.map((a) => a.name).join(', '); // people typing together
    if (version.author) return version.author.kind === 'agent' && version.author.id ? nameOf(version.author.id, version.author.name) : version.author.name;
    return version.kind === 'opened' ? 'Opened' : 'Outside Ponjo';
  }

  function describe(version) {
    if (version.kind === 'restore') {
      const from = versions.find((v) => v.ids.includes(version.restoredFrom));
      if (!from) return 'Restored an earlier version';
      const day = dayLabel(from.at);
      return `Restored ${day === dayLabel(version.at) ? '' : `${day.toLowerCase()}, `}${time.format(new Date(from.at))}`;
    }
    if (version.kind === 'undo') return 'Undid a change';
    const comment = version.thread && commentOf(version.thread);
    return comment ? `On “${comment.replace(/\s+/g, ' ').trim()}”` : '';
  }

  return {
    open, close, changed, isOpen,
    toggle: () => (isOpen() ? close() : open()),
    /** The doc may open in another view now. */
    viewChanged: () => (isOpen() ? makeView() : undefined),
  };
}

// `list` (versions, oldest first) as rows: a burst of typing (see
// BURST_GAP_MS) is one, its last version with `first`, the first's id,
// `startedAt`, when it began, `ids`, each version's, and what they all
// added and removed.
function rowsOf(list) {
  const rows = [];
  for (const v of list) {
    const row = rows.at(-1);
    if (row && typing(row) && typing(v) && sameAuthors(row, v) && Date.parse(v.at) - Date.parse(row.at) < BURST_GAP_MS && Date.parse(v.at) - Date.parse(row.startedAt) < BURST_SPAN_MS) {
      rows[rows.length - 1] = { ...v, first: row.first, startedAt: row.startedAt, ids: [...row.ids, v.id], added: row.added + v.added, removed: row.removed + v.removed };
    } else rows.push({ ...v, first: v.id, startedAt: v.startedAt ?? v.at, ids: [v.id] }); // an older version may span a burst itself
  }
  return rows;
}

const typing = (v) => v.kind === 'edit' && !v.reply;
const authorsOf = (v) => (v.authors ?? (v.author ? [v.author] : [])).map((a) => `${a.kind} ${(a.id ?? a.name).toLowerCase()}`).sort().join();
const sameAuthors = (a, b) => authorsOf(a) !== '' && authorsOf(a) === authorsOf(b);

function timeRange(version) {
  const start = new Date(version.startedAt);
  const end = new Date(version.at);
  const from = time.format(start);
  const to = time.format(end);
  return from === to || dayLabel(version.startedAt) !== dayLabel(version.at) ? to : `${from} – ${to}`;
}

function dayLabel(iso) {
  const at = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const ago = Math.round((today - day) / DAY_MS);
  if (ago === 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return at.getFullYear() === today.getFullYear() ? date.format(at) : dateWithYear.format(at);
}

function el(tag, className, text, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
