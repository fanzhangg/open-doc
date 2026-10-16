// The desktop start window as a static page for a plain browser, in
// dist/start-preview: desktop/start.html with desktop/start-preview-stub.js
// standing in for the app. Run after `npm run build`: node scripts/start-preview.js
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'dist', 'web');
const out = join(root, 'dist', 'start-preview');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'fonts'), { recursive: true });

const page = (await readFile(join(root, 'desktop', 'start.html'), 'utf8'))
  // the app's CSP is for the app; a preview opened from disk or any host doesn't need it
  .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replaceAll('../dist/web/fonts/', 'fonts/')
  .replace('../dist/web/app.css', 'app.css')
  .replace(
    '<script src="../dist/web/start.js" defer></script>',
    '<script src="stub.js"></script>\n  <script src="start.js" defer></script>',
  );
if (page.includes('../dist/')) throw new Error('desktop/start.html changed: update scripts/start-preview.js');

await writeFile(join(out, 'index.html'), page);
await copyFile(join(root, 'desktop', 'start-preview-stub.js'), join(out, 'stub.js'));
await copyFile(join(web, 'start.js'), join(out, 'start.js'));
await copyFile(join(web, 'app.css'), join(out, 'app.css'));
for (const file of await readdir(join(web, 'fonts'))) {
  await copyFile(join(web, 'fonts', file), join(out, 'fonts', file));
}
console.log(`start preview: ${join(out, 'index.html')}`);
