import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../src/core/project.js';
import {
  AnchorError, createAnchor, findQuote, locate, reanchorThreads, refreshSidecar,
} from '../src/core/anchor.js';

const BASE = `# Q4 Launch Plan

We plan to **ship all six features** in week one, then gather feedback from the
beta cohort before the public release.

## Goals

- Grow weekly active users by 20%
- Reduce onboarding time to *under five minutes*

## Risks

The main risk is that the \`sync\` service cannot handle the extra load.
See the [capacity doc](./capacity.md) for details.
`;

// Anchor `quote` in `before`, then return what it re-finds in `after`
// (the matched text), or null when it detaches.
function follow(before, quote, after, options) {
  const oldText = project(before).text;
  const range = findQuote(oldText, quote, options);
  const anchor = createAnchor(oldText, range.start, range.end);
  const newText = project(after).text;
  const found = locate(newText, anchor);
  return found && { text: newText.slice(found.start, found.end), method: found.method };
}

test('createAnchor takes up to 32 characters of context', () => {
  const text = 'x'.repeat(40) + 'QUOTE' + 'y'.repeat(40);
  const anchor = createAnchor(text, 40, 45);
  assert.deepEqual(anchor, { exact: 'QUOTE', prefix: 'x'.repeat(32), suffix: 'y'.repeat(32), start: 40 });
  assert.throws(() => createAnchor(text, 5, 5), RangeError);
  assert.throws(() => createAnchor(text, 80, 90), RangeError);
});

test('unchanged doc: exact match at the same place', () => {
  assert.deepEqual(follow(BASE, 'ship all six features', BASE), { text: 'ship all six features', method: 'exact' });
});

test('acceptance: rewording inside the quote keeps the thread attached', () => {
  const after = BASE.replace('extra load', 'additional load');
  assert.equal(follow(BASE, 'cannot handle the extra load', after).text, 'cannot handle the additional load');
});

test('fuzzy match covers rewording when the context is too short to bracket', () => {
  const before = 'The sync service cannot handle the extra load.\n';
  const after = before.replace('extra load', 'additional load');
  assert.deepEqual(
    follow(before, 'cannot handle the extra load', after),
    { text: 'cannot handle the additional load', method: 'fuzzy' },
  );
});

test('words inserted into the quote are included (context bracket)', () => {
  const after = BASE.replace('in week one', 'in the first week of the quarter');
  assert.deepEqual(
    follow(BASE, 'in week one', after),
    { text: 'in the first week of the quarter', method: 'bracket' },
  );
});

test('a typo fix inside the quote is followed', () => {
  const before = BASE.replace('gather feedback', 'gahter feedback');
  const found = follow(before, 'then gahter feedback from the', BASE);
  assert.equal(found.text, 'then gather feedback from the');
});

test('text inserted before the quote shifts it', () => {
  const after = BASE.replace('## Goals', 'A new paragraph about scope.\n\n## Goals');
  assert.equal(follow(BASE, 'Reduce onboarding time', after).text, 'Reduce onboarding time');
});

test('a paragraph moved elsewhere is followed', () => {
  const para = 'The main risk is that the `sync` service cannot handle the extra load.\nSee the [capacity doc](./capacity.md) for details.\n';
  const after = BASE.replace(para, '').replace('## Goals', para + '\n## Goals');
  assert.equal(follow(BASE, 'cannot handle the extra load', after).text, 'cannot handle the extra load');
});

test('formatting added around the quote does not break it', () => {
  const after = BASE.replace('Reduce onboarding time', 'Reduce **onboarding** time');
  assert.equal(follow(BASE, 'Reduce onboarding time', after).text, 'Reduce onboarding time');
});

test('duplicate phrase: context picks the right occurrence', () => {
  const doc = 'Alpha says ship it now.\n\nBeta says ship it now.\n';
  const text = project(doc).text;
  const range = findQuote(text, 'ship it now', { occurrence: 1 });
  const anchor = createAnchor(text, range.start, range.end);
  const after = 'Intro line.\n\n' + doc;
  const newText = project(after).text;
  const found = locate(newText, anchor);
  assert.equal(newText.slice(found.start - 'Beta says '.length, found.end), 'Beta says ship it now');
});

test('a deleted quote detaches', () => {
  const after = BASE.replace('- Grow weekly active users by 20%\n', '');
  assert.equal(follow(BASE, 'Grow weekly active users by 20%', after), null);
});

test('a deleted short quote does not jump to an unrelated copy', () => {
  const before = 'Our target is 20% growth this year.\n\nUnrelated: the fee is 20% of revenue for partners.\n';
  const after = 'Unrelated: the fee is 20% of revenue for partners.\n';
  assert.equal(follow(before, '20%', after, { occurrence: 0 }), null);
});

test('a replaced short quote follows its replacement', () => {
  const before = 'Our target is 20% growth this year.\n';
  const after = 'Our target is modest growth this year.\n';
  assert.deepEqual(follow(before, '20%', after), { text: 'modest', method: 'bracket' });
});

