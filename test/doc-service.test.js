// DocService (src/host/doc-service.js) on real files, called as a window
// calls it. Buddies run the fake agent script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyOp } from '../src/core/ops.js';
import { sidecarPath, update } from '../src/store/files.js';
import { SAMPLE, fakeConfig, fakeRuns, openTestDoc, tempDoc, until } from './helpers.js';

const human = { name: 'fzhan', kind: 'human' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withDoc(fn, { content = SAMPLE, settings = {}, sidecar = null } = {}) {
  const docPath = await tempDoc(content);
  if (sidecar) await writeFile(sidecarPath(docPath), JSON.stringify(sidecar));
  const settingsDir = await fakeConfig(settings);
  const opened = await openTestDoc(docPath, { settingsDir });
  try {
    await fn({ ...opened, docPath, settingsDir });
  } finally {
    await opened.doc.close();
  }
}

// Pilot is in the doc; `agents` come in when added or @mentioned.
const roster = (agents) => ({
  settings: { agents: [{ name: 'Pilot', persona: 'You answer everything.' }, ...agents].map((a, i) => ({ id: `a_test0${i}`, ...a })) },
  sidecar: { opendoc: 1, doc: 'plan.md', docHash: null, threads: [], participants: [{ name: 'Pilot', kind: 'agent' }] },
});

const comment = (call, id, body) => call('op', { op: { type: 'addThread', id, anchor: null, message: { id: `m_${id.slice(2)}`, author: human, body } } });
const authorsOf = (thread) => thread.messages.slice(1).map((m) => m.author.name);
const refused = (code) => (error) => error.code === code;

test('state returns the doc, its hash and the sidecar', async () => {
  await withDoc(async ({ state }) => {
    const now = await state();
    assert.equal(now.doc, 'plan.md');
    assert.equal(now.markdown, SAMPLE);
    assert.match(now.docHash, /^sha256:/);
    assert.deepEqual(now.sidecar.threads, []);
    assert.match(now.defaultName, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});

test('saves are conditional and byte-preserving', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const before = await state();
    const stale = await call('saveDoc', { markdown: 'x', baseHash: 'sha256:0' });
    assert.deepEqual([stale.conflict, stale.markdown], [true, SAMPLE]);

    // The editor reformats the link and joins the hard wrap, and edits one heading.
    const fromEditor = SAMPLE.replace('from the\nbeta cohort', 'from the beta cohort').replace('## Risks', '## Main risks');
    const saved = await call('saveDoc', { markdown: fromEditor, baseHash: before.docHash });
    assert.ok(!saved.conflict);
    const onDisk = await readFile(docPath, 'utf8');
    assert.equal(onDisk, SAMPLE.replace('## Risks', '## Main risks'));
    assert.notEqual(saved.docHash, before.docHash);
    assert.equal(saved.markdown, onDisk, 'the save says what is on disk now');
  });
});

test('CRLF docs stay CRLF', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    await call('saveDoc', { markdown: '# Title\n\nNew text.\n', baseHash: (await state()).docHash });
    assert.equal(await readFile(docPath, 'utf8'), '# Title\r\n\r\nNew text.\r\n');
  }, { content: '# Title\r\n\r\nOld text.\r\n' });
});

test('operations from a window: always the human, validated, persisted', async () => {
  await withDoc(async ({ call, state, docPath }) => {
    const anchor = { exact: 'extra load', prefix: 'service cannot handle the ', suffix: '.', start: 150 };
    const created = await call('op', { op: { type: 'addThread', id: 't_browser1', anchor, message: { id: 'm_browser1', author: { name: 'fzhan', kind: 'agent' }, body: '@claude?' } } });
    const thread = created.sidecar.threads[0];
    assert.equal(thread.messages[0].author.kind, 'human', 'the page cannot post as an agent');
    assert.equal(thread.anchor.exact, 'extra load');
    assert.equal(JSON.parse(await readFile(sidecarPath(docPath), 'utf8')).threads[0].id, 't_browser1');

    const bad = [
      { type: 'setWorking', threadId: 't_browser1', by: 'fzhan', since: new Date().toISOString() },
      { type: 'addMessage', threadId: 'nope', message: { id: 'm_xxxxxx', author: human, body: 'x' } },
      { type: 'addThread', id: 't_browser2', anchor: { exact: '' }, message: { id: 'm_xxxxxx', author: human, body: 'x' } },
      { type: 'addMessage', threadId: 't_missing', message: { id: 'm_xxxxxx', author: human, body: 'x' } },
    ];
    for (const op of bad) await assert.rejects(call('op', { op }), refused(op.threadId === 't_missing' ? 'unknown_thread' : 'bad_input'), op.type);

    // Resolve and reopen as the human, whatever name the page sends.
    const resolved = await call('op', { op: { type: 'resolve', threadId: 't_browser1', by: 'claude' } });
    const { settings, defaultName } = await state();
    assert.equal(resolved.sidecar.threads[0].resolvedBy, settings.name ?? defaultName);
    assert.equal((await call('op', { op: { type: 'reopen', threadId: 't_browser1' } })).sidecar.threads[0].status, 'open');
    await assert.rejects(call('nope'), refused('bad_input'));
  });
});

