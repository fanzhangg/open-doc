// The page the view contract tests (test/views.test.js) drive: any view,
// made on demand in a stage like the doc window's, and DOM helpers that work
// for any view that edits through contenteditable.

import { createMarkdownView } from '../../web/views/markdown/view.js';
import { viewSettings } from '../../src/core/settings.js';
import { plain } from '../../web/views/plain/index.js';
import { markdown } from '../../web/views/markdown/index.js';

const VIEWS = { markdown: createMarkdownView, plain: plain.createView };
const stage = document.querySelector('.pj-stage');
let view = null;

const contract = {
  clicked: [],
  saved: [], // the settings changes the view asked to save
  edits: [], // getText at each onEdit
  changes: 0, // how many times onChange fired
  images: {}, // what the view's `image` gives, by src
  // `toolbar: true` gives a Markdown view its toolbar, with that view's settings.
  async make(name, text, { toolbar = false, ...options } = {}) {
    await view?.destroy();
    document.querySelector('.pj-toolbar')?.remove();
    contract.clicked = [];
    contract.saved = [];
    contract.edits = [];
    contract.changes = 0;
    const bar = toolbar ? Object.assign(document.createElement('div'), { className: 'pj-toolbar', innerHTML: '<span class="pj-spacer"></span>' }) : null;
    if (bar) document.body.prepend(bar);
    const settings = viewSettings({ views: {} }, toolbar ? markdown : plain);
    view = await VIEWS[name]({ stage, text, settings, toolbar: bar, image: async (src) => contract.images[src] ?? null, ...options, onMarkClick: (id) => contract.clicked.push(id), onEdit: () => contract.edits.push(view.getText()), onChange: () => contract.changes++, saveSettings: (patch) => contract.saved.push(patch) });
    window.view = view;
  },
  // Press toolbar button `command`, as a click does.
  tool: (command) => document.querySelector(`.pj-toolbar [data-command="${command}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
  // Put the selection on characters [start, end) of the first piece of text holding `quote`.
  async select(quote, start = 0, end = quote.length) {
    const editable = stage.querySelector('[contenteditable]');
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.data.includes(quote)) node = walker.nextNode();
    const at = node.data.indexOf(quote);
    view.focus();
    const range = document.createRange();
    range.setStart(node, at + start);
    range.setEnd(node, at + end);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((done) => setTimeout(done, 50)); // the view takes in the selection
  },
  // The text drawn in the elements matching `selector`.
  drawn: (selector) => [...stage.querySelectorAll(selector)].map((el) => el.textContent).join(''),
};
window.contract = contract;
