// The sidebar of a desktop folder window: the folder's files as a tree, read
// a folder at a time as it opens, the open one marked, and light file
// management: new file, rename and delete (from its menu), and move (drag). The app does each
// on disk and checks it; the page only names files and folders by their
// place in the folder. Clicking a file asks the app to show it in this
// window as a doc (the page is replaced by that doc's); a file that is not
// one (not text, or too large) shows here, read only, in place of the doc.
// The app keeps which subfolders are open, whether the sidebar shows and how
// far it was scrolled, so the next page draws it just as this one left it.

import { icon } from './icons.js';

const DRAG_SLOP_PX = 4;
const OPEN_ON_HOVER_MS = 700;
const SCROLL_EDGE_PX = 28; // a drag this close to the tree's top or bottom scrolls it
const FILTER_KEY = 'opendoc.filesFilter:'; // + the folder's name: what was typed in its filter
const WIDTH_KEY = 'opendoc.filesWidth'; // the sidebar width the human dragged to, in px
const MIN_WIDTH_PX = 180;
const MAX_WIDTH_PX = 480;
const isMac = /Mac/.test(navigator.platform);
const NOT_SHOWN = {
  large: 'This file is too large to show here.',
  binary: 'This file is not text, so it can’t be shown here.',
};

/**
 * Set up the sidebar; in a window with a single doc, it stays hidden. `onCarry(carry)` hears how the last page in this window left
 * things (`carry` from the app; `startTyping` when it made this doc), once; `onError(message)` hears what could
 * not be done. Returns `ready`, which resolves once the sidebar is drawn,
 * and `state()`, how this page leaves it.
 */
