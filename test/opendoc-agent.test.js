// The OpenDoc agent (docs/opendoc-agent.md): `turn` with a fake `infer`, and
// the shipped script once, on a fake Chat Completions server, with its log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { files, turn } from '../agents/opendoc.mjs';
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
/** The model's message calling the tools `[name, args]`. */
const calling = (...uses) => ({
  role: 'assistant',
  content: null,
  tool_calls: uses.map(([name, args]) => ({ id: `call_${++calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
});

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
  assert.deepEqual(infer.tools.map((t) => t.function.name), ['read', 'propose']);
  assert.deepEqual(infer.messages[2], { role: 'tool', tool_call_id: infer.messages[1].tool_calls[0].id, content: '8\tThe main risk is that the `sync` service cannot handle the extra load.' });
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
  const infer = fake({ role: 'assistant', content: 'I will read it.' }, calling(['read', { path: doc, lines: [1, 1] }], ['read', { path: sidecar }]), {
    role: 'assistant', content: null, tool_calls: [{ id: 'bad', type: 'function', function: { name: 'read', arguments: '{"path":' } }],
  });
  await assert.rejects(turn({ prompt: 'p', doc, sidecar }, { infer, readFile: files({ doc, sidecar }) }), /No proposal in 20 steps/);
  assert.equal(infer.steps, 20);
  const [, , nudge, , first, second, , notJson] = infer.messages;
  assert.deepEqual(nudge, { role: 'user', content: 'Call read or propose.' });
  assert.deepEqual([first.content, second.content], ['1\t# Q4 Launch Plan', 'Not run: one tool per step.']);
  assert.deepEqual([first.tool_call_id, second.tool_call_id], infer.messages[3].tool_calls.map((c) => c.id), 'each call id gets a result');
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

test('the shipped script runs a turn under the contract, on a Chat Completions server', { skip: process.platform === 'win32' }, async () => {
  const requests = [];
  const answers = [];
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, body: JSON.parse(await text(req)) });
    const [status, body] = answers.shift() ?? [500, { error: 'no answer queued' }];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    // The endpoint is in the script, to change like any of it.
    const config = await mkdtemp(join(tmpdir(), 'opendoc-config-'));
    await installAgents(config, { platform: 'linux' });
    const program = join(config, 'agents', 'opendoc.mjs');
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    await writeFile(program, (await readFile(program, 'utf8')).replace('http://localhost:11434/v1', endpoint));
    const { dir, doc, sidecar } = await copies();
    const run = (PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH}`) => new Promise((resolve) => {
      const env = { ...process.env, PATH, OPENDOC_DOC: doc, OPENDOC_COMMENTS: sidecar, OPENDOC_PROJECT: '', OPENDOC_BUDDY: 'Ada' };
      execFile(agentScript('opendoc', config, 'linux'), { cwd: dir, env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })).stdin.end('the prompt');
    });

    answers.push([200, { choices: [{ message: calling(['propose', { edits: [{ path: doc, old: 'week one', new: 'week two' }, { path: sidecar, old: '', new: '{"body":"Two weeks?"}' }], reply: 'Moved it.' }]) }] }]);
    assert.deepEqual(await run(), { code: 0, stdout: 'Moved it.', stderr: '' });
    assert.equal(await readFile(doc, 'utf8'), SAMPLE.replace('week one', 'week two'));
    assert.equal(await readFile(sidecar, 'utf8'), `${HEADER}{"body":"Two weeks?"}\n`);
    const [{ url, body }] = requests;
    assert.equal(url, '/v1/chat/completions');
    assert.deepEqual([body.model, body.tool_choice, body.messages], ['qwen3', 'auto', [{ role: 'user', content: 'the prompt' }]]);

    // A failed run's reply says what failed, then what to change and where.
    answers.push([404, { error: 'model "qwen3" not found' }]);
    const failed = await run();
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr, `${endpoint}: 404 {"error":"model \\"qwen3\\" not found"}\nCheck the endpoint, and that the model qwen3 is there (with Ollama: ollama pull qwen3).\nThe endpoint, model and key are at the top of ${program}.\n`);

    const log = (await readFile(join(config, 'logs', 'opendoc.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((entry) => [entry.buddy, entry.messages.map((m) => m.role), entry.error]), [
      ['Ada', ['user', 'assistant'], null],
      ['Ada', ['user'], failed.stderr.trim()],
    ], 'each turn\'s messages are logged');

    // A CRLF doc reads without its \r, and an edit quoting more than a line keeps its line breaks.
    await writeFile(doc, SAMPLE.replace(/\n/g, '\r\n'));
    const quote = 'We plan to **ship all six features** in week one, then gather feedback from the\nbeta cohort';
    answers.push([200, { choices: [{ message: calling(['read', { path: doc, lines: [3, 4] }]) }] }]);
    answers.push([200, { choices: [{ message: calling(['propose', { edits: [{ path: doc, old: quote, new: 'We ship\nin week two' }], reply: '' }]) }] }]);
    assert.equal((await run()).code, 0);
    assert.equal(requests.at(-1).body.messages.at(-1).content, '3\tWe plan to **ship all six features** in week one, then gather feedback from the\n4\tbeta cohort before the public release.');
    assert.equal(await readFile(doc, 'utf8'), SAMPLE.replace(quote, 'We ship\nin week two').replace(/\n/g, '\r\n'));

    await new Promise((r) => server.close(r));
    assert.match((await run()).stderr, new RegExp(`^Cannot reach ${endpoint} \\(ECONNREFUSED\\): is the model's server running\\?\nThe endpoint, model and key are at the top of ${program}\\.`));
    assert.deepEqual(await run('/nowhere'), { code: 1, stdout: '', stderr: 'The OpenDoc agent runs on Node.js: install it from https://nodejs.org, with node on PATH.\n' });
  } finally {
    server.close();
  }
});
