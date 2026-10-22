// DocService (docs/architecture.md): orders every edit to one doc, as text
// operations on a revision, and writes the doc and its sidecar, one at a
// time; changes made outside the app; versions. It runs the buddies
// @mentioned in the doc's comments (runner.js) and lands what each run
// changed when it ends. It lives in the doc host; windows call it over a
// message port (desktop/doc-host.js) and hear its events (ops, sidecar,
// agents, settings, history, renamed, missing, team). In project mode its
// project's files are read through ProjectService, and its team changed
// through Team (team.js), at the same door.

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { createAnchor, locate } from '../core/anchor.js';
import { appendedComments, askedBy, newComment, newId, parseSidecar, peopleOf, serializeSidecar, threadsOf, validAnchor } from '../core/comments.js';
import { sameName } from '../core/mentions.js';
import { BuddyError, CLIPPY, buddiesHere, checkBuddyPatch } from '../core/buddies.js';
import { DEFAULT_SETTINGS, SettingsError, agentSettings } from '../core/settings.js';
import { apply, diffOps, mapOffset, pastYield, transform } from '../core/ot.js';
import { rulesOf } from '../rules/index.js';
import { StoreError, hashText, moveDoc, readDoc, readSidecarText, sidecarPath, writeDoc, writeSidecar } from '../store/files.js';
import { VERSION_ID, markConflict, moveHistory, noteTaken, noteWritten, readHistory, readTaken, readVersion, recordVersion, writtenEdits } from '../store/history.js';
import { configDir, defaultName, ownerOf, readSettings, settingsWithId, updateSettings, watchSettings } from '../store/settings.js';
import { projectBuddiesDir, readBuddies, removeBuddy, saveBuddy, userBuddiesDir, writeBuddy } from '../store/buddies.js';
import { secretsSet } from '../store/secrets.js';
import { watchDoc, watchFolder } from '../store/watch.js';
import { agentScript, agentsDir, installAgents, listAgents, readAgent, SHIPPED_AGENTS } from '../store/agents.js';
import { mirrorDir, syncMirror } from './mirror.js';
import { projectService } from './project-service.js';
import { Runner } from './runner.js';
import { TeamError } from './team.js';

/**
 * A call refused: `code` says why ('bad_input', 'not_found', 'read_only',
 * 'stale', 'forbidden'); or 'not_saved', an edit that landed but whose
 * file could not be written: it is written once it can be, and told then.
 */
class DocError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// What a call may need, each level allowing the ones before it.
const LEVELS = ['read', 'write', 'owner'];

// Whether `who` ({ id, name, kind, level }) may make a call that needs `level`.
const can = (who, level) => LEVELS.indexOf(who?.level) >= LEVELS.indexOf(level);

// A comment's `by`: who wrote it.
const byOf = ({ id, name, kind }) => ({ id, name, kind });

/**
 * Open the doc at `docPath`. Its buddies are the user's and, in project
 * mode, the project folder's (src/store/buddies.js). One @mentioned in a
 * comment of this user's answers it, in a run of the agent script picked in
 * Settings (src/store/agents.js). `settingsDir` is the user's config folder
 * (default: the per-user one): settings, buddies and agent scripts.
 * `folder` is the project folder the doc was opened from (null in doc
 * mode), whose mirror (mirror.js) runs get as PONJO_PROJECT; `team`,
 * its Team (team.js).
 * `secrets()` gives the agents' secrets, decrypted ({ <agent>: { <key>:
 * value } }, src/store/secrets.js), handed to runs with the other settings.
 * `emit(event, data)` hears what changed. `call(type, arg, who)` runs a request of `who`'s (see
 * `calls`), `owner()` being the `who` of this machine's user;
 * `moveTo(newPath, move)` renames the doc while it is open (`move` defaults
 * to moveDoc and may return the final path).
 * @returns {Promise<{ call: (type: string, arg: object | undefined, who: object) => Promise<object>, owner: () => Promise<object>, leave: (id: string) => void, hello: () => object, runner: Runner, docPath: () => string, moveTo: (newPath: string, move?: Function) => Promise<string>, setFolder: (folder: string | null, team: object | null) => void, close: () => Promise<void> }>}
 */
