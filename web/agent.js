// The people in the header, laid out like a shared doc's: avatars of the
// buddies the doc reaches, a People button, then yours.
//
// Buddies are light: on a buddy's card, a click on its name or its persona
// (one line) edits it in place; the Buddies panel holds the finer settings,
// such as instructions. New buddy opens a draft there. A new buddy is this
// doc's own: it shows only here. Starring it puts it in your buddies, for
// every doc.
//
// A buddy answers when @mentioned. The People panel lists who commented
// and the buddies here. Clicking an avatar opens that buddy's card: its
// name and persona, each editable right there. Your own card works
// the same way: a click on your name edits it in place. On either, a click
// on the face draws a new one; a new name keeps the face.
//
// The comment box asks this module what to offer after @.

import { api } from './api.js';
import { icon } from './icons.js';
import { avatar, namecardFor } from './threads.js';
import { MAX_PERSONA, availableIn, introOf } from '../src/core/agents.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const ME = 'me'; // your card's id for its name field: no agent's (theirs start with a_)
export const NAME_RULE = 'Letters, digits, dot, dash or underscore, starting with a letter or digit';
// A seed for a new face (web/faces.js).
const newFace = () => Math.random().toString(36).slice(2, 10);

/**
 * @param {{ root: HTMLElement, invite: HTMLElement, panel: HTMLElement, me: HTMLElement, getName: () => string, getId?: () => string | null,
 *           setName: (name: string) => boolean, setFace: (face: string) => void, openSettings: (section: string, agentId?: string) => void,
 *           newAgent: () => void, onSettings: (settings: object) => void, onError: (message: string) => void }} options
 */
