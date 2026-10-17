// The sidebar of a desktop folder window: the folder's docs as a tree, the
// open one marked, and light file management: new
// doc and new folder, rename, move (drag, or Move To…) and delete. The app
// does each on disk and checks it; the page only names docs and folders by
// their place in the folder. Clicking a doc asks the app to show it in this
// window (the page is replaced by that doc's); the app keeps which subfolders
// are open, whether the sidebar shows and how far it was scrolled, so the
// next page draws it just as this one left it.

import { icon } from './icons.js';

const DOC_EXTENSION = /\.(md|markdown)$/i;
const DRAG_SLOP_PX = 4;
const OPEN_ON_HOVER_MS = 700;
const SCROLL_EDGE_PX = 28; // a drag this close to the tree's top or bottom scrolls it
const isMac = /Mac/.test(navigator.platform);
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
  const toggle = document.querySelector('.od-files-toggle');
  if (!desktop?.folder) return { ready: Promise.resolve(), state: () => ({}) };
  let view = null;
  let folders = new Set(); // every folder the tree shows
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
  let picker = null; // the open Move To… list, if any
  let drag = null;
  let justDragged = false;
  let created = null; // the doc just made here, which the next page opens ready to type in

  async function refresh() {
    if (field) {
      stale = true;
      return;
    }
    try {
      view = await desktop.folder();
    } catch {
      view = null;
    }
    toggle.hidden = !view;
    if (!view) {
      aside.hidden = true;
      document.documentElement.removeAttribute('data-files');
      return;
    }
    aside.querySelector('.od-files-name').textContent = view.name;
    aside.querySelector('.od-files-name').title = view.name;
    const more = aside.querySelector('.od-files-more');
    more.hidden = !view.truncated;
    more.textContent = view.truncated ? `Showing the first ${view.docs.length} docs.` : '';
    const focused = tree.contains(document.activeElement) ? document.activeElement.closest('[role="treeitem"]')?.dataset.path : null;
    const root = nest(view.docs, view.folders ?? []);
    folders = allFolders(root);
    tree.replaceChildren(...items(root, '', new Set(view.expanded), 1));
    if (view.docs.length === 0 && folders.size === 0) tree.append(el('li', 'od-files-empty', 'No docs in this folder'));
    const wanted = focusNext ?? focused;
    focusNext = null;
    const target = (wanted !== null && wanted !== undefined && visibleRow(wanted)) || null;
    rove(target ?? visibleRow(view.current ?? '') ?? rows()[0] ?? null);
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

  function show(open) {
    docked = open;
    draw();
  }

  function draw() {
    const open = narrow.matches ? floating : docked;
    aside.hidden = !open;
    document.documentElement.toggleAttribute('data-files', docked && !narrow.matches);
    toggle.setAttribute('aria-pressed', String(open));
    toggle.dataset.tip = open ? 'Hide docs' : 'Show docs';
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

  // A row: a doc or a folder, named by `path`, its place in the folder.
  function row(kind, path, label, level) {
    const node = el('div', `od-files-row od-files-${kind}`);
    node.setAttribute('role', 'treeitem');
    node.setAttribute('aria-level', String(level));
    node.tabIndex = -1;
    node.title = path;
    node.dataset.path = path;
    node.dataset.kind = kind;
    const actions = el('span', 'od-files-actions');
    actions.setAttribute('aria-hidden', 'true'); // Shift+F10 opens the same menu
    actions.dataset.tip = 'More';
    actions.append(icon('more'));
    if (kind === 'folder') node.append(icon('chevron', 'od-icon od-files-chevron'));
    node.append(icon(kind === 'folder' ? 'folder' : 'file'), el('span', 'od-files-label', label), actions);
    return node;
  }

  // A subfolder's row and, below it, what is in it.
  function folderItem(name, node, path, expanded, level) {
    const item = el('li');
    item.setAttribute('role', 'none');
    const open = expanded.has(path);
    const heading = row('folder', path, name, level);
    heading.setAttribute('aria-expanded', String(open));
    const children = el('ul');
    children.setAttribute('role', 'group');
    const inside = items(node, `${path}/`, expanded, level + 1);
    if (inside.length) {
      children.append(...inside);
    } else {
      const empty = el('li', 'od-files-empty-folder');
      empty.setAttribute('role', 'none');
      const start = el('button', 'od-files-link', 'New doc');
      start.type = 'button';
      start.tabIndex = -1;
      start.addEventListener('click', () => startCreate(path, 'doc'));
      empty.append(el('span', null, 'No docs yet · '), start);
      children.append(empty);
    }
    children.hidden = !open;
    item.append(heading, children);
    return item;
  }

  function docItem(name, path, level) {
    const item = el('li');
    item.setAttribute('role', 'none');
    const node = row('doc', path, name.replace(DOC_EXTENSION, ''), level);
    if (path === view.current) node.setAttribute('aria-current', 'page');
    item.append(node);
    return item;
  }

  function items(node, prefix, expanded, level) {
    return [
      ...[...node.folders].map(([name, child]) => folderItem(name, child, prefix + name, expanded, level)),
      ...node.docs.map((name) => docItem(name, prefix + name, level)),
    ];
  }

  // ---- rows, focus and opening ----

  const rows = () => [...tree.querySelectorAll('.od-files-row[data-path]')].filter((node) => !node.closest('[hidden]'));
  const rowFor = (path) => tree.querySelector(`.od-files-row[data-path="${CSS.escape(path)}"]`);
  const visibleRow = (path) => rows().find((node) => node.dataset.path === path) ?? null;
  const labelOf = (node) => node.querySelector('.od-files-label').textContent;

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

  function setOpen(node, open) {
    if (node.getAttribute('aria-expanded') === String(open)) return;
    node.setAttribute('aria-expanded', String(open));
    node.nextElementSibling.hidden = !open;
    desktop.folderExpand(node.dataset.path, open).catch(() => {});
  }

  function openDoc(node) {
    const path = node.dataset.path;
    if (path === view.current) return;
    node.setAttribute('aria-busy', 'true');
    // The page saves any edit still on its way before it is replaced.
    desktop.openInFolder(path).catch((error) => onError(`Could not open ${labelOf(node)}: ${reason(error)}`))
      .finally(() => node.removeAttribute('aria-busy'));
  }

  function activate(node) {
    if (node.dataset.kind === 'folder') setOpen(node, node.getAttribute('aria-expanded') !== 'true');
    else openDoc(node);
  }

  // The folder a new doc goes in: the focused folder, the focused doc's, or the open doc's.
  function hereFolder() {
    const focused = tree.contains(document.activeElement) ? document.activeElement.closest('[role="treeitem"]') : null;
    if (focused?.dataset.kind === 'folder') return focused.dataset.path;
    return parentOf(focused?.dataset.path ?? view?.current ?? '');
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
    refresh();
  }

  // ---- naming: new docs and folders, and renames ----

  // The names already in folder `parent` (lowercase), but `except`.
  function taken(parent, except = null) {
    const names = new Set();
    for (const path of [...view.docs, ...folders]) {
      if (parentOf(path) === parent && path !== except) names.add(path.split('/').at(-1).toLowerCase());
    }
    return names;
  }

  // Why `typed` can't name a `kind` here, as far as the page can tell (the
  // app checks again, and for the characters an OS refuses).
  function problem(typed, kind, names, extension) {
    const parts = typed.split('/').map((part) => part.trim());
    if (parts.some((part) => !part)) return 'Enter a name.';
    if (parts.some((part) => part.startsWith('.'))) return 'Names starting with "." are hidden; pick another.';
    if (parts.length > 1) return null;
    const name = kind === 'doc' && !DOC_EXTENSION.test(parts[0]) ? parts[0] + extension : parts[0];
    return names.has(name.toLowerCase()) ? `${name} is already here.` : null;
  }

  /**
   * Turn `node`'s label into a name field. `commit(typed)` resolves to
   * { rel } or { error }; `cancel()` runs when the field closes without one.
   */
  function nameField(node, { value, placeholder, label, check, commit, cancel = () => {}, emptyCancels }) {
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
      if (!typed && emptyCancels(fromEnter)) return void drop();
      const local = typed ? check(typed) : null;
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
    input.select();
  }

  function startRename(node) {
    if (field) return;
    closePicker();
    const { kind, path } = node.dataset;
    const name = path.split('/').at(-1);
    const extension = kind === 'doc' ? (name.match(DOC_EXTENSION)?.[0] ?? '') : '';
    const stem = extension ? name.slice(0, -extension.length) : name;
    const parent = parentOf(path);
    const names = taken(parent, path);
    focusRow(node);
    nameField(node, {
      value: stem,
      placeholder: stem,
      label: `Rename ${name}`,
      check: (typed) => problem(typed, kind, names, extension),
      emptyCancels: () => true,
      commit: async (typed) => (typed === stem ? { rel: path } : desktop.folderMove(path, kind, join(parent, typed))),
    });
  }

  function startCreate(parent, kind) {
    if (field || !view) return;
    closePicker();
    reveal();
    const holder = parent ? rowFor(parent) : null;
    if (parent && !holder) return;
    if (holder) setOpen(holder, true);
    const group = holder ? holder.nextElementSibling : tree;
    group.querySelector(':scope > .od-files-empty-folder, :scope > .od-files-empty')?.setAttribute('hidden', '');
    const item = el('li');
    item.setAttribute('role', 'none');
    const level = parent ? parent.split('/').length + 1 : 1;
    const node = row(kind, '', '', level);
    delete node.dataset.path;
    node.classList.add('od-files-new');
    item.append(node);
    // A new folder goes first; a new doc first among the docs, under the folders.
    const before = kind === 'folder' ? group.firstElementChild
      : [...group.children].find((child) => child.querySelector(':scope > .od-files-doc'));
    group.insertBefore(item, before ?? null);
    const names = taken(parent);
    nameField(node, {
      value: '',
      placeholder: kind === 'doc' ? 'Untitled' : 'New folder',
      label: kind === 'doc' ? 'New doc name' : 'New folder name',
      check: (typed) => problem(typed, kind, names, '.md'),
      // Enter on an empty doc name takes the next free Untitled; leaving it empty cancels.
      emptyCancels: (fromEnter) => kind !== 'doc' || !fromEnter,
      commit: (typed) => {
        created = kind === 'doc';
        return desktop.folderCreate(parent, typed, kind).finally(() => { created = null; });
      },
      cancel: () => {
        item.remove();
        group.querySelector(':scope > [hidden].od-files-empty-folder, :scope > [hidden].od-files-empty')?.removeAttribute('hidden');
      },
    });
    item.scrollIntoView({ block: 'nearest' });
  }

  // ---- Move To… ----

  function openPicker(node) {
    closePicker();
    if (field) return;
    const { kind, path } = node.dataset;
    const name = path.split('/').at(-1);
    const from = parentOf(path);
    const inside = (folder) => kind === 'folder' && (folder === path || folder.startsWith(`${path}/`));
    const choices = ['', ...[...folders].sort(byName.compare)].filter((folder) => !inside(folder));
    const box = el('div', 'od-files-picker');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', `Move ${name} to`);
    const input = el('input', 'od-files-input');
    Object.assign(input, { type: 'text', placeholder: 'Find a folder', spellcheck: false, autocomplete: 'off' });
    input.setAttribute('aria-label', `Move ${name} to`);
    const list = el('ul', 'od-files-picker-list');
    list.setAttribute('role', 'listbox');
    list.id = 'od-files-picker-list';
    input.setAttribute('aria-controls', list.id);
    box.append(input, list);
    let shown = [];
    let active = 0;

    const render = () => {
      const filter = input.value.trim().toLowerCase();
      shown = choices.filter((folder) => (folder || view.name).toLowerCase().includes(filter));
      active = Math.min(active, Math.max(shown.length - 1, 0));
      if (shown[active] === from) active = shown.findIndex((folder) => folder !== from);
      list.replaceChildren(...shown.map((folder, index) => {
        const option = el('li', 'od-files-option');
        option.setAttribute('role', 'option');
        option.id = `od-files-option-${index}`;
        option.setAttribute('aria-selected', String(index === active));
        if (folder === from) {
          option.setAttribute('aria-disabled', 'true');
          option.title = `${name} is already here`;
        }
        option.append(icon('folder'), el('span', 'od-files-label', folder || view.name));
        option.addEventListener('pointerdown', (event) => event.preventDefault()); // keep the field focused
        option.addEventListener('click', () => pick(folder));
        return option;
      }));
      if (shown.length === 0) list.append(el('li', 'od-files-empty', 'No folder matches'));
      input.setAttribute('aria-activedescendant', shown.length ? `od-files-option-${active}` : '');
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    };
    const step = (by) => {
      if (shown.length === 0) return;
      let next = active;
      do next = (next + by + shown.length) % shown.length;
      while (shown[next] === from && next !== active);
      active = next;
      render();
    };
    async function pick(folder) {
      if (folder === undefined || folder === from) return;
      closePicker();
      const result = await desktop.folderMove(path, kind, join(folder, name)).catch((error) => ({ error: reason(error) }));
      if (result?.error) {
        onError(result.error);
        focusRow(visibleRow(path));
        return;
      }
      focusNext = result.rel;
      refresh();
    }
    input.addEventListener('input', () => {
      active = 0;
      render();
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'ArrowDown') step(1);
      else if (event.key === 'ArrowUp') step(-1);
      else if (event.key === 'Enter' && !event.isComposing) pick(shown[active]);
      else if (event.key === 'Escape') {
        closePicker();
        focusRow(visibleRow(path));
      } else return;
      event.preventDefault();
    });
    const top = node.getBoundingClientRect().bottom - aside.getBoundingClientRect().top + 4;
    box.style.top = `${Math.min(top, aside.clientHeight - 260)}px`;
    aside.append(box);
    picker = { box, node };
    render();
    input.focus();
  }

  function closePicker() {
    picker?.box.remove();
    picker = null;
  }

  // ---- dragging to move ----

  // The folder a drop at `x`, `y` goes to ('' for the top), or null for none.
  function dropTarget(x, y) {
    const under = document.elementFromPoint(x, y);
    if (!under || !aside.contains(under) || under.closest('.od-files-picker')) return null;
    const node = under.closest('.od-files-row[data-path]');
    if (node) return node.dataset.kind === 'folder' ? node.dataset.path : parentOf(node.dataset.path);
    return under.closest('.od-files-tree, .od-files-head') ? '' : null;
  }

  function startDrag() {
    drag.started = true;
    closePicker();
    const ghost = el('div', 'od-files-ghost');
    ghost.append(icon(drag.kind === 'folder' ? 'folder' : 'file'), el('span', null, labelOf(drag.node)));
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
    const name = done.path.split('/').at(-1);
    desktop.folderMove(done.path, done.kind, join(done.target, name))
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
    if (!node || event.target.closest('.od-files-actions')) return;
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
    if (event.target.closest('.od-files-actions')) {
      const box = event.target.closest('.od-files-actions').getBoundingClientRect();
      menu(node, { x: box.left, y: box.bottom + 4 });
      return;
    }
    activate(node);
  });
  aside.addEventListener('contextmenu', (event) => {
    if (field || event.target.closest('.od-files-picker, input')) return;
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

  desktop.onFolderCommand(({ action, rel, kind }) => {
    const node = rel ? rowFor(rel) : null;
    if (action === 'rename' && node) startRename(node);
    else if (action === 'move' && node) openPicker(node);
    else if (action === 'newDoc') startCreate(kind === 'here' ? hereFolder() : rel, 'doc');
    else if (action === 'newFolder') startCreate(rel, 'folder');
  });
  head.querySelector('[data-action="new-doc"]').addEventListener('click', () => startCreate(parentOf(view?.current ?? ''), 'doc'));
  head.querySelector('[data-action="new-folder"]').addEventListener('click', () => startCreate(parentOf(view?.current ?? ''), 'folder'));

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
      return;
    }
    if (!floating) return;
    closeFloating();
    toggle.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (picker && !picker.box.contains(event.target)) closePicker();
    if (floating && !aside.contains(event.target) && !toggle.contains(event.target)) closeFloating();
  });
  desktop.onFolderChanged(refresh);
  return { ready: refresh(), state: () => ({ sidebarScroll: tree.scrollTop, startTyping: Boolean(created) }) };
}

// The docs and empty folders (paths with `/` between folders, the docs in
// the folder's order) as a tree: { folders: Map<name, node>, docs: [name] },
// each folder's subfolders by name.
function nest(paths, empty = []) {
  const root = { folders: new Map(), docs: [] };
  const folderAt = (parts) => {
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), docs: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const path of paths) {
    const parts = path.split('/');
    folderAt(parts.slice(0, -1)).docs.push(parts.at(-1));
  }
  for (const path of empty) folderAt(path.split('/'));
  sortFolders(root);
  return root;
}

function sortFolders(node) {
  node.folders = new Map([...node.folders].sort(([a], [b]) => byName.compare(a, b)));
  for (const child of node.folders.values()) sortFolders(child);
}

function allFolders(node, prefix = '', into = new Set()) {
  for (const [name, child] of node.folders) {
    into.add(prefix + name);
    allFolders(child, `${prefix + name}/`, into);
  }
  return into;
}

const parentOf = (path) => path.split('/').slice(0, -1).join('/');
const join = (folder, name) => (folder ? `${folder}/${name}` : name);

// An error from the app, without Electron's "Error invoking remote method" wrapping.
const reason = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
