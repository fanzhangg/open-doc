// The page the two-writer harness (test/collab.test.js) drives: two views of
// one doc, each with the page's side of the doc host's order
// (web/client.js), joined to the doc host the harness starts as the app does
// (test/views/main.js), 150 ms away each way. Plan A (docs/markdown-view.md,
// Many writers): typing goes out as operations when it pauses; before taking
// the host's edits a view's text is read once more, the edits moved over
// what it has not landed, and shown with applyText.

import { createMarkdownView } from '../../web/views/markdown/view.js';
import { markdown } from '../../web/views/markdown/index.js';
import { plain } from '../../web/views/plain/index.js';
import { viewFor } from '../../web/views/index.js';
import { resolveSettings, viewSettings } from '../../src/core/settings.js';
import { apply } from '../../src/core/ot.js';
import { createClient } from '../../web/client.js';
import { rulesOf } from '../../src/rules/index.js';

const DELAY = Number(new URLSearchParams(location.search).get('delay') ?? 150); // ms each way
let inTransit = 0;
const later = (fn) => {
  inTransit++;
  setTimeout(() => {
    inTransit--;
    fn();
  }, DELAY);
};
const bridge = window.collabHost;

// The doc host's text, as its `ops` events tell it.
const host = { text: '', rev: 0, epoch: null };
bridge.onEvent((name, data) => {
  if (name !== 'ops' || data.epoch !== host.epoch) return;
  host.text = apply(host.text, data.ops);
  host.rev = data.rev;
  for (const c of collab.clients) later(() => c.client.receive(data));
});

// A call to the doc host, 150 ms there and 150 ms back.
const call = (type, arg) => new Promise((resolve, reject) => later(async () => {
  const { result, error } = await bridge.call(type, arg);
  later(() => (error ? reject(Object.assign(new Error(error.message), { code: error.code })) : resolve(result)));
}));

function createHarnessClient(view, name) {
  const harness = {
    view, name,
    errors: [],
    drifts: [], // where getText after applyText was not the text given
    batches: [], // per batch from the host: ms in the getText before it and the move over pending, in applyText and setMarks, and in the getText after
  };
  let received = 0;
  harness.client = createClient({
    view,
    call,
    rules: () => rulesOf('doc.md', resolveSettings({})),
    onError: (error) => harness.errors.push({ kind: 'error', message: String(error.stack) }),
    show(text, ops, event) {
      try {
        const shown = performance.now();
        view.applyText(text, { by: event?.id ? 'other' : 'outside' });
        // The other's cursor, after what they typed, is a mark (plan A, 3).
        let at = 0;
        let shift = 0;
        for (const op of ops) {
          at = op.from + shift + op.insert.length;
          shift += op.insert.length - (op.to - op.from);
        }
        view.setMarks([{ kind: 'cursor', at, by: 'other', working: false }]);
        const applied = performance.now();
        const after = view.getText();
        harness.batches.push({ before: shown - received, applyText: applied - shown, after: performance.now() - applied });
        // The view rewrote what it was given: the next pause sends that as an edit.
        if (after !== text) harness.drifts.push(diffs(text, after));
      } catch (error) {
        harness.errors.push({ kind: 'error', message: String(error.stack) });
      }
    },
  });
  const receive = harness.client.receive;
  harness.client.receive = (event) => {
    received = performance.now();
    receive(event);
  };
  return harness;
}

// Where `a` and `b` differ, with some text around it.
function diffs(a, b) {
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  return a.slice(Math.max(0, start - 40), start + 40);
}

