// The page the two-writer harness (test/collab.test.js) drives: two Markdown
// views of one doc, joined by an in-memory host that orders edits, 150 ms
// away each way. Each view's page side is plan A (docs/markdown-view.md,
// Many writers): typing goes out as diffOps when it pauses; before taking the
// host's edits it reads getText once more, transforms, and shows the result
// with applyText. Thrown away once the plan is decided.

import { createMarkdownView } from '../../web/views/markdown/view.js';
import { markdown } from '../../web/views/markdown/index.js';
import { plain } from '../../web/views/plain/index.js';
import { viewFor } from '../../web/views/index.js';
import { resolveSettings, viewSettings } from '../../src/core/settings.js';
import { apply, diffOps, transform } from '../../src/core/ot.js';

const DELAY = Number(new URLSearchParams(location.search).get('delay') ?? 150); // ms each way
let inTransit = 0;
const later = (fn) => {
  inTransit++;
  setTimeout(() => {
    inTransit--;
    fn();
  }, DELAY);
};

const host = { text: '', log: [], clients: [] };
function submit(client, ops, rev) {
  for (const landed of host.log.slice(rev)) ops = transform(ops, landed);
  host.text = apply(host.text, ops);
  host.log.push(ops);
  for (const c of host.clients) later(() => (c === client ? c.ack() : c.receive(ops, client?.name ?? 'outside')));
}

function createClient(view, name) {
  const client = {
    view, name, last: '', rev: 0, pending: [], // pending[0] is at the host or on its way
    errors: [],
    drifts: [], // where getText after applyText was not the text given
    batches: [], // per batch from the host: ms in the getText before it, in applyText and setMarks, and in the getText after
    flush() {
      const text = view.getText();
      if (text === client.last) return;
      client.pending.push(diffOps(client.last, text, view.selection()?.to));
      client.last = text;
      if (client.pending.length === 1) client.send();
    },
    send() {
      const [ops] = client.pending;
      const rev = client.rev;
      later(() => submit(client, ops, rev));
    },
    ack() {
      client.rev++;
      client.pending.shift();
      if (client.pending.length) client.send();
    },
    receive(ops, by) {
      try {
        const start = performance.now();
        client.flush();
        const flushed = performance.now();
        client.rev++;
        client.pending = client.pending.map((mine) => {
          const moved = transform(mine, ops);
          ops = transform(ops, mine, { first: true });
          return moved;
        });
        client.last = apply(client.last, ops);
        view.applyText(client.last, { by });
        // The other's cursor, after what they typed, is a mark (plan A, 3).
        let at = 0;
        let shift = 0;
        for (const op of ops) {
          at = op.from + shift + op.insert.length;
          shift += op.insert.length - (op.to - op.from);
        }
        view.setMarks([{ kind: 'cursor', at, by, working: false }]);
        const applied = performance.now();
        const shown = view.getText();
        client.batches.push({ before: flushed - start, applyText: applied - flushed, after: performance.now() - applied });
        // The view rewrote what it was given: the next pause sends that as an edit.
        if (shown !== client.last) client.drifts.push(diffOps(client.last, shown).map((op) => client.last.slice(op.from - 40, op.to + 40)));
      } catch (error) {
        client.errors.push({ kind: 'error', message: String(error.stack) });
      }
    },
  };
  return client;
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
    Object.assign(host, { text, log: [], clients: [] });
    const chosen = kind === 'auto' ? viewFor('doc.md', resolveSettings({}), text) : { id: kind, editable: true };
    const declared = chosen.id === 'plain' ? plain : markdown;
    const create = chosen.id === 'plain' ? plain.createView : createMarkdownView;
    collab.clients = await Promise.all(stages.map(async (stage) => {
      let client;
      const toolbar = stage.closest('main').previousElementSibling;
      const view = await create({ stage, text, name: 'doc.md', toolbar, editable: chosen.editable, settings: viewSettings({ views: {} }, declared), onChange: () => client.flush() });
      client = createClient(view, stage.closest('[data-name]')?.dataset.name ?? 'other');
      client.last = text;
      return client;
    }));
    host.clients = collab.clients;
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
      for (const c of collab.clients) c.flush();
      await new Promise((done) => setTimeout(done, DELAY * 2 + 50));
      if (inTransit === 0 && collab.clients.every((c) => c.pending.length === 0)) return collab.state();
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
  inject: (ops) => submit(null, ops, host.log.length),
};
window.collab = collab;
