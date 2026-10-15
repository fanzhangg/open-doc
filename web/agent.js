// The people in the header, as in a chat app: the agent's avatar with a
// presence dot, then yours. The agent is
//   online          it answers every comment not addressed to someone else
//   do not disturb  it answers only comments that @mention it (the user's choice)
//   offline         it cannot answer until someone fixes something
// Clicking an avatar opens a profile card: for the agent, its presence, the
// online / do-not-disturb switch, what is wrong when it is offline, and its
// last run; for you, your name.

import { api } from './api.js';
import { avatar } from './threads.js';

const OFFLINE = new Set(['error', 'unavailable', 'limited', 'stopped']);

/**
 * @param {{ root: HTMLElement, panel: HTMLElement, me: HTMLElement, getName: () => string,
 *           setPresence: (presence: 'online' | 'dnd') => void, openSettings: (section: string) => void }} options
 */
export function createAgentPresence({ root, panel, me, getName, setPresence, openSettings }) {
  const face = root.querySelector('.od-agent-face');
  const line = root.querySelector('.od-agent-line');
  let status = null;
  let showing = null; // 'agent' | 'me' | null
  let log = null; // the last run's log, fetched when the card opens

  face.addEventListener('click', () => toggle('agent'));
  me.addEventListener('click', () => toggle('me'));
  document.addEventListener('mousedown', (event) => {
    if (showing && !panel.contains(event.target) && !face.contains(event.target) && !me.contains(event.target)) close();
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
    if (which === 'agent') {
      try {
        log = (await api.agentDetails()).log;
      } catch {
        log = '';
      }
      if (showing === 'agent') paintCard();
    }
  }

  function close() {
    showing = null;
    panel.hidden = true;
  }

  // ---- the avatar in the header ----

  function render(next) {
    status = next;
    root.hidden = !status;
    if (!status) {
      if (showing === 'agent') close();
      return;
    }
    const mode = presenceOf(status);
    root.dataset.presence = mode;
    root.dataset.state = status.state;
    face.replaceChildren(avatar(status.name, 'agent'), el('span', 'od-presence-dot'));
    face.title = `${status.name} · ${LABELS[mode]}`;
    const working = status.state === 'running';
    line.textContent = working ? `Working on ${status.threads === 1 ? 'a comment' : `${status.threads} comments`}…` : '';
    line.hidden = !working;
    if (showing === 'agent') paintCard();
  }

  // ---- the profile cards ----

  function paintCard() {
    panel.dataset.card = showing ?? '';
    if (showing === 'me') return panel.replaceChildren(...meCard());
    if (showing === 'agent' && status) panel.replaceChildren(...agentCard());
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

  function agentCard() {
    const mode = presenceOf(status);
    const parts = [];

    const head = el('div', 'od-profile');
    head.dataset.presence = mode;
    const pic = el('span', 'od-profile-face');
    pic.append(avatar(status.name, 'agent'), el('span', 'od-presence-dot'));
    const who = el('div', 'od-profile-who');
    const name = el('div', 'od-profile-name', status.name);
    name.append(el('span', 'od-ai', 'AI'));
    const state = el('div', 'od-profile-state');
    state.append(el('span', 'od-presence-dot od-presence-dot-inline'), el('span', '', LABELS[mode]));
    who.append(name, state);
    head.append(pic, who);
    parts.push(head);

    if (mode === 'offline') {
      const problem = el('div', 'od-profile-problem');
      problem.append(el('div', 'od-profile-problem-text', offlineReason(status)));
      const actions = el('div', 'od-profile-actions');
      if (status.state !== 'limited') actions.append(button('Try again', 'od-primary', retry));
      actions.append(button('Agent settings', 'od-secondary', () => {
        close();
        openSettings('agent');
      }));
      problem.append(actions);
      parts.push(problem);
    } else if (status.state === 'running') {
      parts.push(el('div', 'od-profile-working', `Working on ${status.threads === 1 ? 'a comment' : `${status.threads} comments`}…`));
    }

    // The user's choice, also while offline (it applies once the agent is back).
    const choices = el('div', 'od-presence-choices');
    choices.setAttribute('role', 'radiogroup');
    choices.setAttribute('aria-label', 'Presence');
    for (const [value, title, hint] of [
      ['online', 'Online', 'Answers every comment, except ones for someone else'],
      ['dnd', 'Do not disturb', `Answers only comments that mention @${status.name}`],
    ]) {
      const choice = el('button', 'od-presence-choice');
      choice.type = 'button';
      choice.setAttribute('role', 'radio');
      choice.setAttribute('aria-checked', String(status.presence === value));
      choice.dataset.presence = value;
      const text = el('span', 'od-presence-choice-text');
      text.append(el('span', 'od-presence-choice-title', title), el('span', 'od-presence-choice-hint', hint));
      choice.append(el('span', 'od-presence-dot od-presence-dot-inline'), text);
      choice.addEventListener('click', () => {
        if (status.presence !== value) setPresence(value);
      });
      choices.append(choice);
    }
    parts.push(choices);

    const facts = el('div', 'od-profile-facts');
    facts.append(el('div', '', status.editMode === 'approve' ? 'Suggests edits for you to apply' : 'Edits the doc directly; you can undo'));
    const run = status.lastRun;
    if (run) {
      const bits = [`Last run ${run.ok ? 'finished' : 'failed'} ${new Date(run.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`];
      if (run.turns) bits.push(`${run.turns} turns`);
      if (run.costUsd) bits.push(`$${run.costUsd.toFixed(2)}`);
      if (run.denials) bits.push(`${run.denials} tool calls denied`);
      facts.append(el('div', '', bits.join(' · ')));
    }
    parts.push(facts);

    if (log) {
      const details = el('details', 'od-profile-log');
      details.append(el('summary', '', 'Run log'), el('pre', '', plain(log)));
      parts.push(details);
    }
    return parts;
  }

  async function retry() {
    try {
      render(await api.agentAction('retry'));
    } catch {
      // the next status event tells
    }
  }

  return {
    render,
    status: () => status,
    /** Your name changed: repaint your card if it is open. */
    renameMe() {
      if (showing === 'me') paintCard();
    },
  };
}

const LABELS = { online: 'Online', dnd: 'Do not disturb', offline: 'Offline', connecting: 'Connecting…' };

/** 'online', 'dnd', 'offline' (needs fixing) or 'connecting' (starting up). */
export function presenceOf(status) {
  if (status.state === 'starting') return 'connecting';
  if (OFFLINE.has(status.state)) return 'offline';
  return status.presence === 'dnd' ? 'dnd' : 'online';
}

// Why the agent is offline, in a sentence: the first line of its error.
function offlineReason(status) {
  if (status.state === 'limited') {
    const back = status.retryAt ? ` It is back at ${new Date(status.retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : '';
    return `It reached its limit of runs per hour.${back} You can raise the limit in Agent settings.`;
  }
  const error = plain(status.error ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (status.state === 'unavailable') return error ?? 'It could not start.';
  const sentence = (text) => (/[.!?。！？]$/.test(text) ? text : `${text}.`);
  if (status.state === 'error') return `The last run failed${error ? `: ${sentence(clip(error, 160))}` : '.'} Unfinished comments wait until you try again or reply.`;
  return 'It stopped.';
}

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
