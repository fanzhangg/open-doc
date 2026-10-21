import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, diffOps, transform } from '../src/core/ot.js';
import { lineMatches, sameEnd, sameStart } from '../src/core/diff.js';
import { DEFAULT_SETTINGS } from '../src/core/settings.js';
import { rulesOf } from '../src/rules/index.js';

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
  const host = apply(apply(text, a), transform(b, a).ops);
  assert.equal(apply(apply(text, b), transform(a, b, { first: true }).ops), host);
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

test('random concurrent edits from two pages and buddies\' turns end in the host\'s text on both', () => {
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
      for (const landed of log.slice(rev)) ops = transform(ops, landed).ops;
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
        const moved = transform(mine, ops).ops;
        ops = transform(ops, mine, { first: true }).ops;
        return moved;
      });
      page.text = apply(page.text, ops);
    };
    // A buddy's turn: an edit of the host's text as it was, landed later,
    // yielding to what landed since.
    let turn = null;
    const yieldNow = () => {
      const { ops } = transform(diffOps(turn.base, turn.edited), diffOps(turn.base, host), { yields: true, base: turn.base });
      host = apply(host, ops);
      log.push(ops);
      for (const p of pages) p.inbox.push(ops);
      turn = null;
    };
    for (let step = 0; step < 40; step++) {
      const page = pages[random(2)];
      const pick = random(3);
      if (random(10) === 0) {
        if (turn) yieldNow();
        else turn = { base: host, edited: edit(host) };
      } else if (pick === 0) {
        const next = edit(page.text);
        page.pending.push(diffOps(page.text, next));
        page.text = next;
        if (page.pending.length === 1) sent.push([page, page.pending[0], page.rev]);
      } else if (pick === 1 && sent.length) land();
      else if (page.inbox.length) receive(page);
    }
    if (turn) yieldNow();
    while (sent.length || pages.some((p) => p.inbox.length)) {
      if (sent.length) land();
      for (const page of pages) while (page.inbox.length) receive(page);
    }
    for (const page of pages) assert.equal(page.text, host, `run ${run}`);
  }
});

// `other`, an edit that yields, over `person`'s, both from `base`: the text
// and whether anything was dropped.
function yielded(base, person, other, rules = []) {
  const landed = diffOps(base, person);
  const { ops, dropped } = transform(diffOps(base, other), landed, { yields: true, base, rules });
  return { text: apply(person, ops), dropped };
}

const doc = (...lines) => lines.join('\n');
const BASE = doc('# Plan', '', 'Intro.', '', 'Middle.', '', 'End.');

test('an edit that yields lands where no one changed its lines', () => {
  const theirs = BASE.replace('Middle.', 'Middle, revised.');
  assert.deepEqual(yielded(BASE, BASE, theirs), { text: theirs, dropped: false });
  assert.deepEqual(yielded(BASE, theirs, BASE), { text: theirs, dropped: false });
  assert.deepEqual(yielded(BASE, BASE.replace('Intro.', 'Intro, typed.'), BASE.replace('End.', 'End, by the buddy.')),
    { text: doc('# Plan', '', 'Intro, typed.', '', 'Middle.', '', 'End, by the buddy.'), dropped: false }, 'different paragraphs');
  assert.deepEqual(yielded(BASE, `${BASE}\n\nA new last paragraph.`, BASE.replace('Intro.', 'Intro.\n\nAn inserted paragraph.')),
    { text: doc('# Plan', '', 'Intro.', '', 'An inserted paragraph.', '', 'Middle.', '', 'End.', '', 'A new last paragraph.'), dropped: false }, 'inserts');
  assert.deepEqual(yielded(BASE, BASE.replace('Intro.', 'Intro!'), BASE.replace('Middle.\n\n', '')),
    { text: doc('# Plan', '', 'Intro!', '', 'End.'), dropped: false }, 'a delete');
});

test('an edit that yields is dropped where the same line changed, and the rest of it lands', () => {
  assert.deepEqual(yielded(BASE, BASE.replace('Middle.', 'Mine.'), BASE.replace('Middle.', 'Theirs.')), { text: BASE.replace('Middle.', 'Mine.'), dropped: true });
  assert.deepEqual(yielded(BASE, BASE.replace('Middle.', 'Middle. A'), BASE.replace('Middle.', 'Middle. B')), { text: BASE.replace('Middle.', 'Middle. A'), dropped: true }, 'two inserts at one place');
  const ours = BASE.replace('Middle.', 'Mine.').replace('End.', 'End!');
  const theirs = BASE.replace('Middle.', 'Theirs.').replace('Intro.', 'Intro, agent.');
  assert.deepEqual(yielded(BASE, ours, theirs), { text: doc('# Plan', '', 'Intro, agent.', '', 'Mine.', '', 'End!'), dropped: true });
  const both = BASE.replace('Middle.', 'Same change.');
  assert.deepEqual(yielded(BASE, both, both), { text: both, dropped: false }, 'the same change on both sides drops nothing');
  const wrapped = doc('One', 'two', 'three');
  assert.deepEqual(yielded(wrapped, doc('One', 'TWO', 'three'), doc('One', 'two three')), { text: doc('One', 'TWO', 'three'), dropped: true }, 'a joined line changed');
});

