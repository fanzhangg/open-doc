// The comment margin, Google Docs style: one card per thread beside the text it
// is about, stacked so they never overlap, with the active card aligned to its
// text. A buddy shows up like any other collaborator: an avatar, its
// replies, and typing dots while it works. A reply whose run failed, or
// whose edit was partly dropped for the human's text, says so; one that
// edited the doc on this machine offers Undo. Only the human resolves
// threads; they delete their own comments and buddies'.

import { icon } from './icons.js';
import { agentFace, buddyColor, personFace } from './faces.js';
import { mentionSpans } from '../src/core/mentions.js';

const GAP = 10;
const MENTION_BEFORE_CARET = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]*)$/;

/**
 * @param {HTMLElement} margin
 * @param {{ onCreate: (body: string) => Promise<void>, onCancelDraft: () => void,
 *           onReply: (threadId: string, body: string) => Promise<void>,
 *           onResolve: (threadId: string) => Promise<void>, onReopen: (threadId: string) => Promise<void>,
 *           onUndo: (replyId: string) => Promise<void>,
 *           onSelect: (threadId: string | null) => void,
 *           anchorTops: (items: { id: string, anchor: object }[]) => Map<string, number>,
 *           mentionChoices?: (query: string, me: string) => { name, kind, group, tagline? }[],
 *           mentionable?: () => { name: string, kind: string }[] }} handlers
 */
