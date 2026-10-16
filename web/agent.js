// The people in the header, laid out like a shared doc's: avatars of the
// doc's agents, a People button, then yours.
//
// Agents are light: New agent pops one into the doc and opens its card, where
// a click on its name or its persona (one line) edits it in place; the Agents
// panel holds the finer settings, such as instructions. A new agent is this
// doc's own: it shows only here and comes back with the doc. Starring it puts
// it in your agents, for every doc; removing a doc's own agent deletes it.
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
import { avatar, namecardFor } from './threads.js';
import { parseMentions } from '../src/core/mentions.js';
import { MAX_PERSONA, PERMISSIONS, availableIn, introOf, permissionPatch, permissionsOf } from '../src/core/agents.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const OFFLINE = new Set(['error', 'unavailable', 'limited', 'stopped']);

/**
 * @param {{ root: HTMLElement, invite: HTMLElement, panel: HTMLElement, me: HTMLElement, getName: () => string,
 *           openSettings: (section: string, agentId?: string) => void, onSidecar: (sidecar: object) => void,
 *           onSettings: (settings: object) => void, onError: (message: string) => void,
 *           onPeople?: () => void }} options   onPeople: who is here or what they are changed
 */
export function createPeople({ root, invite, panel, me, getName, docKey = () => null, openSettings, onSidecar, onSettings, onError, onPeople = () => {} }) {
  let statuses = []; // the agents running here (server)
  let participants = []; // the doc's participants: [{ name, kind }]
  let saved = []; // the user's agents, as the settings have them
  let roster = []; // the same, with the switches flipped on a card and not yet saved
  const flipped = new Map(); // agent id → the fields its card changed, until saved
  let flips = Promise.resolve(); // the changes from cards, saved one at a time
  let unsaved = 0;
  let showing = null; // 'me' | 'people' | 'agent:<name>' | 'person:<name>' | null
  // One card for everyone, in two states: view only, opened by hovering a
  // name on the page, or editable, opened by a click (or a click on the card
  // itself) or by hovering a face in the header.
  let viewOnly = false;
  let hovered = false; // opened by hovering: goes when the pointer leaves, until a click or a field keeps it
  let anchor = null; // the name on the page the card opened next to; null: under the header
  let log = null; // the shown agent's last run log, fetched when its card opens
  let busy = false;
  let editing = null; // the field of the shown agent being edited in place: 'name' | 'persona'
  let naming = null; // id of the agent just made: after its name, its persona
  const fresh = new Set(); // names of agents just made, whose avatars pop in

  invite.addEventListener('click', () => toggle('people'));
  me.addEventListener('click', () => toggle('me'));
  root.addEventListener('click', (event) => {
    const face = event.target.closest('[data-agent]');
    if (face) toggle(`agent:${face.dataset.agent}`);
  });
  panel.addEventListener('pointerdown', () => { hovered = false; });
  panel.addEventListener('click', (event) => {
    if (viewOnly && editable() && !event.target.closest('button, a')) {
      viewOnly = false;
      return paintCard();
    }
    const row = event.target.closest('[data-open-agent]');
    if (row && !event.target.closest('button')) toggle(`agent:${row.dataset.openAgent}`);
  });
  document.addEventListener('mousedown', (event) => {
    if (showing && ![panel, root, me, invite].some((n) => n.contains(event.target))) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !showing) return;
    if (panel.contains(document.activeElement)) document.activeElement.blur(); // saves the field
    close();
  });

  window.addEventListener('scroll', () => anchor && !panel.hidden && place(), true);

  async function toggle(which, from = null) {
    // A click on the face whose card its hover opened keeps the card; a second closes it.
    if (showing === which && !viewOnly && !hovered) return close();
    if (showing !== which) anchor = from;
    showing = which;
    viewOnly = false;
    hovered = false;
    log = null;
    panel.hidden = false;
    paintCard();
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
    viewOnly = false;
    hovered = false;
    anchor = null;
    editing = null;
    naming = null;
    panel.hidden = true;
  }

  // The card of `name` (`kind` 'agent' or 'human') for the hovered `from`:
  // a name on the page gets it view only, next to it; a face in the header
  // gets it editable, under the header. False when a card opened by a click
  // is open: that one stays.
  function peek(name, kind, from) {
    if (showing && !hovered) return false;
    const header = Boolean(from.closest('.od-header'));
    showing = keyOf(name, kind);
    viewOnly = !header;
    hovered = true;
    editing = null;
    anchor = header ? null : from;
    log = null;
    panel.hidden = false;
    paintCard();
    return true;
  }

  function unpeek() {
    if (showing && hovered && !editing) close(); // a field being edited keeps it
  }

  // A click on a name: its card, editable, where it is.
  function pin(name, kind, from) {
    const which = keyOf(name, kind);
    if (showing !== which || viewOnly || hovered) toggle(which, from.closest('.od-header') ? null : from);
  }

  function keyOf(name, kind) {
    if (kind !== 'agent' && same(name, getName())) return 'me';
    const agent = agentsHere().find((n) => same(n, name)) ?? profileOf(name)?.name;
    if (agent || kind === 'agent') return `agent:${agent ?? name}`;
    return `person:${participants.find((p) => same(p.name, name))?.name ?? name}`;
  }

  // Only another person's card has nothing to change.
  const editable = () => Boolean(showing) && !showing.startsWith('person:');

  // Under the header, or next to the name it opened from: below it, or above
  // when there is no room, kept inside the window.
  function place() {
    const style = panel.style;
    if (!anchor) {
      style.left = style.top = style.right = '';
      return;
    }
    if (!anchor.isConnected) return; // its comment was redrawn: stay put
    const at = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const below = at.bottom + 6;
    style.right = 'auto';
    style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - width - 8))}px`;
    style.top = `${Math.max(8, below + height > window.innerHeight - 8 ? at.top - 6 - height : below)}px`;
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
      const wrap = el('span', `od-agent${fresh.has(name.toLowerCase()) ? ' od-agent-new' : ''}`);
      wrap.dataset.presence = mode;
      wrap.dataset.state = status?.state ?? 'away';
      const face = el('button', 'od-agent-face');
      face.type = 'button';
      face.dataset.agent = name;
      face.setAttribute('aria-label', `${name}${LABELS[mode] ? ` · ${LABELS[mode]}` : ''}`);
      face.append(avatar(name, 'agent'));
      namecardFor(face, name, 'agent', 'instant'); // its name card on hover, its full card on a click
      wrap.append(face);
      return wrap;
    }));
    // A renamed agent's card stays open while the doc catches up with the new name.
    if (agentShown() && !names.some((n) => same(n, agentShown())) && !profileOf(agentShown())) close();
  }

  // ---- the cards ----

  function paintCard() {
    panel.dataset.card = showing?.split(':')[0] ?? '';
    panel.dataset.state = viewOnly ? 'view' : 'edit';
    panel.toggleAttribute('data-editable', editable());
    if (showing === 'me') panel.replaceChildren(...meCard());
    else if (showing === 'people') panel.replaceChildren(...peopleCard());
    else if (showing?.startsWith('person:')) panel.replaceChildren(...personCard(showing.slice(7)));
    else if (agentShown()) panel.replaceChildren(...agentCard(agentShown()));
    if (!panel.hidden) place();
  }

  // A person's card is an agent's with less on it: face, name, where they
  // stand. Yours, editable, can change your name.
  function personHead(name, standing) {
    const head = el('div', 'od-profile');
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'human'));
    const who = el('div', 'od-profile-who');
    who.append(el('div', 'od-profile-name', name), el('div', 'od-profile-sub', standing));
    head.append(pic, who);
    return head;
  }

  function meCard() {
    const head = personHead(getName(), 'You');
    if (viewOnly) return [head];
    const actions = el('div', 'od-profile-actions');
    actions.append(button('Change name', 'od-secondary', () => {
      close();
      openSettings('general');
    }));
    return [head, actions];
  }

  function personCard(name) {
    return [personHead(name, 'Commented on this doc')];
  }

  // Like a shared doc's people list, one line each: you and the people who
  // commented, the agents here, then the agents you can bring in. What an
  // agent may do is on its card, a click away.
  function peopleCard() {
    const head = el('div', 'od-card-head');
    head.append(el('div', 'od-card-title', 'People'), button('Manage agents', 'od-link-button', () => {
      close();
      openSettings('agents');
    }));
    const people = el('div', 'od-people-list');
    people.append(personRow(getName(), 'You'));
    for (const p of participants.filter((p) => p.kind === 'human' && !same(p.name, getName()))) people.append(personRow(p.name, 'Commenter'));

    // The agents in this doc, then a row to make a new one.
    const here = agentsHere();
    const inDoc = el('div', 'od-people-list');
    for (const name of here) {
      // A starred agent with Auto Commenter is in every doc; this doc's own can always go.
      const removable = statusOf(name)?.source !== 'flags' && (!onAutoComment(name) || !profileOf(name)?.starred);
      // One that cannot be removed keeps the slot, so the stars line up.
      const removal = removable ? iconButton('close', `Remove ${name} from this doc`, () => remove(name)) : el('span', 'od-tool-slot');
      removal.classList.add('od-on-hover');
      inDoc.append(agentRow(name, [starButton(name), removal], true));
    }
    const create = el('button', 'od-people-row od-people-new');
    create.type = 'button';
    const plus = el('span', 'od-people-new-face');
    plus.append(icon('plus'));
    create.append(plus, el('span', 'od-people-name', 'New agent'));
    create.addEventListener('click', () => createBlank());
    inDoc.append(create);

    // Your starred agents, to bring in. (This doc's own are always in it.)
    const others = roster.filter((a) => !here.some((n) => same(n, a.name)) && a.starred);
    const parts = [head, people, el('div', 'od-card-subtitle', 'Agents in this doc'), inDoc];
    if (others.length > 0) {
      const list = el('div', 'od-people-list');
      for (const agent of others) list.append(agentRow(agent.name, [starButton(agent.name), iconButton('plus', `Add ${agent.name} to this doc`, () => add(agent.id))], false));
      parts.push(el('div', 'od-card-subtitle', 'Your agents'), list);
    }
    return parts;
  }

  function personRow(name, role) {
    const row = el('div', 'od-people-row');
    row.append(avatar(name, 'human', true), el('span', 'od-people-name', name), el('span', 'od-people-role', role));
    return row;
  }

  // An agent on one line: avatar, name, persona, then `actions`. The row
  // opens its card. Only an agent in the doc shows its state (greyed out
  // when it cannot answer here).
  function agentRow(name, actions, inDoc) {
    const row = el('div', 'od-people-row od-people-agent');
    row.dataset.openAgent = name;
    const status = statusOf(name);
    const face = el('span', 'od-profile-face');
    if (inDoc) face.dataset.presence = modeOf(status);
    face.append(avatar(name, 'agent', true));
    const who = el('span', 'od-people-who');
    who.append(el('span', 'od-people-name', name));
    const intro = profileOf(name) || status ? introOf(infoOf(name)) : 'Not one of your agents';
    if (intro) who.append(el('span', 'od-people-sub', intro));
    const tools = el('span', 'od-people-tools');
    tools.append(...actions.filter(Boolean));
    row.append(face, who, tools);
    return row;
  }

  // Star or unstar one of your agents from its row. A starred agent shows
  // its star; an unstarred one shows it on hover.
  function starButton(name) {
    const profile = profileOf(name);
    if (!profile) return el('span', 'od-tool-slot'); // not one of yours: nothing to star
    const star = iconButton('star', profile.starred ? `Unstar ${name}` : `Star ${name} to use it in every doc`, () => toggleStar(profile));
    star.classList.add('od-star');
    star.setAttribute('aria-pressed', String(profile.starred));
    if (!profile.starred) star.classList.add('od-on-hover');
    return star;
  }

  // An agent's card: who it is, and its permissions as switches. Problems
  // (it cannot run, its last run failed) show only when there is one.
  function agentCard(name) {
    const status = statusOf(name);
    const profile = profileOf(name);
    const info = infoOf(name);
    const parts = [];

    parts.push(cardHead(name));

    if (info.editMode) parts.push(permissionSwitches(info, profile));

    if (!status && !profile) {
      // In the doc, but not run here: someone else's agent, or one you deleted.
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', `None of your agents is called ${name}, so it does not answer here. It may answer from elsewhere, such as a chat session running opendoc wait.`));
      if (!viewOnly) {
        const actions = el('div', 'od-profile-actions');
        actions.append(button(`Set up ${name}`, 'od-primary', () => setUp(name)));
        problem.append(actions);
      }
      parts.push(problem);
    } else if (status && OFFLINE.has(status.state)) {
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', offlineReason(status)));
      if (status.state !== 'limited' && !viewOnly) {
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

  // The top of an agent's card: its face, name, introduction, star and edit.
  function cardHead(name) {
    const status = statusOf(name);
    const profile = profileOf(name);
    const info = infoOf(name);
    const head = el('div', 'od-profile');
    head.dataset.presence = modeOf(status);
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'agent'));
    const who = el('div', 'od-profile-who');
    if (profile && !viewOnly) {
      // Click the name or the persona line to edit it right there.
      who.append(inPlace(profile, 'name', 'od-profile-name', 'Name, as you @mention it'));
      who.append(inPlace(profile, 'persona', 'od-profile-slogan', 'Who it is, in one line'));
    } else {
      who.append(el('div', 'od-profile-name', profile?.name ?? name));
      if (introOf(info)) who.append(el('div', 'od-profile-slogan', introOf(info)));
    }
    const here = agentsHere().some((n) => same(n, name));
    who.append(el('div', 'od-profile-sub od-profile-standing', here ? (STANDING[modeOf(status)] ?? 'In this doc') : 'Not in this doc'));
    head.append(pic, who);
    if (profile && !viewOnly) {
      const tools = el('div', 'od-profile-tools');
      const star = iconButton('star', profile.starred ? `Unstar ${name}` : `Star ${name} to use it in every doc`, () => toggleStar(profile));
      star.classList.add('od-star');
      star.setAttribute('aria-pressed', String(profile.starred));
      tools.append(star, iconButton('settings', 'More settings, such as instructions', () => editProfile(profile.id)));
      head.append(tools);
    }
    return head;
  }

  // `key` of `agent` as text that turns into a field when clicked. Enter or
  // leaving the field saves it, Escape puts it back. An empty persona shows
  // as an empty line, still there to click.
  function inPlace(agent, key, className, placeholder) {
    if (editing !== key) {
      const value = key === 'name' ? agent.name : introOf(agent);
      const text = el('div', `${className} od-editable`, value || undefined);
      // No persona yet: say so, where it would go.
      if (!value) text.append(icon('plus'), el('span', '', 'Add a persona'));
      text.classList.toggle('od-editable-empty', !value);
      text.tabIndex = 0;
      text.setAttribute('role', 'button');
      text.setAttribute('aria-label', key === 'name' ? `Rename ${agent.name}` : `Persona of ${agent.name}`);
      const start = () => {
        editing = key;
        paintCard();
        const field = panel.querySelector('.od-inline-input');
        field?.focus();
        field?.select();
      };
      text.addEventListener('click', start);
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(); } });
      return text;
    }
    const field = el('input', `${className} od-inline-input`);
    field.type = 'text';
    field.value = key === 'name' ? agent.name : agent.persona;
    field.placeholder = placeholder;
    field.maxLength = key === 'name' ? 64 : MAX_PERSONA;
    field.spellcheck = key !== 'name';
    field.setAttribute('aria-label', key === 'name' ? 'Name' : 'Persona');
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) commit(agent, key, field);
      else {
        editing = null;
        paintCard();
      }
    };
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    field.addEventListener('blur', () => finish(true));
    return field;
  }

  async function commit(agent, key, field) {
    const value = field.value.trim();
    const next = key === 'name' && naming === agent.id ? 'persona' : null; // a new agent: name, then persona
    if (value === (key === 'name' ? agent.name : agent.persona)) return settle(next);
    if (key === 'name' && !NAME_PATTERN.test(value)) return fail(field, 'Letters, digits, dot, dash or underscore, starting with a letter or digit', key);
    // A new agent's persona field opens at once, while its name saves, so
    // nothing typed right after Enter is lost.
    if (next) settle(next);
    try {
      const result = await api.updateAgent(agent.id, { [key]: value });
      if (key === 'name' && showing === `agent:${agent.name}`) showing = `agent:${value}`;
      take(result);
      if (!next) settle(null);
    } catch (failure) {
      fail(field, failure.message, key);
    }
  }

  // The field is done: back to text, or on to the next one.
  function settle(next) {
    if (!next) naming = null;
    editing = next;
    paintCard();
    if (!next) return;
    const field = panel.querySelector('.od-inline-input');
    field?.focus();
  }

  // Keep the field open, with what went wrong under the card's top.
  function fail(field, message, key) {
    editing = key;
    paintCard();
    const again = panel.querySelector('.od-inline-input');
    if (!again) return;
    again.value = field.value;
    again.setAttribute('aria-invalid', 'true');
    const error = el('div', 'od-input-error', message);
    panel.querySelector('.od-profile')?.after(error);
    again.focus();
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
      chip.disabled = viewOnly || !profile || unsupported;
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

  // One click: the new agent pops into the doc, its card open for editing.
  const createBlank = () => act(async () => {
    const result = await api.createAgent({}, { invite: true });
    const name = result.agent.name;
    fresh.add(name.toLowerCase());
    setTimeout(() => fresh.delete(name.toLowerCase()), 800);
    take(result);
    editing = 'name';
    naming = result.agent.id;
    showing = `agent:${name}`;
    panel.hidden = false;
    paintCard();
    const field = panel.querySelector('.od-inline-input');
    field?.focus();
    field?.select();
  }, 'Could not create the agent');

  // Unstarring an agent that is not in this doc takes it out of your agents
  // (docs that use it keep it), so that asks first.
  const toggleStar = (agent) => act(async () => {
    const here = agentsHere().some((n) => same(n, agent.name));
    if (agent.starred && !here && !window.confirm(`Unstar ${agent.name}?\n\nIt leaves your agents. Docs that use it keep it as their own.`)) return;
    take(await api.updateAgent(agent.id, { starred: !agent.starred }));
  }, 'Could not change the agent');

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
    // Only the agents that can work here: starred ones and this doc's own.
    roster = saved.filter((a) => availableIn(a, docKey())).map((a) => (flipped.has(a.id) ? { ...a, ...flipped.get(a.id) } : a));
    paintFaces();
    // Not while a field on the card is being typed in.
    if (showing && showing !== 'me' && !(editing && panel.contains(document.activeElement))) paintCard();
    onPeople();
  }

  // ---- @names in the text ----

  /** Everyone an @name can mean here: [{ name, kind }], agents first. */
  function mentionable() {
    const found = [];
    const add = (name, kind) => {
      if (!found.some((p) => same(p.name, name))) found.push({ name, kind });
    };
    for (const name of agentsHere()) add(name, 'agent');
    for (const agent of roster) add(agent.name, 'agent');
    add(getName(), 'human');
    for (const p of participants) add(p.name, p.kind);
    return found;
  }

  // Opens the full card of `name` from elsewhere on the page.
  function open(name) {
    if (showing !== `agent:${name}`) toggle(`agent:${name}`);
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
    mentionable,
    open,
    peek,
    unpeek,
    pin,
    statuses: () => statuses,
    /** The agent whose run is in progress, if any (only one runs at a time). */
    running: () => statuses.find((s) => s.state === 'running') ?? null,
    /** Your name changed: repaint your card if it is open. */
    renameMe() {
      if (showing === 'me' || showing === 'people') paintCard();
      onPeople();
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
// Where an agent in the doc stands, for its name card.
// Where an agent stands in this doc, on its card under its name.
const STANDING = {
  autocomment: 'Answers new comments', idle: 'Answers when @mentioned', working: 'Working…',
  queued: 'Waiting for its turn', offline: 'Offline', connecting: 'Connecting…', away: 'Not running here',
};

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
