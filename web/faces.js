// Avatars: a face drawn from the id (a person's, the name), from one set of parts, each body a
// little uneven as if drawn by hand. People are round, wear a hat that says
// who they are on the project (the owner a crown, a teammate a top hat) and
// keep their face everywhere. Buddies in a doc take parts as unlike each
// other's as can be (setBuddies), and a colour no other buddy there has
// (colorSlots); people there take the colours the buddies left (setPeople).
//
// Everything is drawn in a 100×100 box. Strokes and dots are sized to stay
// legible down to the 18px faces in a thread's footer; below 24px the
// extras and the tilt go (app.css), so a face stays plain.

import { colorSlots } from '../src/core/buddies.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#1f1d24';
const STROKE = 5.5;
const GOLD = '#f5b301'; // the owner's crown

// [lightness, chroma, hue] in OKLCH: eight hues evenly apart, sunflower
// first, a touch lighter so it reads as yellow.
const COLORS = [[0.84, 0.17, 85], ...[135, 180, 225, 270, 315, 0, 45].map((hue) => [0.78, 0.14, hue])];
let slots = colorSlots([]);
let looks = new Map();

let names = new Map(); // buddy id → its name now
let buddyIds = [];
let people = []; // the names of the people in this doc
let owner = null; // the owner's id: the one person with a crown

/** The owner's id, so their face wears the crown and everyone else's a top hat. */
export function setOwner(id) {
  owner = id;
}

export const isOwner = (id) => id === owner;

/** The buddies in this doc ([{ id, name }]), so their faces and colours differ. */
export function setBuddies(buddies) {
  names = new Map(buddies.map((b) => [b.id, b.name]));
  buddyIds = buddies.map((b) => b.id);
  looks = spread([...colorSlots(buddyIds).keys()]);
  recolor();
}

/**
 * The names of the people in this doc, so their colours differ from each
 * other's and the buddies'; whether any of their colours changed.
 */
export function setPeople(list) {
  const before = people.map((name) => slots.get(name.toLowerCase()));
  people = list;
  recolor();
  return people.length !== before.length || people.some((name, i) => slots.get(name.toLowerCase()) !== before[i]);
}

// The buddies keep theirs, so their edits keep their colour; people take what is left.
function recolor() {
  const own = colorSlots(buddyIds);
  slots = new Map([...own, ...colorSlots(people, new Set(own.values()))]);
}

/** Buddy `id`'s name now; `fallback` (the name in a comment) when it is not here. */
export const nameOf = (id, fallback = id) => names.get(id) ?? fallback;

/** Buddy `id`'s colour (a person's: the name), a little lighter (`lift` > 0) or darker. */
export function buddyColor(id, lift = 0) {
  const [lightness, chroma, hue] = colorOf(id);
  return `oklch(${(lightness + lift).toFixed(2)} ${chroma} ${hue})`;
}

function colorOf(name) {
  const key = name.toLowerCase();
  return COLORS[slots.get(key) ?? colorSlots([key]).get(key)];
}

let ids = 0; // gradient ids, unique per page

/** @param {string} id */
export const agentFace = (id) => face(id, looks.get(id.toLowerCase()) ?? drawn(id));

/** @param {string} name @param {string} id */
export const personFace = (name, id = name) => face(name, drawn(name), 'circle', isOwner(id) ? 'crown' : 'tophat');

function face(name, look, kind = look.body, hat = null) {
  const body = drawBody(kind, name);
  const svg = node('svg', { viewBox: '0 0 100 100', class: 'pj-face', 'aria-hidden': 'true' });
  const id = `pj-face-${++ids}`;
  const gradient = node('radialGradient', { id, cx: '0.34', cy: '0.28', r: '0.9' });
  const stops = [buddyColor(name, 0.08), buddyColor(name), buddyColor(name, -0.07)];
  gradient.append(...[0, 0.55, 1].map((offset, i) => node('stop', { offset: String(offset), 'stop-color': stops[i] })));
  const defs = node('defs', {});
  defs.append(gradient);

  // The whole face tilts a touch, body and all, a hat a little more.
  const tilted = node('g', { class: 'pj-face-tilt', transform: `rotate(${f(look.tilt)} 50 50)` });
  const features = node('g', { class: 'pj-face-look' });
  tilted.append(node('path', { class: 'pj-face-body', d: body.d, fill: `url(#${id})` }), features);
  if (hat) tilted.append(drawHat(hat, look.tilt));
  svg.append(defs, tilted);
  drawFace(features, look, body.cy, colorOf(name)[2]);
  return svg;
}

