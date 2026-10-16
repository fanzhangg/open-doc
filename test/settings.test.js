import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, PROGRAM_KEYS, SettingsError, checkSettingsPatch, resolveSettings } from '../src/core/settings.js';
import { configDir, editAgents, readSettings, settingsPath, updateSettings, watchSettings } from '../src/store/settings.js';
import { AGENT_DEFAULTS, AgentError, DEFAULT_AGENTS, DEFAULT_AGENT_ID, checkAgentPatch, availableIn, createAgent, deleteAgent, docOnly, introOf, leaderless, permissionLabels, permissionPatch, permissionsOf, resolveRoster, updateAgent } from '../src/core/agents.js';

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
  assert.deepEqual(permissionLabels(roster[0]), ['Editor', 'Auto Editor', 'Auto Commenter']);
  assert.equal(introOf({ persona: 'A poet' }), 'A poet', 'the persona is the line on its card');
  assert.equal(introOf({ persona: '', instructions: 'You are a poet.' }), '', 'empty until the user writes one');
});

test('agents: a persona is one line; instructions hold the rest; old agents are split', () => {
  assert.doesNotThrow(() => checkAgentPatch({ persona: 'A strict copy editor', instructions: 'Fix grammar only.\nReply with a list.' }));
  assert.throws(() => checkAgentPatch({ persona: 'two\nlines' }), /persona/);
  assert.throws(() => checkAgentPatch({ persona: 'x'.repeat(121) }), /persona/);
  assert.throws(() => checkAgentPatch({ instructions: 'x'.repeat(4001) }), /instructions/);
  assert.throws(() => checkAgentPatch({ tagline: 'gone' }), /unknown agent setting: tagline/);
  const [short, introduced, long] = resolveRoster([
    { id: 'a_old001', name: 'translator', tagline: '', persona: 'Translate English to Chinese when I @you' },
    { id: 'a_old002', name: 'will', tagline: 'Polishes style', persona: 'You are Will.\nKeep the voice.' },
    { id: 'a_old003', name: 'sam', persona: 'You are Sam, the proofreader. Your job is spelling.\nNothing else.' },
  ]);
  assert.deepEqual([short.persona, short.instructions], ['Translate English to Chinese when I @you', '']);
  assert.deepEqual([introduced.persona, introduced.instructions], ['Polishes style', 'You are Will.\nKeep the voice.']);
  assert.deepEqual([long.persona, long.instructions], ['Sam, the proofreader', 'You are Sam, the proofreader. Your job is spelling.\nNothing else.']);
  assert.equal(Object.hasOwn(short, 'tagline'), false);
});

test('agents: a new one edits directly, and the first among its peers leads', () => {
  assert.equal(createAgent([]).editMode, 'auto', 'Auto Editor, as a co-author');
  assert.equal(createAgent([]).autoComment, false, 'Auto Commenter is the caller\'s choice');
  assert.equal(leaderless([]), true, 'no one yet: the next one leads');
  assert.equal(leaderless([{ autoComment: false }, { autoComment: false }]), true);
  assert.equal(leaderless([{ autoComment: false }, { autoComment: true }]), false);
});

test('agents: each permission is a switch, and Auto Editor needs Editor', () => {
  const agent = { ...AGENT_DEFAULTS, editMode: 'none' };
  assert.deepEqual(permissionsOf(agent), { editor: false, autoEditor: false, autoComment: false, web: false, files: false });
  assert.deepEqual(permissionPatch(agent, 'editor', true), { editMode: 'approve' });
  assert.deepEqual(permissionPatch(agent, 'autoEditor', true), { editMode: 'auto' }, 'Auto Editor turns Editor on');
  const auto = { ...agent, editMode: 'auto' };
  assert.deepEqual(permissionPatch(auto, 'autoEditor', false), { editMode: 'approve' }, 'off, it still proposes');
  assert.deepEqual(permissionPatch(auto, 'editor', false), { editMode: 'none' }, 'Editor off turns Auto Editor off');
  assert.deepEqual(permissionPatch({ ...agent, editMode: 'approve' }, 'editor', true), { editMode: 'approve' });
  assert.deepEqual(permissionPatch(agent, 'autoComment', true), { autoComment: true });
  assert.deepEqual(permissionPatch(agent, 'web', true), { webAccess: true });
  assert.deepEqual(permissionPatch(agent, 'files', true), { fileAccess: true });
  assert.equal(permissionPatch(agent, 'reader', false), null, 'reading the doc is not a switch');
  assert.deepEqual(permissionLabels(agent), []);
});