export function createCommentMargin(margin, handlers) {
  let threads = [];
  let agents = []; // the buddies' statuses in this doc: who works on which threads
  let me = { id: null, name: '' };
  let edits = {}; // the buddy replies that edited the doc here: { [id]: 'edited' | 'undone' }
  let activeId = null;
  let draft = null; // { hint } while composing a comment on the selected text
  let showResolved = false;
  const replyDrafts = new Map();
  const unfolded = new Set(); // ids of long comments shown in full
  const expanded = new Set(); // ids of long threads shown with every reply
  const narrow = window.matchMedia('(max-width: 900px)');

  // ---- rendering ----

  function visibleThreads() {
    return threads.filter((t) => t.resolved === showResolved);
  }

  function render() {
    const focused = document.activeElement?.closest?.('[data-box]')?.dataset.box;
    const caret = document.activeElement?.selectionStart;

    margin.classList.toggle('od-margin-list', showResolved);
    const cards = [];
    if (draft) cards.push(draftCard());
    const shown = visibleThreads();
    for (const thread of shown) cards.push(threadCard(thread));
    if (showResolved && shown.length === 0) cards.push(el('p', 'od-empty', 'No resolved comments.'));
    else if (!draft && shown.length === 0) cards.push(el('p', 'od-empty od-empty-open', 'No comments yet.')); // shown only in the narrow window's sheet

    // Live updates arrive while the human types: keep the card they are typing
    // in attached, updated around its text box, so text, caret and IME input survive.
    const typingIn = focused && document.activeElement.closest('.od-card');
    const at = typingIn ? cards.findIndex((c) => c.dataset.thread === typingIn.dataset.thread) : -1;
    const kept = at !== -1 && patchCard(typingIn, cards[at]) ? typingIn : null;
    if (kept) cards[at] = kept;
    for (const child of [...margin.children]) if (child !== kept) child.remove();
    cards.forEach((card, i) => {
      if (kept && i < at) margin.insertBefore(card, kept);
      else if (card !== kept) margin.append(card);
    });

    if (focused && !kept) {
      const box = margin.querySelector(`[data-box="${focused}"] textarea`);
      if (box) {
        box.focus();
        if (caret !== undefined && caret !== null) box.setSelectionRange(caret, caret);
      }
    }
    layout();
  }

  function threadCard(thread) {
    const card = el('article', 'od-card');
    card.dataset.thread = thread.id;
    const active = thread.id === activeId;
    const working = thread.resolved ? [] : agents.filter((a) => a.threadIds.includes(thread.id)).map((a) => a.name);
    card.classList.toggle('od-card-active', active);
    card.classList.toggle('od-card-working', working.length > 0);
    card.classList.toggle('od-card-resolved', thread.resolved);
    // A click that ends selecting the card's text leaves the selection, to copy.
    card.addEventListener('click', (event) => {
      if (!event.target.closest('textarea, button, a') && getSelection().isCollapsed) handlers.onSelect(thread.id);
    });

    if (thread.anchor && thread.detached) card.append(el('div', 'od-card-note', 'The text this was about was deleted.'));
    if (thread.anchor && (showResolved || thread.detached)) card.append(el('blockquote', 'od-quote', truncate(thread.anchor.exact, 120)));
    if (!thread.anchor) card.append(el('div', 'od-card-note', 'On the whole document'));

    // A long thread folds its middle replies until the human opens them or
    // selects the card (setActive); Hide folds them again either way. A
    // comment that only resolved the thread shows as the resolved line; a
    // buddy's reply with nothing to say still shows, for what its run did.
    const comments = thread.comments.filter((c) => c.body.trim() !== '' || (c.by.kind === 'ai' && !c.resolved));
    const long = comments.length > 3;
    const collapse = long && !expanded.has(thread.id);
    comments.forEach((comment, i) => {
      if (long && i === 1) card.append(moreButton(thread.id, comments.slice(1, -1), !collapse));
      if (collapse && i > 0 && i < comments.length - 1) return;
      card.append(commentRow(comment, i === 0 && !thread.resolved ? resolveButton(thread) : null));
    });

    // Typing dots for each agent working on it; several can at once.
    for (const name of working) {
      const row = el('div', 'od-typing');
      row.title = `${name} is working on it`;
      row.append(avatar(name, 'agent', true), dots());
      card.append(row);
    }
    if (thread.resolved) {
      const by = thread.comments.at(-1).by;
      const row = el('div', 'od-resolved-row');
      row.append(checkIcon(), el('span', '', `Resolved by ${by.id === me.id ? 'you' : by.name}`));
      row.append(linkButton('Reopen', () => handlers.onReopen(thread.id)));
      card.append(row);
    }
    if (active && !thread.resolved) card.append(composer(`reply:${thread.id}`, 'Reply…', 'Reply', async (body) => {
      await handlers.onReply(thread.id, body);
      replyDrafts.delete(thread.id);
    }, () => handlers.onSelect(null), thread.id));
    return card;
  }

  function commentRow(comment, action) {
    const row = el('div', 'od-msg');
    const head = el('div', 'od-msg-head');
    const who = el('div', 'od-who');
    const kind = kindOf(comment);
    const name = el('span', 'od-name', comment.by.name);
    who.append(name, el('time', 'od-time', relativeTime(comment.at)));
    namecardFor(name, comment.by.name, kind, 'click');
    head.append(namecardFor(avatar(comment.by.name, kind), comment.by.name, kind, 'click'), who);
    if (action) head.append(action);
    const open = unfolded.has(comment.id);
    const body = el('div', `od-body${open ? '' : ' od-body-folded'}`);
    body.append(...withMentions(comment.body, handlers.mentionable?.() ?? []));
    if (comment.body.trim()) row.append(head, body, foldButton(comment.id, open));
    else row.append(head);
    // To retry, or to redo what was dropped, the human asks again.
    if (comment.failed) row.append(el('div', 'od-card-note od-msg-note', `The run failed. @mention ${comment.by.name} again to retry.`));
    if (comment.conflict) row.append(el('div', 'od-card-note od-msg-note', `You changed this text meanwhile, so part of the edit was dropped. @mention ${comment.by.name} again to redo it.`));
    if (edits[comment.id]) row.append(receipt(comment.id, edits[comment.id]));
    row.classList.toggle('od-msg-failed', Boolean(comment.failed));
    return row;
  }

  // What a run did, as the app counted it, on the machine that ran it:
  // hovering shows its edits in the text; the icon undoes them.
  function receipt(id, { state, by, changes, hash }) {
    const box = el('div', `od-receipt${state === 'undone' ? ' od-receipt-undone' : ''}`);
    box.style.setProperty('--buddy', buddyColor(by ?? ''));
    const count = el('span', 'od-receipt-text', state === 'undone' ? `${changes === 1 ? 'Edit' : 'Edits'} undone` : `${changes} ${changes === 1 ? 'edit' : 'edits'}`);
    box.append(icon('pencil'), count);
    if (state === 'edited') {
      box.addEventListener('mouseenter', () => handlers.onLight?.(hash));
      box.addEventListener('mouseleave', () => handlers.onLight?.(null));
      const undo = el('button', 'od-icon-button od-receipt-undo');
      undo.type = 'button';
      undo.title = `Undo ${changes === 1 ? 'this edit' : `these ${changes} edits`}`;
      undo.setAttribute('aria-label', undo.title);
      undo.append(icon('undo'));
      undo.addEventListener('click', (event) => {
        event.stopPropagation();
        undo.disabled = true;
        handlers.onLight?.(null);
        handlers.onUndo(id).catch(() => { undo.disabled = false; });
      });
      box.append(undo);
    }
    return box;
  }

  // The replies folded out of a long thread: who wrote them and how many,
  // in the link color, opening and closing them in place.
  function moreButton(threadId, hidden, open) {
    const button = el('button', 'od-more');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    if (!open) {
      const faces = el('span', 'od-more-faces');
      const authors = new Map(hidden.map((c) => [c.by.name, kindOf(c)]));
      for (const [name, kind] of [...authors].slice(0, 3)) faces.append(avatar(name, kind, true));
      button.append(faces);
    }
    const n = hidden.length;
    button.append(el('span', '', open ? 'Hide replies' : `${n} more ${n === 1 ? 'reply' : 'replies'}`), icon('chevron'));
    button.addEventListener('click', () => {
      if (open) expanded.delete(threadId);
      else expanded.add(threadId);
      render();
    });
    return button;
  }

  // Show more / Show less under a long message. Folded, it stays hidden until
  // layout finds the text actually overflows its clamp.
  function foldButton(id, open) {
    const button = el('button', 'od-fold');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    button.append(el('span', '', open ? 'Show less' : 'Show more'), icon('chevron'));
    button.hidden = !open;
    button.addEventListener('click', () => {
      if (open) unfolded.delete(id);
      else unfolded.add(id);
      render();
    });
    return button;
  }

  function resolveButton(thread) {
    const button = el('button', 'od-icon-button od-resolve');
    button.type = 'button';
    button.title = 'Mark as resolved and hide';
    button.setAttribute('aria-label', 'Resolve');
    button.append(checkIcon());
    button.addEventListener('click', () => handlers.onResolve(thread.id));
    return button;
  }

  function draftCard() {
    const card = el('article', 'od-card od-card-active od-card-draft');
    card.dataset.thread = 'draft';
    const head = el('div', 'od-msg-head');
    const who = el('div', 'od-who');
    who.append(el('span', 'od-name', me.name));
    head.append(avatar(me.name, 'human'), who);
    card.append(head);
    card.append(composer('draft', 'Comment…', 'Comment', async (body) => {
      await handlers.onCreate(body);
      draft = null;
      replyDrafts.delete('draft');
      render();
    }, () => {
      draft = null;
      replyDrafts.delete('draft');
      handlers.onCancelDraft();
      render();
    }, 'draft'));
    return card;
  }

  // A growing text box: Enter posts, Shift+Enter breaks the line, Escape
  // cancels. @ offers the agents and people to address, grouped (agents in
  // the doc, agents to bring in, people).
  function composer(id, placeholder, submitLabel, submit, cancel, draftKey) {
    const wrap = el('div', 'od-composer');
    wrap.dataset.box = id;
    const box = document.createElement('textarea');
    box.rows = 1;
    box.placeholder = placeholder;
    box.value = draftKey ? replyDrafts.get(draftKey) ?? '' : '';
    const menu = el('ul', 'od-mentions');
    menu.setAttribute('role', 'listbox');
    menu.hidden = true;
    const buttons = el('div', 'od-composer-buttons');
    const send = el('button', 'od-primary', submitLabel);
    send.type = 'button';
    const cancelButton = el('button', 'od-secondary', 'Cancel');
    cancelButton.type = 'button';
    buttons.append(send, cancelButton);
    let choices = [];
    let selected = 0;

    const grow = () => {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight}px`;
      send.disabled = !box.value.trim();
    };
    const update = () => {
      if (draftKey) replyDrafts.set(draftKey, box.value);
      grow();
      const match = box.value.slice(0, box.selectionStart).match(MENTION_BEFORE_CARET);
      choices = match ? (handlers.mentionChoices?.(match[2]) ?? []) : [];
      selected = 0;
      drawMenu();
      layout();
    };
    const drawMenu = () => fillMentionMenu(menu, choices, selected, (choice) => pick(choice.name));
    const pick = (name) => {
      const before = box.value.slice(0, box.selectionStart).replace(/@[A-Za-z0-9._-]*$/, `@${name} `);
      box.value = before + box.value.slice(box.selectionStart);
      box.setSelectionRange(before.length, before.length);
      choices = [];
      drawMenu();
      if (draftKey) replyDrafts.set(draftKey, box.value);
    };
    const post = async () => {
      const body = box.value.trim();
      if (!body) return;
      box.disabled = true;
      send.disabled = true;
      try {
        await submit(body);
        box.value = '';
      } finally {
        box.disabled = false;
        grow();
      }
    };

    box.addEventListener('input', update);
    box.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 100));
    box.addEventListener('keydown', (event) => {
      if (choices.length > 0 && !menu.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowDown') selected = (selected + 1) % choices.length;
        else if (event.key === 'ArrowUp') selected = (selected - 1 + choices.length) % choices.length;
        else pick(choices[selected].name);
        drawMenu();
        return;
      }
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        choices = [];
        drawMenu();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        post();
      }
    });
    send.addEventListener('click', post);
    cancelButton.addEventListener('click', cancel);
    wrap.append(box, menu, buttons);
    requestAnimationFrame(() => {
      grow();
      layout();
    });
    return wrap;
  }

  // ---- layout: cards beside their text, never overlapping ----

  function layout() {
    foldBodies();
    const cards = [...margin.querySelectorAll('.od-card')];
    if (showResolved || narrow.matches) {
      for (const card of cards) card.style.top = '';
      margin.style.height = '';
      return;
    }
    const byId = new Map(threads.map((t) => [t.id, t]));
    const items = cards.map((card) => {
      const id = card.dataset.thread;
      // The draft card can outlive `draft` until the next render (cancelling
      // repaints the doc, which lays out the margin first).
      return { card, id, anchor: id === 'draft' ? draft && hintAnchor(draft.hint) : byId.get(id)?.anchor };
    });
    const tops = handlers.anchorTops(items.filter((i) => i.anchor));
    const origin = margin.getBoundingClientRect().top;
    // Cards with no place in the text (whole-doc, detached) line up at the top.
    let unplaced = 0;
    for (const item of items) {
      item.height = item.card.offsetHeight;
      item.want = tops.has(item.id) ? tops.get(item.id) - origin : -1000 + unplaced++;
    }
    items.sort((a, b) => a.want - b.want);
    for (const item of items) if (item.want < 0) item.want = 0;

    const pivot = Math.max(0, items.findIndex((i) => i.id === (draft ? 'draft' : activeId)));
    if (items.length > 0) items[pivot].top = items[pivot].want;
    for (let i = pivot + 1; i < items.length; i++) {
      items[i].top = Math.max(items[i].want, items[i - 1].top + items[i - 1].height + GAP);
    }
    for (let i = pivot - 1; i >= 0; i--) {
      items[i].top = Math.min(items[i].want, items[i + 1].top - items[i].height - GAP);
    }
    const shift = items.length > 0 && items[0].top < 0 ? -items[0].top : 0;
    let bottom = 0;
    for (const item of items) {
      item.top += shift;
      item.card.style.top = `${item.top}px`;
      bottom = Math.max(bottom, item.top + item.height);
    }
    margin.style.height = `${bottom + 40}px`;
  }

  // Offer Show more only on messages cut off by their line clamp.
  function foldBodies() {
    for (const body of margin.querySelectorAll('.od-body-folded')) {
      body.nextElementSibling.hidden = body.scrollHeight <= body.clientHeight + 1;
    }
  }

  window.addEventListener('resize', layout);
  narrow.addEventListener('change', layout);

  return {
    /** Show `nextThreads` (from the doc host), as `nextMe` ({ id, name }) sees them; `nextEdits`: which replies edited the doc. */
    update(nextThreads, nextMe, nextEdits = {}) {
      threads = nextThreads;
      me = nextMe;
      edits = nextEdits;
      render();
    },
    /** The buddies' statuses changed: who works on which threads. */
    setAgents(statuses) {
      agents = statuses ?? [];
      render();
    },
    startDraft(hint) {
      draft = { hint };
      replyDrafts.delete('draft');
      showResolved = false;
      render();
      margin.querySelector('.od-card-draft textarea')?.focus();
    },
    /** Make `id` the active card; `focus: false` leaves the caret where it is (e.g. in the doc). */
    setActive(id, { focus = true } = {}) {
      // Selecting a card shows its folded replies; leaving it folds them again.
      if (id !== activeId) {
        expanded.delete(activeId);
        if (id) expanded.add(id);
      }
      activeId = id;
      render();
      if (narrow.matches) margin.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (id && focus) margin.querySelector(`[data-thread="${id}"] textarea`)?.focus({ preventScroll: true });
    },
    setShowResolved(value) {
      showResolved = value;
      render();
    },
    layout,
    rerender: render,
  };
}

// Give `card` the content of `fresh` (same thread) but keep its own text box
// element. False when either has no text box, so the caller replaces the card.
function patchCard(card, fresh) {
  const box = card.querySelector('.od-composer');
  const freshBox = fresh.querySelector('.od-composer');
  if (!box || !freshBox) return false;
  const keep = [...card.children].find((child) => child.contains(box));
  const kids = [...fresh.childNodes];
  const slot = kids.findIndex((child) => child.contains(freshBox));
  for (const child of [...card.childNodes]) if (child !== keep) child.remove();
  for (const child of kids.slice(0, slot)) card.insertBefore(child, keep);
  for (const child of kids.slice(slot + 1)) card.append(child);
  card.className = fresh.className;
  return true;
}

const hintAnchor = (hint) => ({ exact: hint.quote, prefix: hint.prefix, suffix: hint.suffix, start: hint.start });

/**
 * Fills `menu` (an `.od-mentions` list) with `choices` from mentionChoices,
 * under their group headings, `selected` highlighted; `onPick(choice)` on a
 * click. Hidden when there is nothing to offer. The comment box and the doc's
 * text share it, so @ looks the same in both.
 */
export function fillMentionMenu(menu, choices, selected, onPick) {
  const items = [];
  let group = null;
  choices.forEach((choice, i) => {
    if (choice.group !== group) {
      group = choice.group;
      items.push(el('li', 'od-mentions-group', group));
    }
    const item = el('li', `od-mention${i === selected ? ' od-selected' : ''}`);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(i === selected));
    const who = el('span', 'od-mention-who');
    const name = el('span', 'od-mention-name', choice.name);
    if (choice.kind === 'agent') name.append(el('span', 'od-ai', 'AI'));
    who.append(name);
    if (choice.tagline) who.append(el('span', 'od-mention-sub', choice.tagline));
    item.append(avatar(choice.name, choice.kind, true), who);
    item.addEventListener('mousedown', (event) => {
      event.preventDefault();
      onPick(choice);
    });
    items.push(item);
  });
  menu.replaceChildren(...items);
  menu.hidden = choices.length === 0;
  menu.querySelector('.od-selected')?.scrollIntoView({ block: 'nearest' });
}

/**
 * `text` as nodes, each @name of someone in `people` ([{ name, kind }]) a
 * chip that shows their name card on hover.
 */
export function withMentions(text, people) {
  const nodes = [];
  let at = 0;
  for (const { start, end, name } of mentionSpans(text, people.map((p) => p.name))) {
    const who = people.find((p) => p.name === name);
    if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
    const chip = el('span', `od-at od-at-${who.kind}`, text.slice(start, end));
    chip.dataset.mention = who.name;
    chip.dataset.mentionKind = who.kind;
    nodes.push(chip);
    at = end;
  }
  if (at < text.length) nodes.push(document.createTextNode(text.slice(at)));
  return nodes;
}

/**
 * Makes `node` show the name card of `name` (`kind` 'agent' or 'human'; see
 * namecard.js), `how`: 'instant' or 'click'. The card says who it is, so the
 * browser's own tooltip goes.
 */
export function namecardFor(node, name, kind, how) {
  node.dataset.mention = name;
  node.dataset.mentionKind = kind;
  node.dataset.namecard = how;
  for (const titled of [node, ...node.querySelectorAll('[title]')]) titled.removeAttribute('title');
  return node;
}

export function avatar(name, kind, small = false) {
  const agent = kind === 'agent';
  const node = el('span', `od-avatar${agent ? ' od-avatar-agent' : ''}${small ? ' od-avatar-small' : ''}`);
  // Everyone's face is drawn from their name (faces.js): people round,
  // buddies a soft blob, so several in one doc are told apart at a glance.
  node.append(agent ? agentFace(name) : personFace(name));
  node.title = name;
  return node;
}

function dots() {
  const node = el('span', 'od-dots');
  node.append(el('i'), el('i'), el('i'));
  return node;
}

function checkIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'od-check');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z');
  svg.append(path);
  return svg;
}

function linkButton(text, onClick) {
  const button = el('button', 'od-link-button', text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// A comment's author as faces and name cards know them: 'agent' for a buddy.
const kindOf = (comment) => (comment.by.kind === 'ai' ? 'agent' : 'human');

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
