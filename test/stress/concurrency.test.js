// Concurrency stress tests, asserted by invariant rather than by an exact
// transcript, and kept out of `npm test` (which globs test/*.test.js); CI
// runs them with `npm run test:stress`.
//
// Many buddies answering many asks at once while the human types: every ask
// gets one reply, every buddy edit lands, and no human text is lost. A
// fixed seed by default; another can be passed as STRESS_SEED.
//
// The protocol fuzz (docs/testing-ci.md, Editing tests): a real DocService
// on a temp file and 1 to 4 pages (web/client.js), each on a fake line that
// delays, drops (calls fail `offline`) and loses events, while the host
// starts again, its writes fail, the file changes outside and teammates are
// set to Read and back. Each case is
// a list of steps made from a seed, run one step at a time, so a seed runs
// the same every time. A fixed 300 seeds, or random ones for STRESS_MINUTES;
// a failing case is shrunk to the fewest steps that still fail and printed,
// and the fix adds it to regressions.json, which every run replays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '../../web/client.js';
import { openDoc } from '../../src/host/doc-service.js';
import { readDoc } from '../../src/store/files.js';
import { fakeConfig, openTestDoc, readOnly, tempDoc, until } from '../helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A small seeded PRNG so a failing run can be replayed from its seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('buddies x asks while the human types: one reply each, every edit lands, no human text lost', { timeout: 120_000 }, async () => {
  const seed = Number(process.env.STRESS_SEED ?? 7);
  const random = rng(seed);
  const buddies = ['Ana', 'Ben', 'Cy', 'Di'];
  const asksEach = 5;
  // One paragraph per ask for the buddies, and some for the human.
  const asks = buddies.flatMap((name) => Array.from({ length: asksEach }, (_, i) => ({ name, key: `${name}-${i}` })));
  const human = Array.from({ length: 10 }, (_, i) => `human-${i}`);
  const doc = ['# Stress', ...asks.map((a) => `Para ${a.key} old.`), ...human.map((h) => `Para ${h} old.`)].join('\n\n') + '\n';
  const docPath = await tempDoc(doc);

  const settingsDir = await fakeConfig();
  const { doc: opened, call, edit, state } = await openTestDoc(docPath, { settingsDir, buddies: Object.fromEntries(buddies.map((name) => [name, '\n'])) });
  try {
    // Every ask at once, in a random order, while the human edits their own paragraphs.
    const order = asks.map((a) => [random(), a]).sort((x, y) => x[0] - y[0]).map(([, a]) => a);
    const posting = Promise.all(order.map((a) => call('comment', { anchor: null, body: `@${a.name} replace "Para ${a.key} old." with "Para ${a.key} new."` })));
    for (const h of human) {
      // From the doc as it was read: moved over a buddy's edit that landed since.
      const now = await state();
      await edit(now.text.replace(`Para ${h} old.`, `Para ${h} typed.`), now);
      await sleep(Math.floor(random() * 40));
    }
    await posting;

    const deadline = Date.now() + 90_000;
    let threads;
    for (;;) {
      threads = (await state()).threads;
      if (threads.length === asks.length && threads.every((t) => t.comments.length >= 2)) break;
      if (Date.now() > deadline) throw new Error(`seed ${seed}: not every ask was answered`);
      await sleep(100);
    }
    await sleep(500); // nothing more arrives
    threads = (await state()).threads;
    for (const t of threads) assert.equal(t.comments.length, 2, `seed ${seed}: ${t.id} answered once`);
    assert.ok(threads.every((t) => !t.comments[1].failed), `seed ${seed}: no run failed`);
    const text = await readFile(docPath, 'utf8');
    for (const a of asks) assert.ok(text.includes(`Para ${a.key} new.`), `seed ${seed}: ${a.key}'s edit landed`);
    for (const h of human) assert.ok(text.includes(`Para ${h} typed.`), `seed ${seed}: ${h} kept`);
  } finally {
    await opened.close();
  }
});

const REGRESSIONS = JSON.parse(await readFile(new URL('regressions.json', import.meta.url), 'utf8'));
const STEPS = ['type', 'type', 'type', 'up', 'up', 'up', 'down', 'down', 'down', 'down', 'lose', 'drop', 'connect', 'restart', 'readOnly', 'writable', 'outside', 'level'];

// A case made from `seed`: { pages, crlf, deletes, steps }, each step
// [kind, page, a, b] with `a` and `b` in [0, 1), where it acts.
function caseOf(seed) {
  const random = rng(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  return {
    pages: 1 + Math.floor(random() * 4),
    crlf: random() < 0.3,
    deletes: random() < 0.5,
    steps: Array.from({ length: 20 + Math.floor(random() * 60) }, () => [pick(STEPS), Math.floor(random() * 4), random(), random()]),
  };
}

// An offset of `text` near fraction `f` of it, as a caret can be: never
// inside a surrogate pair, nor inside a token typed (so each stays whole).
function offset(text, f) {
  let at = Math.floor(f * (text.length + 1));
  const open = text.lastIndexOf('‹', at - 1);
  if (open !== -1 && text.indexOf('›', open) >= at) at = open;
  return at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]) ? at - 1 : at;
}

