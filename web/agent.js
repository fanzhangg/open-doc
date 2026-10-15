// The people in the header, laid out like a shared doc's: avatars of the
// doc's agents, a People button, then yours.
//
// Agents with **Auto Commenter** are in every doc and answer the new comments that
// fit their persona; the others answer only when @mentioned, and mentioning
// one brings it into the doc. The People panel works like Docs' share
// dialog: who is here, what each may do, Remove, and the agents you can bring
// in. Clicking an avatar opens that agent's card: its name, introduction and
// permissions, each a switch you can flip right there.
//
// The comment box asks this module what to offer after @ and who will reply.

import { api } from './api.js';
import { icon } from './icons.js';
import { avatar } from './threads.js';
import { parseMentions } from '../src/core/mentions.js';
import { PERMISSIONS, introOf, permissionPatch, permissionsOf } from '../src/core/agents.js';

const OFFLINE = new Set(['error', 'unavailable', 'limited', 'stopped']);

/**
 * @param {{ root: HTMLElement, invite: HTMLElement, panel: HTMLElement, me: HTMLElement, getName: () => string,
 *           openSettings: (section: string, agentId?: string) => void, onSidecar: (sidecar: object) => void,
 *           onSettings: (settings: object) => void, onError: (message: string) => void }} options
 */
