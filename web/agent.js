// The people in the header, laid out like a shared doc's: avatars of the
// buddies the doc reaches, a Team button, then yours.
//
// A card is where everyone is changed: on a buddy's, a click on its name
// edits it in place, and who it is is a field right under it; your own
// card edits your name the same way; on a teammate's, the owner sets Read
// or Edit, or removes them. Faces are drawn from names.
//
// A buddy answers when @mentioned. The Team panel (the button after the
// faces) has you, in a project your teammates (a request to join at the
// top) and the invite link, then every buddy here; in a project it deletes
// a buddy and makes one. Only the owner changes the team and the buddies.
//
// The comment box asks this module what to offer after @.

import { api } from './api.js';
import { icon } from './icons.js';
import { avatar, namecardFor } from './threads.js';
import { defaultName, tagline } from '../src/core/buddies.js';
import { NAME_PATTERN } from '../src/core/mentions.js';

const NAME_RULE = 'Letters, digits, dot, dash or underscore, starting with a letter or digit';

/**
 * @param {{ root: HTMLElement, invite: HTMLElement, panel: HTMLElement, me: HTMLElement, getName: () => string, getId?: () => string | null,
 *           setName: (name: string) => boolean, getAbout: () => string, setAbout: (about: string) => void, project?: () => boolean,
 *           owner?: () => boolean, onResult: (result: { agents? }) => void }} options
 */
