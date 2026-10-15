// Grant at first use (src/core/grants.js): a run's risky tool calls (the web,
// files beyond the doc) are left out of what it may do, and a PreToolUse hook
// (`opendoc guard`) asks the server first. The server answers from the
// human's grants, or shows the request in the comment thread and waits for
// the human: Allow once and Deny last for the rest of the run, Allow in this
// doc and Always become grants. No answer within the timeout counts as Deny.
// Anything that goes wrong on the way leaves the tool denied: the run's own
// permission rules do not allow it.

import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { newId } from '../../core/ops.js';
import { ASK_TIMEOUT_MS, ANSWERS, PERMISSION_LABELS } from '../../core/grants.js';

/** The tools that need a grant, by permission. */
export const ASK_TOOLS = Object.freeze({ web: ['WebSearch', 'WebFetch'], files: ['Read', 'Glob', 'Grep'] });
const PERMISSION_OF = Object.fromEntries(Object.entries(ASK_TOOLS).flatMap(([p, tools]) => tools.map((t) => [t, p])));

/**
 * What tool call `tool` (`input` as Claude Code gives it) reaches beyond the
 * doc: { permission, target, path, folder }, or null when it needs no grant
 * (another tool, the doc itself, the run's own working folder).
 */
export function requestFor(tool, input = {}, { docPath, workdir = null }) {
  const permission = PERMISSION_OF[tool];
  if (!permission) return null;
  if (permission === 'web') {
    const target = String((tool === 'WebFetch' ? input.url : input.query) ?? '').slice(0, 500);
    return { permission, target, path: null, folder: null };
  }
  const base = workdir ?? dirname(docPath);
  let raw = tool === 'Read' ? input.file_path : input.path;
  // A Glob with an absolute pattern and no path looks where the pattern starts.
  if (!raw && tool === 'Glob' && typeof input.pattern === 'string' && isAbsolute(input.pattern)) raw = globRoot(input.pattern);
  if (typeof raw !== 'string' || !raw) return null; // the working folder
  const path = resolve(base, raw);
  if (samePath(path, docPath) || (workdir && within(path, workdir))) return null;
  return { permission, target: path, path, folder: tool === 'Read' ? dirname(path) : path };
}

/** Whether `grant` lets agent `agentId` use `permission` on `docPath` (for files: `path`). */
export function covers(grant, { agentId, permission, docPath, path = null }) {
  if (grant.agent !== agentId || grant.permission !== permission) return false;
  if (grant.doc !== null && !samePath(grant.doc, docPath)) return false;
  return permission !== 'files' || grant.folder === null || (path !== null && within(path, grant.folder));
}

/** Whether agent `agentId` holds `permission` here without asking (for files: any folder). */
export function holds(grants, { agentId, permission, docPath }) {
  return grants.some((g) => g.agent === agentId && g.permission === permission && (g.doc === null || samePath(g.doc, docPath)));
}

/** The grants that hold in `docPath`, for the page: { id, agentId, permission, scope: 'doc' | 'always', folder, at }. */
export function grantsHere(grants, docPath) {
  return grants.filter((g) => g.doc === null || samePath(g.doc, docPath))
    .map((g) => ({ id: g.id, agentId: g.agent, permission: g.permission, scope: g.doc === null ? 'always' : 'doc', folder: g.folder, at: g.at }));
}

export function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
  return norm(a) === norm(b);
}