export function createPeople({ root, invite, panel, me, getName, openSettings, onSidecar, onSettings, onError }) {
  let statuses = []; // the agents running here (server)
  let participants = []; // the doc's participants: [{ name, kind }]
  let saved = []; // the user's agents, as the settings have them
  let roster = []; // the same, with the switches flipped on a card and not yet saved
  const flipped = new Map(); // agent id → the fields its card changed, until saved
  let flips = Promise.resolve(); // the changes from cards, saved one at a time
  let unsaved = 0;
  let showing = null; // 'me' | 'people' | 'agent:<name>' | null
  let log = null; // the shown agent's last run log, fetched when its card opens
  let busy = false;

  invite.addEventListener('click', () => toggle('people'));
  me.addEventListener('click', () => toggle('me'));
  root.addEventListener('click', (event) => {
    const face = event.target.closest('[data-agent]');
    if (face) toggle(`agent:${face.dataset.agent}`);
  });
  panel.addEventListener('click', (event) => {
    const row = event.target.closest('[data-open-agent]');
    if (row && !event.target.closest('button')) toggle(`agent:${row.dataset.openAgent}`);
  });
  document.addEventListener('mousedown', (event) => {
    if (showing && ![panel, root, me, invite].some((n) => n.contains(event.target))) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && showing) close();
  });

  async function toggle(which) {
    if (showing === which) return close();
    showing = which;
    log = null;
    paintCard();
    panel.hidden = false;
    const name = agentShown();
    if (name && OFFLINE.has(statusOf(name)?.state)) {
      try {
        log = (await api.agentDetails(name)).log;
      } catch {
        log = '';
      }
      if (agentShown() === name) paintCard();
    }
  }

  function close() {
    showing = null;
    panel.hidden = true;
  }

  const agentShown = () => (showing?.startsWith('agent:') ? showing.slice(6) : null);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const statusOf = (name) => statuses.find((s) => same(s.name, name)) ?? null;
  const profileOf = (name) => roster.find((a) => same(a.name, name)) ?? null;
  // Everything known about an agent: its profile, or else what its status says.
  const infoOf = (name) => profileOf(name) ?? statusOf(name) ?? { name };
  const onAutoComment = (name) => Boolean(statusOf(name)?.autoComment ?? profileOf(name)?.autoComment);

  // The agents of the doc: those with Auto Commenter first, then the others as they joined.
  function agentsHere() {
    const names = participants.filter((p) => p.kind === 'agent').map((p) => p.name);
    for (const s of statuses) if (!names.some((n) => same(n, s.name))) names.push(s.name);
    return names.sort((a, b) => Number(onAutoComment(b)) - Number(onAutoComment(a)));
  }

  // ---- the avatars in the header ----

  function paintFaces() {
    const names = agentsHere();
    root.replaceChildren(...names.map((name) => {
      const status = statusOf(name);
      const mode = modeOf(status);
      const wrap = el('span', 'od-agent');
      wrap.dataset.presence = mode;
      wrap.dataset.state = status?.state ?? 'away';
      const face = el('button', 'od-agent-face');
      face.type = 'button';
      face.dataset.agent = name;
      const label = `${name}${LABELS[mode] ? ` · ${LABELS[mode]}` : ''}`;
      face.title = label;
      face.setAttribute('aria-label', label);
      face.append(avatar(name, 'agent'), el('span', 'od-presence-dot'));
      wrap.append(face);
      return wrap;
    }));
    if (agentShown() && !names.some((n) => same(n, agentShown()))) close();
  }

  // ---- the cards ----

  function paintCard() {
    panel.dataset.card = showing?.split(':')[0] ?? '';
    if (showing === 'me') return panel.replaceChildren(...meCard());
    if (showing === 'people') return panel.replaceChildren(...peopleCard());
    const name = agentShown();
    if (name) panel.replaceChildren(...agentCard(name));
  }

  function meCard() {
    const name = getName();
    const head = el('div', 'od-profile');
    const who = el('div', 'od-profile-who');
    who.append(el('div', 'od-profile-name', name), el('div', 'od-profile-sub', 'You · comments and edits appear under this name'));
    head.append(avatar(name, 'human'), who);
    const actions = el('div', 'od-profile-actions');
    actions.append(button('Change name', 'od-secondary', () => {
      close();
      openSettings('general');
    }));
    return [head, actions];
  }

  // Like a shared doc's people list, one line each: you and the people who
  // commented, the agents here, then the agents you can bring in. What an
  // agent may do is on its card, a click away.
  function peopleCard() {
    const parts = [el('div', 'od-card-title', 'People')];
    const list = el('div', 'od-people-list');
    list.append(personRow(getName(), 'You'));
    for (const p of participants.filter((p) => p.kind === 'human' && !same(p.name, getName()))) list.append(personRow(p.name, 'Commenter'));
    parts.push(list);

    const here = agentsHere();
    parts.push(el('div', 'od-card-subtitle', 'Agents here'));
    if (here.length === 0) parts.push(el('p', 'od-card-hint', 'None yet. @mention one in a comment, or add one below.'));
    for (const name of here) {
      const removable = statusOf(name)?.source !== 'flags' && !onAutoComment(name);
      const removal = removable ? iconButton('close', `Remove ${name} from this doc`, () => remove(name)) : null;
      removal?.classList.add('od-on-hover');
      parts.push(agentRow(name, removal));
    }

    const available = roster.filter((a) => !here.some((n) => same(n, a.name)));
    if (available.length > 0) {
      parts.push(el('div', 'od-card-subtitle', 'Add to this doc'));
      for (const agent of available) parts.push(agentRow(agent.name, iconButton('plus', `Add ${agent.name} to this doc`, () => add(agent.id)), agent));
    }
    const actions = el('div', 'od-profile-actions od-profile-footer');
    actions.append(button('New agent', 'od-link-button', () => createBlank()), button('Manage agents', 'od-link-button', () => {
      close();
      openSettings('agents');
    }));
    parts.push(actions);
    return parts;
  }

  function personRow(name, role) {
    const row = el('div', 'od-people-row');
    row.append(avatar(name, 'human', true), el('span', 'od-people-name', name), el('span', 'od-people-role', role));
    return row;
  }

  // An agent on one line: avatar, name, introduction, and `action`. The row
  // opens its card.
  function agentRow(name, action, info = infoOf(name)) {
    const row = el('div', 'od-people-row od-people-agent');
    row.dataset.openAgent = name;
    row.title = `${name}: open card`;
    const status = statusOf(name);
    const face = el('span', 'od-profile-face');
    face.dataset.presence = modeOf(status);
    face.append(avatar(name, 'agent', true), ...(status ? [el('span', 'od-presence-dot')] : []));
    const intro = profileOf(name) || status ? introOf(info) || 'No introduction yet' : 'Not one of your agents';
    row.append(face, el('span', 'od-people-name', name), el('span', 'od-people-sub', intro));
    if (action) row.append(action);
    return row;
  }

  // An agent's card: who it is, and its permissions as switches. Problems
  // (it cannot run, its last run failed) show only when there is one.
  function agentCard(name) {
    const status = statusOf(name);
    const profile = profileOf(name);
    const info = infoOf(name);
    const parts = [];

    const head = el('div', 'od-profile');
    head.dataset.presence = modeOf(status);
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'agent'), el('span', 'od-presence-dot'));
    const who = el('div', 'od-profile-who');
    who.append(el('div', 'od-profile-name', name));
    if (introOf(info)) who.append(el('div', 'od-profile-slogan', introOf(info)));
    head.append(pic, who);
    if (profile) {
      const edit = iconButton('pencil', 'Edit profile', () => editProfile(profile.id));
      edit.classList.add('od-profile-edit');
      head.append(edit);
    }
    parts.push(head);

    if (info.editMode) parts.push(permissionSwitches(info, profile));

    if (!status && !profile) {
      // In the doc, but not run here: someone else's agent, or one you deleted.
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', `None of your agents is called ${name}, so it does not answer here. It may answer from elsewhere, such as a chat session running opendoc wait.`));
      const actions = el('div', 'od-profile-actions');
      actions.append(button(`Set up ${name}`, 'od-primary', () => setUp(name)));
      problem.append(actions);
      parts.push(problem);
    } else if (status && OFFLINE.has(status.state)) {
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', offlineReason(status)));
      if (status.state !== 'limited') {
        const actions = el('div', 'od-profile-actions');
        actions.append(button('Try again', 'od-primary', () => retry(name)));
        problem.append(actions);
      }
      if (log) {
        const details = el('details', 'od-profile-log');
        details.append(el('summary', '', 'Run log'), el('pre', '', plain(log)));
        problem.append(details);
      }
      parts.push(problem);
    }
    return parts;
  }

  // The permissions as switches. One of your agents' switches change it at
  // once; an agent from `serve` flags shows them read-only.
  function permissionSwitches(info, profile) {
    const has = permissionsOf(info);
    const codex = (info.runtime ?? info.kind) === 'codex';
    const row = el('div', 'od-perms');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Permissions');
    for (const p of PERMISSIONS) {
      const chip = el('button', 'od-perm', p.label);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(has[p.key]));
      // Codex reads the whole disk, so it cannot be kept to the doc: no File Searcher.
      const unsupported = p.key === 'files' && codex;
      chip.disabled = !profile || unsupported;
      chip.title = unsupported ? 'Codex agents cannot be kept to your files' : profile ? p.hint : `${p.hint} Set with opendoc serve flags.`;
      if (!chip.disabled) chip.addEventListener('click', () => flip(profile, p.key, !has[p.key]));
      row.append(chip);
    }
    return row;
  }

  // ---- actions ----

  async function act(work, failure) {
    if (busy) return;
    busy = true;
    panel.setAttribute('aria-busy', 'true');
    try {
      await work();
    } catch (error) {
      onError(`${failure}: ${error.message}`);
    } finally {
      busy = false;
      panel.removeAttribute('aria-busy');
    }
  }

  // The answer of every agent request: whatever changed, at once.
  function take(result) {
    if (result.settings) onSettings(result.settings);
    if (result.sidecar) onSidecar(result.sidecar);
    if (result.agents) render({ agents: result.agents });
  }

  // A switch flips at once and is saved in order behind any other; a change
  // that fails is undone when the rest are saved.
  function flip(agent, key, on) {
    if (on && !confirmAccess(agent, key)) return;
    const patch = permissionPatch(agent, key, on);
    flipped.set(agent.id, { ...flipped.get(agent.id), ...patch });
    unsaved++;
    render({});
    flips = flips
      .then(() => api.updateAgent(agent.id, patch))
      .then(take, (error) => onError(`Could not change ${agent.name}: ${error.message}`))
      .finally(() => {
        if (--unsaved > 0) return;
        flipped.clear();
        render({});
      });
  }

  const add = (id) => act(async () => take(await api.invite(id)), 'Could not add the agent');

  const createBlank = () => act(async () => {
    const result = await api.createAgent({ name: 'agent', tagline: 'Your own agent' }, { invite: true });
    take(result);
    editProfile(result.agent.id);
  }, 'Could not create the agent');

  const setUp = (name) => act(async () => {
    take(await api.createAgent({ name }, { invite: false }));
  }, 'Could not set up the agent');

  const remove = (name) => act(async () => {
    if (!window.confirm(`Remove ${name} from this doc?\n\nIt stops answering here until you @mention it again. Its comments stay.`)) return;
    take(await api.removeAgent(name));
    if (showing === `agent:${name}`) close(); // not a card opened meanwhile
  }, 'Could not remove the agent');

  const retry = (name) => act(async () => {
    const next = await api.agentAction(name, 'retry');
    render({ agents: statuses.map((s) => (same(s.name, name) ? next : s)) });
  }, 'Could not restart the agent');

  function editProfile(id) {
    close();
    openSettings('agents', id);
  }

  /** Any of: `agents` (statuses), `participants` (the sidecar's), `roster` (settings.agents). */
  function render({ agents, participants: nextParticipants, roster: nextRoster }) {
    if (agents) statuses = agents;
    if (nextParticipants) participants = nextParticipants;
    if (nextRoster) saved = nextRoster;
    roster = saved.map((a) => (flipped.has(a.id) ? { ...a, ...flipped.get(a.id) } : a));
    paintFaces();
    if (showing && showing !== 'me') paintCard();
  }

  // ---- the comment box ----

  /**
   * What @`query` may address, grouped: agents in the doc, agents to bring in
   * (matched by name, or by their introduction for two letters or more), and
   * people.
   */
  function mentionChoices(query, myName) {
    const q = query.toLowerCase();
    const matches = (name, intro = '') => name.toLowerCase().startsWith(q) || (q.length >= 2 && intro.toLowerCase().includes(q));
    const here = agentsHere();
    const agentChoice = (name, group) => {
      const info = infoOf(name);
      return { name, kind: 'agent', group, tagline: introOf(info) };
    };
    const inDoc = here.filter((n) => matches(n, introOf(infoOf(n)))).map((n) => agentChoice(n, 'Agents in this doc'));
    const bring = roster.filter((a) => !here.some((n) => same(n, a.name)) && matches(a.name, introOf(a)))
      .map((a) => agentChoice(a.name, 'Bring in (joins this doc)'));
    const people = participants.filter((p) => p.kind === 'human' && !same(p.name, myName) && matches(p.name))
      .map((p) => ({ name: p.name, kind: 'human', group: 'People' }));
    return [...inDoc, ...bring, ...people].slice(0, 12);
  }

  /**
   * Who will answer a comment with this text, in a few words: the agents it
   * mentions; else, in a thread an agent answered, that agent; else the
   * agents with Auto Commenter, each if the comment fits it.
   */
  function replyHint(body, thread = null) {
    const known = [...participants, ...roster.map((a) => ({ name: a.name, kind: 'agent' }))];
    const mentioned = parseMentions(body, known);
    const agents = mentioned.filter((n) => known.find((k) => same(k.name, n))?.kind === 'agent');
    if (mentioned.length === 0) {
      const answered = thread?.messages.findLast((m) => m.author.kind === 'agent' && !m.undoes && !m.applies)?.author.name;
      if (answered) return `${answered} will reply · @ to ask someone else`;
      const commenters = agentsHere().filter(onAutoComment);
      if (commenters.length === 0) return 'No agent has Auto Commenter on · @ an agent to ask it';
      if (commenters.length === 1) return `${commenters[0]} will reply if it fits · @ to ask someone else`;
      return `${list(commenters, 'or')} will reply, whoever it fits · @ to ask one`;
    }
    if (agents.length === 0) return `For ${list(mentioned)}; no agent will reply`;
    const joining = agents.filter((n) => !agentsHere().some((h) => same(h, n)));
    return `${list(agents)} will reply${joining.length ? ` · ${list(joining)} ${joining.length === 1 ? 'joins' : 'join'} this doc` : ''}`;
  }

  return {
    render,
    mentionChoices,
    replyHint,
    statuses: () => statuses,
    /** The agent whose run is in progress, if any (only one runs at a time). */
    running: () => statuses.find((s) => s.state === 'running') ?? null,
    /** Your name changed: repaint your card if it is open. */
    renameMe() {
      if (showing === 'me' || showing === 'people') paintCard();
    },
  };
}

