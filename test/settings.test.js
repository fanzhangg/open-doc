import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, SettingsError, checkSettingsPatch, resolveSettings } from '../src/core/settings.js';
import { configDir, editAgents, readSettings, settingsPath, updateSettings, watchSettings } from '../src/store/settings.js';
import { AGENT_DEFAULTS, AgentError, DEFAULT_AGENTS, DEFAULT_AGENT_ID, checkAgentPatch, availableIn, createAgent, createFields, deleteAgent, draftAgent, docOnly, introOf, resolveRoster, updateAgent } from '../src/core/agents.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'opendoc-settings-'));

test('configDir follows each OS convention and the override', () => {
  const home = '/home/u';
  assert.equal(configDir({ OPENDOC_CONFIG_DIR: '/x' }, 'win32', home), '/x');
  assert.equal(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', home), join('C:\\Users\\u\\AppData\\Roaming', 'OpenDoc'));
  assert.equal(configDir({}, 'darwin', home), join(home, 'Library', 'Application Support', 'OpenDoc'));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', home), join('/cfg', 'opendoc'));
  assert.equal(configDir({}, 'linux', home), join(home, '.config', 'opendoc'));
});

test('patches are checked key by key', () => {
  assert.doesNotThrow(() => checkSettingsPatch({ font: 'serif', focus: true, name: 'fzhan' }));
  assert.doesNotThrow(() => checkSettingsPatch({ name: null }));
  assert.throws(() => checkSettingsPatch({ font: 'comic' }), SettingsError);
  assert.throws(() => checkSettingsPatch({ colour: 'red' }), /unknown setting/);
  assert.throws(() => checkSettingsPatch({ outline: 'yes' }), SettingsError);
  assert.throws(() => checkSettingsPatch({ name: 'two words' }), SettingsError);
  assert.throws(() => checkSettingsPatch([]), SettingsError);
});

test('resolveSettings keeps valid values and defaults the rest', () => {
  assert.deepEqual(resolveSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(resolveSettings({ font: 'mono', width: 'huge', extra: 1 }), { ...DEFAULT_SETTINGS, font: 'mono' });
});

test('no file: defaults, not saved, and nothing is created', async () => {
  const dir = join(await tempDir(), 'nested');
  assert.deepEqual(await readSettings(dir), { settings: DEFAULT_SETTINGS, saved: false });
  await assert.rejects(stat(dir));
});

test('updates merge, create the folder, and survive a fresh read', async () => {
  const dir = join(await tempDir(), 'nested');
  await updateSettings({ font: 'serif' }, dir);
  const after = await updateSettings({ theme: 'dark' }, dir);
  assert.deepEqual(after, { ...DEFAULT_SETTINGS, font: 'serif', theme: 'dark' });
  assert.deepEqual(await readSettings(dir), { settings: after, saved: true });
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.equal(raw.version, 1);
});

test('a bad patch writes nothing', async () => {
  const dir = await tempDir();
  await assert.rejects(updateSettings({ font: 'serif', width: 'huge' }, dir), SettingsError);
  assert.equal((await readSettings(dir)).saved, false);
});

test('keys from a newer version are kept on write', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), JSON.stringify({ version: 2, font: 'mono', agent: { enabled: true } }));
  await updateSettings({ focus: true }, dir);
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.deepEqual(raw.agent, { enabled: true });
  assert.equal(raw.font, 'mono');
  assert.equal(raw.focus, true);
});

test('a corrupt file is set aside and defaults are used', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), '{ not json');
  const { settings } = await readSettings(dir);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(await readFile(settingsPath(dir) + '.bak', 'utf8'), '{ not json');
  await updateSettings({ font: 'serif' }, dir);
  assert.equal((await readSettings(dir)).settings.font, 'serif');
});

test('concurrent writers of different settings both keep their change', async () => {
  const dir = await tempDir();
  const script = join(dir, 'writer.mjs');
  const store = new URL('../src/store/settings.js', import.meta.url).href;
  await writeFile(script, `import { updateSettings } from ${JSON.stringify(store)};
const [key, value] = process.argv.slice(2);
for (let i = 0; i < 20; i++) await updateSettings({ [key]: i % 2 === 0 ? value === 'true' : value !== 'true' }, process.env.DIR);
await updateSettings({ [key]: value === 'true' }, process.env.DIR);`);
  const run = (key, value) => new Promise((resolve, reject) => {
    fork(script, [key, value], { env: { ...process.env, DIR: dir } }).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([run('focus', 'true'), run('wordCount', 'true'), run('outline', 'false')]);
  const { settings } = await readSettings(dir);
  assert.equal(settings.focus, true);
  assert.equal(settings.wordCount, true);
  assert.equal(settings.outline, false);
});

test('watchSettings sees the file appear and change', async () => {
  const dir = join(await tempDir(), 'later');
  let calls = 0;
  const stop = watchSettings(() => { calls++; }, dir);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600)); // first poll records "missing"
    await updateSettings({ font: 'serif' }, dir);
    const deadline = Date.now() + 3000;
    while (calls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(calls > 0);
  } finally {
    stop();
  }
});

