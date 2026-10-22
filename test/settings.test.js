import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, SettingsError, agentOf, agentSettings, checkSettingsPatch, resolveSettings, ruleSettings, viewSettings } from '../src/core/settings.js';
import { configDir, readSettings, settingsPath, updateSettings, watchSettings } from '../src/store/settings.js';
import { markdown } from '../web/views/markdown/index.js';
import { markdownRule } from '../src/rules/markdown.js';

const MARKDOWN_DEFAULTS = { font: 'sans', width: 'normal', outline: true, focus: false, wordCount: false };
const tempDir = () => mkdtemp(join(tmpdir(), 'ponjo-settings-'));

test('configDir follows each OS convention and the override', () => {
  const home = '/home/u';
  assert.equal(configDir({ PONJO_CONFIG_DIR: '/x' }, 'win32', home), '/x');
  assert.equal(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', home), join('C:\\Users\\u\\AppData\\Roaming', 'OpenDoc'));
  assert.equal(configDir({}, 'darwin', home), join(home, 'Library', 'Application Support', 'OpenDoc'));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', home), join('/cfg', 'opendoc'));
  assert.equal(configDir({}, 'linux', home), join(home, '.config', 'opendoc'));
});

test('patches are checked key by key', () => {
  assert.doesNotThrow(() => checkSettingsPatch({ theme: 'dark', name: 'fzhan', about: 'I write novels.' }));
  assert.doesNotThrow(() => checkSettingsPatch({ name: null }));
  assert.throws(() => checkSettingsPatch({ theme: 'comic' }), SettingsError);
  assert.throws(() => checkSettingsPatch({ colour: 'red' }), /unknown setting/);
  assert.throws(() => checkSettingsPatch({ font: 'serif' }), /unknown setting: font/);
  assert.throws(() => checkSettingsPatch({ about: 5 }), SettingsError);
  assert.throws(() => checkSettingsPatch({ name: 'two words' }), SettingsError);
  assert.throws(() => checkSettingsPatch([]), SettingsError);
});

test('resolveSettings keeps valid values and defaults the rest', () => {
  assert.deepEqual(resolveSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(resolveSettings({ theme: 'dark', agent: 'a/b', extra: 1 }), { ...DEFAULT_SETTINGS, theme: 'dark' });
});

test('no file: defaults, not saved, and nothing is created', async () => {
  const dir = join(await tempDir(), 'nested');
  assert.deepEqual(await readSettings(dir), { settings: DEFAULT_SETTINGS, saved: false });
  await assert.rejects(stat(dir));
});

test('updates merge, create the folder, and survive a fresh read', async () => {
  const dir = join(await tempDir(), 'nested');
  await updateSettings({ name: 'ada' }, dir);
  const after = await updateSettings({ theme: 'dark' }, dir);
  assert.deepEqual(after, { ...DEFAULT_SETTINGS, name: 'ada', theme: 'dark' });
  assert.deepEqual(await readSettings(dir), { settings: after, saved: true });
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.equal(raw.version, 3);
});

test('a bad patch writes nothing', async () => {
  const dir = await tempDir();
  await assert.rejects(updateSettings({ name: 'ada', theme: 'huge' }, dir), SettingsError);
  assert.equal((await readSettings(dir)).saved, false);
});

test('keys from a newer version are kept on write', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), JSON.stringify({ version: 4, newer: 'mono', agent: { enabled: true } }));
  await updateSettings({ name: 'ada' }, dir);
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.deepEqual(raw.agent, { enabled: true });
  assert.equal(raw.newer, 'mono');
  assert.equal(raw.name, 'ada');
});

test('a corrupt file is set aside and defaults are used', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), '{ not json');
  const { settings } = await readSettings(dir);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.equal(await readFile(settingsPath(dir) + '.bak', 'utf8'), '{ not json');
  await updateSettings({ theme: 'dark' }, dir);
  assert.equal((await readSettings(dir)).settings.theme, 'dark');
});

