// The people in the header, laid out like a shared doc's: avatars of the
// doc's agents, a People button, then yours.
//
// The **pilot** (Clippy unless the user picks another) is in every doc and
// answers every comment not addressed to someone else. **Co-pilots** answer
// only when @mentioned; mentioning one brings it into the doc. The People
// panel works like Docs' share dialog: who is here and what each may do
// (Can edit or Can suggest; Web and Your files greyed when not allowed,
// outlined when it asks you first), Remove, the co-pilots you can bring in,
// and the access you gave agents when they asked, with Revoke. Clicking an
// avatar opens that agent's profile card: its job, persona, permissions and
// grants, what it is doing, its last run.
//
// The comment box asks this module what to offer after @ and who will reply.

import { api } from './api.js';
import { avatar, chips, shortPath } from './threads.js';
import { parseMentions } from '../src/core/mentions.js';
import { PERMISSION_LABELS } from '../src/core/grants.js';

const OFFLINE = new Set(['error', 'unavailable', 'limited', 'stopped']);

/**
 * @param {{ root: HTMLElement, invite: HTMLElement, panel: HTMLElement, me: HTMLElement, getName: () => string,
 *           openSettings: (section: string, agentId?: string) => void, onSidecar: (sidecar: object) => void,
 *           onSettings: (settings: object) => void, onError: (message: string) => void }} options
 */
