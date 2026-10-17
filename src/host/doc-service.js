// DocService (docs/architecture.md): every write to one doc and its
// sidecar, one at a time; changes made outside the app; versions. It runs
// the buddies @mentioned in the doc's comments (runner.js) and merges what
// each run changed into the doc when it ends. It lives in the doc host;
// windows call it over a message port (desktop/doc-host.js) and hear its
// events (doc, sidecar, agents, settings, history, renamed, missing).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createAnchor, locate } from '../core/anchor.js';
import { FormatError, appendedComments, askedOf, newId, parseSidecar, peopleOf, serializeSidecar, threadsOf, validAnchor } from '../core/comments.js';
import { sameName } from '../core/mentions.js';
import { BuddyError, CLIPPY, buddiesHere, checkBuddyPatch } from '../core/buddies.js';
import { project } from '../core/project.js';
import { SettingsError } from '../core/settings.js';
import { merge3 } from '../core/merge.js';
import { revertEdits } from '../core/diff.js';
import { StoreError, V1_SUFFIX, exists, hashBytes, moveDoc, readDoc, readSidecarText, sidecarPath, writeAtomic } from '../store/files.js';
import { VERSION_ID, moveHistory, readHistory, readVersion, recordVersion } from '../store/history.js';
import { configDir, readSettings, settingsWithId, updateSettings, watchSettings } from '../store/settings.js';
import { projectBuddiesDir, readBuddies, removeBuddy, writeBuddy } from '../store/buddies.js';
import { watchDoc, watchFolder } from '../store/watch.js';
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
 * Open the doc at `docPath`. Its buddies are the user's and, in project
 * mode, the project folder's (src/store/buddies.js). One @mentioned in a
 * comment of this user's answers it, in a run of the agent script picked in
 * Settings (src/store/agents.js). `settingsDir` is the user's config folder
 * (default: the per-user one): settings, buddies and agent scripts.
 * `folder` is the project folder the doc was opened from (null in doc
 * mode), handed to runs as OPENDOC_PROJECT. `emit(event, data)` hears
 * what changed. `call(type, arg)` runs a window's request (see `calls`);
 * `moveTo(newPath, move)` renames the doc while it is open (`move` defaults
 * to moveDoc and may return the final path).
 * @returns {Promise<{ call: (type: string, arg?: object) => Promise<object>, hello: () => object, runner: Runner, docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, setFolder: (folder: string | null) => void, close: () => Promise<void> }>}
 */
