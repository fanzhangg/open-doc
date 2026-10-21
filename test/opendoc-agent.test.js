// The OpenDoc agent (docs/opendoc-agent.md): `turn` with a fake `infer`;
// each provider's `infer` on a fake server of its API; and the shipped
// script once, with its settings and its log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { INFER, files, turn } from '../agents/opendoc.mjs';
import { agentScript, installAgents } from '../src/store/agents.js';
import { SAMPLE } from './helpers.js';

const HEADER = '{"opendoc":1}\n';

/** A working folder holding copies of a doc and its sidecar: { dir, doc, sidecar }. */
async function copies(content = SAMPLE) {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-agent-'));
  const doc = join(dir, 'plan.md');
  const sidecar = `${doc}.opendoc.jsonl`;
  await writeFile(doc, content);
  await writeFile(sidecar, HEADER);
  return { dir, doc, sidecar };
}

let calls = 0;
/** What `infer` resolves to when the model calls the tools `[name, args]`. */
const calling = (...uses) => ({ calls: uses.map(([name, args]) => ({ id: `call_${++calls}`, name, args: JSON.stringify(args) })), sent: 'as the API sent it' });

/** A fake `infer` answering with `replies` in turn, then reading forever; `messages` is what it was last sent. */
function fake(...replies) {
  const infer = async (messages, tools) => {
    infer.messages = messages;
    infer.tools = tools;
    infer.steps = (infer.steps ?? 0) + 1;
    return replies.shift() ?? calling(['read', { path: 'plan.md' }]);
  };
  return infer;
}

const results = (messages) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('a turn reads the doc by line number and proposes an edit and a comment', async () => {
  const { doc, sidecar } = await copies();
  const edits = [{ path: doc, old: 'extra load', new: 'extra peak load' }, { path: sidecar, old: '', new: '{"body":"Is week one too soon?"}' }];
  const infer = fake(calling(['read', { path: doc, lines: [8, 8] }]), calling(['propose', { edits, reply: 'Peak load is the risk.' }]));
  assert.deepEqual(await turn({ prompt: 'the prompt', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) }), { edits, reply: 'Peak load is the risk.' });
  assert.deepEqual(infer.messages[0], { role: 'user', content: 'the prompt' }, 'the first message is the prompt as is');
  assert.deepEqual(infer.tools.map((t) => t.name), ['read', 'propose']);
  assert.deepEqual([infer.messages[1].role, infer.messages[1].sent], ['assistant', 'as the API sent it'], 'the model\'s message, kept as its API sent it');
  assert.deepEqual(infer.messages[2], { role: 'tool', id: infer.messages[1].calls[0].id, content: '8\tThe main risk is that the `sync` service cannot handle the extra load.' });
});

test('a bad proposal goes back saying what to fix', async () => {
  const { doc, sidecar } = await copies();
  const bad = [
    [{ path: doc, old: 'the', new: 'a' }, /more than once/],
    [{ path: doc, old: 'all seven features', new: 'x' }, /not in the doc/],
    [{ path: doc, old: '', new: 'x' }, /is empty/],
    [{ path: join(dirname(doc), 'other.md'), old: '', new: 'x' }, /other\.md cannot change/],
    [{ path: sidecar, old: HEADER, new: '' }, /old must be empty/],
    [{ path: sidecar, old: '', new: '{"body":"ok"}\n{"anchor":"week one","body":"no"}' }, /not a comment line: {"anchor":"week one"/],
    [{ path: sidecar, old: '', new: '{"body":"ok","resolved":true}' }, /not a comment line/],
  ];
  const overlapping = [{ path: doc, old: 'ship all six', new: 'x' }, { path: doc, old: 'all six features', new: 'y' }];
  const good = [{ path: doc, old: 'week one', new: 'week two' }, { path: sidecar, old: '', new: '{"thread":"c_1","body":"Moved."}\n' }];
  const infer = fake(...bad.map(([edit]) => calling(['propose', { edits: [good[0], edit], reply: '' }])), calling(['propose', { edits: overlapping, reply: '' }]), calling(['propose', { edits: good }]));
  assert.deepEqual(await turn({ prompt: 'p', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) }), { edits: good, reply: '' });
  const said = results(infer.messages);
  bad.forEach(([, why], i) => assert.match(said[i], new RegExp(`^Nothing was changed\\. Edit 2: .*${why.source}`)));
  assert.match(said.at(-1), /Edit 2 overlaps another edit/);
});