/**
 * Asks before giving `agent` Web Searcher or File Searcher (`key` 'web' or
 * 'files'); true for any other permission. With both, a web page could trick
 * it into sending your files to a website.
 */
export function confirmAccess(agent, key) {
  const risk = ACCESS_RISKS[key];
  if (!risk) return true;
  const both = key === 'web' ? agent.fileAccess : agent.webAccess;
  return window.confirm(`${risk.replace('%s', agent.name)}${both ? `\n\n${BOTH_RISK}` : ''}`);
}

const ACCESS_RISKS = {
  web: 'Let %s search the web and open web pages?\n\nA web page can hide instructions that trick it into sending this doc to a website.',
  files: 'Let %s read your other files?\n\nIt can read files on this computer except keys and .env files, and a file can hide instructions it then follows.',
};
const BOTH_RISK = 'It can also use the other one. With both, it could be tricked into sending your files to a website.';

// Only what needs your attention: no label for an agent that is fine.
const LABELS = { autocomment: 'Auto Commenter', working: 'Working…', queued: 'Waiting for its turn', offline: 'Offline', connecting: 'Connecting…', away: 'Not here' };

/**
 * 'autocomment' (ready, with Auto Commenter), 'idle' (ready, answers when
 * @mentioned), 'working', 'queued', 'offline', 'connecting', or 'away' (no
 * status: not run here).
 */
