import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, SettingsError, checkSettingsPatch, pluginSettings, resolveSettings } from '../src/core/settings.js';
import { configDir, readSettings, settingsPath, updateSettings, watchSettings } from '../src/store/settings.js';
import { markdown } from '../web/plugins/markdown/index.js';
import { markdownHarness } from '../src/plugins/markdown.js';

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
  assert.doesNotThrow(() => checkSettingsPatch({ font: 'serif', wordCount: true, name: 'fzhan' }));
  assert.doesNotThrow(() => checkSettingsPatch({ name: null }));
  assert.throws(() => checkSettingsPatch({ font: 'comic' }), SettingsError);
  assert.throws(() => checkSettingsPatch({ colour: 'red' }), /unknown setting/);
  assert.throws(() => checkSettingsPatch({ wordCount: 'yes' }), SettingsError);
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
  assert.equal(raw.version, 2);
});

test('a bad patch writes nothing', async () => {
  const dir = await tempDir();
  await assert.rejects(updateSettings({ font: 'serif', width: 'huge' }, dir), SettingsError);
  assert.equal((await readSettings(dir)).saved, false);
});

test('keys from a newer version are kept on write', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), JSON.stringify({ version: 3, font: 'mono', agent: { enabled: true } }));
  await updateSettings({ wordCount: true }, dir);
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.deepEqual(raw.agent, { enabled: true });
  assert.equal(raw.font, 'mono');
  assert.equal(raw.wordCount, true);
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

test('concurrent writers of different plugin switches all keep their change', async () => {
  const dir = await tempDir();
  const script = join(dir, 'writer.mjs');
  const store = new URL('../src/store/settings.js', import.meta.url).href;
  await writeFile(script, `import { updateSettings } from ${JSON.stringify(store)};
const [key, value] = process.argv.slice(2);
const set = (on) => updateSettings({ plugins: { markdown: { [key]: on } } }, process.env.DIR);
for (let i = 0; i < 20; i++) await set(i % 2 === 0 ? value === 'true' : value !== 'true');
await set(value === 'true');`);
  const run = (key, value) => new Promise((resolve, reject) => {
    fork(script, [key, value], { env: { ...process.env, DIR: dir } }).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  await Promise.all([run('focus', 'true'), run('enabled', 'false'), run('outline', 'false')]);
  const { settings } = await readSettings(dir);
  assert.deepEqual(settings.plugins.markdown, { focus: true, enabled: false, outline: false });
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

test('agent: which agent script runs every buddy, Claude Code unless changed', () => {
  assert.equal(DEFAULT_SETTINGS.agent, 'claude');
  assert.doesNotThrow(() => checkSettingsPatch({ agent: 'codex' }));
  assert.throws(() => checkSettingsPatch({ agent: '../evil' }), SettingsError);
  assert.equal(resolveSettings({ agent: 'my-bot' }).agent, 'my-bot');
  assert.equal(resolveSettings({ agent: 'a/b' }).agent, 'claude');
  assert.throws(() => checkSettingsPatch({ claudeBin: '/opt/claude' }), /unknown setting: claudeBin/);
});

test('plugins: defaults come from the declaration; the old top-level outline and focus are gone', () => {
  assert.deepEqual(DEFAULT_SETTINGS.plugins, {});
  assert.deepEqual(pluginSettings(resolveSettings(null), markdown), { enabled: true, outline: true, focus: false });
  assert.deepEqual(resolveSettings({ outline: false, focus: true }), DEFAULT_SETTINGS);
  assert.throws(() => checkSettingsPatch({ focus: true }), /unknown setting: focus/);
});

test('plugins: a switch changed is saved alone and survives a fresh read', async () => {
  const dir = await tempDir();
  await updateSettings({ plugins: { markdown: { enabled: false } } }, dir);
  await updateSettings({ plugins: { markdown: { focus: true } } }, dir);
  const { settings } = await readSettings(dir);
  assert.deepEqual(settings.plugins, { markdown: { enabled: false, focus: true } });
  assert.deepEqual(pluginSettings(settings, markdown), { enabled: false, outline: true, focus: true });
});

test('plugins: only booleans, strings and numbers by plugin id; a bad value falls back alone', () => {
  assert.doesNotThrow(() => checkSettingsPatch({ plugins: { markdown: { outline: false }, csv: {} } }));
  for (const plugins of [[], null, { markdown: true }, { markdown: { focus: null } }, { markdown: { focus: {} } }, { markdown: [] }]) {
    assert.throws(() => checkSettingsPatch({ plugins }), SettingsError, JSON.stringify(plugins));
  }
  assert.deepEqual(resolveSettings({ plugins: 'on' }).plugins, {});
  const resolved = resolveSettings({ plugins: { markdown: { enabled: 'no', outline: false }, broken: 3 } });
  assert.deepEqual(resolved.plugins, { markdown: { enabled: 'no', outline: false } });
  assert.deepEqual(pluginSettings(resolved, markdown), { enabled: true, outline: false, focus: false });
});

test('plugins: ids this version does not know are kept', async () => {
  const dir = await tempDir();
  await writeFile(settingsPath(dir), JSON.stringify({ version: 2, plugins: { csv: { enabled: false, header: true } } }));
  assert.deepEqual((await readSettings(dir)).settings.plugins, { csv: { enabled: false, header: true } });
  await updateSettings({ plugins: { markdown: { outline: false } } }, dir);
  const raw = JSON.parse(await readFile(settingsPath(dir), 'utf8'));
  assert.deepEqual(raw.plugins, { csv: { enabled: false, header: true }, markdown: { outline: false } });
});

test('plugins: a value is kept only if its field allows it, else the default', () => {
  const plugin = {
    id: 'demo',
    settings: [
      { key: 'on', type: 'switch', default: true },
      { key: 'mode', type: 'choice', options: [['a', 'A'], [4, 'Four']], default: 'a' },
      { key: 'size', type: 'number', min: 12, max: 20, default: 14 },
    ],
  };
  const own = (demo) => pluginSettings(resolveSettings({ plugins: { demo } }), plugin);
  assert.deepEqual(own({}), { enabled: true, on: true, mode: 'a', size: 14 });
  assert.deepEqual(own({ on: false, mode: 4, size: 20, enabled: false }), { enabled: false, on: false, mode: 4, size: 20 });
  assert.deepEqual(own({ on: 'x', mode: 'b', size: 21 }), { enabled: true, on: true, mode: 'a', size: 14 });
  assert.deepEqual(own({ mode: '4', size: 13.5 }), { enabled: true, on: true, mode: 'a', size: 14 });
  assert.doesNotThrow(() => checkSettingsPatch({ plugins: { demo: { mode: 'a', size: 16 } } }));
});

test('plugins: on by default, the Markdown editor and its harness included', () => {
  assert.equal(pluginSettings(resolveSettings(null), markdown).enabled, true);
  assert.equal(pluginSettings(resolveSettings(null), markdownHarness).enabled, true);
});