test('concurrent writers of different view switches all keep their change', async () => {
  const dir = await tempDir();
  const script = join(dir, 'writer.mjs');
  const store = new URL('../src/store/settings.js', import.meta.url).href;
  await writeFile(script, `import { updateSettings } from ${JSON.stringify(store)};
const [key, value] = process.argv.slice(2);
const set = (on) => updateSettings({ views: { markdown: { [key]: on } } }, process.env.DIR);
for (let i = 0; i < 20; i++) await set(i % 2 === 0 ? value === 'true' : value !== 'true');
await set(value === 'true');`);
  const run = (key, value) => new Promise((resolve, reject) => {
    fork(script, [key, value], { env: { ...process.env, DIR: dir } }).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([run('focus', 'true'), run('enabled', 'false'), run('outline', 'false')]);
  const { settings } = await readSettings(dir);
  assert.deepEqual(settings.views.markdown, { focus: true, enabled: false, outline: false });
});

test('watchSettings sees the file appear and change', async () => {
  const dir = join(await tempDir(), 'later');
  let calls = 0;
  const stop = watchSettings(() => { calls++; }, dir);
  try {
    await new Promise((resolve) => setTimeout(resolve, 600)); // first poll records "missing"
    await updateSettings({ theme: 'dark' }, dir);
    const deadline = Date.now() + 3000;
    while (calls === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(calls > 0);
  } finally {
    stop();
  }
});

test('agent: which agent script runs every buddy, Claude Code unless changed', () => {
  assert.equal(DEFAULT_SETTINGS.agent, 'claude');
  assert.doesNotThrow(() => checkSettingsPatch({ agent: 'codex' }));
  assert.throws(() => checkSettingsPatch({ agent: '../evil' }), SettingsError);
  assert.equal(resolveSettings({ agent: 'my-bot' }).agent, 'my-bot');
  assert.equal(resolveSettings({ agent: 'a/b' }).agent, 'claude');
  assert.throws(() => checkSettingsPatch({ claudeBin: '/opt/claude' }), /unknown setting: claudeBin/);
});

test('views: defaults come from the declaration; the old top-level outline and focus are gone', () => {
  assert.deepEqual([DEFAULT_SETTINGS.views, DEFAULT_SETTINGS.rules], [{}, {}]);
  assert.deepEqual(viewSettings(resolveSettings(null), markdown), { enabled: true, ...MARKDOWN_DEFAULTS });
  assert.deepEqual(resolveSettings({ outline: false, focus: true }), DEFAULT_SETTINGS);
  assert.throws(() => checkSettingsPatch({ focus: true }), /unknown setting: focus/);
});

test('views: a switch changed is saved alone and survives a fresh read', async () => {
  const dir = await tempDir();
  await updateSettings({ views: { markdown: { enabled: false } } }, dir);
  await updateSettings({ views: { markdown: { focus: true } } }, dir);
  const { settings } = await readSettings(dir);
  assert.deepEqual(settings.views, { markdown: { enabled: false, focus: true } });
  assert.deepEqual(viewSettings(settings, markdown), { enabled: false, ...MARKDOWN_DEFAULTS, focus: true });
});

test('views and rules: only booleans, strings and numbers by id; a bad value falls back alone', () => {
  assert.doesNotThrow(() => checkSettingsPatch({ views: { markdown: { outline: false }, csv: {} }, rules: { 'markdown-rule': { enabled: false } } }));
  for (const bad of [[], null, { markdown: true }, { markdown: { focus: null } }, { markdown: { focus: {} } }, { markdown: [] }]) {
    for (const kind of ['views', 'rules']) assert.throws(() => checkSettingsPatch({ [kind]: bad }), SettingsError, JSON.stringify(bad));
  }
  assert.deepEqual(resolveSettings({ views: 'on' }).views, {});
  const resolved = resolveSettings({ views: { markdown: { enabled: 'no', outline: false }, broken: 3 } });
  assert.deepEqual(resolved.views, { markdown: { enabled: 'no', outline: false } });
  assert.deepEqual(viewSettings(resolved, markdown), { enabled: true, ...MARKDOWN_DEFAULTS, outline: false });
});

test('views and rules: ids this version does not know are kept', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), JSON.stringify({ version: 3, views: { csv: { enabled: false, header: true } } }));
  assert.deepEqual((await readSettings(dir)).settings.views, { csv: { enabled: false, header: true } });
  await updateSettings({ views: { markdown: { outline: false } } }, dir);
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.deepEqual(raw.views, { csv: { enabled: false, header: true }, markdown: { outline: false } });
});

test('views: a value is kept only if its field allows it, else the default', () => {
  const view = {
    id: 'demo',
    settings: [
      { key: 'on', type: 'switch', default: true },
      { key: 'mode', type: 'choice', options: [['a', 'A'], [4, 'Four']], default: 'a' },
      { key: 'size', type: 'number', min: 12, max: 20, default: 14 },
    ],
  };
  const own = (demo) => viewSettings(resolveSettings({ views: { demo } }), view);
  assert.deepEqual(own({}), { enabled: true, on: true, mode: 'a', size: 14 });
  assert.deepEqual(own({ on: false, mode: 4, size: 20, enabled: false }), { enabled: false, on: false, mode: 4, size: 20 });
  assert.deepEqual(own({ on: 'x', mode: 'b', size: 21 }), { enabled: true, on: true, mode: 'a', size: 14 });
  assert.deepEqual(own({ mode: '4', size: 13.5 }), { enabled: true, on: true, mode: 'a', size: 14 });
  assert.doesNotThrow(() => checkSettingsPatch({ views: { demo: { mode: 'a', size: 16 } } }));
});