export function createPeople({ root, invite, panel, me, getName, getId = () => null, setName, setFace, docKey = () => null, openSettings, newAgent, onSettings, onError }) {
  let statuses = []; // the buddies the doc reaches, and which are at work (the doc host)
  let writers = []; // the people who commented: [{ id, name }]
  let roster = []; // the user's agents that can work here
  let showing = null; // 'me' | 'people' | 'agent:<name>' | 'person:<name>' | null
  // One card for everyone, in two states: view only, opened by hovering a
  // name on the page, or editable, opened by a click (or a click on the card
  // itself) or by hovering a face in the header.
  let viewOnly = false;
  let hovered = false; // opened by hovering: goes when the pointer leaves, until a click or a field keeps it
  let anchor = null; // the name on the page the card opened next to; null: under the header
  let busy = false;
  let editing = null; // the field of the shown agent being edited in place: 'name' | 'persona'

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

  function toggle(which, from = null) {
    // A click on the face whose card its hover opened keeps the card; a second closes it.
    if (showing === which && !viewOnly && !hovered) return close();
    if (showing !== which) anchor = from;
    showing = which;
    viewOnly = false;
    hovered = false;
    panel.hidden = false;
    paintCard();
  }

  function close() {
    showing = null;
    viewOnly = false;
    hovered = false;
    anchor = null;
    editing = null;
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
    return `person:${writers.find((p) => same(p.name, name))?.name ?? name}`;
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
  const isMe = (p) => p.id === getId();
  const statusOf = (name) => statuses.find((s) => same(s.name, name)) ?? null;
  const profileOf = (name) => roster.find((a) => same(a.name, name)) ?? null;
  // Everything known about an agent: its profile, or else what its status says.
  const infoOf = (name) => profileOf(name) ?? statusOf(name) ?? { name };

  // The buddies the doc reaches.
  const agentsHere = () => statuses.map((s) => s.name);

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
  // stand.
  function personHead(name, standing) {
    const head = el('div', 'od-profile');
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'human'));
    const who = el('div', 'od-profile-who');
    who.append(el('div', 'od-profile-name', name), el('div', 'od-profile-sub', standing));
    head.append(pic, who);
    return head;
  }

  // Yours works as an agent's does: editable, a click on your name edits it
  // in place and a click on your face draws a new one.
  function meCard() {
    if (viewOnly) return [personHead(getName(), 'You')];
    const head = el('div', 'od-profile');
    const who = el('div', 'od-profile-who');
    who.append(inPlace({ id: ME, name: getName() }, 'name', 'od-profile-name', 'Your name, as others @mention you'), el('div', 'od-profile-sub', 'You'));
    const tools = el('div', 'od-profile-tools');
    tools.append(iconButton('settings', 'More settings', () => {
      close();
      openSettings('general');
    }));
    head.append(facePicker(getName(), 'human', () => setFace(newFace())), who, tools);
    return [head];
  }

  // A face to click for a new one.
  function facePicker(name, kind, pick) {
    const face = avatar(name, kind);
    face.removeAttribute('title');
    const node = button('', 'od-profile-face od-face-picker', pick);
    node.title = 'Change avatar';
    node.setAttribute('aria-label', 'Change avatar');
    node.append(face);
    return node;
  }

  function personCard(name) {
    return [personHead(name, 'Commented on this doc')];
  }

  // Like a shared doc's people list, one line each: you and the people who
  // commented, the agents here, then the agents you can bring in. What an
  // agent may do is on its card, a click away.
  function peopleCard() {
    const head = el('div', 'od-card-head');
    head.append(el('div', 'od-card-title', 'People'), button('Manage buddies', 'od-link-button', () => {
      close();
      openSettings('agents');
    }));
    const people = el('div', 'od-people-list');
    people.append(personRow(getName(), 'You'));
    for (const p of writers.filter((p) => !isMe(p))) people.append(personRow(p.name, 'Commenter'));

    // The buddies here, then a row to make a new one.
    const inDoc = el('div', 'od-people-list');
    for (const name of agentsHere()) inDoc.append(agentRow(name, [starButton(name)], true));
    const create = el('button', 'od-people-row od-people-new');
    create.type = 'button';
    const plus = el('span', 'od-people-new-face');
    plus.append(icon('plus'));
    create.append(plus, el('span', 'od-people-name', 'New buddy'));
    create.addEventListener('click', () => {
      close();
      newAgent();
    });
    inDoc.append(create);

    return [head, people, el('div', 'od-card-subtitle', 'Buddies in this doc'), inDoc];
  }

  function personRow(name, role) {
    const row = el('div', 'od-people-row');
    row.append(avatar(name, 'human', true), el('span', 'od-people-name', name), el('span', 'od-people-role', role));
    return row;
  }

  // An agent on one line: avatar, name, persona, then `actions`. The row
  // opens its card. Only an agent in the doc shows its state.
  function agentRow(name, actions, inDoc) {
    const row = el('div', 'od-people-row od-people-agent');
    row.dataset.openAgent = name;
    const status = statusOf(name);
    const face = el('span', 'od-profile-face');
    if (inDoc) face.dataset.presence = modeOf(status);
    face.append(avatar(name, 'agent', true));
    const who = el('span', 'od-people-who');
    who.append(el('span', 'od-people-name', name));
    const intro = profileOf(name) || status ? introOf(infoOf(name)) : 'Not one of your buddies';
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

  // An agent's card: who it is. One in the doc that is not one of yours
  // (it shares your name, say) says it does not answer here.
  function agentCard(name) {
    const parts = [cardHead(name)];
    if (!statusOf(name) && !profileOf(name)) {
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', `None of your buddies is called ${name}, so it does not answer here.`));
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
    let pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'agent'));
    if (profile && !viewOnly) pic = facePicker(name, 'agent', () => changeFace(profile));
    const who = el('div', 'od-profile-who');
    if (profile && !viewOnly) {
      // Click the name or the persona line to edit it right there.
      who.append(inPlace(profile, 'name', 'od-profile-name', 'Name'));
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
    if (agent.id === ME) return commitMyName(field, value);
    if (value === (key === 'name' ? agent.name : agent.persona)) return settle();
    if (key === 'name' && !NAME_PATTERN.test(value)) return fail(field, NAME_RULE, key);
    try {
      const result = await api.updateAgent(agent.id, { [key]: value });
      if (key === 'name' && showing === `agent:${agent.name}`) showing = `agent:${value}`;
      take(result);
      settle();
    } catch (failure) {
      fail(field, failure.message, key);
    }
  }

  function commitMyName(field, value) {
    if (value !== getName() && !NAME_PATTERN.test(value)) return fail(field, NAME_RULE, 'name');
    settle();
    setName(value);
  }

  // The field is done: back to text.
  function settle() {
    editing = null;
    paintCard();
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
    if (result.agents) render({ agents: result.agents });
  }

  // Unstarred, a buddy becomes this doc's own.
  const toggleStar = (agent) => act(async () => {
    take(await api.updateAgent(agent.id, { starred: !agent.starred }));
  }, 'Could not change the buddy');

  const changeFace = (agent) => act(async () => {
    take(await api.updateAgent(agent.id, { face: newFace() }));
  }, 'Could not change the avatar');

  function editProfile(id) {
    close();
    openSettings('agents', id);
  }

  /** Any of: `agents` (statuses), `people` (who commented), `roster` (settings.agents). */
  function render({ agents, people: nextWriters, roster: nextRoster }) {
    if (agents) statuses = agents;
    if (nextWriters) writers = nextWriters;
    // Only the agents that can work here: starred ones and this doc's own.
    if (nextRoster) roster = nextRoster.filter((a) => availableIn(a, docKey()));
    paintFaces();
    // Not while a field on the card is being typed in.
    if (showing && showing !== 'me' && !(editing && panel.contains(document.activeElement))) paintCard();
  }

  // ---- @names in the text ----

  /** Everyone an @name can mean here: [{ name, kind }], agents first. */
  function mentionable() {
    const found = [];
    const add = (name, kind) => {
      if (!found.some((p) => same(p.name, name))) found.push({ name, kind });
    };
    for (const name of agentsHere()) add(name, 'agent');
    add(getName(), 'human');
    for (const p of writers) add(p.name, 'human');
    return found;
  }

  // Opens the full card of `name` from elsewhere on the page.
  function open(name) {
    if (showing !== `agent:${name}`) toggle(`agent:${name}`);
  }

  // ---- the comment box ----

  /**
   * What @`query` may address, grouped: the buddies here (matched by name,
   * or by their persona for two letters or more), and the people who
   * commented.
   */
  function mentionChoices(query) {
    const q = query.toLowerCase();
    const matches = (name, intro = '') => name.toLowerCase().startsWith(q) || (q.length >= 2 && intro.toLowerCase().includes(q));
    const here = agentsHere();
    const agentChoice = (name, group) => {
      const info = infoOf(name);
      return { name, kind: 'agent', group, tagline: introOf(info) };
    };
    const inDoc = here.filter((n) => matches(n, introOf(infoOf(n)))).map((n) => agentChoice(n, 'Buddies'));
    const people = writers.filter((p) => !isMe(p) && matches(p.name))
      .map((p) => ({ name: p.name, kind: 'human', group: 'People' }));
    return [...inDoc, ...people].slice(0, 12);
  }

  return {
    render,
    mentionChoices,
    mentionable,
    open,
    peek,
    unpeek,
    pin,
    statuses: () => statuses,
    /** An agent whose run is in progress, if any. */
    running: () => statuses.find((s) => s.state === 'running') ?? null,
    /** Your name changed: repaint your card if it is open. */
    renameMe() {
      if (showing === 'me' || showing === 'people') paintCard();
    },
  };
}

// Where an agent stands in this doc, on its card under its name.
const STANDING = { working: 'Working…', away: 'Not running here' };

const LABELS = { working: 'Working…', away: 'Not here' };

/** 'working', 'idle' (answers when @mentioned), or 'away' (no status: not run here). */
export function modeOf(status) {
  if (!status) return 'away';
  return status.state === 'running' ? 'working' : 'idle';
}

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
