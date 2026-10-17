// DocService (docs/architecture-v2.md): every write to one doc and its
// sidecar, one at a time; changes made outside the app; versions. It runs
// the buddies @mentioned in the doc's comments (runner.js) and merges what
// each run changed into the doc when it ends. It lives in the doc host;
// windows call it over a message port (desktop/doc-host.js) and hear its
// events (doc, sidecar, agents, settings, history, renamed, missing).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { OpError, applyOp, askedOf, newId } from '../core/index.js';
import { NAME_PATTERN, parseMentions, sameName } from '../core/mentions.js';
import { AGENT_SERVER_KEYS, AgentError, DEFAULT_AGENT_ID, availableIn, createAgent, deleteAgent, docOnly, updateAgent } from '../core/agents.js';
import { SettingsError } from '../core/settings.js';
import { merge3 } from '../core/merge.js';
import { StoreError, hashBytes, load, moveDoc, readDoc, readSidecar, sidecarPath, update, writeAtomic } from '../store/files.js';
import { VERSION_ID, moveHistory, readHistory, readVersion, recordVersion } from '../store/history.js';
import { configDir, editAgents, readSettings, settingsWithId, updateSettings, watchSettings } from '../store/settings.js';
import { watchDoc } from '../store/watch.js';
import { agentScript, agentsDir, installAgents, listAgents, SHIPPED_AGENTS } from '../store/agents.js';
import { splice } from './splice.js';
import { Runner } from './runner.js';

const BROWSER_OPS = new Set(['join', 'addThread', 'addMessage', 'resolve', 'reopen']);
const ID = { t: /^t_[A-Za-z0-9_-]{6,}$/, m: /^m_[A-Za-z0-9_-]{6,}$/ };