test('a reply without a tool call is sent back, every call is answered, and twenty steps fail', async () => {
  const { doc, sidecar } = await copies();
  const infer = fake({ calls: [], sent: 'I will read it.' }, calling(['read', { path: doc, lines: [1, 1] }], ['read', { path: sidecar }]), {
    calls: [{ id: 'bad', name: 'read', args: '{"path":' }], sent: null,
  });
  await assert.rejects(turn({ prompt: 'p', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) }), /No proposal in 20 steps/);
  assert.equal(infer.steps, 20);
  const [, , nudge, , first, second, , notJson] = infer.messages;
  assert.deepEqual(nudge, { role: 'user', content: 'Call read or propose.' });
  assert.deepEqual([first.content, second.content], ['1\t# Q4 Launch Plan', 'Not run: one tool per step.']);
  assert.deepEqual([first.id, second.id], infer.messages[3].calls.map((c) => c.id), 'each call id gets a result');
  assert.equal(notJson.content, 'The arguments are not JSON: {"path":');
});

test('a long file reads as its outline, and in parts by line number', async () => {
  const section = (title) => `## ${title}\n\n${'Some text that goes on. '.repeat(40)}\n\n`;
  const { doc, sidecar } = await copies(`# Plan\n\n${section('One')}\`\`\`sh\n# not a heading\n\`\`\`\n\n${Array.from({ length: 22 }, (_, i) => section(`S${i}`)).join('')}`);
  const infer = fake(calling(['read', { path: doc }]), calling(['read', { path: doc, lines: [3, 4] }]), calling(['read', { path: 'nowhere.md' }]), calling(['propose', { edits: [], reply: '' }]));
  await turn({ prompt: 'p', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) });
  const [outline, part, missing] = results(infer.messages);
  assert.deepEqual(outline.split('\n').slice(0, 5), [`${doc} has 98 lines, too many to read at once: read it in parts.`, 'Its headings, with their lines:', '1-2\t# Plan', '3-10\t## One', '11-14\t## S0']);
  assert.equal(part, `3\t## One\n4\t`);
  assert.equal(missing, 'nowhere.md: no such file, or not one you can read.');
});

test('in project mode the turn reads the project as the app shows it, and nothing hidden or outside', async () => {
  const { doc, sidecar } = await copies();
  const project = await mkdtemp(join(tmpdir(), 'opendoc-project-'));
  const outside = await mkdtemp(join(tmpdir(), 'opendoc-outside-'));
  await mkdir(join(project, 'notes'));
  await mkdir(join(project, '.git'));
  await writeFile(join(project, 'notes', 'a.md'), 'A\n');
  await writeFile(join(project, 'notes', 'a.md.opendoc.jsonl'), HEADER);
  await writeFile(join(project, '.git', 'config'), 'secret');
  await writeFile(join(project, '.env'), 'secret');
  await writeFile(join(outside, 'b.md'), 'secret');
  await symlink(outside, join(project, 'out'), 'junction');
  const readable = files({ doc, sidecar, project });
  assert.deepEqual(await readable(''), ['notes/', 'out'], 'a folder, its entries');
  assert.deepEqual(await readable('notes'), ['a.md', 'a.md.opendoc.jsonl']);
  assert.equal(await readable(join(project, 'notes', 'a.md')), 'A\n');
  assert.equal(await readable('notes/a.md.opendoc.jsonl'), HEADER, 'sidecars included');
  assert.equal(await readable(doc), SAMPLE, 'and the copies');
  for (const path of ['.env', '.git/config', 'notes/../.env', `../${basename(outside)}/b.md`, join(outside, 'b.md'), 'out/b.md', 'notes/none.md']) {
    assert.equal(await readable(path), null, path);
  }
  assert.equal(await files({ doc, sidecar })('notes/a.md'), null, 'in doc mode, only the copies');
});

