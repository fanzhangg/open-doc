// The comment margin, Google Docs style: one card per thread beside the text it
// is about, stacked so they never overlap, with the active card aligned to its
// text. The agent shows up like any other collaborator: an avatar, its
// replies, "working on it" while it runs, and "Resolved by …" when it is done,
// kept in place until the human dismisses it.

import { activeWorking } from '../src/core/ops.js';

const MENTION_BEFORE_CARET = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]*)$/;
const GAP = 10;
const PALETTE = ['#1a73e8', '#188038', '#9334e6', '#e37400', '#d01884', '#007b83', '#5f6368'];

/**
 * @param {HTMLElement} margin
 * @param {{ onCreate: (body: string) => Promise<void>, onCancelDraft: () => void,
 *           onReply: (threadId: string, body: string) => Promise<void>,
 *           onResolve: (threadId: string) => Promise<void>, onReopen: (threadId: string) => Promise<void>,
 *           onSelect: (threadId: string | null) => void,
 *           anchorTops: (items: { id: string, anchor: object }[]) => Map<string, number> }} handlers
 */
export function createCommentMargin(margin, handlers) {
  let sidecar = { participants: [], threads: [] };
  let me = '';
  let agent = null; // dispatcher status, or null
  let activeId = null;
  let draft = null; // { hint } while composing; hint null for a comment on the whole doc
  let showResolved = false;
  const recentlyResolved = new Set(); // resolved during this visit; shown until dismissed
  const dismissed = new Set();
  const knownOpen = new Set();
  const replyDrafts = new Map();
  const narrow = window.matchMedia('(max-width: 900px)');

  // ---- rendering ----

  function visibleThreads() {
    if (showResolved) return sidecar.threads.filter((t) => t.status === 'resolved');
    return sidecar.threads.filter((t) => t.status === 'open' || (recentlyResolved.has(t.id) && !dismissed.has(t.id)));
  }

  function render() {
    const focused = document.activeElement?.closest?.('[data-box]')?.dataset.box;
    const caret = document.activeElement?.selectionStart;

    margin.replaceChildren();
    margin.classList.toggle('od-margin-list', showResolved);
    if (draft) margin.append(draftCard());
    const threads = visibleThreads();
    for (const thread of threads) margin.append(threadCard(thread));
    if (showResolved && threads.length === 0) margin.append(el('p', 'od-empty', 'No resolved comments.'));

    if (focused) {
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
    const collapse = !active && messages.length > 3;
    messages.forEach((message, i) => {
      if (collapse && i > 0 && i < messages.length - 1) {
        if (i === 1) card.append(el('div', 'od-more', `${messages.length - 2} more ${messages.length - 2 === 1 ? 'reply' : 'replies'}`));
        return;
      }
      card.append(messageRow(message, i === 0 && thread.status === 'open' ? resolveButton(thread) : null));
    });

    if (working) {
      const row = el('div', 'od-typing');
      row.append(avatar(working.by, 'agent', true), el('span', '', `${working.by} is working on it`), dots());
      card.append(row);
    }
    if (thread.status === 'resolved') {
      const row = el('div', 'od-resolved-row');
      row.append(checkIcon(), el('span', '', `Resolved by ${thread.resolvedBy === me ? 'you' : thread.resolvedBy}`));
      const reopen = linkButton('Reopen', () => handlers.onReopen(thread.id));
      row.append(reopen);
      if (!showResolved) {
        row.append(linkButton('Dismiss', () => {
          dismissed.add(thread.id);
          if (activeId === thread.id) handlers.onSelect(null);
          render();
        }));
      }
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
    head.append(avatar(message.author.name, message.author.kind), who);
    if (action) head.append(action);
    row.append(head, el('div', 'od-body', message.body));
    return row;
  }

  function resolveButton(thread) {
    const button = el('button', 'od-icon-button');
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
    if (!draft.hint) who.append(el('span', 'od-time', 'On the whole document'));
    head.append(avatar(me, 'human'), who);
    card.append(head);
    const placeholder = agentAnswers() ? `Comment, or ask ${agent.name} to change something…` : 'Comment… (@ to mention)';
    card.append(composer('draft', placeholder, 'Comment', async (body) => {
      await handlers.onCreate(body);
      draft = null;
      render();
    }, () => {
      draft = null;
      handlers.onCancelDraft();
      render();
    }));
    const hint = agentHint();
    if (hint) card.append(el('div', 'od-hint', hint));
    return card;
  }

  function agentAnswers() {
    return agent && !['unavailable', 'stopped'].includes(agent.state);
  }

  function agentHint() {
    if (!agent) return '';
    if (agent.state === 'unavailable') return `${agent.name} is unavailable.`;
    if (agent.state === 'paused') return `${agent.name} is paused and will reply when resumed.`;
    return agent.mentionsOnly ? `Mention @${agent.name} to have them reply.` : `${agent.name} will reply. @mention someone else to keep ${agent.name} out of it.`;
  }

  // A growing text box: Enter posts, Shift+Enter breaks the line, Escape cancels, @ autocompletes names.
  function composer(id, placeholder, submitLabel, submit, cancel, draftKey) {
    const wrap = el('div', 'od-composer');
    wrap.dataset.box = id;
    const box = document.createElement('textarea');
    box.rows = 1;
    box.placeholder = placeholder;
    box.value = draftKey ? replyDrafts.get(draftKey) ?? '' : '';
    const menu = el('ul', 'od-mentions');
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
      choices = match
        ? sidecar.participants.filter((p) => p.name.toLowerCase().startsWith(match[2].toLowerCase()) && p.name !== me)
        : [];
      selected = 0;
      drawMenu();
      layout();
    };
    const drawMenu = () => {
      menu.replaceChildren(...choices.map((p, i) => {
        const item = el('li', i === selected ? 'od-selected' : '');
        item.append(avatar(p.name, p.kind), el('span', '', p.name));
        if (p.kind === 'agent') item.append(el('span', 'od-ai', 'AI'));
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pick(p.name);
        });
        return item;
      }));
      menu.hidden = choices.length === 0;
    };
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
      if (choices.length > 0 && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowDown') selected = (selected + 1) % choices.length;
        else if (event.key === 'ArrowUp') selected = (selected - 1 + choices.length) % choices.length;
        else pick(choices[selected].name);
        drawMenu();
        return;
      }
      if (event.key === 'Escape') {
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
    const cards = [...margin.querySelectorAll('.od-card')];
    if (showResolved || narrow.matches) {
      for (const card of cards) card.style.top = '';
      margin.style.height = '';
      return;
    }
    const byId = new Map(sidecar.threads.map((t) => [t.id, t]));
    const items = cards.map((card) => {
      const id = card.dataset.thread;
      return { card, id, anchor: id === 'draft' ? draft?.hint && hintAnchor(draft.hint) : byId.get(id)?.anchor };
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
  window.addEventListener('resize', layout);
  narrow.addEventListener('change', layout);

  return {
    update(nextSidecar, nextMe) {
      // A thread someone else resolved while the page was open stays visible
      // as "Resolved by …" so the human sees what was done.
      for (const thread of nextSidecar.threads) {
        if (thread.status === 'open') knownOpen.add(thread.id);
        else if (knownOpen.has(thread.id)) {
          knownOpen.delete(thread.id);
          if (thread.resolvedBy !== nextMe) recentlyResolved.add(thread.id);
        }
      }
      sidecar = nextSidecar;
      me = nextMe;
      render();
    },
    setAgent(status) {
      agent = status;
      if (draft) render();
    },
    startDraft(hint) {
      draft = { hint };
      showResolved = false;
      render();
      margin.querySelector('.od-card-draft textarea')?.focus();
    },
    setActive(id) {
      activeId = id;
      render();
      if (narrow.matches) margin.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (id) margin.querySelector(`[data-thread="${id}"] textarea`)?.focus({ preventScroll: true });
    },
    setShowResolved(value) {
      showResolved = value;
      render();
    },
    resolvedCount: () => sidecar.threads.filter((t) => t.status === 'resolved').length,
    layout,
    rerender: render,
  };
}

const hintAnchor = (hint) => ({ exact: hint.quote, prefix: hint.prefix, suffix: hint.suffix, start: hint.start });

export function avatar(name, kind, small = false) {
  const node = el('span', `od-avatar${kind === 'agent' ? ' od-avatar-agent' : ''}${small ? ' od-avatar-small' : ''}`, initials(name));
  if (kind !== 'agent') node.style.background = colorFor(name);
  node.title = name;
  return node;
}

function initials(name) {
  const parts = name.split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

function colorFor(name) {
  let hash = 0;
  for (const ch of name.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
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

function relativeTime(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}
