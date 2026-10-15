import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT } from '../src/core/settings.js';
import { agentFromSettings, hooksWarning } from '../src/server/agents/config.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'opendoc-agentcfg-'));

test('agentFromSettings: off is null; on builds the adapter and limits', async () => {
  const dir = await tempDir();
  const doc = join(dir, 'plan.md');
  assert.equal(agentFromSettings(DEFAULT_AGENT, doc), null);

  const claude = agentFromSettings({ ...DEFAULT_AGENT, enabled: true, bin: join(dir, 'claude.exe'), runTimeoutMinutes: 3, runsPerHour: 7, editMode: 'approve' }, doc);
  assert.equal(claude.name, 'claude');
  assert.equal(claude.adapter.name, 'claude');
  assert.equal(claude.adapter.program, join(dir, 'claude.exe'));
  assert.deepEqual(claude.limits, { timeoutMs: 3 * 60 * 1000, runsPerHour: 7 });
  assert.equal(claude.editMode, 'approve');

  const custom = agentFromSettings({ ...DEFAULT_AGENT, enabled: true, kind: 'custom', name: 'bot', command: 'mybot --prompt-file {promptFile}' }, doc);
  assert.equal(custom.adapter.name, 'custom');
  assert.equal(custom.adapter.program, 'mybot');
});

test('a custom agent without a command is unavailable, with a reason', async () => {
  const agent = agentFromSettings({ ...DEFAULT_AGENT, enabled: true, kind: 'custom' }, join(await tempDir(), 'plan.md'));
  const result = await agent.adapter.preflight();
  assert.equal(result.ok, false);
  assert.match(result.error, /Settings > Agent/);
});

test('hooksWarning names the project settings that define hooks, unless runs are isolated', async () => {
  const dir = await tempDir();
  const doc = join(dir, 'docs', 'plan.md');
  await mkdir(join(dir, '.claude'), { recursive: true });
  await mkdir(join(dir, 'docs'));
  const claude = { name: 'claude' };
  assert.equal(hooksWarning(claude, false, doc), null);
  await writeFile(join(dir, '.claude', 'settings.json'), '{ "hooks": { "Stop": [] } }');
  assert.match(hooksWarning(claude, false, doc), /settings\.json defines hooks/);
  assert.equal(hooksWarning(claude, true, doc), null);
  assert.equal(hooksWarning({ name: 'custom' }, false, doc), null);
  // A run kept to the doc starts in its own folder, outside the project.
  const elsewhere = await tempDir();
  assert.equal(hooksWarning({ name: 'claude', workdir: () => elsewhere }, false, doc), null);
});
