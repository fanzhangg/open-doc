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
import { createAnchor, locate } from '../core/anchor.js';
import { FormatError, askedOf, deleteComment, newId, parseSidecar, peopleOf, serializeSidecar, threadsOf, validAnchor } from '../core/comments.js';
import { sameName } from '../core/mentions.js';
import { AGENT_SERVER_KEYS, AgentError, availableIn, createAgent, deleteAgent, updateAgent } from '../core/agents.js';
import { project } from '../core/project.js';
import { SettingsError } from '../core/settings.js';
import { merge3 } from '../core/merge.js';
import { StoreError, V1_SUFFIX, exists, hashBytes, moveDoc, readDoc, readSidecarText, sidecarPath, writeAtomic } from '../store/files.js';
import { VERSION_ID, moveHistory, readHistory, readVersion, recordVersion } from '../store/history.js';
import { configDir, editAgents, readSettings, settingsWithId, updateSettings, watchSettings } from '../store/settings.js';
import { watchDoc } from '../store/watch.js';
import { agentScript, agentsDir, installAgents, listAgents, SHIPPED_AGENTS } from '../store/agents.js';
import { splice } from './splice.js';
import { Runner } from './runner.js';

/** A call refused: `code` says why ('bad_input', 'not_found', 'unreadable'). */
export class DocError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Open the doc at `docPath`. The doc's buddies are the user's agents (the
 * Agents panel) it can reach: the starred ones and its own. One @mentioned
 * in a comment of this user's answers it, in a run of the agent script
 * picked in Settings (src/store/agents.js). `settingsDir` is the folder of
 * the user's settings file (default: the per-user config folder), which
 * also holds the agent scripts. `folder` is the project folder the doc was
 * opened from, handed to runs as OPENDOC_PROJECT. `emit(event, data)` hears
 * what changed. `call(type, arg)` runs a window's request (see `calls`);
 * `moveTo(newPath, move)` renames the doc while it is open (`move` defaults
 * to moveDoc and may return the final path).
 * @returns {Promise<{ call: (type: string, arg?: object) => Promise<object>, hello: () => object, runner: Runner, docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, setFolder: (folder: string | null) => void, close: () => Promise<void> }>}
 */
