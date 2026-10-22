import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginEnvPatch, parseEnv, readLoginEnv } from '../desktop/shell-env.js';

const unix = process.platform !== 'win32';

/** A fake login shell: prints `noise`, then runs the script it is given. */
async function fakeShell(body) {
  const path = join(await mkdtemp(join(tmpdir(), 'ponjo-shell-')), 'shell');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test('parseEnv reads what env -0 printed between the markers', () => {
  const out = 'motd\nM' + 'A=1\0B=x=y\0C=two\nlines\0' + 'M' + 'prompt';
  assert.deepEqual(parseEnv(out, 'M'), { A: '1', B: 'x=y', C: 'two\nlines' });
  assert.equal(parseEnv('no markers', 'M'), null);
  assert.equal(parseEnv('only one M', 'M'), null);
});

test('loginEnvPatch adds what is missing and puts the login PATH first', () => {
  const current = { PATH: '/usr/bin:/bin', HOME: '/h', KEEP: 'app' };
  const login = { PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/h', KEEP: 'shell', ANTHROPIC_API_KEY: 'k', PWD: '/x', SHLVL: '2', _: '/usr/bin/env' };
  assert.deepEqual(loginEnvPatch(current, login), { ANTHROPIC_API_KEY: 'k', PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
  assert.deepEqual(loginEnvPatch(current, null), {});
  assert.deepEqual(loginEnvPatch({ PATH: '/a:/b' }, { PATH: '/a' }), {});
});

test('readLoginEnv reads the shell environment past what shell files print', { skip: !unix }, async () => {
  const shell = await fakeShell('echo "Welcome!"; FROM_RC=yes; export FROM_RC; exec /bin/sh -c "$2"');
  const env = await readLoginEnv({ shell });
  assert.equal(env.FROM_RC, 'yes');
  assert.ok(env.PATH);
});

test('readLoginEnv gives null for a shell that hangs, fails or is missing', { skip: !unix }, async () => {
  assert.equal(await readLoginEnv({ shell: await fakeShell('sleep 10'), timeout: 200 }), null);
  assert.equal(await readLoginEnv({ shell: await fakeShell('exit 1') }), null);
  assert.equal(await readLoginEnv({ shell: '/no/such/shell' }), null);
  assert.equal(await readLoginEnv({ shell: '' }), null);
});
