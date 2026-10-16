// The Agents panel: the user's agents, for every doc, in a dialog of their
// own. On the left, the list (those with Auto Commenter first, a green dot
// on each, and what each runs on); on the right, the one picked, top to
// bottom in the order people change things: who it is (name, persona), what
// it runs on (whether that program works, and its model or command), what it
// can do (the permission switches, the same as on its card), its
// instructions, and, folded away, effort and limits. A problem shows above
// the rest only when there is one.
// "Programs" at the foot of the list holds where Claude Code and Codex are,
// and whether each works: found, runs, signed in. It is checked when the
// panel first needs it or a path changes, and again only when the user
// clicks Check, there or under Runs on.
//
// Changes save through the server as they are made. A new agent is a draft
// until Create: nothing is saved or invited before it has a name, so one
// left half made (the panel closed, Esc, another agent picked) leaves no
// trace. An agent's program (a custom command, or where Claude Code is) is
// set through the desktop app, which asks the user to confirm it; in a
// browser tab those fields are read-only, and a Command agent shows what to
// put in settings.json instead.

import { api } from './api.js';
import { avatar } from './threads.js';
import { NAME_RULE, confirmAccess } from './agent.js';
import { agentFace } from './faces.js';
import { PERMISSIONS, RUNTIME_LABELS, availableIn, checkAgentPatch, commandSnippet, createFields, draftAgent, introOf, modelChoices, modelWarning, permissionPatch, permissionsOf, runtimePatch } from '../src/core/agents.js';

const PROBLEMS = {
  error: 'Its last run failed',
  unavailable: 'It cannot start',
  limited: 'It reached its runs per hour',
};

/**
 * @param {{ store: object, onResult: (result: { settings?, sidecar?, agents? }) => void }} options
 */
/**
 * `folder()` names the folder the doc was opened from (whose files every
 * agent may read), or is null. `settingsFile()` is the path of settings.json.
 */