test('events: the sidecar and the doc changed on disk', { timeout: 15_000 }, async () => {
  await withDoc(async ({ events, docPath }) => {
    await update(docPath, (s) => applyOp(s, { type: 'addThread', id: 't_disk0001', anchor: null, message: { id: 'm_disk0001', author: human, body: 'note', createdAt: new Date().toISOString() } }));
    await until(() => events.some(([name]) => name === 'sidecar'), 'a sidecar event');
    await writeFile(docPath, SAMPLE.replace('Q4 Launch Plan', 'Q4 Plan'));
    await until(() => events.some(([name]) => name === 'doc'), 'a doc event');
  });
});

test('a doc renamed while open is found at its new path', async () => {
  await withDoc(async ({ doc, call, state, docPath }) => {
    const before = await state();
    await comment(call, 't_rename1', 'keep me');
    const newPath = join(dirname(docPath), 'launch.md');
    // A save sent while the rename runs waits for it, then lands in the new file.
    const [moved, saved] = await Promise.all([
      doc.moveTo(newPath),
      call('saveDoc', { markdown: SAMPLE.replace('Q4', 'Q1'), baseHash: before.docHash }),
    ]);
    assert.equal(moved, newPath);
    assert.equal(doc.docPath(), newPath);
    assert.ok(!saved.conflict);
    assert.deepEqual((await readdir(dirname(docPath))).sort(), ['launch.md', 'launch.md.opendoc.json']);
    assert.match(await readFile(newPath, 'utf8'), /Q1 Launch Plan/);
    const after = await state();
    assert.equal(after.doc, 'launch.md');
    assert.equal(after.sidecar.threads[0].messages[0].body, 'keep me');
    await assert.rejects(doc.moveTo(newPath), /already exists/);
  });
});

