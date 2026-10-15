import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DEFAULTS, RUNTIMES as AGENT_RUNTIMES } from '../src/core/agents.js';
import { RUNTIMES, agentSpec, hooksWarning } from '../src/server/agents/config.js';
import { buildPrompt, privateWorkdir } from '../src/server/agents/adapters.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'opendoc-agentcfg-'));
const agent = (fields) => ({ ...AGENT_DEFAULTS, id: 'a_test01', name: 'claude', ...fields });

test('agentSpec: each runtime builds its adapter; the persona and limits carry over', async () => {
  const dir = await tempDir();
  const doc = join(dir, 'plan.md');
  const claude = agentSpec(agent({ persona: 'Be terse.', runTimeoutMinutes: 3, runsPerHour: 7, editMode: 'approve' }), { claudeBin: join(dir, 'claude.exe') }, doc);
  assert.equal(claude.name, 'claude');
  assert.equal(claude.id, 'a_test01');
  assert.equal(claude.persona, 'Be terse.');
  assert.equal(claude.adapter.name, 'claude');
  assert.equal(claude.adapter.program, join(dir, 'claude.exe'));
  assert.deepEqual(claude.limits, { timeoutMs: 3 * 60 * 1000, runsPerHour: 7 });
  assert.equal(claude.editMode, 'approve');
  assert.equal(claude.presence, 'dnd', 'answers only when @mentioned');
  assert.equal(agentSpec(agent({ autoComment: true }), { claudeBin: null }, doc).presence, 'online', 'with Auto Commenter, also open comments');
  const searcher = agentSpec(agent({ webAccess: true }), { claudeBin: 'claude' }, doc).adapter.command({ prompt: 'P', docFile: 'plan.md', docPath: doc }).args;
  assert.ok(searcher.includes('WebSearch'), 'Web Searcher is granted as switched on');

  const custom = agentSpec(agent({ runtime: 'custom', name: 'bot', command: 'mybot --prompt-file {promptFile}' }), { claudeBin: null }, doc);
  assert.equal(custom.adapter.name, 'custom');
  assert.equal(custom.adapter.program, 'mybot');

  const codexAgent = agent({ runtime: 'codex', name: 'codex', model: 'gpt-5', persona: 'Be terse.', webAccess: true });
  const offline = agentSpec({ ...codexAgent, webAccess: false }, { claudeBin: null }, doc).adapter.command({ prompt: 'P', docFile: 'plan.md', docPath: doc }).args;
  assert.ok(offline.includes('web_search="disabled"'));
  const codex = agentSpec(codexAgent, { claudeBin: join(dir, 'claude.exe'), codexBin: join(dir, 'codex.exe') }, doc);
  assert.equal(codex.adapter.name, 'codex');
  assert.equal(codex.adapter.program, join(dir, 'codex.exe'), 'Agents > Programs > Codex');
  assert.equal(codex.persona, 'Be terse.');
  assert.equal(codex.adapter.supportsSessions, true);
  assert.equal(codex.adapter.workdir(doc), privateWorkdir(doc, 'codex'));
  const args = codex.adapter.command({ prompt: 'PROMPT', docFile: 'plan.md', docPath: doc }).args;
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'gpt-5']);
  assert.ok(args.includes('web_search="live"'));
  assert.equal(codex.warning, null, 'Claude Code hooks do not apply to Codex');
  assert.deepEqual(Object.keys(RUNTIMES), ['claude', 'codex', 'custom']);
  assert.deepEqual(Object.keys(RUNTIMES), [...AGENT_RUNTIMES]);
});

test('a custom agent without a command, or a runtime this version lacks, is unavailable with a reason', async () => {
  const doc = join(await tempDir(), 'plan.md');
  const noCommand = await agentSpec(agent({ runtime: 'custom', name: 'bot' }), { claudeBin: null }, doc).adapter.preflight();
  assert.equal(noCommand.ok, false);
  assert.match(noCommand.error, /No command is set for bot; set it in Agents > Advanced/);
  const unknown = await agentSpec(agent({ runtime: 'gemini' }), { claudeBin: null }, doc).adapter.preflight();
  assert.match(unknown.error, /gemini agents are not supported/);
});

test('every Claude agent of a doc starts in a folder of its own', () => {
  const doc = join(tmpdir(), 'plan.md');
  assert.notEqual(privateWorkdir(doc, 'muse'), privateWorkdir(doc, 'fact-checker'));
  assert.equal(privateWorkdir(doc, 'Muse'), privateWorkdir(doc, 'muse'));
  assert.equal(agentSpec(agent({ name: 'muse' }), { claudeBin: 'claude' }, doc).adapter.workdir(doc), privateWorkdir(doc, 'muse'));
});

test('the prompt carries the persona and names the other agents, for any runtime', () => {
  const plain = buildPrompt({ name: 'muse', docFile: 'plan.md' });
  assert.doesNotMatch(plain, /persona/i);
  assert.doesNotMatch(plain, /Other agents/);
  const prompt = buildPrompt({ name: 'muse', docFile: 'plan.md', persona: '  You are a poet.\nBe bold.  ', others: ['fact-checker', 'grammar-police'] });
  assert.match(prompt, /<persona>\nYou are a poet\.\nBe bold\.\n<\/persona>/);
  assert.match(prompt, /not the rules below or your tools and permissions/);
  assert.match(prompt, /Other agents in this doc: @fact-checker, @grammar-police/);
  assert.ok(prompt.indexOf('<persona>') < prompt.indexOf('Never resolve a thread'), 'the rules come after the persona');
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
