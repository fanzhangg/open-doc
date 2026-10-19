// The Markdown view's chrome: its tools in the page's toolbar (reflecting the
// formatting at the caret), a formatting bubble over selections, the link
// card and popover, the "/" block menu and a floating outline. The view
// makes it when the page gives it a toolbar (web/views/markdown.js).

import { hydrateIcons, icon } from '../icons.js';
import { keyLabel } from '../settings-dialog.js';

const TOOLS = `
  <div class="od-tool-group">
    <button type="button" data-command="undo" data-icon="undo" data-tip="Undo" data-keys="Mod+Z" aria-label="Undo"></button>
    <button type="button" data-command="redo" data-icon="redo" data-tip="Redo" data-keys="Mod+Shift+Z" aria-label="Redo"></button>
  </div>
  <span class="od-sep"></span>
  <div class="od-block-picker">
    <button type="button" class="od-block-button" aria-haspopup="listbox" aria-expanded="false" data-tip="Text style">
      <span class="od-block-label">Normal text</span>
    </button>
    <ul class="od-block-menu" role="listbox" aria-label="Text style" hidden>
      <li role="option" data-command="paragraph" data-block="paragraph"><span class="od-sample-p">Normal text</span><kbd data-keys="Mod+Alt+0"></kbd></li>
      <li role="option" data-command="h1" data-block="h1"><span class="od-sample-h1">Heading 1</span><kbd data-keys="Mod+Alt+1"></kbd></li>
      <li role="option" data-command="h2" data-block="h2"><span class="od-sample-h2">Heading 2</span><kbd data-keys="Mod+Alt+2"></kbd></li>
      <li role="option" data-command="h3" data-block="h3"><span class="od-sample-h3">Heading 3</span><kbd data-keys="Mod+Alt+3"></kbd></li>
    </ul>
  </div>
  <span class="od-sep"></span>
  <div class="od-tool-group">
    <button type="button" data-command="bold" data-icon="bold" data-tip="Bold" data-keys="Mod+B" aria-label="Bold"></button>
    <button type="button" data-command="italic" data-icon="italic" data-tip="Italic" data-keys="Mod+I" aria-label="Italic"></button>
    <button type="button" data-command="strike" data-icon="strike" data-tip="Strikethrough" data-keys="Mod+Alt+X" aria-label="Strikethrough"></button>
    <button type="button" data-command="code" data-icon="code" data-tip="Inline code" data-keys="Mod+E" aria-label="Inline code"></button>
    <button type="button" data-command="link" data-icon="link" data-tip="Link" data-keys="Mod+K" aria-label="Link" aria-haspopup="dialog"></button>
  </div>
  <span class="od-sep"></span>
  <div class="od-tool-group">
    <button type="button" data-command="bullets" data-icon="bullets" data-tip="Bulleted list" data-keys="Mod+Alt+8" aria-label="Bulleted list"></button>
    <button type="button" data-command="numbers" data-icon="numbers" data-tip="Numbered list" data-keys="Mod+Alt+7" aria-label="Numbered list"></button>
    <button type="button" data-command="quote" data-icon="quote" data-tip="Quote" data-keys="Mod+Shift+B" aria-label="Quote"></button>
    <button type="button" data-command="codeBlock" data-icon="codeBlock" data-tip="Code block" data-keys="Mod+Alt+C" aria-label="Code block"></button>
  </div>`;

const BUBBLE = `
  <div class="od-bubble" role="toolbar" aria-label="Selection" hidden>
    <button type="button" class="od-bubble-comment" data-action="comment" data-icon="comment" data-tip="Comment" data-keys="Mod+Alt+M">Comment</button>
    <span class="od-sep"></span>
    <button type="button" data-command="bold" data-icon="bold" data-tip="Bold" data-keys="Mod+B" aria-label="Bold"></button>
    <button type="button" data-command="italic" data-icon="italic" data-tip="Italic" data-keys="Mod+I" aria-label="Italic"></button>
    <button type="button" data-command="strike" data-icon="strike" data-tip="Strikethrough" data-keys="Mod+Alt+X" aria-label="Strikethrough"></button>
    <button type="button" data-command="code" data-icon="code" data-tip="Inline code" data-keys="Mod+E" aria-label="Inline code"></button>
    <button type="button" data-command="link" data-icon="link" data-tip="Link" data-keys="Mod+K" aria-label="Link" aria-haspopup="dialog"></button>
  </div>
  <ul class="od-slash" role="listbox" aria-label="Insert block" hidden></ul>`;