// A crown or a top hat on the head, tipped the way the face leans: a flat
// silhouette, a crown in gold, a top hat in the text's colour so it reads on
// any page.
const HATS = {
  crown: 'M28 28L25 8L38.5 17.5L50 3L61.5 17.5L75 8L72 28Z',
  tophat: 'M35 22L36 3Q50 0 64 3L65 22Q77 23 79 25Q80 30 74 30L26 30Q20 30 21 25Q23 23 35 22Z',
};

// It sits on the crown of the head, a little above the box.
function drawHat(hat, tilt) {
  const tipped = node('g', { class: 'pj-face-tilt', transform: `rotate(${f(tilt * 0.5 + (tilt < 0 ? -6 : 6))} 50 8)` });
  const color = hat === 'crown' ? GOLD : 'currentColor';
  tipped.append(node('path', { class: 'pj-face-hat', d: HATS[hat], fill: color, stroke: color, 'stroke-width': '3', 'stroke-linejoin': 'round', transform: 'translate(50 13) scale(0.68) translate(-50 -30)' }));
  return tipped;
}

// The parts `name` picks, drawn from the name.
function drawn(name) {
  const rand = random(seed(name));
  const body = pick(rand, BODIES);
  const tilt = range(rand, -7, 7);
  const eye = pick(rand, EYES);
  const mouth = pick(rand, MOUTHS);
  const extra = pick(rand, EXTRAS.filter((x) => fits(x, eye)));
  return { body, tilt, eye, mouth, extra };
}

// The buddies in turn: each part is the one fewest before have,
// the first such from the one the name picks, so faces in a doc differ as
// much as they can.
function spread(names) {
  const parts = { body: BODIES, eye: EYES, mouth: MOUTHS, extra: EXTRAS };
  const counts = Object.fromEntries(Object.keys(parts).map((part) => [part, new Map()]));
  const count = (part, option) => counts[part].get(option) ?? 0;
  const result = new Map();
  for (const name of names) {
    const look = { ...drawn(name) };
    for (const [part, options] of Object.entries(parts)) {
      const fit = options.filter((option) => part !== 'extra' || fits(option, look.eye));
      const start = Math.max(0, fit.indexOf(look[part]));
      look[part] = [...fit.slice(start), ...fit.slice(0, start)].reduce((best, option) => (count(part, option) < count(part, best) ? option : best));
      counts[part].set(look[part], count(part, look[part]) + 1);
    }
    result.set(name, look);
  }
  return result;
}

// ---- the body ----

// Five shapes far enough apart to tell at 18px. `FACE_Y` is where the face
// sits: lower where the body is wide below.
const UP = -Math.PI / 2;
const BODIES = ['circle', 'square', 'triangle', 'pentagon', 'cloud'];
const FACE_Y = { circle: 52, square: 52, triangle: 60, pentagon: 55, cloud: 52 };

// Body `kind` as `name` draws it: corners a touch off and the outline gently
// uneven, as if by hand, and the same every time.
function drawBody(kind, name) {
  const rand = random(seed(name) + 1);
  let points;
  if (kind === 'circle') {
    points = ring(() => 1);
  } else if (kind === 'cloud') {
    const turn = rand() * Math.PI;
    points = ring((t) => 1 + 0.085 * (2 * Math.abs(Math.cos(3 * (t + turn))) ** 0.5 - 1));
  } else {
    const [sides, start, round, bulge] = { square: [4, Math.PI / 4, 0.32, 0], triangle: [3, UP, 0.36, 0.3], pentagon: [5, UP, 0.3, 0] }[kind];
    const corners = Array.from({ length: sides }, (_, i) => {
      const t = start + (i / sides) * Math.PI * 2 + range(rand, -0.05, 0.05);
      const r = 1 + range(rand, -0.04, 0.04);
      return [r * Math.cos(t), r * Math.sin(t)];
    });
    points = puff(roundCorners(corners, corners.map(() => round + range(rand, -0.04, 0.04))), bulge);
  }
  // Slow waves in the outline, so no side is quite straight and no curve quite even.
  const waves = [2, 3].map((k) => [k, range(rand, 0.006, 0.016), rand() * Math.PI * 2]);
  points = points.map(([x, y]) => {
    const t = Math.atan2(y, x);
    const s = 1 + waves.reduce((sum, [k, amp, phase]) => sum + amp * Math.cos(k * t + phase), 0);
    return [x * s, y * s];
  });
  return { d: outline(points), cy: FACE_Y[kind] };
}

