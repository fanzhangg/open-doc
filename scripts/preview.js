// The app's pages as a static site for a plain browser, in dist/preview:
// the doc window (web/index.html, the doc host played by
// desktop/doc-preview-stub.js) and the start window (desktop/start.html,
// the app played by desktop/start-preview-stub.js). Run after
// `npm run build`: node scripts/preview.js
import { build } from 'esbuild';
import { copyFile, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'dist', 'web');
const out = join(root, 'dist', 'preview');
await rm(out, { recursive: true, force: true });
await cp(web, out, { recursive: true });

const doc = (await readFile(join(web, 'index.html'), 'utf8'))
  .replace('<script type="module" src="app.js"></script>', '<script type="module" src="doc-stub.js"></script>\n  <script type="module" src="app.js"></script>');
if (!doc.includes('doc-stub.js')) throw new Error('web/index.html changed: update scripts/preview.js');
await writeFile(join(out, 'index.html'), doc);
await build({
  entryPoints: [join(root, 'desktop', 'doc-preview-stub.js')],
  outfile: join(out, 'doc-stub.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'warning',
});

const start = (await readFile(join(root, 'desktop', 'start.html'), 'utf8'))
  .replaceAll('../dist/web/', '')
  .replace('<script src="start.js" defer></script>', '<script src="start-stub.js"></script>\n  <script src="start.js" defer></script>');
if (start.includes('../') || !start.includes('start-stub.js')) throw new Error('desktop/start.html changed: update scripts/preview.js');
await writeFile(join(out, 'start.html'), start);
await copyFile(join(root, 'desktop', 'start-preview-stub.js'), join(out, 'start-stub.js'));
console.log(`preview: ${join(out, 'index.html')}`);
