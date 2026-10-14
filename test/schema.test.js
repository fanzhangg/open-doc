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
