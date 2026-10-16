import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeWorking, applyOp, emptySidecar, newId, OpError, workingList } from '../src/core/ops.js';
import { parseMentions } from '../src/core/mentions.js';
import { addedMentions, carry, changedRanges, textMentions } from '../src/core/text-mentions.js';
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
  const resolved = applyOp(twice, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at });
  assert.equal(applyOp(resolved, { type: 'resolve', threadId: 't_aaaaaa', by: 'fzhan', at }), resolved);
  assert.equal(resolved.threads[0].resolvedBy, 'fzhan');
});

test('a reply reopens a resolved thread; the agent reply clears its working flag', () => {
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude?') });
  s = applyOp(s, { type: 'setWorking', threadId: 't_aaaaaa', by: 'claude', since: new Date().toISOString() });
  assert.deepEqual(s.threads[0].working.map((w) => w.by), ['claude']);
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'Done.') });
  assert.equal(s.threads[0].working, null);
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
  s = applyOp(s, { type: 'addMessage', threadId: 't_noone1', message: msg(human, 'Better, but shorter?') });
  assert.ok(inbox(s, 'claude', now).some((t) => t.id === 't_noone1'), 'a follow-up wakes it without @');
  const dnd = (sc) => inbox(sc, 'claude', now, { mentionsOnly: true }).map((t) => t.id);
  assert.deepEqual(dnd(s), ['t_noone1', 't_both01'], 'off Auto Commenter, it answers its mentions and follow-ups in its own threads');
  s = applyOp(s, { type: 'addThread', id: 't_noone2', anchor: null, message: msg(human, 'Another open comment') });
  assert.ok(!dnd(s).includes('t_noone2'), 'but not a comment for no one');
});

