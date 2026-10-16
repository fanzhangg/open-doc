// opendoc CLI: the agent's whole API. Commands read and write the doc's
// sidecar directly, so they work with or without a running editor.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { basename, resolve as resolvePath } from 'node:path';
import {
  AnchorError, FormatError, OpError,
  activeWorking, applyOp, createAnchor, findQuote, findThread, inbox, newId, project, proposeChanges,
} from '../core/index.js';
import { threadLines } from '../core/lines.js';
import { StoreError, load, moveDoc, update } from '../store/files.js';
import { watchDoc } from '../store/watch.js';
import { startServer } from '../server/server.js';
import { claudeAdapter, customAdapter } from '../server/agents/adapters.js';
import { hooksWarning } from '../server/agents/config.js';
import { NAME_PATTERN } from '../core/mentions.js';
import { EDIT_MODES, MAX_INSTRUCTIONS } from '../core/agents.js';

export const EXIT = { ok: 0, error: 1, badInput: 2, timeout: 3, conflict: 4 };
const DEFAULT_WAIT_SECONDS = 900;

const USAGE = `opendoc — co-author markdown with agents through comment threads

Usage:
  opendoc serve    <doc> [--port <n>] [--no-open] [--agent <name> [agent options]]
  opendoc comments <doc> [--status open|resolved|all] [--json]
  opendoc inbox    <doc> --as <name> [--json]
  opendoc wait     <doc> --as <name> [--timeout <seconds>] [--json]
  opendoc comment  <doc> [--quote "<text>" [--occurrence <n>]] "<body>" --as <name>
  opendoc reply    <doc> <thread-id> "<body>" --as <name>
  opendoc propose  <doc> <thread-id> --as <name>   (stdin: {"body": "...", "changes": [{"before": "...", "after": "..."}]})
  opendoc resolve  <doc> <thread-id> --as <name> --kind human
  opendoc reopen   <doc> <thread-id> --as <name> --kind human
  opendoc mv       <old.md> <new.md>
  opendoc guard    (a Claude Code hook the server sets up for its runs; reads the hook input on stdin)

serve also runs your agents invited into the doc (the Agents panel in the editor).
Agent options for serve add one more agent for this run (it answers comments that mention
it or no one):
  --agent claude                 Claude Code preset; --agent-bin <path> if claude is not found
  --agent <name> --agent-cmd "<command with {promptFile} {threadsFile} {doc}>"   any other agent
  --persona "<text>"             the agent's role, e.g. "a strict copy editor; fix only grammar"
  --edit-mode auto|approve|none  auto (default): the agent edits the doc and replies;
                                 approve: it replies with proposals for you to apply;
                                 none: it only replies
  --model <name>  --max-turns <n> (30)  --run-timeout <minutes> (10)  --runs-per-hour <n> (20)
  --max-budget-usd <n>  --agent-isolated (Claude --bare; needs ANTHROPIC_API_KEY)
  --agent-web                    let Claude search and fetch the web (off by default)
  --agent-read-files             let Claude read files other than the doc (off by default)
                                 A web page or file could trick it into leaking what it read.

Identity: --as <name> (or OPENDOC_AS), --kind agent|human (or OPENDOC_KIND; default agent).
A thread waits on <name> when its latest message from a human mentions @<name> and <name> has
not answered it yet, or mentions no one and no one has answered it yet.
wait blocks until a thread is waiting on <name>, marks it as being answered,
prints it and exits 0; it exits 3 on timeout (default ${DEFAULT_WAIT_SECONDS}s, 0 = none).
propose replies with changes instead of making them; each "before" must appear exactly
once in the doc's markdown source. An agent's comment, reply or proposal text is at most
280 characters. Only humans resolve and reopen threads.
Exit codes: 0 ok, 1 error, 2 bad input, 3 wait timed out, 4 sidecar busy.`;

class UsageError extends Error {}