/**
 * A fake API on 127.0.0.1: `answers` are [status, body] in turn; `requests`
 * what it was sent, { url, headers, body }. `url` is its address.
 */
async function fakeApi(answers) {
  const requests = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(await text(req)) });
    const [status, body] = answers.shift();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

test('Anthropic: the Messages API, the tools and the prompt cached, the model\'s content sent back as it came, a refusal fails', async () => {
  const { doc, sidecar } = await copies();
  const thinking = { type: 'thinking', thinking: '', signature: 'sig' }; // must go back as it came
  const api = await fakeApi([
    [200, { stop_reason: 'tool_use', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: doc, lines: [1, 1] } }] }],
    [200, { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 'toolu_2', name: 'propose', input: { edits: [], reply: 'Fine as is.' } }] }],
    [200, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Not this.' }, content: [] }],
  ]);
  try {
    const infer = INFER.anthropic({ model: 'claude-opus-5-5', key: 'sk-ant-test', effort: 'low' }, api.url);
    assert.deepEqual(await turn({ prompt: 'the prompt', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) }), { edits: [], reply: 'Fine as is.' });
    const [first, second] = api.requests;
    assert.equal(first.url, '/v1/messages');
    assert.equal(first.body.messages.length, 1, 'the first step is the prompt alone');
    assert.equal(first.headers['x-api-key'], 'sk-ant-test');
    assert.equal(first.headers['anthropic-version'], '2023-06-01');
    const { tools, messages, ...rest } = second.body;
    assert.deepEqual(rest, { model: 'claude-opus-5-5', max_tokens: 16_000, output_config: { effort: 'low' }, tool_choice: { type: 'auto' } }, 'no thinking setting: the model thinks as it needs');
    assert.deepEqual(tools.map((t) => [t.name, Object.keys(t.input_schema.properties).join(), t.cache_control]), [['read', 'path,lines', undefined], ['propose', 'edits,reply', { type: 'ephemeral' }]]);
    assert.deepEqual(messages, [
      { role: 'user', content: [{ type: 'text', text: 'the prompt', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: doc, lines: [1, 1] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\t# Q4 Launch Plan' }] },
    ]);
    await assert.rejects(infer(messages, []), /^Error: The model refused: Not this\.$/);
  } finally {
    await api.close();
  }
});

test('OpenAI-compatible: Chat Completions at the endpoint, with the key and the effort', async () => {
  const { doc, sidecar } = await copies();
  const read = { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: doc, lines: [1, 1] }) } }] };
  const propose = { role: 'assistant', content: null, tool_calls: [{ id: 'call_b', type: 'function', function: { name: 'propose', arguments: '{"edits":[],"reply":"ok"}' } }] };
  const api = await fakeApi([[200, { choices: [{ message: read }] }], [200, { choices: [{ message: propose }] }]]);
  try {
    const infer = INFER.openai({ endpoint: `${api.url}/`, model: 'gpt-5', key: 'sk-test', effort: 'medium' });
    assert.deepEqual(await turn({ prompt: 'the prompt', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) }), { edits: [], reply: 'ok' });
    const [, { url, headers, body }] = api.requests;
    assert.equal(url, '/v1/chat/completions');
    assert.equal(headers.authorization, 'Bearer sk-test');
    assert.deepEqual([body.model, body.reasoning_effort, body.tool_choice], ['gpt-5', 'medium', 'auto']);
    assert.deepEqual(body.tools.map((t) => [t.type, t.function.name]), [['function', 'read'], ['function', 'propose']]);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'the prompt' }, read, { role: 'tool', tool_call_id: 'call_a', content: '1\t# Q4 Launch Plan' }]);
  } finally {
    await api.close();
  }
});

