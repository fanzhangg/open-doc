// A stand-in for the doc host (src/host/doc-service.js) so the doc window
// opens in a plain browser (preview/build.js): a sample doc, or with
// `?folder` a sample project and the app's side of its sidebar
// (window.ponjoDesktop), read with the same src/core as the app. Kept in
// sessionStorage, so switching docs (`?folder&doc=<path>`, a new page as
// in the app) and reloading keep it; a new tab starts over.
// Buddies don't run: one asked answers with a set reply after a moment.
// No history, no undo, no menus. A project's team is a sample: Noor can
// edit, Sam asks to join, and no link is made.

import { createAnchor, locate } from '../src/core/anchor.js';
import { apply } from '../src/core/ot.js';
import { askedOf, newComment, newId, peopleOf, threadsOf } from '../src/core/comments.js';
import { buddiesHere, checkBuddyPatch } from '../src/core/buddies.js';
import { sameName } from '../src/core/mentions.js';
import { DEFAULT_SETTINGS, agentOf, checkSettingsPatch, mergeSettings } from '../src/core/settings.js';
import claude from '../agents/claude.json' with { type: 'json' };
import codex from '../agents/codex.json' with { type: 'json' };
import ponjo from '../agents/ponjo.json' with { type: 'json' };

const params = new URLSearchParams(location.search);
const inFolder = params.has('folder');
const KEY = `ponjo.preview.${inFolder ? 'folder' : 'doc'}`;

const WELCOME = `# Welcome to Ponjo

This is a preview of the editor in a browser. Edit anything: changes stay in this tab.

## Comments

Select some text and press the comment button to start a thread. Mention @Clippy to ask it; here it answers with a set reply, since buddies only run in the desktop app.

## What is not here

Opening files and folders, version history and undoing a buddy's edit need the desktop app.
`;

const PROJECT = {
  'README.md': `# Sample Project

A folder opened as a project: its files in the sidebar, and its own buddies, Editor and Researcher, next to yours, Clippy.

Open a doc from the sidebar, rename one (F2), delete one (Delete) or drag it into another folder. New files come from the right-click menu, which is the desktop app's own, so not here.
`,
  'notes/plan.md': `# Plan

1. Draft the launch post.
2. Check the numbers in the budget.
3. Share the draft for comments.
`,
  'notes/meeting.md': `# Meeting notes

We agreed to ship the preview first and ask for feedback before the next step.
`,
  'drafts/launch-post.md': `# Introducing Ponjo

Write plain Markdown with people and AI buddies, in comments next to the text.
`,
  'data/budget.csv': 'item,cost\ndesign,1200\nhosting,40\n',
};

// The sample threads: a comment by you on `quote`, and a buddy's answer.
const THREADS = inFolder
  ? [
    { doc: 'README.md', quote: 'its own buddies', ask: '@Editor is this clear enough?', by: 'Editor', answer: 'Yes. Maybe say what a buddy is in one line.' },
    { doc: 'notes/plan.md', quote: 'Check the numbers', ask: '@Researcher which numbers?', by: 'Researcher', answer: 'The hosting cost in data/budget.csv looks low.' },
  ]
  : [{ doc: 'Welcome.md', quote: 'a preview of the editor', ask: '@Clippy what can I try here?', by: 'Clippy', answer: 'Edit the text, start a thread on any selection, reply, resolve. Settings work too.' }];

const AGENTS = Object.entries({ claude, codex, ponjo }).map(([id, manifest]) => agentOf(id, manifest));
const ai = (name) => ({ id: name, name, kind: 'ai' });
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function seed() {
  const settings = { ...DEFAULT_SETTINGS, id: 'u_preview', name: 'you' };
  const me = { id: settings.id, name: settings.name, kind: 'human' };
  const files = inFolder ? { ...PROJECT } : { 'Welcome.md': WELCOME };
  const comments = {};
  for (const t of THREADS) {
    const text = files[t.doc];
    const start = text.indexOf(t.quote);
    const id = newId('c');
    (comments[t.doc] ??= []).push(
      { id, anchor: createAnchor(text, start, start + t.quote.length), by: me, at: ago(30), body: t.ask },
      { id: newId('c'), thread: id, by: ai(t.by), at: ago(29), body: t.answer },
    );
  }
  return {
    settings, files, comments,
    mine: [{ id: 'Clippy', name: 'Clippy', about: 'A general writing assistant that helps draft and edit docs' }],
    buddies: inFolder ? [{ id: 'Editor', name: 'Editor', about: 'Tightens prose and keeps the tone even' }, { id: 'Researcher', name: 'Researcher', about: 'Finds sources and checks the facts' }] : [],
    expanded: ['notes'], sidebar: true, carry: null,
    team: { members: [{ id: 'p_noor', name: 'Noor', level: 'write' }], pending: [{ id: 'p_sam', name: 'Sam' }], link: null },
  };
}

