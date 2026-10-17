import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyOp, newId } from '../src/core/index.js';
import { readSidecar, sidecarPath, update } from '../src/store/files.js';
import {
  cleanPaths, countFolder, createDoc, createFolder, createUntitled, docPathFor, freeUntitledPath, isInside, moveFolder,
  nameProblem, pathsFromArgs, renameDoc, trashDoc, withDocExtension,
} from '../desktop/files.js';
import { MAX_FOLDER_DOCS, MAX_RECENT, addRecent, readState, rememberFolderDoc, removeRecent, renameRecent, writeState } from '../desktop/state.js';
import { docInFolder, firstDoc, listDocs, listedFolders, neighbourDoc, relativeDoc, watchFolder } from '../desktop/folder.js';
import { tempDoc } from './helpers.js';

const tempDir = () => mkdtemp(join(tmpdir(), 'opendoc-desktop-'));

test('docPathFor opens docs and sidecars and refuses other files', () => {
  assert.equal(docPathFor('/a/plan.md'), '/a/plan.md');
  assert.equal(docPathFor('/a/Notes.MARKDOWN'), '/a/Notes.MARKDOWN');
  assert.equal(docPathFor('/a/plan.md.opendoc.json'), '/a/plan.md');
  assert.equal(docPathFor('/a/plan.txt'), null);
  assert.equal(docPathFor('/a/data.json'), null);
  assert.equal(docPathFor('/a/plan.txt.opendoc.json'), null);
});

test('withDocExtension adds .md only when missing', () => {
  assert.equal(withDocExtension('/a/idea'), '/a/idea.md');
  assert.equal(withDocExtension('/a/idea.md'), '/a/idea.md');
  assert.equal(withDocExtension('/a/idea.markdown'), '/a/idea.markdown');
  assert.equal(withDocExtension('/a/v1.2'), '/a/v1.2.md');
});

test('createDoc writes an empty doc, makes its folder, and creates no sidecar', async () => {
  const dir = await tempDir();
  const path = join(dir, 'notes', 'idea.md');
  assert.equal(await createDoc(path), path);
  assert.equal(await readFile(path, 'utf8'), '');
  assert.deepEqual(await readdir(dirname(path)), ['idea.md']);
});

test('createDoc never overwrites an existing doc', async () => {
  const path = await tempDoc('keep me');
  await assert.rejects(createDoc(path), { code: 'exists', path });
  assert.equal(await readFile(path, 'utf8'), 'keep me');
});

test('new docs in a folder take the next free Untitled name', async () => {
  const dir = await tempDir();
  assert.equal(await createUntitled(dir), join(dir, 'Untitled.md'));
  assert.equal(await createUntitled(dir), join(dir, 'Untitled 2.md'));
  await writeFile(join(dir, 'Untitled 4.md'), 'taken');
  assert.equal(await createUntitled(dir), join(dir, 'Untitled 3.md'));
  assert.equal(await createUntitled(dir), join(dir, 'Untitled 5.md'));
  assert.equal(await readFile(join(dir, 'Untitled 4.md'), 'utf8'), 'taken');
});

test('a leftover sidecar keeps its name from being reused', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'Untitled.md.opendoc.json'), '{}');
  assert.equal(await freeUntitledPath(dir), join(dir, 'Untitled 2.md'));
});

test('renameDoc moves the doc and its sidecar together', async () => {
  const from = await tempDoc('# Plan\n\nShip it.\n');
  await update(from, (s) => applyOp(s, { type: 'join', participant: { name: 'fzhan', kind: 'human' } }));
  const to = join(dirname(from), 'launch');

  const moved = await renameDoc(from, to);
  assert.equal(moved, `${to}.md`);
  assert.deepEqual((await readdir(dirname(from))).sort(), ['launch.md', 'launch.md.opendoc.json']);
  assert.equal(await readFile(moved, 'utf8'), '# Plan\n\nShip it.\n');
  const sidecar = await readSidecar(moved);
  assert.equal(sidecar.doc, 'launch.md');
  assert.equal(sidecar.participants[0].name, 'fzhan');
});

test('renameDoc without a sidecar moves only the doc', async () => {
  const from = await tempDoc();
  const moved = await renameDoc(from, join(dirname(from), 'other.md'));
  assert.deepEqual(await readdir(dirname(from)), ['other.md']);
  assert.equal(moved, join(dirname(from), 'other.md'));
});