test('the shipped script runs a turn under the contract, with its settings from the environment', { skip: process.platform === 'win32' }, async () => {
  const answers = [];
  const api = await fakeApi(answers);
  try {
    const config = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
    await installAgents(config, { platform: 'linux' });
    const { dir, doc, sidecar } = await copies();
    const settings = { PROVIDER: 'openai', ENDPOINT: api.url, MODEL: 'gpt-5', KEY: 'sk-secret-test', EFFORT: 'low' };
    const run = (PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`, own = settings) => new Promise((resolve) => {
      const env = { ...process.env, PATH, OPENDOC_DOC: doc, OPENDOC_COMMENTS: sidecar, OPENDOC_PROJECT: '', OPENDOC_BUDDY: 'Ada' };
      for (const [key, value] of Object.entries(own)) env[`OPENDOC_SETTING_${key}`] = value;
      const child = execFile(agentScript('opendoc', config, 'linux'), { cwd: dir, env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
      child.stdin.on('error', () => {}); // a run that fails early need not read its prompt
      child.stdin.end('the prompt');
    });

    const edits = [{ path: doc, old: 'week one', new: 'week two' }, { path: sidecar, old: '', new: '{"body":"Two weeks?"}' }];
    answers.push([200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose', arguments: JSON.stringify({ edits, reply: 'Moved it.' }) } }] } }] }]);
    assert.deepEqual(await run(), { code: 0, stdout: 'Moved it.', stderr: '' });
    assert.equal(await readFile(doc, 'utf8'), SAMPLE.replace('week one', 'week two'));
    assert.equal(await readFile(sidecar, 'utf8'), `${HEADER}{"body":"Two weeks?"}\n`);
    assert.deepEqual([api.requests[0].body.model, api.requests[0].headers.authorization], ['gpt-5', 'Bearer sk-secret-test']);

    // A failed run's reply says what failed, then what to change and where.
    answers.push([404, { error: 'model "gpt-5" not found' }]);
    const failed = await run();
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, `${api.url}/chat/completions: 404 {"error":"model \\"gpt-5\\" not found"}\nCheck the endpoint and the model.\nThe provider, endpoint, model and key are in Settings > Agents > OpenDoc agent.\n`);
    assert.deepEqual(await run(undefined, { ...settings, KEY: '' }), { code: 1, stdout: '', stderr: 'No API key: set one in Settings > Agents > OpenDoc agent.\n' });

    const log = await readFile(join(config, 'logs', 'opendoc.jsonl'), 'utf8');
    assert.deepEqual(log.trim().split('\n').map((l) => JSON.parse(l)).map((entry) => [entry.buddy, entry.messages.map((m) => m.role), entry.error]), [
      ['Ada', ['user', 'assistant'], null],
      ['Ada', ['user'], failed.stderr.trim()],
      ['Ada', [], 'No API key: set one in Settings > Agents > OpenDoc agent.'],
    ], 'each turn\'s messages are logged');
    assert.doesNotMatch(log, /sk-secret-test/, 'never the key');

    await api.close();
    assert.match((await run()).stderr, new RegExp(`^Cannot reach ${api.url}/chat/completions \\(ECONNREFUSED\\)\\.\nThe provider, endpoint, model and key are in Settings > Agents > OpenDoc agent\\.`));
    assert.deepEqual(await run('/nowhere'), { code: 1, stdout: '', stderr: 'The OpenDoc agent runs on Node.js: install it from https://nodejs.org, with node on PATH.\n' });
  } finally {
    await api.close().catch(() => {});
  }
});
