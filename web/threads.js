// The comment margin, Google Docs style: one card per thread beside the text it
// is about, stacked so they never overlap, with the active card aligned to its
// text. The agent shows up like any other collaborator: an avatar, its
// replies (with what it changed in the doc and Undo, or the changes it
// proposes and Apply), and typing dots while it works. Only the human
// resolves threads.

import { activeWorking } from '../src/core/ops.js';
import { appliedBy } from './review.js';
import { icon } from './icons.js';
import { agentFace, personFace } from './faces.js';
import { MENTION_TOKEN } from '../src/core/mentions.js';

const GAP = 10;
const MENTION_BEFORE_CARET = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]*)$/;

/**
 * @param {HTMLElement} margin
 * @param {{ onCreate: (body: string) => Promise<void>, onCancelDraft: () => void,
 *           onReply: (threadId: string, body: string) => Promise<void>,
 *           onResolve: (threadId: string) => Promise<void>, onReopen: (threadId: string) => Promise<void>,
 *           onUndo: (threadId: string, message: object) => Promise<void>,
 *           onApply: (threadId: string, message: object) => Promise<void>,
 *           canApply: (message: object) => boolean,
 *           onReview: (threadId: string, message: object) => void, reviewing: () => string | null,
 *           onSelect: (threadId: string | null) => void,
 *           anchorTops: (items: { id: string, anchor: object }[]) => Map<string, number>,
 *           mentionChoices?: (query: string, me: string) => { name, kind, group, tagline? }[],
 *           replyHint?: (body: string, thread: object | null) => string,
 *           mentionable?: () => { name: string, kind: string }[] }} handlers
 */