const OUTLINE = `
  <nav class="od-outline" aria-label="Outline" hidden>
    <div class="od-outline-ticks" aria-hidden="true"></div>
    <div class="od-outline-panel">
      <div class="od-outline-title">Outline</div>
      <ol class="od-outline-list"></ol>
    </div>
  </nav>`;

const LINK = `
  <div class="od-link-card" role="toolbar" aria-label="Link" hidden>
    <button type="button" class="od-link-go" data-action="open" data-tip="Open" data-keys="Mod+Click"><span class="od-link-go-icon"></span><span class="od-link-go-text"></span></button>
    <button type="button" class="od-icon-btn" data-action="edit" data-icon="pencil" data-tip="Edit link" data-keys="Mod+K" aria-label="Edit link"></button>
    <button type="button" class="od-icon-btn" data-action="unlink" data-icon="unlink" data-tip="Remove link" aria-label="Remove link"></button>
  </div>
  <div class="od-link" role="dialog" aria-label="Link" hidden>
    <span class="od-link-icon" data-icon="link"></span>
    <input class="od-link-input" type="text" inputmode="url" autocomplete="off" spellcheck="false" aria-label="Link URL" placeholder="Paste or type a link">
    <button type="button" class="od-primary" data-action="apply">Apply</button>
    <button type="button" class="od-icon-btn" data-action="unlink" data-icon="unlink" data-tip="Remove link" aria-label="Remove link" hidden></button>
  </div>`;

const BLOCK_LABELS = { paragraph: 'Normal text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', h5: 'Heading 5', h6: 'Heading 6', code_block: 'Code block' };
const SLASH_ITEMS = [
  { command: 'paragraph', icon: 'text', label: 'Text', words: 'text paragraph normal p' },
  { command: 'h1', icon: 'heading', label: 'Heading 1', words: 'heading h1 title' },
  { command: 'h2', icon: 'heading', label: 'Heading 2', words: 'heading h2 subtitle' },
  { command: 'h3', icon: 'heading', label: 'Heading 3', words: 'heading h3' },
  { command: 'bullets', icon: 'bullets', label: 'Bulleted list', words: 'bullet list ul unordered' },
  { command: 'numbers', icon: 'numbers', label: 'Numbered list', words: 'numbered list ol ordered' },
  { command: 'quote', icon: 'quote', label: 'Quote', words: 'quote blockquote' },
  { command: 'codeBlock', icon: 'codeBlock', label: 'Code block', words: 'code block fence pre' },
  { command: 'table', icon: 'table', label: 'Table', words: 'table grid' },
  { command: 'divider', icon: 'divider', label: 'Divider', words: 'divider hr rule line separator' },
];

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

// The elements of `markup`, icons and key labels filled in.
function elements(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup;
  hydrateIcons(template.content);
  for (const kbd of template.content.querySelectorAll('kbd[data-keys]')) kbd.textContent = keyLabel(kbd.dataset.keys);
  return [...template.content.children];
}

/**
 * `editor`: the Markdown view's own commands and queries. The tools go first
 * in `toolbar`, the bubble and "/" menu in `stage`, the outline before it.
 * `onComment` is the bubble's Comment button.
 *
 * @param {object} editor
 * @param {{ toolbar: HTMLElement, stage: HTMLElement, host: HTMLElement, onComment: () => void }} options
 */
