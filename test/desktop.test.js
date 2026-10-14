import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyOp, newId } from '../src/core/index.js';
import { readSidecar, sidecarPath, update } from '../src/store/files.js';
import {
  createDoc, createUntitled, docPathFor, freeUntitledPath, renameDoc, withDocExtension,
} from '../desktop/files.js';
import { MAX_RECENT, addRecent, readState, removeRecent, renameRecent, writeState } from '../desktop/state.js';
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
  assert.deepEqual(await readState(dir), { recent: [], lastFolder: null, bounds: null });
  const state = { recent: ['/a/x.md'], lastFolder: '/a', bounds: { x: 1, y: 2, width: 800, height: 600 } };
  await writeState(state, dir);
  assert.deepEqual(await readState(dir), state);
  await writeFile(join(dir, 'state.json'), '{ nope');
  assert.deepEqual(await readState(dir), { recent: [], lastFolder: null, bounds: null });
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
