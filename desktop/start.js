// The start window: New doc, Open, your crew, and the recent docs. Bundled
// into dist/web/start.js (scripts/build.js) so the crew wears the same faces
// as in the editor.

import { agentFace } from '../web/faces.js';
import { icon } from '../web/icons.js';

const desktop = window.opendocDesktop;
const list = document.querySelector('ul');
const empty = document.querySelector('.empty');
const crewList = document.querySelector('.crew-list');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

document.querySelector('[data-action="new"]').addEventListener('click', () => desktop.newDoc().catch(() => {}));
document.querySelector('[data-action="open"]').addEventListener('click', () => desktop.open().catch(() => {}));

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---- recent docs ----

async function showRecent() {
  const recent = await desktop.recent();
  list.replaceChildren(...recent.map(({ name, folder }, index) => {
    const button = el('button');
    button.type = 'button';
    button.title = folder;
    // rtl keeps the end of a long path visible; the marks keep it readable
    button.append(icon('file'), el('span', 'name', name), el('span', 'folder', `‎${folder}‎`));
    button.addEventListener('click', () => desktop.openRecent(index).catch(() => {}));
    const item = el('li');
    item.append(button);
    return item;
  }));
  empty.hidden = recent.length > 0;
}

desktop.onRecentChanged(showRecent);
showRecent();

// ---- the crew: who every doc starts with ----
// Your starred agents as faces: in colour when in the crew, greyed out when
// not; a click takes one in or out. The + adds a new agent by name.

let adding = false;

function showCrew(agents) {
  const members = agents.map((agent) => {
    const button = el('button', 'member');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(agent.crew));
    button.title = `${agent.name}${agent.persona ? `: ${agent.persona}` : ''}\n${agent.crew ? 'In your crew. Click to take it out.' : 'Click to add it to your crew.'}`;
    const face = el('span', 'face');
    face.append(agentFace(agent.name));
    button.append(face, el('span', 'member-name', agent.name));
    button.addEventListener('click', () => desktop.setCrew(agent.id, !agent.crew).then(showCrew, () => {}));
    return button;
  });
  crewList.replaceChildren(...members, adding ? newMember() : addButton());
}

function addButton() {
  const button = el('button', 'member');
  button.type = 'button';
  button.title = 'New agent for your crew';
  const face = el('span', 'add-face');
  face.append(icon('plus'));
  button.append(face, el('span', 'member-name', 'New'));
  button.addEventListener('click', () => {
    adding = true;
    refreshCrew().then(() => crewList.querySelector('input')?.focus());
  });
  return button;
}

// The + turns into a name field: Enter adds the agent, Escape or leaving it cancels.
function newMember() {
  const box = el('div', 'member');
  const face = el('span', 'add-face');
  face.append(icon('plus'));
  const input = el('input');
  input.type = 'text';
  input.maxLength = 64;
  input.spellcheck = false;
  input.placeholder = 'Name';
  input.setAttribute('aria-label', "New agent's name");
  let done = false;
  const stop = () => {
    done = true;
    adding = false;
    refreshCrew();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return stop();
    if (event.key !== 'Enter') return;
    const name = input.value.trim();
    if (!NAME.test(name)) return input.setAttribute('aria-invalid', 'true');
    done = true;
    adding = false;
    desktop.addCrewAgent(name).then(showCrew, () => refreshCrew());
  });
  input.addEventListener('blur', () => { if (!done) stop(); });
  box.append(face, input);
  return box;
}

const refreshCrew = () => desktop.crew().then(showCrew).catch(() => {});
desktop.onCrewChanged(refreshCrew);
refreshCrew();