function ring(radius) {
  return Array.from({ length: 160 }, (_, i) => {
    const t = (i / 160) * Math.PI * 2;
    return [radius(t) * Math.cos(t), radius(t) * Math.sin(t)];
  });
}

// Cut each corner `fracs[i]` of the way along its edges and curve through it.
function roundCorners(corners, fracs) {
  const points = [];
  corners.forEach((c, i) => {
    const prev = corners.at(i - 1);
    const next = corners[(i + 1) % corners.length];
    const a = [c[0] + (prev[0] - c[0]) * fracs[i], c[1] + (prev[1] - c[1]) * fracs[i]];
    const b = [c[0] + (next[0] - c[0]) * fracs[i], c[1] + (next[1] - c[1]) * fracs[i]];
    for (let j = 0; j <= 8; j++) {
      const t = j / 8;
      const w = [(1 - t) ** 2, 2 * (1 - t) * t, t * t];
      points.push([0, 1].map((k) => w[0] * a[k] + w[1] * c[k] + w[2] * b[k]));
    }
  });
  return points;
}

// Push the edges out toward a circle, so straight sides bulge a little.
function puff(points, amount) {
  const max = Math.max(...points.map(([x, y]) => Math.hypot(x, y)));
  return points.map(([x, y]) => {
    const s = 1 - amount + (amount * max) / Math.hypot(x, y);
    return [x * s, y * s];
  });
}

// A closed path through `points`, fitted to the box, centred, with a hair of
// room for anti-aliasing.
function outline(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 96 / Math.max(maxX - minX, maxY - minY);
  const fit = points.map(([x, y]) => `${(50 + (x - (minX + maxX) / 2) * scale).toFixed(1)} ${(50 + (y - (minY + maxY) / 2) * scale).toFixed(1)}`);
  return `M${fit.join('L')}Z`;
}

// ---- the face ----

// Only features that still tell apart at 18px.
const EYES = ['dot', 'big', 'happy', 'sleepy', 'squint'];
const MOUTHS = ['smile', 'grin', 'o', 'flat', 'cat'];
const EXTRAS = [null, 'blush', 'glasses'];
// Blush and glasses would crowd big eyes.
const fits = (extra, eye) => eye !== 'big' || !['blush', 'glasses'].includes(extra);

function drawFace(g, { eye, mouth, extra }, cy, hue) {
  const big = eye === 'big';
  const gap = big ? 16 : 14;
  const eyeY = cy - 7;
  const mouthY = eyeY + (big ? 17 : 14);

  const extras = node('g', { class: 'pj-face-extra' }); // gone below 24px (app.css)

  // Cheeks go under everything else, a soft blush below the eyes.
  if (extra === 'blush') {
    const blush = hue > 320 || hue < 15 ? 'hsl(350 85% 50% / 0.45)' : 'hsl(350 95% 72% / 0.6)';
    for (const side of [-1, 1]) extras.append(node('ellipse', { cx: f(50 + side * (gap + 5)), cy: f(eyeY + 9), rx: '5.5', ry: '3.2', fill: blush }));
    g.append(extras);
  }

  // Its own eyes, and focused ones it wears while it works (app.css).
  const eyes = node('g', { class: 'pj-face-eyes' });
  const focused = node('g', { class: 'pj-face-focused' });
  for (const side of [-1, 1]) {
    drawEye(eyes, eye, 50 + side * gap, eyeY, side);
    drawEye(focused, 'focused', 50 + side * gap, eyeY, side);
  }
  g.append(eyes, focused);

  if (extra === 'glasses') {
    const r = 9.5;
    for (const side of [-1, 1]) extras.append(node('circle', { cx: f(50 + side * gap), cy: f(eyeY), r: f(r), fill: 'rgba(255,255,255,0.18)', stroke: INK, 'stroke-width': '3.2' }));
    extras.append(stroke(`M${f(50 - gap + r)} ${f(eyeY)}Q50 ${f(eyeY - 3)} ${f(50 + gap - r)} ${f(eyeY)}`, 3.2));
    g.append(extras);
  }

  drawMouth(g, mouth, 50, mouthY, hue);
}