test('an edit that yields merges by character in a line both changed apart, if every rule agrees', () => {
  const base = doc('Intro.', '', 'The plan has three steps and one risk.');
  assert.deepEqual(yielded(base, base.replace('three steps', 'four steps'), base.replace('one risk.', 'one known risk.')),
    { text: doc('Intro.', '', 'The plan has four steps and one known risk.'), dropped: false });
  assert.equal(yielded('a 😀 b', 'a 😁 b', 'a 😀 b!').text, 'a 😁 b!', 'never half a surrogate pair');
  // Taking out one `*` and adding another elsewhere would pair them into new emphasis.
  const off = { ...DEFAULT_SETTINGS, rules: { 'markdown-rule': { enabled: false } } };
  assert.deepEqual(yielded('1 *2* 3', '1 *2 3', '1 *2* 3 4*', rulesOf('plan.md', DEFAULT_SETTINGS)), { text: '1 *2 3', dropped: true });
  for (const rules of [rulesOf('plan.md', off), rulesOf('notes.txt', DEFAULT_SETTINGS)]) assert.deepEqual(yielded('1 *2* 3', '1 *2 3', '1 *2* 3 4*', rules), { text: '1 *2 3 4*', dropped: false });
  const rules = [{ mergeLine: () => true }, { mergeLine: () => false }];
  assert.deepEqual(yielded('a b', 'x b', 'a y', rules), { text: 'x b', dropped: true }, 'any rule refuses');
  assert.deepEqual(yielded('a b', 'x b', 'a y', [rules[0]]), { text: 'x y', dropped: false });
});

test('random edits: one that yields keeps every line the other changed, lands whole elsewhere, and says what it dropped', () => {
  let seed = 9;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  // Edits inside lines: each side changes a few lines by character, adding no line.
  const edit = (lines, marks) => lines.map((line) => {
    if (random(3)) return line;
    let next = line;
    for (let k = random(2); k >= 0; k--) {
      const from = random(next.length + 1);
      next = next.slice(0, from) + marks[random(marks.length)].repeat(random(3)) + next.slice(Math.min(next.length, from + random(3)));
    }
    return next;
  });
  const never = [{ mergeLine: () => false }];
  for (let run = 0; run < 3000; run++) {
    const lines = Array.from({ length: 1 + random(6) }, (_, k) => 'abcdef'.slice(random(3), 3 + random(4)) + k);
    const person = edit(lines, 'XY');
    const other = edit(lines, 'xy');
    const expected = lines.map((line, k) => (person[k] !== line ? person[k] : other[k]));
    const dropped = lines.some((line, k) => person[k] !== line && other[k] !== line && other[k] !== person[k]);
    assert.deepEqual(yielded(doc(...lines), doc(...person), doc(...other), never), { text: doc(...expected), dropped }, JSON.stringify([lines, person, other]));
  }
  // Any edits, lines added and joined too: what the person typed is all there, in order.
  for (let run = 0; run < 3000; run++) {
    const base = Array.from({ length: 1 + random(5) }, (_, k) => `ab${k}`).join('\n');
    const change = (text, marks) => {
      let next = text;
      for (let k = random(3); k >= 0; k--) {
        const from = random(next.length + 1);
        next = next.slice(0, from) + [marks[random(2)], '\n', ''][random(3)] + next.slice(Math.min(next.length, from + random(3)));
      }
      return next;
    };
    const person = change(base, 'XY');
    const { text } = yielded(base, person, change(base, 'xy'));
    assert.equal(text.replace(/[^XY]/g, ''), person.replace(/[^XY]/g, ''), JSON.stringify([base, person]));
    const unchanged = transform(diffOps(base, change(base, 'xy')), [], { yields: true, base });
    assert.equal(unchanged.dropped, false, 'nothing landed: nothing dropped');
  }
});

test('an edit in two places far apart leaves what lies between to others', () => {
  const lines = Array.from({ length: 1000 }, (_, k) => `line ${k}\n`);
  const base = lines.join('');
  const ours = diffOps(base, base.replace('line 0\n', 'line zero\n').replace('line 999\n', 'line last\n'));
  assert.ok(ours.every((op) => op.to - op.from < 20 && op.insert.length < 20), JSON.stringify(ours).slice(0, 200));
  const theirs = [{ from: base.indexOf('line 500\n'), to: base.indexOf('line 501\n'), insert: '' }];
  const merged = apply(apply(base, theirs), transform(ours, theirs).ops);
  assert.ok(!merged.includes('line 500\n') && merged.includes('line zero') && merged.includes('line last'));
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

test('lineMatches is a longest common subsequence', () => {
  let seed = 3;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const longest = (a, b) => {
    const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    return t[0][0];
  };
  for (let run = 0; run < 5000; run++) {
    const letters = 'abcd'.slice(0, 1 + random(4));
    const a = Array.from({ length: random(14) }, () => letters[random(letters.length)]);
    const b = Array.from({ length: random(14) }, () => letters[random(letters.length)]);
    const matched = lineMatches(a, b).map((j, i) => [i, j]).filter(([, j]) => j !== -1);
    assert.ok(matched.every(([i, j], k) => a[i] === b[j] && (k === 0 || j > matched[k - 1][1])), `${a} / ${b}`);
    assert.equal(matched.length, longest(a, b), `${a} / ${b}`);
  }
});

test('a change spread over a long doc diffs place by place, and soon', () => {
  const lines = Array.from({ length: 125_000 }, (_, k) => `Line ${k} of the doc, some words here.\n`);
  const base = lines.join('');
  for (const every of [50, 3]) { // a git pull touching 2% of the lines, or a third
    const text = lines.map((line, k) => (k % every ? line : line.replace('.', ' pulled.'))).join('');
    const started = performance.now();
    const ops = diffOps(base, text);
    const ms = performance.now() - started;
    assert.equal(ops.length, Math.ceil(lines.length / every));
    assert.ok(ops.every((op) => op.to === op.from && op.insert === ' pulled'));
    assert.ok(ms < 1000, `${Math.round(ms)} ms for ${base.length} characters`);
  }
});
