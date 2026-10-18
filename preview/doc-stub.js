// A stand-in for the doc host (src/host/doc-service.js) so the doc window
// opens in a plain browser (preview/build.js): one sample doc and
// its comments, kept in memory, read with the same src/core as the app.
// Buddies don't run: one asked answers with a set reply after a moment.
// No history, no undo; a reload starts over.

import { createAnchor, findQuote, locate } from '../src/core/anchor.js';
import { askedOf, newId, peopleOf, threadsOf } from '../src/core/comments.js';
import { CLIPPY, buddiesHere } from '../src/core/buddies.js';
import { project } from '../src/core/project.js';
import { DEFAULT_SETTINGS, checkSettingsPatch, mergeSettings } from '../src/core/settings.js';

const DOC = 'Welcome.md';
let markdown = `# Welcome to OpenDoc

This is a preview of the editor in a browser. Edit anything: changes stay in this tab until you reload.

## Comments

Select some text and press the comment button to start a thread. Mention @Clippy to ask it; here it answers with a set reply, since buddies only run in the desktop app.

## What is not here

Opening files and folders, version history and undoing a buddy's edit need the desktop app.
`;

let settings = { ...DEFAULT_SETTINGS, id: 'u_preview', name: 'you' };
const me = () => ({ id: settings.id, name: settings.name, kind: 'human' });
const buddies = buddiesHere([]);
const ai = (name) => ({ id: name, name, kind: 'ai' });
const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function anchorOn(quote) {
  const text = project(markdown).text;
  const found = findQuote(text, quote);
  return createAnchor(text, found.start, found.end);
}

const first = 'c_preview1';
const comments = [
  { id: first, anchor: anchorOn('a preview of the editor'), by: me(), at: at(30), body: '@Clippy what can I try here?' },
  { id: 'c_preview2', thread: first, by: ai(CLIPPY.name), at: at(29), body: 'Edit the text, start a thread on any selection, reply, resolve. Settings work too.' },
];

// FNV-1a, standing in for the file's sha256: only equality matters here.
function hash(text) {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(16);
}

const running = new Map(); // buddy name → thread ids
const agents = () => buddies.map((b) => ({ ...b, state: running.has(b.name) ? 'running' : 'ready', threadIds: running.get(b.name) ?? [] }));

function view() {
  const text = project(markdown).text;
  const threads = threadsOf(comments, buddies.map((b) => b.name)).map((thread) => {
    if (!thread.anchor) return { ...thread, detached: false };
    const found = locate(text, thread.anchor);
    return { ...thread, anchor: found ? createAnchor(text, found.start, found.end) : thread.anchor, detached: !found };
  });
  return { threads, people: peopleOf(comments), edits: {}, readOnly: null, notice: null };
}

let listener = null;
const emit = (event, data) => listener?.(event, data);

// The buddies this user's comments ask, as the runner would start them.
function answer() {
  for (const thread of threadsOf(comments, buddies.map((b) => b.name))) {
    for (const name of askedOf(thread, settings.id)) {
      if (running.get(name)?.includes(thread.id)) continue;
      running.set(name, [...(running.get(name) ?? []), thread.id]);
      emit('agents', agents());
      setTimeout(() => {
        const left = running.get(name).filter((id) => id !== thread.id);
        if (left.length) running.set(name, left);
        else running.delete(name);
        if (!threadsOf(comments).find((t) => t.id === thread.id)?.resolved) {
          comments.push({ id: newId('c'), thread: thread.id, by: ai(name), at: new Date().toISOString(), body: 'This is a preview, so I can\'t read or edit the doc here. In the desktop app I would answer you now.' });
          emit('sidecar', {});
        }
        emit('agents', agents());
      }, 1500);
    }
  }
}

function add(comment) {
  comments.push({ id: newId('c'), by: me(), at: new Date().toISOString(), ...comment });
  setTimeout(answer);
  return { ...view(), id: comments.at(-1).id };
}

const refuse = (message) => {
  throw Object.assign(new Error(message), { code: 'bad_input' });
};

const calls = {
  state: () => ({ doc: DOC, markdown, docHash: hash(markdown), ...view(), settings, defaultName: 'you', me: me(), agents: agents(), project: false }),
  saveDoc({ markdown: next, baseHash }) {
    if (baseHash !== hash(markdown)) return { conflict: true, markdown, docHash: hash(markdown) };
    markdown = next;
    return { docHash: hash(markdown), markdown };
  },
  comment: ({ anchor, body }) => add({ anchor, body }),
  reply: ({ thread, body }) => add({ thread, body }),
  resolve: ({ thread }) => add({ thread, body: '', resolved: true }),
  reopen: ({ thread }) => add({ thread, body: '' }),
  saveSettings(patch) {
    checkSettingsPatch(patch);
    settings = mergeSettings(settings, patch);
    emit('settings', settings);
    return { settings };
  },
  scripts: () => ({ agents: ['claude', 'codex'], shipped: ['claude', 'codex'], folder: '(the desktop app\'s config folder)' }),
  resetScript: () => ({ agents: ['claude', 'codex'] }),
  createBuddy: () => refuse('buddies other than Clippy belong to a project'),
  updateBuddy: () => refuse('buddies can\'t be changed in the preview'),
  deleteBuddy: () => refuse('buddies can\'t be changed in the preview'),
  history: () => ({ versions: [] }),
  version: () => refuse('no history in the preview'),
  restoreVersion: () => refuse('no history in the preview'),
  undoReply: () => refuse('no undo in the preview'),
};

window.opendocHost = {
  async call(type, arg) {
    try {
      return { result: structuredClone(await calls[type](arg ?? {})) };
    } catch (error) {
      return { error: { message: error.message, code: error.code ?? 'bad_input' } };
    }
  },
  onEvent(fn) {
    listener = fn;
    fn('hello', { missing: false, agents: agents() });
  },
};
