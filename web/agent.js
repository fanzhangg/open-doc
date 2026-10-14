// The agent as a collaborator in the header: an avatar whose ring shows what
// it is doing, a one-line status when there is something to say, and a small
// panel (click the avatar) with pause / resume / retry and the last run's log.

import { api } from './api.js';
import { avatar } from './threads.js';

const STATES = {
  starting: { line: 'Getting ready…', action: null },
  ready: { line: null, action: 'pause' },
  running: { line: null, action: 'pause' },
  paused: { line: 'Paused', action: 'resume' },
  error: { line: 'Could not finish the last comments', action: 'retry' },
  unavailable: { line: 'Unavailable', action: 'retry' },
  limited: { line: 'Taking a break (hourly run limit)', action: null },
};
const ACTION_TEXT = { pause: 'Pause', resume: 'Resume', retry: 'Try again' };

export function createAgentPresence(root, panel) {
  const face = root.querySelector('.od-agent-face');
  const line = root.querySelector('.od-agent-line');
  const title = panel.querySelector('.od-panel-title');
  const text = panel.querySelector('.od-panel-text');
  const actionButton = panel.querySelector('.od-panel-action');
  const log = panel.querySelector('.od-panel-log');
  let status = null;

  face.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await fillLog();
  });
  document.addEventListener('mousedown', (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !face.contains(event.target)) panel.hidden = true;
  });
  actionButton.addEventListener('click', async () => {
    const action = actionButton.dataset.action;
    if (!action) return;
    actionButton.disabled = true;
    try {
      render(await api.agentAction(action));
    } finally {
      actionButton.disabled = false;
    }
  });

  async function fillLog() {
    const { status: current, log: lines } = await api.agentDetails();
    const run = current.lastRun;
    const summary = run
      ? `Last run ${run.ok ? 'finished' : 'failed'} at ${new Date(run.endedAt).toLocaleTimeString()}`
        + `${run.error ? `: ${run.error}` : ''}${run.denials ? ` (${run.denials} tool calls denied)` : ''}`
      : current.error ?? 'No runs yet.';
    log.textContent = lines ? `${summary}\n\n${lines}` : summary;
  }

  function render(next) {
    status = next;
    if (!status) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const { line: stateLine, action } = STATES[status.state] ?? { line: status.state, action: null };
    root.dataset.state = status.state;
    face.replaceChildren(avatar(status.name, 'agent'));
    face.title = `${status.name} (AI) · ${status.state}`;

    const working = status.state === 'running'
      ? `Working on ${status.threads === 1 ? 'a comment' : `${status.threads} comments`}`
      : null;
    line.textContent = working ?? stateLine ?? '';
    line.hidden = !line.textContent;

    title.textContent = `${status.name} · AI co-author`;
    const mode = status.mentionsOnly
      ? `Replies to comments that mention @${status.name}.`
      : 'Reads every new comment, edits the doc and replies in the thread.';
    text.textContent = [working ?? stateLine, status.error, mode].filter(Boolean).join(' · ');
    actionButton.hidden = !action;
    actionButton.dataset.action = action ?? '';
    actionButton.textContent = action ? ACTION_TEXT[action] : '';
    if (!panel.hidden) fillLog();
  }

  return { render, status: () => status };
}
