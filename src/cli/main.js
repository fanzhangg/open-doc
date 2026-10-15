// opendoc CLI: the agent's whole API. Commands read and write the doc's
// sidecar directly, so they work with or without a running editor.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { basename, resolve as resolvePath } from 'node:path';
import {
  AnchorError, FormatError, OpError,
  activeWorking, applyOp, createAnchor, findQuote, findThread, inbox, newId, project,
} from '../core/index.js';
import { threadLines } from '../core/lines.js';
import { StoreError, load, moveDoc, update } from '../store/files.js';
import { watchDoc } from '../store/watch.js';
import { startServer } from '../server/server.js';
import { claudeAdapter, customAdapter } from '../server/agents/adapters.js';
import { hooksWarning } from '../server/agents/config.js';
import { NAME_PATTERN } from '../core/mentions.js';

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
  opendoc resolve  <doc> <thread-id> --as <name>
  opendoc reopen   <doc> <thread-id> --as <name>
  opendoc mv       <old.md> <new.md>

Agent options for serve (the server starts a headless run for each new comment that mentions
@<name> or no one; --mentions-only limits it to comments that mention @<name>):
  --agent claude                 Claude Code preset; --agent-bin <path> if claude is not found
  --agent <name> --agent-cmd "<command with {promptFile} {threadsFile} {doc}>"   any other agent
  --model <name>  --max-turns <n> (30)  --run-timeout <minutes> (10)  --runs-per-hour <n> (20)
  --max-budget-usd <n>  --agent-isolated (Claude --bare; needs ANTHROPIC_API_KEY)  --mentions-only

Identity: --as <name> (or OPENDOC_AS), --kind agent|human (or OPENDOC_KIND; default agent).
wait blocks until a thread is waiting on <name>, marks it as being answered,
prints it and exits 0; it exits 3 on timeout (default ${DEFAULT_WAIT_SECONDS}s, 0 = none).
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
  model: { type: 'string' },
  'max-turns': { type: 'string' },
  'run-timeout': { type: 'string' },
  'runs-per-hour': { type: 'string' },
  'max-budget-usd': { type: 'string' },
  'mentions-only': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** Run the CLI. Returns the exit code; output goes to the given streams. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
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
    return (await handler(rest, values, { out, env })) ?? EXIT.ok;
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
    // --agent flags pick the agent for this run; without them the agent is
    // the one in the user's settings (Settings > Agent), which may be off.
    const agent = agentOptions(values, docPath);
    const server = await startServer(docPath, { port, agent, agentFromSettings: !agent });
    out(`opendoc: editing ${basename(docPath)} at ${server.url}`);
    if (server.dispatcher) {
      const status = server.dispatcher.status();
      if (status.warning) out(`opendoc: warning: ${status.warning}`);
      out(status.state === 'unavailable'
        ? `opendoc: agent ${status.name} is unavailable: ${status.error}`
        : status.mentionsOnly
          ? `opendoc: ${status.name} answers comments that mention @${status.name}`
          : `opendoc: ${status.name} answers every comment (except ones addressed to someone else)`);
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
    const body = requireBody(bodyParts);
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
    const body = requireBody(bodyParts);
    return writeAndPrint(docPath, values, out, threadId, (s) =>
      applyOp(s, { type: 'addMessage', threadId, message: message(me, body) }));
  },

  async resolve([docArg, threadId], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    return writeAndPrint(docPath, values, out, threadId, (s) =>
      applyOp(s, { type: 'resolve', threadId, by: me.name, at: new Date().toISOString() }));
  },

  async reopen([docArg, threadId], values, { out, env }) {
    const docPath = requireDoc(docArg);
    identity(values, env);
    requireThreadId(threadId);
    return writeAndPrint(docPath, values, out, threadId, (s) => applyOp(s, { type: 'reopen', threadId }));
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
    return change(s);
  });
  print(out, values.json, markdown, sidecar, [findThread(sidecar, threadId)]);
}

function agentOptions(values, docPath) {
  if (!values.agent) {
    if (values['agent-cmd']) throw new UsageError('--agent-cmd needs --agent <name>');
    if (values['mentions-only']) throw new UsageError('--mentions-only needs --agent <name>');
    return undefined;
  }
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
    });
  } else {
    throw new UsageError(`no preset for agent "${values.agent}"; pass --agent-cmd "<command>"`);
  }
  const warning = hooksWarning(adapter, values['agent-isolated'] === true, docPath);
  return { name: values.agent, adapter, limits, mentionsOnly: values['mentions-only'] === true, warning };
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
  for (const m of thread.messages) lines.push(`  ${m.author.name} (${m.author.kind}): ${m.body.replace(/\n/g, '\n    ')}`);
  if (thread.status === 'resolved') lines.push(`  resolved by ${thread.resolvedBy}`);
  if (working) lines.push(`  ${working.by} is responding…`);
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
