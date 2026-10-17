// Avatars: a face drawn from the name, from one set of parts. People are
// round and keep their face everywhere. Clippy's is fixed. The other buddies
// in a doc take parts as unlike each other's as can be (setBuddies), and a
// colour no other buddy there has (colorSlots).
//
// Everything is drawn in a 100×100 box. Strokes and dots are sized to stay
// legible down to the 18px faces in a thread's footer.

import { CLIPPY, colorSlots } from '../src/core/buddies.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = '#1f1d24';
const STROKE = 5.5;

// [lightness, chroma, hue] in OKLCH: eight hues evenly apart, Clippy's
// sunflower first, a touch lighter so it reads as yellow.
const COLORS = [[0.84, 0.17, 85], ...[135, 180, 225, 270, 315, 0, 45].map((hue) => [0.78, 0.14, hue])];
let slots = colorSlots([]);
let looks = new Map();

/** The buddies in this doc, so their faces and colours differ. */
export function setBuddies(names) {
  slots = colorSlots(names);
  looks = spread([...slots.keys()]);
}

/** Buddy `name`'s colour, a little lighter (`lift` > 0) or darker. */
export function buddyColor(name, lift = 0) {
  const [lightness, chroma, hue] = colorOf(name);
  return `oklch(${(lightness + lift).toFixed(2)} ${chroma} ${hue})`;
}

function colorOf(name) {
  const key = name.toLowerCase();
  return COLORS[slots.get(key) ?? colorSlots([key]).get(key)];
}

let ids = 0; // gradient ids, unique per page

