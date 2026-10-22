// Find and replace, the same in every view: a bar at the top of the page
// (Mod+F; Mod+Alt+F with Replace), every match marked and the current one
// stronger. The view finds in what a reader sees and does the replacing, as
// the person's own edit (web/views/: each view makes its bar).

import { hydrateIcons } from './icons.js';

const BAR = `
  <div class="pj-find" hidden>
    <div class="pj-find-box" role="search" aria-label="Find">
      <div class="pj-find-row">
        <input class="pj-find-input" type="text" autocomplete="off" spellcheck="false" aria-label="Find" placeholder="Find">
        <span class="pj-count pj-find-count" aria-live="polite"></span>
        <button type="button" class="pj-icon-btn" data-action="previous" data-icon="up" data-tip="Previous" data-keys="Mod+Shift+G" aria-label="Previous"></button>
        <button type="button" class="pj-icon-btn" data-action="next" data-icon="chevron" data-tip="Next" data-keys="Mod+G" aria-label="Next"></button>
        <button type="button" class="pj-icon-btn" data-action="close" data-icon="close" data-tip="Close" data-keys="Esc" aria-label="Close"></button>
      </div>
      <div class="pj-find-row" data-replace hidden>
        <input class="pj-find-input" type="text" autocomplete="off" spellcheck="false" aria-label="Replace with" placeholder="Replace with">
        <button type="button" class="pj-secondary" data-action="replace">Replace</button>
        <button type="button" class="pj-secondary" data-action="all">Replace all</button>
      </div>
    </div>
  </div>`;

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/** The ranges [start, end) of `query` in `text`, ignoring case. */
export function matches(text, query) {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return [...text.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length]);
}

/**
 * A find bar for a view, over its `host` (the view's `.pj-editor`).
 * `search` is the view's: `find(query)` marks every match and answers
 * `{ count, current }` (current: which one is selected, from 1; 0 for none),
 * `step(back)` selects the next or previous one, `replace(text, all)` puts
 * `text` for the selected match (then selects the next) or for every one,
 * all three answering as `find` does; `selected()` is the selected text, and
 * `focus()` gives the text the focus back. A view that cannot be edited
 * (`editable` false) has no Replace.
 */
export function createFind(search, { host, editable }) {
  const template = document.createElement('template');
  template.innerHTML = BAR;
  hydrateIcons(template.content);
  const bar = template.content.firstElementChild;
  host.before(bar);
  const [input, replacement] = bar.querySelectorAll('input');
  const row = bar.querySelector('[data-replace]');
  const count = bar.querySelector('.pj-find-count');

  const show = ({ count: n, current }) => {
    count.textContent = !input.value ? '' : n === 0 ? 'No results' : current ? `${current} of ${n}` : `${n} found`;
  };
  const find = () => show(search.find(input.value));

  function open(replacing) {
    const selected = search.selected();
    if (selected && !selected.includes('\n')) input.value = selected;
    bar.hidden = false;
    row.hidden = !(editable && (replacing || !row.hidden));
    find();
    input.select();
    (replacing && editable ? replacement : input).focus();
  }

  function close() {
    bar.hidden = true;
    search.find('');
    search.focus();
  }

  bar.addEventListener('input', (event) => {
    if (event.target === input) find();
  });
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault();
      show(search.step(event.shiftKey));
    } else if (event.key === 'Enter' && event.target === replacement) {
      event.preventDefault();
      show(search.replace(replacement.value, mac ? event.metaKey : event.ctrlKey));
    }
  });
  // Mod+F (Mod+Alt+F: with Replace), Mod+G and Mod+Shift+G (the next and
  // previous match), in the text or the bar; in a view that cannot be edited
  // the text never has the focus, only the selection.
  const done = new AbortController();
  document.addEventListener('keydown', (event) => {
    const here = [document.activeElement, getSelection()?.anchorNode].some((node) => host.contains(node) || bar.contains(node));
    if (!here || !(mac ? event.metaKey : event.ctrlKey) || !['KeyF', 'KeyG'].includes(event.code) || (event.code === 'KeyF' && event.shiftKey)) return;
    event.preventDefault();
    if (event.code === 'KeyF') open(event.altKey);
    else if (bar.hidden) open(false);
    else show(search.step(event.shiftKey));
  }, { capture: true, signal: done.signal });
  // The buttons act without taking the focus from the field.
  bar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button')) event.preventDefault();
  });
  bar.addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'close') close();
    else if (action === 'next' || action === 'previous') show(search.step(action === 'previous'));
    else if (action === 'replace' || action === 'all') show(search.replace(replacement.value, action === 'all'));
  });

  return {
    /** The text changed: find again, while the bar is open. */
    changed() {
      if (!bar.hidden && input.value) find();
    },
    destroy() {
      done.abort();
      bar.remove();
    },
  };
}
