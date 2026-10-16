// Avatars: a face drawn from a seed, the name unless one is saved (yours
// and your agents', so a new name keeps the face; see threads.js avatar).
// Everyone gets their own colour and expression, a little personality, and
// keeps it wherever they show up (the header, threads, history).
// People are round; agents are soft blobs that stay close to a circle, so
// they still read as avatars but are told apart from people at a glance.
//
// Everything is drawn in a 100×100 box. Strokes and dots are sized to stay
// legible down to the 18px faces in a thread's footer.

const NS = 'http://www.w3.org/2000/svg';
const INK = '#1f1d24';
const STROKE = 5.5;

// [hue, saturation, lightness]: bright, toy-like colours that dark ink reads on.
const COLORS = [
  [46, 100, 56], // yellow
  [218, 95, 64], // blue
  [98, 62, 52], // green
  [336, 92, 68], // pink
  [24, 100, 62], // orange
  [262, 82, 72], // lilac
  [170, 60, 50], // teal
  [198, 88, 62], // sky
  [6, 86, 66], // coral
  [70, 76, 54], // lime
  [290, 62, 74], // orchid
  [36, 90, 70], // apricot
];

let ids = 0; // gradient ids, unique per page

/** @param {string} seed */
export const agentFace = (seed) => seed.trim().toLowerCase() === 'clippy' ? clippyFace() : face(seed, false);

/** @param {string} seed */
export const personFace = (seed) => face(seed, true);

