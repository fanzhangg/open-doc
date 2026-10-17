// One app, no server (docs/v2-milestones.md, M2): windows talk to the doc
// host over message ports, so nothing in the app opens a port, and there is
// no CLI to install. On Linux the smoke test also checks the running app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function sources(dir) {
  const found = [];
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(c|m)?js$|\.html$/.test(entry.name)) found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

test('nothing in the app starts a server or talks over HTTP', async () => {
  const files = (await Promise.all(['src', 'desktop', 'web'].map(sources))).flat();
  assert.ok(files.length > 20);
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const pattern of [/\bcreateServer\b/, /['"]node:(http|https|net|dgram)['"]/, /\bEventSource\b/, /\bfetch\(/, /127\.0\.0\.1|localhost/]) {
      assert.doesNotMatch(text, pattern, `${file.slice(ROOT.length + 1)}`);
    }
  }
});

test('package.json has no bin: there is no CLI', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin, undefined);
  assert.ok(!pkg.files.includes('bin/'));
});
