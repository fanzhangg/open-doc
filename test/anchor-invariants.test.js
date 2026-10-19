// What re-finding an anchor (SPEC.md §3.2) must always do, checked on
// generated docs and edits as well as on the cases that once broke it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnchor, locate } from '../src/core/anchor.js';

const WORDS = ('the cache layer sync service load beta cohort release plan risk week users time ship feature '
  + 'docs owner review draft budget scope vendor launch metric goal team notes build test deploy').split(' ');

// Small seeded generator, so a failure names a case that can be run again.
function generator(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);
  const sentence = () => {
    const words = Array.from({ length: 4 + int(8) }, () => WORDS[int(WORDS.length)]);
    return words.join(' ') + '.';
  };
  const doc = (n) => Array.from({ length: n }, () => Array.from({ length: 1 + int(3) }, sentence).join(' ')).join('\n');
  return { int, sentence, doc };
}

// A word-aligned range of `text`: [start, end).
function wordRange(text, int, words) {
  const starts = [...text.matchAll(/\S+/g)].map((m) => m.index);
  const first = int(Math.max(1, starts.length - words));
  const start = starts[first];
  const last = text.slice(start).split(/\s+/).slice(0, words).join(' ');
  return { start, end: start + last.length };
}

const RUNS = 200;

test('an unchanged doc finds every anchor where it was', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const g = generator(seed);
    const text = g.doc(6);
    const { start, end } = wordRange(text, g.int, 1 + g.int(4));
    const found = locate(text, createAnchor(text, start, end));
    assert.deepEqual({ start: found?.start, end: found?.end }, { start, end }, `seed ${seed}`);
  }
});

test('an edit away from the anchor and its context moves it with the text, short quotes included', () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const g = generator(seed);
    const text = g.doc(6);
    const { start, end } = wordRange(text, g.int, 1 + g.int(3));
    const anchor = createAnchor(text, start, end);
    // Insert or delete a sentence at least 40 characters outside the anchor's context.
    const before = start - anchor.prefix.length - 40;
    const after = end + anchor.suffix.length + 40;
    const atStart = before > 0 && (after >= text.length || g.int(2) === 0);
    if (!atStart && after >= text.length) continue;
    const at = atStart ? text.lastIndexOf(' ', g.int(before)) + 1 : text.indexOf(' ', after + g.int(text.length - after)) + 1;
    if (at <= 0) continue;
    const insert = g.int(2) === 0;
    const removed = insert ? 0 : Math.min(text.indexOf(' ', at + 10) - at + 1, atStart ? before - at : text.length - at);
    if (!insert && removed <= 0) continue;
    const added = insert ? `${g.sentence()} ` : '';
    const edited = text.slice(0, at) + added + text.slice(at + removed);
    const shift = atStart ? added.length - removed : 0;
    const found = locate(edited, anchor);
    assert.deepEqual(
      { start: found?.start, end: found?.end },
      { start: start + shift, end: end + shift },
      `seed ${seed}: "${anchor.exact}"`,
    );
  }
});

test('a deleted short quote does not jump to an unrelated copy elsewhere', () => {
  // "cache" (5 characters) and "CDN" (3) each appear again later, in other sentences.
  const before = 'The cache layer is slow and needs work.\nLater sections talk about an unrelated cache in the build system.';
  const after = 'Later sections talk about an unrelated cache in the build system.';
  assert.equal(locate(after, createAnchor(before, 4, 9)), null);
  const cdn = 'The CDN is slow.\nUse a CDN in the build.';
  assert.equal(locate('Use a CDN in the build.', createAnchor(cdn, 4, 7)), null);
});

test('a short quote follows its own sentence when text around it changes a little', () => {
  const before = 'Intro line here.\nThe cache layer is slow and needs work.\nLater we mention cache again in a list.';
  const anchor = createAnchor(before, before.indexOf('cache'), before.indexOf('cache') + 5);
  const after = 'Intro line here.\nThe cache layer is quite slow and needs work.\nLater we mention cache again in a list.';
  const found = locate(after, anchor);
  assert.equal(found?.start, after.indexOf('cache'));
});

test('a long quote whose sentence was deleted may still move to an exact copy (SPEC §3.2 step 1)', () => {
  const before = 'Opening words.\nWe need the capacity doc first.\nFooter: see the capacity doc for details.';
  const anchor = createAnchor(before, before.indexOf('capacity doc'), before.indexOf('capacity doc') + 12);
  const after = 'Opening words.\nFooter: see the capacity doc for details.';
  assert.equal(locate(after, anchor)?.start, after.indexOf('capacity doc'));
});