export function createFileList({ onError = () => {}, onCarry = () => {} } = {}) {
  const desktop = window.opendocDesktop;
  const aside = document.querySelector('.od-files');
  const head = aside.querySelector('.od-files-head');
  const tree = aside.querySelector('.od-files-tree');
  const filter = aside.querySelector('.od-files-filter');
  const toggle = document.querySelector('.od-files-toggle');
  const preview = document.querySelector('.od-preview');
  const previewName = document.querySelector('.od-preview-name');
  if (!desktop?.folder) return { ready: Promise.resolve(), state: () => ({}) };
  let view = null;
  let lists = new Map(); // what the top folder ('') and each open subfolder hold: [{ name, folder }]
  let first = true;
  // In a narrow window the sidebar floats over the page instead of beside
  // it: closed until the toggle opens it, closed again by the toggle, Escape
  // or a click outside it. Opening it there leaves the wide window's choice
  // (`docked`, which the app keeps) alone.
  const narrow = window.matchMedia('(max-width: 900px)');
  let docked = false;
  let floating = false;
  let field = null; // the name being typed, if any: a redraw waits for it
  let stale = false; // the folder changed while a name was being typed
  let focusNext = null; // the row to focus once the tree is drawn again
  let created = null; // the doc just made here, which the next page opens ready to type in
  let previewing = null; // the file shown read only, if any
  let drag = null;
  let justDragged = false;
  let everything = null; // every file's path, read once a filter is typed, dropped when the folder changes

  async function refresh() {
    if (field) {
      stale = true;
      return;
    }
    try {
      view = await desktop.folder();
      if (view) lists = await load(new Set(view.expanded));
      everything = null;
      if (view && filter.value) everything = await allFiles();
    } catch {
      view = null;
    }
    toggle.hidden = !view;
    if (!view) {
      aside.hidden = true;
      document.documentElement.removeAttribute('data-files');
      return;
    }
    if (first) {
      try {
        filter.value = localStorage.getItem(FILTER_KEY + view.name) ?? '';
      } catch {
        // no storage: an empty filter
      }
      if (filter.value) everything = await allFiles();
    }
    aside.querySelector('.od-files-name').textContent = view.name;
    aside.querySelector('.od-files-name').title = view.name;
    if (previewing && lists.get(parentOf(previewing))?.some(({ name }) => name === nameOf(previewing)) === false) closePreview();
    const focused = tree.contains(document.activeElement) ? document.activeElement.closest('[role="treeitem"]')?.dataset.path : null;
    tree.replaceChildren(...(filter.value ? matches() : items('', 1)));
    const wanted = focusNext ?? focused;
    focusNext = null;
    const target = (wanted !== null && wanted !== undefined && visibleRow(wanted)) || null;
    rove(target ?? visibleRow(shown() ?? '') ?? rows()[0] ?? null);
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
    }
    show(view.sidebar);
    if (first && view.carry) {
      tree.scrollTop = view.carry.sidebarScroll ?? 0;
      onCarry(view.carry);
    } else if (first) {
      tree.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    }
    first = false;
  }

  // What the top folder and each open subfolder in it hold.
  async function load(expanded) {
    const loaded = new Map();
    async function read(path) {
      const entries = await desktop.folderList(path).catch(() => []);
      loaded.set(path, entries);
      await Promise.all(entries.filter(({ name, folder }) => folder && expanded.has(join(path, name)))
        .map(({ name }) => read(join(path, name))));
    }
    await read('');
    return loaded;
  }

  // ---- filtering: grep the files' paths with a regular expression ----

  async function allFiles() {
    const paths = [];
    async function read(path) {
      const entries = await desktop.folderList(path).catch(() => []);
      await Promise.all(entries.map(({ name, folder }) => (folder ? read(join(path, name)) : paths.push(join(path, name)))));
    }
    await read('');
    return paths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  }

  // The files whose path matches the filter, in their folders, all open, the
  // match marked. Case is ignored until the pattern has a capital letter. A
  // pattern that is not a regular expression is marked and shows what the
  // last one did.
  function matches() {
    let pattern;
    try {
      pattern = new RegExp(filter.value, /[A-Z]/.test(filter.value) ? 'g' : 'gi');
    } catch {
      filter.setAttribute('aria-invalid', 'true');
      return [...tree.children];
    }
    filter.removeAttribute('aria-invalid');
    const found = everything.filter((path) => {
      pattern.lastIndex = 0;
      return pattern.test(path);
    });
    if (!found.length) return [el('li', 'od-files-none', 'No files match')];
    function branch(paths, base, level) {
      const names = [...new Set(paths.map((path) => path.slice(base.length).split('/')[0]))];
      return names.map((name) => {
        const at = join(base.replace(/\/$/, ''), name);
        const inside = paths.filter((path) => path.startsWith(`${at}/`));
        const item = el('li');
        item.setAttribute('role', 'none');
        const node = row(inside.length ? 'folder' : 'file', at, inside.length ? name : '', level);
        item.append(node);
        if (inside.length) {
          node.setAttribute('aria-expanded', 'true');
          const children = el('ul');
          children.setAttribute('role', 'group');
          children.append(...branch(inside, `${at}/`, level + 1));
          item.append(children);
        } else {
          const label = node.querySelector('.od-files-label');
          let from = 0;
          pattern.lastIndex = 0;
          const hits = [...at.matchAll(pattern)].filter(({ 0: hit }) => hit);
          for (const { 0: hit, index } of hits) {
            const start = index - (at.length - name.length);
            if (start + hit.length <= 0 || start < from) continue;
            const begin = Math.max(start, 0);
            label.append(name.slice(from, begin), el('mark', '', name.slice(begin, start + hit.length)));
            from = start + hit.length;
          }
          label.append(name.slice(from));
          if (at === shown()) node.setAttribute('aria-current', 'page');
        }
        return item;
      });
    }
    return branch(found, '', 1);
  }

  async function applyFilter() {
    if (filter.value && !everything) everything = await allFiles();
    tree.replaceChildren(...(filter.value ? matches() : items('', 1)));
    rove(visibleRow(shown() ?? '') ?? rows()[0] ?? null);
  }
  filter.addEventListener('input', () => {
    try {
      localStorage.setItem(FILTER_KEY + view.name, filter.value);
    } catch {
      // no storage: the filter lasts for this page
    }
    applyFilter();
  });
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      filter.value = '';
      filter.dispatchEvent(new Event('input'));
      focusRow(rows()[0]);
    } else if (event.key === 'ArrowDown' || (event.key === 'Enter' && !event.isComposing)) {
      event.preventDefault();
      focusRow(rows()[0]);
    }
  });

  function show(open) {
    docked = open;
    draw();
  }

  function draw() {
    const open = narrow.matches ? floating : docked;
    aside.hidden = !open;
    document.documentElement.toggleAttribute('data-files', docked && !narrow.matches);
    toggle.setAttribute('aria-pressed', String(open));
    toggle.dataset.tip = open ? 'Hide files' : 'Show files';
    window.dispatchEvent(new Event('resize')); // the comment margin re-lays out
  }

  // Show the sidebar if it is hidden, to name something in it.
  function reveal() {
    if (!aside.hidden) return;
    if (narrow.matches) {
      floating = true;
      draw();
      return;
    }
    show(true);
    desktop.showSidebar(true).catch(() => {});
  }

  // ---- drawing ----

  // A row: a file or a folder, named by `path`, its place in the folder.
  function row(kind, path, label, level) {
    const node = el('div', `od-files-row od-files-${kind}`);
    node.setAttribute('role', 'treeitem');
    node.setAttribute('aria-level', String(level));
    node.tabIndex = -1;
    node.title = path;
    node.dataset.path = path;
    node.dataset.kind = kind;
    if (kind === 'folder') node.append(icon('chevron', 'od-icon od-files-chevron'));
    node.append(icon(kind), el('span', 'od-files-label', label));
    return node;
  }

  // What the folder `path` holds, as rows: a subfolder with what is in it, when open.
  function items(path, level) {
    return (lists.get(path) ?? []).map(({ name, folder }) => {
      const at = join(path, name);
      const item = el('li');
      item.setAttribute('role', 'none');
      const node = row(folder ? 'folder' : 'file', at, name, level);
      item.append(node);
      if (folder) {
        const open = lists.has(at);
        node.setAttribute('aria-expanded', String(open));
        const children = el('ul');
        children.setAttribute('role', 'group');
        if (open) children.append(...items(at, level + 1));
        children.hidden = !open;
        item.append(children);
      } else if (at === shown()) {
        node.setAttribute('aria-current', 'page');
      }
      return item;
    });
  }

  // ---- rows, focus and opening ----

  const rows = () => [...tree.querySelectorAll('.od-files-row[data-path]')].filter((node) => !node.closest('[hidden]'));
  const rowFor = (path) => tree.querySelector(`.od-files-row[data-path="${CSS.escape(path)}"]`);
  const visibleRow = (path) => rows().find((node) => node.dataset.path === path) ?? null;
  const shown = () => previewing ?? view?.current;

  // One row takes Tab; the arrows move between the others.
  function rove(node) {
    for (const other of tree.querySelectorAll('.od-files-row[tabindex="0"]')) other.tabIndex = -1;
    if (node) node.tabIndex = 0;
  }

  function focusRow(node) {
    if (!node) return;
    rove(node);
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest' });
  }

  // Open or close a folder; one not read since it was last open is read first.
  async function setOpen(node, open) {
    const { path } = node.dataset;
    if (filter.value || node.getAttribute('aria-expanded') === String(open)) return; // a filter keeps every folder open
    desktop.folderExpand(path, open).catch(() => {});
    if (open && !lists.has(path)) {
      lists.set(path, await desktop.folderList(path).catch(() => []));
      node.nextElementSibling.replaceChildren(...items(path, Number(node.getAttribute('aria-level')) + 1));
    }
    node.setAttribute('aria-expanded', String(open));
    node.nextElementSibling.hidden = !open;
  }

  function markShown() {
    for (const node of tree.querySelectorAll('.od-files-file')) {
      if (node.dataset.path === shown()) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
  }

  // Open the file as a doc, or show it read only when it is not one.
  function openFile(node) {
    const path = node.dataset.path;
    if (path === view.current) return void closePreview();
    node.setAttribute('aria-busy', 'true');
    // The page saves any edit still on its way before it is replaced.
    desktop.openInFolder(path).then((opened) => opened || showFile(path))
      .catch((error) => onError(`Could not open ${nameOf(path)}: ${reason(error)}`))
      .finally(() => node.removeAttribute('aria-busy'));
  }

  // Show the file `path` read only, in place of the doc.
  async function showFile(path) {
    previewing = path;
    markShown();
    const result = await desktop.folderRead(path).catch((error) => ({ error: reason(error) }));
    if (previewing !== path) return;
    if (result.error) {
      closePreview();
      onError(`Could not open ${nameOf(path)}: ${result.error}`);
      return;
    }
    previewName.textContent = nameOf(path);
    preview.replaceChildren(result.problem ? el('p', 'od-preview-note', NOT_SHOWN[result.problem]) : el('pre', 'od-preview-text', result.text));
    document.documentElement.setAttribute('data-preview', '');
    preview.scrollIntoView({ block: 'start' });
    if (floating) closeFloating();
  }

  function closePreview() {
    if (!previewing) return;
    previewing = null;
    document.documentElement.removeAttribute('data-preview');
    preview.replaceChildren();
    markShown();
  }

  function activate(node) {
    if (node.dataset.kind === 'folder') setOpen(node, node.getAttribute('aria-expanded') !== 'true');
    else openFile(node);
  }

  function menu(node, at = null) {
    const kind = node ? node.dataset.kind : 'root';
    desktop.folderMenu(node ? node.dataset.path : '', kind, at?.x ?? null, at?.y ?? null).catch(() => {});
  }

  async function trash(node) {
    const after = rows();
    const at = after.indexOf(node);
    const result = await desktop.folderTrash(node.dataset.path, node.dataset.kind).catch((error) => ({ error: reason(error) }));
    if (result?.error) onError(result.error);
    if (!result?.trashed) return;
    // Keep the keyboard where it was: on the row that takes this one's place.
    const path = node.dataset.path;
    const next = [...after.slice(at + 1), ...after.slice(0, at).reverse()]
      .find((other) => other.dataset.path !== path && !other.dataset.path.startsWith(`${path}/`));
    focusNext = next?.dataset.path ?? null;
    if (previewing === path || previewing?.startsWith(`${path}/`)) closePreview();
    refresh();
  }

  // Rename or move `path` to `to`; what is shown read only follows it.
  async function move(path, kind, to) {
    const result = await desktop.folderRename(path, kind, to);
    if (result?.rel && (previewing === path || previewing?.startsWith(`${path}/`))) previewing = result.rel + previewing.slice(path.length);
    return result;
  }

  // ---- naming: new files and renames ----

  // Why `typed` (a path in folder `base`) can't name a file other than
  // `except`, as far as the page can tell (the app checks again, and for the
  // characters an OS refuses).
  function problem(typed, base, except = null) {
    const parts = typed.split('/').map((part) => part.trim());
    if (parts.some((part) => !part)) return 'Enter a name.';
    const path = join(base, parts.join('/'));
    const there = (lists.get(parentOf(path)) ?? []).some(({ name }) => join(parentOf(path), name) !== except
      && name.toLowerCase() === nameOf(path).toLowerCase());
    return there ? `${nameOf(path)} is already there.` : null;
  }

  /**
   * Turn `node`'s label into a name field, with `selection` ([start, end])
   * selected. `commit(typed)` resolves to { rel } or { error }; `cancel()`
   * runs when the field closes without one, as it does empty.
   */
  function nameField(node, { value, selection = [0, value.length], placeholder, label, check, commit, cancel = () => {} }) {
    const name = node.querySelector('.od-files-label');
    const input = el('input', 'od-files-input');
    Object.assign(input, { type: 'text', value, placeholder, spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', label);
    const error = el('div', 'od-files-error');
    error.id = `od-files-error-${Math.random().toString(36).slice(2)}`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    input.setAttribute('aria-describedby', error.id);
    name.hidden = true;
    name.after(input);
    node.after(error);
    node.classList.add('od-files-editing');
    let busy = false;
    field = { input };

    const say = (message) => {
      error.textContent = message ?? '';
      error.hidden = !message;
      input.setAttribute('aria-invalid', String(Boolean(message)));
    };
    const close = () => {
      if (field?.input !== input) return;
      field = null;
      input.remove();
      error.remove();
      name.hidden = false;
      node.classList.remove('od-files-editing');
    };
    const drop = () => {
      close();
      cancel();
      if (stale) refresh();
      stale = false;
    };
    async function submit(fromEnter) {
      if (busy) return;
      const typed = input.value.trim();
      if (!typed) return void drop();
      const local = check(typed);
      if (local) {
        if (fromEnter) return void say(local);
        return void drop();
      }
      busy = true;
      input.readOnly = true;
      node.setAttribute('aria-busy', 'true');
      const result = await commit(typed).catch((failure) => ({ error: reason(failure) }));
      busy = false;
      input.readOnly = false;
      node.removeAttribute('aria-busy');
      if (result?.error) {
        if (!fromEnter) {
          drop();
          onError(result.error);
          return;
        }
        say(result.error);
        input.focus();
        return;
      }
      focusNext = result?.rel ?? null;
      close();
      stale = false;
      refresh();
    }
    input.addEventListener('input', () => say(input.value.trim() ? check(input.value.trim()) : null));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation(); // the tree's keys stay out of the field
      if (event.key === 'Escape') {
        event.preventDefault();
        drop();
        focusRow(visibleRow(node.dataset.path ?? '') ?? rows()[0]);
      } else if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        submit(true);
      }
    });
    input.addEventListener('blur', () => {
      // The window went to the back: the name is still there to finish.
      if (!document.hasFocus() || busy || field?.input !== input) return;
      submit(false);
    });
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.focus();
    input.setSelectionRange(...selection);
  }

  function startRename(node) {
    if (field) return;
    const { kind, path } = node.dataset;
    const name = nameOf(path);
    const parent = parentOf(path);
    const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
    focusRow(node);
    nameField(node, {
      value: name,
      selection: [0, dot > 0 ? dot : name.length], // the name, not its extension
      placeholder: name,
      label: `Rename ${name}`,
      check: (typed) => problem(typed, parent, path),
      commit: async (typed) => (typed === name ? { rel: path } : move(path, kind, join(parent, typed))),
    });
  }

  async function startCreate(parent) {
    if (field || !view) return;
    reveal();
    const holder = parent ? rowFor(parent) : null;
    if (parent && !holder) return;
    if (holder) await setOpen(holder, true);
    const group = holder ? holder.nextElementSibling : tree;
    const item = el('li');
    item.setAttribute('role', 'none');
    const level = parent ? parent.split('/').length + 1 : 1;
    const node = row('file', '', '', level);
    delete node.dataset.path;
    node.classList.add('od-files-new');
    item.append(node);
    // First among the files, under the folders.
    group.insertBefore(item, [...group.children].find((child) => child.querySelector(':scope > .od-files-file')) ?? null);
    nameField(node, {
      value: '',
      placeholder: 'Name',
      label: 'New file name',
      check: (typed) => problem(typed, parent),
      commit: (typed) => {
        created = true; // an empty file is text: it opens as a doc
        return desktop.folderCreate(parent, typed).finally(() => { created = null; });
      },
      cancel: () => item.remove(),
    });
    item.scrollIntoView({ block: 'nearest' });
  }

  // ---- dragging to move ----

  // The folder a drop at `x`, `y` goes to ('' for the top), or null for none.
  function dropTarget(x, y) {
    const under = document.elementFromPoint(x, y);
    if (!under || !aside.contains(under)) return null;
    const node = under.closest('.od-files-row[data-path]');
    if (node) return node.dataset.kind === 'folder' ? node.dataset.path : parentOf(node.dataset.path);
    return under.closest('.od-files-tree, .od-files-head') ? '' : null;
  }

  function startDrag() {
    drag.started = true;
    const ghost = el('div', 'od-files-ghost');
    ghost.append(icon(drag.kind), el('span', null, nameOf(drag.path)));
    document.body.append(ghost);
    drag.ghost = ghost;
    drag.node.classList.add('od-files-dragged');
    aside.classList.add('od-files-dragging');
    const scroll = () => {
      if (!drag?.started) return;
      if (drag.speed) tree.scrollTop += drag.speed;
      drag.frame = requestAnimationFrame(scroll);
    };
    drag.frame = requestAnimationFrame(scroll);
  }

  function moveDrag(x, y) {
    drag.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    const target = dropTarget(x, y);
    const { path, kind } = drag;
    const ok = target !== null && target !== parentOf(path)
      && !(kind === 'folder' && (target === path || target.startsWith(`${path}/`)));
    drag.target = ok ? target : null;
    const lit = ok ? (target ? rowFor(target) : head) : null;
    if (lit !== drag.lit) {
      drag.lit?.classList.remove('od-files-drop');
      lit?.classList.add('od-files-drop');
      drag.lit = lit;
    }
    aside.classList.toggle('od-files-nodrop', !ok);
    // A closed folder held under the pointer opens.
    const hovered = target ? rowFor(target) : null;
    if (hovered !== drag.hovered) {
      clearTimeout(drag.opener);
      drag.hovered = hovered;
      if (hovered?.getAttribute('aria-expanded') === 'false') drag.opener = setTimeout(() => setOpen(hovered, true), OPEN_ON_HOVER_MS);
    }
    const box = tree.getBoundingClientRect();
    drag.speed = y < box.top + SCROLL_EDGE_PX ? -8 : y > box.bottom - SCROLL_EDGE_PX ? 8 : 0;
  }

  function endDrag(drop) {
    const done = drag;
    drag = null;
    if (!done?.started) return;
    cancelAnimationFrame(done.frame);
    clearTimeout(done.opener);
    done.ghost.remove();
    done.lit?.classList.remove('od-files-drop');
    done.node.classList.remove('od-files-dragged');
    aside.classList.remove('od-files-dragging', 'od-files-nodrop');
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    if (!drop || done.target === null) return;
    const name = nameOf(done.path);
    move(done.path, done.kind, join(done.target, name))
      .then((result) => {
        if (result?.error) return onError(result.error);
        focusNext = result.rel;
        return refresh();
      })
      .catch((error) => onError(`Could not move ${name}: ${reason(error)}`));
  }

  tree.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || field) return;
    const node = event.target.closest('.od-files-row[data-path]');
    if (!node) return;
    drag = { node, path: node.dataset.path, kind: node.dataset.kind, x: event.clientX, y: event.clientY, pointerId: event.pointerId, started: false, target: null };
  });
  document.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_SLOP_PX) return;
      startDrag();
    }
    event.preventDefault();
    moveDrag(event.clientX, event.clientY);
  });
  document.addEventListener('pointerup', (event) => {
    if (drag && event.pointerId === drag.pointerId) endDrag(true);
  });
  document.addEventListener('pointercancel', () => endDrag(false));
  window.addEventListener('blur', () => endDrag(false));

  // ---- clicks, menus and keys ----

  tree.addEventListener('click', (event) => {
    if (justDragged) return;
    const node = event.target.closest('.od-files-row[data-path]');
    if (!node) return;
    rove(node);
    activate(node);
  });
  aside.addEventListener('contextmenu', (event) => {
    if (field || event.target.closest('input')) return;
    const node = event.target.closest('.od-files-row[data-path]');
    if (!node && !event.target.closest('.od-files-tree')) return;
    event.preventDefault();
    if (node) rove(node);
    menu(node);
  });
  tree.addEventListener('keydown', (event) => {
    const node = event.target.closest?.('.od-files-row[data-path]');
    if (!node || field || event.target !== node) return;
    const list = rows();
    const at = list.indexOf(node);
    const folder = node.dataset.kind === 'folder';
    const open = node.getAttribute('aria-expanded') === 'true';
    const key = event.key;
    if (key === 'ArrowDown') focusRow(list[at + 1]);
    else if (key === 'ArrowUp') focusRow(list[at - 1]);
    else if (key === 'Home') focusRow(list[0]);
    else if (key === 'End') focusRow(list.at(-1));
    else if (key === 'ArrowRight' && folder) {
      if (!open) setOpen(node, true);
      else focusRow(list[at + 1]?.dataset.path.startsWith(`${node.dataset.path}/`) ? list[at + 1] : null);
    } else if (key === 'ArrowLeft') {
      if (folder && open) setOpen(node, false);
      else focusRow(visibleRow(parentOf(node.dataset.path)));
    } else if (key === 'Enter' || key === ' ') activate(node);
    else if (key === 'F2') startRename(node);
    else if (key === 'Delete' || (isMac && key === 'Backspace' && event.metaKey)) trash(node);
    else if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey)) {
      const box = node.getBoundingClientRect();
      menu(node, { x: box.left + 24, y: box.bottom });
    } else return;
    event.preventDefault();
  });
  tree.addEventListener('focusin', (event) => {
    const node = event.target.closest?.('.od-files-row[data-path]');
    if (node) rove(node);
  });

  desktop.onFolderCommand(({ action, rel }) => {
    const node = rel ? rowFor(rel) : null;
    if (action === 'rename' && node) startRename(node);
    else if (action === 'newFile') startCreate(rel);
  });

  // ---- showing and hiding ----

  toggle.addEventListener('click', () => {
    if (narrow.matches) {
      floating = aside.hidden;
      draw();
      return;
    }
    show(aside.hidden);
    desktop.showSidebar(docked).catch(() => {});
  });
  const closeFloating = () => {
    floating = false;
    draw();
  };
  narrow.addEventListener('change', () => {
    floating = false;
    if (view) draw();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (drag?.started) {
      endDrag(false);
    } else if (floating) {
      closeFloating();
      toggle.focus();
    } else {
      closePreview();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (floating && !aside.contains(event.target) && !toggle.contains(event.target)) closeFloating();
  });
  // ---- width ----

  // Drag the sidebar's edge to resize it; double-click it for the default
  // width back. Every window shares the width last dragged to.
  const handle = aside.querySelector('.od-files-resize');
  const setWidth = (px) => {
    if (px) document.documentElement.style.setProperty('--files-w', `${px}px`);
    else document.documentElement.style.removeProperty('--files-w');
    window.dispatchEvent(new Event('resize')); // the comment margin re-lays out
  };
  try {
    setWidth(Number(localStorage.getItem(WIDTH_KEY)) || 0);
  } catch {
    // no storage: the default width
  }
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('od-files-resizing');
    let width = 0;
    const move = (e) => {
      width = Math.round(Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, e.clientX)));
      setWidth(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('lostpointercapture', () => {
      handle.removeEventListener('pointermove', move);
      document.documentElement.classList.remove('od-files-resizing');
      try {
        if (width) localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // no storage: the width lasts for this page
      }
    }, { once: true });
  });
  handle.addEventListener('dblclick', () => {
    setWidth(0);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      // no storage: nothing kept
    }
  });

  desktop.onFolderChanged(refresh);
  return { ready: refresh(), state: () => ({ sidebarScroll: tree.scrollTop, startTyping: Boolean(created) }) };
}

const parentOf = (path) => path.split('/').slice(0, -1).join('/');
const nameOf = (path) => path.split('/').at(-1);
const join = (folder, name) => (folder ? `${folder}/${name}` : name);

// An error from the app, without Electron's "Error invoking remote method" wrapping.
const reason = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
