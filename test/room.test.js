// Room (src/host/room.js): a project's room while its owner hosts it, in
// memory only. The relay is a stand-in here; test/relay.test.js has the
// real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom } from '../src/host/room.js';

// A project with the buddies Editor and Clippy, its owner fan, and its room, put on a
// stand-in relay: `lines` holds each room put there ({ secret, stopped }).
async function newRoom({ reachable = true } = {}) {
  const settingsDir = await mkdtemp(join(tmpdir(), 'ponjo-config-'));
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify({ name: 'fan' }));
  await mkdir(join(settingsDir, 'buddies'));
  await writeFile(join(settingsDir, 'buddies', 'Clippy.md'), 'Mine.\n');
  const folder = await mkdtemp(join(tmpdir(), 'ponjo-project-'));
  await mkdir(join(folder, '.ponjo', 'buddies'), { recursive: true });
  await writeFile(join(folder, '.ponjo', 'buddies', 'Editor.md'), 'Edits.\n');
  const lines = [];
  const host = (secret) => {
    const line = { secret, stopped: null, link: `page?room=${secret}`, joined: reachable ? Promise.resolve() : Promise.reject(new Error('no relay')) };
    line.stop = (reason) => { line.stopped = reason ?? true; };
    lines.push(line);
    return line;
  };
  return { settingsDir, folder, lines, room: createRoom(folder, { settingsDir, host }) };
}

// Every file under `dir`, as paths.
const files = async (dir) => (await readdir(dir, { recursive: true })).sort();

test('anyone with the link is in at once, at Edit; a taken name gets a number; nothing is written', async () => {
  const { settingsDir, folder, room, lines } = await newRoom();
  const before = [await files(settingsDir), await files(folder)];
  assert.equal(room.list(), null, 'closed until opened');
  await assert.rejects(room.join({ id: 'p_a', name: 'Ada' }), { code: 'closed' });
  let changes = 0;
  room.onChange(() => changes++);
  await room.open();
  assert.equal(changes, 1);
  assert.equal(room.list().link, `page?room=${lines[0].secret}`);
  assert.ok(lines[0].secret.length >= 32, 'a secret no one guesses');

  await room.join({ id: 'p_a', name: 'Ada' });
  for (const [id, name] of [['p_b', 'ada'], ['p_c', 'FAN'], ['p_d', 'Editor'], ['p_e', 'Clippy'], ['p_f', 'Ada']]) await room.join({ id, name });
  assert.deepEqual(room.list().players.map((p) => [p.name, p.level]), [['Ada', 'write'], ['ada2', 'write'], ['FAN2', 'write'], ['Editor2', 'write'], ['Clippy2', 'write'], ['Ada3', 'write']]);
  await room.join({ id: 'p_a', name: 'Someone' }); // again, as after a dropped line: the same player
  assert.equal(room.nameOf('p_a'), 'Ada');
  assert.deepEqual(room.names(), ['Ada', 'ada2', 'FAN2', 'Editor2', 'Clippy2', 'Ada3']);
  for (const who of [{ id: '', name: 'Ada' }, { id: 'p_g', name: 'no spaces' }, { id: 'p_g' }]) await assert.rejects(room.join(who), { code: 'bad_input' });

  room.setLevel('p_a', 'read');
  assert.equal(room.levelOf('p_a'), 'read');
  assert.throws(() => room.setLevel('p_a', 'owner'), { code: 'bad_input' });
  assert.throws(() => room.setLevel('p_z', 'read'), { code: 'not_found' });
  assert.deepEqual([await files(settingsDir), await files(folder)], before, 'nothing about players on disk');
});

test('a locked room takes no new id, but its players come back; a kicked id never does', async () => {
  const { room } = await newRoom();
  await room.open();
  await room.join({ id: 'p_a', name: 'Ada' });
  await room.join({ id: 'p_b', name: 'Bo' });
  room.lock(true);
  await assert.rejects(room.join({ id: 'p_c', name: 'Cy' }), { code: 'locked' });
  await room.join({ id: 'p_a', name: 'Ada' });
  assert.equal(room.list().locked, true);

  room.lock(false);
  room.kick('p_b');
  assert.equal(room.levelOf('p_b'), null);
  await assert.rejects(room.join({ id: 'p_b', name: 'Bo' }), { code: 'kicked' });
  assert.deepEqual(room.list().players.map((p) => p.name), ['Ada']);
  assert.throws(() => room.kick('p_b'), { code: 'not_found' });
});

test('Close room ends it: its pages turned away, its players and kicks gone; the next room has a new secret', async () => {
  const { room, lines } = await newRoom();
  await room.open();
  await room.join({ id: 'p_a', name: 'Ada' });
  room.kick('p_a');
  room.close();
  assert.equal(lines[0].stopped, 'closed');
  assert.equal(room.list(), null);
  assert.equal(room.levelOf('p_a'), null);

  await room.open();
  assert.notEqual(lines[1].secret, lines[0].secret);
  await room.join({ id: 'p_a', name: 'Ada' });
  assert.deepEqual(room.list(), { link: `page?room=${lines[1].secret}`, locked: false, players: [{ id: 'p_a', name: 'Ada', level: 'write' }] });
});

test('a room the relay cannot take stays closed, and says so; no relay, no room', async () => {
  const { room, lines } = await newRoom({ reachable: false });
  await assert.rejects(room.open(), { code: 'offline' });
  assert.equal(room.list(), null);
  assert.equal(lines[0].stopped, true);
  await assert.rejects(createRoom('x', { settingsDir: tmpdir() }).open(), { code: 'no_relay' });
});