export function createAgentsPanel({ store, onResult, docKey = () => null, folder = () => null, settingsFile = () => null }) {
  const dialog = document.querySelector('.od-agents-dialog');
  const desktop = window.opendocDesktop;
  const list = dialog.querySelector('.od-agents-list');
  const programsButton = dialog.querySelector('[data-action="programs"]');
  const programsPage = dialog.querySelector('.od-agents-programs-page');
  const form = dialog.querySelector('.od-agent-editor');
  const headAvatar = form.querySelector('.od-agent-head-avatar');
  const nameInput = form.querySelector('[data-agent="name"]');
  const nameError = form.querySelector('.od-input-error');
  const createButton = form.querySelector('[data-action="create-agent"]');
  const commandInput = form.querySelector('[data-agent-program="command"]');
  const commandNote = form.querySelector('.od-program-note');
  const problem = form.querySelector('.od-agent-problem');
  const problemText = form.querySelector('.od-agent-problem-text');
  const check = form.querySelector('[data-action="agent-check"]');
  const where = form.querySelector('.od-agent-where');
  const perms = form.querySelector('.od-agent-perms');
  const risk = form.querySelector('.od-agent-risk');
  const reads = form.querySelector('.od-agent-reads');
  const hooks = form.querySelector('.od-agent-hooks');
  const runtimeLine = form.querySelector('.od-agent-program');
  const runtimeNote = form.querySelector('.od-runtime-note');
  const model = form.querySelector('[data-agent="model"]');
  const models = form.querySelector('#od-agent-models');
  const modelWarn = form.querySelector('.od-model-warning');
  perms.replaceChildren(...PERMISSIONS.map(permissionRow));
  let statuses = [];
  let programStatus = {}; // what the server found for each program: { claude, codex }
  let checkedFor = null; // the paths that check was for
  const checking = new Set(); // programs being checked
  let selected = null; // the id of the agent shown
  let programs = false; // the Programs page is shown instead
  let note = null; // { id, text }: what the last switch of runtime changed, for that agent
  let draft = null; // a new agent not created yet: { agent, invite }, `invite` to bring it into this doc
  let creating = false;

  form.querySelector('.od-program-note').hidden = Boolean(desktop);
  for (const button of dialog.querySelectorAll('[data-action="choose-program"]')) button.hidden = !desktop;
  for (const input of dialog.querySelectorAll('[data-agent-program], [data-program]')) input.readOnly = !desktop;
  programsPage.querySelector('.od-programs-note').hidden = Boolean(desktop);

  // Your starred agents, and this doc's own; other docs' own stay with them.
  const agents = () => store.get().agents.filter((a) => availableIn(a, docKey()));
  const current = () => draft?.agent ?? agents().find((a) => a.id === selected) ?? null;
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
    const roster = [...agents()].sort((a, b) => Number(b.autoComment) - Number(a.autoComment));
    if (selected && !roster.some((a) => a.id === selected)) selected = null;
    if (!programs) selected ??= roster[0]?.id ?? null;
    list.replaceChildren(...(draft ? [draftRow()] : []), ...roster.map((agent) => listRow(agent)));
    if (roster.length === 0 && !draft) list.append(el('p', 'od-agents-empty', 'No agents yet. Make one with +.'));
    programsButton.setAttribute('aria-pressed', String(programs));
    programsPage.hidden = !programs;
    for (const bin of dialog.querySelectorAll('[data-program]')) {
      if (document.activeElement !== bin) bin.value = store.get()[bin.dataset.program] ?? '';
    }
    const agent = programs ? null : current();
    if (programs || (agent && agent.runtime !== 'custom')) loadProgramsOnce();
    if (programs) paintPrograms();

    form.hidden = !agent;
    if (!agent) return;
    form.dataset.kind = agent.runtime;
    form.toggleAttribute('data-draft', Boolean(draft));
    headAvatar.replaceChildren(draft ? draftFace() : avatar(agent.name, 'agent'));
    createButton.disabled = creating || !draft || !createFields(draft.agent);
    for (const button of form.querySelectorAll('[data-agent-runtime]')) {
      const kind = button.dataset.agentRuntime;
      button.setAttribute('aria-checked', String(kind === agent.runtime));
      // A program that does not work is marked on its option, before it is picked.
      const broken = programStatus[kind] && !programStatus[kind].ok;
      const flag = button.querySelector('.od-runtime-flag');
      if (flag) flag.hidden = !broken;
      button.title = broken ? `${programStatus[kind].label}: ${programStatus[kind].error}` : '';
    }
    if (agent.runtime !== 'custom') paintProgramLine(runtimeLine, agent.runtime, true);
    runtimeNote.textContent = note?.id === agent.id ? note.text : '';
    runtimeNote.hidden = !runtimeNote.textContent;
    const { suggestions, placeholder } = modelChoices(agent.runtime, programStatus[agent.runtime]?.defaultModel ?? null);
    model.placeholder = placeholder;
    if (models.dataset.names !== suggestions.join(' ')) {
      models.dataset.names = suggestions.join(' '); // replaced only when it changes, not under an open list
      models.replaceChildren(...suggestions.map((name) => Object.assign(document.createElement('option'), { value: name })));
    }
    paintModelWarning(agent.runtime, document.activeElement === model ? model.value.trim() : agent.model);
    for (const button of form.querySelectorAll('[data-agent-effort]')) {
      button.setAttribute('aria-checked', String(button.dataset.agentEffort === agent.effort));
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
    reads.textContent = folder()
      ? `Every agent reads the doc it works on, and the other files in ${folder()}. It edits only the doc.`
      : 'Every agent reads the doc it works on.';
    risk.textContent = riskOf(agent, Boolean(folder()));
    risk.hidden = !risk.textContent;
    for (const input of form.querySelectorAll('input[data-agent]:not([type="checkbox"]), textarea[data-agent], input[data-agent-program]')) {
      if (document.activeElement === input) continue;
      const key = input.dataset.agent ?? input.dataset.agentProgram;
      input.value = agent[key] ?? '';
      input.removeAttribute('aria-invalid');
    }
    form.querySelector('[data-agent="isolated"]').checked = agent.isolated;
    form.querySelector('[data-agent="starred"]').checked = agent.starred;
    if (!desktop) paintCommandNote(agent);
    paintStatus();
  }

  // The draft, first in the list and picked, under the name typed so far.
  function draftRow() {
    const row = el('div', 'od-agents-row');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'true');
    const face = el('span', 'od-profile-face');
    face.append(draftFace(true));
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', draft.agent.name.trim() || 'New agent'), el('span', 'od-agents-sub', 'Not created yet'));
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

  // In a browser tab the page cannot set a command (the desktop app asks
  // first), so it says where to set it by hand and what to write there.
  function paintCommandNote(agent) {
    commandNote.querySelector('.od-program-note-draft').hidden = !draft;
    commandNote.querySelector('.od-program-note-saved').hidden = Boolean(draft);
    if (draft) return;
    commandNote.querySelector('.od-settings-file').textContent = settingsFile() ?? 'settings.json';
    commandNote.querySelector('.od-agent-id').textContent = `"id": "${agent.id}"`;
    commandNote.querySelector('.od-command-snippet').textContent = commandSnippet(agent.command);
  }

  function listRow(agent) {
    const row = el('button', 'od-agents-row');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(!programs && !draft && agent.id === selected));
    row.dataset.agentId = agent.id;
    const face = el('span', 'od-profile-face');
    face.dataset.presence = agent.autoComment ? 'autocomment' : 'idle';
    face.append(avatar(agent.name, 'agent', true));
    if (agent.autoComment) face.title = 'Auto Commenter';
    const who = el('span', 'od-agents-who');
    who.append(el('span', 'od-agents-name', agent.name), el('span', 'od-agents-sub', introOf(agent)));
    row.append(face, who, el('span', 'od-agents-runtime', RUNTIME_LABELS[agent.runtime] ?? ''));
    if (PROBLEMS[statusOf(agent)?.state]) row.append(el('span', 'od-agents-flag', '!'));
    return row;
  }

  // Where the agent answers, and what is wrong when something is.
  function paintStatus() {
    const agent = current();
    if (!agent) return;
    if (draft) {
      problem.hidden = hooks.hidden = true;
      where.textContent = draft.invite ? 'Joins this doc when you create it.' : 'Not in this doc.';
      return;
    }
    const status = statusOf(agent);
    const trouble = status && PROBLEMS[status.state];
    problem.hidden = !trouble;
    if (trouble) {
      const error = status.error?.replace(/\u001b\[[0-9;]*m/g, '').split('\n').find((l) => l.trim());
      problemText.textContent = error ? `${trouble}: ${error}` : `${trouble}.`;
      check.hidden = status.state === 'limited';
    }
    where.textContent = status ? 'In this doc.' : 'Not in this doc.';
    hooks.textContent = status?.warning ? `Note: ${status.warning}.` : '';
    hooks.hidden = !status?.warning;
  }

  // Each program's line: what runs and that it is signed in, or what is
  // wrong and how to fix it. An empty path shows what it finds.
  function paintPrograms() {
    for (const line of programsPage.querySelectorAll('.od-program-status')) {
      const kind = line.dataset.programKind;
      const status = programStatus[kind];
      const bin = programsPage.querySelector(`[data-program="${kind}Bin"]`);
      bin.placeholder = status ? (status.found ?? 'Not found automatically') : 'Found automatically';
      bin.title = bin.value || (status?.found ?? ''); // a long path does not fit
      paintProgramLine(line, kind);
    }
  }

  // One program's status line, on the Programs page or under Runs on, where
  // `named` says which program it is (the page shows that above the line).
  function paintProgramLine(line, kind, named = false) {
    const status = programStatus[kind];
    const busy = checking.has(kind) || !status;
    line.dataset.state = busy ? 'checking' : status.ok ? 'ok' : 'error';
    const recheck = line.querySelector('[data-action="check-program"]');
    recheck.dataset.programKind = kind;
    recheck.disabled = busy;
    // A missing or wrong path is fixed on the Programs page; a sign-in, in a terminal.
    const fix = line.querySelector('[data-action="open-programs"]');
    if (fix) fix.hidden = busy || status.ok || status.error === 'Not signed in';
    const text = line.querySelector('.od-program-status-text');
    if (busy) text.replaceChildren('Checking…');
    else if (status.ok) {
      const how = status.apiKey ? 'uses CODEX_API_KEY' : 'signed in';
      text.replaceChildren(el('span', 'od-program-mark', '✓ '), `${status.label}${status.version ? ` ${status.version}` : ''} · ${how}`);
    } else if (named && status.error === 'Not signed in') {
      text.replaceChildren(el('span', 'od-program-mark', '✗ '), `${status.label} isn't signed in: ${status.fix}`);
    } else text.replaceChildren(el('span', 'od-program-mark', '✗ '), `${named ? `${status.label}: ` : ''}${status.error}: ${status.fix}`);
    text.title = status?.path ?? '';
  }

  // Ask the server once per set of paths: it keeps each check, so a program
  // runs only the first time, or after its path changed. Only while the panel
  // is open, never in the background.
  function loadProgramsOnce() {
    const paths = JSON.stringify([store.get().claudeBin, store.get().codexBin]);
    if (!dialog.open || paths === checkedFor) return;
    checkedFor = paths;
    programStatus = {}; // a new path's check takes a few seconds: say so meanwhile
    loadPrograms();
  }

  function paintModelWarning(runtime, value) {
    modelWarn.textContent = modelWarning(runtime, value);
    modelWarn.hidden = !modelWarn.textContent;
  }

  let loads = 0;
  async function loadPrograms() {
    const load = ++loads;
    let next = {};
    try {
      next = await api.programs();
    } catch {
      // the server is gone; nothing to show
    }
    if (load !== loads) return; // the paths changed again meanwhile
    programStatus = next;
    paint();
  }

  async function checkProgram(kind) {
    checking.add(kind);
    paint();
    try {
      const result = await api.checkProgram(kind);
      programStatus = result.programs;
      onResult({ agents: result.agents });
    } catch {
      // the server is gone; the line keeps what it last knew
    } finally {
      checking.delete(kind);
      paint();
    }
  }

  function show(id) {
    draft = null; // another agent, or the panel opened again: a draft goes
    programs = false;
    if (id && id !== selected) note = null;
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
    else if (button.dataset.action === 'programs' || button.dataset.action === 'open-programs') {
      draft = null;
      programs = true;
      paint();
    } else if (button.dataset.agentRuntime) setRuntime(button.dataset.agentRuntime);
    else if (button.dataset.agentEffort) save({ effort: button.dataset.agentEffort });
    else if (button.dataset.action === 'choose-program') desktop?.chooseProgram(button.dataset.programKey).catch(() => {});
    else if (button.dataset.action === 'check-program') checkProgram(button.dataset.programKind);
    else if (button.dataset.action === 'new-agent') newAgent();
    else if (button.dataset.action === 'create-agent') create();
    else if (button.dataset.action === 'discard-draft') show();
    else if (button.dataset.action === 'copy-command') copyCommand(button);
    else if (button.dataset.action === 'delete-agent') {
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
    // Enter in a one-line field saves it, as leaving it does; in a draft's
    // name, it creates the agent.
    if (event.key === 'Enter' && event.target.matches('input[type="text"], input[type="number"]')) {
      event.preventDefault();
      if (draft && event.target === nameInput) create();
      else event.target.blur();
    }
  });
  form.addEventListener('change', (event) => {
    const input = event.target;
    if (input.dataset.permission) {
      const agent = current();
      if (!agent) return;
      if (input.checked && !confirmAccess({ ...agent, name: agent.name.trim() || 'this agent' }, input.dataset.permission)) {
        input.checked = false;
        return;
      }
      return save(permissionPatch(agent, input.dataset.permission, input.checked));
    }
    if (input.dataset.agentProgram) {
      // A draft's command waits for Create: the desktop app sets it then.
      if (!draft) return setProgram(input, 'command', current()?.id);
      draft.agent = { ...draft.agent, command: input.value.trim() || null };
      return;
    }
    const key = input.dataset.agent;
    if (!key || (draft && key === 'name')) return; // a draft's name is taken as it is typed
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
    if (key === 'model') note = null; // the reset it told of is past
    save({ [key]: value });
  });
  // A model warns as it is typed; it saves when the field is left.
  form.addEventListener('input', (event) => {
    if (event.target === model) paintModelWarning(current()?.runtime, model.value.trim());
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
  for (const bin of dialog.querySelectorAll('[data-program]')) bin.addEventListener('change', (event) => setProgram(event.target, bin.dataset.program));

  // Another runtime starts on its own default model, saved with the runtime
  // in one change; a line under Runs on says what model it had.
  async function setRuntime(runtime) {
    const agent = current();
    if (!agent || agent.runtime === runtime) return;
    const { patch, note: text } = runtimePatch(agent, runtime);
    if (!(await save(patch))) return;
    note = text ? { id: agent.id, text } : null;
    paint();
  }

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

  // New agent: a draft in the editor, its name to type first. Nothing is
  // saved until Create.
  function newAgent({ invite = false } = {}) {
    if (!dialog.open) dialog.showModal();
    show();
    draft = { agent: draftAgent({ face: Math.random().toString(36).slice(2, 10) }), invite };
    note = null;
    paint();
    nameInput.focus();
  }

  // One request: the agent with everything set in the draft, brought into
  // this doc when it came from there. Its command, if one was typed, goes
  // to the desktop app after, which asks first.
  async function create() {
    const fields = draft && createFields(draft.agent);
    if (!fields || creating) return;
    const { invite, agent: { command } } = draft;
    creating = true;
    paint();
    try {
      const result = await api.createAgent(fields, { invite });
      draft = null;
      onResult(result);
      show(result.agent.id);
      if (command && desktop) {
        commandInput.value = command;
        setProgram(commandInput, 'command', result.agent.id);
      }
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

  async function copyCommand(button) {
    const snippet = commandNote.querySelector('.od-command-snippet');
    try {
      await navigator.clipboard.writeText(snippet.textContent);
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    } catch {
      // No clipboard here: select it, for Ctrl+C.
      getSelection().selectAllChildren(snippet);
    }
  }

  function showStatus(next) {
    statuses = next ?? [];
    paint();
  }

  function open(id) {
    if (!dialog.open) dialog.showModal(); // first: programs are checked only while it is open
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
    showStatus,
    /** Open the panel on agent `id` (or the one shown last). */
    open,
    /** Open the panel on a new agent's draft; with `invite`, Create brings it into this doc. */
    newAgent,
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
// `inFolder`: it may also read the files of the folder the doc was opened from.
function riskOf(agent, inFolder = false) {
  if (agent.webAccess && agent.fileAccess) return 'With Web Searcher and File Searcher both on, a web page could trick it into sending your files to a website.';
  if (agent.webAccess && inFolder) return "A web page can hide instructions that trick it into sending this doc, or the folder's files, to a website.";
  if (agent.webAccess) return 'A web page can hide instructions that trick it into sending this doc to a website.';
  if (agent.fileAccess || inFolder) return 'A file can hide instructions it then follows.';
  return '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
