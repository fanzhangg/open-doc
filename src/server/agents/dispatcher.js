// The dispatcher: when a comment is waiting on the agent (its latest message
// is from a human and mentions @agent or no one), claim the thread (the page shows the
// agent working on it) and start one headless agent run for the batch. The
// edit mode decides whether the run edits the doc or only proposes changes.
// At most one run per agent at a time; a failed run never loops. The agents
// of one doc run at the same time, but write the doc one at a time (a
// Floor), so each run's edits are its own and two agents never edit the doc
// at once.

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeWorking, applyOp, diffEdits, findEdit, handedTo, inbox, locate, newId, openAsk, project, proposeChanges, sourceRange, workingList } from '../../core/index.js';
import { merge3 } from '../../core/merge.js';
import { sameName } from '../../core/mentions.js';
import { threadLines } from '../../core/lines.js';
import { load, readDoc, update } from '../../store/files.js';
import { agentEnv, buildPrompt } from './adapters.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'opendoc.js');
const HOUR_MS = 60 * 60 * 1000;
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const LOG_LINES = 40;

export const DEFAULT_LIMITS = { timeoutMs: 10 * 60 * 1000, runsPerHour: 20 };
export const EDIT_LEASE_MS = 5_000; // a guarded edit holds the floor at most this long without saying it is done
export const GUARD_WAIT_MS = 15_000; // how long the guard waits for the floor before refusing an edit

/**
 * The right to write the doc, shared by the agents of one doc. Their runs go
 * on at the same time; only the writing is one at a time, so each run's
 * edits stay its own. A run whose every edit passes the guard (a Claude Code
 * run) takes the floor for one edit at a time (`acquire`, from the guard
 * before the edit to the hook after it). A run that may edit the doc
 * otherwise holds it for the whole run (`take`); an agent that finds
 * comments waiting while another holds it waits for its turn ('queued'), and
 * looks again once the floor is released.
 *
 * The holder may take the floor again while it holds it (a run ending
 * while one of its edits waits); each `acquire` is matched by a `release`,
 * and the floor is free after the last. `before` is the doc as the holder
 * found it (with what the human saved since). Once free, the holder's
 * change, `before` to the doc then, goes into the base of every other run
 * (`dispatchers()`), so no other run counts it as its own.
 */
export class Floor {
  holder = null;
  before = null;
  #holds = 0;
  #queued = new Set();
  #waiters = new Set();

  constructor(dispatchers = () => []) {
    this.dispatchers = dispatchers;
  }

  /** Take the floor now, or be told when it is free (`notify`). */
  take(dispatcher) {
    if (this.holder && this.holder !== dispatcher) {
      this.#queued.add(dispatcher);
      return false;
    }
    if (this.holder !== dispatcher) this.#holds = 1;
    this.holder = dispatcher;
    this.#queued.delete(dispatcher);
    return true;
  }

  /** Take the floor, waiting up to `waitMs` for it; false if it stayed taken. */
  async acquire(dispatcher, waitMs = Infinity) {
    const deadline = Date.now() + waitMs;
    while (this.holder && this.holder !== dispatcher) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#waiters.delete(done);
          resolve();
        };
        const timer = Number.isFinite(left) ? setTimeout(done, left) : null;
        this.#waiters.add(done);
      });
    }
    this.#holds = this.holder === dispatcher ? this.#holds + 1 : 1;
    this.holder = dispatcher;
    return true;
  }

  /**
   * Give the floor back. `after` is the doc now, read just before: what the
   * holder changed since `before` goes into the other runs' bases.
   */
  release(dispatcher, after = null) {
    this.#queued.delete(dispatcher);
    if (this.holder !== dispatcher || --this.#holds > 0) return;
    const before = this.before;
    this.holder = null;
    this.before = null;
    if (before !== null && after !== null && before !== after) {
      for (const other of this.dispatchers()) if (other !== dispatcher) other.othersEdited(before, after);
    }
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const done of waiters) done();
    const queued = [...this.#queued];
    this.#queued.clear();
    for (const waiting of queued) waiting.notify();
  }

  /** The human saved the doc from `before` to `after`: not any run's change. */
  humanEdited(before, after) {
    if (this.before !== null && before !== after) this.before = merge3(before, after, this.before, { prefer: 'ours' }).text;
    for (const dispatcher of this.dispatchers()) dispatcher.othersEdited(before, after);
  }
}

/**
 * States: starting, ready, queued (comments wait while another agent of the
 * doc runs), running, error (last run failed), limited (runs per hour
 * reached), unavailable (preflight failed), stopped.
 * Presence follows Auto Commenter: 'online' also looks at every comment that
 * mentions no one and answers the ones that fit its persona (leaving the
 * rest without a reply passes them on); 'dnd' answers only comments
 * addressed to it.
 */
