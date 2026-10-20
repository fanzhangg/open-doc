import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locate } from '../src/core/anchor.js';

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

// Anchor `quote` (its `occurrence`, 0 by default) in the doc text `before`,
// then return what it re-finds in `after` (the matched text), or null when
// it detaches.
function follow(before, quote, after, { occurrence = 0 } = {}) {
  let start = before.indexOf(quote);
  for (let i = 0; i < occurrence; i++) start = before.indexOf(quote, start + 1);
  assert.ok(start >= 0, `"${quote}" is not in the doc`);
  const anchor = createAnchor(before, start, start + quote.length);
  const found = locate(after, anchor);
  return found && { text: after.slice(found.start, found.end), method: found.method };
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

test('text typed after an edited quote stays out of it (context bracket)', () => {
  const quote = 'then gather feedback from the\nbeta cohort';
  const after = BASE.replace(quote, 'then quickly gather feedback from the\nbeta cohort').replace('cohort before', 'cohortss before');
  assert.deepEqual(follow(BASE, quote, after), { text: 'then quickly gather feedback from the\nbeta cohort', method: 'bracket' });
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

test('formatting added inside the quote is followed, marks included', () => {
  const after = BASE.replace('Reduce onboarding time', 'Reduce **onboarding** time');
  assert.equal(follow(BASE, 'Reduce onboarding time', after).text, 'Reduce **onboarding** time');
});

test('duplicate phrase: context picks the right occurrence', () => {
  const doc = 'Alpha says ship it now.\n\nBeta says ship it now.\n';
  const start = doc.lastIndexOf('ship it now');
  const anchor = createAnchor(doc, start, start + 'ship it now'.length);
  const after = 'Intro line.\n\n' + doc;
  const found = locate(after, anchor);
  assert.equal(after.slice(found.start - 'Beta says '.length, found.end), 'Beta says ship it now');
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

test('performance: 200 anchors are found again in a 100 KB doc quickly', () => {
  const paragraphs = Array.from({ length: 700 }, (_, i) =>
    `Paragraph ${i} discusses milestone ${i * 7} and the risk register entry R-${i}, owned by team ${i % 9}, with notes on scope, budget and timeline for item ${i}.`);
  const doc = paragraphs.join('\n\n') + '\n';
  const threads = Array.from({ length: 200 }, (_, i) => {
    const quote = `risk register entry R-${i * 2},`;
    const start = doc.indexOf(quote);
    return createAnchor(doc, start, start + quote.length);
  });
  // Edit the context around every quote and the quote itself, so every thread
  // takes the fuzzy path.
  const edited = doc
    .replace(/milestone (\d+)/g, 'milestone #$1')
    .replace(/risk register entry/g, 'risk-register entry');

  const started = performance.now();
  const found = threads.map((anchor) => locate(edited, anchor));
  const elapsed = performance.now() - started;

  assert.ok(doc.length > 100_000);
  assert.ok(found.every((f, i) => f && edited.slice(f.start, f.end) === `risk-register entry R-${i * 2},`));
  assert.ok(elapsed < 1000, `finding the anchors took ${elapsed.toFixed(0)} ms`);
  console.log(`  found 200 anchors in a ${(doc.length / 1024).toFixed(0)} KB doc: ${elapsed.toFixed(1)} ms`);
});