test('renameDoc never overwrites another doc', async () => {
  const from = await tempDoc('mine');
  const other = join(dirname(from), 'other.md');
  await writeFile(other, 'theirs');
  await assert.rejects(renameDoc(from, other), { code: 'exists' });
  assert.equal(await readFile(from, 'utf8'), 'mine');
  assert.equal(await readFile(other, 'utf8'), 'theirs');
});

test('renameDoc can change only the case of the name', async () => {
  const from = await tempDoc('mine');
  await update(from, (s) => applyOp(s, {
    type: 'addThread', id: newId('t'), anchor: null,
    message: { id: newId('m'), author: { name: 'fzhan', kind: 'human' }, body: 'hi', createdAt: new Date().toISOString() },
  }));
  const moved = await renameDoc(from, join(dirname(from), 'Plan.md'));
  assert.equal(moved, join(dirname(from), 'Plan.md'));
  assert.deepEqual((await readdir(dirname(from))).sort(), ['Plan.md', 'Plan.md.opendoc.json']);
  assert.equal((await readSidecar(moved)).threads.length, 1);
  assert.equal(JSON.parse(await readFile(sidecarPath(moved), 'utf8')).doc, 'Plan.md');
});

test('state round-trips and survives a missing or corrupt file', async () => {
  const dir = await tempDir();
  const empty = { recent: [], folderDocs: {}, lastFolder: null, bounds: null };
  assert.deepEqual(await readState(dir), empty);
  const state = { recent: ['/a/x.md', '/b'], folderDocs: { '/b': 'notes/y.md' }, lastFolder: '/a', bounds: { x: 1, y: 2, width: 800, height: 600 } };
  await writeState(state, dir);
  assert.deepEqual(await readState(dir), state);
  await writeFile(join(dir, 'state.json'), '{ nope');
  assert.deepEqual(await readState(dir), empty);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ folderDocs: { '/b': 3, '/c': 'z.md' } }));
  assert.deepEqual((await readState(dir)).folderDocs, { '/c': 'z.md' });
});

test('recent docs: newest first, no duplicates, at most ten, renames keep their place', () => {
  let recent = [];
  for (let i = 0; i < 12; i++) recent = addRecent(recent, `/d/${i}.md`);
  assert.equal(recent.length, MAX_RECENT);
  assert.equal(recent[0], '/d/11.md');
  recent = addRecent(recent, '/d/5.md');
  assert.deepEqual(recent.slice(0, 2), ['/d/5.md', '/d/11.md']);
  assert.equal(recent.filter((p) => p === '/d/5.md').length, 1);
  assert.equal(renameRecent(recent, '/d/11.md', '/d/eleven.md')[1], '/d/eleven.md');
  assert.ok(!removeRecent(recent, '/d/5.md').includes('/d/5.md'));
});

test('pathsFromArgs: doc paths from a launch, absolute, flags skipped', () => {
  const cwd = join(tmpdir(), 'work');
  assert.deepEqual(
    pathsFromArgs(['electron', 'desktop/main.js', 'plan.md', '--inspect', join(cwd, 'b', 'x.md')], { packaged: false, cwd }),
    [join(cwd, 'plan.md'), join(cwd, 'b', 'x.md')],
  );
  assert.deepEqual(pathsFromArgs(['OpenDoc.exe', 'notes/idea.md'], { packaged: true, cwd }), [join(cwd, 'notes', 'idea.md')]);
  assert.deepEqual(pathsFromArgs(['OpenDoc.exe', '--allow-file-access'], { packaged: true, cwd }), []);
  assert.deepEqual(pathsFromArgs(['electron', 'desktop/main.js'], { packaged: false, cwd }), []);
});

test('cleanPaths keeps absolute path strings only, up to a limit', () => {
  const doc = join(tmpdir(), 'plan.md');
  assert.deepEqual(cleanPaths([doc, 'relative.md', 42, null, { path: doc }]), [doc]);
  assert.deepEqual(cleanPaths('not a list'), []);
  assert.equal(cleanPaths(Array(30).fill(doc), 20).length, 20);
});

test('the doc last open in a folder: newest first, one per folder, at most fifty folders', () => {
  let folderDocs = {};
  for (let i = 0; i < MAX_FOLDER_DOCS + 5; i++) folderDocs = rememberFolderDoc(folderDocs, `/f/${i}`, 'a.md');
  assert.equal(Object.keys(folderDocs).length, MAX_FOLDER_DOCS);
  folderDocs = rememberFolderDoc(folderDocs, '/f/10', 'sub/b.md');
  assert.deepEqual(Object.entries(folderDocs)[0], ['/f/10', 'sub/b.md']);
  assert.equal(Object.keys(folderDocs).filter((k) => k === '/f/10').length, 1);
});