export function createChrome(editor, { toolbar, stage, host, onComment }) {
  const tools = elements(TOOLS);
  const [bubble, slashMenu] = elements(BUBBLE);
  const [outlineNav] = elements(OUTLINE);
  const [card, popover] = elements(LINK);
  toolbar.prepend(...tools);
  stage.append(bubble, slashMenu);
  stage.before(outlineNav);
  document.body.append(card, popover);
  const made = [...tools, bubble, slashMenu, outlineNav, card, popover];

  const canvas = stage.parentElement; // scrolls the page
  const page = host.closest('.od-page');
  const done = new AbortController();
  const { signal } = done;
  const slash = setupSlash(editor, slashMenu);
  const link = setupLink(editor, { card, popover, host, canvas, signal });
  const outline = setupOutline(editor, { nav: outlineNav, host, canvas, signal });
  const blockPicker = setupBlockPicker(editor, tools.find((el) => el.matches('.od-block-picker')), signal);
  const buttons = [...tools, bubble].flatMap((el) => [...el.querySelectorAll('button[data-command]')]);
  const commentButton = bubble.querySelector('[data-action="comment"]');

  // Tools and bubble buttons act on the editor without taking its selection.
  for (const bar of [toolbar, bubble]) {
    bar.addEventListener('mousedown', (event) => {
      const target = event.target.closest('button');
      if (!buttons.includes(target) && target !== commentButton) return;
      event.preventDefault();
      if (target === commentButton) onComment();
      else if (target.dataset.command === 'link') link.toggle(target);
      else editor.run(target.dataset.command);
    }, { signal });
  }

  // ---- reflect the editor's state ----

  let frame = 0;
  function update() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refresh();
    });
  }

  function refresh() {
    const { active, block, canUndo, canRedo } = editor.formatState();
    for (const button of buttons) {
      const { command } = button.dataset;
      if (command === 'undo' || command === 'redo') {
        button.disabled = !(command === 'undo' ? canUndo : canRedo);
        continue;
      }
      button.setAttribute('aria-pressed', String(active.has(command)));
    }
    blockPicker.show(block);
    placeBubble();
    link.refresh(pointerDown);
    slash.refresh();
    outline.refresh();
  }

  // ---- selection bubble ----

  let pointerDown = false;
  document.addEventListener('mousedown', (event) => {
    if (host.contains(event.target)) pointerDown = true;
  }, { signal });
  document.addEventListener('mouseup', () => {
    if (!pointerDown) return;
    pointerDown = false;
    requestAnimationFrame(() => {
      placeBubble();
      link.refresh(false);
    });
  }, { signal });

  function placeBubble() {
    const rect = !pointerDown && editor.selectionRect();
    if (!rect) {
      bubble.hidden = true;
      return;
    }
    commentButton.hidden = !rect.commentable;
    bubble.hidden = false;
    const stageRect = bubble.offsetParent.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const canvasTop = canvas.getBoundingClientRect().top;
    const { offsetWidth: width, offsetHeight: height } = bubble;
    const center = (rect.left + rect.right) / 2;
    const left = Math.min(Math.max(center - width / 2, pageRect.left + 8), pageRect.right - width - 8);
    const above = rect.top - height - 10 > canvasTop;
    const top = above ? rect.top - height - 10 : rect.bottom + 10;
    bubble.style.left = `${left - stageRect.left}px`;
    bubble.style.top = `${top - stageRect.top}px`;
    bubble.dataset.side = above ? 'above' : 'below';
  }
  canvas.addEventListener('scroll', () => {
    if (!bubble.hidden) placeBubble();
  }, { passive: true, signal });

  document.addEventListener('keydown', (event) => {
    const mod = mac ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k' && host.contains(event.target)) {
      event.preventDefault();
      link.toggle();
    }
  }, { signal });

  refresh();
  return {
    /** After every editor update: typing, selection, focus. */
    update,
    /** Sees editor keydowns first (for the "/" menu); true when it took one. */
    onKey: (event) => slash.onKey(event),
    destroy() {
      done.abort();
      cancelAnimationFrame(frame);
      for (const el of made) el.remove();
    },
  };
}

// ---- links: a card for the link at the caret, and the popover that edits one ----