export function modeOf(status) {
  if (!status) return 'away';
  if (status.state === 'starting') return 'connecting';
  if (OFFLINE.has(status.state)) return 'offline';
  if (status.state === 'running') return 'working';
  if (status.state === 'queued') return 'queued';
  return status.autoComment ? 'autocomment' : 'idle';
}

// Why the agent is offline, in a sentence: the first line of its error.
function offlineReason(status) {
  if (status.state === 'limited') {
    const back = status.retryAt ? ` It is back at ${time(status.retryAt)}.` : '';
    return `It reached its limit of runs per hour.${back} You can raise the limit in its profile.`;
  }
  const error = plain(status.error ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (status.state === 'unavailable') return error ?? 'It could not start.';
  const sentence = (text) => (/[.!?。！？]$/.test(text) ? text : `${text}.`);
  if (status.state === 'error') return `The last run failed${error ? `: ${sentence(clip(error, 160))}` : '.'} Unfinished comments wait until you try again or reply.`;
  return 'It stopped.';
}

const list = (names, and = 'and') => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} ${and} ${names.at(-1)}`);
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// Terminal colour codes do not belong on the page.
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function button(text, className, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// A small icon-only button, labelled for screen readers and on hover.
function iconButton(name, label, onClick) {
  const node = button('', 'od-icon-button', onClick);
  node.append(icon(name));
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
