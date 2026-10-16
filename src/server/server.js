// Local editor server for one doc: static editor assets, a small JSON API,
// and a Server-Sent Events stream of changes (doc, sidecar, agents, settings).
// Single user, bound to 127.0.0.1, every API call carries a per-run token.

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpError, applyOp, blockAt, createAnchor, locate, newId, project, sourceRange } from '../core/index.js';
import { NAME_PATTERN, parseMentions, sameName } from '../core/mentions.js';
import { AGENT_PROGRAM_KEYS, AGENT_SERVER_KEYS, AgentError, DEFAULT_AGENT_ID, availableIn, createAgent, deleteAgent, docOnly, leaderless, updateAgent } from '../core/agents.js';
import { PROGRAM_KEYS, SettingsError } from '../core/settings.js';
import { StoreError, hashBytes, load, moveDoc, readDoc, readSidecar, sidecarPath, update, writeAtomic } from '../store/files.js';
import { VERSION_ID, moveHistory, readHistory, readVersion, recordVersion } from '../store/history.js';
import { configDir, editAgents, readSettings, settingsWithId, updateSettings, watchSettings } from '../store/settings.js';
import { watchDoc } from '../store/watch.js';
import { splice } from './splice.js';
import { Team } from './agents/team.js';
import { TextAsks } from './text-asks.js';
import { agentSpec } from './agents/config.js';
import { programStatus } from './agents/adapters.js';