// The card shows where the link at the caret goes, under it: click to open,
// or edit or remove it. Mod+click on a link opens it too. The popover edits
// the URL for the selection or the link at the caret: Enter applies, an
// empty URL removes the link, Escape or clicking away cancels. It sits under
// the text it links, or under the button that opened it when that text is
// out of view.
function setupLink(editor, { card, popover, host, canvas, signal }) {
  const go = card.querySelector('.od-link-go');
  const input = popover.querySelector('.od-link-input');
  const unlink = popover.querySelector('[data-action="unlink"]');
  let button = null; // the toolbar or bubble button it opened from
  let shown = null; // the link the card is for: { href, rect }

  // `#heading` scrolls this doc; anything else is the app's to open.
  function follow(href) {
    if (href.startsWith('#')) editor.scrollToAnchor(href.slice(1));
    else if (window.opendocDesktop) window.opendocDesktop.openLink(href).catch(() => {});
    else window.open(href, '_blank', 'noopener');
  }

  function showCard(link) {
    shown = link;
    card.hidden = !link;
    if (!link) return;
    const { href } = link;
    const doc = !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('#');
    go.querySelector('.od-link-go-icon').replaceChildren(icon(doc ? 'file' : 'link'));
    go.querySelector('.od-link-go-text').textContent = doc
      ? decoded(href.split(/[?#]/)[0].split('/').at(-1)).replace(/\.(md|markdown)$/i, '') || href
      : href.replace(/^(https?:|mailto:)(\/\/)?(www\.)?/i, '');
    go.dataset.tip = href;
    placeAt(card, link.rect);
  }

  card.addEventListener('mousedown', (event) => event.preventDefault()); // the caret stays in the link
  card.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (!shown || !action) return;
    if (action === 'open') follow(shown.href);
    else if (action === 'edit') open(null);
    else if (action === 'unlink') {
      editor.beginLink();
      editor.endLink('');
    }
  });
  host.addEventListener('click', (event) => {
    const a = event.target.closest?.('a[href]');
    if (!a || !(mac ? event.metaKey : event.ctrlKey)) return;
    event.preventDefault();
    follow(a.getAttribute('href'));
  });

  function open(from) {
    showCard(null);
    button = from ?? null;
    const href = editor.beginLink();
    input.value = href ?? '';
    unlink.hidden = href === null;
    popover.hidden = false;
    place();
    input.focus();
    input.select();
  }

  // `href`: the URL to set, '' to remove the link, null to cancel.
  function close(href) {
    if (popover.hidden) return;
    popover.hidden = true;
    button = null;
    editor.endLink(href);
  }

  function place() {
    const rect = editor.linkRect();
    const view = canvas.getBoundingClientRect();
    const visible = rect && rect.bottom > view.top && rect.top < view.bottom;
    const onScreen = button?.isConnected && button.getClientRects().length > 0;
    const anchor = visible || !onScreen ? rect : button.getBoundingClientRect();
    if (!anchor) return;
    placeAt(popover, anchor, visible ? rect.left - 10 : (anchor.left + anchor.right) / 2 - popover.offsetWidth / 2);
  }

  // Under `anchor`, or over it when there is no room below.
  function placeAt(box, anchor, left = anchor.left - 10) {
    const { offsetWidth: width, offsetHeight: height } = box;
    const below = anchor.bottom + 8 + height < window.innerHeight - 8;
    box.style.left = `${Math.min(Math.max(left, 8), window.innerWidth - width - 8)}px`;
    box.style.top = `${below ? anchor.bottom + 8 : anchor.top - height - 8}px`;
  }

  popover.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(null);
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      close(input.value.trim());
    } else if (event.key === 'Tab') {
      // Focus stays in the popover: the URL, Apply, Remove.
      const stops = [...popover.querySelectorAll('input, button:not([hidden])')];
      const next = stops.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1);
      if (next < 0 || next >= stops.length) {
        event.preventDefault();
        stops.at(next < 0 ? -1 : 0).focus();
      }
    }
  });
  popover.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'apply') close(input.value.trim());
    else if (action === 'unlink') close('');
  });
  // Clicking anywhere else cancels; the link buttons toggle it themselves.
  document.addEventListener('mousedown', (event) => {
    if (popover.hidden || popover.contains(event.target) || event.target.closest?.('[data-command="link"]')) return;
    close(null);
  }, { capture: true, signal });
  const replace = () => {
    if (!popover.hidden) place();
    if (shown) showCard(editor.caretLink());
  };
  canvas.addEventListener('scroll', replace, { passive: true, signal });
  window.addEventListener('resize', replace, { signal });

  return {
    /** Show the card for the link at the caret, if any; none while the pointer is still down. */
    refresh(pointerDown) {
      if (popover.hidden) showCard(pointerDown ? null : editor.caretLink());
    },
    /** Open for the selection (`from`: the button that asked), or cancel when open. */
    toggle(from) {
      if (popover.hidden) open(from);
      else close(null);
    },
  };
}

// ---- "Normal text ▾" block style picker ----

