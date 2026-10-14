// The thread pane: General / Open / Detached / Resolved threads, each with
// its messages, a one-line reply bar with @ autocomplete, and Resolve/Reopen.

const WORKING_TTL_MS = 5 * 60 * 1000;
const MENTION_BEFORE_CARET = /(^|[^A-Za-z0-9._-])@([A-Za-z0-9._-]*)$/;

/**
 * @param {HTMLElement} pane
 * @param {{ onReply: (threadId: string, body: string) => Promise<void>,
 *           onCreate: (body: string) => Promise<void>,
 *           onCancelDraft: () => void,
 *           onResolve: (threadId: string) => void, onReopen: (threadId: string) => void,
 *           onSelect: (threadId: string) => void }} handlers
 */
export function createThreadPane(pane, handlers) {
  let sidecar = { participants: [], threads: [] };
  let me = '';
  let activeId = null;
  let draft = null; // { quote } | { quote: null } while composing a new thread
  let showResolved = false;
  const replyDrafts = new Map();

  const list = pane.querySelector('.od-threads');
  pane.querySelector('.od-new-doc-comment').addEventListener('click', () => {
    draft = { quote: null };
    render();
    list.querySelector('.od-draft input')?.focus();
  });
  const toggle = pane.querySelector('.od-show-resolved');
  toggle.addEventListener('change', () => {
    showResolved = toggle.checked;
    render();
  });

  function render() {
    // Keep focus and caret in whichever bar the user is typing in.
    const focused = document.activeElement?.closest?.('[data-bar]')?.dataset.bar;
    const caret = document.activeElement?.selectionStart;

    list.replaceChildren();
    if (draft) list.append(draftCard());

    const open = sidecar.threads.filter((t) => t.status === 'open');
    const general = open.filter((t) => !t.anchor);
    const anchored = open.filter((t) => t.anchor && !t.detached).sort((a, b) => a.anchor.start - b.anchor.start);
    const detached = open.filter((t) => t.anchor && t.detached);
    const resolved = sidecar.threads.filter((t) => t.status === 'resolved');

    section('General', general);
    section('Open', anchored);
    section('Detached', detached, 'The text these threads were attached to is gone.');
    if (showResolved) section('Resolved', resolved);
    pane.querySelector('.od-resolved-count').textContent = resolved.length ? `(${resolved.length})` : '';
    if (!list.querySelector('.od-thread') && !draft) {
      list.append(el('p', 'od-empty', 'No comments yet. Select text in the doc to comment on it.'));
    }

    if (focused) {
      const input = list.querySelector(`[data-bar="${focused}"] input`);
      if (input) {
        input.focus();
        if (caret !== undefined && caret !== null) input.setSelectionRange(caret, caret);
      }
    }
  }

  function section(title, threads, note) {
    if (threads.length === 0) return;
    list.append(el('h3', 'od-section', title));
    if (note) list.append(el('p', 'od-note', note));
    for (const thread of threads) list.append(threadCard(thread));
  }

  function threadCard(thread) {
    const card = el('article', 'od-thread');
    card.dataset.thread = thread.id;
    if (thread.id === activeId) card.classList.add('od-active');
    if (thread.status === 'resolved') card.classList.add('od-resolved');
    card.addEventListener('click', (event) => {
      if (!event.target.closest('input, button')) handlers.onSelect(thread.id);
    });

    if (thread.anchor) card.append(el('blockquote', 'od-quote', truncate(thread.anchor.exact, 140)));
    for (const message of thread.messages) {
      const row = el('div', 'od-message');
      const head = el('div', 'od-message-head');
      head.append(el('span', 'od-author', message.author.name));
      if (message.author.kind === 'agent') head.append(el('span', 'od-badge', 'agent'));
      head.append(el('time', 'od-time', relativeTime(message.createdAt)));
      row.append(head, el('div', 'od-body', message.body));
      card.append(row);
    }
    const working = thread.working && Date.now() - Date.parse(thread.working.since) < WORKING_TTL_MS;
    if (working) card.append(el('div', 'od-working', `${thread.working.by} is responding`));
    if (thread.status === 'resolved') card.append(el('div', 'od-resolved-by', `Resolved by ${thread.resolvedBy}`));

    const actions = el('div', 'od-actions');
    actions.append(textBar(`reply:${thread.id}`, thread.status === 'resolved' ? 'Reply to reopen…' : 'Reply…', async (body) => {
      await handlers.onReply(thread.id, body);
      replyDrafts.delete(thread.id);
    }, replyDrafts, thread.id));
    const resolveButton = el('button', 'od-link-button', thread.status === 'resolved' ? 'Reopen' : 'Resolve');
    resolveButton.addEventListener('click', () =>
      (thread.status === 'resolved' ? handlers.onReopen : handlers.onResolve)(thread.id));
    actions.append(resolveButton);
    card.append(actions);
    return card;
  }

  function draftCard() {
    const card = el('article', 'od-thread od-draft');
    card.append(el('div', 'od-draft-title', draft.quote ? 'New comment' : 'New comment on the document'));
    if (draft.quote) card.append(el('blockquote', 'od-quote', truncate(draft.quote, 140)));
    const bar = textBar('draft', 'Comment… (@ to mention)', async (body) => {
      await handlers.onCreate(body);
      draft = null;
      render();
    });
    const cancel = el('button', 'od-link-button', 'Cancel');
    cancel.addEventListener('click', () => {
      draft = null;
      handlers.onCancelDraft();
      render();
    });
    const actions = el('div', 'od-actions');
    actions.append(bar, cancel);
    card.append(actions);
    return card;
  }

  // One plain text bar: Enter posts, Escape cancels, @ autocompletes names.
  function textBar(id, placeholder, submit, drafts, key) {
    const wrap = el('div', 'od-bar');
    wrap.dataset.bar = id;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = drafts?.get(key) ?? '';
    const menu = el('ul', 'od-mentions');
    menu.hidden = true;
    let choices = [];
    let selected = 0;

    const update = () => {
      drafts?.set(key, input.value);
      const match = input.value.slice(0, input.selectionStart).match(MENTION_BEFORE_CARET);
      choices = match
        ? sidecar.participants.filter((p) => p.name.toLowerCase().startsWith(match[2].toLowerCase()) && p.name !== me)
        : [];
      selected = 0;
      drawMenu();
    };
    const drawMenu = () => {
      menu.replaceChildren(...choices.map((p, i) => {
        const item = el('li', i === selected ? 'od-selected' : '', p.name);
        if (p.kind === 'agent') item.append(el('span', 'od-badge', 'agent'));
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          pick(p.name);
        });
        return item;
      }));
      menu.hidden = choices.length === 0;
    };
    const pick = (name) => {
      const before = input.value.slice(0, input.selectionStart).replace(/@[A-Za-z0-9._-]*$/, `@${name} `);
      input.value = before + input.value.slice(input.selectionStart);
      input.setSelectionRange(before.length, before.length);
      choices = [];
      drawMenu();
      drafts?.set(key, input.value);
    };

    input.addEventListener('input', update);
    input.addEventListener('blur', () => setTimeout(() => { menu.hidden = true; }, 100));
    input.addEventListener('keydown', async (event) => {
      if (choices.length > 0 && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
        event.preventDefault();
        if (event.key === 'ArrowDown') selected = (selected + 1) % choices.length;
        else if (event.key === 'ArrowUp') selected = (selected - 1 + choices.length) % choices.length;
        else pick(choices[selected].name);
        drawMenu();
        return;
      }
      if (event.key === 'Escape') {
        if (id === 'draft') {
          draft = null;
          handlers.onCancelDraft();
          render();
        } else {
          input.blur();
        }
        return;
      }
      if (event.key === 'Enter' && input.value.trim()) {
        event.preventDefault();
        const body = input.value.trim();
        input.disabled = true;
        try {
          await submit(body);
          input.value = '';
        } finally {
          input.disabled = false;
        }
      }
    });
    wrap.append(input, menu);
    return wrap;
  }

  return {
    update(nextSidecar, nextMe) {
      sidecar = nextSidecar;
      me = nextMe;
      render();
    },
    startDraft(quote) {
      draft = { quote };
      render();
      list.querySelector('.od-draft input')?.focus();
    },
    setActive(id) {
      activeId = id;
      render();
      list.querySelector(`[data-thread="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  };
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
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}
