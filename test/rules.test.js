// Every rule of Editing (docs/architecture.md) has a test whose title
// starts with its id (docs/testing-ci.md, Editing tests); a rule whose row
// says "No test yet" waits for one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every editing rule has a test named by its id', async () => {
  const doc = await readFile(join(root, 'docs', 'architecture.md'), 'utf8');
  const start = doc.indexOf('### Editing');
  const editing = doc.slice(start, doc.indexOf('\n### ', start + 1));
  const rules = [...editing.matchAll(/^\| ([A-E]\d+) \|(.*)$/gm)].filter(([, , row]) => !row.includes('No test yet')).map(([, id]) => id);
  assert.ok(rules.includes('A1'), 'the rules are read');
  const tested = new Set();
  for (const file of await readdir(join(root, 'test'), { recursive: true })) {
    if (!file.endsWith('.test.js')) continue;
    for (const [, ids] of (await readFile(join(root, 'test', file), 'utf8')).matchAll(/\btest\(\s*[`'"]((?:[A-E]\d+ )*[A-E]\d+):/g)) {
      for (const id of ids.split(' ')) tested.add(id);
    }
  }
  assert.deepEqual(rules.filter((id) => !tested.has(id)), [], 'rules with no test');
});