export const DEFAULT_ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const TYPING_MS = 15_000; // the human counts as typing in a paragraph this long after their last keystroke there
const MENTION_SETTLE_MS = 3_000; // an @mention typed in the doc that ends a sentence is sent once its paragraph is still this long
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/assets/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/assets/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const FONT_PATH = /^\/assets\/fonts\/([a-z0-9-]+\.woff2)$/;
const BROWSER_OPS = new Set(['join', 'addThread', 'addMessage', 'resolve', 'reopen', 'retry', 'cancel']);
const ID = { t: /^t_[A-Za-z0-9_-]{6,}$/, m: /^m_[A-Za-z0-9_-]{6,}$/ };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The doc's agents run as a Team (src/server/agents/team.js): a headless
 * agent run starts whenever a comment waits on one of them, one run at a time.
 * `agent`, when given, is `{ name, adapter, limits, editMode, persona }`, an
 * agent from `serve` flags that joins the doc and works on it while this
 * server runs. `agentFromSettings: true` also runs the user's agents
 * (the Agents panel) that are invited into the doc, following every change
 * to them or to who is invited.
 * `settingsDir` is the folder of the user's settings file (default: the
 * per-user config folder). `typingMs` is how long the human counts as typing
 * in a paragraph after their last keystroke there (default 15 s).
 * An @mention typed in the doc is sent once its paragraph has been still for
 * `mentionIdleMs` (default `typingMs`), or `mentionSettleMs` (default 3 s)
 * when it ends a sentence, or at once when the human moves on from it.
 * `moveTo(newPath, move)` renames the doc while it is open (`move` defaults
 * to moveDoc and may return the final path); the page is told its new name.
 * `folder`, when given, is the folder the doc was opened from (the desktop
 * app's sidebar): the user's agents may read every file in it, though they
 * still work only on this doc. `setFolder(folder)` changes it.
 * @returns {Promise<{ url: string, port: number, token: string, team: Team, docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, setFolder: (folder: string | null) => Promise<void>, close: () => Promise<void> }>}
 */
export async function startServer(docPath, {
  port = 0, token = randomBytes(16).toString('hex'), assetsDir = DEFAULT_ASSETS, agent: fixedAgent, agentFromSettings: useSettings = false, folder = null,
  settingsDir = configDir(), typingMs = TYPING_MS, mentionSettleMs = MENTION_SETTLE_MS, mentionIdleMs = typingMs,
} = {}) {
  await readDoc(docPath); // fail early on a missing doc
  const clients = new Set();
  // An unstarred agent belongs to one doc, known by its full path.
  const docKey = () => resolve(docPath);
  // An agent's entry among the doc's participants: its name, and who it is.
  const asParticipant = (agent) => ({ name: agent.name, kind: 'agent', persona: agent.persona, instructions: agent.instructions });
  // The doc's agents; they start once the server listens (syncAgents).
  const broadcastAgents = () => broadcast('agents', team.statuses());
  const team = new Team({
    docPath,
    onChange: broadcastAgents,
    options: (spec) => ({
      onStatus: broadcastAgents,
      guard: { url: `http://127.0.0.1:${actualPort}`, token: guardToken(spec.name) },
      typingIn: async () => typingIn((await readDoc(docPath)).markdown.replace(/\r\n/g, '\n'))?.quote ?? null,
      humanName: async () => (await human()).name,
      catchUp: () => onFilesChanged(),
      held: (threadId) => textAsks.held(threadId),
    }),
  });
  let actualPort = port;
  let lastDocHash = null;
  let lastSidecarHash = null;
  let lastSettings = null;
  let missing = false; // the doc was moved or deleted on disk while open
  // Where the human last typed ({ anchor, at }, from the page), and the keys
  // the agents' runs use to ask the guard before an edit: one per agent, so
  // a request names the agent that made it, and not the page's token, which
  // would let a run act as the human.
  let editing = null;
  const guardTokens = new Map(); // agent name, lower case → token
  const guardToken = (name) => {
    const key = name.toLowerCase();
    if (!guardTokens.has(key)) guardTokens.set(key, randomBytes(16).toString('hex'));
    return guardTokens.get(key);
  };
  const guardedAgent = (given) => {
    for (const [key, value] of guardTokens) if (tokenMatches(given, value)) return team.get(key);
    return null;
  };
  // Writes to the doc and its sidecar run one at a time, so a rename never
  // lands in the middle of a save.
  let writes = Promise.resolve();
  const serial = (fn) => {
    const run = writes.then(fn);
    writes = run.catch(() => {});
    return run;
  };
  // Version history (src/store/history.js): the hash of the doc as this
  // server last wrote it, so the watcher does not take that write for
  // someone else's, and the queue that keeps versions in order.
  let lastWritten = null;
  let chronicle = Promise.resolve();

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error.status ?? statusFor(error);
      if (status >= 500) console.error(error);
      try {
        sendJson(res, status, { error: error.message, code: error.code ?? 'internal' });
      } catch (failed) {
        // Even the error reply failed (a bad header, say): drop the
        // connection rather than leave the request hanging.
        console.error(failed);
        res.destroy();
      }
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    checkHost(req, actualPort);

    const font = req.method === 'GET' && url.pathname.match(FONT_PATH);
    if (font) {
      let body;
      try {
        body = await readFile(join(assetsDir, 'fonts', font[1]));
      } catch {
        throw new HttpError(404, 'not_found', 'not found');
      }
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=86400', ...SECURITY_HEADERS });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && ASSETS[url.pathname]) {
      if (url.pathname === '/' && !tokenMatches(url.searchParams.get('t'), token)) {
        throw new HttpError(403, 'forbidden', 'Open the link printed by "opendoc serve".');
      }
      const [file, type] = ASSETS[url.pathname];
      let body;
      try {
        body = await readFile(join(assetsDir, file));
      } catch {
        throw new HttpError(500, 'no_assets', 'Editor assets are missing; run "npm run build".');
      }
      if (file === 'index.html') body = withSettings(body.toString('utf8'), (await readSettings(settingsDir)).settings);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      res.end(body);
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'not found');
    if (req.method === 'POST' && url.pathname === '/api/guard') {
      checkWriteRequest(req, actualPort);
      const agent = guardedAgent(req.headers['x-opendoc-guard']);
      if (!agent) throw new HttpError(403, 'forbidden', 'missing or wrong guard token');
      return sendJson(res, 200, await guard(agent, await readJson(req)));
    }
    if (!tokenMatches(req.headers['x-opendoc-token'] ?? url.searchParams.get('t'), token)) {
      throw new HttpError(403, 'forbidden', 'missing or wrong token');
    }
    const route = `${req.method} ${url.pathname}`;
    if (req.method !== 'GET') checkWriteRequest(req, actualPort);

    switch (route) {
      case 'GET /api/state':
        return sendJson(res, 200, await state());
      case 'PUT /api/doc': {
        const body = await readJson(req);
        return sendJson(...(await serial(() => saveDoc(body))));
      }
      case 'POST /api/ops': {
        const body = await readJson(req);
        return sendJson(res, 200, await applyBrowserOp(body));
      }
      case 'GET /api/events':
        return openEvents(req, res);
      case 'GET /api/settings':
        return sendJson(res, 200, await readSettings(settingsDir));
      case 'PUT /api/settings': {
        const patch = await readJson(req);
        if (patch && Object.hasOwn(patch, 'agents')) throw new HttpError(400, 'bad_input', 'agents are changed through /api/roster');
        if (patch && Object.hasOwn(patch, 'id')) throw new HttpError(400, 'bad_input', 'your id cannot be changed');
        await checkProgram(PROGRAM_KEYS, patch, (await readSettings(settingsDir)).settings);
        return sendJson(res, 200, { settings: await updateSettings(patch, settingsDir) });
      }
      case 'GET /api/agent': {
        const member = team.get(url.searchParams.get('name') ?? '');
        if (!member) throw new HttpError(404, 'no_agent', 'no such agent in this doc');
        return sendJson(res, 200, { status: member.status(), log: member.log() });
      }
      case 'POST /api/agent':
        return sendJson(res, 200, { status: await agentAction(await readJson(req)) });
      case 'GET /api/programs':
        return sendJson(res, 200, { programs: await programs() });
      case 'POST /api/programs/check': {
        const body = await readJson(req);
        return sendJson(res, 200, await recheckProgram(body?.kind));
      }
      case 'POST /api/agents/invite': {
        const body = await readJson(req);
        return sendJson(res, 200, await invite(body?.id));
      }
      case 'POST /api/agents/remove': {
        const body = await readJson(req);
        return sendJson(res, 200, await removeAgent(body?.name));
      }
      case 'POST /api/roster': {
        const body = await readJson(req);
        return sendJson(res, 200, await rosterCreate(body));
      }
      case 'PUT /api/roster': {
        const body = await readJson(req);
        return sendJson(res, 200, await rosterUpdate(body));
      }
      case 'POST /api/roster/delete': {
        const body = await readJson(req);
        return sendJson(res, 200, await rosterDelete(body));
      }
      case 'POST /api/editing': {
        const anchor = (await readJson(req))?.anchor;
        editing = anchor ? { anchor: validAnchor(anchor), at: Date.now() } : null;
        textAsks.caret(editing?.anchor ?? null);
        return sendJson(res, 200, {});
      }
      case 'POST /api/caret': {
        // Where the caret is (an anchor on its paragraph), or null when the
        // editor lost focus: an @mention typed in the text is sent once the
        // human moves on from it. Unlike typing, it keeps no agent out.
        const anchor = (await readJson(req))?.anchor;
        textAsks.caret(anchor ? validAnchor(anchor) : null);
        return sendJson(res, 200, {});
      }
      case 'POST /api/agent/overwritten': {
        const body = await readJson(req);
        const changes = validChanges(body?.changes);
        const member = typeof body.name === 'string' ? team.get(body.name) : team.editing() ?? team.lastToRun();
        if (!member) throw new HttpError(404, 'no_agent', 'no such agent in this doc');
        const offered = await serial(() => member.overwritten(changes));
        return sendJson(res, 200, { offered });
      }
      case 'GET /api/history':
        await chronicle;
        return sendJson(res, 200, { versions: await readHistory(docPath, settingsDir) });
      case 'GET /api/history/version': {
        const found = await readVersion(docPath, settingsDir, versionId(url.searchParams.get('id')));
        if (!found) throw new HttpError(404, 'not_found', 'no such version');
        return sendJson(res, 200, found);
      }
      case 'POST /api/history/restore': {
        const body = await readJson(req);
        return sendJson(...(await serial(() => restoreVersion(body))));
      }
      default:
        throw new HttpError(404, 'not_found', 'not found');
    }

    // `recreate: true` writes the page's text back when the doc has gone
    // missing from disk; otherwise a save needs the doc to be there.
    async function saveDoc(body) {
      if (typeof body.markdown !== 'string' || typeof body.baseHash !== 'string') {
        throw new HttpError(400, 'bad_input', 'expected { markdown, baseHash }');
      }
      let current;
      try {
        current = await readDoc(docPath);
      } catch (error) {
        if (body.recreate !== true || error.code !== 'no_doc') throw error;
        await mkdir(dirname(docPath), { recursive: true });
        lastWritten = hashBytes(Buffer.from(body.markdown));
        await writeAtomic(docPath, body.markdown);
        await update(docPath, (s) => s); // refresh anchors if the sidecar is still there
        await noteVersion(body.markdown, { kind: 'edit', author: await human() });
        return [res, 200, { docHash: lastWritten, markdown: body.markdown }];
      }
      if (current.hash !== body.baseHash) {
        return [res, 409, { code: 'conflict', markdown: current.markdown, docHash: current.hash }];
      }
      const incoming = current.markdown.includes('\r\n') ? body.markdown.replace(/\r?\n/g, '\r\n') : body.markdown;
      const next = splice(current.markdown, incoming);
      if (next !== current.markdown) {
        await noteDisk(current); // whatever reached the disk since, before the human's change
        lastWritten = hashBytes(Buffer.from(next));
        await writeAtomic(docPath, next);
        team.humanEdited(current.markdown, next); // not the agent's edit
        await update(docPath, (s) => s); // refresh anchors against the saved doc
        await noteVersion(next, { kind: 'edit', author: await human() });
        textAsks.humanSaved(current.markdown, next);
      }
      return [res, 200, { docHash: hashBytes(Buffer.from(next)), markdown: next }];
    }

    // Put the doc back the way it was in an earlier version, as the human's
    // change: a new version, so the restore can itself be undone. Comments
    // stay; their anchors follow the restored text like after any edit.
    async function restoreVersion(body) {
      const id = versionId(body?.id);
      if (typeof body.baseHash !== 'string') throw new HttpError(400, 'bad_input', 'expected { id, baseHash }');
      const current = await readDoc(docPath);
      if (current.hash !== body.baseHash) {
        return [res, 409, { code: 'conflict', markdown: current.markdown, docHash: current.hash }];
      }
      const found = await readVersion(docPath, settingsDir, id);
      if (!found) throw new HttpError(404, 'not_found', 'no such version');
      const next = found.markdown;
      if (next !== current.markdown) {
        await noteDisk(current);
        lastWritten = hashBytes(Buffer.from(next));
        await writeAtomic(docPath, next);
        team.humanEdited(current.markdown, next);
        await update(docPath, (s) => s);
        await noteVersion(next, { kind: 'restore', author: await human(), restoredFrom: id });
      }
      return [res, 200, { docHash: hashBytes(Buffer.from(next)), markdown: next }];
    }
  }

  // An agent's program (a custom command, or where Claude Code is) decides
  // what runs on this machine, so a page can only clear it. Setting one takes
  // the desktop app, which asks the user first, or editing settings.json.
  async function checkProgram(keys, patch, current) {
    if (!patch || typeof patch !== 'object') return;
    for (const key of keys) {
      if (Object.hasOwn(patch, key) && patch[key] !== null && patch[key] !== (current?.[key] ?? null)) {
        throw new HttpError(403, 'forbidden', "an agent's program can be set in the desktop app or in settings.json, not from the page");
      }
    }
  }

  async function state() {
    const { doc, sidecar } = await load(docPath);
    const { settings, saved } = await readSettings(settingsDir);
    return {
      doc: basename(docPath),
      markdown: doc.markdown,
      docHash: doc.hash,
      sidecar,
      settings,
      settingsSaved: saved,
      defaultName: defaultName(),
      agents: team.statuses(),
      docKey: docKey(), // which of the user's unstarred agents are this doc's own
      folder: folder && basename(folder), // the folder the agents may read, if any
    };
  }

  // ---- the doc's agents ----

  // Who should work on the doc now: the agent from flags, and the user's
  // agents that are participants of the doc (Clippy, whom it started with, this
  // doc's own, or starred ones brought in by an @mention or added), except
  // one being removed. Another doc's own agents never work here; this doc's own come
  // before a starred agent of the same name. A restart is due whenever an
  // agent's `key` changes; switching Auto Commenter only changes whom it answers.
  const leaving = new Set();
  async function wantedAgents() {
    const specs = [];
    if (fixedAgent) specs.push({ presence: 'online', ...fixedAgent, key: 'flags', source: 'flags', join: true });
    if (!useSettings) return specs;
    const { settings } = await readSettings(settingsDir);
    let participants;
    try {
      participants = (await readSidecar(docPath)).participants;
    } catch {
      return specs; // a sidecar that cannot be read invites no one
    }
    const ours = settings.agents.filter((a) => availableIn(a, docKey())).sort((a, b) => Number(a.starred) - Number(b.starred));
    for (const agent of ours) {
      const here = participants.some((p) => p.kind === 'agent' && sameName(p.name, agent.name));
      if (!here || leaving.has(agent.name.toLowerCase()) || specs.some((s) => sameName(s.name, agent.name))) continue;
      // A person of the same name keeps the name; the agent stays out.
      if (participants.some((p) => p.kind === 'human' && sameName(p.name, agent.name))) continue;
      const key = JSON.stringify({ ...agent, face: undefined, autoComment: undefined, claudeBin: settings.claudeBin, codexBin: settings.codexBin, docPath, folder });
      specs.push({ ...agentSpec(agent, settings, docPath, { folder }), key, source: 'roster', join: false, participant: asParticipant(agent) });
    }
    return specs;
  }

  // Bring the team in line with the settings and the sidecar, one change at a time.
  let agentChanges = Promise.resolve();
  let closed = false;
  let listening = false; // runs need the server's port, for the guard
  function syncAgents() {
    const run = agentChanges.then(async () => {
      if (!closed && listening) await team.sync(await wantedAgents());
    });
    agentChanges = run.catch((error) => console.error('Could not start the agents:', error));
    return agentChanges;
  }

  async function currentSettings() {
    return (await readSettings(settingsDir)).settings;
  }

  // Invite agent `id` from the user's roster: it joins the doc's participants
  // like a person added to it, and starts answering. Only the sidecar write
  // holds the write lock: starting the agent can wait on another agent's run,
  // and saves must not wait with it.
  async function invite(id) {
    const agent = (await currentSettings()).agents.find((a) => a.id === id && availableIn(a, docKey()));
    if (!agent) throw new HttpError(404, 'not_found', 'no such agent');
    const sidecar = await serial(() => update(docPath, (s) => {
      const taken = s.participants.find((p) => sameName(p.name, agent.name));
      if (taken && taken.kind !== 'agent') throw new HttpError(409, 'name_taken', `${taken.name} is a person in this doc; rename the agent first`);
      return applyOp(s, { type: 'join', participant: asParticipant(agent) });
    }));
    await syncAgents();
    return { sidecar, agents: team.statuses() };
  }

  // Remove an agent from the doc: its run in progress ends, and it leaves the
  // participants, so it is no longer offered for @mentions. Its comments stay.
  async function removeAgent(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new HttpError(400, 'bad_input', 'invalid name');
    if (fixedAgent && sameName(fixedAgent.name, name)) throw new HttpError(409, 'flags', `${name} was started with --agent; stop opendoc serve to remove it`);
    const { participants } = await readSidecar(docPath);
    if (!participants.some((p) => p.kind === 'agent' && sameName(p.name, name))) throw new HttpError(404, 'not_found', `no agent ${name} in this doc`);
    leaving.add(name.toLowerCase());
    try {
      await syncAgents(); // ends its run, outside the write lock (see invite)
      const sidecar = await serial(() => update(docPath, (s) => applyOp(s, { type: 'leave', name })));
      // This doc's own agent has nowhere else to be: removing it deletes it.
      const own = useSettings ? (await currentSettings()).agents.find((a) => docOnly(a) && a.doc === docKey() && sameName(a.name, name)) : null;
      const settings = own ? await editAgents((agents) => deleteAgent(agents, own.id), settingsDir) : null;
      return { sidecar, agents: team.statuses(), ...(settings ? { settings } : {}) };
    } finally {
      leaving.delete(name.toLowerCase());
    }
  }

  // New agent for the user's roster, from the page: any fields but its
  // program. With `invite`, it joins this doc at once.
  async function rosterCreate(body) {
    const { id: _id, ...fields } = body?.agent ?? {};
    await checkProgram(AGENT_PROGRAM_KEYS, fields, {});
    checkServerKeys(fields);
    // Unless starred, it is this doc's own.
    fields.doc = fields.starred === true ? null : docKey();
    const me = (await human()).name;
    // The first agent in the doc leads it: it starts with Auto Commenter.
    const { participants } = Object.hasOwn(fields, 'autoComment') ? {} : await readSidecar(docPath);
    const here = (a) => availableIn(a, docKey()) && participants.some((p) => p.kind === 'agent' && sameName(p.name, a.name));
    let created;
    const settings = await editAgents((agents) => {
      const lead = participants ? { autoComment: leaderless(agents.filter(here)) } : {};
      created = createAgent(agents, { ...fields, ...lead }, [me]);
      return [...agents, created];
    }, settingsDir).catch(agentError);
    const joined = body?.invite === true ? await invite(created.id) : {};
    return { agent: created, settings, ...joined };
  }

  // Change one of the user's agents. Renaming one that is in this doc keeps
  // it here under the new name; other docs keep the old one until it is
  // invited again. The answer does not wait for the agent to restart (after
  // a run in progress, then checking its program): a switch on its card
  // flips at once, and the new status follows over SSE.
  async function rosterUpdate(body) {
    const id = body?.id;
    const patch = body?.patch ?? {};
    const before = (await currentSettings()).agents.find((a) => a.id === id);
    if (!before) throw new HttpError(404, 'not_found', 'no such agent');
    await checkProgram(AGENT_PROGRAM_KEYS, patch, before);
    checkServerKeys(patch);
    // Starring puts it in the library, for every doc. Unstarring keeps it in
    // this doc as its own; one not in this doc leaves the library (the docs
    // that use it still describe it, and set it up again when opened).
    const here = (await readSidecar(docPath)).participants.some((p) => p.kind === 'agent' && sameName(p.name, before.name));
    if (patch.starred === true) patch.doc = null;
    if (patch.starred === false && before.starred) {
      if (!here) return rosterDelete({ id });
      patch.doc = docKey();
    }
    const me = (await human()).name;
    const settings = await editAgents((agents) => updateAgent(agents, id, patch, [me]), settingsDir).catch(agentError);
    const after = settings.agents.find((a) => a.id === id);
    // The doc keeps who its agents are: their names, personas and instructions.
    if (after && here && ['name', 'persona', 'instructions'].some((k) => after[k] !== before[k])) {
      await serial(() => update(docPath, (s) => {
        if (!s.participants.some((p) => p.kind === 'agent' && sameName(p.name, before.name))) return s;
        if (!sameName(after.name, before.name)) return applyOp(applyOp(s, { type: 'leave', name: before.name }), { type: 'join', participant: asParticipant(after) });
        return applyOp(s, { type: 'describe', name: after.name, persona: after.persona, instructions: after.instructions });
      }));
    }
    syncAgents();
    return { settings, agents: team.statuses() };
  }

  // Delete one of the user's agents; it leaves this doc too. Other docs keep
  // its name among their participants, as someone not available here.
  async function rosterDelete(body) {
    const agent = (await currentSettings()).agents.find((a) => a.id === body?.id);
    if (!agent) throw new HttpError(404, 'not_found', 'no such agent');
    const settings = await editAgents((agents) => deleteAgent(agents, agent.id), settingsDir).catch(agentError);
    await serial(() => update(docPath, (s) => applyOp(s, { type: 'leave', name: agent.name })));
    await syncAgents();
    return { settings, agents: team.statuses() };
  }

  // Which doc an agent belongs to is the server's to say.
  function checkServerKeys(fields) {
    const key = AGENT_SERVER_KEYS.find((k) => Object.hasOwn(fields, k));
    if (key) throw new HttpError(400, 'bad_input', `${key} is set by the server`);
  }

  // The first time a doc is opened with no agents in it, Clippy (the agent
  // the app comes with, under whatever name it has now) joins it, so every
  // new doc has someone to answer; other agents are added in the doc. A doc
  // that has agents keeps the ones it has.
  async function joinDefaultAgent() {
    if (!useSettings) return;
    const clippy = (await currentSettings()).agents.find((a) => a.id === DEFAULT_AGENT_ID && a.starred);
    if (!clippy) return; // deleted or made one doc's own: no one
    let participants;
    try {
      participants = (await readSidecar(docPath)).participants;
    } catch {
      return; // a sidecar that cannot be read invites no one
    }
    if (participants.some((p) => p.kind === 'agent')) return;
    await serial(() => update(docPath, (s) => {
      if (s.participants.some((p) => sameName(p.name, clippy.name))) return s; // a person of that name keeps it
      return applyOp(s, { type: 'join', participant: asParticipant(clippy) });
    }));
  }

  // A doc carries its agents (SPEC §2.4). One that is not set up here yet (a
  // cloned repo, another computer, or one unstarred elsewhere) is set up from
  // the doc as this doc's own, with the safest permissions: it proposes
  // edits (not the default for new agents: the doc's text can steer it),
  // answers only when @mentioned, and has no web or files. A doc's own
  // agent follows what the doc says it is. Permissions never come from the doc.
  async function adoptDocAgents() {
    if (!useSettings) return false;
    let participants;
    try {
      participants = (await readSidecar(docPath)).participants;
    } catch {
      return false;
    }
    const me = (await human()).name;
    const described = participants.filter((p) => p.kind === 'agent' && (p.persona || p.instructions) && !sameName(p.name, me));
    const adopt = (agents) => {
      let next = agents;
      for (const p of described) {
        const persona = p.persona ?? '';
        const instructions = p.instructions ?? '';
        const mine = next.find((a) => sameName(a.name, p.name) && availableIn(a, docKey()));
        if (!mine) next = [...next, createAgent(next, { name: p.name, persona, instructions, doc: docKey(), editMode: 'approve', autoComment: false }, [me])];
        else if (docOnly(mine) && (mine.persona !== persona || mine.instructions !== instructions)) next = updateAgent(next, mine.id, { persona, instructions });
      }
      return next;
    };
    const roster = (await currentSettings()).agents;
    if (adopt(roster) === roster) return false;
    await editAgents(adopt, settingsDir);
    return true;
  }

  // Add the doc as it now reads to its history (one version at a time, in
  // order); a failure is logged and never stops a save.
  function noteVersion(markdown, change) {
    const run = chronicle.then(async () => {
      const version = await recordVersion(docPath, settingsDir, markdown, change);
      if (version) broadcast('history', { id: version.id });
    });
    chronicle = run.catch((error) => console.error('Could not record a version:', error));
    return chronicle;
  }

  // The doc on disk changed and not by this server's hand: the edit of the
  // agent holding the floor (only one writes at a time), otherwise a change
  // made outside OpenDoc.
  function noteDisk(doc) {
    if (doc.hash === lastWritten) return chronicle;
    const agentNow = team.editing()?.status();
    return noteVersion(doc.markdown, agentNow
      ? { kind: 'edit', author: { name: agentNow.name, kind: 'agent' }, threadIds: agentNow.threadIds }
      : { kind: 'external', author: null });
  }

  // The human, by the id that keeps them one person in the doc whatever
  // their name (src/core/ops.js identify). `aka`: names they went by before
  // the doc knew their id: the suggested one, and their face's seed, which
  // keeps the name they had before their first rename.
  async function me() {
    const settings = await settingsWithId(settingsDir);
    const aka = [defaultName(), settings.face].filter((n, i, all) => typeof n === 'string' && NAME_PATTERN.test(n) && all.indexOf(n) === i);
    return { author: { name: settings.name ?? defaultName(), kind: 'human', id: settings.id }, aka };
  }

  async function human() {
    return (await me()).author;
  }

  const asHuman = (s, { author, aka }) => applyOp(s, { type: 'identify', participant: author, aka });

  // The doc calls the human by the name in their settings.
  async function renameHuman() {
    const who = await me();
    await serial(() => update(docPath, (s) => asHuman(s, who)));
  }

  // 'retry' an agent that is offline.
  // ---- Agents > Programs ----

  // The last check of each program, for the path it checked: opening the
  // page again does not run the programs again; a new path, or Check, does.
  const programChecks = {};
  async function programs(recheck = null) {
    const settings = await currentSettings();
    const kinds = ['claude', 'codex'];
    for (const kind of kinds) {
      const bin = settings[`${kind}Bin`] ?? null;
      const last = programChecks[kind];
      if (!last || last.bin !== bin || recheck === kind) programChecks[kind] = { bin, status: programStatus(kind, bin) };
    }
    return Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await programChecks[kind].status])));
  }

  // Check: run the program's checks again, then retry this doc's agents that
  // could not start on it. Nothing else re-checks an agent's program.
  async function recheckProgram(kind) {
    if (kind !== 'claude' && kind !== 'codex') throw new HttpError(400, 'bad_input', 'kind must be claude or codex');
    const result = await programs(kind);
    const stuck = team.statuses().filter((s) => s.kind === kind && s.state === 'unavailable');
    await Promise.all(stuck.map((s) => team.get(s.name)?.retry()));
    return { programs: result, agents: team.statuses() };
  }

  async function agentAction(body) {
    const member = team.get(typeof body?.name === 'string' ? body.name : '');
    if (!member) throw new HttpError(404, 'no_agent', 'no such agent in this doc');
    if (body.action !== 'retry') throw new HttpError(400, 'bad_input', 'action must be retry');
    await member.retry();
    return member.status();
  }

  // An @mention of an agent typed in the doc's text, not in a comment, works
  // like one (src/server/text-asks.js): once the human is done writing it,
  // it becomes their comment on the text from the @ to the end of its
  // paragraph, and the agent answers it. Until then, and until the agent
  // answers, the comment follows that text.
  const textAsks = new TextAsks({
    idleMs: mentionIdleMs,
    settleMs: mentionSettleMs,
    mentionable: () => mentionableAgents(),
    text: async () => project((await readDoc(docPath)).markdown).text,
    send: (ask) => sendTextAsk(ask),
    open: async (threadId, messageId) => {
      try {
        const thread = (await readSidecar(docPath)).threads.find((t) => t.id === threadId);
        return Boolean(thread && thread.status === 'open' && thread.messages.at(-1)?.id === messageId);
      } catch {
        return false;
      }
    },
    rebind: (ask) => serial(() => rebindTextAsk(ask)),
    restart: (threadId) => team.restart(threadId),
    release: () => team.notify(),
  });

  async function sendTextAsk({ name, text, start, end }) {
    const roster = useSettings ? (await currentSettings()).agents.filter((a) => availableIn(a, docKey())) : [];
    const who = await me();
    const { author } = who;
    const threadId = newId('t');
    const messageId = newId('m');
    let sent = false;
    let joined = false;
    // Only the write holds the lock: bringing an agent in (syncAgents) can
    // wait on another agent's run, and saves must not wait with it.
    await serial(() => update(docPath, (s) => {
      let next = asHuman(s, who);
      if (!next.participants.some((p) => sameName(p.name, name))) {
        const agent = roster.find((a) => sameName(a.name, name));
        if (!agent) return s;
        next = applyOp(next, { type: 'join', participant: asParticipant(agent) });
        joined = true;
      }
      sent = true;
      const message = { id: messageId, author, body: text.slice(start, end), createdAt: new Date().toISOString() };
      return applyOp(next, { type: 'addThread', id: threadId, anchor: createAnchor(text, start, end), message });
    }));
    freeParagraph(text, start);
    if (joined) await syncAgents();
    return sent ? { threadId, messageId } : null;
  }

  // The human rewrote an ask already sent, before the agent answered: the
  // comment takes the new text, as a new ask to every agent.
  async function rebindTextAsk({ threadId, messageId, text, start, end }) {
    await update(docPath, (s) => {
      const thread = s.threads.find((t) => t.id === threadId);
      if (!thread || thread.messages.at(-1)?.id !== messageId) return s;
      const body = text.slice(start, end);
      const messages = thread.messages.map((m) => (m.id === messageId ? { ...m, body, mentions: parseMentions(body, s.participants) } : m));
      const next = { ...thread, anchor: createAnchor(text, start, end), detached: false, messages, ...(thread.passed ? { passed: [] } : {}) };
      return { ...s, threads: s.threads.map((t) => (t === thread ? next : t)) };
    });
    freeParagraph(text, start);
  }

  // The human is done with the ask at `start` of `text`: the agent may edit
  // its paragraph to answer (a new keystroke there counts again).
  function freeParagraph(text, start) {
    const at = editing && locate(text, editing.anchor);
    const block = blockAt(text, start);
    if (at && block.start <= at.end && at.start <= block.end) editing = null;
  }

  // Agents an @mention in the text can reach: the doc's agents, and the
  // user's other agents (a mention brings one in, as in a comment).
  async function mentionableAgents() {
    const names = team.statuses().map((s) => s.name);
    let participants = [];
    try {
      participants = (await readSidecar(docPath)).participants;
    } catch {
      // no sidecar yet: no participants
    }
    names.push(...participants.filter((p) => p.kind === 'agent').map((p) => p.name));
    if (useSettings) names.push(...(await currentSettings()).agents.filter((a) => availableIn(a, docKey())).map((a) => a.name));
    const people = participants.filter((p) => p.kind === 'human');
    return names.filter((name, i) => names.findIndex((n) => sameName(n, name)) === i && !people.some((p) => sameName(p.name, name)));
  }

  // A comment that @mentions one of the user's agents not in the doc yet
  // brings it in first, as mentioning a person in Docs shares the doc with
  // them; then the mention counts, and that agent answers.
  async function applyBrowserOp(body) {
    const who = await me();
    const op = validateOp(body?.op, who.author);
    const message = op.message;
    const roster = message && useSettings ? (await currentSettings()).agents.filter((a) => availableIn(a, docKey())) : [];
    let joined = false;
    // Only the write holds the lock (see sendTextAsk).
    const sidecar = await serial(() => update(docPath, (s) => {
      let next = asHuman(s, who);
      for (const name of parseMentions(message?.body ?? '', roster)) {
        if (next.participants.some((p) => sameName(p.name, name))) continue;
        next = applyOp(next, { type: 'join', participant: asParticipant(roster.find((a) => sameName(a.name, name))) });
        joined = true;
      }
      return applyOp(next, op);
    }));
    if (joined) await syncAgents();
    // Retrying an agent that cannot start checks its program again first.
    const retried = op.type === 'retry' ? team.get(op.name) : null;
    if (retried?.status().state === 'unavailable') await retried.retry();
    return { sidecar, ...(joined || retried ? { agents: team.statuses() } : {}) };
  }

  function openEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ docHash: lastDocHash, sidecarHash: lastSidecarHash, missing })}\n\n`);
    // Agents start after the server does, so their statuses may have changed
    // since the page read /api/state.
    res.write(`event: agents\ndata: ${JSON.stringify(team.statuses())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  // An edit `agent`'s run is about to make (from `opendoc guard`): it waits
  // while another agent writes the doc, and takes the floor until the edit
  // is done (`event: 'post'`, from the hook after it). Refused when the
  // floor stays taken, or while it would change the paragraph the human
  // typed in during the last `typingMs`; otherwise the page is told where it
  // is about to land.
  async function guard(agent, body) {
    if (body?.event === 'post') {
      await agent.endEdit();
      return {};
    }
    const old = typeof body?.oldString === 'string' ? body.oldString.replace(/\r\n/g, '\n') : '';
    if (!old || !(await aboutDoc(body))) return { allow: true };
    if (!(await agent.startEdit())) {
      const by = team.editing();
      return {
        allow: false,
        reason: `${by ? `@${by.name} is` : 'Another agent is'} editing the doc right now. Do the rest of your work first and try this edit again after that; if it is refused again, propose the change with opendoc propose instead of editing.`,
      };
    }
    const markdown = (await readDoc(docPath)).markdown.replace(/\r\n/g, '\n');
    const at = markdown.indexOf(old);
    if (at === -1) {
      await agent.endEdit();
      return { allow: true }; // the edit fails on its own
    }
    const human = typingIn(markdown);
    if (human && at < human.end && human.start < at + old.length) {
      agent.avoided();
      await agent.endEdit();
      return {
        allow: false,
        reason: `The human is typing in the paragraph that starts "${human.quote}" right now. Edit other parts first. If you still need to change this paragraph, try once more after that; if it is refused again, propose the change with opendoc propose instead of editing.`,
      };
    }
    broadcast('agentTarget', { quote: project(old).text.trim().slice(0, 300) });
    return { allow: true };
  }

  // Whether the edit the guard is asked about is to the doc (a run that may
  // read other files can also be refused edits to them). A request that does
  // not say is taken to be.
  async function aboutDoc({ filePath, cwd }) {
    if (typeof filePath !== 'string' || !filePath) return true;
    const real = (path) => realpath(path).catch(() => path);
    const [edited, doc] = await Promise.all([real(resolve(typeof cwd === 'string' ? cwd : dirname(docPath), filePath)), real(resolve(docPath))]);
    return process.platform === 'linux' ? edited === doc : edited.toLowerCase() === doc.toLowerCase();
  }

  // The whole lines of `markdown` the human typed in during the last
  // `typingMs`, with the start of their text: { start, end, quote }, or null.
  function typingIn(markdown) {
    if (!editing || Date.now() - editing.at > typingMs) return null;
    const projection = project(markdown);
    const found = locate(projection.text, editing.anchor);
    if (!found) return null;
    const range = sourceRange(projection, found.start, found.end);
    const start = markdown.lastIndexOf('\n', range.start - 1) + 1;
    const lineEnd = markdown.indexOf('\n', range.end);
    const quote = projection.text.slice(found.start, found.end).split('\n')[0].slice(0, 60);
    return { start, end: lineEnd === -1 ? markdown.length : lineEnd, quote };
  }

  function broadcast(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(chunk);
  }

  // Watch both files; refresh anchors when the doc changes (the agent may
  // have edited it directly) and tell the page what changed, including the
  // doc going missing (moved or deleted outside the app) and coming back.
  async function onFilesChanged() {
    try {
      let doc;
      try {
        doc = await readDoc(docPath);
      } catch (error) {
        if (error.code !== 'no_doc') throw error;
        if (!missing) {
          missing = true;
          broadcast('missing', { missing: true, doc: basename(docPath) });
        }
        return;
      }
      if (missing) {
        missing = false;
        broadcast('missing', { missing: false, doc: basename(docPath) });
      }
      if (doc.hash !== lastDocHash) {
        lastDocHash = doc.hash;
        await noteDisk(doc);
        await load(docPath);
        broadcast('doc', { docHash: doc.hash });
      }
      const sidecarHash = await fileHash(sidecarPath(docPath));
      if (sidecarHash !== lastSidecarHash) {
        lastSidecarHash = sidecarHash;
        broadcast('sidecar', { hash: sidecarHash });
        team.notify();
        // Someone may have been invited or removed, or the doc (a git pull)
        // may bring agents of its own.
        adoptDocAgents().catch((error) => console.error('Could not set up the doc\'s agents:', error)).finally(() => syncAgents());
      }
    } catch (error) {
      if (!(error instanceof StoreError)) console.error(error);
    }
  }
  // Settings are shared with every other window and `serve` run: pass on
  // changes from any of them.
  async function onSettingsChanged() {
    try {
      const { settings } = await readSettings(settingsDir);
      const json = JSON.stringify(settings);
      if (json === lastSettings) return;
      lastSettings = json;
      broadcast('settings', settings);
      syncAgents();
      await renameHuman();
    } catch (error) {
      console.error(error);
    }
  }

  async function moveTo(newPath, move = moveDoc) {
    return serial(async () => {
      const before = docKey();
      const target = (await move(docPath, newPath)) ?? newPath;
      stopWatching();
      await team.stop();
      await chronicle;
      // This doc's own agents move with it.
      if (useSettings) {
        await editAgents((agents) => agents.map((a) => (a.doc === before ? { ...a, doc: resolve(target) } : a)), settingsDir)
          .catch((error) => console.error('Could not move the doc\'s agents:', error));
      }
      await moveHistory(docPath, target, settingsDir).catch((error) => console.error('Could not move the history:', error));
      docPath = target;
      team.docPath = target;
      missing = false;
      stopWatching = watchDoc(docPath, onFilesChanged);
      await syncAgents(); // hooks, and so warnings, depend on the folder
      broadcast('renamed', { doc: basename(docPath), docKey: docKey() });
      return docPath;
    });
  }

  const opened = await readDoc(docPath);
  lastDocHash = opened.hash;
  await noteDisk(opened); // the doc as first seen, or as changed while it was not open
  lastSidecarHash = await fileHash(sidecarPath(docPath));
  // The agents the doc carries, set up here if they are new to this machine;
  // a doc with none yet starts with Clippy.
  await adoptDocAgents().catch((error) => console.error('Could not set up the doc\'s agents:', error));
  await joinDefaultAgent().catch((error) => console.error('Could not bring in Clippy:', error));
  await renameHuman().catch((error) => console.error('Could not put your name in the doc:', error));
  lastSettings = JSON.stringify((await readSettings(settingsDir)).settings);
  let stopWatching = watchDoc(docPath, onFilesChanged);
  const stopWatchingSettings = watchSettings(onSettingsChanged, settingsDir);
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  listening = true;

  await syncAgents();

  return {
    url: `http://127.0.0.1:${actualPort}/?t=${token}`,
    port: actualPort,
    token,
    team,
    docPath: () => docPath,
    moveTo,
    async setFolder(next) {
      folder = next;
      broadcast('folder', { folder: folder && basename(folder) });
      await syncAgents(); // they restart with the folder to read
    },
    async close() {
      clearInterval(heartbeat);
      textAsks.stop();
      stopWatching();
      stopWatchingSettings();
      closed = true;
      await team.stop(); // ends runs in progress, which a pending agent change may be waiting on
      await agentChanges;
      await team.stop();
      for (const res of clients) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

// DNS rebinding: only answer requests addressed to the loopback name we serve.
function checkHost(req, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.host)) throw new HttpError(403, 'forbidden', 'unexpected Host header');
}

// Writes must come from our own page: same origin (when the browser sends
// one) and a JSON body, which a cross-site form cannot produce.
function checkWriteRequest(req, port) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    throw new HttpError(403, 'forbidden', 'cross-origin write refused');
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'bad_input', 'expected application/json');
  }
}

