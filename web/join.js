// Who a teammate's page is, in a plain browser (docs/user-experience.md,
// Sharing a project): a key made once in this browser, by which the host
// knows them (it is never shown; their id is its hash), and the name they
// pick the first time they open a link.

import { NAME_PATTERN } from '../src/core/mentions.js';

const KEY = 'ponjo.key';
const NAME = 'ponjo.name';
const NAME_RULE = 'Letters, digits, dot, dash or underscore, starting with a letter or digit';

function stored(item) {
  try {
    return localStorage.getItem(item);
  } catch {
    return null; // no storage: a new key, and the name asked, each time
  }
}

function store(item, value) {
  try {
    localStorage.setItem(item, value);
  } catch {
    // kept for this page only
  }
}

let key = stored(KEY);
let name = stored(NAME);

/** { key, name } for the line to the host (web/relay.js). */
export function identity() {
  if (!key) {
    key = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
    store(KEY, key);
  }
  return { key, name: name ?? '' };
}

/** Whether the teammate has picked a name. */
export const named = () => Boolean(name);

/** Ask the teammate's name, `problem` saying why it is asked again; resolves once it is picked. */
export function askName(problem = '') {
  const form = document.querySelector('.pj-join');
  const field = form.querySelector('input');
  const error = form.querySelector('.pj-input-error');
  const show = (message) => {
    error.textContent = message;
    error.hidden = !message;
    field.toggleAttribute('aria-invalid', Boolean(message));
  };
  field.value = name ?? '';
  show(problem);
  form.hidden = false;
  field.focus();
  return new Promise((done) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const picked = field.value.trim();
      if (!NAME_PATTERN.test(picked)) return show(NAME_RULE);
      name = picked;
      store(NAME, picked);
      form.hidden = true;
      done();
    });
  });
}