let s;
try {
  s = JSON.parse(sessionStorage.getItem(KEY)) ?? seed();
} catch {
  s = seed();
}
function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: kept until the page goes
  }
}
save();

const DOC = /\.(md|markdown)$/i;
const docs = () => Object.keys(s.files).filter((path) => DOC.test(path)).sort();
let current = s.files[params.get('doc')] !== undefined && DOC.test(params.get('doc')) ? params.get('doc') : docs()[0];
const name = (path) => path.split('/').pop();
const me = () => ({ id: s.settings.id, name: s.settings.name, kind: 'human' });
const comments = () => (s.comments[current] ??= []);
const buddies = () => buddiesHere(s.buddies, s.mine);

// The page is the only writer: every edit is on the latest rev of this page load.
const epoch = newId('e');
let rev = 0;

const running = new Map(); // buddy id → thread ids
const agents = () => buddies().map((b) => ({ ...b, state: running.has(b.id) ? 'running' : 'ready', threadIds: running.get(b.id) ?? [] }));

function view() {
  const text = s.files[current];
  const threads = threadsOf(comments(), buddies().map(({ id, name }) => ({ id, name }))).map((thread) => {
    if (!thread.anchor) return { ...thread, detached: false };
    const found = locate(text, thread.anchor);
    return { ...thread, anchor: found ? createAnchor(text, found.start, found.end) : thread.anchor, detached: !found };
  });
  return { threads, people: peopleOf(comments()), edits: {}, readOnly: null, notice: null };
}

let listener = null;
const emit = (event, data) => listener?.(event, data);

// The buddies this user's comments ask, as the runner would start them.
function answer() {
  for (const thread of threadsOf(comments(), buddies().map(({ id, name }) => ({ id, name })))) {
    for (const asked of askedOf(thread, [s.settings.id])) {
      if (running.get(asked)?.includes(thread.id)) continue;
      running.set(asked, [...(running.get(asked) ?? []), thread.id]);
      emit('agents', agents());
      setTimeout(() => {
        const left = running.get(asked).filter((id) => id !== thread.id);
        if (left.length) running.set(asked, left);
        else running.delete(asked);
        if (!threadsOf(comments()).find((t) => t.id === thread.id)?.resolved) {
          comments().push({ id: newId('c'), thread: thread.id, by: { id: asked, name: buddies().find((b) => b.id === asked)?.name ?? asked, kind: 'ai' }, at: new Date().toISOString(), body: 'This is a preview, so I can\'t read or edit the doc here. In the desktop app I would answer you now.' });
          save();
          emit('sidecar', {});
        }
        emit('agents', agents());
      }, 1500);
    }
  }
}

function add(comment) {
  comments().push(newComment(comment, { by: me(), at: new Date().toISOString() }));
  save();
  setTimeout(answer);
  return { ...view(), id: comments().at(-1).id };
}

const refuse = (message) => {
  throw Object.assign(new Error(message), { code: 'bad_input' });
};

function checkBuddy(fields, id = null) {
  checkBuddyPatch(fields);
  const taken = [...buddies().filter((b) => b.id !== id).map((b) => b.name), s.settings.name];
  if (fields.name !== undefined && taken.some((n) => sameName(fields.name, n))) refuse(`the name ${fields.name} is taken`);
}

function changeTeam(fn) {
  s.team = fn(s.team);
  save();
  return s.team;
}

function changedBuddies() {
  save();
  emit('agents', agents());
  return { agents: agents() };
}

const calls = {
  state: () => ({ doc: name(current), text: s.files[current], epoch, rev, ...view(), settings: s.settings, defaultName: 'you', me: me(), level: 'owner', agents: agents(), project: inFolder }),
  submit({ ops, rev: at, epoch: from, id }) {
    if (from !== epoch || at !== rev) throw Object.assign(new Error('the doc has moved on'), { code: 'stale' });
    s.files[current] = apply(s.files[current], ops);
    save();
    emit('ops', { epoch, rev: ++rev, ops, id });
    return { rev };
  },
  comment: ({ thread, anchor, body, resolved }) => add({ thread, anchor, body, resolved }),
  saveSettings(patch) {
    checkSettingsPatch(patch);
    s.settings = mergeSettings(s.settings, patch);
    save();
    emit('settings', s.settings);
    return { settings: s.settings };
  },
  scripts: () => ({ agents: AGENTS, shipped: ['claude', 'codex', 'ponjo'], folder: '(the desktop app\'s config folder)', secrets: {} }),
  resetScript: () => ({ agents: AGENTS }),
  createBuddy({ buddy }) {
    const fields = { about: '', ...buddy };
    checkBuddy(fields);
    if (!fields.name) refuse('a buddy needs a name');
    s[inFolder ? 'buddies' : 'mine'].push({ id: newId('b'), ...fields });
    return changedBuddies();
  },
  updateBuddy({ id, patch = {} }) {
    const found = buddies().find((b) => b.id === id) ?? refuse('no such buddy');
    checkBuddy(patch, id);
    const key = found.where === 'project' ? 'buddies' : 'mine';
    s[key] = s[key].map((b) => (b.id === id ? { ...b, ...patch } : b));
    return changedBuddies();
  },
  deleteBuddy({ id: gone }) {
    s.buddies = s.buddies.filter((b) => b.id !== gone);
    s.mine = s.mine.filter((b) => b.id !== gone);
    return changedBuddies();
  },
  team: () => s.team,
  allow: ({ id, level }) => changeTeam((t) => ({ ...t, pending: t.pending.filter((p) => p.id !== id), members: [...t.members, { ...t.pending.find((p) => p.id === id), level }] })),
  remove: ({ id }) => changeTeam((t) => ({ ...t, pending: t.pending.filter((p) => p.id !== id), members: t.members.filter((m) => m.id !== id) })),
  setLevel: ({ id, level }) => changeTeam((t) => ({ ...t, members: t.members.map((m) => (m.id === id ? { ...m, level } : m)) })),
  link: () => changeTeam((t) => ({ ...t, link: `${location.origin}${location.pathname.replace(/[^/]*$/, '')}team.html?room=${newId('r')}` })),
  history: () => ({ versions: [] }),
  since: () => ({ edits: [], authors: [], head: null }),
  seen: () => ({}),
  version: () => refuse('no history in the preview'),
  restoreVersion: () => refuse('no history in the preview'),
  undo: () => refuse('no undo in the preview'),
};

