// The Agents panel: the user's agents, for every doc, in a dialog of their
// own. On the left, the list (those with Auto Commenter first, a green dot
// on each); on the right, the one picked, top to bottom in the order people
// change things: who it is (name, persona), what it can do (the
// permission switches, the same as on its card), its instructions, and, folded
// away, how it runs. A problem shows above the rest only when there is one.
// "Programs" at the foot of the list holds where Claude Code and Codex are.
//
// Changes save through the server as they are made. An agent's program (a
// custom command, or where Claude Code is) is set through the desktop app,
// which asks the user to confirm it; in a browser tab those fields are
// read-only.

import { api } from './api.js';
import { avatar } from './threads.js';
import { confirmAccess } from './agent.js';
import { PERMISSIONS, availableIn, checkAgentPatch, introOf, permissionPatch, permissionsOf } from '../src/core/agents.js';

const PROBLEMS = {
  error: 'Its last run failed',
  unavailable: 'It cannot start',
  limited: 'It reached its runs per hour',
};

/**
 * @param {{ store: object, onResult: (result: { settings?, sidecar?, agents? }) => void }} options
 */
export function createAgentsPanel({ store, onResult, docKey = () => null }) {
  const dialog = document.querySelector('.od-agents-dialog');
  const desktop = window.opendocDesktop;
  const list = dialog.querySelector('.od-agents-list');
  const programsButton = dialog.querySelector('[data-action="programs"]');
  const programsPage = dialog.querySelector('.od-agents-programs-page');
  const form = dialog.querySelector('.od-agent-editor');
  const headAvatar = form.querySelector('.od-agent-head-avatar');
  const nameError = form.querySelector('.od-input-error');
  const problem = form.querySelector('.od-agent-problem');
  const problemText = form.querySelector('.od-agent-problem-text');
  const check = form.querySelector('[data-action="agent-check"]');
  const where = form.querySelector('.od-agent-where');
  const perms = form.querySelector('.od-agent-perms');
  const risk = form.querySelector('.od-agent-risk');
  const hooks = form.querySelector('.od-agent-hooks');
  perms.replaceChildren(...PERMISSIONS.map(permissionRow));
  let statuses = [];
  let selected = null; // the id of the agent shown
  let programs = false; // the Programs page is shown instead

  form.querySelector('.od-program-note').hidden = Boolean(desktop);
  for (const button of dialog.querySelectorAll('[data-action="choose-program"]')) button.hidden = !desktop;
  for (const input of dialog.querySelectorAll('[data-agent-program], [data-program]')) input.readOnly = !desktop;

  // Your starred agents, and this doc's own; other docs' own stay with them.
  const agents = () => store.get().agents.filter((a) => availableIn(a, docKey()));
  const current = () => agents().find((a) => a.id === selected) ?? null;
  const statusOf = (agent) => statuses.find((s) => (s.id ? s.id === agent.id : s.name.toLowerCase() === agent.name.toLowerCase())) ?? null;
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
    const roster = [...agents()].sort((a, b) => Number(b.autoComment) - Number(a.autoComment));
    if (selected && !roster.some((a) => a.id === selected)) selected = null;
    if (!programs) selected ??= roster[0]?.id ?? null;
    list.replaceChildren(...roster.map((agent) => listRow(agent)));
    if (roster.length === 0) list.append(el('p', 'od-agents-empty', 'No agents yet. Make one with +.'));
    programsButton.setAttribute('aria-pressed', String(programs));
    programsPage.hidden = !programs;
    for (const bin of dialog.querySelectorAll('[data-program]')) {
      if (document.activeElement !== bin) bin.value = store.get()[bin.dataset.program] ?? '';
    }

    const agent = programs ? null : current();
    form.hidden = !agent;
    if (!agent) return;
    form.dataset.kind = agent.runtime;
    headAvatar.replaceChildren(avatar(agent.name, 'agent'));
    for (const button of form.querySelectorAll('[data-agent-runtime]')) {
      button.setAttribute('aria-checked', String(button.dataset.agentRuntime === agent.runtime));
    }
    const has = permissionsOf(agent);
    for (const box of perms.querySelectorAll('input[data-permission]')) {
      const key = box.dataset.permission;
      // Codex reads the whole disk, so it cannot be kept to the doc: no File Searcher.
      const unsupported = key === 'files' && agent.runtime === 'codex';
      box.checked = has[key] && !unsupported;
      box.disabled = unsupported;
      box.closest('.od-perm-row').title = unsupported ? 'Codex agents cannot be kept to your files' : '';
    }
    risk.textContent = riskOf(agent);
    risk.hidden = !risk.textContent;
    for (const input of form.querySelectorAll('input[data-agent]:not([type="checkbox"]), textarea[data-agent], input[data-agent-program]')) {
      if (document.activeElement === input) continue;
      const key = input.dataset.agent ?? input.dataset.agentProgram;
      input.value = agent[key] ?? '';
      input.removeAttribute('aria-invalid');
    }
    form.querySelector('[data-agent="isolated"]').checked = agent.isolated;
    form.querySelector('[data-agent="starred"]').checked = agent.starred;
    paintStatus();
  }

  function listRow(agent) {
    const row = el('button', 'od-agents-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!programs && agent.id === selected));
    row.dataset.agentId = agent.id;
    const face = el('span', 'od-profile-face');
    face.dataset.presence = agent.autoComment ? 'autocomment' : 'idle';
    face.append(avatar(agent.name, 'agent', true));
    if (agent.autoComment) face.title = 'Auto Commenter';
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', agent.name), el('span', 'od-agents-sub', introOf(agent)));
    row.append(face, who);
    if (PROBLEMS[statusOf(agent)?.state]) row.append(el('span', 'od-agents-flag', '!'));
    return row;
  }

  // Where the agent answers, and what is wrong when something is.
  function paintStatus() {
    const agent = current();
    if (!agent) return;
    const status = statusOf(agent);
    const trouble = status && PROBLEMS[status.state];
    problem.hidden = !trouble;
    if (trouble) {
      const error = status.error?.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim());
      problemText.textContent = error ? `${trouble}: ${error}` : `${trouble}.`;
      check.hidden = status.state === 'limited';
    }
    where.textContent = agent.autoComment
      ? status ? 'In this doc, answering new comments that fit its persona.' : `Not in this doc. @${agent.name} in a comment brings it in.`
      : status ? `In this doc. Answers when you @${agent.name}.` : `Not in this doc. @${agent.name} in a comment brings it in.`;
    hooks.textContent = status?.warning ? `Note: ${status.warning}.` : '';
    hooks.hidden = !status?.warning;
  }

  function show(id) {
    programs = false;
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
    else if (button.dataset.action === 'programs') {
      programs = true;
      paint();
    } else if (button.dataset.agentRuntime) save({ runtime: button.dataset.agentRuntime });
    else if (button.dataset.action === 'choose-program') desktop?.chooseProgram(button.dataset.programKey).catch(() => {});
    else if (button.dataset.action === 'new-agent') {
      try {
        const result = await api.createAgent({ name: 'agent' });
        onResult(result);
        show(result.agent.id);
        const name = form.querySelector('[data-agent="name"]');
        name.focus();
        name.select();
      } catch {
        // at most MAX_AGENTS; the list shows what there is
      }
    } else if (button.dataset.action === 'delete-agent') {
      const agent = current();
      if (!agent || !window.confirm(`Delete ${agent.name}?\n\nIt leaves this doc and stops answering in every doc. Its comments stay.`)) return;
      try {
        onResult(await api.deleteAgent(agent.id));
      } catch {
        // already gone
      }
    } else if (button.dataset.action === 'agent-check') {
      const status = current() && statusOf(current());
      if (!status) return;
      check.disabled = true;
      try {
        const next = await api.agentAction(status.name, 'retry');
        showStatus(statuses.map((s) => (s === status ? next : s)));
      } catch {
        // it left the doc meanwhile
      } finally {
        check.disabled = false;
      }
    }
  });

  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('keydown', (event) => {
    // Enter in a one-line field saves it, as leaving it does.
    if (event.key === 'Enter' && event.target.matches('input[type="text"], input[type="number"]')) {
      event.preventDefault();
      event.target.blur();
    }
  });
  form.addEventListener('change', (event) => {
    const input = event.target;
    if (input.dataset.permission) {
      const agent = current();
      if (!agent) return;
      if (input.checked && !confirmAccess(agent, input.dataset.permission)) {
        input.checked = false;
        return;
      }
      return save(permissionPatch(agent, input.dataset.permission, input.checked));
    }
    if (input.dataset.agentProgram) return setProgram(input, 'command', current()?.id);
    const key = input.dataset.agent;
    if (!key) return;
    if (input.type === 'checkbox') return save({ [key]: input.checked });
    const raw = key === 'instructions' ? input.value : input.value.trim();
    if (key === 'name' && raw === '') return paint();
    let value = raw;
    if (input.type === 'number') value = raw === '' ? null : Number(raw);
    else if (key === 'model') value = raw || null;
    if (!valid({ [key]: value })) {
      input.setAttribute('aria-invalid', 'true');
      return;
    }
    input.removeAttribute('aria-invalid');
    nameError.hidden = true;
    save({ [key]: value });
  });
  form.addEventListener('focusout', (event) => {
    if (event.target.matches?.('[aria-invalid="true"]')) paint(); // an invalid value is not kept
  });
  for (const bin of dialog.querySelectorAll('[data-program]')) bin.addEventListener('change', (event) => setProgram(event.target, bin.dataset.program));

  async function setProgram(input, key, id = null) {
    const before = () => (key === 'command' ? current()?.command : store.get()[key]) ?? '';
    if (!desktop) return;
    try {
      const done = await desktop.setAgentProgram(key, input.value.trim() || null, id);
      if (!done) input.value = before();
    } catch {
      input.value = before();
    }
  }

  function showStatus(next) {
    statuses = next ?? [];
    paint();
  }

  function open(id) {
    show(id);
    if (!dialog.open) dialog.showModal();
    list.querySelector('[aria-selected="true"]')?.focus();
  }

  store.subscribe(paint);
  paint();
  return {
    showStatus,
    /** Open the panel on agent `id` (or the one shown last). */
    open,
    /** Open the panel, or close it when it is open. */
    toggle() {
      if (dialog.open) dialog.close();
      else open();
    },
  };
}

// One permission: its name and what it allows, and a switch.
function permissionRow({ key, label, hint }) {
  const row = el('label', 'od-perm-row');
  const text = el('span', 'od-perm-text');
  text.append(el('span', 'od-perm-label', label), el('span', 'od-perm-hint', hint));
  const box = el('input');
  box.type = 'checkbox';
  box.className = 'od-switch';
  box.dataset.permission = key;
  row.append(text, box);
  return row;
}

// What the agent's reach beyond the doc risks, in a sentence, or ''.
function riskOf(agent) {
  if (agent.webAccess && agent.fileAccess) return 'With Web Searcher and File Searcher both on, a web page could trick it into sending your files to a website.';
  if (agent.webAccess) return 'A web page can hide instructions that trick it into sending this doc to a website.';
  if (agent.fileAccess) return 'A file can hide instructions it then follows.';
  return '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
