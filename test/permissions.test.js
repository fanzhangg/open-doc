import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permissions, covers, grantsHere, holds, requestFor } from '../src/server/agents/permissions.js';
import { resolveGrants, validGrant, validGrants } from '../src/core/grants.js';
import { resolveSettings } from '../src/core/settings.js';

const root = join(tmpdir(), 'opendoc-perm');
const docPath = join(root, 'docs', 'plan.md');
const workdir = join(root, 'private');
const notes = join(root, 'notes');
const grant = (fields) => ({ id: 'g_test01', agent: 'a_merlin', permission: 'files', doc: null, folder: null, at: '2026-10-15T00:00:00.000Z', ...fields });

test('requestFor: the web and files beyond the doc need a grant; the doc and the run\'s own folder do not', () => {
  assert.deepEqual(requestFor('WebSearch', { query: 'capital of Peru' }, { docPath }), { permission: 'web', target: 'capital of Peru', path: null, folder: null });
  assert.equal(requestFor('WebFetch', { url: 'https://example.com' }, { docPath }).target, 'https://example.com');
  const read = requestFor('Read', { file_path: join(notes, 'q3.md') }, { docPath, workdir });
  assert.deepEqual(read, { permission: 'files', target: join(notes, 'q3.md'), path: join(notes, 'q3.md'), folder: notes });
  assert.equal(requestFor('Read', { file_path: '../notes/q3.md' }, { docPath, workdir }).path, join(notes, 'q3.md'), 'relative to the working folder');
  assert.equal(requestFor('Grep', { pattern: 'x', path: notes }, { docPath, workdir }).folder, notes);
  assert.equal(requestFor('Glob', { pattern: `${notes.replaceAll('\\', '/')}/**/*.md` }, { docPath, workdir }).permission, 'files', 'an absolute pattern looks outside');
  assert.equal(requestFor('Read', { file_path: docPath }, { docPath, workdir }), null, 'the doc itself');
  assert.equal(requestFor('Glob', { pattern: '*.md' }, { docPath, workdir }), null, 'the working folder');
  assert.equal(requestFor('Read', { file_path: join(workdir, 'x') }, { docPath, workdir }), null);
  assert.equal(requestFor('Edit', { file_path: join(notes, 'x') }, { docPath, workdir }), null, 'not a tool that asks');
});

test('covers: per agent and permission, in one doc or every doc, files maybe within a folder', () => {
  const ask = { agentId: 'a_merlin', permission: 'files', docPath, path: join(notes, 'q3.md') };
  assert.ok(covers(grant({}), ask));
  assert.ok(!covers(grant({ agent: 'a_genius' }), ask));
  assert.ok(!covers(grant({ permission: 'web' }), ask));
  assert.ok(covers(grant({ doc: docPath }), ask));
  assert.ok(!covers(grant({ doc: join(root, 'other.md') }), ask));
  assert.ok(covers(grant({ folder: notes }), ask));
  assert.ok(covers(grant({ folder: notes }), { ...ask, path: join(notes, 'deep', 'x.md') }));
  assert.ok(!covers(grant({ folder: notes }), { ...ask, path: join(root, 'notes-old', 'x.md') }), 'a sibling with the same prefix is outside');
  assert.ok(holds([grant({ folder: notes })], { agentId: 'a_merlin', permission: 'files', docPath }));
  const here = grantsHere([grant({}), grant({ id: 'g_test02', doc: join(root, 'other.md') }), grant({ id: 'g_test03', doc: docPath })], docPath);
  assert.deepEqual(here.map((g) => [g.id, g.scope]), [['g_test01', 'always'], ['g_test03', 'doc']]);
});

test('grants in settings: validated, bad entries dropped', () => {
  assert.ok(validGrant(grant({})));
  assert.ok(!validGrant(grant({ permission: 'camera' })));
  assert.ok(!validGrant(grant({ permission: 'web', folder: notes })), 'only files have a folder');
  assert.ok(!validGrant({ ...grant({}), extra: 1 }));
  assert.ok(!validGrants([grant({}), grant({})]), 'each id once');
  assert.deepEqual(resolveGrants([grant({}), { id: 'nope' }, grant({})]).map((g) => g.id), ['g_test01']);
  assert.deepEqual(resolveSettings({}).grants, []);
  assert.deepEqual(resolveSettings({ grants: [grant({}), 'junk'] }).grants, [grant({})]);
});

// A dispatcher in the middle of a run, as far as Permissions needs one.
function agentRunning(fields = {}) {
  return { name: 'Merlin', id: 'a_merlin', asks: ['files'], adapter: { workdir: () => workdir }, run: { threadIds: ['t_aaaaaaaa'], permits: [] }, ...fields };
}

function broker({ timeoutMs = 5000 } = {}) {
  let grants = [];
  const changes = [];
  const permissions = new Permissions({
    docPath: () => docPath,
    timeoutMs,
    grants: async () => grants,
    addGrant: async (g) => { grants = [...grants, g]; },
    onChange: () => changes.push(permissions.list().length),
  });
  return { permissions, changes, grants: () => grants, revoke: (id) => { grants = grants.filter((g) => g.id !== id); } };
}