/** A call refused: `code` says why ('bad_input', 'not_found', 'name_taken'). */
export class DocError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Open the doc at `docPath`. The doc's buddies are the user's agents (the
 * Agents panel) that are in it; one @mentioned in a comment answers it, in
 * a run of the agent script picked in Settings (src/store/agents.js).
 * `settingsDir` is the folder of the user's settings file (default: the
 * per-user config folder), which also holds the agent scripts. `folder` is
 * the project folder the doc was opened from, handed to runs as
 * OPENDOC_PROJECT. `emit(event, data)` hears what changed.
 * `call(type, arg)` runs a window's request (see `calls`); `moveTo(newPath,
 * move)` renames the doc while it is open (`move` defaults to moveDoc and
 * may return the final path).
 * @returns {Promise<{ call: (type: string, arg?: object) => Promise<object>, hello: () => object, runner: Runner, docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, setFolder: (folder: string | null) => void, close: () => Promise<void> }>}
 */
export async function openDoc(docPath, { folder = null, settingsDir = configDir(), emit = () => {} } = {}) {
  await readDoc(docPath); // fail early on a missing doc
  // An unstarred agent belongs to one doc, known by its full path.
  const docKey = () => resolve(docPath);
  // An agent's entry among the doc's participants: its name, and who it is.
  const asParticipant = (agent) => ({ name: agent.name, kind: 'agent', persona: agent.persona, instructions: agent.instructions });
  const broadcastAgents = () => emit('agents', agentStatuses());
  const runner = new Runner({
    asks: () => asks(),
    doc: async () => ({ name: basename(docPath), markdown: (await readDoc(docPath)).markdown }),
    script: () => agentScript(currentAgent, settingsDir),
    folder: () => folder,
    human: async () => (await human()).name,
    finish: (result) => serial(() => finishRun(result)),
    onChange: broadcastAgents,
  });
  let currentAgent = 'claude'; // the agent script that runs every buddy (settings.agent)
  let lastDocHash = null;
  let lastSidecarHash = null;
  let lastSettings = null;
  let missing = false; // the doc was moved or deleted on disk while open
  // Writes to the doc and its sidecar run one at a time, so a rename never
  // lands in the middle of a save.
  let writes = Promise.resolve();
  const serial = (fn) => {
    const run = writes.then(fn);
    writes = run.catch(() => {});
    return run;
  };
  // Version history (src/store/history.js): the hash of the doc as this
  // service last wrote it, so the watcher does not take that write for
  // someone else's, and the queue that keeps versions in order.
  let lastWritten = null;
  let chronicle = Promise.resolve();

  // `recreate: true` writes the page's text back when the doc has gone
  // missing from disk; otherwise a save needs the doc to be there.
  async function saveDoc(body) {
    if (typeof body.markdown !== 'string' || typeof body.baseHash !== 'string') {
      throw new DocError('bad_input', 'expected { markdown, baseHash }');
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
      return { docHash: lastWritten, markdown: body.markdown };
    }
    if (current.hash !== body.baseHash) {
      return { conflict: true, markdown: current.markdown, docHash: current.hash };
    }
    const incoming = current.markdown.includes('\r\n') ? body.markdown.replace(/\r?\n/g, '\r\n') : body.markdown;
    const next = splice(current.markdown, incoming);
    if (next !== current.markdown) {
      await noteDisk(current); // whatever reached the disk since, before the human's change
      lastWritten = hashBytes(Buffer.from(next));
      await writeAtomic(docPath, next);
      await update(docPath, (s) => s); // refresh anchors against the saved doc
      await noteVersion(next, { kind: 'edit', author: await human() });
    }
    return { docHash: hashBytes(Buffer.from(next)), markdown: next };
  }

  // Put the doc back the way it was in an earlier version, as the human's
  // change: a new version, so the restore can itself be undone. Comments
  // stay; their anchors follow the restored text like after any edit.
  async function restoreVersion(body) {
    const id = versionId(body?.id);
    if (typeof body.baseHash !== 'string') throw new DocError('bad_input', 'expected { id, baseHash }');
    const current = await readDoc(docPath);
    if (current.hash !== body.baseHash) {
      return { conflict: true, markdown: current.markdown, docHash: current.hash };
    }
    const found = await readVersion(docPath, settingsDir, id);
    if (!found) throw new DocError('not_found', 'no such version');
    const next = found.markdown;
    if (next !== current.markdown) {
      await noteDisk(current);
      lastWritten = hashBytes(Buffer.from(next));
      await writeAtomic(docPath, next);
      await update(docPath, (s) => s);
      await noteVersion(next, { kind: 'restore', author: await human(), restoredFrom: id });
    }
    return { docHash: hashBytes(Buffer.from(next)), markdown: next };
  }

  async function state() {
    const { doc, sidecar } = await load(docPath);
    const { settings } = await readSettings(settingsDir);
    return {
      doc: basename(docPath),
      markdown: doc.markdown,
      docHash: doc.hash,
      sidecar,
      settings,
      defaultName: defaultName(),
      agents: agentStatuses(),
      docKey: docKey(), // which of the user's unstarred agents are this doc's own
    };
  }

  // ---- the doc's buddies ----

  // The user's agents that are in the doc: this doc's own and starred ones
  // brought in (Clippy, whom it started with, or one @mentioned or added),
  // this doc's own before a starred one of the same name. A person of the
  // same name keeps the name; the agent stays out.
  async function buddies() {
    const { settings } = await readSettings(settingsDir);
    currentAgent = settings.agent;
    let participants;
    try {
      participants = (await readSidecar(docPath)).participants;
    } catch {
      return []; // a sidecar that cannot be read invites no one
    }
    const ours = settings.agents.filter((a) => availableIn(a, docKey())).sort((a, b) => Number(a.starred) - Number(b.starred));
    const found = [];
    for (const agent of ours) {
      if (found.some((b) => sameName(b.name, agent.name))) continue;
      if (participants.some((p) => p.kind === 'human' && sameName(p.name, agent.name))) continue;
      if (participants.some((p) => p.kind === 'agent' && sameName(p.name, agent.name))) found.push(agent);
    }
    return found;
  }

  // The asks waiting on a buddy now (src/core/inbox.js).
  async function asks() {
    if (closed) return [];
    const here = await buddies();
    if (here.length === 0) return [];
    const sidecar = await readSidecar(docPath);
    return sidecar.threads.flatMap((thread) => askedOf(thread).flatMap((name) => {
      const buddy = here.find((b) => sameName(b.name, name));
      return buddy ? [{ threadId: thread.id, thread, buddy }] : [];
    }));
  }

  // The buddies in the doc, and which are at work.
  let shownBuddies = [];
  function agentStatuses() {
    const running = runner.statuses();
    return shownBuddies.map((b) => {
      const run = running.find((r) => sameName(r.name, b.name));
      return { name: b.name, id: b.id, persona: b.persona, state: run ? 'running' : 'ready', threadIds: run?.threadIds ?? [] };
    });
  }

  // The buddies or the sidecar changed: show who is here, and start the runs due.
  let closed = false;
  async function syncAgents() {
    if (closed) return;
    try {
      shownBuddies = await buddies();
    } catch (error) {
      console.error('Could not read the buddies:', error);
    }
    broadcastAgents();
    await runner.notify();
  }

  // A run ended (runner.js): merge what it changed in its copy
  // into the doc, three-way from the copy as it started, then post its
  // reply. Where the human changed the same text meanwhile, theirs stays,
  // the buddy's change there is dropped and the reply says `conflict`.
  // Run in `serial`.
  async function finishRun({ threadId, name, base, edited, body, failed }) {
    let conflict = false;
    if (edited !== null && edited !== base) {
      let current = null;
      try {
        current = await readDoc(docPath);
      } catch {
        // the doc is gone: nothing to merge into
      }
      if (current) {
        const crlf = current.markdown.includes('\r\n');
        const lf = (text) => text.replace(/\r\n/g, '\n');
        const merged = merge3(lf(base), lf(current.markdown), lf(edited), { prefer: 'ours' });
        conflict = merged.dropped.length > 0;
        const next = crlf ? merged.text.replace(/\n/g, '\r\n') : merged.text;
        if (next !== current.markdown) {
          await noteDisk(current);
          lastWritten = hashBytes(Buffer.from(next));
          await writeAtomic(docPath, next);
          await update(docPath, (s) => s); // refresh anchors against the merged doc
          await noteVersion(next, { kind: 'edit', author: { name, kind: 'agent' }, threadIds: [threadId] });
        }
      }
    }
    const message = {
      id: newId('m'), author: { name, kind: 'agent' }, body, createdAt: new Date().toISOString(),
      ...(conflict ? { conflict: true } : {}), ...(failed ? { failed: true } : {}),
    };
    await update(docPath, (s) => (s.threads.some((t) => t.id === threadId) ? applyOp(s, { type: 'addMessage', threadId, message }) : s))
      .catch((error) => console.error(`Could not post ${name}'s reply:`, error));
  }

  async function currentSettings() {
    return (await readSettings(settingsDir)).settings;
  }

  // Invite agent `id` from the user's roster: it joins the doc's participants
  // like a person added to it, and answers when @mentioned.
  async function invite(id) {
    const agent = (await currentSettings()).agents.find((a) => a.id === id && availableIn(a, docKey()));
    if (!agent) throw new DocError('not_found', 'no such agent');
    const sidecar = await serial(() => update(docPath, (s) => {
      const taken = s.participants.find((p) => sameName(p.name, agent.name));
      if (taken && taken.kind !== 'agent') throw new DocError('name_taken', `${taken.name} is a person in this doc; rename the agent first`);
      return applyOp(s, { type: 'join', participant: asParticipant(agent) });
    }));
    await syncAgents();
    return { sidecar, agents: agentStatuses() };
  }

  // Remove an agent from the doc: it leaves the participants, so it is no
  // longer offered for @mentions. A run in progress still replies. Its
  // comments stay.
  async function removeAgent(name) {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new DocError('bad_input', 'invalid name');
    const { participants } = await readSidecar(docPath);
    if (!participants.some((p) => p.kind === 'agent' && sameName(p.name, name))) throw new DocError('not_found', `no agent ${name} in this doc`);
    const sidecar = await serial(() => update(docPath, (s) => applyOp(s, { type: 'leave', name })));
    // This doc's own agent has nowhere else to be: removing it deletes it.
    const own = (await currentSettings()).agents.find((a) => docOnly(a) && a.doc === docKey() && sameName(a.name, name));
    const settings = own ? await editAgents((agents) => deleteAgent(agents, own.id), settingsDir) : null;
    await syncAgents();
    return { sidecar, agents: agentStatuses(), ...(settings ? { settings } : {}) };
  }

  // New agent for the user's roster, from the page. With `invite`, it joins
  // this doc at once. A name asked for is kept or refused as taken; none gets
  // a free one ("agent", "agent-2", …).
  async function rosterCreate(body) {
    const { id: _id, ...fields } = body?.agent ?? {};
    checkServerKeys(fields);
    // Unless starred, it is this doc's own.
    fields.doc = fields.starred === true ? null : docKey();
    const me = (await human()).name;
    let created;
    const settings = await editAgents((agents) => {
      created = createAgent(agents, fields, [me], { exact: Object.hasOwn(fields, 'name') });
      return [...agents, created];
    }, settingsDir).catch(agentError);
    const joined = body?.invite === true ? await invite(created.id) : {};
    return { agent: created, settings, ...joined };
  }

  // Change one of the user's agents. Renaming one that is in this doc keeps
  // it here under the new name; other docs keep the old one until it is
  // invited again.
  async function rosterUpdate(body) {
    const id = body?.id;
    const patch = body?.patch ?? {};
    const before = (await currentSettings()).agents.find((a) => a.id === id);
    if (!before) throw new DocError('not_found', 'no such agent');
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
    // The settings and the doc change together, so adoptDocAgents never
    // takes this change for one made outside OpenDoc.
    const settings = await serial(async () => {
      const saved = await editAgents((agents) => updateAgent(agents, id, patch, [me]), settingsDir).catch(agentError);
      const after = saved.agents.find((a) => a.id === id);
      // The doc keeps who its agents are: their names, personas and
      // instructions, and what its own agent is now, if it was starred.
      const unstarred = before.starred && after && !after.starred;
      if (after && here && (unstarred || ['name', 'persona', 'instructions'].some((k) => after[k] !== before[k]))) {
        await update(docPath, (s) => {
          if (!s.participants.some((p) => p.kind === 'agent' && sameName(p.name, before.name))) return s;
          if (!sameName(after.name, before.name)) return applyOp(applyOp(s, { type: 'leave', name: before.name }), { type: 'join', participant: asParticipant(after) });
          return applyOp(s, { type: 'describe', name: after.name, persona: after.persona, instructions: after.instructions });
        });
      }
      return saved;
    });
    await syncAgents();
    return { settings, agents: agentStatuses() };
  }

  // Delete one of the user's agents; it leaves this doc too. Other docs keep
  // its name among their participants, as someone not available here.
  async function rosterDelete(body) {
    const agent = (await currentSettings()).agents.find((a) => a.id === body?.id);
    if (!agent) throw new DocError('not_found', 'no such agent');
    const settings = await editAgents((agents) => deleteAgent(agents, agent.id), settingsDir).catch(agentError);
    await serial(() => update(docPath, (s) => applyOp(s, { type: 'leave', name: agent.name })));
    await syncAgents();
    return { settings, agents: agentStatuses() };
  }

  // Which doc an agent belongs to is the app's to say.
  function checkServerKeys(fields) {
    const key = AGENT_SERVER_KEYS.find((k) => Object.hasOwn(fields, k));
    if (key) throw new DocError('bad_input', `${key} is set by the app`);
  }

  // The first time a doc is opened with no agents in it, Clippy (the agent
  // the app comes with, under whatever name it has now) joins it, so every
  // new doc has someone to answer; other agents are added in the doc. A doc
  // that has agents keeps the ones it has.
  async function joinDefaultAgent() {
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
  // the doc as this doc's own; one the doc does not describe is set up too,
  // with no persona. A doc's own agent follows what the doc says it is.
  // Run it in `serial`.
  async function adoptDocAgents() {
    let participants;
    try {
      participants = (await readSidecar(docPath)).participants;
    } catch {
      return false;
    }
    const me = (await human()).name;
    const theirs = participants.filter((p) => p.kind === 'agent' && !sameName(p.name, me));
    const adopt = (agents) => {
      let next = agents;
      for (const p of theirs) {
        const persona = p.persona ?? '';
        const instructions = p.instructions ?? '';
        const described = Boolean(persona || instructions);
        const mine = next.find((a) => sameName(a.name, p.name) && availableIn(a, docKey()));
        if (!mine) next = [...next, createAgent(next, { name: p.name, persona, instructions, doc: docKey() }, [me])];
        else if (described && docOnly(mine) && (mine.persona !== persona || mine.instructions !== instructions)) {
          next = updateAgent(next, mine.id, { persona, instructions });
        }
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
      if (version) emit('history', { id: version.id });
    });
    chronicle = run.catch((error) => console.error('Could not record a version:', error));
    return chronicle;
  }

  // The doc on disk changed and not by this service's hand: a change made
  // outside OpenDoc (buddies edit only their copies).
  function noteDisk(doc) {
    if (doc.hash === lastWritten) return chronicle;
    return noteVersion(doc.markdown, { kind: 'external', author: null });
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

  // A comment that @mentions one of the user's agents not in the doc yet
  // brings it in first, as mentioning a person in Docs shares the doc with
  // them; then the mention counts, and that agent answers.
  async function applyBrowserOp(body) {
    const who = await me();
    const op = validateOp(body?.op, who.author);
    const message = op.message;
    const roster = message ? (await currentSettings()).agents.filter((a) => availableIn(a, docKey())) : [];
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
    return { sidecar, ...(joined ? { agents: agentStatuses() } : {}) };
  }

  // Watch both files; refresh anchors when the doc changes (another program
  // may have edited it) and tell the page what changed, including the
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
          emit('missing', { missing: true, doc: basename(docPath) });
        }
        return;
      }
      if (missing) {
        missing = false;
        emit('missing', { missing: false, doc: basename(docPath) });
      }
      if (doc.hash !== lastDocHash) {
        lastDocHash = doc.hash;
        await noteDisk(doc);
        await load(docPath);
        emit('doc', { docHash: doc.hash });
      }
      const sidecarHash = await fileHash(sidecarPath(docPath));
      if (sidecarHash !== lastSidecarHash) {
        lastSidecarHash = sidecarHash;
        emit('sidecar', { hash: sidecarHash });
        // A new ask, someone invited or removed, or the doc (a git pull)
        // bringing agents of its own.
        serial(adoptDocAgents).catch((error) => console.error('Could not set up the doc\'s agents:', error)).finally(() => syncAgents());
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
      emit('settings', settings);
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
      await runner.stop(); // their asks run again once the doc is at its new name
      await chronicle;
      // This doc's own agents move with it.
      if ((await currentSettings()).agents.some((a) => a.doc === before)) await editAgents((agents) => agents.map((a) => (a.doc === before ? { ...a, doc: resolve(target) } : a)), settingsDir)
        .catch((error) => console.error('Could not move the doc\'s agents:', error));
      await moveHistory(docPath, target, settingsDir).catch((error) => console.error('Could not move the history:', error));
      docPath = target;
      // A folder moved with the doc in it: the watch may have seen it go.
      if (missing) emit('missing', { missing: false, doc: basename(docPath) });
      missing = false;
      stopWatching = watchDoc(docPath, onFilesChanged);
      runner.resume();
      await syncAgents();
      emit('renamed', { doc: basename(docPath), docKey: docKey() });
      return docPath;
    });
  }

  await installAgents(settingsDir).catch((error) => console.error('Could not write the agent scripts:', error));
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
  await syncAgents();

  // What a window may ask. Each returns what changed, for the window that asked.
  const calls = {
    state,
    saveDoc: (body) => serial(() => saveDoc(body ?? {})),
    op: applyBrowserOp,
    async saveSettings(patch) {
      if (patch && Object.hasOwn(patch, 'agents')) throw new DocError('bad_input', 'agents are changed through createAgent and updateAgent');
      if (patch && Object.hasOwn(patch, 'id')) throw new DocError('bad_input', 'your id cannot be changed');
      try {
        return { settings: await updateSettings(patch, settingsDir) };
      } catch (error) {
        if (error instanceof SettingsError) throw new DocError('bad_input', error.message);
        throw error;
      }
    },
    invite: (body) => invite(body?.id),
    removeAgent: (body) => removeAgent(body?.name),
    createAgent: rosterCreate,
    updateAgent: rosterUpdate,
    deleteAgent: rosterDelete,
    scripts: async () => ({ agents: await listAgents(settingsDir), shipped: SHIPPED_AGENTS, folder: agentsDir(settingsDir) }),
    // A shipped agent script, written again as it came.
    async resetScript(body) {
      if (!SHIPPED_AGENTS.includes(body?.name)) throw new DocError('bad_input', 'not a shipped agent');
      await installAgents(settingsDir, { reset: body.name });
      return { agents: await listAgents(settingsDir) };
    },
    async history() {
      await chronicle;
      return { versions: await readHistory(docPath, settingsDir) };
    },
    async version(body) {
      const found = await readVersion(docPath, settingsDir, versionId(body?.id));
      if (!found) throw new DocError('not_found', 'no such version');
      return found;
    },
    restoreVersion: (body) => serial(() => restoreVersion(body)),
  };

  return {
    async call(type, arg) {
      if (!Object.hasOwn(calls, type)) throw new DocError('bad_input', `unknown call: ${type}`);
      try {
        return await calls[type](arg);
      } catch (error) {
        if (error instanceof OpError || error instanceof StoreError) throw new DocError(error.code, error.message);
        throw error;
      }
    },
    /** What a window hears first: whether the doc is missing, and who is at work. */
    hello: () => ({ missing, agents: agentStatuses() }),
    runner,
    docPath: () => docPath,
    moveTo,
    setFolder(next) {
      folder = next;
    },
    async close() {
      stopWatching();
      stopWatchingSettings();
      closed = true;
      await runner.stop();
    },
  };
}

