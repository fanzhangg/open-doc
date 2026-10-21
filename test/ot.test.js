import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, diffOps, transform } from '../src/core/ot.js';
import { sameEnd, sameStart } from '../src/core/diff.js';

test('diffOps is trimmed to the edit, and apply makes the text', () => {
  assert.deepEqual(diffOps('Hello world.', 'Hello, world.'), [{ from: 5, to: 5, insert: ',' }]);
  assert.deepEqual(diffOps('aaa', 'aa'), [{ from: 2, to: 3, insert: '' }]);
  assert.deepEqual(diffOps('same', 'same'), []);
  assert.deepEqual(diffOps('a😀b', 'a😃b'), [{ from: 1, to: 3, insert: '😃' }], 'never half a surrogate pair');
  assert.deepEqual(diffOps('Some __x__ y.', 'Some **x** yz.'), [{ from: 5, to: 7, insert: '**' }, { from: 8, to: 10, insert: '**' }, { from: 12, to: 12, insert: 'z' }], 'by character');
  for (const [a, b] of [['', 'x'], ['x', ''], ['abcabc', 'abc'], ['Some __x__.', 'Some **xy**.']]) assert.equal(apply(a, diffOps(a, b)), b);
  const deleted = 'First. The second goes here. Third.';
  assert.deepEqual(diffOps(deleted, 'First. Third.'), [{ from: 9, to: 31, insert: '' }], 'without the caret, after the repeated "Th"');
  assert.deepEqual(diffOps(deleted, 'First. Third.', 7), [{ from: 7, to: 29, insert: '' }], 'at the caret: the sentence itself');
  for (const caret of [0, 3, 7, 13]) assert.equal(apply(deleted, diffOps(deleted, 'First. Third.', caret)), 'First. Third.');
});

// Both edits on `text`; `a` reached the host first. Each side ends in one text.
function merge(text, a, b) {
  const host = apply(apply(text, a), transform(b, a));
  assert.equal(apply(apply(text, b), transform(a, b, { first: true })), host);
  return host;
}

test('two people merge by character and lose nothing', () => {
  const text = 'One two three.';
  assert.equal(merge(text, diffOps(text, 'One, two three.'), diffOps(text, 'One two three!')), 'One, two three!', 'apart');
  assert.equal(merge(text, diffOps(text, 'One Xtwo three.'), diffOps(text, 'One Ytwo three.')), 'One XYtwo three.', 'at one place, first to land first');
  assert.equal(merge(text, diffOps(text, 'One.'), diffOps(text, 'One twoX three.')), 'OneX.', 'typed inside a deleted range stays');
  assert.equal(merge(text, diffOps(text, 'One three.'), diffOps(text, 'One three.')), 'One three.', 'deleted by both, deleted once');
  const styled = '* Some __bold__ words.';
  assert.equal(merge(styled, diffOps(styled, '- Some **bold** wordsA.'), diffOps(styled, '- Some **bold** Bwords.')), '- Some **bold** BwordsA.', 'restyled by both, restyled once');
});

test('random concurrent edits from two pages end in the host\'s text on both', () => {
  let seed = 7;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const edit = (text) => {
    let next = text;
    for (let k = random(3); k >= 0; k--) {
      const from = random(next.length + 1);
      const to = Math.min(next.length, from + random(4));
      next = next.slice(0, from) + 'xyz\n'.slice(random(4)) + next.slice(to);
    }
    return random(3) ? next : next.replaceAll('xy', '_y'); // as a restyle does
  };
  for (let run = 0; run < 2000; run++) {
    // The host's log, and two pages, each with its text, rev and pending
    // edits (the first sent, the rest waiting for it), and what the host sent it.
    let host = 'ab\ncd\nef';
    const log = [];
    const pages = [0, 1].map(() => ({ text: host, rev: 0, pending: [], inbox: [] }));
    const sent = []; // [page, ops, rev] on their way to the host
    const land = () => {
      let [from, ops, rev] = sent.shift();
      for (const landed of log.slice(rev)) ops = transform(ops, landed);
      host = apply(host, ops);
      log.push(ops);
      for (const p of pages) p.inbox.push(p === from ? null : ops);
    };
    const receive = (page) => {
      let ops = page.inbox.shift();
      page.rev++;
      if (ops === null) { // its own, landed
        page.pending.shift();
        if (page.pending.length) sent.push([page, page.pending[0], page.rev]);
        return;
      }
      page.pending = page.pending.map((mine) => {
        const moved = transform(mine, ops);
        ops = transform(ops, mine, { first: true });
        return moved;
      });
      page.text = apply(page.text, ops);
    };
    for (let step = 0; step < 40; step++) {
      const page = pages[random(2)];
      const pick = random(3);
      if (pick === 0) {
        const next = edit(page.text);
        page.pending.push(diffOps(page.text, next));
        page.text = next;
        if (page.pending.length === 1) sent.push([page, page.pending[0], page.rev]);
      } else if (pick === 1 && sent.length) land();
      else if (page.inbox.length) receive(page);
    }
    while (sent.length || pages.some((p) => p.inbox.length)) {
      if (sent.length) land();
      for (const page of pages) while (page.inbox.length) receive(page);
    }
    for (const page of pages) assert.equal(page.text, host, `run ${run}`);
  }
});

test('sameStart and sameEnd find what two texts share, past whole chunks too', () => {
  const long = 'abcdefghij'.repeat(500);
  for (const at of [0, 1, 1023, 1024, 1025, 2500, 4999]) {
    const changed = `${long.slice(0, at)}X${long.slice(at + 1)}`;
    assert.equal(sameStart(long, changed), at);
    assert.equal(sameEnd(long, changed), long.length - at - 1);
  }
  assert.equal(sameStart(long, long, 7), 7, 'at most max');
  assert.equal(sameEnd('xyz', 'yz'), 2);
});