const FIRST = 'Alpha 𠀀 one.\n\nBeta two.\n\nGamma three.\n';
const TOKEN = /‹[po][\d.]+[^›]*›/g;

// How many of each character `texts` hold.
function characters(...texts) {
  const counts = new Map();
  for (const char of texts.join('')) counts.set(char, (counts.get(char) ?? 0) + 1);
  return counts;
}
const turn = () => new Promise((done) => setImmediate(done));

// Run case `c`; resolves to what broke, or null.
async function run(c) {
  const docPath = await tempDoc(c.crlf ? FIRST.replaceAll('\n', '\r\n') : FIRST);
  const settingsDir = await fakeConfig();
  let host = null;
  const open = async () => {
    let doc = null;
    doc = await openDoc(docPath, { settingsDir, emit: (name, data) => name === 'ops' && doc === host && told(data) });
    return doc;
  };
  const told = (event) => {
    host.outside += event.id === null ? 1 : 0; // no page's: a change made outside
    for (const page of pages) if (page.online) page.down.push({ event });
  };
  host = Object.assign(await open(), { outside: 0 });
  let owner = await host.owner();
  // What the pages typed, and other programs wrote, each with its own
  // number, all as long, so no piece of one reads as another.
  let typed = 0;
  const number = () => String(++typed).padStart(4, '0');
  const typedTokens = [];
  const outsideTokens = [];
  const pages = [];
  for (let k = 0; k < c.pages; k++) {
    // The first is the owner; the others teammates who can edit, or read.
    const page = { k, online: true, up: [], down: [], held: [], errors: [], level: k === 0 ? 'owner' : 'write' };
    const who = k === 0 ? () => owner : () => ({ id: `p_${k}`, name: `P${k}`, kind: 'human', level: page.level });
    page.view = { text: '', getText: () => page.view.text, selection: () => null };
    page.client = createClient({
      view: page.view,
      call: (type, arg) => new Promise((resolve, reject) => (page.online ? page.up : page.held).push({ type, arg, who, resolve, reject })),
      show: (text) => { page.view.text = text; },
      caughtUp: (state) => { page.reading = state.level === 'read'; }, // its view can no longer be typed in
      onError: (error) => page.errors.push(error),
    });
    const state = await host.call('state', {}, who());
    page.view.text = state.text;
    page.client.start(state);
    pages.push(page);
  }
  const offline = () => Object.assign(new Error('The host is offline'), { code: 'offline' });
  const drop = (page) => {
    page.online = false;
    for (const call of page.up.splice(0)) call.reject(offline());
    for (const { answer } of page.down.splice(0)) answer?.reject(offline());
  };
  // A call reaches the host; its answer goes back down the line, after the events it caused.
  const deliver = async (page) => {
    const call = page.up.shift();
    const answer = { reject: call.reject };
    try {
      answer.resolve = call.resolve.bind(null, await host.call(call.type, call.arg, call.who()));
    } catch (error) {
      answer.resolve = call.reject.bind(null, error);
    }
    if (page.online) page.down.push({ answer });
    else call.reject(offline());
  };
  const take = (page) => {
    const { event, answer, hello } = page.down.shift();
    if (event) page.client.receive(event);
    else if (hello) page.client.catchUp(); // or `level`
    else answer.resolve();
  };
  // The owner sets teammate `page` to `level`: a page online is told.
  const setLevel = (page, level) => {
    page.level = level;
    if (page.online) page.down.push({ hello: true });
  };
  const connect = (page) => {
    page.online = true;
    page.down.push({ hello: true });
    page.up.push(...page.held.splice(0));
  };
  let writable = true;
  try {
    for (const [kind, k, a, b] of c.steps) {
      const page = pages[k % pages.length];
      if (kind === 'type' && !page.reading) {
        const text = page.view.text;
        const from = offset(text, a);
        if (c.deletes && b < 0.3) page.view.text = text.slice(0, from) + text.slice(offset(text, Math.min(1, a + b / 10)));
        else {
          const token = `‹p${page.k}.${number()}${b < 0.3 ? '😀' : ''}›${b > 0.8 ? '\n' : ''}`;
          typedTokens.push(token);
          page.view.text = text.slice(0, from) + token + text.slice(from);
        }
        page.client.edited();
      } else if (kind === 'up' && page.up.length > 0) await deliver(page);
      else if (kind === 'down' && page.down.length > 0) take(page);
      else if (kind === 'lose') {
        const lost = page.down.findIndex((message) => message.event);
        if (lost !== -1) page.down.splice(lost, 1);
      } else if (kind === 'drop' && page.online) drop(page);
      else if (kind === 'connect' && !page.online) connect(page);
      else if (kind === 'level' && page.k > 0) setLevel(page, page.level === 'read' ? 'write' : 'read');
      else if (kind === 'restart') {
        for (const each of pages) if (each.online) drop(each);
        const old = host;
        host = null;
        await old.close().catch(() => {}); // a last write that fails is lost, as in a crash
        host = Object.assign(await open(), { outside: 0 });
        owner = await host.owner();
      } else if (kind === 'readOnly' && writable) {
        writable = false;
        await readOnly(docPath, true);
      } else if (kind === 'writable' && !writable) {
        writable = true;
        await readOnly(docPath, false);
      } else if (kind === 'outside' && writable) {
        // Another program adds a line, or deletes one that holds nothing
        // typed: the host takes it, and tells it.
        const was = host.outside;
        const lines = (await readFile(docPath, 'utf8')).split(/(?<=\n)/);
        const plain = lines.map((line, k) => [line, k]).filter(([line]) => !/[‹›]/.test(line) && line.trim() !== '');
        if (b < 0.5 && plain.length > 0) lines.splice(plain[Math.floor(a * plain.length)][1], 1);
        else {
          const line = `‹o${number()}›\n`;
          outsideTokens.push(line);
          lines.splice(Math.floor(a * (lines.length + 1)), 0, c.crlf ? line.replace('\n', '\r\n') : line);
        }
        await writeFile(docPath, lines.join(''));
        await until(() => host.outside > was, 'the outside change taken', 10_000);
      }
      for (let i = 0; i < 5; i++) await turn();
    }
    // The writers stop; the lines come back and carry all there is, and
    // everyone may edit again: what was typed while set to Read lands too.
    if (!writable) await readOnly(docPath, false);
    for (const page of pages) if (!page.online) connect(page);
    for (const page of pages) if (page.level === 'read') setLevel(page, 'write');
    const deadline = Date.now() + 20_000;
    for (;;) {
      let moved = false;
      for (const page of pages) {
        while (page.up.length > 0) await deliver(page);
        while (page.down.length > 0) {
          take(page);
          moved = true;
        }
        for (let i = 0; i < 5; i++) await turn();
      }
      const state = await host.call('state', {}, owner);
      if (!moved && pages.every((page) => page.up.length === 0 && page.client.idle() && page.view.text === state.text)) break;
      if (Date.now() > deadline) return `A1: the pages did not converge: ${JSON.stringify({ host: state.text, pages: pages.map((p) => p.view.text) })}`;
      if (!moved) await new Promise((done) => setTimeout(done, 50)); // a write tried again
    }
    const { text } = await host.call('state', {}, owner);
    const disk = await readDoc(docPath);
    if (disk.text !== text) return `A1: the file is not the host's text: ${JSON.stringify({ file: disk.text, host: text })}`;
    if (c.crlf && /(?<!\r)\n/.test(await readFile(docPath, 'utf8'))) return 'A5: the file lost its CRLF';
    if (/�|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) return `A5: a broken character: ${JSON.stringify(text)}`;
    // Each character is there no more times than anyone wrote it and, when
    // no page deleted, at least as many times as the pages typed it (other
    // programs delete only what holds nothing typed): where it is, of two
    // places an edit could be, does not count.
    const twice = (text.match(TOKEN) ?? []).filter((token, k, all) => all.indexOf(token) !== k);
    const now = characters(text);
    const most = characters(FIRST, ...typedTokens, ...outsideTokens);
    const least = characters(...typedTokens);
    if (twice.length > 0 || [...now].some(([char, n]) => n > (most.get(char) ?? 0))) return `A3: landed twice: ${twice.join(' ')} in ${JSON.stringify(text)}`;
    if (!c.deletes && [...least].some(([char, n]) => (now.get(char) ?? 0) < n)) return `A2: typing lost, in ${JSON.stringify(text)}`;
    return null;
  } finally {
    if (!writable) await readOnly(docPath, false);
    await host?.close().catch(() => {});
  }
}

