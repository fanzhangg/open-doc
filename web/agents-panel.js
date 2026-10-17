// The Agents panel: the user's buddies, for every doc, in a dialog of their
// own. On the left, the list; on the right, the one picked: who it is (name,
// persona), whether it is starred, and its instructions. What runs every
// buddy is the agent picked in Settings.
//
// Changes save through the doc host as they are made. A new agent is a draft
// until Create: nothing is saved before it has a name, so one
// left half made (the panel closed, Esc, another agent picked) leaves no
// trace.

import { api } from './api.js';
import { avatar } from './threads.js';
import { NAME_RULE } from './agent.js';
import { agentFace } from './faces.js';
import { availableIn, checkAgentPatch, createFields, draftAgent, introOf } from '../src/core/agents.js';

/**
 * @param {{ store: object, onResult: (result: { settings?, sidecar?, agents? }) => void, docKey?: () => string | null }} options
 */
export function createAgentsPanel({ store, onResult, docKey = () => null }) {
  const dialog = document.querySelector('.od-agents-dialog');
  const list = dialog.querySelector('.od-agents-list');
  const form = dialog.querySelector('.od-agent-editor');
  const headAvatar = form.querySelector('.od-agent-head-avatar');
  const nameInput = form.querySelector('[data-agent="name"]');
  const nameError = form.querySelector('.od-input-error');
  const createButton = form.querySelector('[data-action="create-agent"]');
  const where = form.querySelector('.od-agent-where');
  let selected = null; // the id of the agent shown
  let draft = null; // a new agent not created yet: { agent }
  let creating = false;

  // Your starred agents, and this doc's own; other docs' own stay with them.
  const agents = () => store.get().agents.filter((a) => availableIn(a, docKey()));
  const current = () => draft?.agent ?? agents().find((a) => a.id === selected) ?? null;
  const valid = (patch) => {
    try {
      checkAgentPatch(patch);
      return true;
    } catch {
      return false;
    }
  };

  async function save(patch) {
    const agent = current();
    if (!agent || !valid(patch)) return false;
    if (draft) {
      // Kept in the draft, and sent with the rest by Create.
      draft.agent = { ...draft.agent, ...patch };
      paint();
      return true;
    }
    try {
      onResult(await api.updateAgent(agent.id, patch));
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
    const roster = agents();
    if (selected && !roster.some((a) => a.id === selected)) selected = null;
    selected ??= roster[0]?.id ?? null;
    list.replaceChildren(...(draft ? [draftRow()] : []), ...roster.map((agent) => listRow(agent)));
    if (roster.length === 0 && !draft) list.append(el('p', 'od-agents-empty', 'No buddies yet. Make one with +.'));

    const agent = current();
    form.hidden = !agent;
    if (!agent) return;
    form.toggleAttribute('data-draft', Boolean(draft));
    headAvatar.replaceChildren(draft ? draftFace() : avatar(agent.name, 'agent'));
    createButton.disabled = creating || !draft || !createFields(draft.agent);
    for (const input of form.querySelectorAll('input[data-agent]:not([type="checkbox"]), textarea[data-agent]')) {
      if (document.activeElement === input) continue;
      input.value = agent[input.dataset.agent] ?? '';
      input.removeAttribute('aria-invalid');
    }
    form.querySelector('[data-agent="starred"]').checked = agent.starred;
    where.textContent = agent.starred ? 'In every doc.' : 'Only in this doc.';
  }

  // The draft, first in the list and picked, under the name typed so far.
  function draftRow() {
    const row = el('div', 'od-agents-row');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'true');
    const face = el('span', 'od-profile-face');
    face.append(draftFace(true));
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', draft.agent.name.trim() || 'New buddy'), el('span', 'od-agents-sub', 'Not created yet'));
    row.append(face, who);
    return row;
  }

  // Its face is drawn from a seed of its own, so it does not change with
  // every letter of the name.
  function draftFace(small = false) {
    const node = el('span', `od-avatar od-avatar-agent${small ? ' od-avatar-small' : ''}`);
    node.append(agentFace(draft.agent.face));
    return node;
  }

  function listRow(agent) {
    const row = el('button', 'od-agents-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!draft && agent.id === selected));
    row.dataset.agentId = agent.id;
    const face = el('span', 'od-profile-face');
    face.append(avatar(agent.name, 'agent', true));
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', agent.name), el('span', 'od-agents-sub', introOf(agent)));
    row.append(face, who);
    return row;
  }

  function show(id) {
    draft = null; // another agent, or the panel opened again: a draft goes
    if (id) selected = id;
    nameError.hidden = true;
    paint();
  }

  dialog.addEventListener('click', async (event) => {
    if (event.target === dialog) return dialog.close(); // backdrop
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.agentId) show(button.dataset.agentId);
    else if (button.dataset.action === 'close') dialog.close();
    else if (button.dataset.action === 'new-agent') newAgent();
    else if (button.dataset.action === 'create-agent') create();
    else if (button.dataset.action === 'discard-draft') show();
    else if (button.dataset.action === 'delete-agent') {
      const agent = current();
      if (!agent || !window.confirm(`Delete ${agent.name}?\n\nIt leaves this doc and stops answering in every doc. Its comments stay.`)) return;
      try {
        onResult(await api.deleteAgent(agent.id));
      } catch {
        // already gone
      }
    }
  });

  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('keydown', (event) => {
    // Enter in a one-line field saves it, as leaving it does; in a draft's
    // name, it creates the agent.
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
    if (input.type === 'checkbox') return save({ [key]: input.checked });
    const value = key === 'instructions' ? input.value : input.value.trim();
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
      draft.agent = { ...draft.agent, name: nameInput.value };
      const bad = nameInput.value.trim() !== '' && !createFields(draft.agent);
      nameInput.toggleAttribute('aria-invalid', bad);
      nameError.textContent = bad ? NAME_RULE : '';
      nameError.hidden = !bad;
      paint();
    }
  });
  form.addEventListener('focusout', (event) => {
    if (event.target.matches?.('[aria-invalid="true"]')) paint(); // an invalid value is not kept
  });

  // New agent: a draft in the editor, its name to type first. Nothing is
  // saved until Create.
  function newAgent() {
    if (!dialog.open) dialog.showModal();
    show();
    draft = { agent: draftAgent({ face: Math.random().toString(36).slice(2, 10) }) };
    paint();
    nameInput.focus();
  }

  // One request: the agent with everything set in the draft.
  async function create() {
    const fields = draft && createFields(draft.agent);
    if (!fields || creating) return;
    creating = true;
    paint();
    try {
      const result = await api.createAgent(fields);
      draft = null;
      onResult(result);
      show(result.agent.id);
    } catch (error) {
      // Its name is taken, or there are too many agents: the draft stays.
      nameError.textContent = error.message;
      nameError.hidden = false;
      nameInput.focus();
    } finally {
      creating = false;
      paint();
    }
  }

  function open(id) {
    if (!dialog.open) dialog.showModal();
    show(id);
    list.querySelector('[aria-selected="true"]')?.focus();
  }

  // Closed, by Esc, the close button or the backdrop: a draft goes with it.
  dialog.addEventListener('close', () => {
    draft = null;
  });

  store.subscribe(paint);
  paint();
  return {
    /** Open the panel on agent `id` (or the one shown last). */
    open,
    /** Open the panel on a new agent's draft. */
    newAgent,
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
