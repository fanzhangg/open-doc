import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, PROGRAM_KEYS, SettingsError, checkSettingsPatch, resolveSettings } from '../src/core/settings.js';
import { configDir, editAgents, readSettings, settingsPath, updateSettings, watchSettings } from '../src/store/settings.js';
import { AGENT_DEFAULTS, AgentError, DEFAULT_AGENTS, checkAgentPatch, createAgent, deleteAgent, disposable, introOf, permissionLabels, permissionPatch, permissionsOf, resolveRoster, updateAgent } from '../src/core/agents.js';

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
  assert.deepEqual(roster.map((a) => [a.name, a.persona, a.starred, a.session]), [['Clippy', '', true, null]], 'no persona, no job, kept');
  assert.deepEqual(permissionLabels(roster[0]), ['Editor', 'Auto Editor', 'Auto Commenter']);
  assert.equal(introOf({ persona: 'You are a poet.\nBe bold.' }), 'A poet', 'without an introduction, the persona says it');
  assert.equal(introOf({ tagline: '', persona: '' }), '');
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
  const muse = { ...AGENT_DEFAULTS, id: 'a_muse01', name: 'muse', persona: 'You are a poet.\nBe bold.' };
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
  assert.throws(() => checkAgentPatch({ tagline: 'x'.repeat(61) }), AgentError);
  assert.throws(() => checkAgentPatch({ persona: 'x'.repeat(4001) }), AgentError);
  assert.throws(() => checkAgentPatch({ editMode: 'sometimes' }), /editMode/);
  assert.throws(() => checkAgentPatch({ autoComment: 'yes' }), /autoComment/);
  assert.doesNotThrow(() => checkAgentPatch({ editMode: 'none' }));

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
  assert.deepEqual([one.starred, one.session], [false, null], 'new agents are not starred');
  assert.equal(one.autoComment, false, 'a new agent answers when @mentioned');
  assert.equal(createAgent([], { name: 'fzhan' }, ['fzhan']).name, 'fzhan-2', "not the human's name");
  assert.throws(() => createAgent([], { maxTurns: 0 }), AgentError);

  const will = roster.find((a) => a.name === 'Will');
  const plainAgent = roster.find((a) => a.name === 'Clippy');
  assert.equal(updateAgent(roster, will.id, { persona: 'Sonnets only.' }).find((a) => a.id === will.id).persona, 'Sonnets only.');
  assert.throws(() => updateAgent(roster, will.id, { name: 'ROCKY' }), /taken/);
  assert.throws(() => updateAgent(roster, will.id, { id: 'a_other1' }), AgentError);
  assert.throws(() => updateAgent(roster, 'a_nobody', { persona: '' }), /no such agent/);
  const both = updateAgent(roster, will.id, { autoComment: true });
  assert.deepEqual(both.filter((a) => a.autoComment).map((a) => a.name), ['Clippy', 'Will']);
  assert.equal(updateAgent(roster, plainAgent.id, { autoComment: false }).some((a) => a.autoComment), false);
  assert.deepEqual(deleteAgent(roster, plainAgent.id).map((a) => a.name), ['Rocky', 'Will']);
  assert.throws(() => deleteAgent(roster, 'a_nobody'), /no such agent/);
});

test('agents: stars keep an agent; an unstarred one belongs to a doc session', () => {
  const session = '4242:0123456789abcdef';
  assert.doesNotThrow(() => checkAgentPatch({ starred: true, session }));
  assert.throws(() => checkAgentPatch({ session: 'any doc' }), /session/);
  assert.throws(() => checkAgentPatch({ starred: 'yes' }), /starred/);
  const [kept, made, old] = resolveRoster([
    { id: 'a_kept01', name: 'kept', starred: true, session },
    { id: 'a_made01', name: 'made', starred: false, session },
    { id: 'a_old001', name: 'old' },
  ]);
  assert.deepEqual([kept.starred, kept.session, disposable(kept)], [true, null, false], 'a starred agent belongs to no session');
  assert.deepEqual([made.session, disposable(made)], [session, true]);
  assert.deepEqual([old.starred, disposable(old)], [true, false], 'saved before stars: kept');
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