test('settings: saved for every window; a bad patch is refused; another window\'s change arrives as an event', { timeout: 15_000 }, async () => {
  await withDoc(async ({ call, events, settingsDir }) => {
    const saved = await call('saveSettings', { font: 'serif' });
    assert.equal(saved.settings.font, 'serif');
    assert.equal(JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8')).font, 'serif');
    for (const patch of [{ font: 'comic' }, { colour: 'red' }, { id: 'u_someone' }, { agents: [] }]) {
      await assert.rejects(call('saveSettings', patch), refused('bad_input'), JSON.stringify(patch));
    }
    const other = await openTestDoc(await tempDoc(), { settingsDir });
    try {
      await other.call('saveSettings', { theme: 'light' });
      await until(() => events.some(([name, data]) => name === 'settings' && data.theme === 'light'), 'the settings event');
    } finally {
      await other.doc.close();
    }
  });
});

test('a doc deleted while open: missing event, saves refused, recreate writes it back', { timeout: 15_000 }, async () => {
  await withDoc(async ({ doc, call, state, events, docPath }) => {
    const before = await state();
    const last = (name) => events.filter(([n]) => n === name).at(-1)?.[1];
    await pause(200);
    await rm(docPath);
    await until(() => last('missing')?.missing === true, 'the missing event');
    assert.equal(last('missing').doc, 'plan.md');
    assert.equal(doc.hello().missing, true, 'a window that connects now hears it too');
    await assert.rejects(call('saveDoc', { markdown: '# Back\n', baseHash: before.docHash }), refused('no_doc'));
    await call('saveDoc', { markdown: '# Back\n', baseHash: before.docHash, recreate: true });
    assert.equal(await readFile(docPath, 'utf8'), '# Back\n');
    await until(() => last('missing')?.missing === false, 'the doc back');
    // Recreate on a doc that is there is an ordinary conditional save.
    assert.equal((await call('saveDoc', { markdown: 'x', baseHash: 'sha256:0', recreate: true })).conflict, true);
  });
});

test('an @name typed in the doc text is plain text: it asks no one', { timeout: 15_000 }, async () => {
  const { settings, sidecar } = roster([]);
  await withDoc(async ({ call, state, settingsDir }) => {
    await call('saveDoc', { markdown: `${SAMPLE}\nShip it. @Pilot add the risks here.\n`, baseHash: (await state()).docHash });
    await pause(1500);
    assert.deepEqual((await state()).sidecar.threads, []);
    assert.deepEqual(await fakeRuns(settingsDir), []);
  }, { settings, sidecar });
});

test('several docs open at once: each saves, comments and runs its buddies', { timeout: 30_000 }, async () => {
  const settingsDir = await fakeConfig(roster([]).settings);
  const opened = await Promise.all([0, 1, 2].map(async () => openTestDoc(await tempDoc(), { settingsDir })));
  try {
    await Promise.all(opened.map(async ({ call, state }, i) => {
      await call('saveDoc', { markdown: SAMPLE.replace('Q4', `Q${i}`), baseHash: (await state()).docHash });
      await comment(call, `t_many000${i}`, `@Pilot replace "extra load" with "load ${i}"`);
    }));
    for (const [i, { state, doc }] of opened.entries()) {
      await until(async () => (await state()).sidecar.threads[0].messages.length === 2, `doc ${i}'s reply`);
      const text = await readFile(doc.docPath(), 'utf8');
      assert.match(text, new RegExp(`# Q${i} Launch Plan`));
      assert.match(text, new RegExp(`load ${i}\\.`));
    }
  } finally {
    await Promise.all(opened.map(({ doc }) => doc.close()));
  }
});

test('the doc\'s agents answer only their @mentions, which bring them in; they can be renamed, removed and added back', { timeout: 30_000 }, async () => {
  const { settings, sidecar } = roster([{ name: 'helper', persona: 'Says it short', instructions: 'You are terse.' }]);
  await withDoc(async ({ call, state, settingsDir }) => {
    assert.deepEqual((await state()).agents.map((a) => [a.name, a.state]), [['Pilot', 'ready']]);
    await comment(call, 't_noone001', 'Is this clear?');

    // @helper brings it into the doc, and only it answers, in its persona.
    const posted = await comment(call, 't_helper01', '@helper shorten this');
    assert.ok(posted.sidecar.participants.some((p) => p.name === 'helper' && p.kind === 'agent'), 'it joined');
    assert.deepEqual(posted.sidecar.threads[1].messages[0].mentions, ['helper'], 'the mention counts');
    assert.ok(posted.agents.some((a) => a.name === 'helper' && a.persona === 'Says it short'));
    await until(async () => (await state()).sidecar.threads[1].messages.length === 2, 'helper\'s answer');
    await pause(500);
    assert.deepEqual(authorsOf((await state()).sidecar.threads[1]), ['helper']);
    assert.deepEqual(authorsOf((await state()).sidecar.threads[0]), [], 'a comment for no one asks no one');
    assert.match((await fakeRuns(settingsDir))[0].prompt, /Says it short[\s\S]*You are terse\./, 'persona and instructions reach the run');

    // Renamed: it stays in this doc under its new name.
    await call('updateAgent', { id: 'a_test01', patch: { name: 'editor' } });
    const now = await state();
    assert.ok(now.agents.some((a) => a.name === 'editor'));
    assert.ok(now.sidecar.participants.some((p) => p.name === 'editor') && !now.sidecar.participants.some((p) => p.name === 'helper'));
    await assert.rejects(call('updateAgent', { id: 'a_test01', patch: { name: 'fzhan' } }), refused('bad_input'), "not the human's name");

    // Removed: it leaves; its comment stays.
    const removed = await call('removeAgent', { name: 'editor' });
    assert.deepEqual(removed.agents.map((a) => a.name), ['Pilot']);
    assert.ok(!removed.sidecar.participants.some((p) => p.name === 'editor'));
    assert.equal(removed.sidecar.threads[1].messages[1].author.name, 'helper');

    // Added back from the People panel.
    assert.ok((await call('invite', { id: 'a_test01' })).agents.some((a) => a.name === 'editor'));
    await assert.rejects(call('invite', { id: 'a_nobody' }), refused('not_found'));
  }, { settings, sidecar });
});

test('agents are created from the page, added at once, and deleted', { timeout: 30_000 }, async () => {
  const { settings, sidecar } = roster([]);
  await withDoc(async ({ call, state }) => {
    await assert.rejects(call('createAgent', { agent: { name: 'boss', role: 'pilot' } }), refused('bad_input'), 'roles are gone');
    const created = await call('createAgent', { agent: { name: 'grammar', persona: 'Fixes grammar', instructions: 'Fix grammar only.' }, invite: true });
    assert.match(created.agent.id, /^a_/);
    assert.ok(created.sidecar.participants.some((p) => p.name === 'grammar'));
    await assert.rejects(call('createAgent', { agent: { name: 'grammar' }, invite: true }), /the name grammar is taken/, 'a name asked for is refused, not changed');
    assert.equal((await state()).settings.agents.filter((a) => a.name.startsWith('grammar')).length, 1, 'nothing saved');
    assert.equal((await call('createAgent', { agent: { name: 'grammar-2' } })).agent.name, 'grammar-2');
    await assert.rejects(call('createAgent', { agent: { editMode: 'auto' } }), refused('bad_input'), 'permissions are gone');
    const deleted = await call('deleteAgent', { id: created.agent.id });
    assert.deepEqual(deleted.settings.agents.map((a) => a.name), ['Pilot', 'grammar-2']);
    assert.ok(!(await state()).sidecar.participants.some((p) => p.name === 'grammar'), 'it left this doc');
  }, { settings, sidecar });
});

test('a doc opened with no agents starts with Clippy, under its name now; one with agents keeps its own', { timeout: 30_000 }, async () => {
  const fresh = await tempDoc(SAMPLE);
  const settled = await tempDoc(SAMPLE);
  const without = await tempDoc(SAMPLE);
  await writeFile(sidecarPath(settled), JSON.stringify({ opendoc: 1, doc: 'plan.md', docHash: null, threads: [], participants: [{ name: 'solo', kind: 'agent' }] }));
  const others = [{ id: 'a_scout01', name: 'scout', starred: true, persona: 'Reads first' }];
  const settingsDir = await fakeConfig({ agents: [{ id: 'a_default_clippy', name: 'Paperclip', starred: true, persona: 'Helps' }, ...others] });
  const participants = async (doc) => JSON.parse(await readFile(sidecarPath(doc), 'utf8')).participants.map((p) => p.name);
  const open = async (doc) => (await openTestDoc(doc, { settingsDir })).doc.close();
  for (const doc of [fresh, settled]) await open(doc);
  assert.deepEqual(await participants(fresh), ['Paperclip'], 'Clippy renamed, and none of the other agents');
  assert.deepEqual(JSON.parse(await readFile(sidecarPath(fresh), 'utf8')).participants[0], { name: 'Paperclip', kind: 'agent', persona: 'Helps' });
  assert.deepEqual(await participants(settled), ['solo'], 'a doc with agents keeps them');
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fzhan', agents: others })); // Clippy deleted
  await open(without);
  assert.deepEqual(await participants(without).catch(() => []), [], 'no Clippy, no one');
});

test('a new agent is its doc\'s own: saved with the doc, back when it opens, gone when removed; a cloned doc brings its agents', { timeout: 30_000 }, async () => {
  const docA = await tempDoc(SAMPLE);
  const docB = await tempDoc(SAMPLE);
  const docC = await tempDoc(SAMPLE);
  const settingsDir = await fakeConfig({ agents: [{ id: 'a_kept01', name: 'kept', starred: true }] });
  const rosterNow = async () => JSON.parse(await readFile(join(settingsDir, 'settings.json'), 'utf8')).agents;
  const open = (doc) => openTestDoc(doc, { settingsDir });
  const participant = async (doc, name) => JSON.parse(await readFile(sidecarPath(doc), 'utf8')).participants.find((p) => p.name === name);

  // Made in A: A's own, and A's sidecar says who it is.
  let opened = await open(docA);
  let id;
  try {
    const made = await opened.call('createAgent', { agent: {}, invite: true });
    id = made.agent.id;
    assert.deepEqual([made.agent.name, made.agent.starred], ['agent', false]);
    assert.equal((await opened.state()).docKey, made.agent.doc, 'it belongs to this doc');
    await opened.call('updateAgent', { id, patch: { name: 'critic', persona: 'A tough reader' } });
    assert.deepEqual(await participant(docA, 'critic'), { name: 'critic', kind: 'agent', persona: 'A tough reader' });
    await assert.rejects(opened.call('createAgent', { agent: { doc: '/x.md' } }), refused('bad_input'), 'the page cannot pick a doc');
  } finally {
    await opened.doc.close();
  }
  assert.ok((await rosterNow()).some((a) => a.name === 'critic'), 'closing the doc keeps it');

  // Not in B.
  opened = await open(docB);
  try {
    assert.ok(!(await opened.state()).agents.some((a) => a.name === 'critic'));
    await assert.rejects(opened.call('invite', { id }), refused('not_found'), 'another doc\'s own cannot be added');
    // Unstarring a starred agent not in this doc takes it out of your agents.
    await opened.call('updateAgent', { id: 'a_kept01', patch: { starred: false } });
    assert.ok(!(await rosterNow()).some((a) => a.name === 'kept'));
  } finally {
    await opened.doc.close();
  }

  // Back in A, then removed: deleted.
  opened = await open(docA);
  try {
    assert.ok((await opened.state()).agents.some((a) => a.name === 'critic'), 'back with the doc');
    await opened.call('removeAgent', { name: 'critic' });
    assert.ok(!(await rosterNow()).some((a) => a.name === 'critic'), 'removing a doc\'s own deletes it');
  } finally {
    await opened.doc.close();
  }

  // A doc from elsewhere has agents this machine does not have: each is set
  // up as that doc's own, described or not.
  await writeFile(sidecarPath(docC), JSON.stringify({ opendoc: 1, doc: 'plan.md', docHash: null, threads: [],
    participants: [{ name: 'helper', kind: 'agent', persona: 'Says it short', instructions: 'Be terse.' }, { name: 'bare', kind: 'agent' }] }));
  opened = await open(docC);
  try {
    const helper = (await rosterNow()).find((a) => a.name === 'helper');
    assert.deepEqual([helper.persona, helper.instructions, helper.starred], ['Says it short', 'Be terse.', false]);
    const { docKey } = await opened.state();
    assert.equal(helper.doc, docKey);
    const bare = (await rosterNow()).find((a) => a.name === 'bare');
    assert.deepEqual([bare.persona, bare.instructions, bare.doc], ['', '', docKey]);

    // Changed in OpenDoc: the doc says so.
    await opened.call('updateAgent', { id: helper.id, patch: { persona: 'Says it shorter' } });
    await pause(500); // the watcher sees the sidecar change
    assert.deepEqual(await participant(docC, 'helper'), { name: 'helper', kind: 'agent', persona: 'Says it shorter', instructions: 'Be terse.' });

    // Changed outside OpenDoc: it follows the doc.
    const sidecar = JSON.parse(await readFile(sidecarPath(docC), 'utf8'));
    sidecar.participants.find((p) => p.name === 'helper').instructions = 'Say less.';
    await writeFile(sidecarPath(docC), JSON.stringify(sidecar));
    await until(async () => (await rosterNow()).find((a) => a.id === helper.id).instructions === 'Say less.', 'the agent to follow the doc');
  } finally {
    await opened.doc.close();
  }
});

test('a rename keeps the human one person in the doc: their comments follow the new name', async () => {
  const docPath = await tempDoc(SAMPLE);
  // A comment from before ids, under the name they had before renaming to Frank (kept as their face's seed).
  await update(docPath, (s) => applyOp(s, { type: 'addThread', id: 't_frank001', anchor: null, message: { id: 'm_frank001', author: { name: 'fanzhang', kind: 'human' }, body: 'first thoughts', createdAt: new Date().toISOString() } }));
  const settingsDir = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'Frank', face: 'fanzhang' }));
  const { doc, call, state } = await openTestDoc(docPath, { settingsDir });
  try {
    const humans = async () => (await state()).sidecar.participants.filter((p) => p.kind === 'human');
    const [frank] = await humans();
    assert.equal(frank.name, 'Frank');
    assert.match(frank.id, /^u_/);
    assert.equal((await humans()).length, 1, 'one person, not two');
    await call('saveSettings', { name: 'Fan' });
    await until(async () => (await humans())[0].name === 'Fan', 'the new name');
    assert.deepEqual(await humans(), [{ name: 'Fan', kind: 'human', id: frank.id }]);
    assert.deepEqual((await state()).sidecar.threads[0].messages[0].author, { name: 'Fan', kind: 'human', id: frank.id });
  } finally {
    await doc.close();
  }
});
