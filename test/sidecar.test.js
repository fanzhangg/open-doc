// The version 2 sidecar (spec/SPEC.md): conformance fixtures
// (spec/conformance/sidecar.json), any order or duplication of lines
// reading to the same threads, and writing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askedOf, parseSidecar, peopleOf, serializeSidecar, threadsOf } from '../src/core/comments.js';
import { parseMentions } from '../src/core/mentions.js';

const { reading, mentions } = JSON.parse(readFileSync(new URL('../spec/conformance/sidecar.json', import.meta.url), 'utf8'));
const read = (lines) => parseSidecar(lines.join('\n') + '\n');
const comments = (parsed) => parsed.lines.map((l) => l.comment).filter(Boolean);
const shape = (threads) => threads.map((t) => ({ id: t.id, resolved: t.resolved, comments: t.comments.map((c) => c.id) }));

for (const c of reading) {
  test(`reading: ${c.name}`, () => {
    const parsed = read(c.sidecar);
    assert.deepEqual(shape(threadsOf(comments(parsed))), c.threads);
    assert.deepEqual(parsed.bad.map((b) => b.line), c.bad);
    for (const [id, body] of Object.entries(c.bodies ?? {})) assert.equal(comments(parsed).find((x) => x.id === id).body, body);
  });
}

for (const m of mentions) {
  test(`mentions: ${m.body}`, () => {
    assert.deepEqual(parseMentions(m.body, m.names), m.mentions);
  });
}

// A small seeded PRNG, so a failure can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('any order or duplication of lines reads to the same threads (what makes merge=union safe)', () => {
  const random = rng(42);
  for (const c of reading.filter((r) => !r.bodies)) {
    const [header, ...body] = c.sidecar;
    const expected = shape(threadsOf(comments(read(c.sidecar))));
    for (let round = 0; round < 50; round++) {
      const lines = body.flatMap((l) => (random() < 0.3 ? [l, l] : [l])); // a union merge may keep a line twice
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [lines[i], lines[j]] = [lines[j], lines[i]];
      }
      assert.deepEqual(shape(threadsOf(comments(read([header, ...lines])))), expected, `${c.name}, round ${round}`);
    }
  }
});

test('a version this tool does not know, or no header, is a problem; the lines are still read', () => {
  assert.equal(parseSidecar('{"opendoc":2}\n').problem, null);
  assert.equal(parseSidecar('{"opendoc":3}\n').problem, 'version');
  assert.equal(parseSidecar('{\n  "opendoc": 1,\n  "doc": "plan.md",\n  "threads": []\n}\n').problem, 'invalid');
  assert.equal(parseSidecar('').problem, 'invalid');
});

test('writing: the whole file, bad lines kept as they are, unknown fields kept, a duplicate written once', () => {
  const bad = reading.find((r) => r.name.startsWith('bad lines'));
  const dupe = reading.find((r) => r.name.startsWith('the first of two'));
  assert.equal(serializeSidecar(read(bad.sidecar).lines), bad.sidecar.join('\n') + '\n', 'byte for byte');
  assert.equal(serializeSidecar(read(dupe.sidecar).lines), dupe.sidecar.slice(0, 2).join('\n') + '\n');
  const added = [...read(bad.sidecar).lines, { comment: { id: 'c_added001', by: { id: 'u_alice01', name: 'alice', kind: 'human' }, at: '2026-10-03T00:00:00Z', body: 'New' } }];
  const again = read(serializeSidecar(added).trimEnd().split('\n'));
  assert.deepEqual(comments(again).map((c) => c.id), ['c_extra001', 'c_added001']);
  assert.deepEqual(comments(again)[0].future, { x: 1 });
});

test('who is asked: whom my comment @mentions, or with no mention the thread\'s buddies, until each replies; another user\'s comment asks no one', () => {
  const by = (id, name, kind = 'human') => ({ id, name, kind });
  const me = by('u_me000001', 'me');
  const other = by('u_other001', 'other');
  const clippy = by('Clippy', 'Clippy', 'ai');
  const thread = (...list) => threadsOf(list.map(([who, body, extra = {}], i) => ({ id: i === 0 ? 'c_thread01' : `c_reply0${i}`, ...(i ? { thread: 'c_thread01' } : {}), by: who, at: `2026-10-01T10:0${i}:00Z`, body, ...extra })), ['Clippy', 'Ada'])[0];
  assert.deepEqual(askedOf(thread([me, '@Clippy look']), 'u_me000001'), ['Clippy']);
  assert.deepEqual(askedOf(thread([me, '@clippy look'], [me, 'and this too']), 'u_me000001'), ['Clippy'], 'a later comment of mine without a mention still waits');
  assert.deepEqual(askedOf(thread([me, '@Clippy look'], [clippy, 'Done. @Ada?']), 'u_me000001'), [], "answered; a buddy's @mention asks no one");
  assert.deepEqual(askedOf(thread([me, '@Clippy look'], [clippy, 'Done.'], [me, '@Clippy again']), 'u_me000001'), ['Clippy']);
  assert.deepEqual(askedOf(thread([other, '@Clippy look']), 'u_me000001'), [], 'only my comments start runs');
  assert.deepEqual(askedOf(thread([me, 'no one']), 'u_me000001'), []);
  assert.deepEqual(askedOf(thread([me, '@Clippy @Ada'], [clippy, 'Mine']), 'u_me000001'), ['Ada']);
  assert.deepEqual(askedOf(thread([me, '@Clippy look'], [me, '', { resolved: true }]), 'u_me000001'), [], 'a resolved thread asks no one');
  assert.deepEqual(askedOf(thread([me, '@Clippy look'], [clippy, 'Done.'], [me, '', { resolved: true }], [me, '']), 'u_me000001'), [], 'reopening asks no one');
  assert.equal(thread([me, '@Clippy look'], [me, '', { resolved: true }], [clippy, 'Late.']).resolved, true, "a buddy's comment does not reopen");
  const ada = by('Ada', 'Ada', 'ai');
  assert.deepEqual(askedOf(thread([me, '@Clippy look'], [clippy, 'Done.'], [me, 'and now this']), 'u_me000001'), ['Clippy'], 'a follow-up with no mention asks the thread\'s buddies');
  assert.deepEqual(askedOf(thread([me, '@Clippy @Ada look'], [clippy, 'A'], [ada, 'B'], [me, '@Ada only you']), 'u_me000001'), ['Ada'], 'a mention asks only whom it names');
  assert.deepEqual(askedOf(thread([me, '@Clippy @Ada look'], [clippy, 'A'], [ada, 'B'], [me, '@Ada only you'], [ada, 'C'], [me, 'both again']), 'u_me000001'), ['Clippy', 'Ada']);
  assert.deepEqual(askedOf(thread([ada, 'This is stale.'], [me, 'Update it']), 'u_me000001'), ['Ada'], 'the buddy that opened the thread is one of its buddies');
  assert.deepEqual(askedOf(thread([me, '@Clippy look'], [clippy, 'Done.'], [other, 'and this']), 'u_me000001'), [], "another user's follow-up asks no one");
  assert.deepEqual(peopleOf([...thread([me, 'a'], [{ ...me, name: 'me2' }, 'b']).comments]), [{ id: 'u_me000001', name: 'me2' }], 'a human goes by the name in their latest comment');
});