export function createCommentMargin(margin, handlers) {
  let sidecar = { participants: [], threads: [] };
  let me = '';
  let activeId = null;
  let draft = null; // { hint } while composing a comment on the selected text
  let showResolved = false;
  const replyDrafts = new Map();
  const busy = new Set(); // ids of messages being undone or applied
  const errors = new Map(); // message id → why undo or apply failed
  const unfolded = new Set(); // ids of long messages shown in full
  const expanded = new Set(); // ids of long threads shown with every reply
  const narrow = window.matchMedia('(max-width: 900px)');

  // ---- rendering ----

  function visibleThreads() {
    return sidecar.threads.filter((t) => t.status === (showResolved ? 'resolved' : 'open'));
  }

  function render() {
    const focused = document.activeElement?.closest?.('[data-box]')?.dataset.box;
    const caret = document.activeElement?.selectionStart;

    margin.classList.toggle('od-margin-list', showResolved);
    const cards = [];
    if (draft) cards.push(draftCard());
    const threads = visibleThreads();
    for (const thread of threads) cards.push(threadCard(thread));
    if (showResolved && threads.length === 0) cards.push(el('p', 'od-empty', 'No resolved comments.'));

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
    const working = thread.status === 'open' ? activeWorking(thread, Date.now()) : null;
    card.classList.toggle('od-card-active', active);
    card.classList.toggle('od-card-working', Boolean(working));
    card.classList.toggle('od-card-resolved', thread.status === 'resolved');
    card.addEventListener('click', (event) => {
      if (!event.target.closest('textarea, button, a')) handlers.onSelect(thread.id);
    });

    if (thread.anchor && thread.detached) card.append(el('div', 'od-card-note', 'The text this was about was deleted.'));
    if (thread.anchor && (showResolved || thread.detached)) card.append(el('blockquote', 'od-quote', truncate(thread.anchor.exact, 120)));
    if (!thread.anchor) card.append(el('div', 'od-card-note', 'On the whole document'));

    const messages = thread.messages;
    const long = !active && messages.length > 3;
    const collapse = long && !expanded.has(thread.id);
    messages.forEach((message, i) => {
      if (long && i === 1) card.append(moreButton(thread.id, messages.slice(1, -1), !collapse));
      if (collapse && i > 0 && i < messages.length - 1) return;
      const row = messageRow(message, i === 0 && thread.status === 'open' ? resolveButton(thread) : null);
      if (message.proposal?.length) row.append(proposalBlock(thread, message, active));
      // An apply notice's edits are shown, and undone, on the proposal it applied.
      const applied = message.applies && messages.some((m) => m.id === message.applies);
      if (message.edits?.length && !applied) row.append(editBlock(thread, message, active));
      card.append(row);
    });

    if (working) {
      const row = el('div', 'od-typing');
      row.title = `${working.by} is working on it`;
      row.append(avatar(working.by, 'agent', true), dots());
      card.append(row);
    }
    if (thread.status === 'resolved') {
      const row = el('div', 'od-resolved-row');
      row.append(checkIcon(), el('span', '', `Resolved by ${thread.resolvedBy === me ? 'you' : thread.resolvedBy}`));
      row.append(linkButton('Reopen', () => handlers.onReopen(thread.id)));
      card.append(row);
    }
    if (active && thread.status === 'open') card.append(composer(`reply:${thread.id}`, 'Reply…', 'Reply', async (body) => {
      await handlers.onReply(thread.id, body);
      replyDrafts.delete(thread.id);
    }, () => handlers.onSelect(null), thread.id));
    return card;
  }

  function messageRow(message, action) {
    const row = el('div', 'od-msg');
    const head = el('div', 'od-msg-head');
    const who = el('div', 'od-who');
    const name = el('span', 'od-name', message.author.name === me ? `${me} (you)` : message.author.name);
    if (message.author.kind === 'agent') name.append(el('span', 'od-ai', 'AI'));
    who.append(name, el('time', 'od-time', relativeTime(message.createdAt)));
    const author = message.author;
    namecardFor(name, author.name, author.kind, 'click');
    head.append(namecardFor(avatar(author.name, author.kind), author.name, author.kind, 'click'), who);
    if (action) head.append(action);
    const open = unfolded.has(message.id);
    const body = el('div', `od-body${open ? '' : ' od-body-folded'}`);
    body.append(...withMentions(message.body, handlers.mentionable?.() ?? []));
    row.append(head, body, foldButton(message.id, open));
    return row;
  }

  // The replies folded out of a long thread: who wrote them, how many, and a
  // chevron, so it reads as something to open. It opens and closes in place.
  function moreButton(threadId, hidden, open) {
    const button = el('button', 'od-more');
    button.type = 'button';
    button.setAttribute('aria-expanded', String(open));
    const n = `${hidden.length} ${hidden.length === 1 ? 'reply' : 'replies'}`;
    if (!open) {
      const faces = el('span', 'od-more-faces');
      const authors = new Map(hidden.map((m) => [m.author.name, m.author.kind]));
      for (const [name, kind] of [...authors].slice(0, 3)) faces.append(avatar(name, kind, true));
      button.append(faces);
    }
    button.append(el('span', '', open ? `Hide ${n}` : `Show ${hidden.length} more ${hidden.length === 1 ? 'reply' : 'replies'}`), icon('chevron'));
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

  // What a reply changed in the doc: an inline diff with a little context,
  // and an Undo icon while the change can still be reverted.
  function editBlock(thread, message, active) {
    const undone = thread.messages.some((m) => m.undoes === message.id);
    const run = message.edits.some((e) => e.scope === 'run');
    const actions = undone ? [] : [actionButton('undo', 'Undo', `Revert ${message.author.name}'s change in the doc`, message, () => handlers.onUndo(thread.id, message))];
    return changeBlock({
      label: undone ? 'Undone' : run ? 'Edited in this run' : 'Edited',
      changes: message.edits,
      active,
      muted: undone,
      actions,
      error: errors.get(message.id),
      review: undone ? null : { thread, message },
    });
  }

  // What a reply suggests changing, with an Apply icon. Once applied, Undo
  // reverts the apply notice's edits; Apply is off when the original text
  // has changed since.
  function proposalBlock(thread, message, active) {
    const notice = appliedBy(thread, message);
    if (notice) {
      return changeBlock({
        label: 'Applied',
        changes: message.proposal,
        active,
        actions: [actionButton('undo', 'Undo', 'Undo applying this change', notice, () => handlers.onUndo(thread.id, notice))],
        error: errors.get(notice.id),
        review: notice.edits?.length ? { thread, message: notice } : null,
      });
    }
    const available = handlers.canApply(message);
    const apply = actionButton('check', 'Apply', available ? 'Apply this change to the doc' : 'The original text has changed since', message, () => handlers.onApply(thread.id, message));
    apply.classList.add('od-change-apply');
    apply.disabled ||= !available;
    return changeBlock({
      label: message.proposal.length === 1 ? 'Suggested edit' : `${message.proposal.length} suggested edits`,
      changes: message.proposal,
      active,
      muted: !available,
      actions: [apply],
      error: errors.get(message.id) ?? (available ? null : 'The original text has changed since.'),
      review: available ? { thread, message } : null,
    });
  }

  // `changes` are edits (§2.5) or proposed changes (§2.6): both read as
  // prefix + before → after + suffix. The lines are capped in height; with
  // `review` ({ thread, message }), clicking the block shows the whole change
  // in the doc, and clicking again hides it.
  function changeBlock({ label, changes, active, muted = false, actions, error, review = null }) {
    const block = el('div', 'od-change');
    block.classList.toggle('od-change-muted', muted);
    const head = el('div', 'od-change-head');
    const tools = el('div', 'od-change-actions');
    tools.append(...actions);
    head.append(el('span', 'od-change-label', label), tools);
    block.append(head);
    const lines = el('div', 'od-change-lines');
    const shown = active ? changes : changes.slice(0, 2);
    for (const change of shown) lines.append(diffLine(change));
    block.append(lines);
    if (shown.length < changes.length) block.append(el('div', 'od-change-more', `${changes.length - shown.length} more`));
    if (error) block.append(el('div', 'od-change-error', error));
    if (review) {
      block.classList.add('od-change-reviewable');
      block.classList.toggle('od-change-reviewing', handlers.reviewing() === review.message.id);
      block.title = handlers.reviewing() === review.message.id ? 'Hide this change in the doc' : 'Show this change in the doc';
      block.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        event.stopPropagation();
        handlers.onReview(review.thread.id, review.message);
      });
    }
    return block;
  }

  // A small icon button that runs `action` once at a time for `message`,
  // keeping its error to show under the block.
  function actionButton(name, label, title, message, action) {
    const button = el('button', 'od-change-button');
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', label);
    button.append(icon(name));
    button.disabled = busy.has(message.id);
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (busy.has(message.id)) return;
      busy.add(message.id);
      errors.delete(message.id);
      render();
      try {
        await action();
      } catch (error) {
        errors.set(message.id, error.message);
      } finally {
        busy.delete(message.id);
        render();
      }
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
    who.append(el('span', 'od-name', me));
    head.append(avatar(me, 'human'), who);
    card.append(head);
    card.append(composer('draft', 'Comment, or @ an agent', 'Comment', async (body) => {
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
  // the doc, agents to bring in, people), and a line under the box says who
  // will reply.
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
    const hint = el('div', 'od-composer-hint');
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
    const paintHint = () => {
      const thread = id.startsWith('reply:') ? sidecar.threads.find((t) => t.id === id.slice(6)) : null;
      hint.textContent = handlers.replyHint?.(box.value, thread) ?? '';
      hint.hidden = !hint.textContent;
    };
    const update = () => {
      if (draftKey) replyDrafts.set(draftKey, box.value);
      grow();
      const match = box.value.slice(0, box.selectionStart).match(MENTION_BEFORE_CARET);
      choices = match ? (handlers.mentionChoices?.(match[2], me) ?? []) : [];
      selected = 0;
      drawMenu();
      paintHint();
      layout();
    };
    const drawMenu = () => {
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
          pick(choice.name);
        });
        items.push(item);
      });
      menu.replaceChildren(...items);
      menu.hidden = choices.length === 0;
    };
    const pick = (name) => {
      const before = box.value.slice(0, box.selectionStart).replace(/@[A-Za-z0-9._-]*$/, `@${name} `);
      box.value = before + box.value.slice(box.selectionStart);
      box.setSelectionRange(before.length, before.length);
      choices = [];
      drawMenu();
      paintHint();
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
        paintHint();
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
    wrap.append(box, menu, hint, buttons);
    requestAnimationFrame(() => {
      grow();
      paintHint();
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
      clipChanges();
      return;
    }
    const byId = new Map(sidecar.threads.map((t) => [t.id, t]));
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
    clipChanges();
  }

  // Offer Show more only on messages cut off by their line clamp.
  function foldBodies() {
    for (const body of margin.querySelectorAll('.od-body-folded')) {
      body.nextElementSibling.hidden = body.scrollHeight <= body.clientHeight + 1;
    }
  }

  // Fade out the bottom of change lines taller than their cap.
  function clipChanges() {
    for (const lines of margin.querySelectorAll('.od-change-lines')) {
      lines.classList.toggle('od-change-clipped', lines.scrollHeight > lines.clientHeight + 1);
    }
  }
  window.addEventListener('resize', layout);
  narrow.addEventListener('change', layout);

  return {
    update(nextSidecar, nextMe) {
      sidecar = nextSidecar;
      me = nextMe;
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
 * `text` as nodes, each @name of someone in `people` ([{ name, kind }]) a
 * chip that shows their name card on hover.
 */
export function withMentions(text, people) {
  const byLower = new Map(people.map((p) => [p.name.toLowerCase(), p]));
  const nodes = [];
  let at = 0;
  for (const match of text.matchAll(MENTION_TOKEN)) {
    let token = match[2];
    // Sentence punctuation after a name ("@claude.") is not part of it.
    while (!byLower.has(token.toLowerCase()) && token.endsWith('.')) token = token.slice(0, -1);
    const who = byLower.get(token.toLowerCase());
    if (!who) continue;
    const start = match.index + match[1].length;
    if (start > at) nodes.push(document.createTextNode(text.slice(at, start)));
    const chip = el('span', `od-at od-at-${who.kind}`, `@${token}`);
    chip.dataset.mention = who.name;
    chip.dataset.mentionKind = who.kind;
    nodes.push(chip);
    at = start + 1 + token.length;
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
  // Everyone is a face of their own (faces.js): people round, agents a soft
  // blob, so several in one doc are told apart at a glance.
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

const oneLine = (s) => s.replace(/\s+/g, ' ');

// One change as it reads in the text: "…context <del>before</del><ins>after</ins> context…",
// the context cut at line breaks and to a few words.
function diffLine({ prefix, before, after, suffix }) {
  const line = el('div', 'od-change-line');
  let lead = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (lead.length > 24) lead = `…${lead.slice(-24).replace(/^\S*\s/, '')}`;
  const end = suffix.indexOf('\n');
  let tail = end === -1 ? suffix : suffix.slice(0, end);
  if (tail.length > 24) tail = `${tail.slice(0, 24).replace(/\s\S*$/, '')}…`;
  if (lead) line.append(el('span', 'od-change-context', oneLine(lead)));
  if (before) line.append(el('del', 'od-change-del', truncate(oneLine(before), 160)));
  if (after) line.append(el('ins', 'od-change-ins', truncate(oneLine(after), 160)));
  if (tail) line.append(el('span', 'od-change-context', oneLine(tail)));
  return line;
}

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