const OPTIONS = {
  as: { type: 'string' },
  kind: { type: 'string' },
  json: { type: 'boolean' },
  status: { type: 'string' },
  quote: { type: 'string' },
  occurrence: { type: 'string' },
  timeout: { type: 'string' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  agent: { type: 'string' },
  'agent-cmd': { type: 'string' },
  'agent-bin': { type: 'string' },
  'agent-isolated': { type: 'boolean' },
  'agent-web': { type: 'boolean' },
  'agent-read-files': { type: 'boolean' },
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  'run-timeout': { type: 'string' },
  'runs-per-hour': { type: 'string' },
  'max-budget-usd': { type: 'string' },
  'edit-mode': { type: 'string' },
  persona: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

/** Run the CLI. Returns the exit code; output goes to the given streams. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env } = {}) {
  const out = (line) => stdout.write(line + '\n');
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    const [command, ...rest] = positionals;
    if (!command || values.help || command === 'help') {
      out(USAGE);
      return EXIT.ok;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`unknown command: ${command}`);
    return (await handler(rest, values, { out, env, stdin })) ?? EXIT.ok;
  } catch (error) {
    stderr.write(`opendoc: ${error.message}\n`);
    return exitCodeFor(error);
  }
}

const COMMANDS = {
  async serve([docArg], values, { out }) {
    const docPath = requireDoc(docArg);
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a port number');
    // --agent flags add an agent for this run, next to the user's agents
    // invited into the doc (the Agents panel).
    const agent = agentOptions(values, docPath);
    const server = await startServer(docPath, { port, agent, agentFromSettings: true });
    out(`opendoc: editing ${basename(docPath)} at ${server.url}`);
    for (const status of server.team.statuses()) {
      if (status.warning) out(`opendoc: warning: ${status.warning}`);
      out(status.state === 'unavailable'
        ? `opendoc: agent ${status.name} is unavailable: ${status.error}`
        : `opendoc: ${status.name} ${status.presence === 'dnd' ? `answers comments that mention @${status.name}` : 'answers comments that mention it or no one'}, ${EDIT_MODE_TEXT[status.editMode]}`);
    }
    out('Press Ctrl+C to stop.');
    if (!values['no-open']) openBrowser(server.url);
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await server.close();
  },

  async comments([docArg], values, { out }) {
    const docPath = requireDoc(docArg);
    const status = values.status ?? 'open';
    if (!['open', 'resolved', 'all'].includes(status)) throw new UsageError('--status must be open, resolved or all');
    const { doc, sidecar } = await load(docPath);
    const threads = sidecar.threads.filter((t) => status === 'all' || t.status === status);
    print(out, values.json, doc.markdown, sidecar, threads);
  },

  async inbox([docArg], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    const { doc, sidecar } = await load(docPath);
    print(out, values.json, doc.markdown, sidecar, inbox(sidecar, me.name), `nothing is waiting on ${me.name}`);
  },

  async wait([docArg], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    const seconds = values.timeout === undefined ? DEFAULT_WAIT_SECONDS : Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError('--timeout must be a number of seconds');
    const result = await waitForInbox(docPath, me, seconds * 1000);
    if (!result) {
      throw Object.assign(new Error(`nothing waiting on ${me.name} after ${seconds}s`), { exitCode: EXIT.timeout });
    }
    print(out, values.json, result.markdown, result.sidecar, result.threads);
  },

  async comment([docArg, ...bodyParts], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    const body = fitBody(me, requireBody(bodyParts));
    const occurrence = values.occurrence === undefined ? undefined : Number(values.occurrence) - 1;
    if (occurrence !== undefined && !(Number.isInteger(occurrence) && occurrence >= 0)) {
      throw new UsageError('--occurrence must be 1 or more');
    }
    const id = newId('t');
    let markdown;
    const sidecar = await update(docPath, (s, doc) => {
      markdown = doc.markdown;
      let anchor = null;
      if (values.quote !== undefined) {
        const { text } = project(doc.markdown);
        const range = findQuote(text, values.quote, { occurrence });
        anchor = createAnchor(text, range.start, range.end);
      }
      return applyOp(s, { type: 'addThread', id, anchor, message: message(me, body) });
    });
    print(out, values.json, markdown, sidecar, [findThread(sidecar, id)]);
  },

  async reply([docArg, threadId, ...bodyParts], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    const body = fitBody(me, requireBody(bodyParts));
    return writeAndPrint(docPath, values, out, threadId, (s) =>
      applyOp(s, { type: 'addMessage', threadId, message: message(me, body) }));
  },

  // The Claude Code hooks the server sets up for its runs (OPENDOC_GUARD_URL
  // and _TOKEN). Before an Edit: asks the server whether the edit lands where
  // the human is typing, and refuses it if so; the server also holds it while
  // another agent writes the doc, and refuses it if that goes on too long.
  // After an Edit: tells the server the agent is done writing. Anything
  // unexpected lets the edit through, since the editor still merges it
  // safely.
  async guard(_args, _values, { out, env, stdin }) {
    const url = env.OPENDOC_GUARD_URL;
    const token = env.OPENDOC_GUARD_TOKEN;
    if (!url || !token) return;
    let input;
    try {
      let text = '';
      for await (const chunk of stdin) text += chunk;
      input = JSON.parse(text);
    } catch {
      return;
    }
    const decide = (decision, reason) => out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
    if (input?.tool_name !== 'Edit') return;
    const post = input.hook_event_name === 'PostToolUse';
    try {
      const response = await fetch(`${url}/api/guard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-opendoc-guard': token },
        body: JSON.stringify(post ? { event: 'post' } : {
          tool: 'Edit', oldString: input.tool_input?.old_string ?? '', filePath: input.tool_input?.file_path, cwd: input.cwd,
        }),
        signal: AbortSignal.timeout(post ? 8000 : 25_000),
      });
      if (post) return;
      const verdict = await response.json();
      if (verdict.allow === false) decide('deny', verdict.reason);
    } catch {
      // the server is gone or slow: let the edit through
    }
  },

  async propose([docArg, threadId], values, { out, env, stdin }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    const { body, changes } = await readProposal(stdin);
    fitBody(me, body);
    return writeAndPrint(docPath, values, out, threadId, (s, doc) => applyOp(s, {
      type: 'addMessage', threadId, message: { ...message(me, body), proposal: proposeChanges(doc.markdown, changes) },
    }));
  },

  // Resolving and reopening are the human's call; the core refuses an agent.
  async resolve([docArg, threadId], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    return writeAndPrint(docPath, values, out, threadId, (s) =>
      applyOp(s, { type: 'resolve', threadId, by: me.name, kind: me.kind, at: new Date().toISOString() }));
  },

  async reopen([docArg, threadId], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    return writeAndPrint(docPath, values, out, threadId, (s) => applyOp(s, { type: 'reopen', threadId, by: me.name, kind: me.kind }));
  },

  async mv([fromArg, toArg], values, { out }) {
    if (!fromArg || !toArg) throw new UsageError('usage: opendoc mv <old.md> <new.md>');
    await moveDoc(resolvePath(fromArg), resolvePath(toArg));
    out(values.json ? JSON.stringify({ from: fromArg, to: toArg }) : `moved ${fromArg} -> ${toArg}`);
  },
};

/**
 * Join as a participant, then block until the inbox is non-empty or the
 * timeout passes. Threads handed out are marked `working` in the same locked
 * write, so the editor shows "responding…" and a re-armed wait skips them.
 */
export async function waitForInbox(docPath, me, timeoutMs) {
  await update(docPath, (s) => applyOp(s, { type: 'join', participant: me }));

  let changed = true;
  let wake = () => {};
  const stop = watchDoc(docPath, () => {
    changed = true;
    wake();
  });
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  try {
    for (;;) {
      if (changed) {
        changed = false;
        const claimed = await claim(docPath, me);
        if (claimed) return claimed;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      let timer;
      await new Promise((resolve) => {
        wake = resolve;
        if (Number.isFinite(remaining)) timer = setTimeout(resolve, remaining);
      });
      clearTimeout(timer);
    }
  } finally {
    stop();
  }
}

async function claim(docPath, me) {
  let ready = [];
  let markdown;
  const since = new Date().toISOString();
  const sidecar = await update(docPath, (s, doc) => {
    markdown = doc.markdown;
    ready = inbox(s, me.name);
    return ready.reduce((acc, t) => applyOp(acc, { type: 'setWorking', threadId: t.id, by: me.name, since }), s);
  });
  if (ready.length === 0) return null;
  const ids = new Set(ready.map((t) => t.id));
  return { markdown, sidecar, threads: sidecar.threads.filter((t) => ids.has(t.id)) };
}

async function writeAndPrint(docPath, values, out, threadId, change) {
  let markdown;
  const sidecar = await update(docPath, (s, doc) => {
    markdown = doc.markdown;
    return change(s, doc);
  });
  print(out, values.json, markdown, sidecar, [findThread(sidecar, threadId)]);
}

const EDIT_MODE_TEXT = {
  auto: 'editing the doc directly',
  approve: 'proposing edits for you to apply',
  none: 'replying without changing the doc',
};

function agentOptions(values, docPath) {
  if (!values.agent) {
    if (values['agent-cmd']) throw new UsageError('--agent-cmd needs --agent <name>');
    if (values['edit-mode']) throw new UsageError('--edit-mode needs --agent <name>');
    if (values.persona) throw new UsageError('--persona needs --agent <name>');
    return undefined;
  }
  const editMode = values['edit-mode'] ?? 'auto';
  if (!EDIT_MODES.includes(editMode)) throw new UsageError('--edit-mode must be auto, approve or none');
  if (!NAME_PATTERN.test(values.agent)) throw new UsageError('--agent must be a participant name (letters, digits, . _ -)');
  const number = (flag, fallback, { min = 1 } = {}) => {
    if (values[flag] === undefined) return fallback;
    const n = Number(values[flag]);
    if (!Number.isFinite(n) || n < min) throw new UsageError(`--${flag} must be a number >= ${min}`);
    return n;
  };
  const limits = {
    timeoutMs: number('run-timeout', 10) * 60 * 1000,
    runsPerHour: number('runs-per-hour', 20),
  };
  let adapter;
  if (values['agent-cmd']) {
    adapter = customAdapter(values['agent-cmd']);
  } else if (values.agent.toLowerCase() === 'claude') {
    adapter = claudeAdapter({
      bin: values['agent-bin'],
      model: values.model,
      maxTurns: number('max-turns', 30),
      maxBudgetUsd: values['max-budget-usd'] === undefined ? undefined : number('max-budget-usd', undefined, { min: 0.01 }),
      isolated: values['agent-isolated'] === true,
      webAccess: values['agent-web'] === true,
      fileAccess: values['agent-read-files'] === true,
    });
  } else {
    throw new UsageError(`no preset for agent "${values.agent}"; pass --agent-cmd "<command>"`);
  }
  const warning = hooksWarning(adapter, values['agent-isolated'] === true, docPath);
  const persona = values.persona ?? '';
  if (persona.length > MAX_INSTRUCTIONS) throw new UsageError(`--persona must be at most ${MAX_INSTRUCTIONS} characters`);
  return { name: values.agent, persona, adapter, limits, editMode, warning };
}

function openBrowser(url) {
  const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).on('error', () => {}).unref();
  } catch {
    // no browser launcher: the URL is printed above
  }
}

function message(author, body) {
  return { id: newId('m'), author, body, createdAt: new Date().toISOString() };
}

// `propose` reads { body, changes: [{ before, after }] } as JSON on stdin.
async function readProposal(stdin) {
  if (stdin.isTTY) throw new UsageError('pipe the proposal as JSON on stdin: {"body": "...", "changes": [{"before": "...", "after": "..."}]}');
  let text = '';
  for await (const chunk of stdin) text += chunk;
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new UsageError('the proposal on stdin is not valid JSON');
  }
  if (!input || typeof input.body !== 'string' || !input.body.trim()) throw new UsageError('the proposal needs a "body" explaining it');
  if (!Array.isArray(input.changes) || input.changes.length === 0) throw new UsageError('the proposal needs "changes": [{ "before", "after" }]');
  return { body: input.body.trim(), changes: input.changes };
}

