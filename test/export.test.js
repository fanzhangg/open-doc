import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { main } from '../src/cli/main.js';
import { applyOp, createAnchor, emptySidecar, project, serializeSidecar } from '../src/core/index.js';
import { parseMarkdown } from '../src/core/project.js';
import { markThreads, pickThreads } from '../src/export/comments.js';
import { ExportError, checkExportOptions, defaultPaper, exportDoc, exportName } from '../src/export/index.js';
import { findBrowser } from '../src/export/browser.js';
import { imageSize } from '../src/export/images.js';
import { SAMPLE, tempDoc } from './helpers.js';

const human = { name: 'fzhan', kind: 'human' };
const agent = { name: 'claude', kind: 'agent' };
const at = '2026-10-14T18:20:00Z';
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** A sidecar with a thread on each quote: { quote, status, reply, body }. */
function sidecarFor(markdown, threads) {
  const { text } = project(markdown);
  let sidecar = emptySidecar('plan.md');
  threads.forEach(({ quote, status = 'open', reply, body = `About ${quote}` }, i) => {
    const id = `t_thread${i}x`;
    const start = quote ? text.indexOf(quote) : -1;
    assert.ok(!quote || start >= 0, quote);
    sidecar = applyOp(sidecar, {
      type: 'addThread', id, anchor: quote ? createAnchor(text, start, start + quote.length) : null,
      message: { id: `m_first${i}x`, author: human, body, createdAt: at },
    });
    if (reply) sidecar = applyOp(sidecar, { type: 'addMessage', threadId: id, message: { id: `m_reply${i}x`, author: agent, body: reply, createdAt: at } });
    if (status === 'resolved') sidecar = applyOp(sidecar, { type: 'resolve', threadId: id, by: 'fzhan', kind: 'human', at });
  });
  return sidecar;
}

async function docWithThreads(markdown, threads) {
  const docPath = await tempDoc(markdown);
  await writeFile(docPath + '.opendoc.json', serializeSidecar(sidecarFor(markdown, threads)));
  return docPath;
}

// The files in a zip (a .docx), by name.
function unzip(buffer) {
  const files = {};
  let end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(at + 10);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    at += 46 + nameLength + extra;
  }
  return files;
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

test('threads are picked by status and numbered in the order of their text', () => {
  const sidecar = sidecarFor(SAMPLE, [
    { quote: 'extra load' },
    { quote: 'ship all six features', status: 'resolved' },
    { quote: null },
    { quote: 'beta cohort' },
  ]);
  assert.deepEqual(pickThreads(sidecar, SAMPLE, 'none'), []);
  const open = pickThreads(sidecar, SAMPLE, 'open');
  assert.deepEqual(open.map((p) => [p.n, p.thread.anchor?.exact ?? null]), [[1, 'beta cohort'], [2, 'extra load'], [3, null]]);
  const all = pickThreads(sidecar, SAMPLE, 'all');
  assert.deepEqual(all.map((p) => p.thread.anchor?.exact ?? null), ['ship all six features', 'beta cohort', 'extra load', null]);
  assert.equal(all[0].range.end - all[0].range.start, '**ship all six features**'.length - 4);
  assert.equal(all[3].range, null);
});

test('marks follow a thread across formatting and end with its number', () => {
  const markdown = 'Plain **bold part** and *more* text.\n';
  const picked = pickThreads(sidecarFor(markdown, [{ quote: 'part and more' }]), markdown, 'all');
  const tree = parseMarkdown(markdown);
  assert.deepEqual([...markThreads(tree, markdown, picked)], [1]);
  const paragraph = tree.children[0];
  const shape = (node) => node.type === 'text' ? node.value : node.type === 'odRef' ? `[${node.n}]` : node.type === 'odMark' ? `<${node.children.map(shape).join('')}>` : `${node.type}(${node.children.map(shape).join('')})`;
  assert.equal(paragraph.children.map(shape).join(''), 'Plain strong(bold <part>)< and >emphasis(<more>[1]) text.');
});

test('in HTML a number that ends inside a link moves after it', () => {
  const markdown = 'See [the capacity doc](./capacity.md) now.\n';
  const picked = pickThreads(sidecarFor(markdown, [{ quote: 'capacity' }]), markdown, 'all');
  const tree = parseMarkdown(markdown);
  markThreads(tree, markdown, picked, { outsideLinks: true });
  const [, link, after] = tree.children[0].children;
  assert.equal(link.type, 'link');
  assert.ok(!JSON.stringify(link).includes('odRef'));
  assert.deepEqual(after, { type: 'odRef', n: 1 });
});