const stages = [...document.querySelectorAll('.od-stage')];
const collab = {
  host,
  clients: [],
  // Both views of `text`: the Markdown view, `{ view: 'plain' }`, or
  // `{ view: 'auto' }`, the one the app would open a .md doc in (read-only
  // past every view's limits). Resolves to that view's id and whether it edits.
  async make(text, { view: kind = 'markdown' } = {}) {
    for (const c of collab.clients) await c.view.destroy();
    collab.clients = [];
    await bridge.make(text);
    const { result: state } = await bridge.call('state');
    Object.assign(host, { text: state.text, rev: state.rev, epoch: state.epoch });
    // As the app makes it: its size judged by viewFor, named as a Markdown doc.
    const sized = viewFor('doc.md', resolveSettings({}), text);
    const chosen = kind === 'auto' ? sized : { id: kind, editable: true, color: sized.color };
    const declared = chosen.id === 'plain' ? plain : markdown;
    const create = chosen.id === 'plain' ? plain.createView : createMarkdownView;
    collab.clients = await Promise.all(stages.map(async (stage) => {
      let harness;
      const toolbar = stage.closest('main').previousElementSibling;
      const view = await create({ stage, text, name: 'doc.md', toolbar, editable: chosen.editable, color: chosen.color, settings: viewSettings({ views: {} }, declared), onChange: () => harness.client.flush() });
      harness = createHarnessClient(view, stage.closest('[data-name]')?.dataset.name ?? 'other');
      harness.client.start(state);
      return harness;
    }));
    return { id: chosen.id, editable: chosen.editable };
  },
  // Put the caret (or a selection) in view i on characters [start, end) of
  // the first `quote` in its drawn text (a glow can split it across nodes).
  async select(i, quote, start = 0, end = start) {
    const editable = stages[i].querySelector('[contenteditable]');
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const at = nodes.map((node) => node.data).join('').indexOf(quote);
    if (at === -1) throw new Error(`no "${quote}" in view ${i}: ${JSON.stringify(collab.clients[i].view.getText())}`);
    // A point on a node boundary is in the node the quote is on.
    const point = (k) => {
      let offset = at + k;
      for (const node of nodes) {
        if (offset < node.data.length || (k > 0 && offset === node.data.length) || node === nodes.at(-1)) return [node, offset];
        offset -= node.data.length;
      }
    };
    collab.clients[i].view.focus();
    const range = document.createRange();
    range.setStart(...point(start));
    range.setEnd(...point(end));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((done) => setTimeout(done, 30));
  },
  // Put the caret in view i at place `r` (0 to 1) along its text.
  async caretAt(i, r) {
    const editable = stages[i].querySelector('[contenteditable]');
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    const total = nodes.reduce((n, node) => n + node.data.length, 0);
    let at = Math.floor(r * total);
    const node = nodes.find((node) => (at -= node.data.length) <= 0) ?? nodes.at(-1);
    collab.clients[i].view.focus();
    if (!node) return;
    const range = document.createRange();
    range.setStart(node, node.data.length + Math.min(0, at));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((done) => setTimeout(done, 10));
  },
  // Flush both views and wait until nothing is on its way: every view and the host agree.
  async settle() {
    for (;;) {
      for (const c of collab.clients) c.client.flush();
      await new Promise((done) => setTimeout(done, DELAY * 2 + 50));
      if (inTransit === 0 && collab.clients.every((c) => c.client.idle())) return collab.state();
    }
  },
  state: () => ({
    host: host.text,
    texts: collab.clients.map((c) => c.view.getText()),
    errors: collab.clients.flatMap((c) => c.errors),
    drifts: collab.clients.flatMap((c) => c.drifts),
  }),
  selection: (i) => collab.clients[i].view.selection(),
  // Press toolbar button `command` of view i, as a click does.
  tool: (i, command) => stages[i].closest('main').previousElementSibling.querySelector(`[data-command="${command}"]`)
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
  focus: (i) => collab.clients[i].view.focus(),
  batches: () => collab.clients.flatMap((c) => c.batches),
  // An edit from a third writer, landing at the host now.
  async inject(ops) {
    const { result } = await bridge.call('state');
    return bridge.call('submit', { ops, rev: result.rev, epoch: result.epoch, id: 'third' });
  },
  // The doc changed outside (git pull), to `text`.
  pull: (text) => bridge.write(text),
  // A comment asking the doc's buddy; `release` lets one that holds go on.
  async ask(body) {
    await bridge.hold();
    return bridge.call('comment', { anchor: null, body });
  },
  release: () => bridge.release(),
  // The replies of the doc's buddy.
  replies: async () => (await bridge.call('state')).result.threads.flatMap((t) => t.comments).filter((c) => c.by.kind === 'ai'),
};
window.collab = collab;