test('views and rules: on by default, the Markdown view and its rule included, and switched apart', () => {
  const fresh = resolveSettings(null);
  assert.equal(viewSettings(fresh, markdown).enabled, true);
  assert.equal(ruleSettings(fresh, markdownRule).enabled, true);
  const viewOff = resolveSettings({ views: { markdown: { enabled: false } } });
  assert.equal(viewSettings(viewOff, markdown).enabled, false);
  assert.equal(ruleSettings(viewOff, markdownRule).enabled, true, 'the rule is another switch');
  const ruleOff = resolveSettings({ rules: { 'markdown-rule': { enabled: false } } });
  assert.equal(ruleSettings(ruleOff, markdownRule).enabled, false);
  assert.equal(viewSettings(ruleOff, markdown).enabled, true, 'the view is another switch');
});

test('views: an always-on view stays enabled whatever is stored', () => {
  const plain = { id: 'plain', always: true, settings: [] };
  assert.equal(viewSettings(resolveSettings({ views: { plain: { enabled: false } } }), plain).enabled, true);
});

test('agents: a manifest declares the fields; one that is not valid leaves the agent its file name and no settings', () => {
  const settings = [
    { key: 'model', type: 'text', label: 'Model', default: '' },
    { key: 'key', type: 'secret', label: 'API key' },
    { key: 'effort', type: 'choice', label: 'Effort', options: [['low', 'Low'], ['high', 'High']], default: 'low', when: { model: { not: '' } } },
  ];
  assert.deepEqual(agentOf('bot', { name: 'Bot', about: 'Mine.', settings }), { id: 'bot', name: 'Bot', about: 'Mine.', settings });
  assert.deepEqual(agentOf('bot', { name: 'Bot' }), { id: 'bot', name: 'Bot', about: '', settings: [] });
  const none = { id: 'bot', name: 'bot', about: '', settings: [] };
  for (const bad of [null, [], 'Bot', { name: '' }, { name: 'Bot', about: 3 }, { name: 'Bot', settings: {} }]) assert.deepEqual(agentOf('bot', bad), none, JSON.stringify(bad));
  for (const field of [
    { key: 'Model', type: 'text', label: 'Model', default: '' }, // a key names PONJO_SETTING_<KEY>: lower case only
    { key: 'a-b', type: 'text', label: 'A', default: '' },
    { key: 'model', type: 'url', label: 'Model', default: '' },
    { key: 'model', type: 'text', default: '' },
    { key: 'model', type: 'text', label: 'Model', default: 'two\nlines' },
    { key: 'model', type: 'text', label: 'Model' },
    { key: 'key', type: 'secret', label: 'Key', default: 'sk-shipped' }, // a secret has no default
    { key: 'mode', type: 'choice', label: 'Mode', options: ['a'], default: 'a' },
    { key: 'n', type: 'number', label: 'N', default: 1 },
    { key: 'model', type: 'text', label: 'Model', default: '', when: 'always' },
  ]) assert.deepEqual(agentOf('bot', { name: 'Bot', settings: [field] }), none, JSON.stringify(field));
  assert.deepEqual(agentOf('bot', { name: 'Bot', settings: [settings[0], settings[0]] }), none, 'keys are unique');
});

test('agents: settings by agent id, stored as a view\'s; a secret only from the keychain, never from settings.json', () => {
  const agent = agentOf('bot', { name: 'Bot', settings: [
    { key: 'model', type: 'text', label: 'Model', default: 'big' },
    { key: 'key', type: 'secret', label: 'API key' },
    { key: 'fast', type: 'switch', label: 'Fast', default: false },
  ] });
  assert.doesNotThrow(() => checkSettingsPatch({ agents: { bot: { model: 'small' } } }));
  assert.throws(() => checkSettingsPatch({ agents: { bot: { model: null } } }), SettingsError);
  assert.deepEqual(agentSettings(resolveSettings(null), agent), { model: 'big', key: undefined, fast: false });
  const stored = resolveSettings({ agents: { bot: { model: 'small', key: 'sk-in-the-file', fast: 'yes' }, other: { x: 1 } } });
  assert.deepEqual(stored.agents.other, { x: 1 }, 'ids this version does not know are kept');
  assert.deepEqual(agentSettings(stored, agent), { model: 'small', key: undefined, fast: false });
  assert.deepEqual(agentSettings(stored, agent, { key: 'sk-secret' }), { model: 'small', key: 'sk-secret', fast: false });
  assert.equal(agentSettings(resolveSettings({ agents: { bot: { model: 'a\nb' } } }), agent).model, 'big', 'a line of text');
});

test('a version 2 file is read as it is', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), JSON.stringify({ version: 2, id: 'u_old00001' }));
  assert.deepEqual(await readSettings(dir), { settings: { ...DEFAULT_SETTINGS, id: 'u_old00001' }, saved: false });
});