test('agents: each field checked; any number of agents with Auto Commenter', () => {
  const muse = { ...AGENT_DEFAULTS, id: 'a_muse01', name: 'muse', persona: 'A poet', instructions: 'Be bold.' };
  const plainAgent = { ...DEFAULT_AGENTS[0] };
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [plainAgent, muse] }));
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [muse] }), 'none with Auto Commenter');
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [plainAgent, { ...muse, autoComment: true }] }), 'two with Auto Commenter');
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [] }));
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, { ...muse, maxTurns: 0 }] }), /invalid value for agents/);
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, { ...muse, runtime: 'robot' }] }), SettingsError);
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, { ...muse, name: 'two words' }] }), SettingsError);
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, { ...muse, role: 'pilot' }] }), SettingsError, 'roles are gone');
  assert.throws(() => checkSettingsPatch({ agents: [plainAgent, muse, { ...muse, id: 'a_muse02', name: 'MUSE' }] }), SettingsError, 'names are unique, case-insensitively');
  assert.throws(() => checkAgentPatch({ persona: 'x'.repeat(121) }), AgentError);
  assert.throws(() => checkAgentPatch({ instructions: 'x'.repeat(4001) }), AgentError);
  assert.throws(() => checkAgentPatch({ editMode: 'sometimes' }), /editMode/);
  assert.throws(() => checkAgentPatch({ autoComment: 'yes' }), /autoComment/);
  assert.doesNotThrow(() => checkAgentPatch({ editMode: 'none' }));
  // Effort: low by default (fast), and only the levels the settings offer.
  assert.equal(AGENT_DEFAULTS.effort, 'low');
  assert.doesNotThrow(() => checkAgentPatch({ effort: 'high' }));
  assert.throws(() => checkAgentPatch({ effort: 'max' }), /effort/);
  assert.equal(resolveRoster([{ ...muse, effort: 'extreme' }])[0].effort, 'low', 'an unknown effort falls back to the default');

  // Stored rosters are repaired: broken entries dropped; the pilot of old keeps its job as Auto Commenter.
  assert.deepEqual(resolveRoster([{ ...muse, maxTurns: -1 }, { name: 'no-id' }]).map((a) => [a.name, a.maxTurns]), [['muse', 30]]);
  const { autoComment: _, ...before } = muse; // saved before Auto Commenter
  const old = resolveRoster([{ ...before, role: 'pilot' }, { ...before, id: 'a_muse02', name: 'muse2', role: 'copilot' }]);
  assert.deepEqual(old.map((a) => [a.autoComment, Object.hasOwn(a, 'role')]), [[true, false], [false, false]]);
  assert.deepEqual(resolveSettings({ agents: [] }).agents, [], 'the user may have no agents');
  // Settings from the single-agent version: the default agent, and where Claude Code is.
  const legacy = resolveSettings({ agent: { enabled: true, name: 'helper', bin: '/opt/claude' } });
  assert.deepEqual(legacy.agents.map((a) => a.name), DEFAULT_AGENTS.map((a) => a.name));
  assert.equal(legacy.claudeBin, '/opt/claude');
  // Grants from the ask-at-first-use version are dropped.
  assert.equal(Object.hasOwn(resolveSettings({ grants: [] }), 'grants'), false);
});

test('agents: new ones get a free name; any agent can be changed or deleted', () => {
  const plain = resolveSettings(null).agents;
  const roster = [...plain, createAgent(plain, { name: 'Rocky' }), createAgent(plain, { name: 'Will' })];
  const one = createAgent(roster, { name: 'Rocky' });
  assert.match(one.id, /^a_/);
  assert.equal(one.name, 'Rocky-2');
  assert.equal(createAgent(plain).name, 'agent', 'a plain name to start with');
  assert.deepEqual([one.starred, one.doc], [false, null], 'new agents are not starred');
  assert.equal(one.autoComment, false, 'a new agent answers when @mentioned');
  assert.equal(createAgent([], { name: 'fzhan' }, ['fzhan']).name, 'fzhan-2', "not the human's name");
  assert.throws(() => createAgent([], { maxTurns: 0 }), AgentError);

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
  const both = updateAgent(roster, will.id, { autoComment: true });
  assert.deepEqual(both.filter((a) => a.autoComment).map((a) => a.name), ['Clippy', 'Will']);
  assert.equal(updateAgent(roster, plainAgent.id, { autoComment: false }).some((a) => a.autoComment), false);
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

test('agents: a crew saved by an older app is dropped; new docs start with Clippy instead', () => {
  const [old] = resolveRoster([{ id: 'a_old001', name: 'pilot', autoComment: true, crew: true }]);
  assert.equal(Object.hasOwn(old, 'crew'), false);
  assert.throws(() => checkAgentPatch({ crew: true }), /unknown agent setting: crew/);
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

test('claudeBin and codexBin: where Claude Code and Codex are, for every agent', () => {
  assert.equal(DEFAULT_SETTINGS.claudeBin, null);
  assert.equal(DEFAULT_SETTINGS.codexBin, null);
  assert.deepEqual(PROGRAM_KEYS, ['claudeBin', 'codexBin'], 'set only in the desktop app or settings.json');
  assert.doesNotThrow(() => checkSettingsPatch({ codexBin: 'C:\\tools\\codex.exe' }));
  assert.throws(() => checkSettingsPatch({ codexBin: '' }), SettingsError);
  assert.equal(resolveSettings({ codexBin: '/opt/codex' }).codexBin, '/opt/codex');
  assert.equal(resolveSettings({ codexBin: 42 }).codexBin, null);
  assert.doesNotThrow(() => checkSettingsPatch({ claudeBin: 'C:\\tools\\claude.exe' }));
  assert.throws(() => checkSettingsPatch({ claudeBin: '' }), SettingsError);
  assert.throws(() => checkSettingsPatch({ agent: { enabled: true } }), /unknown setting: agent/);
});