export async function openDoc(docPath, { folder = null, settingsDir = configDir(), emit = () => {} } = {}) {
  await readDoc(docPath); // fail early on a missing doc
  // An unstarred agent belongs to one doc, known by its full path.
  const docKey = () => resolve(docPath);
  const broadcastAgents = () => emit('agents', agentStatuses());
  const runner = new Runner({
    asks: () => asks(),
    doc: async () => ({ name: basename(docPath), markdown: (await readDoc(docPath)).markdown }),
    script: () => agentScript(currentAgent, settingsDir),
    folder: () => folder,
    human: async () => (await me()).name,
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

  // ---- the doc ----

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
      await noteVersion(body.markdown, { kind: 'edit', author: await me() });
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
      await noteVersion(next, { kind: 'edit', author: await me() });
    }
    return { docHash: hashBytes(Buffer.from(next)), markdown: next };
  }

  // Put the doc back the way it was in an earlier version, as the human's
  // change: a new version, so the restore can itself be undone. Comments
  // stay; readers find their anchors in the restored text.
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
      await noteVersion(next, { kind: 'restore', author: await me(), restoredFrom: id });
    }
    return { docHash: hashBytes(Buffer.from(next)), markdown: next };
  }

  async function state() {
    const doc = await readDoc(docPath);
    const { settings } = await readSettings(settingsDir);
    const comments = await commentsView(doc.markdown);
    return {
      doc: basename(docPath),
      markdown: doc.markdown,
      docHash: doc.hash,
      ...comments,
      settings,
      defaultName: defaultName(),
      me: await me(),
      agents: agentStatuses(),
      docKey: docKey(), // which of the user's unstarred agents are this doc's own
    };
  }

  // ---- comments (spec/SPEC-v2.md) ----

  // The sidecar as it is on disk: its lines, the lines it could not read,
  // and `error` when it is not a version 2 sidecar at all.
  async function readComments() {
    const text = await readSidecarText(docPath);
    if (text === null) return { lines: [], bad: [], error: null };
    try {
      return { ...parseSidecar(text), error: null };
    } catch (error) {
      if (error instanceof FormatError) return { lines: [], bad: [], error };
      throw error;
    }
  }

  // The threads as a window shows them: each anchor where its text is now
  // in `markdown` (it is never rewritten in the file), or `detached`; who
  // wrote in them; and a notice about what of the sidecar cannot be read.
  async function commentsView(markdown) {
    const { lines, bad, error } = await readComments();
    const comments = lines.map((l) => l.comment).filter(Boolean);
    const text = project(markdown).text;
    const threads = threadsOf(comments, (await buddies()).map((b) => b.name)).map((thread) => {
      if (!thread.anchor) return { ...thread, detached: false };
      const found = locate(text, thread.anchor);
      return { ...thread, anchor: found ? createAnchor(text, found.start, found.end) : thread.anchor, detached: !found };
    });
    const file = basename(sidecarPath(docPath));
    const notices = [];
    if (await exists(docPath + V1_SUFFIX)) notices.push(`The comments in ${basename(docPath + V1_SUFFIX)} are from an older OpenDoc and cannot be read here; the file is left as it is.`);
    if (error) notices.push(`${file} cannot be read (${error.message}); it is left as it is.`);
    if (bad.length > 0) notices.push(`${bad.length === 1 ? 'A line' : `${bad.length} lines`} of ${file} could not be read; ${bad.length === 1 ? 'it is' : 'they are'} kept as written.`);
    return { threads, people: peopleOf(comments), notice: notices.join(' ') || null };
  }

  // Add or remove lines of the sidecar, written whole. Run in `serial`.
  async function changeComments(change) {
    const current = await readComments();
    if (current.error) throw new DocError('unreadable', `${basename(sidecarPath(docPath))} cannot be read, so it is not changed`);
    const next = change(current.lines);
    if (next !== current.lines) await writeAtomic(sidecarPath(docPath), serializeSidecar(next));
  }

  // A comment by this user: a first comment (`anchor` on the doc's rendered
  // text, or null for the whole doc), or a reply in `thread`.
  async function comment({ thread, anchor = null, body, resolved = false } = {}) {
    if (typeof body !== 'string' || (body.trim() === '' && !resolved)) throw new DocError('bad_input', 'a comment needs text');
    if (anchor !== null && (thread !== undefined || !validAnchor(anchor))) throw new DocError('bad_input', 'invalid anchor');
    const added = {
      id: newId('c'), ...(thread !== undefined ? { thread } : {}), ...(thread === undefined ? { anchor } : {}),
      by: await me(), at: new Date().toISOString(), body: resolved ? '' : body, ...(resolved ? { resolved: true } : {}),
    };
    await serial(() => changeComments((lines) => {
      if (thread !== undefined && !lines.some((l) => l.comment?.id === thread && l.comment.thread === undefined)) throw new DocError('not_found', 'no such thread');
      return [...lines, { comment: added }];
    }));
    return { ...(await commentsView((await readDoc(docPath)).markdown)), id: added.id };
  }

  // Delete a comment (a first comment takes its replies): your own, or a buddy's.
  async function removeComment({ id } = {}) {
    const mine = (await me()).id;
    await serial(() => changeComments((lines) => {
      const found = lines.find((l) => l.comment?.id === id)?.comment;
      if (!found) throw new DocError('not_found', 'no such comment');
      if (found.by.kind !== 'ai' && found.by.id !== mine) throw new DocError('bad_input', "only your own comments and buddies' can be deleted");
      return deleteComment(lines, id);
    }));
    return commentsView((await readDoc(docPath)).markdown);
  }

  // ---- the doc's buddies ----

  // The user's agents the doc reaches: the starred ones and this doc's own,
  // this doc's own before a starred one of the same name.
  async function buddies() {
    const { settings } = await readSettings(settingsDir);
    currentAgent = settings.agent;
    const ours = settings.agents.filter((a) => availableIn(a, docKey())).sort((a, b) => Number(a.starred) - Number(b.starred));
    return ours.filter((agent, i) => ours.findIndex((a) => sameName(a.name, agent.name)) === i);
  }

  // The asks waiting on a buddy now (docs/architecture-v2.md, Who answers):
  // only this user's comments ask.
  async function asks() {
    if (closed) return [];
    const here = await buddies();
    if (here.length === 0) return [];
    const { lines } = await readComments();
    const mine = (await me()).id;
    const threads = threadsOf(lines.map((l) => l.comment).filter(Boolean), here.map((b) => b.name));
    return threads.flatMap((thread) => askedOf(thread, mine).map((name) => ({
      threadId: thread.id, thread, buddy: here.find((b) => sameName(b.name, name)),
    })));
  }

  // The buddies the doc reaches, and which are at work.
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

  // A run ended (runner.js): merge what it changed in its copy into the doc,
  // three-way from the copy as it started, then post its reply. Where the
  // human changed the same text meanwhile, theirs stays, the buddy's change
  // there is dropped and the reply says `conflict`. Run in `serial`.
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
          await noteVersion(next, { kind: 'edit', author: { name, kind: 'agent' }, threadIds: [threadId] });
        }
      }
    }
    const reply = {
      id: newId('c'), thread: threadId, by: { id: name, name, kind: 'ai' }, at: new Date().toISOString(), body,
      ...(conflict ? { conflict: true } : {}), ...(failed ? { failed: true } : {}),
    };
    await changeComments((lines) => (lines.some((l) => l.comment?.id === threadId) ? [...lines, { comment: reply }] : lines))
      .catch((error) => console.error(`Could not post ${name}'s reply:`, error));
  }

  async function currentSettings() {
    return (await readSettings(settingsDir)).settings;
  }

  // New agent for the user's roster, from the page. A name asked for is
  // kept or refused as taken; none gets a free one ("agent", "agent-2", …).
  async function rosterCreate(body) {
    const { id: _id, ...fields } = body?.agent ?? {};
    checkServerKeys(fields);
    // Unless starred, it is this doc's own.
    fields.doc = fields.starred === true ? null : docKey();
    const taken = (await me()).name;
    let created;
    const settings = await editAgents((agents) => {
      created = createAgent(agents, fields, [taken], { exact: Object.hasOwn(fields, 'name') });
      return [...agents, created];
    }, settingsDir).catch(agentError);
    await syncAgents();
    return { agent: created, settings, agents: agentStatuses() };
  }

  // Change one of the user's agents. Starring puts it in the library, for
  // every doc; unstarring makes it this doc's own.
  async function rosterUpdate(body) {
    const id = body?.id;
    const patch = body?.patch ?? {};
    if (!(await currentSettings()).agents.some((a) => a.id === id)) throw new DocError('not_found', 'no such agent');
    checkServerKeys(patch);
    if (patch.starred === true) patch.doc = null;
    if (patch.starred === false) patch.doc = docKey();
    const taken = (await me()).name;
    const settings = await editAgents((agents) => updateAgent(agents, id, patch, [taken]), settingsDir).catch(agentError);
    await syncAgents();
    return { settings, agents: agentStatuses() };
  }

  // Delete one of the user's agents. Its comments stay.
  async function rosterDelete(body) {
    const agent = (await currentSettings()).agents.find((a) => a.id === body?.id);
    if (!agent) throw new DocError('not_found', 'no such agent');
    const settings = await editAgents((agents) => deleteAgent(agents, agent.id), settingsDir).catch(agentError);
    await syncAgents();
    return { settings, agents: agentStatuses() };
  }

  // Which doc an agent belongs to is the app's to say.
  function checkServerKeys(fields) {
    const key = AGENT_SERVER_KEYS.find((k) => Object.hasOwn(fields, k));
    if (key) throw new DocError('bad_input', `${key} is set by the app`);
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

  // This user, as their comments name them: their id (made once, kept when
  // the name changes) and name.
  async function me() {
    const settings = await settingsWithId(settingsDir);
    return { id: settings.id, name: settings.name ?? defaultName(), kind: 'human' };
  }

  // Watch both files and tell the page what changed, including the doc
  // going missing (moved or deleted outside the app) and coming back.
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
        emit('doc', { docHash: doc.hash });
      }
      const sidecarHash = await fileHash(sidecarPath(docPath));
      if (sidecarHash !== lastSidecarHash) {
        lastSidecarHash = sidecarHash;
        emit('sidecar', { hash: sidecarHash });
        await syncAgents(); // a new ask
      }
    } catch (error) {
      if (!(error instanceof StoreError)) console.error(error);
    }
  }

  // Settings are shared with every other window: pass on changes from any
  // of them.
  async function onSettingsChanged() {
    try {
      const { settings } = await readSettings(settingsDir);
      const json = JSON.stringify(settings);
      if (json === lastSettings) return;
      lastSettings = json;
      emit('settings', settings);
      await syncAgents();
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
      if ((await currentSettings()).agents.some((a) => a.doc === before)) {
        await editAgents((agents) => agents.map((a) => (a.doc === before ? { ...a, doc: resolve(target) } : a)), settingsDir)
          .catch((error) => console.error('Could not move the doc\'s agents:', error));
      }
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
  lastSettings = JSON.stringify((await readSettings(settingsDir)).settings);
  let stopWatching = watchDoc(docPath, onFilesChanged);
  const stopWatchingSettings = watchSettings(onSettingsChanged, settingsDir);
  await syncAgents();

  // What a window may ask. Each returns what changed, for the window that asked.
  const calls = {
    state,
    saveDoc: (body) => serial(() => saveDoc(body ?? {})),
    comment: (body) => comment({ anchor: body?.anchor ?? null, body: body?.body }),
    reply: (body) => comment({ thread: body?.thread, body: body?.body }),
    resolve: (body) => comment({ thread: body?.thread, body: '', resolved: true }),
    reopen: (body) => comment({ thread: body?.thread, body: 'Reopened.' }),
    deleteComment: removeComment,
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
        if (error instanceof StoreError) throw new DocError(error.code, error.message);
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

function agentError(error) {
  if (error instanceof AgentError) throw new DocError(error.code, error.message);
  if (error instanceof SettingsError) throw new DocError('bad_input', error.message);
  throw error;
}

function versionId(id) {
  if (typeof id !== 'string' || !VERSION_ID.test(id)) throw new DocError('bad_input', 'invalid version id');
  return id;
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
