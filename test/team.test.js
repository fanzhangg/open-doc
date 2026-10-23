// Team (src/host/team.js): who is on a project, stored in the config folder
// by the project folder's real path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeam } from '../src/host/team.js';

async function newTeam() {
  const settingsDir = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fan' }));
  await mkdir(join(settingsDir, 'buddies'));
  await writeFile(join(settingsDir, 'buddies', 'Clippy.md'), 'Mine.\n');
  const folder = await mkdtemp(join(tmpdir(), 'ponjo-project-'));
  await mkdir(join(folder, '.ponjo', 'buddies'), { recursive: true });
  await writeFile(join(folder, '.ponjo', 'buddies', 'Editor.md'), 'Edits.\n');
  const linkOf = (secret) => `page?room=${secret}`;
  return { settingsDir, folder, team: (at = folder) => createTeam(at, { settingsDir, linkOf }) };
}

test('a join waits on the owner; Allow, Set and Remove are kept, by the project folder', async () => {
  const { team, folder } = await newTeam();
  const first = team();
  let changes = 0;
  first.onChange(() => changes++);
  assert.equal(await first.join({ id: 'p_a', name: 'Noor' }), 'asked');
  assert.equal(await first.join({ id: 'p_a', name: 'Noor' }), 'waiting');
  assert.equal(changes, 1);
  await first.allow('p_a', 'write');
  assert.equal(await first.join({ id: 'p_a', name: 'whatever' }), 'member');
  assert.equal(await first.levelOf('p_a'), 'write');
  await first.set('p_a', { level: 'read' });
  await first.link();
  const { link } = await first.list();
  assert.match(link, /^page\?room=/);

  const again = team(); // as after a restart
  assert.deepEqual(await again.list(), { members: [{ id: 'p_a', name: 'Noor', level: 'read' }], pending: [], link });
  await again.remove('p_a');
  assert.equal(await team().levelOf('p_a'), null);

  // Another folder, such as the project moved: no team.
  assert.deepEqual(await team(join(folder, 'elsewhere')).list(), { members: [], pending: [], link: null });
});

test('names are unique on a project, people\'s and AI buddies\' together; levels are read or write', async () => {
  const { team } = await newTeam();
  const t = team();
  for (const name of ['FAN', 'Clippy', 'editor']) await assert.rejects(t.join({ id: 'p_b', name }), { code: 'name_taken' });
  await assert.rejects(t.join({ id: 'p_b', name: 'no spaces' }), { code: 'bad_input' });
  await assert.rejects(t.join({ id: '', name: 'Ada' }), { code: 'bad_input' });
  await t.join({ id: 'p_b', name: 'Ada' });
  await assert.rejects(t.join({ id: 'p_c', name: 'ada' }), { code: 'name_taken' });
  await assert.rejects(t.allow('p_b', 'owner'), { code: 'bad_input' });
  await assert.rejects(t.allow('p_c', 'read'), { code: 'not_found' });
  assert.deepEqual(await t.names(), ['Ada']);
  await t.remove('p_b'); // turned down
  assert.deepEqual(await t.list(), { members: [], pending: [], link: null });
  await assert.rejects(createTeam('x', { settingsDir: tmpdir() }).link(), { code: 'no_relay' });
});