function setupBlockPicker(editor, root, signal) {
  const button = root.querySelector('.od-block-button');
  const label = root.querySelector('.od-block-label');
  const menu = root.querySelector('.od-block-menu');
  button.append(icon('chevron', 'od-icon od-chevron'));

  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  menu.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const item = event.target.closest('[data-command]');
    if (!item) return;
    close();
    editor.run(item.dataset.command);
  });
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !root.contains(event.target)) close();
  }, { signal });

  return {
    show(block) {
      label.textContent = BLOCK_LABELS[block] ?? 'Normal text';
      for (const item of menu.children) item.setAttribute('aria-selected', String(item.dataset.block === block));
    },
  };
}

// ---- "/" menu ----

function setupSlash(editor, menu) {
  let range = null;
  let items = [];
  let selected = 0;
  let dismissedAt = null; // slash position the human closed with Escape

  function refresh() {
    const query = editor.slashQuery();
    if (!query || query.from === dismissedAt) {
      if (!query) dismissedAt = null;
      return close();
    }
    const q = query.query.toLowerCase();
    const next = SLASH_ITEMS.filter((item) => !q || `${item.label} ${item.words}`.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
    if (next.length === 0) return close();
    if (range?.from !== query.from || items.length !== next.length) selected = 0;
    range = query;
    items = next;
    draw();
    const stage = menu.offsetParent.getBoundingClientRect();
    const at = editor.coordsAt(query.from);
    const room = window.innerHeight - at.bottom;
    menu.style.left = `${at.left - stage.left}px`;
    menu.style.top = room < menu.offsetHeight + 16 ? `${at.top - stage.top - menu.offsetHeight - 6}px` : `${at.bottom - stage.top + 6}px`;
  }

  function draw() {
    menu.replaceChildren(...items.map((item, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === selected));
      const label = document.createElement('span');
      label.className = 'od-slash-label';
      label.textContent = item.label;
      const glyph = document.createElement('span');
      glyph.className = 'od-slash-icon';
      glyph.append(icon(item.icon));
      li.append(glyph, label);
      li.addEventListener('mousedown', (event) => {
        event.preventDefault();
        pick(i);
      });
      li.addEventListener('mousemove', () => {
        if (selected === i) return;
        selected = i;
        draw();
      });
      return li;
    }));
    menu.hidden = false;
    menu.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  function pick(i) {
    const item = items[i];
    const at = range;
    close();
    editor.runSlash(at, item.command);
  }

  function close() {
    menu.hidden = true;
    range = null;
    items = [];
  }

  function onKey(event) {
    if (menu.hidden) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      draw();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      pick(selected);
      return true;
    }
    if (event.key === 'Escape') {
      dismissedAt = range.from;
      close();
      return true;
    }
    return false;
  }

  return { refresh, onKey };
}

// ---- outline: a tick per heading at the left edge, a list on hover ----

function setupOutline(editor, { nav, host, canvas, signal }) {
  const ticks = nav.querySelector('.od-outline-ticks');
  const list = nav.querySelector('.od-outline-list');
  let signature = '';
  let current = [];

  function refresh() {
    const headings = editor.headings();
    const next = JSON.stringify(headings.map((h) => [h.level, h.text]));
    current = headings;
    if (next === signature) return;
    signature = next;
    nav.hidden = headings.length < 2;
    const minLevel = Math.min(...headings.map((h) => h.level));
    ticks.replaceChildren(...headings.map((h) => {
      const tick = document.createElement('i');
      tick.dataset.depth = String(h.level - minLevel);
      return tick;
    }));
    list.replaceChildren(...headings.map((h, i) => {
      const li = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.dataset.depth = String(h.level - minLevel);
      link.textContent = h.text;
      link.addEventListener('click', () => editor.scrollToHeading(current[i].pos));
      li.append(link);
      return li;
    }));
    markActive();
  }

  function markActive() {
    const top = canvas.getBoundingClientRect().top + 96;
    const elements = [...host.querySelectorAll('.ProseMirror > :is(h1, h2, h3, h4, h5, h6)')].filter((h) => h.textContent.trim());
    let active = 0;
    elements.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= top) active = i;
    });
    [...ticks.children].forEach((tick, i) => tick.classList.toggle('od-on', i === active));
    [...list.querySelectorAll('button')].forEach((link, i) => link.classList.toggle('od-on', i === active));
  }
  canvas.addEventListener('scroll', () => requestAnimationFrame(markActive), { passive: true, signal });

  return { refresh };
}

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