function tokenMatches(given, token) {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

// The browser speaks for the human `me`, whatever name it sends. Timestamps come from the server clock. A
// message may carry `edits` and `undoes` (undoing an edit) or `applies`
// (applying a proposal); the core validates their shape.
function validateOp(op, me) {
  if (!op || !BROWSER_OPS.has(op.type)) throw new HttpError(400, 'bad_input', `operation not allowed: ${op?.type}`);
  const now = new Date().toISOString();
  const message = (m) => {
    if (!m || !ID.m.test(m.id ?? '') || typeof m.body !== 'string') throw new HttpError(400, 'bad_input', 'invalid message');
    const out = { id: m.id, author: me, body: m.body, createdAt: now };
    for (const key of ['undoes', 'applies']) {
      if (m[key] === undefined) continue;
      if (!ID.m.test(m[key] ?? '')) throw new HttpError(400, 'bad_input', `invalid ${key}`);
      out[key] = m[key];
    }
    if (m.edits !== undefined) out.edits = m.edits;
    return out;
  };
  const threadId = (id) => {
    if (!ID.t.test(id ?? '')) throw new HttpError(400, 'bad_input', 'invalid thread id');
    return id;
  };
  switch (op.type) {
    case 'join':
      return { type: 'join', participant: me };
    case 'addThread':
      return { type: 'addThread', id: threadId(op.id), anchor: validAnchor(op.anchor), message: message(op.message) };
    case 'addMessage':
      return { type: 'addMessage', threadId: threadId(op.threadId), message: message(op.message) };
    case 'resolve':
      return { type: 'resolve', threadId: threadId(op.threadId), by: me.name, kind: 'human', at: now };
    case 'retry':
    case 'cancel':
      if (!NAME_PATTERN.test(op.name ?? '')) throw new HttpError(400, 'bad_input', 'invalid agent name');
      return { type: op.type, threadId: threadId(op.threadId), name: op.name, by: me.name, kind: 'human' };
    default:
      return { type: 'reopen', threadId: threadId(op.threadId), by: me.name, kind: 'human' };
  }
}

// What the editor kept of the human's where the agent had changed the same
// text: [{ before: the human's text, after: the agent's }].
function validChanges(changes) {
  const text = (v) => typeof v === 'string' && v.length <= 200_000;
  const ok = Array.isArray(changes) && changes.length > 0 && changes.length <= 20
    && changes.every((c) => c && text(c.before) && c.before.length > 0 && text(c.after) && c.before !== c.after);
  if (!ok) throw new HttpError(400, 'bad_input', 'expected { changes: [{ before, after }] }');
  return changes.map(({ before, after }) => ({ before, after }));
}

function agentError(error) {
  if (error instanceof AgentError) throw new HttpError(error.code === 'not_found' ? 404 : 400, error.code, error.message);
  if (error instanceof SettingsError) throw new HttpError(400, 'bad_input', error.message);
  throw error;
}

function versionId(id) {
  if (typeof id !== 'string' || !VERSION_ID.test(id)) throw new HttpError(400, 'bad_input', 'invalid version id');
  return id;
}

function validAnchor(anchor) {
  if (anchor === null || anchor === undefined) return null;
  const ok = typeof anchor.exact === 'string' && anchor.exact.length > 0
    && typeof anchor.prefix === 'string' && anchor.prefix.length <= 32
    && typeof anchor.suffix === 'string' && anchor.suffix.length <= 32
    && Number.isInteger(anchor.start) && anchor.start >= 0;
  if (!ok) throw new HttpError(400, 'bad_input', 'invalid anchor');
  return { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix, start: anchor.start };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'bad_input', 'request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_input', 'invalid JSON');
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function statusFor(error) {
  if (error instanceof OpError || error instanceof SettingsError) return 400;
  if (error instanceof StoreError) return error.code === 'lock_timeout' ? 409 : 404;
  return 500;
}

// Put the display settings on <html> as the page would, so its first paint
// already uses them (the CSP allows no inline script to do it earlier).
// Values are validated settings, from a fixed set of words.
function withSettings(html, settings) {
  const attrs = [`data-font="${settings.font}"`, `data-width="${settings.width}"`];
  if (settings.theme !== 'system') attrs.push(`data-theme="${settings.theme}"`);
  if (settings.focus) attrs.push('data-focus');
  if (!settings.outline) attrs.push('data-no-outline');
  return html.replace(/<html\b/i, `<html ${attrs.join(' ')}`);
}

async function fileHash(path) {
  try {
    return 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

let cachedName;
function defaultName() {
  if (cachedName !== undefined) return cachedName;
  let name = '';
  try {
    name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // no git, or no name configured
  }
  if (!name) name = userInfo().username;
  cachedName = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'me';
  return cachedName;
}
