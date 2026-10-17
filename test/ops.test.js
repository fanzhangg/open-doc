import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOp, emptySidecar, newId, OpError } from '../src/core/ops.js';
import { parseMentions } from '../src/core/mentions.js';
import { askedOf, inbox } from '../src/core/inbox.js';

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
  const resolved = applyOp(twice, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at });
  assert.equal(applyOp(resolved, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at }), resolved);
  assert.equal(resolved.threads[0].resolvedBy, 'fzhan');
});

test('a reply reopens a resolved thread', () => {
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude?') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'Done.') });
  s = applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(human, 'Not quite') });
  assert.equal(s.threads[0].status, 'open');
  assert.equal(s.threads[0].resolvedBy, null);
  s = applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at });
  s = applyOp(s, { type: 'reopen', threadId: 't_aaaaaa', by: 'fzhan' });
  assert.equal(s.threads[0].status, 'open');
});

test('only a human resolves or reopens', () => {
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude?') });
  const notAllowed = (e) => e instanceof OpError && e.code === 'not_allowed';
  assert.throws(() => applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'claude', at }), notAllowed);
  assert.throws(() => applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'CLAUDE', kind: 'human', at }), notAllowed, 'a known agent cannot claim to be human');
  assert.throws(() => applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'newbot', kind: 'agent', at }), notAllowed);
  assert.throws(() => applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', at }), OpError, 'who resolves must be known');
  s = applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', kind: 'human', at });
  assert.equal(s.threads[0].status, 'resolved');
  assert.throws(() => applyOp(s, { type: 'reopen', threadId: 't_aaaaaa', by: 'claude' }), notAllowed);
  assert.throws(() => applyOp(s, { type: 'reopen', threadId: 't_aaaaaa' }), OpError);
  assert.equal(applyOp(s, { type: 'reopen', threadId: 't_aaaaaa', by: 'fzhan' }).threads[0].status, 'open');
});

test('proposals and apply notices on messages are validated', () => {
  const change = { before: 'extra load', after: 'extra peak load', prefix: 'handle the ', suffix: '.', start: 120 };
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_prop01', anchor: null, message: msg(human, '@claude add peak') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_prop01', message: { ...msg(claude, 'Suggest "peak".', 'm_prop01'), proposal: [change] } });
  assert.deepEqual(s.threads[0].messages[1].proposal, [change]);
  const bad = [[], [{ ...change, before: '' }], [{ ...change, after: change.before }], [{ ...change, suffix: 's'.repeat(33) }], [{ ...change, start: 1.5 }]];
  for (const proposal of bad) {
    assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_prop01', message: { ...msg(claude, 'x'), proposal } }), OpError);
  }
  const edit = { before: '', after: 'peak ', prefix: 'handle the extra ', suffix: 'load.', start: 126 };
  s = applyOp(s, { type: 'addMessage', threadId: 't_prop01', message: { ...msg(human, "Applied claude's proposal"), applies: 'm_prop01', edits: [edit] } });
  assert.equal(s.threads[0].messages[2].applies, 'm_prop01');
  assert.deepEqual(inbox(s, 'claude'), [], 'applying asks the agent for nothing');
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_prop01', message: { ...msg(human, 'x'), applies: 'nope' } }), OpError);
});

test('the inbox: a thread waits on the buddies its latest human comment @mentions, until each replies', () => {
  const muse = { name: 'muse', kind: 'agent' };
  let s = withAgents(claude, muse);
  const add = (id, author, body) => { s = applyOp(s, { type: 'addThread', id, anchor: null, message: msg(author, body) }); };
  const say = (id, author, body) => { s = applyOp(s, { type: 'addMessage', threadId: id, message: msg(author, body) }); };
  add('t_tome01', human, '@claude please check');
  add('t_noone1', human, 'This section is weak');
  add('t_both01', human, '@muse @CLAUDE thoughts?');
  add('t_agent1', claude, '@muse a question for you');
  add('t_done01', human, '@claude fixed?');
  s = applyOp(s, { type: 'resolve', threadId: 't_done01', by: 'fzhan', at });

  assert.deepEqual(inbox(s, 'claude').map((t) => t.id), ['t_tome01', 't_both01']);
  assert.deepEqual(inbox(s, 'MUSE').map((t) => t.id), ['t_both01'], "a buddy's @mention asks no one");
  assert.deepEqual(askedOf(s.threads[1]), [], 'a comment that mentions no one asks no one');

  say('t_both01', claude, 'Looks fine. @muse?');
  assert.deepEqual(askedOf(s.threads[2]), ['muse'], 'each answers once');
  say('t_both01', muse, 'Agreed.');
  assert.deepEqual(askedOf(s.threads[2]), []);
  say('t_both01', human, 'Shorter?');
  assert.deepEqual(askedOf(s.threads[2]), [], 'a follow-up without an @mention asks no one');
  say('t_both01', human, '@claude shorter?');
  assert.deepEqual(askedOf(s.threads[2]), ['claude']);
});

