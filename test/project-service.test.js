// ProjectService (src/host/project-service.js) on real files: what a project
// shows, and every way out of it refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_TEXT_BYTES } from '../src/store/files.js';
import { projectService, resolve } from '../src/host/project-service.js';

const fsp = createRequire(import.meta.url)('node:fs/promises');
const isWindows = process.platform === 'win32';
const notFound = (error) => error.code === 'not_found';

// A project (its real path) holding `files` ({ path: text }), and a folder outside it.
async function project(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-project-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'ponjo-outside-')));
  await writeFile(join(outside, 'secret.md'), 'outside\n');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return { root, outside, service: projectService(root) };
}

test('list: every file and folder the project shows, folders first, without dot names or a file\'s sidecar', async () => {
  const { root, outside, service } = await project({
    'b.md': '', 'b.md.comments.jsonl': '', 'gone.md.comments.jsonl': '', 'a 10.txt': '', 'a 2.txt': '', '.env': '', '.DS_Store': '',
    '.git/HEAD': '', '.github/ci.yml': '', 'node_modules/pkg/index.js': '', 'src/main.js': '', 'empty/.keep': '',
  });
  await symlink(join(root, 'src'), join(root, 'linked'), 'junction'); // a junction on Windows, which needs no admin rights
  await symlink(outside, join(root, 'out'), 'junction');
  await symlink(join(root, '.github'), join(root, 'ci'), 'junction');
  assert.deepEqual(await service.list(''), [
    { name: 'empty', folder: true }, { name: 'linked', folder: true }, { name: 'node_modules', folder: true }, { name: 'src', folder: true },
    { name: 'a 2.txt', folder: false }, { name: 'a 10.txt', folder: false }, { name: 'b.md', folder: false },
    { name: 'gone.md.comments.jsonl', folder: false },
  ]);
  assert.deepEqual(await service.list('empty'), []);
  assert.deepEqual(await service.list('linked'), [{ name: 'main.js', folder: false }], 'a link that stays in the project');
  for (const rel of ['out', 'ci', '.github', 'missing', 'b.md']) await assert.rejects(service.list(rel), notFound, rel);
});

test('resolve: the real path of what the project shows; any other path is not found', async () => {
  const { root, outside } = await project({ 'notes/a.md': '', '.env': '', 'docs/.secret': '', '.github/x.md': '', '.ponjo/buddies/x.md': '' });
  await symlink(outside, join(root, 'out'), 'junction');
  await symlink(tmpdir(), join(root, 'tmp'), 'junction');
  await symlink(join(root, 'notes'), join(root, 'in'), 'junction');
  assert.equal(await resolve(root, ''), root);
  assert.equal(await resolve(root, 'notes/a.md'), join(root, 'notes', 'a.md'));
  assert.equal(await resolve(root, 'in/a.md'), join(root, 'notes', 'a.md'), 'a link inside, as its real path');
  const refused = [
    '..', '../x', 'notes/../../x', 'notes/../a.md', './notes/a.md', 'notes//a.md', 'notes/', '/etc/passwd', join(root, 'notes', 'a.md'),
    '.env', 'docs/.secret', '.github/x.md', '.ponjo/buddies/x.md', 'out/secret.md', 'tmp', 'missing.md', 'a\0b',
  ];
  for (const rel of refused) await assert.rejects(resolve(root, rel), notFound, rel);
  for (const rel of [null, undefined, 42, ['a.md'], { path: 'a.md' }]) await assert.rejects(resolve(root, rel), notFound, String(rel));
});

test('links to files: one that stays in the project and leads to what it shows is its file; any other is not found', { skip: isWindows && 'linking files needs admin rights on Windows' }, async () => {
  const { root, outside, service } = await project({ 'a.md': 'inside\n', '.env': 'KEY=1\n', 'notes/.draft.md': '' });
  await symlink(join(root, 'a.md'), join(root, 'same.md'));
  await symlink(join(root, '.env'), join(root, 'env.txt'));
  await symlink(join(root, 'notes', '.draft.md'), join(root, 'draft.md'));
  await symlink(join(outside, 'secret.md'), join(root, 'secret.md'));
  await symlink('../' + outside.split('/').at(-1) + '/secret.md', join(root, 'relative.md'));
  assert.deepEqual((await service.list('')).map((e) => e.name), ['notes', 'a.md', 'same.md']);
  assert.deepEqual(await service.read('same.md'), { text: 'inside\n' });
  assert.deepEqual(await service.open('same.md'), { path: join(root, 'a.md') });
  for (const rel of ['env.txt', 'draft.md', 'secret.md', 'relative.md']) {
    await assert.rejects(service.read(rel), notFound, rel);
    await assert.rejects(service.open(rel), notFound, rel);
  }
});

test('read: a file\'s text, but not a large or binary one, nor a folder', async () => {
  const { service } = await project({ 'a.js': 'let x = 1;\n', 'pic.png': Buffer.from([0x89, 0x50, 0x00, 0x47]), 'big.log': 'x'.repeat(MAX_TEXT_BYTES + 1), 'src/x.js': '' });
  assert.deepEqual(await service.read('a.js'), { text: 'let x = 1;\n' });
  assert.deepEqual(await service.read('pic.png'), { problem: 'binary' });
  assert.deepEqual(await service.read('big.log'), { problem: 'large' });
  await assert.rejects(service.read('src'), notFound);
  await assert.rejects(service.open('src'), notFound);
  await assert.rejects(service.read(''), notFound);
});

// Run each swap just before the nth call of an fs/promises function
// ({ name: [n, swap] }), in every module that imports it, during `fn`.
async function withSwaps(swaps, fn) {
  const real = {};
  for (const [name, [n, swap]] of Object.entries(swaps)) {
    real[name] = fsp[name];
    let calls = 0;
    fsp[name] = async (...args) => {
      if (++calls === n) await swap();
      return real[name](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    Object.assign(fsp, real);
    syncBuiltinESMExports();
  }
}

test('a file swapped for a link out of the project between the check and the open is refused', { skip: isWindows && 'linking files needs admin rights on Windows' }, async () => {
  const { root, outside, service } = await project({ 'a.md': 'inside\n' });
  const path = join(root, 'a.md');
  const toLink = async () => {
    await rename(path, join(root, 'kept.md'));
    await symlink(join(outside, 'secret.md'), path);
  };
  const toFile = async () => {
    await rm(path);
    await rename(join(root, 'kept.md'), path);
  };
  // Checked as a file, opened as the link.
  await withSwaps({ open: [1, toLink] }, () => assert.rejects(service.read('a.md'), notFound));
  await toFile();
  // Opened as the link, then a file again while it is checked, and the link
  // once more just before the check looks at what the path is.
  await withSwaps({ open: [1, toLink], realpath: [3, toFile], lstat: [1, toLink] }, () => assert.rejects(service.read('a.md'), notFound));
  await toFile();
  assert.deepEqual(await service.read('a.md'), { text: 'inside\n' });
});

test('names are compared as the disk does: on a disk that ignores case, either case finds the file and nothing outside', async () => {
  const { root, service } = await project({ 'README.md': 'hi\n' });
  const ignoresCase = await stat(join(root, 'readme.MD')).then(() => true, () => false);
  if (!ignoresCase) {
    await assert.rejects(service.read('readme.MD'), notFound, 'a disk that minds case');
    return;
  }
  assert.deepEqual(await service.read('readme.MD'), { text: 'hi\n' });
  assert.deepEqual(await projectService(root.toUpperCase()).read('README.md'), { text: 'hi\n' }, 'the project opened in another case');
});
