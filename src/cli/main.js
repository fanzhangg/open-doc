// opendoc CLI: comments from the command line, and `serve` for a browser.
// Commands read and write the doc's sidecar directly.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { basename, resolve as resolvePath } from 'node:path';
import { AnchorError, FormatError, OpError, applyOp, createAnchor, findQuote, findThread, newId, project } from '../core/index.js';
import { threadLines } from '../core/lines.js';
import { StoreError, load, moveDoc, update } from '../store/files.js';
import { startServer } from '../server/server.js';

export const EXIT = { ok: 0, error: 1, badInput: 2, conflict: 4 };

const USAGE = `opendoc — co-author markdown with buddies through comment threads

Usage:
  opendoc serve    <doc> [--port <n>] [--no-open]
  opendoc comments <doc> [--status open|resolved|all] [--json]
  opendoc comment  <doc> [--quote "<text>" [--occurrence <n>]] "<body>" --as <name>
  opendoc resolve  <doc> <thread-id> --as <name>
  opendoc reopen   <doc> <thread-id> --as <name>
  opendoc mv       <old.md> <new.md>

serve opens the doc in the browser and runs the buddies @mentioned in its comments.
Exit codes: 0 ok, 1 error, 2 bad input, 4 sidecar busy.`;

class UsageError extends Error {}

const OPTIONS = {
  as: { type: 'string' },
  json: { type: 'boolean' },
  status: { type: 'string' },
  quote: { type: 'string' },
  occurrence: { type: 'string' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
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
    const server = await startServer(docPath, { port });
    out(`opendoc: editing ${basename(docPath)} at ${server.url}`);
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

  async resolve([docArg, threadId], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    return writeAndPrint(docPath, values, out, threadId, (s) =>
      applyOp(s, { type: 'resolve', threadId, by: me.name, kind: 'human', at: new Date().toISOString() }));
  },

  async reopen([docArg, threadId], values, { out, env }) {
    const docPath = requireDoc(docArg);
    const me = identity(values, env);
    requireThreadId(threadId);
    return writeAndPrint(docPath, values, out, threadId, (s) => applyOp(s, { type: 'reopen', threadId, by: me.name, kind: 'human' }));
  },

  async mv([fromArg, toArg], values, { out }) {
    if (!fromArg || !toArg) throw new UsageError('usage: opendoc mv <old.md> <new.md>');
    await moveDoc(resolvePath(fromArg), resolvePath(toArg));
    out(values.json ? JSON.stringify({ from: fromArg, to: toArg }) : `moved ${fromArg} -> ${toArg}`);
  },
};

async function writeAndPrint(docPath, values, out, threadId, change) {
  let markdown;
  const sidecar = await update(docPath, (s, doc) => {
    markdown = doc.markdown;
    return change(s, doc);
  });
  print(out, values.json, markdown, sidecar, [findThread(sidecar, threadId)]);
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
  const lines = [`${thread.id}  ${thread.status}  ${where}${quote}`];
  for (const m of thread.messages) {
    lines.push(`  ${m.author.name} (${m.author.kind}): ${m.body.replace(/\n/g, '\n    ')}`);
  }
  if (thread.status === 'resolved') lines.push(`  resolved by ${thread.resolvedBy}`);
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

// The CLI speaks for a person: buddies answer through the app.
function identity(values, env) {
  const name = values.as ?? env.OPENDOC_AS;
  if (!name) throw new UsageError('who is this? pass --as <name> or set OPENDOC_AS');
  return { name, kind: 'human' };
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