export async function openDoc(docPath, { folder = null, settingsDir = configDir(), emit = () => {} } = {}) {
  await readDoc(docPath); // fail early on a missing doc
  const broadcastAgents = () => emit('agents', agentStatuses());
  const runner = new Runner({
    asks: () => asks(),
    doc: async () => ({ name: basename(docPath), markdown: (await readDoc(docPath)).markdown, comments: await readSidecarText(docPath) }),
    script: () => agentScript(currentAgent, settingsDir),
    folder: () => folder,
    human: async () => (await me()).name,
    finish: (result) => serial(() => finishRun(result)),
    onChange: broadcastAgents,
    log: (entry) => logRun(settingsDir, { doc: docPath, ...entry }),
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
    await writeChange(current, next, { kind: 'edit', author: await me() });
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
    await writeChange(current, next, { kind: 'restore', author: await me(), restoredFrom: id });
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
      project: folder !== null, // whether buddies can be made here
    };
  }

  // ---- comments (spec/SPEC.md) ----

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
    return { threads, people: peopleOf(comments), edits: await replyEdits(), notice: notices.join(' ') || null };
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

  // ---- the doc's buddies ----

  // Clippy and the project's buddies.
  async function buddies() {
    currentAgent = (await readSettings(settingsDir)).settings.agent;
    return buddiesHere(folder ? await readBuddies(projectBuddiesDir(folder)) : []);
  }

  // The asks waiting on a buddy now (docs/architecture.md, Who answers):
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
    })).filter((ask) => ask.buddy)); // a thread's opener may be gone
  }

  // The buddies the doc reaches, and which are at work.
  let shownBuddies = [];
  function agentStatuses() {
    const running = runner.statuses();
    return shownBuddies.map((b) => {
      const run = running.find((r) => sameName(r.name, b.name));
      return { ...b, state: run ? 'running' : 'ready', threadIds: run?.threadIds ?? [] };
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
  async function finishRun({ threadId, name, base, edited, comments, body, failed }) {
    let conflict = false;
    const id = newId('c');
    if (edited !== null && edited !== base) {
      let current = null;
      try {
        current = await readDoc(docPath);
      } catch {
        // the doc is gone: nothing to merge into
      }
      if (current) {
        const merged = mergeInto(current.markdown, base, edited);
        conflict = merged.dropped.length > 0;
        await writeChange(current, merged.text, { kind: 'edit', author: { name, kind: 'agent' }, thread: threadId, reply: id });
      }
    }
    const by = { id: name, name, kind: 'ai' };
    const now = Date.now();
    const reply = {
      id, thread: threadId, by, at: new Date(now + 1).toISOString(), body, // after its comments, so it ends its thread
      ...(conflict ? { conflict: true } : {}), ...(failed ? { failed: true } : {}),
    };
    // Its comments are on the doc as it is now, its edit merged in.
    const text = comments ? project((await readDoc(docPath).catch(() => null))?.markdown ?? base).text : '';
    await changeComments((lines) => {
      if (!lines.some((l) => l.comment?.id === threadId)) return lines;
      const threads = new Set(lines.filter((l) => l.comment && l.comment.thread === undefined).map((l) => l.comment.id));
      const added = comments ? appendedComments(comments.before, comments.after, { text, by, at: new Date(now).toISOString(), threads }) : [];
      return [...lines, ...added.map((comment) => ({ comment })), { comment: reply }];
    }).catch((error) => console.error(`Could not post ${name}'s reply:`, error));
  }

  // ---- undo ----

  // Undo a buddy's run (docs/architecture.md, Undo): each change from the
  // version before it to the version after it is put back where its new
  // text still is; text anyone changed since stays. Only on this machine,
  // which has the versions.
  async function undoReply(body) {
    await chronicle;
    const edit = (await readHistory(docPath, settingsDir)).find((v) => v.reply === body?.id);
    const found = edit && (await readVersion(docPath, settingsDir, edit.id));
    if (!found?.before) throw new DocError('not_found', 'no edit of that reply on this machine');
    const current = await readDoc(docPath);
    const lf = (text) => text.replace(/\r\n/g, '\n');
    const reverted = revertEdits(lf(current.markdown), lf(found.before), lf(found.markdown));
    const next = current.markdown.includes('\r\n') ? reverted.replace(/\n/g, '\r\n') : reverted;
    await writeChange(current, next, { kind: 'undo', author: await me(), undid: body.id });
    return { docHash: hashBytes(Buffer.from(next)), markdown: next, ...(await commentsView(next)) };
  }

  // The runs that edited the doc on this machine, by their reply: { [replyId]:
  // { state: 'edited' | 'undone', by, changes, hash } }, `changes` how many
  // places the run changed and `hash` the doc's right after it.
  async function replyEdits() {
    await chronicle; // a run's version is in before the page reads the doc it wrote
    const edits = {};
    for (const v of await readHistory(docPath, settingsDir)) {
      if (v.reply) edits[v.reply] = { state: 'edited', by: v.author?.name ?? null, changes: v.changes ?? 0, hash: v.hash };
      if (v.undid && edits[v.undid]) edits[v.undid].state = 'undone';
    }
    return edits;
  }

  // Write `next` over the doc, which read `current`, as `change`: the doc
  // as it was is in history first (an outside change included), then this.
  async function writeChange(current, next, change) {
    if (next === current.markdown) return;
    await noteDisk(current);
    lastWritten = hashBytes(Buffer.from(next));
    await writeAtomic(docPath, next);
    await noteVersion(next, change);
  }

  // ---- buddy files ----

  const projectDir = () => {
    if (!folder) throw new DocError('bad_input', 'buddies other than Clippy belong to a project');
    return projectBuddiesDir(folder);
  };

  // A buddy can be called anything but Clippy or its owner's name.
  async function checkBuddy(fields) {
    try {
      checkBuddyPatch(fields);
    } catch (error) {
      throw new DocError(error.code, error.message);
    }
    if (fields.name !== undefined && [CLIPPY.name, (await me()).name].some((n) => sameName(fields.name, n))) throw new DocError('bad_input', `the name ${fields.name} is taken`);
  }

  // A project buddy here named `name`; Clippy cannot be changed.
  async function projectBuddy(name) {
    const found = (await buddies()).find((b) => sameName(b.name, name ?? ''));
    if (!found) throw new DocError('not_found', 'no such buddy');
    if (found.where === 'app') throw new DocError('bad_input', `${found.name} cannot be changed`);
    return found;
  }

  // Write buddy files; a folder watch tells every window.
  async function changeBuddies(work) {
    try {
      await work();
    } catch (error) {
      if (error instanceof BuddyError) throw new DocError(error.code, error.message);
      throw error;
    }
    await syncAgents();
    return { agents: agentStatuses() };
  }

  // A new buddy, in this project's .opendoc/buddies/ (made if missing).
  async function createBuddy({ buddy } = {}) {
    const fields = { about: '', ...buddy };
    await checkBuddy(fields);
    if (!fields.name) throw new DocError('bad_input', 'a buddy needs a name');
    const dir = projectDir();
    return changeBuddies(() => writeBuddy(dir, fields));
  }

  // Change buddy `name` here: its name (renames its file) or who it is.
  async function updateBuddy({ name, patch = {} } = {}) {
    const found = await projectBuddy(name);
    await checkBuddy(patch);
    const { where, ...was } = found;
    return changeBuddies(() => writeBuddy(projectDir(), { ...was, ...patch }, found.name));
  }

  // Delete buddy `name`'s file. Its comments stay.
  async function deleteBuddy({ name } = {}) {
    const found = await projectBuddy(name);
    return changeBuddies(() => removeBuddy(projectDir(), found.name));
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
      const target = (await move(docPath, newPath)) ?? newPath;
      stopWatching();
      await runner.stop(); // their asks run again once the doc is at its new name
      await chronicle;
      await moveHistory(docPath, target, settingsDir).catch((error) => console.error('Could not move the history:', error));
      docPath = target;
      // A folder moved with the doc in it: the watch may have seen it go.
      if (missing) emit('missing', { missing: false, doc: basename(docPath) });
      missing = false;
      stopWatching = watchDoc(docPath, onFilesChanged);
      runner.resume();
      await syncAgents();
      emit('renamed', { doc: basename(docPath) });
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
  let stopWatchingProjectBuddies = folder ? watchFolder(projectBuddiesDir(folder), syncAgents) : () => {};
  await syncAgents();

  // What a window may ask. Each returns what changed, for the window that asked.
  const calls = {
    state,
    saveDoc: (body) => serial(() => saveDoc(body ?? {})),
    comment: (body) => comment({ anchor: body?.anchor ?? null, body: body?.body }),
    reply: (body) => comment({ thread: body?.thread, body: body?.body }),
    resolve: (body) => comment({ thread: body?.thread, body: '', resolved: true }),
    reopen: (body) => comment({ thread: body?.thread, body: 'Reopened.' }),
    async saveSettings(patch) {
      if (patch && Object.hasOwn(patch, 'id')) throw new DocError('bad_input', 'your id cannot be changed');
      try {
        return { settings: await updateSettings(patch, settingsDir) };
      } catch (error) {
        if (error instanceof SettingsError) throw new DocError('bad_input', error.message);
        throw error;
      }
    },
    createBuddy,
    updateBuddy,
    deleteBuddy,
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
    undoReply: (body) => serial(() => undoReply(body)),
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
      stopWatchingProjectBuddies();
      stopWatchingProjectBuddies = folder ? watchFolder(projectBuddiesDir(folder), syncAgents) : () => {};
      syncAgents();
    },
    async close() {
      stopWatching();
      stopWatchingSettings();
      stopWatchingProjectBuddies();
      closed = true;
      await runner.stop();
    },
  };
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

// `theirs` (a change from `base`) merged into `current`; where both changed
// the same text, `current` stays and the change there is `dropped`. Line
// ends follow `current`.
function mergeInto(current, base, theirs) {
  const lf = (text) => text.replace(/\r\n/g, '\n');
  const merged = merge3(lf(base), lf(current), lf(theirs), { prefer: 'ours' });
  return { ...merged, text: current.includes('\r\n') ? merged.text.replace(/\n/g, '\r\n') : merged.text };
}

// A line per run in the config folder's logs/runs.jsonl: what a slow or
// missing reply was. Never fails a run.
async function logRun(dir, entry) {
  try {
    await mkdir(join(dir, 'logs'), { recursive: true });
    await appendFile(join(dir, 'logs', 'runs.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch (error) {
    console.error('Could not log a run:', error);
  }
}
