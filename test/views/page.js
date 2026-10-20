// The page the view contract tests (test/views.test.js) drive: any view,
// made on demand in a stage like the doc window's, and DOM helpers that work
// for any view that edits through contenteditable.

import { createMarkdownView } from '../../web/plugins/markdown/view.js';
import { pluginSettings } from '../../src/core/settings.js';
import { plain } from '../../web/plugins/plain/index.js';

const VIEWS = { markdown: createMarkdownView, plain: plain.createView };
const stage = document.querySelector('.od-stage');
let view = null;

const contract = {
  clicked: [],
  saved: [], // the settings changes the view asked to save
  async make(name, text, options = {}) {
    await view?.destroy();
    contract.clicked = [];
    contract.saved = [];
    view = await VIEWS[name]({ stage, text, settings: pluginSettings({ plugins: {} }, plain), ...options, onMarkClick: (id) => contract.clicked.push(id), saveSettings: (patch) => contract.saved.push(patch) });
    window.view = view;
  },
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