test('agents: the app comes with Clippy, starred, generic, and no built-in roles', () => {
  const roster = resolveSettings(null).agents;
  assert.deepEqual(roster.map((a) => [a.id, a.name, a.persona, a.starred, a.doc]), [[DEFAULT_AGENT_ID, 'Clippy', 'A general writing assistant that helps draft and edit docs', true, null]], 'a generic writing assistant');
  assert.equal(introOf({ persona: 'A poet' }), 'A poet', 'the persona is the line on its card');
  assert.equal(introOf({ persona: '', instructions: 'You are a poet.' }), '', 'empty until the user writes one');
});

test('agents: a persona is one line; instructions hold the rest', () => {
  assert.doesNotThrow(() => checkAgentPatch({ persona: 'A strict copy editor', instructions: 'Fix grammar only.\nReply with a list.' }));
  assert.throws(() => checkAgentPatch({ persona: 'two\nlines' }), /persona/);
  assert.throws(() => checkAgentPatch({ persona: 'x'.repeat(121) }), /persona/);
  assert.throws(() => checkAgentPatch({ instructions: 'x'.repeat(4001) }), /instructions/);
  assert.throws(() => checkAgentPatch({ tagline: 'gone' }), /unknown agent setting: tagline/);
});


test('agents: a new one is a draft until created, and Create sends only what changed', () => {
  const draft = draftAgent({ face: 'seed1234' });
  assert.deepEqual([draft.id, draft.name, draft.face], [null, '', 'seed1234'], 'the defaults, no id or name yet');
  assert.equal(createFields(draft), null, 'no name: nothing to create');
  assert.equal(createFields({ ...draft, name: '  ' }), null);
  assert.equal(createFields({ ...draft, name: 'bad name' }), null, 'a name it could not be @mentioned by');
  assert.deepEqual(createFields({ ...draft, name: ' critic ' }), { name: 'critic', face: 'seed1234' }, 'the name trimmed, and the face it was drawn with');
  assert.deepEqual(createFields({ ...draft, name: 'critic', persona: 'A tough reader', doc: '/x.md' }), { name: 'critic', face: 'seed1234', persona: 'A tough reader' }, 'the doc is the server\'s to set');
});


test('agents: a name asked for is kept or refused; none asked for gets a free one', () => {
  const roster = [createAgent([], { name: 'critic' })];
  assert.equal(createAgent(roster, { name: 'critic' }).name, 'critic-2');
  assert.throws(() => createAgent(roster, { name: 'Critic' }, [], { exact: true }), (error) => error instanceof AgentError && error.message === 'the name Critic is taken');
  assert.throws(() => createAgent([], { name: 'fzhan' }, ['fzhan'], { exact: true }), /the name fzhan is taken/, "not the human's name either");
  assert.equal(createAgent(roster, { name: 'muse' }, [], { exact: true }).name, 'muse');
});

test('agents: each field checked; permissions and runtimes are gone', () => {
  const muse = { ...AGENT_DEFAULTS, id: 'a_muse01', name: 'muse', persona: 'A poet', instructions: 'Be bold.' };
  const plainAgent = { ...DEFAULT_AGENTS[0] };
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [plainAgent, muse] }));
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [] }));
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, { ...muse, name: 'two words' }] }), SettingsError);
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, muse, { ...muse, id: 'a_muse02', name: 'MUSE' }] }), SettingsError, 'names are unique, case-insensitively');
  for (const key of ['editMode', 'autoComment', 'webAccess', 'fileAccess', 'runtime', 'command', 'model']) {
    assert.throws(() => checkAgentPatch({ [key]: null }), AgentError, key);
  }
  // Stored rosters are repaired: broken entries dropped, unknown fields left out.
  const [kept] = resolveRoster([{ ...muse, editMode: 'auto', runtime: 'codex' }, { name: 'no-id' }]);
  assert.deepEqual(kept, { ...muse, starred: true });
  assert.deepEqual(resolveSettings({ agents: [] }).agents, [], 'the user may have no agents');
});


