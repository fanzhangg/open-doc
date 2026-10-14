import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptySidecar, newId, OpError } from '../src/core/ops.js';
import { parseMentions } from '../src/core/mentions.js';
import { inbox } from '../src/core/inbox.js';

const human = { name: 'fzhan', kind: 'human' };
const claude = { name: 'claude', kind: 'agent' };
const at = '2026-10-14T18:00:00.000Z';
const msg = (author, body, id = newId('m')) => ({ id, author, body, createdAt: at });

function withAgents(...agents) {
  return agents.reduce((s, a) => applyOp(s, { type: 'join', participant: a }), emptySidecar('plan.md'));
}

test('newId has the spec shape', () => {
  assert.match(newId('t'), /^t_[a-z0-9]{10}$/);
  assert.match(newId('m'), /^m_[a-z0-9]{10}$/);
});

test('mentions: participants only, case-insensitive, canonical, once, punctuation-tolerant', () => {
  const participants = [claude, { name: 'Alex.R', kind: 'human' }];
  assert.deepEqual(parseMentions('@Claude and @alex.r, then @claude again.', participants), ['claude', 'Alex.R']);
  assert.deepEqual(parseMentions('thanks @claude.', participants), ['claude']);
  assert.deepEqual(parseMentions('mail me at x@claude.dev or @nobody', participants), []);
});

test('addThread joins the author and records mentions', () => {
  const s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude look') });
  assert.deepEqual(s.participants.map((p) => p.name), ['claude', 'fzhan']);
  assert.deepEqual(s.threads[0].messages[0].mentions, ['claude']);
  assert.equal(s.threads[0].status, 'open');
  assert.equal(s.threads[0].detached, false);
});

test('operations are idempotent by id', () => {
  const m = msg(human, 'hi', 'm_fixed1');
  const once = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: m });
  assert.equal(applyOp(once, { type: 'addThread', id: 't_aaaaaa', anchor: null, message: m }), once);
  const reply = msg(claude, 'yo', 'm_fixed2');
  const twice = applyOp(once, { type: 'addMessage', threadId: 't_aaaaaa', message: reply });
  assert.equal(applyOp(twice, { type: 'addMessage', threadId: 't_aaaaaa', message: reply }), twice);
  const resolved = applyOp(twice, { type: 'resolve', threadId: 't_aaaaaa', by: 'claude', at });
  assert.equal(applyOp(resolved, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at }), resolved);
  assert.equal(resolved.threads[0].resolvedBy, 'claude');
});

test('a reply reopens a resolved thread; the agent reply clears its working flag', () => {
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude?') });
  s = applyOp(s, { type: 'setWorking', threadId: 't_aaaaaa', by: 'claude', since: new Date().toISOString() });
  assert.equal(s.threads[0].working.by, 'claude');
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'Done.') });
  assert.equal(s.threads[0].working, null);
  s = applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'claude', at });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(human, 'Not quite') });
  assert.equal(s.threads[0].status, 'open');
  assert.equal(s.threads[0].resolvedBy, null);
  s = applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at });
  s = applyOp(s, { type: 'reopen', threadId: 't_aaaaaa' });
  assert.equal(s.threads[0].status, 'open');
});

test('bad input is refused', () => {
  const s = withAgents(claude);
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_missing', message: msg(human, 'x') }), (e) => e instanceof OpError && e.code === 'unknown_thread');
  assert.throws(() => applyOp(s, { type: 'join', participant: { name: '@bad', kind: 'agent' } }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'join', participant: { name: 'bot', kind: 'robot' } }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'addThread', id: 't_bbbbbb', anchor: null, message: msg(human, '   ') }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'nope' }), (e) => e.code === 'bad_input');
});

test('inbox: addressed to me or to no one, from a human, open, not already mine', () => {
  const alex = { name: 'alex', kind: 'human' };
  let s = withAgents(claude, alex);
  const add = (id, author, body) => { s = applyOp(s, { type: 'addThread', id, anchor: null, message: msg(author, body) }); };
  add('t_tome01', human, '@claude please check');
  add('t_noone1', human, 'This section is weak');
  add('t_other1', human, '@alex can you confirm?');
  add('t_both01', human, '@alex @claude thoughts?');
  add('t_agent1', claude, 'I have a question for you');
  add('t_done01', human, '@claude fixed?');
  s = applyOp(s, { type: 'resolve', threadId: 't_done01', by: 'fzhan', at });

  assert.deepEqual(inbox(s, 'claude').map((t) => t.id), ['t_tome01', 't_noone1', 't_both01']);
  assert.deepEqual(inbox(s, 'CLAUDE').map((t) => t.id), ['t_tome01', 't_noone1', 't_both01']);

  const now = Date.now();
  s = applyOp(s, { type: 'setWorking', threadId: 't_tome01', by: 'claude', since: new Date(now).toISOString() });
  assert.deepEqual(inbox(s, 'claude', now).map((t) => t.id), ['t_noone1', 't_both01']);
  assert.deepEqual(inbox(s, 'claude', now + 6 * 60 * 1000).map((t) => t.id), ['t_tome01', 't_noone1', 't_both01'], 'stale working flags are ignored');

  s = applyOp(s, { type: 'addMessage', threadId: 't_noone1', message: msg(claude, 'Rewrote it.') });
  assert.ok(!inbox(s, 'claude', now).some((t) => t.id === 't_noone1'), 'an agent reply hands the turn back');
});

test('edits: recorded on an agent reply, validated, idempotent; an undo notice wakes no one', () => {
  const edit = { before: 'load', after: 'peak load', prefix: 'the extra ', suffix: '.', start: 120 };
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_edit01', anchor: null, message: msg(human, 'add peak') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: msg(claude, 'Done.', 'm_reply1') });
  s = applyOp(s, { type: 'resolve', threadId: 't_edit01', by: 'claude', at });
  s = applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits: [edit] });
  assert.deepEqual(s.threads[0].messages[1].edits, [edit]);
  assert.equal(s.threads[0].status, 'resolved', 'attaching edits does not reopen');
  assert.equal(applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits: [{ ...edit }] }), s);

  const bad = [[], [{ ...edit, after: 'load' }], [{ ...edit, prefix: 'p'.repeat(33) }], [{ ...edit, start: -1 }], [{ ...edit, scope: 'all' }]];
  for (const edits of bad) {
    assert.throws(() => applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits }), OpError);
  }
  assert.throws(() => applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_nope00', edits: [edit] }), OpError);

  // A message can carry edits from the start; messages without them stay as they were.
  const withEdits = applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: { ...msg(claude, 'Edited the doc.'), edits: [edit] } });
  assert.deepEqual(withEdits.threads[0].messages.at(-1).edits, [edit]);
  assert.ok(!('edits' in s.threads[0].messages[0]) && !('undoes' in s.threads[0].messages[0]));

  const undo = { ...msg(human, "Undid claude's edit"), undoes: 'm_reply1' };
  s = applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: undo });
  assert.equal(s.threads[0].status, 'open', 'the notice reopens the thread');
  assert.equal(s.threads[0].messages.at(-1).undoes, 'm_reply1');
  assert.deepEqual(inbox(s, 'claude'), [], 'and does not ask the agent to try again');
  s = applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: msg(human, 'Try "heavy" instead') });
  assert.deepEqual(inbox(s, 'claude').map((t) => t.id), ['t_edit01']);
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: { ...msg(human, 'x'), undoes: 'nope' } }), OpError);
});
