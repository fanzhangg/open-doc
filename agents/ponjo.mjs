// The Ponjo agent (docs/ponjo-agent.md): a model reads and proposes, and
// this program checks the proposal and applies it to the copies. Run by
// `ponjo` (`ponjo.cmd` on Windows) next to it, on your own node, under
// the contract of docs/agent-config.md; its settings (ponjo.json) come
// as PONJO_SETTING_*. Plain fetch, no SDK: it runs from the config
// folder, with no node_modules. Yours to change.

import { appendFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

// Each turn's messages, a line each, next to the app's own logs.
const LOG = fileURLToPath(new URL('../logs/ponjo.jsonl', import.meta.url));

const STEPS = 20;
const MAX_READ = 20_000; // characters a read without `lines` returns

// The tools, as each provider's infer gets them: { name, description, parameters (a JSON schema) }.
const TOOLS = [
  {
    name: 'read',
    description: `Read a file, or list a folder. Each line comes after its number and a tab, which are not part of the file. A file over ${MAX_READ} characters read without lines gives its outline: read it in parts.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The path of the file or folder.' },
        lines: { type: 'array', items: { type: 'integer' }, description: 'The first and last line to read, from 1.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'propose',
    description: 'End your turn: your edits and your reply. To edit the doc, replace `old`, quoted exactly from it and found there once, with `new`. To comment, append to the comments file: `old` empty, `new` the lines to append. No other file can change. `reply` is what you print, and may be empty. One bad edit sends the whole proposal back, saying what to fix.',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
            required: ['path', 'old', 'new'],
          },
        },
        reply: { type: 'string' },
      },
      required: ['edits', 'reply'],
    },
  },
];

/**
 * One buddy answering one thread: `prompt` is stdin as is, `doc` and
 * `sidecar` the copies' paths. `infer(messages, tools)` is one step of the
 * model (INFER) and resolves to { calls: [{ id, name, args }], sent }, `args`
 * the JSON the model wrote and `sent` its message as its API sent it;
 * `readFile(path)` to a file's text, a folder's entries or null. Resolves to
 * the checked { edits, reply }, and throws when the turn fails.
 *
 * The messages are in one form for every provider: { role: 'user', content },
 * { role: 'assistant', calls, sent }, and { role: 'tool', id, content }, a
 * call's result.
 */
export async function turn({ prompt, doc, sidecar }, { infer, readFile }) {
  const messages = [{ role: 'user', content: prompt }];
  for (let step = 0; step < STEPS; step++) {
    const { calls, sent } = await infer(messages, TOOLS);
    messages.push({ role: 'assistant', calls, sent });
    const [call, ...more] = calls;
    if (!call) {
      messages.push({ role: 'user', content: 'Call read or propose.' });
      continue;
    }
    const result = await use(call, { doc, sidecar, readFile });
    if (typeof result !== 'string') return result;
    messages.push({ role: 'tool', id: call.id, content: result });
    for (const extra of more) messages.push({ role: 'tool', id: extra.id, content: 'Not run: one tool per step.' });
  }
  throw new Error(`No proposal in ${STEPS} steps.`);
}

// What a tool call gives back to the model, or a valid proposal's { edits, reply }.
async function use({ name, args: json }, { doc, sidecar, readFile }) {
  let args;
  try {
    args = JSON.parse(json);
  } catch {
    return `The arguments are not JSON: ${json}`;
  }
  if (name === 'read') return read(args, readFile);
  if (name !== 'propose') return `No tool ${name}: call read or propose.`;
  const { edits, reply = '' } = args;
  if (!Array.isArray(edits) || typeof reply !== 'string') return 'propose takes { edits: [{ path, old, new }], reply }.';
  try {
    apply(edits, { doc, sidecar }, { doc: await readFile(doc), sidecar: await readFile(sidecar) });
  } catch (error) {
    return `Nothing was changed. ${error.message}`;
  }
  return { edits, reply };
}

async function read({ path, lines }, readFile) {
  const found = typeof path === 'string' ? await readFile(path) : null;
  if (found === null) return `${path}: no such file, or not one you can read.`;
  if (Array.isArray(found)) return found.join('\n') || '(an empty folder)';
  const all = found.replace(/\r?\n$/, '').split(/\r?\n/);
  if (!lines && found.length > MAX_READ) return outline(path, all);
  const from = Math.max(1, lines?.[0] ?? 1);
  return all.slice(from - 1, lines?.[1] ?? all.length).map((line, i) => `${from + i}\t${line}`).join('\n');
}

// A long file's line count, and a Markdown file's headings with their lines.
function outline(path, all) {
  const about = `${path} has ${all.length} lines, too many to read at once: read it in parts.`;
  if (!/\.(md|markdown)$/i.test(path)) return about;
  const headings = [];
  let fenced = false;
  all.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && /^#{1,6}\s/.test(line)) headings.push({ at: i + 1, line });
  });
  const ranges = headings.map(({ at, line }, i) => `${at}-${(headings[i + 1]?.at ?? all.length + 1) - 1}\t${line}`);
  return [about, ...(ranges.length ? ['Its headings, with their lines:', ...ranges] : [])].join('\n');
}

// A sidecar line the app takes (docs/agent-config.md#comments).
const isComment = (line) => {
  try {
    const c = JSON.parse(line);
    if (Object.keys(c).sort().join() === 'resolved,thread') return c.resolved === true && typeof c.thread === 'string';
    return ['body', 'anchor,body', 'body,thread'].includes(Object.keys(c).sort().join()) && typeof c.body === 'string'
      && (!('anchor' in c) || typeof c.anchor?.exact === 'string') && (!('thread' in c) || typeof c.thread === 'string');
  } catch {
    return false;
  }
};

/**
 * The copies' texts { doc, sidecar } after `edits`, all or none: throws what
 * to fix. `paths` are the copies' paths.
 */
function apply(edits, paths, texts) {
  // read shows a CRLF doc's lines without their \r: a quote and its edit get them back.
  const eol = (text) => (texts.doc.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
  const spans = [];
  const appended = [];
  for (const [i, edit] of edits.entries()) {
    const which = `Edit ${i + 1}`;
    if (!['path', 'old', 'new'].every((key) => typeof edit?.[key] === 'string')) throw new Error(`${which}: path, old and new must be strings.`);
    const { path, old, new: by } = edit;
    if (resolve(path) === paths.sidecar) {
      if (old) throw new Error(`${which}: on ${paths.sidecar}, old must be empty: new is appended.`);
      const lines = by.split('\n').filter((line) => line.trim());
      const bad = lines.find((line) => !isComment(line));
      if (bad) throw new Error(`${which}: not a comment line: ${bad}. Each line is {"anchor":{"exact":"…"},"body":"…"}, {"body":"…"}, {"thread":"c_…","body":"…"} or {"thread":"c_…","resolved":true}.`);
      appended.push(...lines);
    } else if (resolve(path) === paths.doc) {
      const quote = eol(old);
      const start = quote ? texts.doc.indexOf(quote) : -1;
      if (start < 0) throw new Error(`${which}: old ${old ? 'is not in the doc: read it and quote it exactly' : 'is empty: quote the text to replace'}.`);
      if (texts.doc.includes(quote, start + 1)) throw new Error(`${which}: old is in the doc more than once: quote more of it.`);
      spans.push({ start, end: start + quote.length, by: eol(by), which });
    } else {
      throw new Error(`${which}: ${path} cannot change: only ${paths.doc} and ${paths.sidecar} can.`);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let doc = '';
  let at = 0;
  for (const { start, end, by, which } of spans) {
    if (start < at) throw new Error(`${which} overlaps another edit: make them one.`);
    doc += texts.doc.slice(at, start) + by;
    at = end;
  }
  const sidecar = texts.sidecar;
  const tail = appended.length ? `${sidecar && !sidecar.endsWith('\n') ? '\n' : ''}${appended.join('\n')}\n` : '';
  return { doc: doc + texts.doc.slice(at), sidecar: sidecar + tail };
}

/**
 * What the turn can see: the copies, and in project mode (`project` a
 * folder) its files, as the app's own: resolved to their real path, inside
 * the folder, and no name starting with `.`. A relative path is in the
 * project, but for the copies' names.
 */
export function files({ doc, sidecar, project }) {
  return async (path) => {
    if ([doc, sidecar].includes(resolve(path))) return readFile(path, 'utf8');
    if (!project) return null;
    const real = await realpath(resolve(project, path)).catch(() => null);
    const inside = real && relative(await realpath(project), real);
    if (inside === null || isAbsolute(inside) || inside.split(sep).some((name) => name.startsWith('.'))) return null;
    const entries = await readdir(real, { withFileTypes: true }).catch(() => null);
    if (!entries) return readFile(real, 'utf8').catch(() => null);
    return entries.filter((e) => !e.name.startsWith('.')).map((e) => e.name + (e.isDirectory() ? '/' : '')).sort();
  };
}

// Where a failed run's reply sends the user: the failure, then what to change.
const SETTINGS = 'The provider, endpoint, model and key are in Settings > Agents > Ponjo agent.';
const HINTS = { 401: 'Check the API key.', 404: 'Check the endpoint and the model.' };

const CACHED = { type: 'ephemeral' };

/**
 * One step of the model, by provider: `INFER[provider](settings, url)` is
 * `infer` for `turn`, over that provider's API at `url`. `settings` are the
 * agent's: { endpoint, model, key, effort }. Each sends `tool_choice: auto`:
 * current Claude models refuse a forced tool call, and a reply without one is
 * sent back anyway.
 */
export const INFER = {
  // Anthropic's Messages API. The model thinks as it needs, at `effort`; its
  // messages go back as they came, thinking included. The tools and the
  // prompt are cached for the turn's later steps.
  anthropic: ({ model, key, effort }, url = 'https://api.anthropic.com/v1') => async (messages, tools) => {
    const reply = await post(`${url}/messages`, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, {
      model,
      max_tokens: 16_000,
      output_config: { effort },
      tool_choice: { type: 'auto' },
      tools: tools.map(({ name, description, parameters }, i) => ({ name, description, input_schema: parameters, ...(i === tools.length - 1 && { cache_control: CACHED }) })),
      messages: messages.map((m, i) => {
        if (m.role === 'assistant') return { role: 'assistant', content: m.sent };
        if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.id, content: m.content }] };
        return { role: 'user', content: [{ type: 'text', text: m.content, ...(i === 0 && { cache_control: CACHED }) }] };
      }),
    });
    if (reply.stop_reason === 'refusal') throw new Error(`The model refused: ${reply.stop_details?.explanation ?? 'no reason given.'}`);
    if (reply.stop_reason === 'max_tokens') throw new Error('The model\'s answer was cut off at 16,000 tokens.');
    const calls = reply.content.filter((block) => block.type === 'tool_use').map(({ id, name, input }) => ({ id, name, args: JSON.stringify(input) }));
    return { calls, sent: reply.content };
  },
  // The Chat Completions API, which OpenAI, OpenRouter and others speak.
  openai: ({ endpoint, model, key, effort }, url = endpoint.replace(/\/+$/, '')) => async (messages, tools) => {
    const { choices: [{ message }] } = await post(`${url}/chat/completions`, { authorization: `Bearer ${key}` }, {
      model,
      reasoning_effort: effort,
      tool_choice: 'auto',
      tools: tools.map((tool) => ({ type: 'function', function: tool })),
      messages: messages.map((m) => (m.role === 'assistant' ? m.sent : m.role === 'tool' ? { role: 'tool', tool_call_id: m.id, content: m.content } : m)),
    });
    const calls = (message.tool_calls ?? []).map(({ id, function: { name, arguments: args } }) => ({ id, name, args }));
    return { calls, sent: message };
  },
};

// POST `body` to `url` as JSON: the reply, or an error that says what failed and where to change it.
async function post(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).catch((error) => {
    throw new Error(`Cannot reach ${url} (${error.cause?.code ?? error.message}).\n${SETTINGS}`);
  });
  if (!response.ok) throw new Error([`${url}: ${response.status} ${await response.text()}`, HINTS[response.status], SETTINGS].filter(Boolean).join('\n'));
  return response.json();
}

// The contract: the prompt on stdin, the copies' paths and the settings in
// the environment, the edits applied to the copies, the reply on stdout.
// Then the log.
async function main() {
  const { PONJO_DOC: doc, PONJO_COMMENTS: sidecar, PONJO_PROJECT: project, PONJO_BUDDY: buddy } = process.env;
  const { PONJO_SETTING_PROVIDER: provider, PONJO_SETTING_ENDPOINT: endpoint, PONJO_SETTING_MODEL: model, PONJO_SETTING_KEY: key, PONJO_SETTING_EFFORT: effort } = process.env;
  const readable = files({ doc, sidecar, project });
  const at = new Date().toISOString();
  let messages = []; // the turn's, which it goes on adding to after each step
  let error = null;
  try {
    if (!key) throw new Error('No API key: set one in Settings > Agents > Ponjo agent.');
    const infer = INFER[provider]({ endpoint, model, key, effort });
    const step = (sent, tools) => infer((messages = sent), tools);
    const { edits, reply } = await turn({ prompt: await text(process.stdin), doc, sidecar }, { infer: step, readFile: readable });
    const texts = apply(edits, { doc, sidecar }, { doc: await readable(doc), sidecar: await readable(sidecar) });
    await writeFile(doc, texts.doc);
    await writeFile(sidecar, texts.sidecar);
    process.stdout.write(reply);
  } catch (failure) {
    error = failure.message;
    process.stderr.write(`${error}\n`);
    process.exitCode = 1;
  }
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, `${JSON.stringify({ at, buddy, error, messages })}\n`);
}

if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main(); // run, not imported by a test