test('agents: new ones get a free name; any agent can be changed or deleted', () => {
  const plain = resolveSettings(null).agents;
  const roster = [...plain, createAgent(plain, { name: 'Rocky' }), createAgent(plain, { name: 'Will' })];
  const one = createAgent(roster, { name: 'Rocky' });
  assert.match(one.id, /^a_/);
  assert.equal(one.name, 'Rocky-2');
  assert.equal(createAgent(plain).name, 'agent', 'a plain name to start with');
  assert.deepEqual([one.starred, one.doc], [false, null], 'new agents are not starred');
  assert.equal(createAgent([], { name: 'fzhan' }, ['fzhan']).name, 'fzhan-2', "not the human's name");
  assert.throws(() => createAgent([], { persona: 'a\nb' }), AgentError);

  const will = roster.find((a) => a.name === 'Will');
  const plainAgent = roster.find((a) => a.name === 'Clippy');
  assert.equal(updateAgent(roster, will.id, { persona: 'Sonnets only.' }).find((a) => a.id === will.id).persona, 'Sonnets only.');
  assert.throws(() => updateAgent(roster, will.id, { name: 'ROCKY' }), /taken/);
  assert.throws(() => updateAgent(roster, will.id, { id: 'a_other1' }), AgentError);
  assert.throws(() => updateAgent(roster, 'a_nobody', { persona: '' }), /no such agent/);
  const renamed = updateAgent(roster, will.id, { name: 'Bill' }).find((a) => a.id === will.id);
  assert.equal(renamed.face, 'Will', 'a new name keeps the face');
  assert.equal(updateAgent(updateAgent(roster, will.id, { face: 'x1' }), will.id, { name: 'Bill' }).find((a) => a.id === will.id).face, 'x1');
  assert.equal(updateAgent(roster, will.id, { name: 'Bill', face: null }).find((a) => a.id === will.id).face, null);
  assert.throws(() => checkAgentPatch({ face: '' }), AgentError);
  assert.equal(resolveSettings({ face: 'abc' }).face, 'abc');
  assert.equal(resolveSettings({ face: 'a\nb' }).face, null);
  assert.deepEqual(deleteAgent(roster, plainAgent.id).map((a) => a.name), ['Rocky', 'Will']);
  assert.throws(() => deleteAgent(roster, 'a_nobody'), /no such agent/);
});

test('agents: an unstarred agent is one doc\'s own; names are unique where they show', () => {
  const doc = '/home/me/plan.md';
  assert.doesNotThrow(() => checkAgentPatch({ starred: false, doc }));
  assert.throws(() => checkAgentPatch({ doc: '' }), /doc/);
  assert.throws(() => checkAgentPatch({ starred: 'yes' }), /starred/);
  const [kept, own, old, stray] = resolveRoster([
    { id: 'a_kept01', name: 'kept', starred: true, doc },
    { id: 'a_own001', name: 'own', starred: false, doc },
    { id: 'a_old001', name: 'old' },
    { id: 'a_stray1', name: 'stray', starred: false },
  ]);
  assert.deepEqual([kept.doc, docOnly(kept)], [null, false], 'a starred agent belongs to no doc');
  assert.deepEqual([own.doc, docOnly(own), availableIn(own, doc), availableIn(own, '/home/me/other.md')], [doc, true, true, false]);
  assert.deepEqual([old.starred, stray.starred], [true, true], 'saved before stars, or in no doc: the user\'s');

  // Two docs may each have a reviewer; a starred one clashes everywhere.
  const two = resolveRoster([
    { id: 'a_rev001', name: 'reviewer', starred: false, doc },
    { id: 'a_rev002', name: 'reviewer', starred: false, doc: '/home/me/other.md' },
  ]);
  assert.equal(two.length, 2);
  assert.equal(createAgent(two, { name: 'reviewer', doc }).name, 'reviewer-2', 'not twice in one doc');
  assert.equal(createAgent(two, { name: 'reviewer', doc: '/home/me/third.md' }).name, 'reviewer', 'free in a third doc');
  assert.throws(() => updateAgent(two, 'a_rev001', { starred: true, doc: null }), /taken/, 'a starred one would show in the other doc too');
});

test('agents: editAgents changes the roster under the lock and keeps other settings', async () => {
  const dir = await tempDir();
  await updateSettings({ font: 'serif' }, dir);
  let created;
  const after = await editAgents((agents) => {
    created = createAgent(agents, { name: 'muse' });
    return [...agents, created];
  }, dir);
  assert.deepEqual(after.agents.map((a) => a.name), ['Clippy', 'muse']);
  assert.equal(after.font, 'serif');
  await assert.rejects(editAgents((agents) => [...agents, { ...created }], dir), SettingsError, 'the same agent twice');
  assert.equal((await readSettings(dir)).settings.agents.length, 2);
});

test('agent: which agent script runs every buddy, Claude Code unless changed', () => {
  assert.equal(DEFAULT_SETTINGS.agent, 'claude');
  assert.doesNotThrow(() => checkSettingsPatch({ agent: 'codex' }));
  assert.throws(() => checkSettingsPatch({ agent: '../evil' }), SettingsError);
  assert.equal(resolveSettings({ agent: 'my-bot' }).agent, 'my-bot');
  assert.equal(resolveSettings({ agent: 'a/b' }).agent, 'claude');
  assert.throws(() => checkSettingsPatch({ claudeBin: '/opt/claude' }), /unknown setting: claudeBin/);
});
