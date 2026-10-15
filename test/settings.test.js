import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, PROGRAM_KEYS, SettingsError, checkSettingsPatch, resolveSettings } from '../src/core/settings.js';
import { configDir, editAgents, readSettings, settingsPath, updateSettings, watchSettings } from '../src/store/settings.js';
import { AGENT_DEFAULTS, AgentError, BUILTIN_AGENTS, checkAgentPatch, createAgent, deleteAgent, permissionLabels, pilotOf, resolveRoster, updateAgent } from '../src/core/agents.js';

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

test('agents: the app comes with Clippy as pilot and four co-pilots, each with only what its job needs', () => {
  const builtins = resolveSettings(null).agents;
  assert.deepEqual(builtins.map((a) => [a.name, a.role]), [['Clippy', 'pilot'], ['Rocky', 'copilot'], ['Will', 'copilot'], ['Genius', 'copilot'], ['Merlin', 'copilot']]);
  for (const agent of builtins) {
    assert.ok(agent.tagline && agent.tagline.length <= 60 && agent.tagline.split(' ').length <= 5, `${agent.name} has a slogan of a few words`);
    assert.ok(agent.persona.includes(agent.name), `${agent.name} has a persona`);
    assert.ok(!(agent.webAccess && agent.fileAccess), `${agent.name} never has both web and your files`);
  }
  const perms = Object.fromEntries(builtins.map((a) => [a.name, permissionLabels(a)]));
  assert.deepEqual(perms, {
    Clippy: ['Can edit', 'Web'],
    Rocky: ['Can edit'],
    Will: ['Can suggest'],
    Genius: ['Can suggest', 'Web'],
    Merlin: ['Can suggest', 'Your files'],
  });
  assert.equal(pilotOf(builtins).name, 'Clippy');
});

test('agents: each field checked; a roster always has exactly one pilot', () => {
  const muse = { ...AGENT_DEFAULTS, id: 'a_muse01', name: 'muse', persona: 'You are a poet.\nBe bold.' };
  const pilot = { ...BUILTIN_AGENTS[0] };
  assert.doesNotThrow(() => checkSettingsPatch({ agents: [pilot, muse] }));
  assert.throws(() => checkSettingsPatch({ agents: [muse] }), SettingsError, 'no pilot');
  assert.throws(() => checkSettingsPatch({ agents: [pilot, { ...muse, role: 'pilot' }] }), SettingsError, 'two pilots');
  assert.throws(() => checkSettingsPatch({ agents: [pilot, { ...muse, maxTurns: 0 }] }), /invalid value for agents/);
  assert.throws(() => checkSettingsPatch({ agents: [pilot, { ...muse, runtime: 'robot' }] }), SettingsError);
  assert.throws(() => checkSettingsPatch({ agents: [pilot, { ...muse, name: 'two words' }] }), SettingsError);
  assert.throws(() => checkSettingsPatch({ agents: [pilot, { ...muse, presence: 'online' }] }), SettingsError, 'presence is gone');
  assert.throws(() => checkSettingsPatch({ agents: [pilot, muse, { ...muse, id: 'a_muse02', name: 'MUSE' }] }), SettingsError, 'names are unique, case-insensitively');
  assert.throws(() => checkAgentPatch({ tagline: 'x'.repeat(61) }), AgentError);
  assert.throws(() => checkAgentPatch({ persona: 'x'.repeat(4001) }), AgentError);
  assert.throws(() => checkAgentPatch({ role: 'boss' }), /role/);

  // Stored rosters are repaired: broken entries dropped, one pilot kept, Clippy brought back when none.
  assert.deepEqual(resolveRoster([{ ...muse, maxTurns: -1 }, { name: 'no-id' }]).map((a) => [a.name, a.role, a.maxTurns]), [['Clippy', 'pilot', 30], ['muse', 'copilot', 30]]);
  assert.deepEqual(resolveRoster([{ ...muse, role: 'pilot' }, { ...muse, id: 'a_muse02', name: 'muse2', role: 'pilot' }]).map((a) => a.role), ['pilot', 'copilot']);
  assert.deepEqual(resolveSettings({ agents: [] }).agents.map((a) => a.name), ['Clippy']);
  // Settings from the single-agent version: the built-ins, and where Claude Code is.
  const legacy = resolveSettings({ agent: { enabled: true, name: 'helper', bin: '/opt/claude' } });
  assert.deepEqual(legacy.agents.map((a) => a.name), BUILTIN_AGENTS.map((a) => a.name));
  assert.equal(legacy.claudeBin, '/opt/claude');
});

test('agents: new ones are co-pilots with a free name; the pilot can be replaced but not removed', () => {
  const roster = resolveSettings(null).agents;
  const one = createAgent(roster, { name: 'Rocky', role: 'pilot' });
  assert.match(one.id, /^a_/);
  assert.equal(one.name, 'Rocky-2');
  assert.equal(one.role, 'copilot', 'a new agent is a co-pilot');
  assert.equal(createAgent([], { name: 'fzhan' }, ['fzhan']).name, 'fzhan-2', "not the human's name");
  assert.throws(() => createAgent([], { maxTurns: 0 }), AgentError);

  const will = roster.find((a) => a.name === 'Will');
  const clippy = roster.find((a) => a.name === 'Clippy');
  assert.equal(updateAgent(roster, will.id, { persona: 'Sonnets only.' }).find((a) => a.id === will.id).persona, 'Sonnets only.');
  assert.throws(() => updateAgent(roster, will.id, { name: 'ROCKY' }), /taken/);
  assert.throws(() => updateAgent(roster, will.id, { id: 'a_other1' }), AgentError);
  assert.throws(() => updateAgent(roster, 'a_nobody', { persona: '' }), /no such agent/);
  assert.throws(() => updateAgent(roster, clippy.id, { role: 'copilot' }), /always a pilot/);
  const swapped = updateAgent(roster, will.id, { role: 'pilot' });
  assert.equal(pilotOf(swapped).name, 'Will');
  assert.equal(swapped.find((a) => a.id === clippy.id).role, 'copilot', 'the old pilot steps down');
  assert.throws(() => deleteAgent(roster, clippy.id), /pilot cannot be deleted/);
  assert.deepEqual(deleteAgent(roster, will.id).map((a) => a.name), ['Clippy', 'Rocky', 'Genius', 'Merlin']);
});

test('agents: editAgents changes the roster under the lock and keeps other settings', async () => {
  const dir = await tempDir();
  await updateSettings({ font: 'serif' }, dir);
  let created;
  const after = await editAgents((agents) => {
    created = createAgent(agents, { name: 'muse' });
    return [...agents, created];
  }, dir);
  assert.deepEqual(after.agents.map((a) => a.name), ['Clippy', 'Rocky', 'Will', 'Genius', 'Merlin', 'muse']);
  assert.equal(after.font, 'serif');
  await assert.rejects(editAgents((agents) => [...agents, { ...created }], dir), SettingsError, 'the same agent twice');
  assert.equal((await readSettings(dir)).settings.agents.length, 6);
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