test('inbox with several agents: each one mentioned answers once; an open comment, each until it answers or passes', () => {
  const muse = { name: 'muse', kind: 'agent' };
  let s = withAgents(claude, muse);
  s = applyOp(s, { type: 'addThread', id: 't_both01', anchor: null, message: msg(human, '@claude @muse what do you think?') });
  s = applyOp(s, { type: 'addThread', id: 't_noone1', anchor: null, message: msg(human, 'This is weak') });
  const waiting = (name) => inbox(s, name).map((t) => t.id);
  assert.deepEqual(waiting('claude'), ['t_both01', 't_noone1']);
  assert.deepEqual(waiting('muse'), ['t_both01', 't_noone1']);

  s = applyOp(s, { type: 'addMessage', threadId: 't_both01', message: msg(claude, 'Fine by me.') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_noone1', message: msg(claude, 'Rewrote it.') });
  assert.deepEqual(waiting('claude'), [], 'claude answered both');
  assert.deepEqual(waiting('muse'), ['t_both01', 't_noone1'], 'muse may still take the open comment claude answered');
  s = applyOp(s, { type: 'pass', threadId: 't_noone1', by: 'MUSE' });
  assert.deepEqual(s.threads[1].passed, ['muse']);
  assert.deepEqual(waiting('muse'), ['t_both01'], 'muse passed on it');
  assert.equal(applyOp(s, { type: 'pass', threadId: 't_noone1', by: 'muse' }), s, 'passing twice changes nothing');

  s = applyOp(s, { type: 'addMessage', threadId: 't_both01', message: msg(muse, 'Make it sing.') });
  assert.deepEqual(waiting('muse'), []);
  s = applyOp(s, { type: 'addMessage', threadId: 't_both01', message: msg(human, '@muse more?') });
  assert.deepEqual(waiting('muse'), ['t_both01']);
  assert.deepEqual(waiting('claude'), [], 'a follow-up for muse is not for claude');

  // A new ask in the thread opens it again; notices do not.
  const noone = (sc) => sc.threads.find((t) => t.id === 't_noone1');
  s = applyOp(s, { type: 'addMessage', threadId: 't_noone1', message: { ...msg(claude, 'Undid it.'), undoes: noone(s).messages[1].id } });
  assert.deepEqual(noone(s).passed, ['muse'], 'an undo notice keeps the passes');
  s = applyOp(s, { type: 'addMessage', threadId: 't_noone1', message: msg(human, 'Still weak') });
  assert.deepEqual(noone(s).passed, []);
  assert.deepEqual(waiting('claude'), ['t_noone1'], 'a follow-up goes to the agent that answered');
  s = applyOp(s, { type: 'addMessage', threadId: 't_noone1', message: msg(claude, 'Tightened it.') });

  // A reply that mentions no one continues with the agent that answered last.
  s = applyOp(s, { type: 'addMessage', threadId: 't_both01', message: msg(muse, 'More it is.') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_both01', message: msg(human, 'Even more.') });
  assert.deepEqual(waiting('muse'), ['t_both01']);
  assert.deepEqual(waiting('claude'), []);
  assert.deepEqual(inbox(s, 'muse', Date.now(), { mentionsOnly: true }).map((t) => t.id), ['t_both01'], 'also for a co-pilot');
});

test('working: several agents at once, each cleared by its own reply; an old single-object value still reads', () => {
  const muse = { name: 'muse', kind: 'agent' };
  const now = Date.now();
  const since = new Date(now).toISOString();
  let s = withAgents(claude, muse);
  s = applyOp(s, { type: 'addThread', id: 't_both01', anchor: null, message: msg(human, '@claude @muse thoughts?') });
  s = applyOp(s, { type: 'setWorking', threadId: 't_both01', by: 'claude', since });
  s = applyOp(s, { type: 'setWorking', threadId: 't_both01', by: 'muse', since });
  s = applyOp(s, { type: 'setWorking', threadId: 't_both01', by: 'Claude', since });
  assert.deepEqual(activeWorking(s.threads[0], now).map((w) => w.by), ['muse', 'Claude'], 'one entry per agent');
  assert.deepEqual(inbox(s, 'claude', now), []);
  s = applyOp(s, { type: 'addMessage', threadId: 't_both01', message: msg(muse, 'A poem.') });
  assert.deepEqual(s.threads[0].working.map((w) => w.by), ['Claude'], 'a reply ends only its author\'s');
  s = applyOp(s, { type: 'setWorking', threadId: 't_both01', by: 'claude', since: null });
  assert.equal(s.threads[0].working, null, 'no one working is null');

  // A sidecar from before the list: a single object.
  const old = { ...s, threads: [{ ...s.threads[0], working: { by: 'muse', since } }] };
  assert.deepEqual(workingList(old.threads[0]).map((w) => w.by), ['muse']);
  assert.deepEqual(inbox(old, 'muse', now), []);
  const added = applyOp(old, { type: 'setWorking', threadId: 't_both01', by: 'claude', since });
  assert.deepEqual(added.threads[0].working.map((w) => w.by), ['muse', 'claude']);
  assert.equal(applyOp(old, { type: 'addMessage', threadId: 't_both01', message: msg(muse, 'Done.') }).threads[0].working, null);
  assert.deepEqual(activeWorking({ working: null }), []);
});

test('pass: an agent leaves an open ask to others, and stops working on it', () => {
  const muse = { name: 'muse', kind: 'agent' };
  let s = withAgents(claude, muse);
  s = applyOp(s, { type: 'addThread', id: 't_noone1', anchor: null, message: msg(human, 'This is weak') });
  s = applyOp(s, { type: 'setWorking', threadId: 't_noone1', by: 'muse', since: new Date().toISOString() });
  s = applyOp(s, { type: 'pass', threadId: 't_noone1', by: 'muse' });
  assert.equal(s.threads[0].working, null);
  assert.deepEqual(inbox(s, 'muse'), []);
  assert.deepEqual(inbox(s, 'claude').map((t) => t.id), ['t_noone1'], 'still open to the others');
  assert.throws(() => applyOp(s, { type: 'pass', threadId: 't_noone1', by: '@bad' }), (e) => e.code === 'bad_input');
  assert.throws(() => applyOp(s, { type: 'pass', threadId: 't_missing', by: 'muse' }), (e) => e.code === 'unknown_thread');
});

test('fail: the ask leaves the agent\'s inbox until a human retries it or asks again', () => {
  let s = withAgents(claude);
  s = applyOp(s, { type: 'addThread', id: 't_failed1', anchor: null, message: msg(human, '@claude look') });
  s = applyOp(s, { type: 'setWorking', threadId: 't_failed1', by: 'claude', since: new Date().toISOString() });
  s = applyOp(s, { type: 'fail', threadId: 't_failed1', by: 'Claude', error: 'timed out after 10 min', at });
  assert.equal(s.threads[0].working, null);
  assert.deepEqual(s.threads[0].failed, [{ name: 'claude', error: 'timed out after 10 min', at }]);
  assert.deepEqual(inbox(s, 'claude'), [], 'a failure is not tried again on its own');
  // Failing again replaces the failure.
  const again = applyOp(s, { type: 'fail', threadId: 't_failed1', by: 'claude', error: 'exited with code 1', at });
  assert.deepEqual(again.threads[0].failed.map((f) => f.error), ['exited with code 1']);
  assert.throws(() => applyOp(s, { type: 'fail', threadId: 't_failed1', by: 'claude', error: ' ', at }), (e) => e.code === 'bad_input');

  // Only a human retries.
  assert.throws(() => applyOp(s, { type: 'retry', threadId: 't_failed1', name: 'claude', by: 'claude' }), (e) => e.code === 'not_allowed');
  const retried = applyOp(s, { type: 'retry', threadId: 't_failed1', name: 'claude', by: 'fzhan', kind: 'human' });
  assert.deepEqual(retried.threads[0].failed, []);
  assert.deepEqual(inbox(retried, 'claude').map((t) => t.id), ['t_failed1']);

  // A new ask from the human is a reason to try again too.
  const asked = applyOp(s, { type: 'addMessage', threadId: 't_failed1', message: msg(human, '@claude again') });
  assert.deepEqual(asked.threads[0].failed, []);
  assert.deepEqual(inbox(asked, 'claude').map((t) => t.id), ['t_failed1']);
});

test('cancel: a human takes the ask back from an agent until they ask again', () => {
  let s = withAgents(claude);
  s = applyOp(s, { type: 'addThread', id: 't_cancel1', anchor: null, message: msg(human, '@claude look') });
  s = applyOp(s, { type: 'fail', threadId: 't_cancel1', by: 'claude', error: 'exited with code 1', at });
  assert.throws(() => applyOp(s, { type: 'cancel', threadId: 't_cancel1', name: 'claude', by: 'claude' }), (e) => e.code === 'not_allowed');
  const cancelled = applyOp(s, { type: 'cancel', threadId: 't_cancel1', name: 'CLAUDE', by: 'fzhan' });
  assert.deepEqual(cancelled.threads[0].failed, []);
  assert.deepEqual(cancelled.threads[0].cancelled, ['claude']);
  assert.deepEqual(inbox(cancelled, 'claude'), []);
  assert.deepEqual(applyOp(cancelled, { type: 'cancel', threadId: 't_cancel1', name: 'claude', by: 'fzhan' }).threads[0].cancelled, ['claude'], 'once');
  // An agent that never ran (it could not start) can be cancelled too.
  const fresh = applyOp(withAgents(claude), { type: 'addThread', id: 't_cancel2', anchor: null, message: msg(human, '@claude look') });
  assert.deepEqual(inbox(applyOp(fresh, { type: 'cancel', threadId: 't_cancel2', name: 'claude', by: 'fzhan' }), 'claude'), []);

  const asked = applyOp(cancelled, { type: 'addMessage', threadId: 't_cancel1', message: msg(human, '@claude now?') });
  assert.deepEqual(asked.threads[0].cancelled, []);
  assert.deepEqual(inbox(asked, 'claude').map((t) => t.id), ['t_cancel1']);
});

test('leave: an agent removed from the doc is no longer a participant or working; its messages stay', () => {
  let s = withAgents(claude);
  s = applyOp(s, { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(human, '@claude look') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'Looked.') });
  s = applyOp(s, { type: 'setWorking', threadId: 't_aaaaaa', by: 'claude', since: new Date().toISOString() });
  const left = applyOp(s, { type: 'leave', name: 'CLAUDE' });
  assert.deepEqual(left.participants.map((p) => p.name), ['fzhan']);
  assert.equal(left.threads[0].working, null);
  assert.equal(left.threads[0].messages[1].author.name, 'claude');
  assert.equal(applyOp(left, { type: 'leave', name: 'claude' }), left, 'leaving twice changes nothing');
  assert.deepEqual(parseMentions('@claude again', left.participants), [], 'no longer offered for mentions');
  assert.throws(() => applyOp(s, { type: 'leave', name: '@bad' }), (e) => e.code === 'bad_input');
});

test('edits: recorded on an agent reply, validated, idempotent; an undo notice wakes no one', () => {
  const edit = { before: 'load', after: 'peak load', prefix: 'the extra ', suffix: '.', start: 120 };
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_edit01', anchor: null, message: msg(human, '@claude add peak') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: msg(claude, 'Done.', 'm_reply1') });
  s = applyOp(s, { type: 'resolve', threadId: 't_edit01', by: 'fzhan', at });
  s = applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits: [edit] });
  assert.deepEqual(s.threads[0].messages[1].edits, [edit]);
  assert.equal(s.threads[0].status, 'resolved', 'attaching edits does not reopen');
  assert.equal(applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits: [{ ...edit }] }), s);

  const bad = [null, [{ ...edit, after: 'load' }], [{ ...edit, prefix: 'p'.repeat(33) }], [{ ...edit, start: -1 }], [{ ...edit, scope: 'all' }]];
  for (const edits of bad) {
    assert.throws(() => applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits }), OpError);
  }
  // An empty list takes the edits off the message.
  const cleared = applyOp(s, { type: 'attachEdits', threadId: 't_edit01', messageId: 'm_reply1', edits: [] });
  assert.equal('edits' in cleared.threads[0].messages[1], false);
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
  s = applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: msg(human, '@claude try "heavy" instead') });
  assert.deepEqual(inbox(s, 'claude').map((t) => t.id), ['t_edit01']);
  assert.throws(() => applyOp(s, { type: 'addMessage', threadId: 't_edit01', message: { ...msg(human, 'x'), undoes: 'nope' } }), OpError);
});

