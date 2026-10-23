import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, diffOps, mapOffset, transform } from '../src/core/ot.js';
import { lineMatches, merge3, sameEnd, sameStart } from '../src/core/diff.js';
import { SAMPLE as SAMPLE_PLAN } from './helpers.js';
import { createClient } from '../web/client.js';

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

test('a caret follows others\' edits: after text inserted at it, at the end of text that replaced it', () => {
  const text = 'Hello world.'; // a caret after "Hello" is at 5
  const at = (ops) => mapOffset(5, ops);
  assert.equal(at([{ from: 0, to: 0, insert: '> ' }]), 7, 'an insert before');
  assert.equal(at([{ from: 11, to: 12, insert: '!' }]), 5, 'an edit after');
  assert.equal(at([{ from: 5, to: 5, insert: ',' }]), 6, 'an insert at it');
  assert.equal(at([{ from: 5, to: 11, insert: '' }]), 5, 'a deletion from it');
  assert.equal(at([{ from: 0, to: 5, insert: 'Hi' }]), 2, 'a replacement up to it');
  assert.equal(at([{ from: 2, to: 8, insert: 'y' }]), 3, 'a replacement around it');
  assert.equal(at([{ from: 0, to: 1, insert: 'J' }, { from: 6, to: 11, insert: 'there' }]), 5, 'several');
  for (const ops of [[{ from: 0, to: 0, insert: '> ' }], [{ from: 2, to: 8, insert: 'y' }]]) assert.ok(mapOffset(5, ops) <= apply(text, ops).length);
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

test('random concurrent edits from two pages and buddies\' turns end in the host\'s text on both', async () => {
  let seed = 7;
  const random = (n) => { // by the high bits: the low ones of this generator repeat every few draws
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor((seed / 2 ** 31) * n);
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
  for (let run = 0; run < 1000; run++) {
    // A host as DocService orders edits, and two pages (web/client.js) on
    // views the test types into. Calls and events wait in queues.
    const host = { text: 'ab\ncd\nef', rev: 0, log: [] };
    const sent = [];
    const land = (ops, meta = {}) => {
      host.log.push({ ops });
      host.text = apply(host.text, ops);
      const event = { epoch: 'e', rev: ++host.rev, ops, id: meta.id ?? null };
      for (const p of pages) p.inbox.push(event);
    };
    const pages = [0, 1].map(() => {
      const view = { text: host.text, getText: () => view.text, selection: () => null };
      const client = createClient({ view, call: (type, arg) => new Promise(() => sent.push(arg)), show: (text) => { view.text = text; } });
      client.start({ text: host.text, epoch: 'e', rev: 0 });
      return { view, client, inbox: [] };
    });
    const submit = () => {
      const { ops, rev, id } = sent.shift();
      let moved = ops;
      for (const landed of host.log.slice(rev)) moved = transform(moved, landed.ops);
      land(moved, { id });
    };
    let turn = null; // a buddy's: the host's text as it was, and its edit of it
    const finish = () => {
      land(diffOps(host.text, merge3(turn.base, host.text, turn.edited).text));
      turn = null;
    };
    for (let step = 0; step < 40; step++) {
      const page = pages[random(2)];
      const pick = random(4);
      if (pick === 0) {
        page.view.text = edit(page.view.text);
        page.client.flush();
      } else if (pick === 1 && sent.length) submit();
      else if (pick === 2) {
        if (turn) finish();
        else turn = { base: host.text, edited: edit(host.text) };
      } else if (page.inbox.length) page.client.receive(page.inbox.shift());
    }
    if (turn) finish();
    while (sent.length || pages.some((p) => p.inbox.length)) {
      while (sent.length) submit();
      for (const page of pages) while (page.inbox.length) page.client.receive(page.inbox.shift());
    }
    for (const page of pages) {
      assert.equal(page.view.text, host.text, `run ${run}`);
      assert.ok(page.client.idle());
    }
  }
});

const doc = (...lines) => lines.join('\n');
const BASE = doc('# Plan', '', 'Intro.', '', 'Middle.', '', 'End.');

test('merge3 takes each side\'s lines where the other did not change them', () => {
  const theirs = BASE.replace('Middle.', 'Middle, revised.');
  assert.deepEqual(merge3(BASE, BASE, theirs), { text: theirs, conflicts: 0 });
  assert.deepEqual(merge3(BASE, theirs, BASE), { text: theirs, conflicts: 0 });
  assert.deepEqual(merge3(BASE, BASE.replace('Intro.', 'Intro, typed.'), BASE.replace('End.', 'End, by the buddy.')),
    { text: doc('# Plan', '', 'Intro, typed.', '', 'Middle.', '', 'End, by the buddy.'), conflicts: 0 }, 'different paragraphs');
  assert.deepEqual(merge3(BASE, `${BASE}\n\nA new last paragraph.`, BASE.replace('Intro.', 'Intro.\n\nAn inserted paragraph.')),
    { text: doc('# Plan', '', 'Intro.', '', 'An inserted paragraph.', '', 'Middle.', '', 'End.', '', 'A new last paragraph.'), conflicts: 0 }, 'inserts');
  assert.deepEqual(merge3(BASE, BASE.replace('Intro.', 'Intro!'), BASE.replace('Middle.\n\n', '')),
    { text: doc('# Plan', '', 'Intro!', '', 'End.'), conflicts: 0 }, 'a delete');
});

test('merge3: where both changed the same lines, or put lines at one place, ours stays, the rest of theirs lands, and it counts', () => {
  assert.deepEqual(merge3(BASE, BASE.replace('Middle.', 'Mine.'), BASE.replace('Middle.', 'Theirs.')), { text: BASE.replace('Middle.', 'Mine.'), conflicts: 1 });
  assert.deepEqual(merge3(BASE, BASE.replace('Middle.', 'Middle. A'), BASE.replace('Middle.', 'Middle. B')), { text: BASE.replace('Middle.', 'Middle. A'), conflicts: 1 }, 'apart in one line is still one line');
  const ours = BASE.replace('Middle.', 'Mine.').replace('End.', 'End!');
  const theirs = BASE.replace('Middle.', 'Theirs.').replace('Intro.', 'Intro, agent.');
  assert.deepEqual(merge3(BASE, ours, theirs), { text: doc('# Plan', '', 'Intro, agent.', '', 'Mine.', '', 'End!'), conflicts: 1 });
  const both = BASE.replace('Middle.', 'Same change.');
  assert.deepEqual(merge3(BASE, both, both), { text: both, conflicts: 0 }, 'the same change on both sides is no conflict');
  assert.deepEqual(merge3(doc('a', 'b', 'c'), doc('a', 'B', 'c'), doc('a', 'b', 'C')), { text: doc('a', 'B', 'C'), conflicts: 0 }, 'lines next to each other');
  assert.deepEqual(merge3('one\n', 'one A\n', 'one\ntwo\n'), { text: 'one A\ntwo\n', conflicts: 0 }, 'a line added after one changed');
  assert.deepEqual(merge3('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n'), { text: 'a\nX\nb\n', conflicts: 1 }, 'lines put at one place');
  const wrapped = doc('One', 'two', 'three');
  assert.deepEqual(merge3(wrapped, doc('One', 'TWO', 'three'), doc('One', 'two three')), { text: doc('One', 'TWO', 'three'), conflicts: 1 }, 'a joined line changed');
});

test('an undo is the inverse of a turn, merged: each change still in place is put back; one changed since stays', () => {
  const run = SAMPLE_PLAN.replace('Q4 Launch', 'Q1 Launch').replace('week one', 'week two').replace('extra load', 'extra peak load');
  const undo = (now) => merge3(run, now, SAMPLE_PLAN).text;
  assert.equal(undo(run), SAMPLE_PLAN);
  const later = run.replace('week two', 'week three').replace('## Risks', '## Open risks');
  assert.equal(undo(later), SAMPLE_PLAN.replace('week one', 'week three').replace('## Risks', '## Open risks'), 'the touched change stays, the rest go, later edits stay');
});

test('random line edits: merge3 keeps every line ours changed, takes theirs where no change of ours is in the same run of lines, and counts the rest', () => {
  let seed = 9;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor((seed / 2 ** 31) * n);
  };
  const edit = (lines, mark) => lines.map((line) => (random(3) ? line : `${line}${mark.repeat(1 + random(2))}`));
  // The runs of lines `side` changed: [from, to).
  const runs = (lines, side) => lines.reduce((out, line, k) => {
    if (side[k] === line) return out;
    if (out.at(-1)?.[1] === k) out.at(-1)[1] = k + 1;
    else out.push([k, k + 1]);
    return out;
  }, []);
  for (let run = 0; run < 3000; run++) {
    const lines = Array.from({ length: 1 + random(8) }, (_, k) => `line ${k}`);
    const ours = edit(lines, 'X');
    const theirs = edit(lines, 'Y');
    // Clusters of runs that share lines, as merge3 makes them.
    const hunks = [...runs(lines, ours).map((r) => [...r, 0]), ...runs(lines, theirs).map((r) => [...r, 1])].sort((a, b) => a[0] - b[0]);
    const clusters = [];
    for (const [from, to, side] of hunks) {
      const last = clusters.at(-1);
      if (last && from < last.to) {
        last.to = Math.max(last.to, to);
        last.sides.add(side);
      } else clusters.push({ from, to, sides: new Set([side]) });
    }
    const expected = lines.map((line, k) => {
      const cluster = clusters.find((c) => c.from <= k && k < c.to);
      return !cluster ? line : cluster.sides.has(0) ? ours[k] : theirs[k];
    });
    const conflicts = clusters.filter((c) => c.sides.size === 2).length;
    // Lines end in newlines, so a last line changed is a line like any other.
    const nl = (list) => list.map((l) => `${l}\n`).join('');
    assert.deepEqual(merge3(nl(lines), nl(ours), nl(theirs)), { text: nl(expected), conflicts }, JSON.stringify([lines, ours, theirs]));
  }
});

test('an edit in two places far apart leaves what lies between to others', () => {
  const lines = Array.from({ length: 1000 }, (_, k) => `line ${k}\n`);
  const base = lines.join('');
  const ours = diffOps(base, base.replace('line 0\n', 'line zero\n').replace('line 999\n', 'line last\n'));
  assert.ok(ours.every((op) => op.to - op.from < 20 && op.insert.length < 20), JSON.stringify(ours).slice(0, 200));
  const theirs = [{ from: base.indexOf('line 500\n'), to: base.indexOf('line 501\n'), insert: '' }];
  const both = apply(apply(base, theirs), transform(ours, theirs));
  assert.ok(!both.includes('line 500\n') && both.includes('line zero') && both.includes('line last'));
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