export function createPeople({ root, invite, panel, me, getName, getId = () => null, setName, getAbout, setAbout, project = () => false, owner = () => true, onResult }) {
  let statuses = []; // the buddies the doc reaches, who they are and which are at work (the doc host)
  let writers = []; // the people who commented: [{ id, name }]
  let team = null; // the project's team, for its owner (api.team)
  let showing = null; // 'me' | 'team' | 'agent:<name>' | 'person:<name>' | null
  // One card for everyone, in two states: view only, opened by hovering a
  // name on the page, or editable, opened by a click (or a click on the card
  // itself) or by hovering a face in the header.
  let viewOnly = false;
  let hovered = false; // opened by hovering: goes when the pointer leaves, until a click or a field keeps it
  let anchor = null; // the name on the page the card opened next to; null: under the header
  let editing = false; // whether the shown card's name is being edited in place

  invite.addEventListener('click', () => toggle('team'));
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
    editing = false;
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
    editing = false;
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
    const agent = agentsHere().find((n) => same(n, name));
    if (agent || kind === 'agent') return `agent:${agent ?? name}`;
    return `person:${memberNamed(name)?.name ?? writers.find((p) => same(p.name, name))?.name ?? name}`;
  }

  // Only another person's card has nothing to change, but for the owner a teammate's.
  const editable = () => Boolean(showing) && (!showing.startsWith('person:') || Boolean(memberNamed(showing.slice(7))));
  const memberNamed = (name) => team?.members.find((m) => same(m.name, name)) ?? null;

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
  const idOf = (name) => statusOf(name)?.id ?? name; // a buddy's face and color come from its id
  const introOf = (name) => {
    const status = statusOf(name);
    return status ? tagline(status) : '';
  };

  // The buddies the doc reaches.
  const agentsHere = () => statuses.map((s) => s.name);

  // ---- the avatars in the header ----

  // When each buddy's last run failed, so its face plays that out even if the
  // header is redrawn meanwhile (its status changes as the run ends).
  const failedAt = new Map();
  let painted = '';

  // Redrawn only when a face would change, so one being pointed at keeps
  // growing and one at work keeps moving through the doc's other updates.
  function paintFaces() {
    const names = agentsHere();
    const flinching = (id) => failedAt.get(id) > Date.now() - FAILED_MS;
    const faces = names.map((name) => ({ id: idOf(name), name, mode: modeOf(statusOf(name)), failed: flinching(idOf(name)) }));
    const key = JSON.stringify(faces);
    if (key !== painted) {
      painted = key;
      root.replaceChildren(...faces.map(({ id, name, mode, failed }) => {
        const wrap = el('span', 'od-agent');
        wrap.dataset.presence = mode;
        const face = el('button', 'od-agent-face');
        face.type = 'button';
        face.dataset.agent = name;
        face.setAttribute('aria-label', `${name}${LABELS[mode] ? ` · ${LABELS[mode]}` : ''}`);
        face.append(avatar(name, 'agent', false, id));
        if (failed) face.firstChild.classList.add('od-failed');
        namecardFor(face, name, 'agent', 'instant'); // its name card on hover, its full card on a click
        wrap.append(face);
        return wrap;
      }));
    }
    // A renamed agent's card stays open while the doc catches up with the new name.
    if (agentShown() && !names.some((n) => same(n, agentShown())) && !editing) close();
  }

  // ---- the cards ----

  function paintCard() {
    panel.dataset.card = showing?.split(':')[0] ?? '';
    panel.dataset.state = viewOnly ? 'view' : 'edit';
    panel.toggleAttribute('data-editable', editable());
    if (showing === 'me') panel.replaceChildren(...meCard());
    else if (showing === 'team') panel.replaceChildren(...teamCard());
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

  // Yours works as an agent's does: a click on your name edits it in place.
  function meCard() {
    if (viewOnly) return [personHead(getName(), 'You')];
    const head = el('div', 'od-profile');
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(getName(), 'human'));
    const who = el('div', 'od-profile-who');
    who.append(inPlace({ me: true, name: getName() }, 'Your name, as others @mention you'), el('div', 'od-profile-sub', 'You'));
    head.append(pic, who);
    const about = el('textarea', 'od-input od-profile-about');
    about.value = getAbout();
    about.placeholder = 'Who you are, what you write, how you like to work. Every buddy that answers you reads it.';
    about.spellcheck = true;
    about.setAttribute('aria-label', 'Who you are');
    about.addEventListener('change', () => setAbout(about.value));
    return [head, about];
  }

  // A teammate's card has, for the owner, Read or Edit and Remove.
  function personCard(name) {
    const teammate = memberNamed(name);
    if (!teammate) return [personHead(name, 'Commented on this doc')];
    if (viewOnly) return [personHead(name, LEVEL[teammate.level])];
    const level = el('div', 'od-teammate-row');
    level.append(levelChoice(teammate.level, (next) => changeTeam(() => api.setLevel(teammate.id, next))));
    const remove = el('button', 'od-secondary od-danger', 'Remove from this project');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Remove ${teammate.name} from this project?\n\nTheir pages close at once. Their comments stay.`)) return;
      await changeTeam(() => api.remove(teammate.id));
      toggle('team');
    });
    const removeRow = el('div', 'od-teammate-row');
    removeRow.append(remove);
    return [personHead(name, 'Teammate'), level, removeRow];
  }

  // Read or Edit, Edit to start: `pick(level)` hears a change.
  function levelChoice(level, pick) {
    const choice = el('div', 'od-segmented');
    choice.setAttribute('role', 'radiogroup');
    choice.setAttribute('aria-label', 'Access');
    for (const [value, label] of [['read', 'Read'], ['write', 'Edit']]) {
      const option = el('button', null, label);
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(value === level));
      option.addEventListener('click', () => {
        for (const other of choice.children) other.setAttribute('aria-checked', String(other === option));
        pick(value);
      });
      choice.append(option);
    }
    return choice;
  }

  // A change to the team, as `request()` asks it: the panel shows the team it answers with, or what went wrong.
  async function changeTeam(request) {
    try {
      team = await request();
      paintCard();
    } catch (failure) {
      const error = el('div', 'od-input-error', failure.message);
      panel.querySelector('.od-input-error')?.remove();
      panel.querySelector('.od-card-head, .od-profile')?.after(error);
    }
  }

  // You, then in a project your teammates, a request to join at the top,
  // then every buddy here, one line each: a click opens a card, and a
  // project's buddy is deleted from here. Then, in a project, a line to name
  // a new buddy: Enter makes it and opens its card. Only the owner sees the
  // teammates and changes anything.
  function teamCard() {
    const head = el('div', 'od-card-head');
    head.append(el('div', 'od-card-title', 'Team'));
    if (team) head.append(inviteButtons());
    const list = el('div', 'od-people-list');
    list.append(meRow());
    if (team) {
      list.append(el('div', 'od-setting-group', 'Teammates'), ...team.pending.map(pendingRow), ...team.members.map(memberRow));
      if (team.pending.length + team.members.length === 0) list.append(el('div', 'od-people-none', 'No one yet: send them the invite link.'));
    }
    list.append(el('div', 'od-setting-group', 'AI buddies'), ...statuses.map(buddyRow));
    return project() && owner() ? [head, list, ...newBuddyRow()] : [head, list]; // buddies other than Clippy are a project's
  }

  // Invite link copies the project's one link, made the first time; New link ends every old one.
  function inviteButtons() {
    const buttons = el('div', 'od-people-invite');
    const copy = el('button', 'od-secondary', 'Invite link');
    copy.type = 'button';
    copy.prepend(icon('link'));
    copy.addEventListener('click', async () => {
      if (!team.link) await changeTeam(() => api.link());
      if (!team.link) return;
      await navigator.clipboard.writeText(team.link);
      const copied = panel.querySelector('.od-people-invite .od-secondary');
      if (copied) copied.lastChild.textContent = 'Copied';
    });
    buttons.append(copy);
    if (team.link) {
      const renew = el('button', 'od-secondary', 'New link');
      renew.type = 'button';
      renew.addEventListener('click', () => {
        if (window.confirm('Make a new invite link?\n\nEvery old link stops working, and pages open on it close. Teammates on the project stay, and join again from the new link.')) changeTeam(() => api.link());
      });
      buttons.append(renew);
    }
    return buttons;
  }

  function meRow() {
    const row = el('div', 'od-people-row');
    const open = el('button', 'od-people-open');
    open.type = 'button';
    open.append(avatar(getName(), 'human', true), el('span', 'od-people-name', getName()), el('span', 'od-people-role', 'You'));
    open.addEventListener('click', () => toggle('me'));
    row.append(open);
    return row;
  }

  // Someone asking to join: Read or Edit (Edit to start), and Allow or Deny.
  function pendingRow({ id, name }) {
    const wrap = el('div', 'od-people-pending');
    const row = el('div', 'od-people-row');
    row.append(avatar(name, 'human', true), el('span', 'od-people-name', name), el('span', 'od-people-role', 'Asks to join'));
    let level = 'write';
    const actions = el('div', 'od-people-actions');
    const deny = el('button', 'od-secondary', 'Deny');
    deny.type = 'button';
    deny.addEventListener('click', () => changeTeam(() => api.remove(id)));
    const allow = el('button', 'od-primary', 'Allow');
    allow.type = 'button';
    allow.addEventListener('click', () => changeTeam(() => api.allow(id, level)));
    actions.append(levelChoice(level, (next) => { level = next; }), el('span', 'od-spacer'), deny, allow);
    wrap.append(row, actions);
    return wrap;
  }

  function memberRow(member) {
    const row = el('div', 'od-people-row');
    const open = el('button', 'od-people-open');
    open.type = 'button';
    open.append(avatar(member.name, 'human', true), el('span', 'od-people-name', member.name), el('span', 'od-people-role', LEVEL[member.level]));
    open.addEventListener('click', () => toggle(`person:${member.name}`));
    row.append(open);
    return row;
  }

  function buddyRow(status) {
    const row = el('div', 'od-people-row');
    const open = el('button', 'od-people-open');
    open.type = 'button';
    open.append(avatar(status.name, 'agent', true, status.id), el('span', 'od-people-name', status.name), el('span', 'od-people-role', tagline(status) || WHERE[status.where]));
    open.addEventListener('click', () => toggle(`agent:${status.name}`));
    row.append(open);
    if (status.where === 'project' && owner()) {
      const remove = el('button', 'od-icon-btn od-people-delete');
      remove.type = 'button';
      remove.dataset.tip = `Delete ${status.name}`;
      remove.setAttribute('aria-label', `Delete ${status.name}`);
      remove.append(icon('trash'));
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Delete ${status.name}?\n\nIts file is deleted and it stops answering. Its comments stay.`)) return;
        take(await api.deleteBuddy(status.id).catch(() => ({}))); // gone already: nothing to do
      });
      row.append(remove);
    }
    return row;
  }

  function newBuddyRow() {
    const row = el('label', 'od-people-row od-people-new');
    const plus = el('span', 'od-people-new-face');
    plus.append(icon('plus'));
    const field = el('input', 'od-people-new-name');
    field.type = 'text';
    field.placeholder = 'New buddy';
    field.value = defaultName([...agentsHere(), getName(), ...writers.map((p) => p.name), ...(team ? [...team.members, ...team.pending].map((p) => p.name) : [])]);
    field.maxLength = 64;
    field.spellcheck = false;
    field.setAttribute('aria-label', "New buddy's name");
    const error = el('div', 'od-input-error');
    error.hidden = true;
    const failed = (message) => {
      error.textContent = message;
      error.hidden = false;
      field.setAttribute('aria-invalid', 'true');
    };
    field.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = field.value.trim();
      if (!NAME_PATTERN.test(name)) return failed(NAME_RULE);
      try {
        take(await api.createBuddy({ name }));
        toggle(`agent:${name}`);
        panel.querySelector('.od-profile-about')?.focus();
      } catch (failure) {
        failed(failure.message);
      }
    });
    row.append(plus, field);
    return [row, error];
  }

  // A buddy's card: who it is. A name in the doc that is no buddy here says
  // it does not answer here.
  function agentCard(name) {
    const status = statusOf(name);
    const parts = [cardHead(name)];
    if (status && !viewOnly) parts.push(aboutField(status));
    if (!status) {
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', `None of your buddies is called ${name}, so it does not answer here.`));
      parts.push(problem);
    }
    return parts;
  }

  // The top of a buddy's card: its face, name, who it is, and edit.
  function cardHead(name) {
    const status = statusOf(name);
    const head = el('div', 'od-profile');
    head.dataset.presence = modeOf(status);
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(name, 'agent', false, idOf(name)));
    const who = el('div', 'od-profile-who');
    // Click the name to edit it right there.
    who.append(status && !viewOnly && status.where !== 'app' ? inPlace(status, 'Name') : el('div', 'od-profile-name', name));
    if (viewOnly && introOf(name)) who.append(el('div', 'od-profile-slogan', introOf(name)));
    who.append(el('div', 'od-profile-sub od-profile-standing', status ? (STANDING[modeOf(status)] ?? WHERE[status.where]) : 'Not in this doc'));
    head.append(pic, who);
    return head;
  }

  // Who `agent` is, all of it, to change right there: saved when the field
  // is left. Clippy's, cleared, is Clippy as it ships.
  function aboutField(agent) {
    const field = el('textarea', 'od-input od-profile-about');
    field.value = agent.about;
    field.placeholder = 'Who it is, what to do, what to leave alone, how to reply. The first line shows next to its name.';
    field.spellcheck = true;
    field.setAttribute('aria-label', `Who ${agent.name} is`);
    field.addEventListener('change', async () => {
      try {
        take(await api.updateBuddy(agent.id, { about: field.value }));
      } catch (failure) {
        field.setAttribute('aria-invalid', 'true');
        field.title = failure.message;
      }
    });
    return field;
  }

  // `agent`'s name as text that turns into a field when clicked. Enter or
  // leaving the field saves it, Escape puts it back.
  function inPlace(agent, placeholder) {
    if (!editing) {
      const text = el('div', 'od-profile-name od-editable', agent.name);
      text.tabIndex = 0;
      text.setAttribute('role', 'button');
      text.setAttribute('aria-label', `Rename ${agent.name}`);
      const start = () => {
        editing = true;
        paintCard();
        const field = panel.querySelector('.od-inline-input');
        field?.focus();
        field?.select();
      };
      text.addEventListener('click', start);
      text.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(); } });
      return text;
    }
    const field = el('input', 'od-profile-name od-inline-input');
    field.type = 'text';
    field.value = agent.name;
    field.placeholder = placeholder;
    field.maxLength = 64;
    field.spellcheck = false;
    field.setAttribute('aria-label', 'Name');
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) commit(agent, field);
      else {
        editing = false;
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

  async function commit(agent, field) {
    const value = field.value.trim();
    if (agent.me) return commitMyName(field, value);
    if (value === agent.name) return settle();
    if (!NAME_PATTERN.test(value)) return fail(field, NAME_RULE);
    try {
      const result = await api.updateBuddy(agent.id, { name: value });
      if (showing === `agent:${agent.name}`) showing = `agent:${value}`;
      take(result);
      settle();
    } catch (failure) {
      fail(field, failure.message);
    }
  }

  function commitMyName(field, value) {
    if (value === getName()) return settle();
    if (!NAME_PATTERN.test(value)) return fail(field, NAME_RULE);
    if (agentsHere().some((n) => same(n, value))) return fail(field, `${value} is a buddy here`);
    settle();
    setName(value);
  }

  // The field is done: back to text.
  function settle() {
    editing = false;
    paintCard();
  }

  // Keep the field open, with what went wrong under the card's top.
  function fail(field, message) {
    editing = true;
    paintCard();
    const again = panel.querySelector('.od-inline-input');
    if (!again) return;
    again.value = field.value;
    again.setAttribute('aria-invalid', 'true');
    const error = el('div', 'od-input-error', message);
    panel.querySelector('.od-profile')?.after(error);
    again.focus();
  }

  const take = (result) => onResult(result);

  /** Any of: `agents` (the buddies here, with their statuses), `people` (who commented), `team` (the project's, for its owner). */
  function render({ agents, people: nextWriters, team: nextTeam }) {
    if (agents) statuses = agents;
    if (nextWriters) writers = nextWriters;
    if (nextTeam) team = nextTeam;
    paintFaces();
    // Not while a field on the card is being typed in.
    if (showing && showing !== 'me' && !panel.querySelector('input:focus, textarea:focus')) paintCard();
  }

  // ---- @names in the text ----

  /** Everyone an @name can mean here: [{ id, name, kind }], agents first. */
  function mentionable() {
    const found = [];
    const add = (name, kind, id = name) => {
      if (!found.some((p) => same(p.name, name))) found.push({ id, name, kind });
    };
    for (const name of agentsHere()) add(name, 'agent', idOf(name));
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
   * or by the first line of who they are for two letters or more), and the people who
   * commented.
   */
  function mentionChoices(query) {
    const q = query.toLowerCase();
    const matches = (name, intro = '') => name.toLowerCase().startsWith(q) || (q.length >= 2 && intro.toLowerCase().includes(q));
    const here = agentsHere();
    const inDoc = here.filter((n) => matches(n, introOf(n))).map((name) => ({ id: idOf(name), name, kind: 'agent', group: 'Buddies', tagline: introOf(name) }));
    const people = writers.filter((p) => !isMe(p) && matches(p.name))
      .map((p) => ({ id: p.id, name: p.name, kind: 'human', group: 'People' }));
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
    /** An agent whose run is in progress, if any. */
    running: () => statuses.find((s) => s.state === 'running') ?? null,
    /** Buddy `id`'s run failed: its face shakes and flashes red, once. */
    failed(id) {
      failedAt.set(id, Date.now());
      paintFaces();
    },
    /** Your name changed: repaint your card if it is open. */
    renameMe() {
      if (showing === 'me' || showing === 'team') paintCard();
    },
    /** Open the Team panel, where a request to join waits. */
    showTeam() {
      if (showing !== 'team') toggle('team');
    },
  };
}

const FAILED_MS = 1000; // how long a failed run's moment plays (app.css: .od-failed)

// Where a buddy stands in this doc, on its card under its name.
const STANDING = { working: 'Working…', away: 'Not running here' };
const WHERE = { app: 'In all your docs', project: "This project's" };

const LABELS = { working: 'Working…', away: 'Not here' };

// What a teammate may do, under their name.
const LEVEL = { read: 'Can read', write: 'Can edit' };

/** 'working', 'idle' (answers when @mentioned), or 'away' (no status: not run here). */
export function modeOf(status) {
  if (!status) return 'away';
  return status.state === 'running' ? 'working' : 'idle';
}

// A small icon-only button, labelled for screen readers and on hover.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
