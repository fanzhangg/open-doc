// Two people writing in one doc, to try by hand: two Markdown views side by
// side, joined by an in-memory host that orders their edits, a delay away each
// way (test/collab/page.js, plan A in docs/markdown-view.md). Type in both and
// watch them merge. Run after `npm run build`: node preview/collab.js, then
// open the page it prints in Chrome. The page takes ?delay=ms (default 150).
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'collab');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'dist', 'web', 'app.css'), join(out, 'app.css'));
await cp(join(root, 'dist', 'web', 'fonts'), join(out, 'fonts'), { recursive: true });
await build({
  entryPoints: [join(root, 'test', 'collab', 'page.js')], outfile: join(out, 'page.js'),
  bundle: true, format: 'iife', external: ['mermaid'], logLevel: 'warning',
});

const SAMPLE = `# Launch plan

We plan to **ship all six features** in week one, then gather
feedback from the [beta cohort](https://example.com/beta) before the public release.

Risks
=====

* The \`sync\` service may not handle the load.
* Some __old__ notes say _maybe_.

|Item|Owner|Due|
|-|-|-|
|Sync|Ana|Friday|
|Docs|Ben|Monday|

> A quote, with a [link](https://example.com).

1) First
2) Second
`;

// A page per writer, without the comment margin, as with comments hidden.
const column = (name) => `<div class="writer" data-name="${name}" style="--margin-w:0px;--stage-gap:0px"><div class="who">${name}</div>
  <div class="od-toolbar"><span class="od-spacer"></span></div>
  <main class="od-canvas"><div class="od-stage"><article class="od-page"><div class="od-editor"></div></article></div></main></div>`;

await writeFile(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Two writers</title>
<link rel="stylesheet" href="app.css">
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font: 13px var(--ui-font); }
  .bar { display: flex; gap: 16px; align-items: center; padding: 8px 16px; border-bottom: 1px solid var(--line); }
  .bar .sync { margin-left: auto; }
  .writers { flex: 1; min-height: 0; display: flex; }
  .writer { flex: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--line); }
  .who { padding: 6px 16px 0; font-weight: 600; }
  pre { margin: 0; max-height: 30vh; overflow: auto; padding: 8px 16px; border-top: 1px solid var(--line); white-space: pre-wrap; }
</style>
<div class="bar">
  <label>Doc <select class="doc"><option value="sample">Sample</option><option value="long">Long (200 KB)</option></select></label>
  <label>or <input type="file" class="file" accept=".md,.markdown,.txt"></label>
  <span class="view"></span>
  <span>Host delay <b class="delay"></b> ms each way (add ?delay=ms to change)</span>
  <button class="show">Host text</button>
  <span class="sync"></span>
</div>
<div class="writers">${column('Ana')}${column('Ben')}</div>
<pre class="host" hidden></pre>
<script src="page.js"></script>
<script>
  const SAMPLE = ${JSON.stringify(SAMPLE)};
  const docs = { sample: SAMPLE, long: Array(Math.ceil(200000 / SAMPLE.length)).fill(SAMPLE).join('\\n') };
  const $ = (selector) => document.querySelector(selector);
  $('.delay').textContent = new URLSearchParams(location.search).get('delay') ?? 150;
  // In the view the app would open the doc in: plain text past the Markdown
  // view's limits, read-only past every view's.
  const open = async (text) => {
    const { id, editable } = await collab.make(text, { view: 'auto' });
    $('.view').textContent = (id === 'plain' ? 'Plain text view' : 'Markdown view') + (editable ? '' : ', read-only: too long to edit');
  };
  $('.doc').onchange = () => open(docs[$('.doc').value]);
  $('.file').onchange = async () => open(await $('.file').files[0].text());
  $('.show').onclick = () => { $('.host').hidden = !$('.host').hidden; };
  // Both views equal the host once nothing is on its way.
  setInterval(() => {
    if (!collab.clients.length) return;
    const { host, texts, errors, drifts } = collab.state();
    const same = texts.every((text) => text === host);
    $('.sync').textContent = (same ? 'In sync' : 'Merging…') + ' · ' + collab.host.log.length + ' edits'
      + (errors.length ? ' · ' + errors.length + ' errors (see the console)' : '') + (drifts.length ? ' · ' + drifts.length + ' rewrites' : '');
    if (errors.length) console.error(errors);
    if (!$('.host').hidden) $('.host').textContent = host;
  }, 300);
  open(SAMPLE);
</script>
`);
console.log(`Open in Chrome: ${pathToFileURL(join(out, 'index.html'))}`);
