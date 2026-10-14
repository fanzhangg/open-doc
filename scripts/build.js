// Bundle the browser editor into dist/web (run at publish time, not install).
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'web');
await mkdir(out, { recursive: true });

await build({
  entryPoints: [join(root, 'web', 'main.js')],
  outfile: join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
});
await copyFile(join(root, 'web', 'index.html'), join(out, 'index.html'));
await copyFile(join(root, 'web', 'app.css'), join(out, 'app.css'));
