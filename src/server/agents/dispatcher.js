// The dispatcher: when a comment is waiting on the agent, claim the thread
// (the page shows the agent working on it) and start one headless agent run
// for the batch. By default every comment that mentions the agent or no one
// is waiting on it, like a co-author who reads every comment; with
// `mentionsOnly` only an explicit @mention is. At most one run per agent at a
// time; a failed run never loops.

import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOp, inbox } from '../../core/index.js';
import { sameName } from '../../core/mentions.js';
import { threadLines } from '../../core/lines.js';
import { load, update } from '../../store/files.js';
import { agentEnv, buildPrompt } from './adapters.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'opendoc.js');
const HOUR_MS = 60 * 60 * 1000;
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const LOG_LINES = 40;

export const DEFAULT_LIMITS = { timeoutMs: 10 * 60 * 1000, runsPerHour: 20 };

/**
 * States: starting, ready, running, paused, error (last run failed), limited
 * (runs per hour reached), unavailable (preflight failed), stopped.
 */
export class Dispatcher {
  constructor({ docPath, name, adapter, limits = {}, mentionsOnly = false, onStatus = () => {}, settleMs = 300 }) {
    this.docPath = docPath;
    this.docFile = basename(docPath);
    this.name = name;
    this.adapter = adapter;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.mentionsOnly = mentionsOnly;
    this.onStatus = onStatus;
    this.settleMs = settleMs;
    this.state = 'starting';
    this.error = null;
    this.run = null;
    this.lastRun = null;
    this.sessionId = null;
    this.failed = new Set(); // "threadId:lastMessageId" of a failed run's threads
    this.runStarts = [];
    this.pausedAfterRun = false;
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      mentionsOnly: this.mentionsOnly,
      threads: this.run?.threadIds.length ?? 0,
      threadIds: this.run?.threadIds ?? [],
      error: this.error,
      retryAt: this.retryAt ?? null,
      lastRun: this.lastRun && { ...this.lastRun, log: undefined },
    };
  }

  log() {
    return this.lastRun?.log ?? '';
  }

  async start() {
    await update(this.docPath, (s) => applyOp(s, { type: 'join', participant: { name: this.name, kind: 'agent' } }));
    this.shimDir = await makeShim();
    await this.#preflight();
  }

  /** Call on every sidecar change; batches bursts. */
  notify() {
    if (this.state === 'stopped') return;
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.#check(), this.settleMs);
  }

  pause() {
    if (this.run) this.pausedAfterRun = true;
    else this.#setState('paused');
  }

  resume() {
    this.pausedAfterRun = false;
    if (this.state === 'paused') this.#setState('ready');
    this.notify();
  }

  async retry() {
    this.failed.clear();
    if (this.state === 'unavailable') await this.#preflight();
    else if (this.state === 'error') this.#setState('ready');
    this.notify();
  }

  async stop() {
    this.state = 'stopped';
    clearTimeout(this.settleTimer);
    clearTimeout(this.limitTimer);
    if (this.run) {
      const done = this.run.done;
      killTree(this.run.child);
      await done;
    }
    if (this.shimDir) await rm(this.shimDir, { recursive: true, force: true });
  }

  async #preflight() {
    const result = await this.adapter.preflight();
    if (result.ok) {
      this.#setState('ready');
      this.notify();
    } else {
      this.#setState('unavailable', result.error);
    }
  }

  async #check() {
    if (this.checking) {
      this.recheck = true;
      return;
    }
    this.checking = true;
    try {
      if (this.run || !['ready', 'error', 'limited'].includes(this.state)) return;
      const { sidecar } = await load(this.docPath);
      if (this.#waiting(sidecar).length === 0) {
        if (this.state === 'limited') this.#setState('ready');
        return;
      }
      if (this.#rateLimited()) return;

      // Claim under the lock, re-reading the inbox so a chat session's `wait`
      // and this dispatcher never answer the same thread.
      let claimed = [];
      let markdown;
      const since = new Date().toISOString();
      await update(this.docPath, (s, doc) => {
        markdown = doc.markdown;
        claimed = this.#waiting(s);
        return claimed.reduce((acc, t) => applyOp(acc, { type: 'setWorking', threadId: t.id, by: this.name, since }), s);
      });
      if (claimed.length > 0) await this.#launch(claimed, markdown);
    } catch (error) {
      this.#setState('error', `could not start a run: ${error.message}`);
    } finally {
      this.checking = false;
      if (this.recheck) {
        this.recheck = false;
        this.notify();
      }
    }
  }

  #waiting(sidecar) {
    return inbox(sidecar, this.name, Date.now(), { mentionsOnly: this.mentionsOnly })
      .filter((t) => !this.failed.has(failureKey(t)));
  }

  #rateLimited() {
    const now = Date.now();
    this.runStarts = this.runStarts.filter((t) => now - t < HOUR_MS);
    if (this.runStarts.length < this.limits.runsPerHour) {
      this.retryAt = null;
      return false;
    }
    this.retryAt = new Date(this.runStarts[0] + HOUR_MS).toISOString();
    this.#setState('limited', `${this.limits.runsPerHour} runs in the last hour`);
    clearTimeout(this.limitTimer);
    this.limitTimer = setTimeout(() => this.notify(), this.runStarts[0] + HOUR_MS - now + 50);
    return true;
  }

  async #launch(threads, markdown) {
    const runDir = await mkdtemp(join(tmpdir(), 'opendoc-run-'));
    const lines = threadLines(markdown, threads);
    const payload = { doc: this.docFile, threads: threads.map((t, i) => ({ ...t, line: lines[i] })) };
    const prompt = buildPrompt({ name: this.name, docFile: this.docFile });
    const threadsFile = join(runDir, 'threads.json');
    const promptFile = join(runDir, 'prompt.md');
    await writeFile(threadsFile, JSON.stringify(payload, null, 2));
    await writeFile(promptFile, `${prompt}\n\n## Threads\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);

    const { command, args } = this.adapter.command({
      prompt, promptFile, threadsFile, docFile: this.docFile,
      sessionId: this.adapter.supportsSessions ? this.sessionId : null,
    });
    const child = spawn(command, args, {
      cwd: dirname(this.docPath),
      env: {
        ...agentEnv(process.env),
        PATH: `${this.shimDir}${delimiter}${process.env.PATH ?? ''}`,
        OPENDOC_AS: this.name,
        OPENDOC_KIND: 'agent',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const startedAt = new Date();
    this.runStarts.push(startedAt.getTime());
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', (d) => { if (stdout.length < MAX_STDOUT) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_STDERR) stderr += d; });
    child.stdin.on('error', () => {}); // the agent may not read stdin
    child.stdin.end(JSON.stringify(payload));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, this.limits.timeoutMs);

    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    this.run = { child, threadIds: threads.map((t) => t.id), done };
    this.#setState('running');

    let over = false;
    const ended = (code) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      this.#finish({ threads, startedAt, stdout, stderr, code, timedOut, spawnError, runDir }).finally(finish);
    };
    child.on('error', (error) => {
      spawnError = error;
      if (child.pid === undefined) ended(null); // never started; 'close' may not follow
    });
    child.on('close', (code) => ended(code));
  }

  async #finish({ threads, startedAt, stdout, stderr, code, timedOut, spawnError, runDir }) {
    const result = spawnError ? { ok: false, error: `could not start the agent: ${spawnError.message}` }
      : timedOut ? { ok: false, error: `timed out after ${Math.round(this.limits.timeoutMs / 60000)} min` }
      : this.adapter.parse({ stdout, stderr, code });

    // Threads the agent did not answer go back to the inbox.
    const ids = new Set(threads.map((t) => t.id));
    try {
      await update(this.docPath, (s) => s.threads
        .filter((t) => ids.has(t.id) && t.working && sameName(t.working.by, this.name))
        .reduce((acc, t) => applyOp(acc, { type: 'setWorking', threadId: t.id, by: this.name, since: null }), s));
    } catch {
      // the doc may be gone; nothing to clear
    }

    this.lastRun = {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      ok: result.ok,
      error: result.error ?? null,
      threads: threads.length,
      costUsd: result.costUsd ?? null,
      turns: result.turns ?? null,
      denials: result.denials ?? 0,
      log: lastLines(`${stderr}\n${stdout}`, LOG_LINES),
    };
    this.run = null;
    await rm(runDir, { recursive: true, force: true });
    if (this.state === 'stopped') return;

    if (result.ok) {
      this.sessionId = result.sessionId ?? this.sessionId;
      this.failed.clear();
    } else {
      // A broken session must not break every later run.
      this.sessionId = null;
      for (const t of threads) this.failed.add(failureKey(t));
    }
    if (this.pausedAfterRun) {
      this.pausedAfterRun = false;
      this.#setState('paused', result.ok ? null : result.error);
    } else {
      this.#setState(result.ok ? 'ready' : 'error', result.ok ? null : result.error);
    }
    this.notify();
  }

  #setState(state, error = null) {
    if (this.state === 'stopped') return;
    this.state = state;
    this.error = error;
    this.onStatus(this.status());
  }
}

// A thread is retried after a failure only once a human adds a new message.
const failureKey = (thread) => `${thread.id}:${thread.messages.at(-1).id}`;

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 5000).unref();
  }
}

// `opendoc` on the agent's PATH, pointing at this install, for sh and Windows shells.
async function makeShim() {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-bin-'));
  const node = process.execPath.replaceAll('\\', '/');
  const bin = BIN.replaceAll('\\', '/');
  await writeFile(join(dir, 'opendoc'), `#!/bin/sh\nexec "${node}" "${bin}" "$@"\n`);
  await chmod(join(dir, 'opendoc'), 0o755);
  await writeFile(join(dir, 'opendoc.cmd'), `@"${process.execPath}" "${BIN}" %*\r\n`);
  return dir;
}

function lastLines(text, count) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
}
