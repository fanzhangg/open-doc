// The dispatcher: when a comment is waiting on the agent (its latest message
// is from a human and mentions @agent or no one), claim the thread (the page shows the
// agent working on it) and start one headless agent run for the batch. The
// edit mode decides whether the run edits the doc or only proposes changes.
// At most one run per agent at a time; a failed run never loops.

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOp, diffEdits, findEdit, inbox, locate, newId, project, proposeChanges, sourceRange } from '../../core/index.js';
import { merge3 } from '../../core/merge.js';
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
 * States: starting, ready, running, error (last run failed), limited (runs
 * per hour reached), unavailable (preflight failed), stopped.
 * Presence, set by the human: 'online' answers every comment not addressed
 * to someone else, 'dnd' (do not disturb) only comments that @mention it.
 */
export class Dispatcher {
  constructor({ docPath, name, adapter, limits = {}, editMode = 'auto', presence = 'online', warning = null, onStatus = () => {}, settleMs = 300 }) {
    this.docPath = docPath;
    this.docFile = basename(docPath);
    this.name = name;
    this.adapter = adapter;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.editMode = editMode;
    this.presence = presence;
    this.warning = warning;
    this.onStatus = onStatus;
    this.settleMs = settleMs;
    this.state = 'starting';
    this.error = null;
    this.run = null;
    this.lastRun = null;
    this.sessionId = null;
    this.failed = new Set(); // "threadId:lastMessageId" of a failed run's threads
    this.runStarts = [];
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      editMode: this.editMode,
      presence: this.presence,
      kind: this.adapter.name,
      program: this.adapter.program ?? null,
      warning: this.warning,
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

  /** 'online' or 'dnd'. A run in progress finishes either way. */
  setPresence(presence) {
    if (presence === this.presence) return;
    this.presence = presence;
    this.onStatus(this.status());
    this.notify();
  }

  async retry() {
    this.failed.clear();
    if (this.state === 'unavailable') await this.#preflight();
    else if (this.state === 'error') this.#setState('ready');
    this.notify();
  }

  /** Start no more runs and wait for the one in progress, if any, to end. */
  async drain() {
    this.draining = true;
    clearTimeout(this.settleTimer);
    if (this.run) await this.run.done;
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
      if (this.run || this.draining || !['ready', 'error', 'limited'].includes(this.state)) return;
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
    return inbox(sidecar, this.name, Date.now(), { mentionsOnly: this.presence === 'dnd' })
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
    // A run kept to the doc starts in a folder of its own, so it names the
    // doc by absolute path.
    const workdir = this.adapter.workdir?.(this.docPath) ?? dirname(this.docPath);
    if (workdir !== dirname(this.docPath)) await mkdir(workdir, { recursive: true });
    const docRef = workdir === dirname(this.docPath) ? this.docFile : this.docPath.replaceAll('\\', '/');
    const payload = { doc: docRef, threads: threads.map((t, i) => ({ ...t, line: lines[i] })) };
    const prompt = buildPrompt({ name: this.name, docFile: docRef, editMode: this.editMode });
    const threadsFile = join(runDir, 'threads.json');
    const promptFile = join(runDir, 'prompt.md');
    await writeFile(threadsFile, JSON.stringify(payload, null, 2));
    await writeFile(promptFile, `${prompt}\n\n## Threads\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);

    const { command, args } = this.adapter.command({
      prompt, promptFile, threadsFile, docFile: this.docFile, docPath: this.docPath, editMode: this.editMode,
      sessionId: this.adapter.supportsSessions ? this.sessionId : null,
    });
    const child = spawn(command, args, {
      cwd: workdir,
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
    // `base` is the doc as it would be without this run: the doc it started
    // from, plus every change the human saved meanwhile (humanEdited).
    // `overwritten` holds changes to offer back once the run has replied.
    const run = { child, threadIds: threads.map((t) => t.id), done, base: markdown, overwritten: [] };
    this.run = run;
    this.#setState('running');

    let over = false;
    const ended = (code) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      this.#finish({ threads, run, startedAt, stdout, stderr, code, timedOut, spawnError, runDir }).finally(finish);
    };
    child.on('error', (error) => {
      spawnError = error;
      if (child.pid === undefined) ended(null); // never started; 'close' may not follow
    });
    child.on('close', (code) => ended(code));
  }

  /**
   * The human saved the doc from `before` to `after` while a run was going:
   * keep that change out of what the run is said to have edited. Where it
   * overlaps a change of the run, the human's text stands and the run's
   * change there is not recorded.
   */
  humanEdited(before, after) {
    if (!this.run || before === after) return;
    this.run.base = merge3(before, after, this.run.base, { prefer: 'ours' }).text;
  }

  /**
   * The human was typing where the agent's last run changed the doc, and the
   * editor kept the human's text. `changes` ({ before: the human's text now
   * on disk, after: the agent's }) are offered back as a proposal, in a reply
   * on the thread each belongs to; during a run, once the run has replied.
   * False when there is no run to attach them to.
   */
  async overwritten(changes) {
    if (this.run) {
      this.run.overwritten.push(...changes);
      return true;
    }
    if (!this.lastThreads) return false;
    await this.#offer(this.lastThreads, changes);
    return true;
  }

  async #offer(threads, changes) {
    await update(this.docPath, (s, doc) => {
      const byThread = new Map();
      for (const change of changes) {
        let proposal;
        try {
          [proposal] = proposeChanges(doc.markdown, [change]);
        } catch {
          continue; // the human's text changed again, or is not unique: nothing to point at
        }
        const id = threadAt(s.threads.filter((t) => threads.some((c) => c.id === t.id)), doc.markdown, proposal) ?? threads[0].id;
        byThread.set(id, [...(byThread.get(id) ?? []), proposal]);
      }
      const now = new Date().toISOString();
      let next = s;
      // An edit the run recorded that the human's text has since replaced is
      // now offered as a proposal; it no longer belongs on the run's reply.
      const offered = [...byThread.values()].flat();
      const replaced = (edit) => edit.after && offered.some((c) => c.after.includes(edit.after)) && !findEdit(doc.markdown, edit);
      for (const claimed of threads) {
        const known = new Set(claimed.messages.map((m) => m.id));
        const thread = next.threads.find((t) => t.id === claimed.id);
        for (const m of thread?.messages ?? []) {
          if (known.has(m.id) || !m.edits || !sameName(m.author.name, this.name) || !m.edits.some(replaced)) continue;
          next = applyOp(next, { type: 'attachEdits', threadId: thread.id, messageId: m.id, edits: m.edits.filter((e) => !replaced(e)) });
        }
      }
      for (const [threadId, proposal] of byThread) {
        const message = { id: newId('m'), author: { name: this.name, kind: 'agent' }, body: OVERWRITTEN, createdAt: now, proposal };
        next = applyOp(next, { type: 'addMessage', threadId, message });
      }
      return next;
    });
  }

  async #finish({ threads, run, startedAt, stdout, stderr, code, timedOut, spawnError, runDir }) {
    let result = spawnError ? { ok: false, error: `could not start the agent: ${spawnError.message}` }
      : timedOut ? { ok: false, error: `timed out after ${Math.round(this.limits.timeoutMs / 60000)} min` }
      : this.adapter.parse({ stdout, stderr, code });

    // Record what the run changed in the doc on the agent's replies; threads
    // the agent did not answer go back to the inbox.
    const ids = new Set(threads.map((t) => t.id));
    try {
      await update(this.docPath, (s, doc) => {
        const recorded = this.#recordEdits(s, threads, run.base, doc.markdown);
        return recorded.threads
          .filter((t) => ids.has(t.id) && t.working && sameName(t.working.by, this.name))
          .reduce((acc, t) => applyOp(acc, { type: 'setWorking', threadId: t.id, by: this.name, since: null }), recorded);
      });
    } catch {
      // the doc may be gone; nothing to record or clear
    }
    // A run must end every thread with a reply. One that did not would be
    // handed the same threads again at once, so it counts as failed instead.
    if (result.ok) {
      const silent = await this.#unanswered(threads);
      if (silent > 0) result = { ...result, ok: false, error: `finished without replying to ${silent === 1 ? 'a comment' : `${silent} comments`}` };
    }
    this.lastThreads = threads;
    if (run.overwritten.length > 0) await this.#offer(threads, run.overwritten).catch(() => {});

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
    this.#setState(result.ok ? 'ready' : 'error', result.ok ? null : result.error);
    this.notify();
  }

  // Attach each change to the reply this run posted in the thread it belongs
  // to (adding a short reply when there is none), so the human can review and
  // undo it from the comment.
  #recordEdits(sidecar, threads, before, after) {
    const byThread = attributeEdits(threads, before, after);
    const now = new Date().toISOString();
    let next = sidecar;
    for (const claimed of threads) {
      const edits = byThread.get(claimed.id);
      const thread = next.threads.find((t) => t.id === claimed.id);
      if (!edits?.length || !thread) continue;
      const known = new Set(claimed.messages.map((m) => m.id));
      const reply = thread.messages.findLast((m) => !known.has(m.id) && sameName(m.author.name, this.name));
      if (reply) {
        next = applyOp(next, { type: 'attachEdits', threadId: thread.id, messageId: reply.id, edits });
        continue;
      }
      const message = { id: newId('m'), author: { name: this.name, kind: 'agent' }, body: 'Edited the doc.', createdAt: now, edits };
      next = applyOp(next, { type: 'addMessage', threadId: thread.id, message });
    }
    return next;
  }

  // How many of the run's threads are still open with no new message from the agent.
  async #unanswered(threads) {
    try {
      const { sidecar } = await load(this.docPath);
      return threads.filter((claimed) => {
        const thread = sidecar.threads.find((t) => t.id === claimed.id);
        if (!thread || thread.status !== 'open') return false;
        const known = new Set(claimed.messages.map((m) => m.id));
        return !thread.messages.some((m) => !known.has(m.id) && sameName(m.author.name, this.name));
      }).length;
    } catch {
      return 0; // the doc may be gone
    }
  }

  #setState(state, error = null) {
    if (this.state === 'stopped') return;
    this.state = state;
    this.error = error;
    this.onStatus(this.status());
  }
}

/**
 * Which thread each change between `before` and `after` belongs to: the one
 * whose anchor (found in `before`) it overlaps or touches, the
 * most overlapped first. A change no anchor claims belongs to the only thread
 * of a one-thread run, or else to every thread of the run, as scope "run".
 * @returns {Map<string, object[]>} thread id → edits
 */
export function attributeEdits(threads, before, after) {
  const result = new Map();
  const changes = diffEdits(before, after);
  if (changes.length === 0) return result;
  const anchored = threads.filter((t) => t.anchor && !t.detached);
  const projection = anchored.length > 0 ? project(before) : null;
  const ranges = anchored.flatMap((t) => {
    const found = locate(projection.text, t.anchor);
    return found && found.start < found.end ? [{ id: t.id, ...sourceRange(projection, found.start, found.end) }] : [];
  });
  const add = (id, edit) => result.set(id, [...(result.get(id) ?? []), edit]);
  for (const { from, to, edit } of changes) {
    let best = null;
    for (const r of ranges) {
      if (from > r.end || to < r.start) continue;
      const overlap = Math.min(to, r.end) - Math.max(from, r.start);
      if (!best || overlap > best.overlap) best = { id: r.id, overlap };
    }
    if (best) add(best.id, edit);
    else if (threads.length === 1) add(threads[0].id, edit);
    else for (const t of threads) add(t.id, { ...edit, scope: 'run' });
  }
  return result;
}

const OVERWRITTEN = 'You were editing this when I changed it, so your text was kept. Here is my version, in case you want it instead.';

// The thread whose anchor overlaps or touches a proposed change, if any.
function threadAt(threads, markdown, change) {
  const projection = project(markdown);
  const end = change.start + change.before.length;
  for (const t of threads) {
    const found = t.anchor && !t.detached && locate(projection.text, t.anchor);
    if (!found || found.start >= found.end) continue;
    const range = sourceRange(projection, found.start, found.end);
    if (range.start <= end && change.start <= range.end) return t.id;
  }
  return threads.length === 1 ? threads[0].id : null;
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

// `opendoc` on the agent's PATH, pointing at this install, for sh and Windows
// shells. Inside the desktop app the runtime is Electron itself, which runs
// the CLI as plain Node only with ELECTRON_RUN_AS_NODE set.
async function makeShim() {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-bin-'));
  const node = process.execPath.replaceAll('\\', '/');
  const bin = BIN.replaceAll('\\', '/');
  const electron = Boolean(process.versions.electron);
  await writeFile(join(dir, 'opendoc'), `#!/bin/sh\n${electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec "${node}" "${bin}" "$@"\n`);
  await chmod(join(dir, 'opendoc'), 0o755);
  await writeFile(join(dir, 'opendoc.cmd'), `${electron ? '@set "ELECTRON_RUN_AS_NODE=1"\r\n' : ''}@"${process.execPath}" "${BIN}" %*\r\n`);
  return dir;
}

function lastLines(text, count) {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-count).join('\n');
}