function drawEye(g, style, x, y, side) {
  if (style === 'focused') {
    // a dot under a brow that slopes down to the middle
    g.append(node('circle', { cx: f(x), cy: f(y + 1), r: '4.6', fill: INK }), stroke(`M${f(x - side * 6)} ${f(y - 9)}L${f(x + side * 5)} ${f(y - 5)}`, 4.5));
  } else if (style === 'dot') {
    g.append(node('circle', { cx: f(x), cy: f(y), r: '5.4', fill: INK }));
  } else if (style === 'big') {
    g.append(
      node('circle', { cx: f(x), cy: f(y), r: '9', fill: '#fff', stroke: INK, 'stroke-width': '2.6' }),
      node('circle', { cx: f(x), cy: f(y), r: '4.6', fill: INK }),
    );
  } else if (style === 'happy') {
    g.append(stroke(`M${f(x - 6)} ${f(y + 2.5)}Q${f(x)} ${f(y - 6)} ${f(x + 6)} ${f(y + 2.5)}`));
  } else if (style === 'sleepy') {
    g.append(stroke(`M${f(x - 6)} ${f(y - 1)}Q${f(x)} ${f(y + 6)} ${f(x + 6)} ${f(y - 1)}`));
  } else if (style === 'squint') {
    // > <, pointing in
    g.append(stroke(`M${f(x + side * 5)} ${f(y - 5)}L${f(x - side * 3)} ${f(y)}L${f(x + side * 5)} ${f(y + 5)}`));
  }
}

function drawMouth(g, style, x, y, hue) {
  const w = 7.5;
  if (style === 'smile') {
    g.append(stroke(`M${f(x - w)} ${f(y)}Q${f(x)} ${f(y + 7)} ${f(x + w)} ${f(y)}`));
  } else if (style === 'grin') {
    const tongue = hue > 320 || hue < 15 ? '#fff' : '#ff6f8f';
    g.append(node('path', { d: `M${f(x - w - 1)} ${f(y - 1)}Q${f(x)} ${f(y + 14)} ${f(x + w + 1)} ${f(y - 1)}Z`, fill: INK, stroke: INK, 'stroke-width': '2.5', 'stroke-linejoin': 'round' }));
    g.append(node('ellipse', { cx: f(x), cy: f(y + 5.2), rx: f(w * 0.45), ry: '2', fill: tongue }));
  } else if (style === 'o') {
    g.append(node('ellipse', { cx: f(x), cy: f(y + 2), rx: '3.6', ry: '4.4', fill: INK }));
  } else if (style === 'flat') {
    g.append(stroke(`M${f(x - w * 0.7)} ${f(y + 2)}L${f(x + w * 0.7)} ${f(y + 2)}`));
  } else if (style === 'cat') {
    const h = w * 0.5;
    g.append(stroke(`M${f(x - 2 * h)} ${f(y)}Q${f(x - h)} ${f(y + 6)} ${f(x)} ${f(y)}Q${f(x + h)} ${f(y + 6)} ${f(x + 2 * h)} ${f(y)}`, 4.5));
  }
}

// ---- helpers ----

function stroke(d, width = STROKE) {
  return node('path', { d, fill: 'none', stroke: INK, 'stroke-width': String(width), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}

function node(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value);
  return n;
}

const f = (n) => (Math.round(n * 10) / 10).toString();
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const range = (rand, lo, hi) => lo + rand() * (hi - lo);

// FNV-1a, so similar names still land far apart.
function seed(name) {
  let h = 0x811c9dc5;
  for (const ch of name.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

// mulberry32
function random(state) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