// The page speaks for the human `me`, whatever name it sends. Timestamps come from the host's clock. A
// message may carry `edits` and `undoes` (undoing an edit) or `applies`
// (applying a proposal); the core validates their shape.
function validateOp(op, me) {
  if (!op || !BROWSER_OPS.has(op.type)) throw new DocError('bad_input', `operation not allowed: ${op?.type}`);
  const now = new Date().toISOString();
  const message = (m) => {
    if (!m || !ID.m.test(m.id ?? '') || typeof m.body !== 'string') throw new DocError('bad_input', 'invalid message');
    const out = { id: m.id, author: me, body: m.body, createdAt: now };
    for (const key of ['undoes', 'applies']) {
      if (m[key] === undefined) continue;
      if (!ID.m.test(m[key] ?? '')) throw new DocError('bad_input', `invalid ${key}`);
      out[key] = m[key];
    }
    if (m.edits !== undefined) out.edits = m.edits;
    return out;
  };
  const threadId = (id) => {
    if (!ID.t.test(id ?? '')) throw new DocError('bad_input', 'invalid thread id');
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
    default:
      return { type: 'reopen', threadId: threadId(op.threadId), by: me.name, kind: 'human' };
  }
}

function agentError(error) {
  if (error instanceof AgentError) throw new DocError(error.code, error.message);
  if (error instanceof SettingsError) throw new DocError('bad_input', error.message);
  throw error;
}

function versionId(id) {
  if (typeof id !== 'string' || !VERSION_ID.test(id)) throw new DocError('bad_input', 'invalid version id');
  return id;
}

function validAnchor(anchor) {
  if (anchor === null || anchor === undefined) return null;
  const ok = typeof anchor.exact === 'string' && anchor.exact.length > 0
    && typeof anchor.prefix === 'string' && anchor.prefix.length <= 32
    && typeof anchor.suffix === 'string' && anchor.suffix.length <= 32
    && Number.isInteger(anchor.start) && anchor.start >= 0;
  if (!ok) throw new DocError('bad_input', 'invalid anchor');
  return { exact: anchor.exact, prefix: anchor.prefix, suffix: anchor.suffix, start: anchor.start };
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
