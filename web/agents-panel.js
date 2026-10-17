// The Buddies panel: the buddies this doc reaches, in a dialog of their own.
// On the left, the list; on the right, the one picked: its name, where its
// file is, and who it is. What runs every buddy is the agent picked in
// Settings.
//
// Changes save to the buddy's file as they are made. A new buddy is a draft
// until Create: nothing is saved before it has a name, so one left half
// made (the panel closed, Esc, another buddy picked) leaves no trace. New
// buddies are the project's. Clippy is in every doc: who it is is yours to
// change, its name is not.

import { api } from './api.js';
import { avatar } from './threads.js';
import { NAME_RULE } from './agent.js';
import { BUDDY_RULES, checkBuddyPatch, tagline } from '../src/core/buddies.js';

/**
 * @param {{ buddies: () => object[], project: () => boolean, onResult: (result: { agents? }) => void }} options
 */
export function createAgentsPanel({ buddies, project, onResult }) {
  const dialog = document.querySelector('.od-agents-dialog');
  const list = dialog.querySelector('.od-agents-list');
  const form = dialog.querySelector('.od-agent-editor');
  const headAvatar = form.querySelector('.od-agent-head-avatar');
  const nameInput = form.querySelector('[data-agent="name"]');
  const nameError = form.querySelector('.od-input-error');
  const createButton = form.querySelector('[data-action="create-agent"]');
  const where = form.querySelector('.od-agent-where');
  const newButton = dialog.querySelector('[data-action="new-agent"]');
  let selected = null; // the name of the buddy shown
  let draft = null; // a new buddy not created yet: { buddy }
  let creating = false;

  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const current = () => draft?.buddy ?? buddies().find((b) => same(b.name, selected ?? '')) ?? null;
  const valid = (patch) => {
    try {
      checkBuddyPatch(patch);
      return true;
    } catch {
      return false;
    }
  };
  // What creating the draft sends, or null while its name is not valid.
  const draftFields = () => {
    const name = draft.buddy.name.trim();
    return BUDDY_RULES.name(name) ? { ...draft.buddy, name } : null;
  };

  async function save(patch) {
    const buddy = current();
    if (!buddy || !valid(patch)) return false;
    if (draft) {
      // Kept in the draft, and sent with the rest by Create.
      draft.buddy = { ...draft.buddy, ...patch };
      paint();
      return true;
    }
    try {
      onResult(await api.updateBuddy(buddy.name, patch));
      if (patch.name) selected = patch.name;
      return true;
    } catch (error) {
      if (Object.hasOwn(patch, 'name')) {
        nameError.textContent = error.message;
        nameError.hidden = false;
      }
      paint();
      return false;
    }
  }

  function paint() {
    const all = buddies();
    if (selected && !all.some((b) => same(b.name, selected))) selected = null;
    selected ??= all[0]?.name ?? null;
    list.replaceChildren(...(draft ? [draftRow()] : []), ...all.map((buddy) => listRow(buddy)));

    const buddy = current();
    form.hidden = !buddy;
    if (!buddy) return;
    form.toggleAttribute('data-draft', Boolean(draft));
    form.toggleAttribute('data-fixed', buddy.where === 'app');
    headAvatar.replaceChildren(avatar(buddy.name || '?', 'agent'));
    createButton.disabled = creating || !draft || !draftFields();
    for (const input of form.querySelectorAll('input[data-agent], textarea[data-agent]')) {
      input.readOnly = buddy.where === 'app' && input === nameInput;
      if (document.activeElement === input) continue;
      input.value = buddy[input.dataset.agent] ?? '';
      input.removeAttribute('aria-invalid');
    }
    where.hidden = Boolean(draft);
    where.textContent = buddy.where === 'project' ? `This project's: .opendoc/buddies/${buddy.name}.md` : 'In all your docs: buddies/Clippy.md in your config folder. Clear it for Clippy as it ships.';
    newButton.hidden = !project();
  }

  // The draft, first in the list and picked, under the name typed so far.
  function draftRow() {
    const row = el('div', 'od-agents-row');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'true');
    const face = el('span', 'od-profile-face');
    face.append(avatar(draft.buddy.name || '?', 'agent', true));
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', draft.buddy.name.trim() || 'New buddy'), el('span', 'od-agents-sub', 'Not created yet'));
    row.append(face, who);
    return row;
  }

  function listRow(buddy) {
    const row = el('button', 'od-agents-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!draft && same(buddy.name, selected ?? '')));
    row.dataset.buddy = buddy.name;
    const face = el('span', 'od-profile-face');
    face.append(avatar(buddy.name, 'agent', true));
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', buddy.name), el('span', 'od-agents-sub', tagline(buddy)));
    row.append(face, who);
    return row;
  }

  function show(name) {
    draft = null; // another buddy, or the panel opened again: a draft goes
    if (name) selected = name;
    nameError.hidden = true;
    paint();
  }

  dialog.addEventListener('click', async (event) => {
    if (event.target === dialog) return dialog.close(); // backdrop
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.buddy) show(button.dataset.buddy);
    else if (button.dataset.action === 'close') dialog.close();
    else if (button.dataset.action === 'new-agent') newAgent();
    else if (button.dataset.action === 'create-agent') create();
    else if (button.dataset.action === 'discard-draft') show();
    else if (button.dataset.action === 'delete-agent') {
      const buddy = current();
      if (!buddy || !window.confirm(`Delete ${buddy.name}?\n\nIts file is deleted and it stops answering. Its comments stay.`)) return;
      try {
        onResult(await api.deleteBuddy(buddy.name));
      } catch {
        // already gone
      }
    }
  });

  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('keydown', (event) => {
    // Enter in a one-line field saves it, as leaving it does; in a draft's
    // name, it creates the buddy.
    if (event.key === 'Enter' && event.target.matches('input[type="text"]')) {
      event.preventDefault();
      if (draft && event.target === nameInput) create();
      else event.target.blur();
    }
  });
  form.addEventListener('change', (event) => {
    const input = event.target;
    const key = input.dataset.agent;
    if (!key || (draft && key === 'name')) return; // a draft's name is taken as it is typed
    const value = key === 'about' ? input.value : input.value.trim();
    if (key === 'name' && value === '') return paint();
    if (!valid({ [key]: value })) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    input.removeAttribute('aria-invalid');
    nameError.hidden = true;
    save({ [key]: value });
  });
  form.addEventListener('input', (event) => {
    if (draft && event.target === nameInput) {
      draft.buddy = { ...draft.buddy, name: nameInput.value };
      const bad = nameInput.value.trim() !== '' && !draftFields();
      nameInput.toggleAttribute('aria-invalid', bad);
      nameError.textContent = bad ? NAME_RULE : '';
      nameError.hidden = !bad;
      paint();
    }
  });
  form.addEventListener('focusout', (event) => {
    if (event.target.matches?.('[aria-invalid="true"]')) paint(); // an invalid value is not kept
  });

  // New buddy: a draft in the editor, its name to type first. Nothing is
  // saved until Create.
  function newAgent() {
    if (!project()) return;
    if (!dialog.open) dialog.showModal();
    show();
    draft = { buddy: { name: '', about: '' } };
    paint();
    nameInput.focus();
  }

  // One request: the buddy with everything set in the draft.
  async function create() {
    const fields = draft && draftFields();
    if (!fields || creating) return;
    creating = true;
    paint();
    try {
      onResult(await api.createBuddy(fields));
      draft = null;
      show(fields.name);
    } catch (error) {
      // Its name is taken: the draft stays.
      nameError.textContent = error.message;
      nameError.hidden = false;
      nameInput.focus();
    } finally {
      creating = false;
      paint();
    }
  }

  function open(name) {
    if (!dialog.open) dialog.showModal();
    show(name);
    list.querySelector('[aria-selected="true"]')?.focus();
  }

  // Closed, by Esc, the close button or the backdrop: a draft goes with it.
  dialog.addEventListener('close', () => {
    draft = null;
  });

  paint();
  return {
    /** Open the panel on buddy `name` (or the one shown last). */
    open,
    /** Open the panel on a new buddy's draft. */
    newAgent,
    /** The buddies changed: show them. */
    refresh: paint,
    /** Open the panel, or close it when it is open. */
    toggle() {
      if (dialog.open) dialog.close();
      else open();
    },
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