test('listDocs: the docs in a folder and its subfolders, subfolders first, hidden folders and packages left out', async () => {
  const dir = await tempDir();
  const files = [
    'README.md', 'b.markdown', 'a 10.md', 'a 2.md', 'notes.txt', 'plan.md.opendoc.json', '.hidden.md',
    'guides/intro.md', 'guides/deep/more.md', 'empty/nothing.txt', '.git/HEAD.md', 'node_modules/pkg/readme.md',
  ];
  for (const file of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), '');
  }
  await symlink(join(dir, 'guides'), join(dir, 'linked'), 'junction'); // a junction on Windows, which needs no admin rights
  const { docs, truncated } = await listDocs(dir);
  assert.deepEqual(docs, ['guides/deep/more.md', 'guides/intro.md', 'a 2.md', 'a 10.md', 'b.markdown', 'README.md']);
  assert.equal(truncated, false);
  assert.deepEqual(await listDocs(dir, { max: 2 }), { docs: ['guides/deep/more.md', 'guides/intro.md'], empty: [], truncated: true });
  assert.deepEqual(await listDocs(join(dir, 'missing')), { docs: [], empty: [], truncated: false });
  assert.equal(docInFolder(dir, 'guides/deep/more.md'), join(dir, 'guides', 'deep', 'more.md'));
});

test('listDocs lists empty folders, but not folders holding only other files', async () => {
  const dir = await tempDir();
  for (const folder of ['fresh', 'quiet/.keep', 'code/src', 'docs/inner']) await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, 'quiet', '.DS_Store'), '');
  await writeFile(join(dir, 'code', 'src', 'main.js'), '');
  await writeFile(join(dir, 'docs', 'a.md'), '');
  const listing = await listDocs(dir);
  assert.deepEqual(listing.docs, ['docs/a.md']);
  assert.deepEqual(listing.empty.sort(), ['docs/inner', 'fresh', 'quiet']);
  assert.deepEqual([...listedFolders(listing)].sort(), ['docs', 'docs/inner', 'fresh', 'quiet']);
});

test('neighbourDoc: the next doc in the same folder, else the one above, else the first', () => {
  const docs = ['a/one.md', 'a/two.md', 'a/three.md', 'b.md', 'README.md'];
  assert.equal(neighbourDoc(docs, 'a/two.md'), 'a/three.md');
  assert.equal(neighbourDoc(docs, 'a/three.md'), 'a/two.md');
  assert.equal(neighbourDoc(docs, 'a/three.md', (doc) => doc !== 'a/two.md'), 'a/one.md');
  assert.equal(neighbourDoc(['a/x.md', 'b.md', 'README.md'], 'a/x.md'), 'README.md');
  assert.equal(neighbourDoc(docs, 'a', (doc) => !doc.startsWith('a/')), 'README.md');
  assert.equal(neighbourDoc(['only.md'], 'only.md'), null);
});

