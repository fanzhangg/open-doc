import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { project } from '../src/core/project.js';
import { locate } from '../src/core/anchor.js';

const schema = JSON.parse(readFileSync(new URL('../spec/opendoc.schema.json', import.meta.url), 'utf8'));
const docBytes = readFileSync(new URL('../spec/examples/plan.md', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../spec/examples/plan.md.opendoc.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ strict: true, validateFormats: false, allErrors: true }).compile(schema);

const clone = (value) => structuredClone(value);

test('the example sidecar is valid', () => {
  assert.ok(validate(example), JSON.stringify(validate.errors, null, 2));
});

test('the example docHash and anchors match the example doc', () => {
  assert.equal(example.docHash, 'sha256:' + createHash('sha256').update(docBytes).digest('hex'));
  const text = project(docBytes.toString('utf8')).text;
  for (const thread of example.threads.filter((t) => t.anchor)) {
    const found = locate(text, thread.anchor);
    assert.equal(found?.method, 'exact');
    assert.equal(found.start, thread.anchor.start);
  }
});

test('unknown fields and x- sections are allowed', () => {
  const sidecar = clone(example);
  sidecar['x-acme'] = { anything: true };
  sidecar.settings = { theme: 'dark' };
  sidecar.threads[0]['x-acme'] = 1;
  assert.ok(validate(sidecar));
});

test('working: a list of agents, the single object of older sidecars, or null', () => {
  const since = '2026-10-14T18:00:00.000Z';
  for (const working of [[{ by: 'claude', since }, { by: 'muse', since }], { by: 'claude', since }, null]) {
    const sidecar = clone(example);
    sidecar.threads[0].working = working;
    assert.ok(validate(sidecar), JSON.stringify(validate.errors));
  }
  for (const working of [[{ by: 'claude' }], [{ by: '@bad', since }], 'claude']) {
    const sidecar = clone(example);
    sidecar.threads[0].working = working;
    assert.ok(!validate(sidecar), JSON.stringify(working));
  }
});

test('invalid sidecars are rejected', () => {
  const cases = {
    'unknown major version': (s) => { s.opendoc = 2; },
    'docHash in the wrong form': (s) => { s.docHash = 'md5:abc'; },
    'missing docHash': (s) => { delete s.docHash; },
    'doc with a directory': (s) => { s.doc = 'docs/plan.md'; },
    'bad thread id': (s) => { s.threads[0].id = 'thread-1'; },
    'empty messages': (s) => { s.threads[0].messages = []; },
    'unknown author kind': (s) => { s.threads[0].messages[0].author.kind = 'bot'; },
    'empty quote': (s) => { s.threads[0].anchor.exact = ''; },
    'context longer than 32': (s) => { s.threads[0].anchor.prefix = 'p'.repeat(33); },
    'bad participant name': (s) => { s.participants[0].name = '@fzhan'; },
    'unknown status': (s) => { s.threads[0].status = 'closed'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const sidecar = clone(example);
    mutate(sidecar);
    assert.equal(validate(sidecar), false, name);
  }
});

test('edits and undo notices on messages are valid; malformed ones are rejected', () => {
  const sidecar = clone(example);
  const edit = { before: 'load', after: 'peak load', prefix: 'the extra ', suffix: '.', start: 120 };
  const [first] = sidecar.threads[0].messages;
  sidecar.threads[0].messages.push(
    { id: 'm_reply01', author: { name: 'claude', kind: 'agent' }, body: 'Done.', mentions: [], createdAt: first.createdAt, edits: [edit, { ...edit, before: '', scope: 'run' }] },
    { id: 'm_undo001', author: first.author, body: "Undid claude's edit", mentions: [], createdAt: first.createdAt, undoes: 'm_reply01' },
  );
  assert.ok(validate(sidecar), JSON.stringify(validate.errors, null, 2));

  const cases = {
    'empty edits': (m) => { m.edits = []; },
    'edit without after': (m) => { delete m.edits[0].after; },
    'edit context longer than 32': (m) => { m.edits[0].suffix = 's'.repeat(33); },
    'negative start': (m) => { m.edits[0].start = -1; },
    'unknown scope': (m) => { m.edits[0].scope = 'doc'; },
    'undoes not a message id': (m) => { m.undoes = 'reply'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const copy = clone(sidecar);
    mutate(copy.threads[0].messages.at(-2));
    assert.equal(validate(copy), false, name);
  }
});

test('proposals and apply notices on messages are valid; malformed ones are rejected', () => {
  const sidecar = clone(example);
  const change = { before: 'extra load', after: 'extra peak load', prefix: 'handle the ', suffix: '.', start: 120 };
  const edit = { before: '', after: 'peak ', prefix: 'handle the extra ', suffix: 'load.', start: 126 };
  const [first] = sidecar.threads[0].messages;
  sidecar.threads[0].messages.push(
    { id: 'm_prop0001', author: { name: 'claude', kind: 'agent' }, body: 'Suggest adding "peak".', mentions: [], createdAt: first.createdAt, proposal: [change, { ...change, before: 'sync', after: '' }] },
    { id: 'm_apply001', author: first.author, body: "Applied claude's proposal", mentions: [], createdAt: first.createdAt, applies: 'm_prop0001', edits: [edit] },
  );
  assert.ok(validate(sidecar), JSON.stringify(validate.errors, null, 2));

  const cases = {
    'empty proposal': (m) => { m.proposal = []; },
    'change with empty before': (m) => { m.proposal[0].before = ''; },
    'change without after': (m) => { delete m.proposal[0].after; },
    'change context longer than 32': (m) => { m.proposal[0].prefix = 'p'.repeat(33); },
    'applies not a message id': (m, notice) => { notice.applies = 'proposal'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const copy = clone(sidecar);
    mutate(copy.threads[0].messages.at(-2), copy.threads[0].messages.at(-1));
    assert.equal(validate(copy), false, name);
  }
});