export async function openDoc(docPath, { folder = null, team = null, settingsDir = configDir(), secrets = () => ({}), emit = () => {} } = {}) {
  const opened = await readDoc(docPath); // fail early on a missing doc
  const broadcastAgents = () => emit('agents', agentStatuses());
  const runner = new Runner({
    asks: () => asks(),
    doc: async () => ({ name: basename(docPath), text, comments: await readSidecarText(docPath) }),
    agent: async () => {
      const { settings } = await readSettings(settingsDir);
      return { script: agentScript(settings.agent, settingsDir), settings: agentSettings(settings, await readAgent(settings.agent, settingsDir), secrets()[settings.agent]) };
    },
    // The project, as a run reads it: its mirror, up to date (none if that fails).
    folder: () => folder && syncMirror(folder, mirrorDir(folder, settingsDir)).catch((error) => {
      console.error('Could not mirror the project:', error);
      return null;
    }),
    human: async () => ({ name: (await me()).name, about: (await settingsWithId(settingsDir)).about.trim() }),
    finish: (result) => serial(() => finishRun(result)),
    onChange: broadcastAgents,
    log: (entry) => logRun(settingsDir, { doc: docPath, ...entry }),
  });
  let lastSidecarHash = null;
  let lastSettings = null;
  let missing = false; // the doc was moved or deleted on disk while open
  // Writes to the doc and its sidecar, and the edits landing, run one at a
  // time, so a rename never lands in the middle of a save.
  let writes = Promise.resolve();
  const serial = (fn) => {
    const run = writes.then(fn);
    writes = run.catch(() => {});
    return run;
  };
  let chronicle = Promise.resolve(); // the queue that keeps versions in order (src/store/history.js)

  // ---- the doc: every edit is operations on a revision ----

  // The doc's text, as edits have landed on it; `rev` counts them since
  // this service started, `epoch` names that start (a window that sees a
  // new one takes the text again). `log` holds the latest landed edits, the
  // one that made rev `logStart + k + 1` at k, to move a window's edit from
  // an older rev, to know a window's edit sent again, and to tell a window
  // what it missed: { ops, id, event }, and the `base` text of one that
  // yields, with a buddy's `reply`, and `left`, what people's edits from
  // before it left of it (pastYield), the last landed at rev `end`.
  // `written` is the text the file holds as last written or read,
  // `writtenHash` its hash: a file that is not that changed outside.
  // `writtenStat` is the file's stat as this service last wrote it: a file
  // that still has it is not read again (a doc of millions of characters
  // takes tens of milliseconds), `form` how its lines end.
  let text = opened.text;
  let rev = 0;
  const epoch = newId('e');
  const log = [];
  let logStart = 0;
  let written = text;
  let writtenHash = opened.hash;
  let writtenStat = null;
  let form = opened.form;
  // Whether the file, as `now` (a stat, or null) says, is still as this service wrote it.
  const ours = (now) => sameStat(now, writtenStat);
  let told = []; // landed edits not yet written and told to windows, as `ops` events
  // Where each person has their cursor: id → { id, name, at },
  // `at` an offset in the text at `toldRev`, the last rev windows were told
  // of, so a window places it on its own text; told to every window as
  // `cursors`, with `by`, whose cursor moved. Never queued behind writes.
  const cursors = new Map();
  let toldRev = 0;
  const tellCursors = (by = null) => emit('cursors', { epoch, rev: toldRev, cursors: [...cursors.values()], by });
  // The cursors on the text at `rev`.
  const cursorsNow = () => [...cursors.values()].map((cursor) => ({
    ...cursor, at: log.slice(toldRev - logStart, rev - logStart).reduce((at, landed) => mapOffset(at, landed.ops), cursor.at),
  }));
  // Windows' edits the file holds that a service before this one may not
  // have told them of (noteWritten), kept in each note after.
  const landedBefore = await writtenEdits(docPath, settingsDir, opened.hash);
  const noteIds = () => [...landedBefore, ...log.map((landed) => landed.id).filter(Boolean)].slice(-LOG_SIZE);
  let writtenIds = landedBefore; // the ids noted for the file as last written
  let unsaved = null; // a write that failed, tried again

  // Edit `ops` lands on the text, from a window (`id`, the window's name for
  // it) or from here: one that yields (a buddy's, with its `reply` and buddy
  // `by`; an outside change; an undo).
  function land(ops, meta = {}) {
    const event = { epoch, rev: rev + 1, ops, id: meta.id ?? null, ...(meta.yields ? { yields: true } : {}), ...(meta.reply ? { reply: meta.reply, by: meta.by } : {}) };
    log.push(meta.yields ? { ops, base: text, reply: meta.reply, event } : { ops, id: meta.id, event });
    if (log.length > LOG_SIZE) {
      log.shift();
      logStart++;
    }
    text = apply(text, ops);
    rev++;
    told.push(event);
  }

  // Write what landed, then tell every window: what a window has heard of is
  // in the file. A file changed outside since it was last written is merged
  // first, and one changed while it was being written, just before it took
  // the file's place, too, then written again. A missing doc is not
  // written; its edits are still told. A write that fails is tried again
  // until it is written, nothing told meanwhile. Run in `serial`.
  async function commit() {
    clearTimeout(unsaved);
    let wroteAny = false; // its note says only that it is about to be
    try {
      while (!missing && text !== written) {
        const before = await stat(docPath).catch(() => null);
        if (!ours(before)) {
          let disk;
          try {
            disk = await readOutside();
          } catch (error) {
            if (error.code !== 'no_doc') throw error;
            break;
          }
          form = disk.form;
          if (disk.hash !== writtenHash) await takeOutside(disk);
          if (text === written) break;
        }
        // A window told nothing yet, should this service stop now, learns from it its edit is in;
        // if the write fails, the note is again of what the file holds.
        const hash = hashText(text);
        const ids = noteIds();
        await noteWritten(docPath, settingsDir, hash, ids, writtenIds);
        const wrote = await writeDoc(docPath, text, form, async () => sameStat(await stat(docPath).catch(() => null), before)).catch(async (error) => {
          await noteWritten(docPath, settingsDir, writtenHash, writtenIds);
          throw error;
        });
        if (!wrote) continue;
        writtenHash = hash;
        writtenIds = ids;
        writtenStat = wrote;
        written = text;
        wroteAny = true;
      }
    } catch (error) {
      unsaved = setTimeout(() => serial(commit).catch(() => {}), RETRY_MS);
      throw error;
    }
    for (const event of told.splice(0)) {
      for (const cursor of cursors.values()) cursor.at = mapOffset(cursor.at, event.ops);
      toldRev = event.rev;
      emit('ops', event);
    }
    // Written now, so landed even if the file changes outside before the next write.
    if (wroteAny) await noteWritten(docPath, settingsDir, writtenHash, writtenIds).catch(() => {});
  }

  // The file as changed outside, once it holds still: another program may be
  // half way through writing it, emptied with the rest to come.
  async function readOutside() {
    for (let tries = 1; ; tries++) {
      const was = await stat(docPath).catch(() => null);
      const disk = await readDoc(docPath);
      await new Promise((done) => setTimeout(done, STILL_MS));
      if (tries === STILL_TRIES || sameStat(await stat(docPath).catch(() => null), was)) return disk;
    }
  }

  // The doc's rules, as the settings are now.
  async function rules() {
    return rulesOf(docPath, (await readSettings(settingsDir)).settings);
  }

  // A change made outside (another program, git pull), found on disk as
  // `disk`: it is in history first, then lands, yielding to what landed
  // since the file was last written. Where it was dropped, the person's text
  // stays and the outside version is only in history. Run in `serial`.
  async function takeOutside(disk) {
    if (typing !== null) { // the typing the file held, a version before the outside one
      clearTimeout(typing);
      typing = null;
      await noteVersion(written, await typingChange());
    }
    await noteVersion(disk.text, { kind: 'external', author: null });
    const { ops } = transform(diffOps(written, disk.text), diffOps(written, text), { yields: true, base: written, rules: await rules() });
    written = disk.text;
    writtenHash = disk.hash;
    await noteWritten(docPath, settingsDir, writtenHash, writtenIds); // the edits written so far: landed, though the file now holds another's
    land(ops, { yields: true });
    if (text !== disk.text) await noteVersion(text, { kind: 'edit', author: await me() });
  }

  // Typing is a version once everyone typing has paused (src/store/history.js
  // joins a burst of it into one), and before any edit that is not theirs:
  // one version, by each person who typed in it.
  let typing = null;
  let typists = []; // who typed since the last version, as comments name them
  function typed(who) {
    if (!typists.some((t) => t.id === who.id)) typists.push(byOf(who));
    clearTimeout(typing);
    typing = setTimeout(() => serial(flushTyping), SAVE_DELAY_MS);
  }
  // The version's change for the typing so far; the next typing is a new burst.
  async function typingChange() {
    const [author = await me(), ...more] = typists.splice(0);
    return { kind: 'edit', author, ...(more.length > 0 ? { authors: [author, ...more] } : {}) };
  }
  async function flushTyping() {
    if (typing === null) return;
    clearTimeout(typing);
    typing = null;
    await noteVersion(text, await typingChange());
  }

  // A window's edit: operations `ops` on rev `rev` of epoch `epoch`, moved over
  // what landed since, by character; an edit that yields, there since, yields
  // to it too, and a buddy's turn that loses part of it so is marked
  // `conflict` in history. `id` names it in the `ops` event that tells it;
  // one sent again once it landed lands no more, and is answered as it was.
  // An epoch or rev this service no longer has is `stale`: the window takes
  // the text again (state) and sends its edit on that.
  async function submit({ ops, rev: at, epoch: from, id } = {}, who) {
    if (!validOps(ops) || !Number.isInteger(at) || typeof id !== 'string') throw new DocError('bad_input', 'expected { ops, rev, epoch, id }');
    const saved = () => commit().catch((error) => {
      throw new DocError('not_saved', error.message);
    });
    return serial(async () => {
      const landedAt = from === epoch ? log.findIndex((landed) => landed.id === id) : -1;
      if (landedAt !== -1) {
        await saved();
        return { rev: logStart + landedAt + 1 };
      }
      if (from !== epoch || at < logStart || at > rev) throw new DocError('stale', 'the doc has moved on: take it again');
      const overridden = [];
      const left = []; // what each edit that yields is left as, once this lands
      for (let k = at - logStart; k < log.length; k++) {
        const landed = log[k];
        if (landed.base === undefined) {
          ops = transform(ops, landed.ops).ops;
          continue;
        }
        // An edit that yields, there since: it yields to this one, which
        // started before it, as the people's edits before this one left it.
        const was = landed.left ?? { ops: landed.ops, text: landed.base };
        const moved = pastYield(ops, was, await rules());
        if (moved.dropped && landed.reply) overridden.push(landed.reply);
        left.push([landed, { ...moved.left, end: rev + 1 }]);
        if (!landed.left) {
          ops = moved.ops;
          continue;
        }
        // From the text the ones before left, to the text before the next
        // edit that yields after them, or now.
        const next = log.findIndex((later, j) => j >= was.end - logStart && later.base !== undefined);
        ops = transform(moved.ops, diffOps(apply(was.text, was.ops), next === -1 ? text : log[next].base)).ops;
        k = next === -1 ? log.length : next - 1;
      }
      if (ops.length > 0 && ops.at(-1).to > text.length) throw new DocError('bad_input', 'operations past the end of the doc');
      for (const [landed, now] of left) landed.left = now;
      land(ops, { id });
      typed(who);
      await saved();
      for (const reply of overridden) await markConflict(docPath, settingsDir, reply);
      if (overridden.length > 0) emit('history', {});
      return { rev };
    });
  }

  // A missing doc written back as it is here, by `who`.
  async function recreate(who) {
    if (!missing) return {};
    await mkdir(dirname(docPath), { recursive: true });
    const ids = noteIds();
    await noteWritten(docPath, settingsDir, hashText(text), ids, writtenIds);
    writtenStat = await writeDoc(docPath, text, form);
    writtenHash = hashText(text);
    writtenIds = ids;
    written = text;
    await noteVersion(text, { kind: 'edit', author: byOf(who) });
    return {};
  }

  // `who`'s cursor is at offset `at` of the text at rev `rev` of `epoch`;
  // one from a rev windows are not all told of yet, or this service no
  // longer has, is dropped (the next comes).
  function cursor({ at, rev: from, epoch: of } = {}, who) {
    if (!Number.isInteger(at) || at < 0 || !Number.isInteger(from)) throw new DocError('bad_input', 'expected { at, rev, epoch }');
    if (of !== epoch || from < logStart || from > toldRev) return {};
    const now = log.slice(from - logStart, toldRev - logStart).reduce((offset, landed) => mapOffset(offset, landed.ops), at);
    cursors.set(who.id, { id: who.id, name: who.name, at: now });
    tellCursors(who.id);
    return {};
  }

  // Put the doc back the way it was in an earlier version, as `who`'s
  // edit: a new version, so the restore can itself be undone. Comments
  // stay; readers find their anchors in the restored text.
  async function restoreVersion(body, who) {
    const found = await readVersion(docPath, settingsDir, versionId(body?.id));
    if (!found) throw new DocError('not_found', 'no such version');
    await flushTyping();
    land(diffOps(text, found.text));
    await commit();
    await noteVersion(text, { kind: 'restore', author: byOf(who), restoredFrom: body.id });
    return {};
  }

  // The doc as `who` sees it, and their `level`. The owner's settings and
  // name are theirs alone: anyone else gets the default settings, and is
  // `me` themselves. A window that has the text at `since` ({ epoch, rev })
  // gets the `events` it missed since, as told, while the log holds them.
  async function state({ since } = {}, who) {
    const owner = can(who, 'owner');
    const caught = since?.epoch === epoch && Number.isInteger(since.rev) && since.rev >= logStart && since.rev <= toldRev;
    return {
      doc: basename(docPath),
      text,
      epoch,
      rev,
      ...(caught ? { events: log.slice(since.rev - logStart, toldRev - logStart).map((landed) => landed.event) } : {}),
      landed: landedBefore,
      ...(await commentsView(text)),
      settings: owner ? (await readSettings(settingsDir)).settings : DEFAULT_SETTINGS,
      defaultName: owner ? defaultName() : who.name,
      me: owner ? await me() : byOf(who),
      level: who.level,
      agents: agentStatuses(),
      cursors: cursorsNow(),
      project: folder !== null, // whether buddies can be made here
      // The project's name and the doc's path in it, for a teammate's sidebar.
      place: folder && { name: basename(folder), path: relative(folder, await realpath(docPath).catch(() => docPath)).split(sep).join('/') },
    };
  }

  // ---- comments (spec/SPEC.md) ----

  // The sidecar as it is on disk: its lines, the lines it could not read,
  // and the `problem` that makes it read-only (parseSidecar).
  async function readComments() {
    const text = await readSidecarText(docPath);
    return text === null ? { lines: [], bad: [], problem: null } : parseSidecar(text);
  }

  // The threads as a window shows them: each anchor where it is now in the
  // doc's `text` (it is never rewritten in the file), or `detached`; who
  // wrote in them; why they are read-only (`readOnly`, parseSidecar's
  // problem); and a notice about lines of the sidecar that cannot be read.
  async function commentsView(text) {
    const { lines, bad, problem } = await readComments();
    const comments = lines.map((l) => l.comment).filter(Boolean);
    const threads = threadsOf(comments, (await buddies()).map(({ id, name }) => ({ id, name }))).map((thread) => {
      if (!thread.anchor) return { ...thread, detached: false };
      const found = locate(text, thread.anchor);
      return { ...thread, anchor: found ? createAnchor(text, found.start, found.end) : thread.anchor, detached: !found };
    });
    const file = basename(sidecarPath(docPath));
    const notice = bad.length > 0 && !problem ? `${bad.length === 1 ? 'A line' : `${bad.length} lines`} of ${file} could not be read; ${bad.length === 1 ? 'it is' : 'they are'} kept as written.` : null;
    return { threads, people: peopleOf(comments), edits: await replyEdits(), readOnly: problem, notice };
  }

  // Add or remove lines of the sidecar, written whole. Run in `serial`.
  async function changeComments(change) {
    const current = await readComments();
    if (current.problem) throw new DocError('read_only', `${basename(sidecarPath(docPath))} is read-only here, so it is not changed`);
    const next = await change(current.lines);
    if (next !== current.lines) await writeSidecar(docPath, serializeSidecar(next));
  }

  // A comment by `who`: a first comment (`anchor` on the doc's text, or
  // null for the whole doc), or a reply in `thread`. Resolving is an empty
  // reply with `resolved`, reopening an empty reply; neither asks anyone.
  // Only a comment taken here asks (asks): it is noted before it is written.
  async function comment({ thread, anchor = null, body, resolved } = {}, who) {
    if (typeof body !== 'string' || (body.trim() === '' && thread === undefined)) throw new DocError('bad_input', 'a comment needs text');
    if (anchor !== null && (thread !== undefined || !validAnchor(anchor))) throw new DocError('bad_input', 'invalid anchor');
    if (resolved === true && thread === undefined) throw new DocError('bad_input', 'only a reply can resolve');
    const added = newComment({ thread, anchor, body, resolved }, { by: byOf(who), at: new Date().toISOString() });
    await serial(() => changeComments(async (lines) => {
      if (thread !== undefined && !lines.some((l) => l.comment?.id === thread && l.comment.thread === undefined)) throw new DocError('not_found', 'no such thread');
      if (body.trim() !== '') await noteTaken(docPath, settingsDir, added, lines.map((l) => l.comment?.id));
      return [...lines, { comment: added }];
    }));
    return { ...(await commentsView(text)), id: added.id };
  }

  // ---- the doc's buddies ----

  // Clippy, as the user made it, and the project's buddies.
  async function buddies() {
    return buddiesHere(folder ? await readBuddies(projectBuddiesDir(folder)) : [], await readBuddies(userBuddiesDir(settingsDir)));
  }

  // The asks waiting on a buddy now (docs/architecture.md, Who answers):
  // only the comments of those who may write ask: the owner and the
  // teammates who can edit, and only those this host took (comment), as
  // they were taken: one that reached the sidecar another way is shown but
  // asks no one. Each says who asked.
  async function asks() {
    if (closed) return [];
    const here = await buddies();
    if (here.length === 0) return [];
    const { lines, problem } = await readComments();
    if (problem) return []; // a buddy could not post its reply
    const editors = team ? (await team.list()).members.filter((m) => m.level === 'write').map((m) => m.id) : [];
    const askers = [(await me()).id, ...editors];
    const taken = await readTaken(docPath, settingsDir);
    const threads = threadsOf(lines.map((l) => l.comment).filter(Boolean), here.map(({ id, name }) => ({ id, name })));
    return threads.flatMap((thread) => [...askedBy(thread, askers, taken)].map(([id, asker]) => ({
      threadId: thread.id, thread, buddy: here.find((b) => b.id === id), buddies: here, asker,
    })).filter((ask) => ask.buddy)); // a thread's opener may be gone
  }

  // The level of the person with id `id` now: the owner's, a teammate's, or null.
  async function levelOf(id) {
    if (id === (await me()).id) return 'owner';
    return team ? team.levelOf(id) : null;
  }

  // The buddies the doc reaches, and which are at work.
  let shownBuddies = [];
  function agentStatuses() {
    const running = runner.statuses();
    return shownBuddies.map((b) => {
      const run = running.find((r) => r.id === b.id);
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
    await runner.reconcile();
  }

  // A run ended (runner.js): what it changed in its copy lands as an edit
  // that yields to what landed since the copy was made, then its reply is
  // posted. Where anyone changed the same line meanwhile, theirs stays, the
  // buddy's change there is dropped and the reply says `conflict`. A run
  // whose thread was resolved meanwhile is dropped whole. Its reply and
  // comments come just after the last comment it saw, so one written while
  // it worked still asks; the reply resolves the thread when the run asked
  // to. The buddy acts with the level of whoever asked it, at most write,
  // asked now: a run whose asker was removed or set to Read meanwhile lands
  // nothing. Run in `serial`.
  async function finishRun({ threadId, id: buddyId, name, asker, base, seen, edited, comments, body, failed }) {
    if (!can({ level: await levelOf(asker) }, 'write')) return;
    const latest = (await readComments()).lines.map((l) => l.comment).filter(Boolean);
    if (threadsOf(latest).find((t) => t.id === threadId)?.resolved) return;
    let conflict = false;
    const id = newId('c');
    if (edited !== null && edited !== base && !missing) { // a doc gone has nothing to land on
      await flushTyping();
      const edit = transform(diffOps(base, edited), diffOps(base, text), { yields: true, base, rules: await rules() });
      conflict = edit.dropped;
      land(edit.ops, { yields: true, reply: id, by: buddyId });
      await commit();
      await noteVersion(text, { kind: 'edit', author: { id: buddyId, name, kind: 'agent' }, thread: threadId, reply: id });
    }
    const by = { id: buddyId, name, kind: 'ai' };
    const at = Date.parse(seen) + 1;
    // Its comments are on the doc as it is now, its edit landed.
    await changeComments((lines) => {
      if (!lines.some((l) => l.comment?.id === threadId)) return lines;
      const threads = new Set(lines.filter((l) => l.comment && l.comment.thread === undefined).map((l) => l.comment.id));
      const added = comments ? appendedComments(comments.before, comments.after, { text, by, at: new Date(at).toISOString(), threads, own: threadId }) : { comments: [], resolves: false };
      const reply = {
        id, thread: threadId, by, at: new Date(at + 1).toISOString(), body, // after its comments, so it ends its thread
        ...(conflict ? { conflict: true } : {}), ...(failed ? { failed: true } : {}), ...(added.resolves ? { resolved: true } : {}),
      };
      return [...lines, ...added.comments.map((comment) => ({ comment })), { comment: reply }];
    }).catch((error) => console.error(`Could not post ${name}'s reply:`, error));
  }

  // ---- undo ----

  // Undo a buddy's run (docs/architecture.md, Undoing changes): the edit
  // from the version after it back to the version before it, as an edit
  // that yields to everything landed since, so text anyone changed since
  // stays. On the machine that has the versions; by `who`.
  async function undoReply(body, who) {
    await chronicle;
    const edit = (await readHistory(docPath, settingsDir)).find((v) => v.reply === body?.id);
    const found = edit && (await readVersion(docPath, settingsDir, edit.id));
    if (!found?.before) throw new DocError('not_found', 'no edit of that reply on this machine');
    await flushTyping();
    const after = found.text;
    land(transform(diffOps(after, found.before), diffOps(after, text), { yields: true, base: after, rules: await rules() }).ops, { yields: true });
    await commit();
    await noteVersion(text, { kind: 'undo', author: byOf(who), undid: body.id });
    return commentsView(text);
  }

  // The runs that edited the doc on this machine, by their reply: { [replyId]:
  // { state: 'edited' | 'undone', by, changes, version, conflict } },
  // `changes` how many places the run changed, `version` the version that
  // holds the doc right after it, and `conflict` whether a person's edit that
  // started before it took part of it back.
  async function replyEdits() {
    await chronicle; // a run's version is in before the page reads the doc it wrote
    const edits = {};
    for (const v of await readHistory(docPath, settingsDir)) {
      if (v.reply) edits[v.reply] = { state: 'edited', by: v.author?.id ?? v.author?.name ?? null, changes: v.changes ?? 0, version: v.id, conflict: Boolean(v.conflict) };
      if (v.undid && edits[v.undid]) edits[v.undid].state = 'undone';
    }
    return edits;
  }

  // ---- buddy files ----

  const projectDir = () => {
    if (!folder) throw new DocError('bad_input', 'buddies other than Clippy belong to a project');
    return projectBuddiesDir(folder);
  };

  // A buddy can be called anything but Clippy, its owner's or a teammate's name.
  async function checkBuddy(fields) {
    try {
      checkBuddyPatch(fields);
    } catch (error) {
      throw new DocError(error.code, error.message);
    }
    if (fields.name !== undefined && [CLIPPY.name, (await me()).name, ...(await teamNames())].some((n) => sameName(fields.name, n))) throw new DocError('bad_input', `the name ${fields.name} is taken`);
  }

  // The names of the teammates and of those asking to join.
  const teamNames = async () => (team ? team.names() : []);

  // The buddy here with id `id`.
  async function buddyById(id) {
    const found = (await buddies()).find((b) => b.id === id);
    if (!found) throw new DocError('not_found', 'no such buddy');
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

  // A new buddy, in this project's .ponjo/buddies/ (made if missing).
  async function createBuddy({ buddy } = {}) {
    const fields = { about: '', ...buddy };
    await checkBuddy(fields);
    if (!fields.name) throw new DocError('bad_input', 'a buddy needs a name');
    const dir = projectDir();
    return changeBuddies(() => writeBuddy(dir, { id: newId('b'), ...fields }));
  }

  // Change buddy `id` here: its name (renames its file) or who it is.
  // Clippy's is the user's own Clippy.md, in every doc; it keeps its name.
  async function updateBuddy({ id, patch = {} } = {}) {
    const found = await buddyById(id);
    if (found.where === 'app' && patch.name !== undefined) throw new DocError('bad_input', `${found.name} keeps its name`);
    await checkBuddy(patch);
    const { where, ...was } = found;
    if (where === 'app') return changeBuddies(() => saveBuddy(userBuddiesDir(settingsDir), { ...was, ...patch }));
    return changeBuddies(() => writeBuddy(projectDir(), { ...was, ...patch }, found.name));
  }

  // Delete buddy `id`'s file. Its comments stay. Clippy stays.
  async function deleteBuddy({ id } = {}) {
    const found = await buddyById(id);
    if (found.where === 'app') throw new DocError('bad_input', `${found.name} cannot be deleted`);
    return changeBuddies(() => removeBuddy(projectDir(), found.name));
  }

  // Add the doc as it now reads to its history (one version at a time, in
  // order); a failure is logged and never stops a save.
  function noteVersion(text, change) {
    const run = chronicle.then(async () => {
      const version = await recordVersion(docPath, settingsDir, text, change);
      if (version) emit('history', { id: version.id });
    });
    chronicle = run.catch((error) => console.error('Could not record a version:', error));
    return chronicle;
  }

  // This user, as their comments name them.
  function me() {
    return ownerOf(settingsDir);
  }

  // Watch both files and tell the page what changed, including the doc
  // going missing (moved or deleted outside the app) and coming back.
  async function onFilesChanged() {
    try {
      if (!(await serial(onDocChanged))) return;
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

  // The doc's part of onFilesChanged; false when it is missing. In `serial`,
  // so a write of this service's is all before the read or all after it:
  // a read from before it is never taken for someone else's change.
  async function onDocChanged() {
    if (!missing && ours(await stat(docPath).catch(() => null))) return true; // this service's own write
    let doc;
    try {
      doc = await readOutside();
    } catch (error) {
      if (error.code !== 'no_doc') throw error;
      if (!missing) {
        missing = true;
        emit('missing', { missing: true, doc: basename(docPath) });
      }
      return false;
    }
    if (missing) {
      missing = false;
      emit('missing', { missing: false, doc: basename(docPath) });
    }
    if (doc.hash !== writtenHash) { // not this service's write: a change made outside
      await takeOutside(doc);
      await commit();
    }
    return true;
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
  await noteVersion(text, { kind: 'external', author: null }); // the doc as first seen, or as changed while it was not open
  lastSidecarHash = await fileHash(sidecarPath(docPath));
  lastSettings = JSON.stringify((await readSettings(settingsDir)).settings);
  let stopWatching = watchDoc(docPath, onFilesChanged);
  const stopWatchingSettings = watchSettings(onSettingsChanged, settingsDir);
  let stopWatchingProjectBuddies = folder ? watchFolder(projectBuddiesDir(folder), syncAgents) : () => {};
  let project = folder ? projectService(folder) : null;
  const inProject = () => {
    if (!project) throw new DocError('bad_input', 'a doc on its own has no project');
    return project;
  };
  const stopWatchingUserBuddies = watchFolder(userBuddiesDir(settingsDir), syncAgents);
  const inTeam = () => {
    if (!team) throw new DocError('bad_input', 'a doc on its own has no team');
    return team;
  };
  async function changeTeam(fn) {
    await fn(inTeam());
    return team.list();
  }
  // The owner's windows follow the team (desktop/doc-host.js sends `team` to
  // theirs alone), and so do the asks: who may ask changes with it.
  const followTeam = () => team?.onChange(async () => {
    emit('team', await team.list());
    await runner.reconcile();
  }) ?? (() => {});
  let stopFollowingTeam = followTeam();
  await syncAgents();

  // What a window may ask, by the level it needs (`can`). Each returns what
  // changed, for the window that asked.
  const calls = {
    read: {
      state,
      cursor,
      async history() {
        await serial(flushTyping); // typing not paused yet is a version too
        await chronicle;
        return { versions: await readHistory(docPath, settingsDir) };
      },
      async version(body) {
        const found = await readVersion(docPath, settingsDir, versionId(body?.id));
        if (!found) throw new DocError('not_found', 'no such version');
        return found;
      },
      // The project's files (project-service.js), `path` in the project.
      // Its real path is the owner's alone.
      list: (body) => inProject().list(body?.path),
      read: (body) => inProject().read(body?.path),
      async open(body, who) {
        const opened = await inProject().open(body?.path);
        return can(who, 'owner') ? opened : { path: body.path };
      },
    },
    write: {
      submit,
      recreate: (body, who) => serial(() => recreate(who)),
      comment: (body, who) => comment({ thread: body?.thread, anchor: body?.anchor ?? null, body: body?.body, resolved: body?.resolved }, who),
      restoreVersion: (body, who) => serial(() => restoreVersion(body, who)),
      undoReply: (body, who) => serial(() => undoReply(body, who)),
    },
    owner: {
      async saveSettings(patch) {
        if (patch && Object.hasOwn(patch, 'id')) throw new DocError('bad_input', 'your id cannot be changed');
        // Your name is no buddy's or teammate's here, as theirs are not yours.
        if (typeof patch?.name === 'string' && [...(await buddies()).map((b) => b.name), ...(await teamNames())].some((n) => sameName(n, patch.name))) throw new DocError('bad_input', `the name ${patch.name} is taken`);
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
      scripts: async () => ({ agents: await listAgents(settingsDir), shipped: SHIPPED_AGENTS, folder: agentsDir(settingsDir), secrets: secretsSet(secrets()) }),
      // A shipped agent script, written again as it came.
      async resetScript(body) {
        if (!SHIPPED_AGENTS.includes(body?.name)) throw new DocError('bad_input', 'not a shipped agent');
        await installAgents(settingsDir, { reset: body.name });
        return { agents: await listAgents(settingsDir) };
      },
      // The project's team (team.js), each call answered with the team as it is then.
      team: () => inTeam().list(),
      allow: (body) => changeTeam((t) => t.allow(body?.id, body?.level)),
      remove: (body) => changeTeam((t) => t.remove(body?.id)),
      setLevel: (body) => changeTeam((t) => t.set(body?.id, { level: body?.level })),
      link: () => changeTeam((t) => t.link()),
    },
  };

  return {
    // The door: every call comes through here, once, as `who`.
    async call(type, arg, who) {
      const level = LEVELS.find((l) => Object.hasOwn(calls[l], type));
      if (!level) throw new DocError('bad_input', `unknown call: ${type}`);
      if (!can(who, level)) throw new DocError('forbidden', `${who?.name ?? 'no one'} may not ${type} here`);
      try {
        return await calls[level][type](arg, who);
      } catch (error) {
        if (error instanceof StoreError || error instanceof TeamError) throw new DocError(error.code, error.message);
        throw error;
      }
    },
    /** The owner of this machine, as a `who`. */
    owner: async () => ({ ...(await me()), level: 'owner' }),
    /** Person `id` has no window or page on the doc any more: their cursor goes. */
    leave(id) {
      if (cursors.delete(id)) tellCursors();
    },
    /** What a window hears first: whether the doc is missing, and who is at work. */
    hello: () => ({ missing, agents: agentStatuses() }),
    runner,
    docPath: () => docPath,
    moveTo,
    setFolder(next, nextTeam) {
      folder = next;
      project = folder ? projectService(folder) : null;
      stopFollowingTeam();
      team = nextTeam;
      stopFollowingTeam = followTeam();
      stopWatchingProjectBuddies();
      stopWatchingProjectBuddies = folder ? watchFolder(projectBuddiesDir(folder), syncAgents) : () => {};
      syncAgents();
    },
    // Closed even when its last write fails: what was not written is lost.
    async close() {
      try {
        await serial(async () => {
          await commit();
          await flushTyping();
        });
      } finally {
        clearTimeout(unsaved);
        stopWatching();
        stopWatchingSettings();
        stopWatchingProjectBuddies();
        stopWatchingUserBuddies();
        stopFollowingTeam();
        closed = true;
        await runner.stop();
      }
    },
  };
}

// How many landed edits the log keeps: a window's edit from an older rev is stale.
const LOG_SIZE = 1000;
// A write that failed is tried again after this long.
const RETRY_MS = 500;
// Typing is a version once it pauses this long.
const SAVE_DELAY_MS = 800;
// A file changed outside is taken once it is unchanged this long, waiting at most STILL_TRIES times.
const STILL_MS = 50;
const STILL_TRIES = 20;

// Whether `ops` is an edit: { from, to, insert } in order, not overlapping.
function validOps(ops) {
  if (!Array.isArray(ops)) return false;
  let at = 0;
  for (const op of ops) {
    if (!Number.isInteger(op?.from) || !Number.isInteger(op.to) || typeof op.insert !== 'string' || op.from < at || op.to < op.from) return false;
    at = op.to;
  }
  return true;
}

// Whether stats `a` and `b` (or null) are of one file, unchanged.
const sameStat = (a, b) => Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino);

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