// Follow the original sketch: a wide warm yellow coil, eyes on either side and
// asymmetric brows. Rounded arcs and a soft gaze gently refine its expression.
export function clippyFace() {
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
    d: 'M18 60C7 40 18 20 37 20C61 18 84 28 85 48C87 69 70 86 50 85C30 84 24 71 27 54C29 40 41 35 54 38C68 41 70 53 64 62C58 71 45 69 45 59C45 53 48 50 53 50',
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

const CIRCLE = { d: 'M2 50a48 48 0 1 0 96 0a48 48 0 1 0 -96 0Z', lift: 0, pointyBottom: false };

// A large warm yellow coil overlaps the folded page, following the original sketch.
export function documentIcon() {
  const svg = node('svg', { xmlns: NS, viewBox: '0 0 100 100', role: 'img', 'aria-label': 'OpenDoc document' });
  svg.append(
    node('path', { d: 'M34 8H69L91 30V88Q91 94 85 94H34Q28 94 28 88V14Q28 8 34 8Z', fill: '#fff' }),
    node('path', { d: 'M28 27V14Q28 8 34 8H69L91 30V88Q91 94 85 94H34Q28 94 28 88V86', fill: 'none', stroke: '#96959e', 'stroke-width': '2.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    node('path', { d: 'M69 8V25Q69 30 74 30H91', fill: '#eeedf0', stroke: '#96959e', 'stroke-width': '2.5', 'stroke-linejoin': 'round' }),
    node('path', { d: 'M68 45H81M69 57H81M68 69H81', fill: 'none', stroke: '#b8b7be', 'stroke-width': '3.5', 'stroke-linecap': 'round' }),
  );
  const avatar = clippyFace();
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

function face(name, round) {
  const rand = random(seed(name));
  const [hue, sat, light] = pick(rand, COLORS);
  const body = round ? CIRCLE : bodyShape(rand);

  const svg = node('svg', { viewBox: '0 0 100 100', class: 'od-face', 'aria-hidden': 'true' });
  const id = `od-face-${++ids}`;
  const gradient = node('radialGradient', { id, cx: '0.34', cy: '0.28', r: '0.9' });
  gradient.append(
    node('stop', { offset: '0', 'stop-color': `hsl(${hue} ${sat}% ${Math.min(light + 14, 90)}%)` }),
    node('stop', { offset: '0.55', 'stop-color': `hsl(${hue} ${sat}% ${light}%)` }),
    node('stop', { offset: '1', 'stop-color': `hsl(${hue} ${sat}% ${light - 9}%)` }),
  );
  const defs = node('defs', {});
  defs.append(gradient);
  svg.append(defs, node('path', { class: 'od-face-body', d: body.d, fill: `url(#${id})` }));

  // The face sits a little off centre, as if glancing somewhere, and tilts a touch.
  const cx = 50 + range(rand, -6, 6);
  const cy = 52 + body.lift + range(rand, -3, 4);
  const tilt = range(rand, -7, 7);
  const look = node('g', { class: 'od-face-look' });
  const features = node('g', { transform: `rotate(${f(tilt)} ${f(cx)} ${f(cy)})` });
  look.append(features);
  svg.append(look);
  drawFace(features, rand, { cx, cy, hue, pointyBottom: body.pointyBottom });
  return svg;
}

// ---- the body ----

// A closed curve r(θ) around the centre: a base form (round, pebble, rounded
// triangle or square, cloud, egg) plus a couple of slow wobbles, so no two are
// alike but all stay near a circle.
function bodyShape(rand) {
  const form = pick(rand, ['round', 'round', 'pebble', 'pebble', 'triangle', 'square', 'cloud', 'egg']);
  const wobbles = [2, 3].map((k) => ({ k, amp: range(rand, 0.005, 0.022), phase: rand() * Math.PI * 2 }));
  let stretch = 1 + range(rand, -0.03, 0.03);
  let shape = () => 0;
  let lift = 0;
  let pointyBottom = false;
  if (form === 'pebble') {
    stretch = rand() < 0.5 ? range(rand, 1.05, 1.08) : range(rand, 0.92, 0.95);
  } else if (form === 'triangle') {
    const up = rand() < 0.7; // most point up, with room for the face low and wide
    const depth = range(rand, 0.055, 0.075);
    const turn = (up ? -Math.PI / 2 : Math.PI / 2) + range(rand, -0.15, 0.15);
    shape = (t) => depth * Math.cos(3 * (t - turn));
    lift = up ? 5 : -4;
    pointyBottom = !up;
  } else if (form === 'square') {
    const depth = range(rand, 0.04, 0.06);
    const turn = Math.PI / 4 + range(rand, -0.12, 0.12);
    shape = (t) => depth * Math.cos(4 * (t - turn));
  } else if (form === 'cloud') {
    const lobes = 5 + Math.floor(rand() * 4);
    const depth = range(rand, 0.03, 0.045);
    const turn = rand() * Math.PI;
    shape = (t) => depth * (2 * Math.abs(Math.cos((lobes * (t - turn)) / 2)) ** 0.6 - 1);
  } else if (form === 'egg') {
    const depth = range(rand, 0.05, 0.08);
    shape = (t) => depth * Math.sin(t); // y points down: wider at the bottom
    stretch = range(rand, 0.94, 1);
    lift = 2;
  }

  const points = [];
  const steps = 96;
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    let r = 1 + shape(t);
    for (const w of wobbles) r += w.amp * Math.cos(w.k * t + w.phase);
    points.push([r * Math.cos(t) * stretch, r * Math.sin(t) / stretch]);
  }

  // Fit the curve to the box, centred, with a hair of room for anti-aliasing.
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 96 / Math.max(maxX - minX, maxY - minY);
  const fit = points.map(([x, y]) => [50 + (x - (minX + maxX) / 2) * scale, 50 + (y - (minY + maxY) / 2) * scale]);
  return { d: smooth(fit), lift, pointyBottom };
}

// A closed path through the midpoints of `points`, curving at each point.
function smooth(points) {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(points.at(-1), points[0]);
  let d = `M${f(start[0])} ${f(start[1])}`;
  points.forEach((p, i) => {
    const m = mid(p, points[(i + 1) % points.length]);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  });
  return `${d}Z`;
}

// ---- the face ----

const EYES = ['dot', 'dot', 'dot', 'oval', 'shiny', 'shiny', 'happy', 'sleepy', 'line', 'wink', 'big', 'squint'];
const MOUTHS = ['smile', 'smile', 'smile', 'grin', 'grin', 'o', 'flat', 'smirk', 'cat', 'wavy', 'tongue', 'none'];

function drawFace(g, rand, { cx, cy, hue, pointyBottom }) {
  const eye = pick(rand, EYES);
  const mouth = pick(rand, MOUTHS);
  const size = range(rand, 0.85, 1.15);
  const gap = range(rand, 12, 17) * (eye === 'big' ? 1.15 : 1);
  const eyeY = cy - 7;
  const mouthY = eyeY + range(rand, 12, 16) * (eye === 'big' ? 1.15 : 1);
  const glance = [range(rand, -2.5, 2.5), range(rand, -2, 2)];

  // Cheeks go under everything else, a soft blush below the eyes.
  if (rand() < 0.3 && eye !== 'big') {
    const blush = hue > 320 || hue < 15 ? 'hsl(350 85% 50% / 0.45)' : 'hsl(350 95% 72% / 0.6)';
    for (const side of [-1, 1]) g.append(node('ellipse', { cx: f(cx + side * (gap + 5)), cy: f(eyeY + 9), rx: '5.5', ry: '3.2', fill: blush }));
  } else if (rand() < 0.12) {
    for (const side of [-1, 1]) {
      for (const [dx, dy] of [[0, 0], [4.5, 2], [1.5, 4.5]]) {
        g.append(node('circle', { cx: f(cx + side * (gap + 2 + dx)), cy: f(eyeY + 9 + dy), r: '1.3', fill: INK, opacity: '0.55' }));
      }
    }
  }

  for (const side of [-1, 1]) {
    const style = eye === 'wink' ? (side < 0 ? 'dot' : 'happy') : eye;
    drawEye(g, style, cx + side * gap, eyeY, side, size, glance);
  }

  // Brows, now and then: raised, worried or set to work.
  const open = ['dot', 'oval', 'shiny', 'big'].includes(eye);
  if (rand() < 0.22 && eye !== 'big') {
    const mood = pick(rand, ['raised', 'worried', 'keen']);
    for (const side of [-1, 1]) {
      const x = cx + side * gap;
      const y = eyeY - 11 * size;
      const inner = mood === 'worried' ? -3 : mood === 'keen' ? 3 : 0;
      const arc = mood === 'raised' ? -3 : 0;
      g.append(stroke(`M${f(x - side * 5)} ${f(y + inner)}Q${f(x)} ${f(y + arc - 1)} ${f(x + side * 5)} ${f(y - inner / 2)}`, 4));
    }
  } else if (open && rand() < 0.14) {
    // Round glasses over open eyes.
    const r = 8 + size * 1.5;
    for (const side of [-1, 1]) g.append(node('circle', { cx: f(cx + side * gap), cy: f(eyeY), r: f(r), fill: 'rgba(255,255,255,0.18)', stroke: INK, 'stroke-width': '3.2' }));
    g.append(stroke(`M${f(cx - gap + r)} ${f(eyeY)}Q${f(cx)} ${f(eyeY - 3)} ${f(cx + gap - r)} ${f(eyeY)}`, 3.2));
  }

  drawMouth(g, mouth, cx, mouthY, range(rand, 0.85, 1.2), hue);

  if (!pointyBottom && rand() < 0.09) {
    // A bow tie.
    const y = mouthY + 15;
    const w = 11;
    g.append(node('path', { d: `M${f(cx)} ${f(y)}L${f(cx - w)} ${f(y - 5.5)}Q${f(cx - w - 1.5)} ${f(y)} ${f(cx - w)} ${f(y + 5.5)}ZM${f(cx)} ${f(y)}L${f(cx + w)} ${f(y - 5.5)}Q${f(cx + w + 1.5)} ${f(y)} ${f(cx + w)} ${f(y + 5.5)}Z`, fill: INK, 'stroke-linejoin': 'round', stroke: INK, 'stroke-width': '2' }));
  }
}

function drawEye(g, style, x, y, side, size, [gx, gy]) {
  const s = size;
  if (style === 'dot') {
    g.append(node('circle', { cx: f(x + gx * 0.6), cy: f(y + gy * 0.6), r: f(5.4 * s), fill: INK }));
  } else if (style === 'oval') {
    g.append(node('ellipse', { cx: f(x + gx * 0.6), cy: f(y + gy * 0.6), rx: f(4.2 * s), ry: f(7 * s), fill: INK }));
  } else if (style === 'shiny') {
    const ex = x + gx * 0.6;
    const ey = y + gy * 0.6;
    g.append(
      node('circle', { cx: f(ex), cy: f(ey), r: f(6.2 * s), fill: INK }),
      node('circle', { cx: f(ex + 2 * s), cy: f(ey - 2.2 * s), r: f(2 * s), fill: '#fff' }),
    );
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
  } else if (style === 'line') {
    g.append(stroke(`M${f(x - 5.5 * s)} ${f(y)}L${f(x + 5.5 * s)} ${f(y)}`));
  } else if (style === 'squint') {
    // > <, pointing in
    const w = 5 * s;
    g.append(stroke(`M${f(x + side * w)} ${f(y - w)}L${f(x - side * w * 0.6)} ${f(y)}L${f(x + side * w)} ${f(y + w)}`));
  }
}

function drawMouth(g, style, x, y, width, hue) {
  const w = 7 * width;
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
  } else if (style === 'smirk') {
    g.append(stroke(`M${f(x - w * 0.8)} ${f(y + 2)}Q${f(x + 1)} ${f(y + 5)} ${f(x + w)} ${f(y - 2)}`));
  } else if (style === 'cat') {
    const h = w * 0.5;
    g.append(stroke(`M${f(x - 2 * h)} ${f(y)}Q${f(x - h)} ${f(y + 6)} ${f(x)} ${f(y)}Q${f(x + h)} ${f(y + 6)} ${f(x + 2 * h)} ${f(y)}`, 4.5));
  } else if (style === 'wavy') {
    const h = w * 0.5;
    g.append(stroke(`M${f(x - 2 * h)} ${f(y + 2)}Q${f(x - h)} ${f(y - 2)} ${f(x)} ${f(y + 2)}Q${f(x + h)} ${f(y + 6)} ${f(x + 2 * h)} ${f(y + 2)}`, 4.5));
  } else if (style === 'tongue') {
    const tongue = hue > 320 || hue < 15 ? '#fff' : '#ff6f8f';
    g.append(node('path', { d: `M${f(x + 0.5)} ${f(y + 3)}q0 6 3.5 6q3.5 0 3.5 -6z`, fill: tongue, stroke: INK, 'stroke-width': '2.2', 'stroke-linejoin': 'round' }));
    g.append(stroke(`M${f(x - w)} ${f(y)}Q${f(x)} ${f(y + 6)} ${f(x + w)} ${f(y)}`));
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