window.ponjoHost = {
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

// ---- the folder (desktop/main.js's side of the sidebar) ----

if (inFolder) {
  const inside = (path, base) => !base || path === base || path.startsWith(`${base}/`);
  const parents = (path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  const exists = (path) => s.files[path] !== undefined || Object.keys(s.files).some((file) => parents(file).includes(path));
  let onChanged = () => {};
  s.expanded = [...new Set([...s.expanded, ...parents(current)])]; // the open doc shows in the tree
  save();

  // Show doc `path` here: as in the app, a new page, told how this one left things.
  async function open(path) {
    s.carry = await window.ponjoLeave();
    save();
    location.search = `?folder&doc=${encodeURIComponent(path)}`;
  }

  function changed() {
    save();
    onChanged();
  }

  // The doc's ProjectService.
  calls.list = ({ path }) => {
    const names = new Map();
    for (const file of Object.keys(s.files).filter((f) => inside(f, path) && f !== path)) {
      const [first, ...rest] = (path ? file.slice(path.length + 1) : file).split('/');
      names.set(first, rest.length > 0 || names.get(first) === true);
    }
    return [...names].map(([n, folder]) => ({ name: n, folder }))
      .sort((a, b) => (b.folder - a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  };
  calls.read = ({ path }) => ({ text: s.files[path] ?? '' });

  window.ponjoDesktop = {
    folder() {
      const carry = s.carry;
      s.carry = null;
      save();
      return Promise.resolve({ name: 'Sample Project', current, expanded: s.expanded, sidebar: s.sidebar, carry });
    },
    openInFolder: (path) => open(path),
    folderRename(from, kind, to) {
      if (exists(to)) return Promise.resolve({ error: `${name(to)} is already here.` });
      const moved = (path) => to + path.slice(from.length);
      for (const map of [s.files, s.comments]) {
        for (const path of Object.keys(map).filter((p) => (kind === 'folder' ? inside(p, from) : p === from))) {
          map[moved(path)] = map[path];
          delete map[path];
        }
      }
      s.expanded = s.expanded.map((path) => (inside(path, from) ? moved(path) : path));
      if (kind === 'folder' ? inside(current, from) : current === from) {
        current = moved(current);
        history.replaceState(null, '', `?folder&doc=${encodeURIComponent(current)}`);
        emit('renamed', { doc: name(current) });
      }
      changed();
      return Promise.resolve({ rel: to });
    },
    async folderTrash(rel, kind) {
      if (!window.confirm(`Delete ${name(rel)}?`)) return { trashed: false };
      for (const map of [s.files, s.comments]) {
        for (const path of Object.keys(map).filter((p) => (kind === 'folder' ? inside(p, rel) : p === rel))) delete map[path];
      }
      changed();
      if (s.files[current] === undefined && docs().length > 0) await open(docs()[0]);
      return { trashed: true };
    },
    folderExpand(path, isOpen) {
      s.expanded = isOpen ? [...new Set([...s.expanded, path])] : s.expanded.filter((p) => p !== path);
      save();
      return Promise.resolve();
    },
    showSidebar(isOpen) {
      s.sidebar = isOpen;
      save();
      return Promise.resolve();
    },
    onFolderChanged: (fn) => {
      onChanged = fn;
    },
    // The app's menus (new file among them) and dialogs: none in a browser.
    folderMenu: () => Promise.resolve(),
    onFolderCommand: () => {},
    onCommand: () => {},
    openLink: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    revealSidecar: () => Promise.resolve(),
    showAgents: () => Promise.resolve(),
  };
}
