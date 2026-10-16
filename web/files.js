// The sidebar of a desktop folder window: the folder's docs as a tree, the
// open one marked. Clicking a doc asks the app to show it in this window
// (the page is replaced by that doc's); the app keeps which subfolders are
// open, whether the sidebar shows and how far it was scrolled, so the next
// page draws it just as this one left it.

import { icon } from './icons.js';

const DOC_EXTENSION = /\.(md|markdown)$/i;

/**
 * Set up the sidebar; in a browser, or a window with a single doc, it stays
 * hidden. `onCarry(carry)` hears how the last page in this window left
 * things (`carry` from the app), once. Returns `ready`, which resolves once
 * the sidebar is drawn, and `state()`, how this page leaves it.
 */
export function createFileList({ onError = () => {}, onCarry = () => {} } = {}) {
  const desktop = window.opendocDesktop;
  const aside = document.querySelector('.od-files');
  const tree = aside.querySelector('.od-files-tree');
  const toggle = document.querySelector('.od-files-toggle');
  if (!desktop?.folder) return { ready: Promise.resolve(), state: () => ({}) };
  let view = null;
  let first = true;
  // In a narrow window the sidebar floats over the page instead of beside
  // it: closed until the toggle opens it, closed again by the toggle, Escape
  // or a click outside it. Opening it there leaves the wide window's choice
  // (`docked`, which the app keeps) alone.
  const narrow = window.matchMedia('(max-width: 900px)');
  let docked = false;
  let floating = false;

  async function refresh() {
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
    tree.replaceChildren(...items(nest(view.docs), '', new Set(view.expanded)));
    if (view.docs.length === 0) tree.append(el('li', 'od-files-empty', 'No docs in this folder'));
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

  // A subfolder's row and, below it, its docs; `path` is its place in the folder.
  function folderItem(name, node, path, expanded) {
    const item = el('li');
    const row = el('button', 'od-files-row od-files-folder');
    row.type = 'button';
    row.title = path;
    const open = expanded.has(path);
    row.setAttribute('aria-expanded', String(open));
    row.append(icon('chevron', 'od-icon od-files-chevron'), icon('folder'), el('span', 'od-files-label', name));
    const children = el('ul');
    children.append(...items(node, `${path}/`, expanded));
    children.hidden = !open;
    row.addEventListener('click', () => {
      const next = row.getAttribute('aria-expanded') !== 'true';
      row.setAttribute('aria-expanded', String(next));
      children.hidden = !next;
      desktop.folderExpand(path, next).catch(() => {});
    });
    item.append(row, children);
    return item;
  }

  function docItem(name, path) {
    const item = el('li');
    const row = el('button', 'od-files-row od-files-doc');
    row.type = 'button';
    row.title = path;
    row.append(icon('file'), el('span', 'od-files-label', name.replace(DOC_EXTENSION, '')));
    if (path === view.current) row.setAttribute('aria-current', 'page');
    row.addEventListener('click', () => {
      if (path === view.current) return;
      row.setAttribute('aria-busy', 'true');
      // The page saves any edit still on its way before it is replaced.
      desktop.openInFolder(path).catch((error) => onError(`Could not open ${name}: ${error.message}`))
        .finally(() => row.removeAttribute('aria-busy'));
    });
    item.append(row);
    return item;
  }

  function items(node, prefix, expanded) {
    return [
      ...[...node.folders].map(([name, child]) => folderItem(name, child, prefix + name, expanded)),
      ...node.docs.map((name) => docItem(name, prefix + name)),
    ];
  }

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
    if (event.key !== 'Escape' || !floating || event.defaultPrevented) return;
    closeFloating();
    toggle.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (floating && !aside.contains(event.target) && !toggle.contains(event.target)) closeFloating();
  });
  desktop.onFolderChanged(refresh);
  return { ready: refresh(), state: () => ({ sidebarScroll: tree.scrollTop }) };
}

// The docs (paths with `/` between folders, in the folder's order) as a tree:
// { folders: Map<name, node>, docs: [name] }.
function nest(paths) {
  const root = { folders: new Map(), docs: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), docs: [] });
      node = node.folders.get(part);
    }
    node.docs.push(parts.at(-1));
  }
  return root;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