test('textMentions: @name in the doc text, to the end of its block, outside code', () => {
  const md = '# Plan\n\nShip in Q3. @claude add the **risks** here.\n\n`@claude` in code\n\n```\n@claude fenced\n```\n\nMail a@claude.com, ask @alex, or @Claude.\n';
  assert.deepEqual(textMentions(md, ['claude']).map((m) => [m.name, m.quote]), [
    ['claude', '@claude add the risks here.'],
    ['claude', '@Claude.'],
  ]);
  assert.deepEqual(textMentions(md, []), []);
  const [first] = textMentions(md, ['claude']);
  assert.equal(first.end - first.start, first.quote.length);
});

test('addedMentions: only a mention the change typed, pasted, finished or uncovered', () => {
  const added = (before, after) => addedMentions(before, after, ['claude', 'alex']).map((m) => m.quote);
  const doc = 'Ship it. @claude add risks\n\nNext.\n';
  assert.deepEqual(added('Ship it.\n', 'Ship it. @claude\n'), ['@claude'], 'typed');
  assert.deepEqual(added('Ship it. @cla\n', 'Ship it. @claude\n'), ['@claude'], 'finished');
  assert.deepEqual(added('Ship it. x@claude\n', 'Ship it. @claude\n'), ['@claude'], 'uncovered');
  assert.deepEqual(added(doc, doc.replace('add risks', 'add the risks here')), [], 'writing on after an old one');
  assert.deepEqual(added(doc, `Intro.\n\n${doc}`), [], 'text added before an old one');
  assert.deepEqual(added(doc, doc.replace('Ship it.', 'Ship it soon.').replace('Next.', 'Next!')), [], 'one save changing places on both sides of an old one');
  assert.deepEqual(added(doc, doc.replace('Next.', 'Next. @claude check dates')), ['@claude check dates'], 'a second one, after an old one');
  assert.deepEqual(added(doc, doc.replace('@claude', '@alex')), ['@alex add risks'], 'renamed');
  assert.deepEqual(added(doc, doc.replace('Ship it. @claude add risks', 'Ship it. @claude do more')), [], 'rewording an old ask is not a new one');
  assert.deepEqual(added(doc, doc.replace('Next.', '`@claude` in code')), []);
});