const read = (path) => ({ file_path: path });
async function waiting(permissions) {
  for (let i = 0; i < 200 && permissions.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return permissions.list()[0];
}

test('Permissions: a request waits for the human; Allow once lasts the run, and so does Deny', async () => {
  const { permissions } = broker();
  const merlin = agentRunning();
  const first = permissions.decide(merlin, 'Read', read(join(notes, 'q3.md')));
  const request = await waiting(permissions);
  assert.deepEqual([request.agent, request.permission, request.target, request.folder, request.threadIds], ['Merlin', 'files', join(notes, 'q3.md'), notes, ['t_aaaaaaaa']]);
  assert.equal(request.warning, null);
  await permissions.answer(request.id, 'once', { folderOnly: true });
  assert.deepEqual(await first, { decision: 'allow' });
  assert.deepEqual(await permissions.decide(merlin, 'Read', read(join(notes, 'other.md'))), { decision: 'allow' }, 'the rest of the run, in that folder');

  const elsewhere = permissions.decide(merlin, 'Read', read(join(root, 'diary.md')));
  const second = await waiting(permissions);
  assert.ok(second, 'outside the folder it asks again');
  await permissions.answer(second.id, 'deny');
  const denied = await elsewhere;
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /did not allow Your files for this reply/);
  assert.equal((await permissions.decide(merlin, 'Read', read(join(root, 'x.md')))).decision, 'deny', 'not asked again this run');

  // The next run starts afresh.
  merlin.run = { threadIds: ['t_bbbbbbbb'], permits: [] };
  const next = permissions.decide(merlin, 'Read', read(join(notes, 'q3.md')));
  assert.ok(await waiting(permissions), 'asked again');
  permissions.clear();
  assert.equal((await next).decision, 'deny');
});

test('Permissions: Allow in this doc and Always become grants; revoked, it asks again', async () => {
  const { permissions, grants, revoke } = broker();
  const merlin = agentRunning();
  const pending = permissions.decide(merlin, 'Read', read(join(notes, 'q3.md')));
  await permissions.answer((await waiting(permissions)).id, 'doc');
  assert.deepEqual(await pending, { decision: 'allow' });
  assert.deepEqual(grants().map((g) => [g.agent, g.permission, g.doc, g.folder]), [['a_merlin', 'files', docPath, null]]);

  merlin.run = { threadIds: ['t_bbbbbbbb'], permits: [] };
  assert.deepEqual(await permissions.decide(merlin, 'Read', read(join(root, 'any.md'))), { decision: 'allow' }, 'no question in a later run');
  revoke(grants()[0].id);
  const again = permissions.decide(merlin, 'Read', read(join(root, 'any.md')));
  const request = await waiting(permissions);
  assert.ok(request, 'revoked: it asks again');
  await permissions.answer(request.id, 'always', { folderOnly: true });
  assert.deepEqual(await again, { decision: 'allow' });
  assert.deepEqual(grants().map((g) => [g.doc, g.folder]), [[null, root]]);
  await assert.rejects(permissions.answer(request.id, 'once'), /no longer waiting/);
});

test('Permissions: no answer in time is a Deny, and a run that ends stops waiting', async () => {
  const { permissions, changes } = broker({ timeoutMs: 80 });
  const started = Date.now();
  const verdict = await permissions.decide(agentRunning(), 'Read', read(join(notes, 'q3.md')));
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /did not answer within 1 min/);
  assert.ok(Date.now() - started >= 70);
  assert.deepEqual(changes, [1, 0], 'the card came and went');

  const gone = new AbortController();
  const ended = permissions.decide(agentRunning(), 'Read', read(join(notes, 'q3.md')), gone.signal);
  await waiting(permissions);
  gone.abort();
  assert.equal((await ended).decision, 'deny');
  assert.equal(permissions.list().length, 0);
});

test('Permissions: parallel calls share one question; undeclared permissions and calls outside a run are denied at once', async () => {
  const { permissions } = broker();
  const genius = agentRunning({ name: 'Genius', id: 'a_genius', asks: ['web', 'files'] });
  const a = permissions.decide(genius, 'WebSearch', { query: 'one' });
  const b = permissions.decide(genius, 'WebFetch', { url: 'https://example.com' });
  const request = await waiting(permissions);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(permissions.list().length, 1, 'one card for both');
  await permissions.answer(request.id, 'once');
  assert.deepEqual([await a, await b], [{ decision: 'allow' }, { decision: 'allow' }]);

  // Holding the web, a request for files carries the warning.
  const files = permissions.decide(genius, 'Read', read(join(notes, 'q3.md')));
  assert.match((await waiting(permissions)).warning, /can also use Web here/);
  permissions.clear();
  assert.equal((await files).decision, 'deny');

  assert.match((await permissions.decide(agentRunning({ asks: [] }), 'Read', read(join(notes, 'x')))).reason, /does not have Your files access/);
  assert.equal((await permissions.decide(agentRunning({ run: null }), 'Read', read(join(notes, 'x')))).decision, 'deny');
  assert.deepEqual(await permissions.decide(agentRunning(), 'Read', read(docPath)), { decision: null }, 'the doc: left to the run\'s rules');
});