test('nameProblem refuses empty, hidden, slashed and, on Windows, reserved names', () => {
  assert.equal(nameProblem('plan', 'darwin'), null);
  assert.equal(nameProblem('plan: v2', 'darwin'), null);
  assert.match(nameProblem('  ', 'darwin'), /Enter a name/);
  assert.match(nameProblem('.secret', 'darwin'), /hidden/);
  assert.match(nameProblem('..', 'darwin'), /can't be a name/);
  assert.match(nameProblem('plan: v2', 'win32'), /can't contain :/);
  assert.match(nameProblem('con', 'win32'), /Windows keeps/);
  assert.match(nameProblem('plan.', 'win32'), /end with a dot/);
  assert.match(nameProblem('x'.repeat(256), 'linux'), /too long/);
  assert.match(nameProblem('notes/kickoff', 'darwin'), /can't contain \//);
});

test('isInside: a path in a folder, or the folder itself, but not a sibling with a longer name', () => {
  const root = join(tmpdir(), 'work');
  assert.equal(isInside(root, join(root, 'a', 'b.md')), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, join(tmpdir(), 'work2', 'b.md')), false);
  assert.equal(isInside(join(root, 'a'), root), false);
});

test('createFolder makes a folder, with its parents, and never reuses one', async () => {
  const dir = await tempDir();
  await createFolder(join(dir, 'notes', 'drafts'));
  assert.equal((await stat(join(dir, 'notes', 'drafts'))).isDirectory(), true);
  await assert.rejects(createFolder(join(dir, 'notes')), { code: 'exists' });
});

test('moveFolder moves a folder with everything in it, never over another or into itself', async () => {
  const dir = await tempDir();
  await mkdir(join(dir, 'drafts', 'deep'), { recursive: true });
  await writeFile(join(dir, 'drafts', 'deep', 'plan.md'), '# Plan\n');
  await writeFile(join(dir, 'drafts', 'deep', 'plan.md.opendoc.json'), '{}');
  await mkdir(join(dir, 'archive'));
  await moveFolder(join(dir, 'drafts'), join(dir, 'archive', 'drafts'));
  assert.deepEqual((await readdir(join(dir, 'archive', 'drafts', 'deep'))).sort(), ['plan.md', 'plan.md.opendoc.json']);
  await mkdir(join(dir, 'taken'));
  await assert.rejects(moveFolder(join(dir, 'archive'), join(dir, 'taken')), { code: 'exists' });
  await assert.rejects(moveFolder(join(dir, 'archive'), join(dir, 'archive', 'drafts', 'archive')), { code: 'inside' });
  await moveFolder(join(dir, 'archive'), join(dir, 'Archive'));
  assert.ok((await readdir(dir)).includes('Archive'));
});

test('countFolder counts docs and other files, sidecars aside', async () => {
  const dir = await tempDir();
  for (const file of ['a.md', 'a.md.opendoc.json', 'sub/b.markdown', 'sub/pic.png', '.hidden/x.txt', 'notes.txt']) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), '');
  }
  assert.deepEqual(await countFolder(dir), { docs: 2, others: 3 });
});

test('trashDoc puts the doc and then its sidecar in the Trash', async () => {
  const dir = await tempDir();
  const doc = join(dir, 'plan.md');
  await writeFile(doc, '');
  await writeFile(sidecarPath(doc), '{}');
  const trashed = [];
  await trashDoc(doc, async (path) => trashed.push(path));
  assert.deepEqual(trashed, [doc, sidecarPath(doc)]);
  const lone = join(dir, 'lone.md');
  await writeFile(lone, '');
  trashed.length = 0;
  await trashDoc(lone, async (path) => trashed.push(path));
  assert.deepEqual(trashed, [lone]);
});

test('relativeDoc says where a doc is in a folder, and null outside it', () => {
  const root = join(tmpdir(), 'work');
  assert.equal(relativeDoc(root, join(root, 'a', 'b.md')), 'a/b.md');
  assert.equal(relativeDoc(root, join(root, 'b.md')), 'b.md');
  assert.equal(relativeDoc(root, join(tmpdir(), 'other', 'b.md')), null);
  assert.equal(relativeDoc(root, join(root, '..', 'b.md')), null);
  assert.equal(relativeDoc(root, join(root, '..work', 'b.md')), '..work/b.md');
  assert.equal(relativeDoc(root, root), null);
});

test('firstDoc: the one last open, else a README or index at the top, else the first', () => {
  assert.equal(firstDoc(['a/x.md', 'b.md', 'README.md'], 'a/x.md'), 'a/x.md');
  assert.equal(firstDoc(['a/x.md', 'b.md', 'README.md'], 'gone.md'), 'README.md');
  assert.equal(firstDoc(['a/README.md', 'b.md', 'index.md']), 'index.md');
  assert.equal(firstDoc(['a/x.md', 'b.md']), 'b.md');
  assert.equal(firstDoc(['a/x.md']), 'a/x.md');
  assert.equal(firstDoc([]), null);
});

test('watchFolder notices docs added, removed and renamed in subfolders, but not edits', async () => {
  const dir = await tempDir();
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'a.md'), 'one');
  let changes = 0;
  const stop = watchFolder(dir, () => changes++);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 600));
  try {
    await settle();
    changes = 0;
    await writeFile(join(dir, 'sub', 'b.md'), 'new');
    await settle();
    assert.ok(changes >= 1, 'a new doc');
    changes = 0;
    await rename(join(dir, 'sub', 'b.md'), join(dir, 'sub', 'c.md'));
    await settle();
    assert.ok(changes >= 1, 'a renamed doc');
  } finally {
    stop();
  }
});