test('changedRanges and carry: what a change moved, and what it touched', () => {
  assert.deepEqual(changedRanges('abc @x def', 'abc @x de1f'), [{ a0: 9, a1: 9, b0: 9, b1: 10 }]);
  assert.deepEqual(changedRanges('same', 'same'), []);
  const far = changedRanges('one\ntwo @x\nthree', 'one!\ntwo @x\nthree!');
  assert.equal(far.length, 2, 'changes far apart stay apart');
  assert.equal(carry(far, 8, 10), 9, 'between them: moved by the first');
  assert.equal(carry(changedRanges('ab @x', 'abZZ @x'), 3, 5), 5, 'after a change: moves with it');
  assert.equal(carry(changedRanges('ab @x', 'ab @x!'), 3, 5), 3, 'before a change: stays');
  assert.equal(carry(changedRanges('ab @x', 'ab @y'), 3, 5), null, 'touched');
});

test('identify: a person with an id keeps one entry when they change their name', () => {
  const old = { name: 'fanzhang', kind: 'human' };
  let s = applyOp(withAgents(claude), { type: 'addThread', id: 't_aaaaaa', anchor: null, message: msg(old, '@claude look', 'm_old001') });
  s = applyOp(s, { type: 'addMessage', threadId: 't_aaaaaa', message: msg(claude, 'ask @fanzhang', 'm_old002') });
  s = applyOp(s, { type: 'pass', threadId: 't_aaaaaa', by: 'claude' });
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
