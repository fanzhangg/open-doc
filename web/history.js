// Version history: every version of the doc (src/store/history.js), who made
// it and what it changed. A version shows read-only in a second view, with
// what it changed from the version before marked as a revision (added text
// highlighted, removed text struck through); any earlier version can be
// restored, which adds a new version, so a restore can be undone the same way.

import { diffEdits } from '../src/core/diff.js';
import { revisionMarks } from './marks.js';
import { icon } from './icons.js';
import { avatar } from './threads.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const dateWithYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * `api` is web/api.js; `chooseView()` is the view the doc opens in (viewFor
 * in web/plugins/index.js); `commentOf(threadId)` is the text of the comment
 * a buddy's version answered, or null; `onRestore(id)` puts the doc back to
 * version `id` and resolves once the page shows it.
 */
export function createHistory({ api, chooseView, commentOf, onRestore, onClose }) {
  const root = document.documentElement;
  const stage = document.querySelector('.od-history-stage');
  const list = stage.querySelector('.od-history-list');
  const bar = document.querySelector('.od-history-bar');
  const heading = bar.querySelector('.od-history-heading');
  const restoreButton = bar.querySelector('[data-action="restore"]');
  const changesToggle = bar.querySelector('.od-history-changes input');
  const toggleButton = document.querySelector('.od-tool-history');

  let view = null; // the read-only view, made when history first opens
  let viewId; // the plugin `view` is of (null: the plain view)
  let versions = [];
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

  // The view, made again when the doc opens in another one (a plugin was
  // switched); one at a time.
  let making = Promise.resolve();
  function makeView() {
    making = making.catch(() => {}).then(remakeView);
    return making;
  }

  async function remakeView() {
    const chosen = chooseView();
    if (view && chosen.id === viewId) return;
    const old = view;
    view = await chosen.createView({ stage, text: '', editable: false, settings: chosen.settings });
    viewId = chosen.id;
    await old?.destroy();
    view.applyText(shown?.text ?? ''); // the version picked by now
    showChanges();
  }

  async function refresh() {
    try {
      versions = await api.history();
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
        items.push(el('li', 'od-history-day', label, { role: 'presentation' }));
      }
      items.push(row(version, version === current));
    }
    if (items.length === 0) items.push(el('li', 'od-history-empty', 'No versions yet.'));
    list.replaceChildren(...items);
    markSelected();
  }

  function row(version, current) {
    const li = el('li', 'od-version', null, { role: 'option', 'data-id': version.id });
    const face = version.author ? avatar(version.author.name, version.author.kind, true) : el('span', 'od-avatar od-avatar-small od-version-outside');
    if (!version.author) face.append(icon(version.kind === 'opened' ? 'file' : 'history'));
    const who = el('span', 'od-version-who', authorLabel(version));
    const when = el('span', 'od-version-time', timeRange(version));
    const top = el('span', 'od-version-top');
    top.append(who);
    if (current) top.append(el('span', 'od-version-tag', 'Current'));
    const stats = el('span', 'od-version-stats');
    if (version.kind !== 'opened') { // the first version counts the whole doc as added
      if (version.added) stats.append(el('span', 'od-plus', `+${version.added}`));
      if (version.removed) stats.append(el('span', 'od-minus', `−${version.removed}`));
    }
    stats.title = 'Characters added and removed';
    li.append(face, top, when);
    const note = describe(version);
    if (note || stats.childNodes.length) {
      const what = el('span', 'od-version-what');
      if (note) what.append(el('span', 'od-version-note', note));
      what.append(stats);
      li.append(what);
    }
    li.addEventListener('click', () => select(version.id));
    return li;
  }

  function markSelected() {
    for (const li of list.querySelectorAll('.od-version')) {
      const on = li.dataset.id === selected;
      li.setAttribute('aria-selected', String(on));
      if (on) list.setAttribute('aria-activedescendant', li.id = `od-version-${li.dataset.id}`);
    }
  }

  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [...list.querySelectorAll('.od-version')];
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
    if (load !== loads) return; // another version was picked meanwhile
    shown = data;
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

  // The selected row says which version this is; the bar only offers to
  // restore it (not the current one) and speaks up when something fails.
  function showHeading() {
    const version = shown?.version;
    heading.textContent = '';
    restoreButton.hidden = !version || version.id === latest()?.id;
    restoreButton.disabled = restoring;
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
    if (version.author) return version.author.name;
    return version.kind === 'opened' ? 'Opened' : 'Outside OpenDoc';
  }

  function describe(version) {
    if (version.kind === 'restore') {
      const from = versions.find((v) => v.id === version.restoredFrom);
      if (!from) return 'Restored an earlier version';
      const day = dayLabel(from.at);
      return `Restored ${day === dayLabel(version.at) ? '' : `${day.toLowerCase()}, `}${time.format(new Date(from.at))}`;
    }
    if (version.kind === 'undo') return 'Undid a buddy\'s edit';
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