// The brand mark on the app and document icons: a warm yellow coil, eyes on
// either side and asymmetric brows.
function coilMark() {
  const svg = node('svg', { xmlns: NS, viewBox: '0 0 100 100', class: 'od-face', role: 'img', 'aria-label': 'OpenDoc' });
  const id = `od-clippy-${++ids}`;
  const defs = node('defs', {});
  const gradient = node('radialGradient', { id, cx: '0.34', cy: '0.28', r: '0.9' });
  for (const [offset, color] of [[0, '#ffe9a3'], [0.55, '#ffd05b'], [1, '#edac38']]) {
    gradient.append(node('stop', { offset, 'stop-color': color }));
  }
  defs.append(gradient);
  const body = node('g', {});
  svg.append(defs, body);
  body.append(node('path', {
    class: 'od-face-body',
    d: coil(),
    fill: 'none', stroke: `url(#${id})`, 'stroke-width': '8',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  const features = node('g', { class: 'od-face-look' });
  drawEye(features, 'big', 23, 46, -1, 1.55, [0.8, -0.3]);
  drawEye(features, 'big', 77, 43, 1, 1.55, [-0.8, -0.3]);
  // A small highlight softens the gaze without adding another facial feature.
  for (const [x, y] of [[22, 43], [74, 40]]) {
    features.append(node('circle', { cx: x, cy: y, r: '1.7', fill: '#fff' }));
  }
  features.append(stroke('M13 26Q22 22 31 25', 3.5), stroke('M68 21Q76 16 84 18', 3.5));
  svg.append(features);
  return svg;
}

// An Archimedean spiral around (50, 50): two turns from the tail at the lower
// left, winding anticlockwise in.
function coil() {
  const [outer, inner, turns, start] = [35, 4, 2, Math.PI * 3 / 4];
  const steps = turns * 48;
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = start - t * turns * Math.PI * 2;
    const r = outer - (outer - inner) * t;
    points.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  // Curve through each point, ending on the midpoints between them.
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 1; i < steps; i++) {
    const [p, q] = [points[i], points[i + 1]];
    d += `Q${f(p[0])} ${f(p[1])} ${f((p[0] + q[0]) / 2)} ${f((p[1] + q[1]) / 2)}`;
  }
  return `${d}L${f(points[steps][0])} ${f(points[steps][1])}`;
}

// The app icon: Clippy on a paper tile, the shape and size of Apple's icon grid
// (824 of 1024). macOS 26 shrinks an icon that does not fill this shape onto a
// grey plate, which is how the bare coil showed in the Dock and Finder.
export function appIcon() {
  const svg = node('svg', { xmlns: NS, viewBox: '0 0 100 100', role: 'img', 'aria-label': 'OpenDoc' });
  const defs = node('defs', {});
  const gradient = node('linearGradient', { id: 'od-tile', x1: '0', y1: '0', x2: '0', y2: '1' });
  gradient.append(node('stop', { offset: '0', 'stop-color': '#ffffff' }), node('stop', { offset: '1', 'stop-color': '#f1ede3' }));
  defs.append(gradient);
  // A faint ink edge keeps the tile apart from white backgrounds (Windows, browser tabs).
  svg.append(defs, node('rect', {
    x: '9.77', y: '9.77', width: '80.47', height: '80.47', rx: '18.1',
    fill: 'url(#od-tile)', stroke: INK, 'stroke-opacity': '0.12', 'stroke-width': '0.6',
  }));
  const avatar = coilMark();
  const mark = node('g', { transform: 'translate(50 50.5) scale(0.64) translate(-50 -51)' });
  mark.append(...avatar.childNodes);
  svg.append(mark);
  return svg;
}

// A large warm yellow coil overlaps the folded page; its white halo cuts the
// page edge where they cross.
export function documentIcon() {
  const svg = node('svg', { xmlns: NS, viewBox: '0 0 100 100', role: 'img', 'aria-label': 'OpenDoc document' });
  svg.append(
    node('path', { d: 'M34 8H69L91 30V88Q91 94 85 94H34Q28 94 28 88V14Q28 8 34 8Z', fill: '#fff' }),
    node('path', { d: 'M28 88V14Q28 8 34 8H69L91 30V88Q91 94 85 94H34Q28 94 28 88', fill: 'none', stroke: '#96959e', 'stroke-width': '2.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    node('path', { d: 'M69 8V25Q69 30 74 30H91', fill: '#eeedf0', stroke: '#96959e', 'stroke-width': '2.5', 'stroke-linejoin': 'round' }),
    node('path', { d: 'M68 45H81M69 57H81M68 69H81', fill: 'none', stroke: '#b8b7be', 'stroke-width': '3.5', 'stroke-linecap': 'round' }),
  );
  const avatar = coilMark();
  svg.append(avatar.querySelector('defs'));
  const coil = avatar.querySelector('.od-face-body');
  const halo = coil.cloneNode(true);
  halo.setAttribute('stroke', '#fff');
  halo.setAttribute('stroke-width', '16');
  const mark = node('g', { transform: 'translate(-1 20) scale(0.73)' });
  mark.append(halo, coil);
  svg.append(mark);
  return svg;
}

/** @param {string} name */
export const agentFace = (name) => face(name, looks.get(name.toLowerCase()) ?? drawn(name));

/** @param {string} name */
export const personFace = (name) => face(name, drawn(name), CIRCLE);

function face(name, look, body = look.body) {
  const svg = node('svg', { viewBox: '0 0 100 100', class: 'od-face', 'aria-hidden': 'true' });
  const id = `od-face-${++ids}`;
  const gradient = node('radialGradient', { id, cx: '0.34', cy: '0.28', r: '0.9' });
  const stops = [buddyColor(name, 0.08), buddyColor(name), buddyColor(name, -0.07)];
  gradient.append(...[0, 0.55, 1].map((offset, i) => node('stop', { offset: String(offset), 'stop-color': stops[i] })));
  const defs = node('defs', {});
  defs.append(gradient);

  // The whole face tilts a touch, body and all.
  const tilted = node('g', { transform: `rotate(${f(look.tilt)} 50 50)` });
  const features = node('g', { class: 'od-face-look' });
  tilted.append(node('path', { class: 'od-face-body', d: body.d, fill: `url(#${id})` }), features);
  svg.append(defs, tilted);
  drawFace(features, look, body.cy, colorOf(name)[2]);
  return svg;
}

// The parts `name` picks: Clippy's are fixed, anyone else's drawn from the name.
function drawn(name) {
  if (name.toLowerCase() === CLIPPY.name.toLowerCase()) return CLIPPY_LOOK;
  const rand = random(seed(name));
  const body = pick(rand, BODIES);
  const tilt = range(rand, -7, 7);
  const eye = pick(rand, EYES);
  const mouth = pick(rand, MOUTHS);
  const extra = pick(rand, EXTRAS.filter((x) => fits(x, eye)));
  return { body, tilt, eye, mouth, extra };
}

// The buddies in turn, Clippy first: each part is the one fewest before have,
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
      if (name !== CLIPPY.name.toLowerCase()) {
        const fit = options.filter((option) => part !== 'extra' || fits(option, look.eye));
        const start = Math.max(0, fit.indexOf(look[part]));
        look[part] = [...fit.slice(start), ...fit.slice(0, start)].reduce((best, option) => (count(part, option) < count(part, best) ? option : best));
      }
      counts[part].set(look[part], count(part, look[part]) + 1);
    }
    result.set(name, look);
  }
  return result;
}

const CIRCLE = { d: 'M2 50a48 48 0 1 0 96 0a48 48 0 1 0 -96 0Z', cy: 52 };

// ---- the body ----

// Four shapes far enough apart to tell at 18px: a square, a plump triangle
// and a pentagon, all soft-cornered, and a cloud. `cy` is where the face
// sits: lower where the body is wide below.
const UP = -Math.PI / 2;
const BODIES = [
  { d: outline(roundCorners(polygon(4, Math.PI / 4), 0.32)), cy: 52 },
  { d: outline(puff(roundCorners(polygon(3, UP), 0.36), 0.3)), cy: 60 },
  { d: outline(roundCorners(polygon(5, UP), 0.3)), cy: 55 },
  { d: outline(cloud()), cy: 52 },
];

function polygon(sides, start) {
  return Array.from({ length: sides }, (_, i) => {
    const t = start + (i / sides) * Math.PI * 2;
    return [Math.cos(t), Math.sin(t)];
  });
}

// Cut each corner `frac` of the way along its edges and curve through it.
function roundCorners(corners, frac) {
  const points = [];
  corners.forEach((c, i) => {
    const prev = corners.at(i - 1);
    const next = corners[(i + 1) % corners.length];
    const a = [c[0] + (prev[0] - c[0]) * frac, c[1] + (prev[1] - c[1]) * frac];
    const b = [c[0] + (next[0] - c[0]) * frac, c[1] + (next[1] - c[1]) * frac];
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

function cloud() {
  return Array.from({ length: 160 }, (_, i) => {
    const t = (i / 160) * Math.PI * 2;
    const r = 1 + 0.085 * (2 * Math.abs(Math.cos(3 * (t + 0.3))) ** 0.5 - 1);
    return [r * Math.cos(t), r * Math.sin(t)];
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
const EXTRAS = [null, 'blush', 'glasses', 'bow'];
// Blush and glasses would crowd big eyes.
const fits = (extra, eye) => eye !== 'big' || !['blush', 'glasses'].includes(extra);

const CLIPPY_LOOK = { body: BODIES[3], tilt: -3, eye: 'dot', mouth: 'smile', extra: 'blush' };

function drawFace(g, { eye, mouth, extra }, cy, hue) {
  const big = eye === 'big';
  const gap = big ? 16 : 14;
  const eyeY = cy - 7;
  const mouthY = eyeY + (big ? 17 : 14);

  // Cheeks go under everything else, a soft blush below the eyes.
  if (extra === 'blush') {
    const blush = hue > 320 || hue < 15 ? 'hsl(350 85% 50% / 0.45)' : 'hsl(350 95% 72% / 0.6)';
    for (const side of [-1, 1]) g.append(node('ellipse', { cx: f(50 + side * (gap + 5)), cy: f(eyeY + 9), rx: '5.5', ry: '3.2', fill: blush }));
  }

  for (const side of [-1, 1]) drawEye(g, eye, 50 + side * gap, eyeY, side, 1, [0, 0]);

  if (extra === 'glasses') {
    const r = 9.5;
    for (const side of [-1, 1]) g.append(node('circle', { cx: f(50 + side * gap), cy: f(eyeY), r: f(r), fill: 'rgba(255,255,255,0.18)', stroke: INK, 'stroke-width': '3.2' }));
    g.append(stroke(`M${f(50 - gap + r)} ${f(eyeY)}Q50 ${f(eyeY - 3)} ${f(50 + gap - r)} ${f(eyeY)}`, 3.2));
  }

  drawMouth(g, mouth, 50, mouthY, hue);

  if (extra === 'bow') {
    const y = mouthY + 15;
    const w = 11;
    g.append(node('path', { d: `M50 ${f(y)}L${f(50 - w)} ${f(y - 5.5)}Q${f(48.5 - w)} ${f(y)} ${f(50 - w)} ${f(y + 5.5)}ZM50 ${f(y)}L${f(50 + w)} ${f(y - 5.5)}Q${f(51.5 + w)} ${f(y)} ${f(50 + w)} ${f(y + 5.5)}Z`, fill: INK, 'stroke-linejoin': 'round', stroke: INK, 'stroke-width': '2' }));
  }
}

function drawEye(g, style, x, y, side, size, [gx, gy]) {
  const s = size;
  if (style === 'dot') {
    g.append(node('circle', { cx: f(x + gx * 0.6), cy: f(y + gy * 0.6), r: f(5.4 * s), fill: INK }));
  } else if (style === 'big') {
    const r = 9 * s;
    g.append(
      node('circle', { cx: f(x), cy: f(y), r: f(r), fill: '#fff', stroke: INK, 'stroke-width': '2.6' }),
      node('circle', { cx: f(x + gx * 1.4), cy: f(y + gy * 1.4), r: f(4.6 * s), fill: INK }),
    );
  } else if (style === 'happy') {
    g.append(stroke(`M${f(x - 6 * s)} ${f(y + 2.5)}Q${f(x)} ${f(y - 6 * s)} ${f(x + 6 * s)} ${f(y + 2.5)}`));
  } else if (style === 'sleepy') {
    g.append(stroke(`M${f(x - 6 * s)} ${f(y - 1)}Q${f(x)} ${f(y + 6 * s)} ${f(x + 6 * s)} ${f(y - 1)}`));
  } else if (style === 'squint') {
    // > <, pointing in
    const w = 5 * s;
    g.append(stroke(`M${f(x + side * w)} ${f(y - w)}L${f(x - side * w * 0.6)} ${f(y)}L${f(x + side * w)} ${f(y + w)}`));
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