export class Dispatcher {
  /**
   * `guard` ({ url, token }) is where a run asks before each edit whether the
   * human is typing there (`opendoc guard`); `typingIn()` resolves to the
   * start of the paragraph the human is typing in, or null.
   * `persona` is the agent's role in the human's words; `others()` names the
   * other agents of the doc; `floor` is how they take turns writing it. `join` adds
   * the agent to the doc's participants when it starts (an agent from flags;
   * one from the roster is there because it was invited). `profile`
   * ({ webAccess, fileAccess, folder }) is shown with the status and told to
   * its runs; `folder` is the folder the doc was opened from, which runs may
   * read. `humanName()` resolves to the human's name, for the prompt.
   * `catchUp()` has the server take in the doc as it is on disk, run when a
   * run ends and before it counts as over, so the run's last edits are known
   * to be its own.
   */
  constructor({
    docPath, name, id = null, persona = '', profile = {}, adapter, limits = {}, editMode = 'auto', presence = 'online', warning = null,
    onStatus = () => {}, settleMs = 300, guard = null, typingIn = async () => null, humanName = async () => null, catchUp = async () => {}, held = () => false, floor = null, others = () => [], join = true, source = 'flags', participant = null,
  }) {
    this.docPath = docPath;
    this.docFile = basename(docPath);
    this.name = name;
    this.id = id;
    this.persona = persona;
    this.floor = floor ?? new Floor(() => [this]);
    this.others = others;
    this.profile = profile;
    this.join = join;
    this.participant = participant; // its entry when it joins: name, and who it is
    this.source = source;
    this.adapter = adapter;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.editMode = editMode;
    this.presence = presence;
    this.warning = warning;
    this.onStatus = onStatus;
    this.settleMs = settleMs;
    this.guard = guard;
    this.typingIn = typingIn;
    this.humanName = humanName;
    this.catchUp = catchUp;
    this.held = held; // threadId → whether the human is still rewriting its ask (not yet for agents)
    this.state = 'starting';
    this.error = null;
    this.run = null;
    this.lastRun = null;
    this.failed = new Set(); // "threadId:lastMessageId" of a failed run's threads
    this.runStarts = [];
    this.leased = false; // whether an edit the guard let through holds the floor
  }

  status() {
    return {
      name: this.name,
      id: this.id,
      source: this.source,
      autoComment: this.presence === 'online',
      webAccess: Boolean(this.profile.webAccess),
      fileAccess: Boolean(this.profile.fileAccess),
      readsFolder: Boolean(this.profile.folder),
      persona: this.persona,
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
    if (this.join) await update(this.docPath, (s) => applyOp(s, { type: 'join', participant: this.participant ?? { name: this.name, kind: 'agent' } }));
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
    clearTimeout(this.leaseTimer);
    if (this.run) {
      const done = this.run.done;
      killTree(this.run.child);
      await done;
    }
    this.floor.release(this);
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
      if (this.run || this.draining || !['ready', 'error', 'limited', 'queued'].includes(this.state)) return;
      const { sidecar } = await load(this.docPath);
      if (this.#waiting(sidecar).length === 0) {
        this.floor.release(this);
        if (this.state === 'limited' || this.state === 'queued') this.#setState('ready');
        return;
      }
      if (this.#rateLimited()) return;
      // A run that may edit the doc without the guard knowing holds the floor
      // throughout; others run whenever they like.
      if (this.#wholeRun() && !this.floor.take(this)) {
        if (this.state !== 'queued') this.#setState('queued');
        return;
      }

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
      if (this.#wholeRun()) this.floor.before = markdown;
      if (claimed.length > 0) await this.#launch(claimed, markdown);
      else this.#yield('ready');
    } catch (error) {
      this.#yield('error', `could not start a run: ${error.message}`);
    } finally {
      this.checking = false;
      if (this.recheck) {
        this.recheck = false;
        this.notify();
      }
    }
  }

  // Threads for this agent, except ones whose ask the human is still
  // rewriting, and open asks another participant is answering right now
  // (they come back if that one ends without a reply), so it can see whether
  // that reply already does what the ask wants. An ask addressed to several
  // agents is answered by all of them at once.
  #waiting(sidecar) {
    const now = Date.now();
    return inbox(sidecar, this.name, now, { mentionsOnly: this.presence === 'dnd' })
      .filter((t) => !this.failed.has(failureKey(t)) && !this.held(t.id) && !(this.#open(t) && activeWorking(t, now).length > 0));
  }

  // Whether the thread is an open ask for it, one it may take or leave: not
  // when another agent handed it the thread.
  #open(thread) {
    return openAsk(thread) && !handedTo(thread, this.name);
  }

  // Whether its runs may change the doc.
  #writes() {
    return this.editMode === 'auto';
  }

  // Whether the guard sees each edit of its runs before and after, so a run
  // needs the floor only while it edits.
  #guarded() {
    return this.#writes() && Boolean(this.guard && this.adapter.guardsEdits);
  }