export function createPeople({ root, invite, panel, me, getName, openSettings, onSidecar, onSettings, onError }) {
  let statuses = []; // the agents running here (server)
  let participants = []; // the doc's participants: [{ name, kind }]
  let roster = []; // the user's agents (settings)
  let grants = []; // what the human allowed agents here: [{ id, agentId, permission, scope, folder }]
  let asking = []; // runs' requests waiting on the human
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
    if (name && statusOf(name)) {
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
  const pilot = () => roster.find((a) => a.role === 'pilot') ?? null;
  // Everything known about an agent: its profile, or else what its status says.
  const infoOf = (name) => profileOf(name) ?? statusOf(name) ?? { name };
  const isPilot = (name) => (statusOf(name)?.role ?? profileOf(name)?.role) === 'pilot';
  const isAsking = (name) => asking.some((r) => same(r.agent, name));
  const chipsOf = (info) => permissionChips(info, grants);

  // The agents of the doc: the pilot first, then the others as they joined.
  function agentsHere() {
    const names = participants.filter((p) => p.kind === 'agent').map((p) => p.name);
    for (const s of statuses) if (!names.some((n) => same(n, s.name))) names.push(s.name);
    return names.sort((a, b) => Number(isPilot(b)) - Number(isPilot(a)));
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
      if (isPilot(name)) wrap.dataset.pilot = '';
      if (isAsking(name)) wrap.dataset.asking = '';
      const face = el('button', 'od-agent-face');
      face.type = 'button';
      face.dataset.agent = name;
      const label = `${name}${isPilot(name) ? ' (pilot)' : ''} · ${isAsking(name) ? 'Waiting for your OK' : LABELS[mode]}`;
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

  // Like a shared doc's people list: you, the pilot, the co-pilots here,
  // then the co-pilots you can bring in.
  function peopleCard() {
    const parts = [el('div', 'od-card-title', 'People and agents')];
    const list = el('div', 'od-people-list');
    const meRow = personRow(getName(), 'human', 'You');
    meRow.append(el('span', 'od-people-role', 'Owner'));
    list.append(meRow);
    for (const p of participants.filter((p) => p.kind === 'human' && !same(p.name, getName()))) {
      const row = personRow(p.name, 'human', 'Commented here');
      row.append(el('span', 'od-people-role', 'Commenter'));
      list.append(row);
    }
    parts.push(list);

    const here = agentsHere();
    const pilotName = here.find(isPilot);
    if (pilotName) {
      parts.push(el('div', 'od-card-subtitle', 'Pilot · answers every comment'));
      parts.push(agentRow(pilotName, null));
    }
    const copilots = here.filter((n) => !isPilot(n));
    parts.push(el('div', 'od-card-subtitle', 'Co-pilots · answer when @mentioned'));
    if (copilots.length === 0) parts.push(el('p', 'od-card-hint', 'None here yet. @mention one in a comment, or add one below.'));
    for (const name of copilots) {
      const removable = statusOf(name)?.source !== 'flags';
      parts.push(agentRow(name, removable ? button('Remove', 'od-link-button od-danger', () => remove(name)) : null));
    }

    const given = grants.filter((g) => roster.some((a) => a.id === g.agentId));
    if (given.length > 0) {
      parts.push(el('div', 'od-card-subtitle', 'Access you allowed'));
      for (const grant of given) parts.push(grantRow(grant, true));
    }

    const available = roster.filter((a) => a.role !== 'pilot' && !here.some((n) => same(n, a.name)));
    if (available.length > 0) {
      parts.push(el('div', 'od-card-subtitle', 'Bring in a co-pilot'));
      for (const agent of available) parts.push(agentRow(agent.name, button('Add', 'od-secondary', () => add(agent.id)), agent));
    }
    const actions = el('div', 'od-profile-actions od-profile-footer');
    actions.append(button('New agent', 'od-link-button', () => createBlank()), button('Manage agents', 'od-link-button', () => {
      close();
      openSettings('agents');
    }));
    parts.push(actions);
    return parts;
  }

  function personRow(name, kind, sub) {
    const row = el('div', 'od-people-row');
    const who = el('div', 'od-people-who');
    who.append(el('div', 'od-people-name', name), el('div', 'od-people-sub', sub));
    row.append(avatar(name, kind), who);
    return row;
  }

  function agentRow(name, action, info = infoOf(name)) {
    const row = el('div', 'od-people-row od-people-agent');
    row.dataset.openAgent = name;
    row.title = `${name}: open profile`;
    const status = statusOf(name);
    const face = el('span', 'od-profile-face');
    face.dataset.presence = modeOf(status);
    face.append(avatar(name, 'agent'), ...(status ? [el('span', 'od-presence-dot')] : []));
    const who = el('div', 'od-people-who');
    const title = el('div', 'od-people-name', name);
    title.append(el('span', 'od-ai', 'AI'));
    who.append(title, el('div', 'od-people-sub', info.tagline || (status ? LABELS[modeOf(status)] : 'Not set up on this computer')));
    if (info.editMode) who.append(chips(chipsOf(info)));
    row.append(face, who);
    if (action) row.append(action);
    return row;
  }

  // One grant: what, where, and Revoke. `named` puts the agent's name first.
  function grantRow(grant, named = false) {
    const agent = roster.find((a) => a.id === grant.agentId);
    const row = el('div', 'od-grant');
    const text = el('span', 'od-grant-text', `${named && agent ? `${agent.name}: ` : ''}${grantText(grant)}`);
    if (grant.folder) text.title = grant.folder;
    row.append(text, button('Revoke', 'od-link-button od-danger', () => revoke(grant, agent?.name ?? 'the agent')));
    return row;
  }

  // What the agent may reach beyond the doc: each permission it may ask for,
  // the grants it holds, and for a Codex agent (which cannot ask during a
  // run) a way to allow the web in advance.
  function accessBlock(info) {
    const id = info.id;
    const codex = (info.runtime ?? info.kind) === 'codex';
    const rows = [];
    for (const permission of ['web', 'files']) {
      if (!(permission === 'web' ? info.webAccess : info.fileAccess && !codex)) continue;
      const held = grants.filter((g) => g.agentId === id && g.permission === permission);
      for (const grant of held) rows.push(grantRow(grant));
      if (held.length > 0) continue;
      const row = el('div', 'od-grant');
      if (codex) {
        row.append(el('span', 'od-grant-text', `${PERMISSION_LABELS[permission]}: off until you allow it (Codex cannot ask during a run)`));
        const allow = el('span', 'od-grant-actions');
        allow.append(
          button('In this doc', 'od-link-button', () => allowAhead(info, permission, 'doc')),
          button('Always', 'od-link-button', () => allowAhead(info, permission, 'always')),
        );
        row.append(allow);
      } else {
        row.append(el('span', 'od-grant-text', `${PERMISSION_LABELS[permission]}: asks you the first time`));
      }
      rows.push(row);
    }
    if (rows.length === 0 || !id) return null;
    const block = el('div', 'od-access');
    block.append(el('div', 'od-card-subtitle', 'Beyond this doc'), ...rows);
    return block;
  }

  function agentCard(name) {
    const status = statusOf(name);
    const info = infoOf(name);
    const mode = modeOf(status);
    const parts = [];

    const head = el('div', 'od-profile');
    head.dataset.presence = mode;
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'agent'), el('span', 'od-presence-dot'));
    const who = el('div', 'od-profile-who');
    const title = el('div', 'od-profile-name', name);
    title.append(el('span', 'od-ai', 'AI'), el('span', 'od-role', isPilot(name) ? 'Pilot' : 'Co-pilot'));
    const state = el('div', 'od-profile-state');
    state.append(el('span', 'od-presence-dot od-presence-dot-inline'), el('span', '', isAsking(name) ? 'Waiting for your OK in a comment' : stateText(status)));
    who.append(title);
    if (info.tagline) who.append(el('div', 'od-profile-slogan', info.tagline));
    who.append(state);
    head.append(pic, who);
    parts.push(head);
    parts.push(el('p', 'od-profile-answers', isPilot(name)
      ? 'Answers every comment that does not @mention someone else.'
      : `Answers when you @mention ${name}, and follow-ups in its own threads.`));
    if (info.editMode) parts.push(chips(chipsOf(info)));
    const access = info.editMode ? accessBlock({ ...info, id: info.id ?? status?.id }) : null;
    if (access) parts.push(access);

    const persona = info.persona ?? '';
    if (persona.trim()) {
      const details = el('details', 'od-profile-persona');
      details.append(el('summary', '', 'Persona'), el('div', 'od-profile-persona-text', persona.trim()));
      parts.push(details);
    }

    if (!status) {
      // In the doc, but not run here: someone else's agent, or one you deleted.
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', profileOf(name)
        ? 'Starting…'
        : `None of your agents is called ${name}, so it does not answer here. It may answer from elsewhere, such as a chat session running opendoc wait.`));
      if (!profileOf(name)) {
        const actions = el('div', 'od-profile-actions');
        actions.append(button(`Set up ${name}`, 'od-primary', () => setUp(name)));
        problem.append(actions);
      }
      parts.push(problem);
    } else if (mode === 'offline') {
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', offlineReason(status)));
      const actions = el('div', 'od-profile-actions');
      if (status.state !== 'limited') actions.append(button('Try again', 'od-primary', () => retry(name)));
      if (status.id) actions.append(button('Agent settings', 'od-secondary', () => edit(status.id)));
      problem.append(actions);
      parts.push(problem);
    }

    if (status) {
      const facts = el('div', 'od-profile-facts');
      facts.append(el('div', '', `Runs on ${RUNTIME_LABELS[status.kind] ?? status.kind}`));
      const run = status.lastRun;
      if (run) {
        const bits = [`Last run ${run.ok ? 'finished' : 'failed'} ${time(run.endedAt)}`];
        if (run.turns) bits.push(`${run.turns} turns`);
        if (run.costUsd) bits.push(`$${run.costUsd.toFixed(2)}`);
        if (run.denials) bits.push(`${run.denials} tool calls denied`);
        facts.append(el('div', '', bits.join(' · ')));
      }
      if (status.source === 'flags') facts.append(el('div', '', 'Started with opendoc serve --agent'));
      parts.push(facts);
      if (log) {
        const details = el('details', 'od-profile-log');
        details.append(el('summary', '', 'Run log'), el('pre', '', plain(log)));
        parts.push(details);
      }
    }

    const actions = el('div', 'od-profile-actions od-profile-footer');
    const id = status?.id ?? profileOf(name)?.id;
    if (id) actions.append(button('Edit profile', 'od-secondary', () => edit(id)));
    if (status?.source !== 'flags' && !isPilot(name)) actions.append(button('Remove from doc', 'od-secondary od-danger', () => remove(name)));
    parts.push(actions);
    return parts;
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
    if (result.agents || result.grants) render({ agents: result.agents, grants: result.grants });
  }

  const revoke = (grant, agentName) => act(async () => {
    take(await api.revokeGrant(grant.id));
  }, `Could not revoke ${agentName}'s access`);

  const allowAhead = (info, permission, scope) => act(async () => {
    const where = scope === 'doc' ? 'in this doc' : 'in every doc';
    if (!window.confirm(`Let ${info.name} search the web ${where}?\n\nA web page can hide instructions that trick it into sending this doc to a website.`)) return;
    take(await api.grantAhead(info.id, permission, scope));
  }, 'Could not allow it');

  const add = (id) => act(async () => take(await api.invite(id)), 'Could not add the agent');

  const createBlank = () => act(async () => {
    const result = await api.createAgent({ name: 'agent', tagline: 'Your own co-pilot' }, { invite: true });
    take(result);
    edit(result.agent.id);
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

  function edit(id) {
    close();
    openSettings('agents', id);
  }

  /**
   * Any of: `agents` (statuses), `participants` (the sidecar's), `roster`
   * (settings.agents), `grants` (those that hold here), `permissions` (requests
   * waiting on the human).
   */
  function render({ agents, participants: nextParticipants, roster: nextRoster, grants: nextGrants, permissions: nextAsking }) {
    if (agents) statuses = agents;
    if (nextParticipants) participants = nextParticipants;
    if (nextRoster) roster = nextRoster;
    if (nextGrants) grants = nextGrants;
    if (nextAsking) asking = nextAsking;
    paintFaces();
    if (showing && showing !== 'me') paintCard();
  }

  // ---- the comment box ----

  /**
   * What @`query` may address, grouped: co-pilots in the doc, co-pilots to
   * bring in (matched by name, or by their job for two letters or more), and
   * people. The pilot answers anyway, so it is left out.
   */
  function mentionChoices(query, myName) {
    const q = query.toLowerCase();
    const matches = (name, tagline = '') => name.toLowerCase().startsWith(q) || (q.length >= 2 && tagline.toLowerCase().includes(q));
    const here = agentsHere();
    const agentChoice = (name, group) => {
      const info = infoOf(name);
      return { name, kind: 'agent', group, tagline: info.tagline ?? '', labels: info.editMode ? chipsOf(info) : [] };
    };
    const inDoc = here.filter((n) => !isPilot(n) && matches(n, infoOf(n).tagline)).map((n) => agentChoice(n, 'Co-pilots in this doc'));
    const bring = roster.filter((a) => a.role !== 'pilot' && !here.some((n) => same(n, a.name)) && matches(a.name, a.tagline))
      .map((a) => agentChoice(a.name, 'Bring in (joins this doc)'));
    const people = participants.filter((p) => p.kind === 'human' && !same(p.name, myName) && matches(p.name))
      .map((p) => ({ name: p.name, kind: 'human', group: 'People' }));
    return [...inDoc, ...bring, ...people].slice(0, 12);
  }

  /**
   * Who will answer a comment with this text, in a few words: the agents it
   * mentions; else, in a thread an agent answered, that agent; else the pilot.
   */
  function replyHint(body, thread = null) {
    const known = [...participants, ...roster.map((a) => ({ name: a.name, kind: 'agent' }))];
    const mentioned = parseMentions(body, known);
    const agents = mentioned.filter((n) => known.find((k) => same(k.name, n))?.kind === 'agent');
    const leader = pilot()?.name ?? agentsHere().find(isPilot);
    if (mentioned.length === 0) {
      const answered = thread?.messages.findLast((m) => m.author.kind === 'agent' && !m.undoes && !m.applies)?.author.name;
      if (answered) return `${answered} will reply · @ to ask someone else`;
      return leader ? `${leader} will reply · @ to bring in a co-pilot` : '';
    }
    if (agents.length === 0) return `For ${list(mentioned)}; no agent will reply`;
    const joining = agents.filter((n) => !agentsHere().some((h) => same(h, n)));
    const joins = joining.map((n) => `${n} (${permissionLabels(infoOf(n), grants)})`);
    return `${list(agents)} will reply${joins.length ? ` · ${list(joins)} ${joining.length === 1 ? 'joins' : 'join'} this doc` : ''}`;
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

const LABELS = { online: 'Ready', working: 'Working…', queued: 'Waiting for its turn', offline: 'Offline', connecting: 'Connecting…', away: 'Not here' };
const RUNTIME_LABELS = { claude: 'Claude Code', codex: 'Codex', custom: 'a custom command' };

/**
 * Every permission as a chip: Can edit or Can suggest; Web and Your files off
 * (its profile may not ask for them), on (`grants` hold one here), or asked
 * for at first use. A Codex agent cannot ask during a run, so without a grant
 * its Web is off.
 */
export function permissionChips(agent, grants = []) {
  const codex = (agent.runtime ?? agent.kind) === 'codex';
  const chip = (permission, may) => {
    const label = PERMISSION_LABELS[permission];
    if (!may) return { label, on: false };
    const held = grants.filter((g) => g.agentId === agent.id && g.permission === permission);
    if (held.length > 0) return { label, on: true, title: `Allowed: ${held.map(grantText).join('; ')}` };
    if (codex) return { label, on: false, title: 'Off until you allow it in its profile card (Codex cannot ask during a run)' };
    return { label: `${label} · asks`, on: false, ask: true, title: 'Asks you the first time it needs it' };
  };
  return [
    { label: agent.editMode === 'auto' ? 'Can edit' : 'Can suggest', on: true },
    chip('web', Boolean(agent.webAccess)),
    chip('files', Boolean(agent.fileAccess) && !codex),
  ];
}

const permissionLabels = (agent, grants) => permissionChips(agent, grants).filter((c) => c.on || c.ask).map((c) => c.label).join(' · ');

/** A grant in a few words: "Your files in …/work/notes · always". */
function grantText(grant) {
  const where = grant.folder ? ` in ${shortPath(grant.folder)}` : '';
  return `${PERMISSION_LABELS[grant.permission]}${where} · ${grant.scope === 'doc' ? 'in this doc' : 'always'}`;
}

/** 'online', 'working', 'queued', 'offline', 'connecting', or 'away' (no status: not run here). */
export function modeOf(status) {
  if (!status) return 'away';
  if (status.state === 'starting') return 'connecting';
  if (OFFLINE.has(status.state)) return 'offline';
  if (status.state === 'running') return 'working';
  if (status.state === 'queued') return 'queued';
  return 'online';
}

function stateText(status) {
  return LABELS[modeOf(status)];
}

// Why the agent is offline, in a sentence: the first line of its error.
function offlineReason(status) {
  if (status.state === 'limited') {
    const back = status.retryAt ? ` It is back at ${time(status.retryAt)}.` : '';
    return `It reached its limit of runs per hour.${back} You can raise the limit in its settings.`;
  }
  const error = plain(status.error ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (status.state === 'unavailable') return error ?? 'It could not start.';
  const sentence = (text) => (/[.!?。！？]$/.test(text) ? text : `${text}.`);
  if (status.state === 'error') return `The last run failed${error ? `: ${sentence(clip(error, 160))}` : '.'} Unfinished comments wait until you try again or reply.`;
  return 'It stopped.';
}

const list = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