// ---- output ----

function print(out, json, markdown, sidecar, threads, emptyText = 'no threads') {
  const located = threadLines(markdown, threads);
  if (json) {
    out(JSON.stringify({ doc: sidecar.doc, threads: threads.map((t, i) => ({ ...t, line: located[i] })) }, null, 2));
    return;
  }
  if (threads.length === 0) {
    out(emptyText);
    return;
  }
  out(threads.map((t, i) => formatThread(t, located[i])).join('\n\n'));
}

function formatThread(thread, line) {
  const where = !thread.anchor ? 'doc'
    : thread.detached ? 'detached'
    : `line ${line}`;
  const quote = thread.anchor ? `  "${truncate(thread.anchor.exact, 60)}"` : '';
  const working = activeWorking(thread);
  const lines = [`${thread.id}  ${thread.status}  ${where}${quote}`];
  for (const m of thread.messages) {
    lines.push(`  ${m.author.name} (${m.author.kind}): ${m.body.replace(/\n/g, '\n    ')}`);
    for (const c of m.proposal ?? []) lines.push(`    proposes: "${truncate(c.before, 40)}" -> "${truncate(c.after, 40)}"`);
  }
  if (thread.status === 'resolved') lines.push(`  resolved by ${thread.resolvedBy}`);
  for (const w of working) lines.push(`  ${w.by} is responding…`);
  return lines.join('\n');
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\n/g, ' ');