test('a buddy\'s reply may say conflict or failed; no one else\'s may', () => {
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude?') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: { ...msg(claude, 'Partly done.'), conflict: true } });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: { ...msg(claude, 'exit 1'), failed: true } });
  assert.deepEqual(s.threads[0].messages.slice(1).map((m) => [m.conflict, m.failed]), [[true, undefined], [undefined, true]]);
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: { ...msg(human, 'x'), failed: true } }), OpError);
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: { ...msg(claude, 'x'), conflict: 'yes' } }), OpError);
});

test('bad input is refused', () => {
  const s = withAgents(claude);
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_missing', message: msg(human, 'x') }), (e) => e instanceof OpError && e.code === 'unknown_thread');
  assert.throws(() => applyOp(s, { type: 'join', participant: { name: '@bad', kind: 'agent' } }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'join', participant: { name: 'bot', kind: 'robot' } }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'addThread', id: 't_bbbbbb', anchor: null, message: msg(human, '   ') }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'nope' }), (e) => e.code === 'bad_input');
});

test('leave: an agent removed from the doc is no longer a participant; its messages stay', () => {
  let s = withAgents(claude);
  s = applyOp(s, { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude look') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'Looked.') });
  const left = applyOp(s, { type: 'leave', name: 'CLAUDE' });
  assert.deepEqual(left.participants.map((p) => p.name), ['fzhan']);
  assert.equal(left.threads[0].messages[1].author.name, 'claude');
  assert.equal(applyOp(left, { type: 'leave', name: 'claude' }), left, 'leaving twice changes nothing');
  assert.deepEqual(parseMentions('@claude again', left.participants), [], 'no longer offered for mentions');
  assert.throws(() => applyOp(s, { type: 'leave', name: '@bad' }), (e) => e.code === 'bad_input');
});

test('identify: a person with an id keeps one entry when they change their name', () => {
  const old = { name: 'fanzhang', kind: 'human' };
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(old, '@claude look', 'm_old001') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'ask @fanzhang', 'm_old002') });
  s = applyOp(s, { type: 'resolve', threadId: 't_aaaaaa', by: 'fanzhang', at });

  // Before ids: their entry is claimed by an aka, and everything that names them follows the new name.
  const me = { name: 'Frank', kind: 'human', id: 'u_abc123' };
  const renamed = applyOp(s, { type: 'identify', participant: me, aka: ['fanzhang'] });
  assert.deepEqual(renamed.participants, [claude, { name: 'Frank', kind: 'human', id: 'u_abc123' }]);
  const thread = renamed.threads[0];
  assert.deepEqual(thread.messages[0].author, { name: 'Frank', kind: 'human', id: 'u_abc123' });
  assert.deepEqual(thread.messages[1].author, claude, "others' messages stay theirs");
  assert.deepEqual(thread.messages[1].mentions, ['Frank']);
  assert.equal(thread.messages[1].body, 'ask @fanzhang', 'bodies stay as written');
  assert.equal(thread.resolvedBy, 'Frank');
  assert.equal(applyOp(renamed, { type: 'identify', participant: me, aka: ['fanzhang'] }), renamed, 'idempotent');

  // Later renames find them by id; their new comments carry it.
  const later = applyOp(renamed, { type: 'addMessage', threadId: 't_aaaaaa', message: msg({ ...me, name: 'Fan' }, 'done', 'm_new001') });
  assert.deepEqual(later.participants.map((p) => p.name), ['claude', 'Fan']);
  assert.deepEqual(later.threads[0].messages.map((m) => m.author.name), ['Fan', 'claude', 'Fan']);
});

test('identify: someone not in the doc is not added; a taken name is not taken', () => {
  const s = withAgents(claude);
  assert.equal(applyOp(s, { type: 'identify', participant: { name: 'Frank', kind: 'human', id: 'u_abc123' } }), s);
  const two = applyOp(applyOp(s, { type: 'join', participant: { name: 'fanzhang', kind: 'human', id: 'u_abc123' } }), { type: 'join', participant: { name: 'Frank', kind: 'human', id: 'u_other1' } });
  const blocked = applyOp(two, { type: 'identify', participant: { name: 'frank', kind: 'human', id: 'u_abc123' } });
  assert.equal(blocked, two, 'keeps their old name');
  const posted = applyOp(blocked, { type: 'addThread', id: 't_bbbbbb', anchor: null, message: msg({ name: 'frank', kind: 'human', id: 'u_abc123' }, 'hi') });
  assert.deepEqual(posted.threads[0].messages[0].author, { name: 'fanzhang', kind: 'human', id: 'u_abc123' });
  assert.throws(() => applyOp(s, { type: 'identify', participant: { name: 'Frank', kind: 'human' } }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'join', participant: { name: 'Frank', kind: 'human', id: 'bad id' } }), (e) => e.code === 'bad_input');
});