test('a short quote that stays in place is kept', () => {
  const after = BASE.replace('by 20%', 'by 20% (stretch goal)');
  assert.equal(follow(BASE, '20%', after).text, '20%');
});

test('a heavily rewritten passage detaches instead of guessing', () => {
  const after = BASE.replace('The main risk is that the `sync` service cannot handle the extra load.', 'Load is not a concern after the migration.');
  assert.equal(follow(BASE, 'cannot handle the extra load', after), null);
});

test('findQuote: markdown in the quote, whitespace, ambiguity, missing', () => {
  const text = project(BASE).text;
  assert.equal(text.slice(...Object.values(findQuote(text, 'ship **all six** features'))), 'ship all six features');
  assert.equal(text.slice(...Object.values(findQuote(text, 'feedback   from the\n beta'))), 'feedback from the beta');
  assert.throws(() => findQuote(text, 'the'), (e) => e instanceof AnchorError && e.code === 'ambiguous' && e.count > 1);
  assert.throws(() => findQuote(text, 'not in the doc'), (e) => e instanceof AnchorError && e.code === 'not_found');
  assert.throws(() => findQuote(text, 'Risks', { occurrence: 3 }), (e) => e.code === 'not_found');
});

test('reanchorThreads: updates, detaches, re-attaches, keeps unknown fields, deterministic', () => {
  const text = project(BASE).text;
  const anchorFor = (q) => { const r = findQuote(text, q); return createAnchor(text, r.start, r.end); };
  const threads = [
    { id: 't_aaaaaa', anchor: anchorFor('extra load'), detached: false, 'x-acme': { keep: true } },
    { id: 't_bbbbbb', anchor: anchorFor('Grow weekly active users by 20%'), detached: false },
    { id: 't_cccccc', anchor: null, detached: false },
  ];
  const edited = project(BASE.replace('extra load', 'extra peak load').replace('- Grow weekly active users by 20%\n', '')).text;

  const first = reanchorThreads(edited, threads);
  assert.equal(first.changed, true);
  assert.equal(first.threads[0].detached, false);
  assert.equal(first.threads[0].anchor.exact, 'extra peak load');
  assert.deepEqual(first.threads[0]['x-acme'], { keep: true });
  assert.equal(first.threads[1].detached, true);
  assert.deepEqual(first.threads[1].anchor, threads[1].anchor, 'detached threads keep their last anchor');
  assert.equal(first.threads[2], threads[2], 'doc-level threads are untouched');

  const again = reanchorThreads(edited, first.threads);
  assert.equal(again.changed, false);
  assert.deepEqual(again.threads, first.threads);

  const restored = reanchorThreads(text, first.threads);
  assert.equal(restored.threads[1].detached, false, 'text that comes back re-attaches');
});

test('refreshSidecar skips work when docHash matches', () => {
  const sidecar = { opendoc: 1, doc: 'plan.md', docHash: 'sha256:aa', participants: [], threads: [] };
  assert.equal(refreshSidecar(sidecar, BASE, 'sha256:aa'), sidecar);
  const next = refreshSidecar(sidecar, BASE, 'sha256:bb');
  assert.equal(next.docHash, 'sha256:bb');
  assert.notEqual(next, sidecar);
});

test('performance: 100 KB doc with 200 threads re-anchors quickly', () => {
  const paragraphs = Array.from({ length: 700 }, (_, i) =>
    `Paragraph ${i} discusses milestone ${i * 7} and the risk register entry R-${i}, owned by team ${i % 9}, with notes on scope, budget and timeline for item ${i}.`);
  const doc = paragraphs.join('\n\n') + '\n';
  const text = project(doc).text;
  const threads = Array.from({ length: 200 }, (_, i) => {
    const r = findQuote(text, `risk register entry R-${i * 2},`);
    return { id: `t_perf${String(i).padStart(4, '0')}`, anchor: createAnchor(text, r.start, r.end), detached: false };
  });
  // Edit the context around every quote and the quote itself, so every thread
  // takes the fuzzy path.
  const edited = project(doc
    .replace(/milestone (\d+)/g, 'milestone #$1')
    .replace(/risk register entry/g, 'risk-register entry')).text;

  const started = performance.now();
  const { threads: next } = reanchorThreads(edited, threads);
  const elapsed = performance.now() - started;

  assert.ok(doc.length > 100_000);
  assert.equal(next.filter((t) => t.detached).length, 0);
  assert.ok(next.every((t, i) => t.anchor.exact === `risk-register entry R-${i * 2},`));
  assert.ok(elapsed < 1000, `re-anchoring took ${elapsed.toFixed(0)} ms`);
  console.log(`  re-anchored 200 threads in a ${(doc.length / 1024).toFixed(0)} KB doc: ${elapsed.toFixed(1)} ms`);
});