test('HTML export: one page with the text, marks and the picked comments', async () => {
  const markdown = `${SAMPLE}\n![logo](logo.png)\n\n<script>alert(1)</script>\n`;
  const docPath = await docWithThreads(markdown, [
    { quote: 'ship all six features', reply: 'Six is a lot.', body: 'Is <b>six</b> realistic?' },
    { quote: 'extra load', status: 'resolved' },
  ]);
  await writeFile(join(dirname(docPath), 'logo.png'), PNG);

  const none = (await exportDoc(docPath, { format: 'html', paper: 'a4' })).bytes.toString('utf8');
  assert.match(none, /^<!doctype html>/);
  assert.match(none, /<title>Q4 Launch Plan<\/title>/);
  assert.match(none, /http-equiv="Content-Security-Policy" content="script-src &#x27;none&#x27;/);
  assert.match(none, /size: A4/);
  assert.match(none, /<img src="data:image\/png;base64,/);
  assert.doesNotMatch(none.split('<body>')[1], /od-comments|od-mark/);

  const open = await exportDoc(docPath, { format: 'html', comments: 'open', paper: 'letter' });
  assert.equal(open.name, 'plan.html');
  const page = open.bytes.toString('utf8');
  assert.match(page, /size: letter/);
  assert.match(page, /<mark class="od-mark" data-comments="1">ship all six features<\/mark>/);
  assert.match(page, /Is &#x3C;b>six&#x3C;\/b> realistic\?/);
  assert.match(page, /Six is a lot\./);
  assert.equal(count(page, /class="od-comment"/g), 1);

  const all = (await exportDoc(docPath, { format: 'html', comments: 'all' })).bytes.toString('utf8');
  assert.equal(count(all, /class="od-comment( od-resolved)?"/g), 2);
  assert.match(all, /Resolved/);
});

test('Word export: the doc with each thread as a Word comment', async () => {
  const docPath = await docWithThreads(SAMPLE, [
    { quote: 'ship all six features', reply: 'Six is a lot.' },
    { quote: 'extra load', status: 'resolved' },
    { quote: null },
  ]);
  const none = unzip((await exportDoc(docPath, { format: 'docx' })).bytes);
  assert.match(none['word/document.xml'], /Q4 Launch Plan/);
  assert.match(none['word/document.xml'], /w:pStyle w:val="Heading1"/);
  assert.equal(count(none['word/comments.xml'] ?? '', /<w:comment /g), 0);

  const result = await exportDoc(docPath, { format: 'docx', comments: 'all' });
  assert.equal(result.name, 'plan.docx');
  const files = unzip(result.bytes);
  const doc = files['word/document.xml'];
  assert.equal(count(files['word/comments.xml'], /<w:comment /g), 4);
  assert.equal(count(doc, /<w:commentRangeStart /g), 4);
  assert.equal(count(doc, /<w:commentReference /g), 4);
  assert.match(doc, /Other comments/); // the thread on the whole doc
  assert.match(files['word/comments.xml'], /claude \(agent\)/);
  assert.match(files['word/commentsExtended.xml'], /w15:paraIdParent/);
  assert.match(files['word/commentsExtended.xml'], /w15:done="1"/);
});

test('export options: formats, names and paper sizes', () => {
  assert.equal(exportName('plan.md', 'pdf'), 'plan.pdf');
  assert.equal(exportName('notes.markdown', 'html'), 'notes.html');
  assert.equal(defaultPaper('en-US'), 'letter');
  assert.equal(defaultPaper('en-GB'), 'a4');
  assert.equal(defaultPaper('zh-CN'), 'a4');
  assert.deepEqual(checkExportOptions({ format: 'pdf', paper: 'a4' }), { format: 'pdf', comments: 'none', paper: 'a4', font: 'sans' });
  assert.throws(() => checkExportOptions({ format: 'rtf' }), ExportError);
  assert.throws(() => checkExportOptions({ format: 'pdf', comments: 'some' }), ExportError);
  assert.throws(() => checkExportOptions({ format: 'pdf', paper: 'a3' }), ExportError);
  assert.equal(findBrowser({ OPENDOC_BROWSER: '/opt/chrome' }), '/opt/chrome');
  assert.deepEqual(imageSize(PNG, 'image/png'), { width: 1, height: 1 });
});

test('opendoc export writes the copy next to the doc', async () => {
  const docPath = await docWithThreads(SAMPLE, [{ quote: 'extra load' }]);
  const run = async (...argv) => {
    let stdout = '';
    let stderr = '';
    const code = await main(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } }, env: {} });
    return { code, stdout, stderr };
  };
  const html = await run('export', docPath, '--to', 'html', '--comments', 'all');
  assert.equal(html.code, 0, html.stderr);
  const out = join(dirname(docPath), 'plan.html');
  assert.equal(html.stdout.trim(), `exported ${out}`);
  assert.match(await readFile(out, 'utf8'), /class="od-comment"/);

  const elsewhere = join(dirname(docPath), 'copy.html');
  const copy = await run('export', docPath, '--to', 'html', '--out', elsewhere, '--json');
  assert.equal(copy.code, 0, copy.stderr);
  assert.equal(JSON.parse(copy.stdout).out, elsewhere);
  assert.match(await readFile(elsewhere, 'utf8'), /Q4 Launch Plan/);

  const docx = await run('export', docPath, '--to', 'docx');
  assert.equal(docx.code, 0, docx.stderr);
  assert.match(unzip(await readFile(join(dirname(docPath), 'plan.docx')))['word/document.xml'], /Q4 Launch Plan/);

  assert.equal((await run('export', docPath, '--to', 'rtf')).code, 2);
  assert.equal((await run('export', docPath)).code, 2);
});