// ---- arguments ----

function requireDoc(docArg) {
  if (!docArg) throw new UsageError('missing <doc> argument');
  if (docArg.endsWith('.opendoc.json')) throw new UsageError('pass the markdown file, not its sidecar');
  return resolvePath(docArg);
}

function requireThreadId(threadId) {
  if (!threadId) throw new UsageError('missing <thread-id> argument');
}

function requireBody(parts) {
  const body = parts.join(' ').trim();
  if (!body) throw new UsageError('missing comment text');
  return body;
}

// An agent comments the way a person does in a doc review: a point or two,
// no longer than a tweet. A longer one is refused so the agent shortens it.
export const MAX_AGENT_COMMENT = 280;

function fitBody(author, body) {
  if (author.kind === 'agent' && body.length > MAX_AGENT_COMMENT) {
    throw new UsageError(`too long: an agent's comment is at most ${MAX_AGENT_COMMENT} characters, and this one is ${body.length}. Make the one point that matters most in a sentence or two, with no list or preamble, and post it again.`);
  }
  return body;
}

function identity(values, env) {
  const name = values.as ?? env.OPENDOC_AS;
  if (!name) throw new UsageError('who is this? pass --as <name> or set OPENDOC_AS');
  const kind = values.kind ?? env.OPENDOC_KIND ?? 'agent';
  if (kind !== 'agent' && kind !== 'human') throw new UsageError('--kind must be agent or human');
  return { name, kind };
}

function exitCodeFor(error) {
  if (error.exitCode !== undefined) return error.exitCode;
  if (error instanceof UsageError || error instanceof AnchorError || error instanceof OpError || error instanceof FormatError) {
    return EXIT.badInput;
  }
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return EXIT.badInput;
  if (error instanceof StoreError) return error.code === 'lock_timeout' ? EXIT.conflict : EXIT.badInput;
  return EXIT.error;
}