// The fewest steps of failing case `c` that still fail.
async function shrink(c) {
  let steps = c.steps;
  for (let size = Math.ceil(steps.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let at = 0; at < steps.length;) {
      const fewer = [...steps.slice(0, at), ...steps.slice(at + size)];
      if (await run({ ...c, steps: fewer })) steps = fewer;
      else at += size;
    }
  }
  return { ...c, steps };
}

const minutes = Number(process.env.STRESS_MINUTES ?? 0);
test('A1 A2 A3 A5 C1 C3 C4 C5 C7: pages on lines that fail, a host that starts again, writes that fail, outside changes, levels that change: one text everywhere, nothing lost or twice', { timeout: minutes * 60_000 + 600_000 }, async () => {
  const cases = REGRESSIONS.map((c, k) => ({ name: `regression ${k}`, c }));
  if (minutes > 0) {
    const end = Date.now() + minutes * 60_000;
    while (Date.now() < end) {
      const seed = Math.floor(Math.random() * 2 ** 32);
      const broke = await run(caseOf(seed));
      if (broke) cases.push({ name: `seed ${seed}`, c: caseOf(seed), broke });
      if (broke) break;
    }
  } else for (let seed = 1; seed <= 300; seed++) cases.push({ name: `seed ${seed}`, c: caseOf(seed) });
  for (const { name, c, broke = await run(c) } of cases) {
    if (!broke) continue;
    const shrunk = await shrink(c);
    assert.fail(`${name}: ${broke}\nshrunk, for regressions.json: ${JSON.stringify(shrunk)}\nwhich gives: ${await run(shrunk)}`);
  }
});