export function within(path, folder) {
  const rel = relative(folder, path);
  if (process.platform === 'win32' && /^[A-Za-z]:/.test(rel)) return false; // another drive
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function globRoot(pattern) {
  const parts = pattern.split(/[\\/]/);
  const at = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  return at === -1 ? dirname(pattern) : parts.slice(0, at).join('/') || '/';
}

/**
 * The requests waiting on the human for one doc. `grants()` reads the
 * current grants, `addGrant(grant)` saves one, `docPath()` is the doc's path
 * now, and `onChange()` runs whenever a request comes or goes.
 */
export class Permissions {
  constructor({ grants, addGrant, docPath, timeoutMs = ASK_TIMEOUT_MS, onChange = () => {} }) {
    this.grants = grants;
    this.addGrant = addGrant;
    this.docPath = docPath;
    this.timeoutMs = timeoutMs;
    this.onChange = onChange;
    this.pending = new Map(); // id → { request, member, run, settle, settled, timer }
  }

  /** The requests waiting on the human, for the page. */
  list() {
    return [...this.pending.values()].map((p) => p.request);
  }

  /**
   * Agent `member` (a dispatcher) is about to call `tool` with `input`.
   * Resolves to { decision: 'allow' | 'deny' | null, reason? }: null leaves
   * it to the run's own rules (the doc, the working folder). `signal` aborts
   * when the hook goes away (its run was stopped).
   */
  async decide(member, tool, input, signal = new AbortController().signal) {
    const docPath = this.docPath();
    const request = requestFor(tool, input, { docPath, workdir: member.adapter.workdir?.(docPath) ?? null });
    if (!request) return { decision: null };
    const label = PERMISSION_LABELS[request.permission];
    const run = member.run;
    if (!run || !member.id) return deny(`${member.name} may use ${label} only during a run.`);
    if (!member.asks?.includes(request.permission)) {
      return deny(`${member.name} does not have ${label} access. The human can let it ask for it in Settings > Agents.`);
    }
    for (;;) {
      const permit = run.permits.findLast((p) => p.permission === request.permission && (p.folder === null || within(request.path, p.folder)));
      if (permit) return permit.allow ? { decision: 'allow' } : deny(permit.reason);
      const grants = await this.grants();
      if (grants.some((g) => covers(g, { agentId: member.id, permission: request.permission, docPath, path: request.path }))) return { decision: 'allow' };
      if (signal.aborted || member.run !== run) return deny('The run ended before the human answered.');
      // Parallel calls of the same kind wait on one question.
      const same = [...this.pending.values()].find((p) => p.run === run && p.request.permission === request.permission);
      await (same ? same.settled : this.#ask(member, run, request, tool, grants, signal));
    }
  }

  #ask(member, run, { permission, target, folder }, tool, grants, signal) {
    const id = newId('p');
    const at = Date.now();
    const other = permission === 'web' ? 'files' : 'web';
    const docPath = this.docPath();
    const holdsOther = member.asks.includes(other)
      && (run.permits.some((p) => p.permission === other && p.allow) || holds(grants, { agentId: member.id, permission: other, docPath }));
    const request = {
      id,
      agent: member.name,
      agentId: member.id,
      permission,
      tool,
      target,
      folder,
      threadIds: [...run.threadIds],
      at: new Date(at).toISOString(),
      expiresAt: new Date(at + this.timeoutMs).toISOString(),
      warning: holdsOther
        ? `${member.name} can also use ${PERMISSION_LABELS[other]} here. With both, a web page could trick it into sending your files to a website.`
        : null,
    };
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const entry = { request, member, run, settled, settle: null, timer: null };
    const minutes = Math.max(1, Math.round(this.timeoutMs / 60000));
    entry.settle = (answer) => {
      if (!this.pending.has(id)) return;
      clearTimeout(entry.timer);
      signal.removeEventListener('abort', onAbort);
      this.pending.delete(id);
      if (answer) run.permits.push(answer);
      this.onChange();
      settle();
    };
    const onAbort = () => entry.settle(null);
    entry.timer = setTimeout(() => entry.settle({
      permission, folder: null, allow: false,
      reason: `The human did not answer within ${minutes} min, so ${PERMISSION_LABELS[permission]} is denied for this reply. Do without it, and say in your reply what you needed it for.`,
    }), this.timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    this.pending.set(id, entry);
    this.onChange();
    return settled;
  }

  /**
   * The human's answer to request `id`: 'once', 'doc', 'always' or 'deny'.
   * `folderOnly` limits an allowed request for files to the folder it named.
   */
  async answer(id, answer, { folderOnly = false } = {}) {
    const entry = this.pending.get(id);
    if (!entry) throw Object.assign(new Error('that request is no longer waiting'), { code: 'not_found' });
    if (!ANSWERS.includes(answer)) throw Object.assign(new Error('answer must be once, doc, always or deny'), { code: 'bad_input' });
    const { permission, folder: asked } = entry.request;
    const folder = permission === 'files' && folderOnly ? asked : null;
    if (answer === 'deny') {
      return entry.settle({
        permission, folder: null, allow: false,
        reason: `The human did not allow ${PERMISSION_LABELS[permission]} for this reply. Do without it, and say in your reply what you needed it for.`,
      });
    }
    if (answer === 'once') return entry.settle({ permission, folder, allow: true });
    await this.addGrant({
      id: newId('g'), agent: entry.request.agentId, permission, doc: answer === 'doc' ? this.docPath() : null, folder, at: new Date().toISOString(),
    });
    entry.settle(null); // the grant answers it
  }

  /** Forget every request (the server is closing): their runs see Deny. */
  clear() {
    for (const entry of [...this.pending.values()]) {
      entry.settle({ permission: entry.request.permission, folder: null, allow: false, reason: 'OpenDoc closed before the human answered.' });
    }
  }
}

const deny = (reason) => ({ decision: 'deny', reason });