  // Whether a run of it holds the floor from start to end.
  #wholeRun() {
    return this.#writes() && !this.#guarded();
  }

  // Give the turn back without running.
  #yield(state, error = null) {
    this.floor.release(this);
    this.#setState(state, error);
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
    // doc by absolute path. The folder starts empty every time: nothing a run
    // leaves there reaches the next one.
    const workdir = this.adapter.workdir?.(this.docPath) ?? dirname(this.docPath);
    if (workdir !== dirname(this.docPath)) {
      await rm(workdir, { recursive: true, force: true });
      await mkdir(workdir, { recursive: true });
    }
    await this.adapter.prepare?.({ workdir, docPath: this.docPath, editMode: this.editMode });
    const docRef = workdir === dirname(this.docPath) ? this.docFile : this.docPath.replaceAll('\\', '/');
    // With Auto Commenter, an open ask is the agent's to take or leave (`open`).
    const open = new Set(this.presence === 'online' ? threads.filter((t) => this.#open(t)).map((t) => t.id) : []);
    const payload = { doc: docRef, threads: threads.map((t, i) => ({ ...t, line: lines[i], ...(open.has(t.id) ? { open: true } : {}) })) };
    const typing = this.editMode === 'auto' ? await this.typingIn().catch(() => null) : null;
    const prompt = buildPrompt({
      name: this.name, docFile: docRef, editMode: this.editMode, typing, persona: this.persona, autoComment: this.presence === 'online', others: this.others(),
      human: await this.humanName().catch(() => null),
      webAccess: Boolean(this.profile.webAccess), fileAccess: Boolean(this.profile.fileAccess), docFolder: dirname(this.docPath),
      folder: this.profile.folder ?? null,
    });
    const threadsFile = join(runDir, 'threads.json');
    const promptFile = join(runDir, 'prompt.md');
    await writeFile(threadsFile, JSON.stringify(payload, null, 2));
    await writeFile(promptFile, `${prompt}\n\n## Threads\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`);

    const { command, args } = this.adapter.command({
      prompt, promptFile, threadsFile, docFile: this.docFile, docPath: this.docPath, editMode: this.editMode, guard: Boolean(this.guard),
    });
    const child = spawn(command, args, {
      cwd: workdir,
      env: {
        ...agentEnv(process.env),
        PATH: `${this.shimDir}${delimiter}${process.env.PATH ?? ''}`,
        OPENDOC_AS: this.name,
        OPENDOC_KIND: 'agent',
        ...(this.guard ? { OPENDOC_GUARD_URL: this.guard.url, OPENDOC_GUARD_TOKEN: this.guard.token } : {}),
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
    // `base` is the doc as it would be without this run: the doc when it
    // first took the floor (at the start for a whole-run holder, at its first
    // edit for a guarded run; null until then), plus every change the human
    // or another run made since (othersEdited).
    // `overwritten` holds changes to offer back once the run has replied.
    // `avoided` counts the edits the guard refused because the human was typing there.
    // `open` holds the open asks it may leave to others.
    const run = { child, threadIds: threads.map((t) => t.id), done, base: this.#wholeRun() ? markdown : null, overwritten: [], avoided: 0, open };
    this.run = run;
    this.#setState('running');

    let over = false;
    const ended = (code) => {
      if (over) return;
      over = true;
      run.ending = true;
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
   * The human, or another agent's run, changed the doc from `before` to
   * `after` while a run was going: keep that change out of what the run is
   * said to have edited. Where it overlaps a change of the run, their text
   * stands and the run's change there is not recorded.
   */
  othersEdited(before, after) {
    if (!this.run || this.run.base === null || before === after) return;
    this.run.base = merge3(before, after, this.run.base, { prefer: 'ours' }).text;
  }

  /**
   * The guard is about to let an edit of the run through: take the floor
   * for it, waiting up to `waitMs` while another run writes the doc. The doc
   * at the run's first edit is its base. The floor comes back once the edit
   * is done (`endEdit`), or after EDIT_LEASE_MS. False when the floor stayed
   * taken, or the run is ending.
   */
  async startEdit(waitMs = GUARD_WAIT_MS) {
    const run = this.run;
    if (!run || !this.#guarded()) return true; // a whole-run holder has the floor already
    if (run.ending) return false;
    clearTimeout(this.leaseTimer);
    if (!this.leased) {
      if (!(await this.floor.acquire(this, waitMs))) return false;
      if (run.ending) {
        this.floor.release(this); // the run ended while it waited
        return false;
      }
      this.leased = true;
    }
    this.leaseTimer = setTimeout(() => this.endEdit(), EDIT_LEASE_MS);
    if (this.floor.before === null) {
      const markdown = await readDoc(this.docPath).then((d) => d.markdown, () => null);
      if (markdown === null) return true; // the doc is gone; the edit fails on its own
      if (this.floor.holder !== this) return true; // the run ended meanwhile and gave the floor back
      this.floor.before ??= markdown;
      run.base ??= markdown;
    }
    return true;
  }

  /** The edit the guard let through is done, or given up on: the floor goes back. */
  async endEdit() {
    clearTimeout(this.leaseTimer);
    if (!this.leased) return;
    this.leased = false;
    await this.catchUp().catch(() => {}); // so the change is seen as this run's while it holds the floor
    const after = await readDoc(this.docPath).then((d) => d.markdown, () => null);
    this.floor.release(this, after);
  }

  /**
   * The human changed the ask of thread `threadId`: end the run answering
   * it, if one is, so the thread is answered afresh. Not a failure: what the
   * run did so far stays, and threads it did not answer go back to the inbox.
   */
  restart(threadId) {
    if (!this.run?.threadIds.includes(threadId)) return false;
    this.run.restarted = true;
    killTree(this.run.child);
    return true;
  }

  /** The guard refused an edit of the run because the human is typing there. */
  avoided() {
    if (this.run) this.run.avoided++;
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
    let result = run.restarted ? { ok: false, error: 'stopped: the comment it was answering changed' }
      : spawnError ? { ok: false, error: `could not start the agent: ${spawnError.message}` }
      : timedOut ? { ok: false, error: `timed out after ${Math.round(this.limits.timeoutMs / 60000)} min` }
      : this.adapter.parse({ stdout, stderr, code });
    await this.catchUp().catch(() => {}); // the file watcher may not have seen the last edit yet
    // A run that edited records its edits holding the floor, so no other
    // run's edit lands in between.
    const edited = run.base !== null;
    if (edited && this.#guarded()) {
      await this.floor.acquire(this);
      if (this.leased) { // an edit still holds it: this hold takes over
        clearTimeout(this.leaseTimer);
        this.leased = false;
        this.floor.release(this);
      }
    }

    // Record what the run changed in the doc on the agent's replies; threads
    // the agent did not answer go back to the inbox.
    const ids = new Set(threads.map((t) => t.id));
    try {
      await update(this.docPath, (s, doc) => {
        const recorded = edited ? this.#recordEdits(s, threads, run.base, doc.markdown) : s;
        return recorded.threads
          .filter((t) => ids.has(t.id) && workingList(t).some((w) => sameName(w.by, this.name)))
          .reduce((acc, t) => applyOp(acc, { type: 'setWorking', threadId: t.id, by: this.name, since: null }), recorded);
      });
    } catch {
      // the doc may be gone; nothing to record or clear
    }
    if (this.floor.holder === this) {
      const after = await readDoc(this.docPath).then((d) => d.markdown, () => null);
      this.floor.release(this, after);
    }
    // A run must end every thread addressed to it with a reply. One that did
    // not would be handed the same threads again at once, so it counts as
    // failed instead. An open ask it left without a reply is passed on.
    if (result.ok) {
      const silent = await this.#unanswered(threads);
      const passing = silent.filter((t) => run.open.has(t.id));
      if (passing.length > 0) {
        await update(this.docPath, (s) => passing.reduce((acc, t) => applyOp(acc, { type: 'pass', threadId: t.id, by: this.name }), s)).catch(() => {});
      }
      const missed = silent.length - passing.length;
      if (missed > 0) result = { ...result, ok: false, error: `finished without replying to ${missed === 1 ? 'a comment' : `${missed} comments`}` };
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
      // Edits the guard refused are the agent keeping out of the human's
      // way, not permissions it lacked.
      denials: Math.max(0, (result.denials ?? 0) - run.avoided),
      avoided: run.avoided,
      log: lastLines(`${stderr}\n${stdout}`, LOG_LINES),
    };
    this.run = null;
    await rm(runDir, { recursive: true, force: true });
    if (this.state === 'stopped') return;

    if (result.ok) {
      this.failed.clear();
    } else if (!run.restarted) {
      for (const t of threads) this.failed.add(failureKey(t));
    }
    const fine = result.ok || run.restarted;
    this.#setState(fine ? 'ready' : 'error', fine ? null : result.error);
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

  // The run's threads still open with no new message from the agent.
  async #unanswered(threads) {
    try {
      const { sidecar } = await load(this.docPath);
      return threads.filter((claimed) => {
        const thread = sidecar.threads.find((t) => t.id === claimed.id);
        if (!thread || thread.status !== 'open') return false;
        const known = new Set(claimed.messages.map((m) => m.id));
        return !thread.messages.some((m) => !known.has(m.id) && sameName(m.author.name, this.name));
      });
    } catch {
      return []; // the doc may be gone
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
