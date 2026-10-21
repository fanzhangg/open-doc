// Bundle the browser editor into dist/web (run at publish time, not install).
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'web');
await mkdir(out, { recursive: true });

// Split, so mermaid loads only with a doc's first diagram (web/diagrams.js).
await rm(join(out, 'chunks'), { recursive: true, force: true });
await build({
  entryPoints: { app: join(root, 'web', 'main.js') },
  outdir: out,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
});
// The desktop start window (desktop/start.html loads it from here), with the editor's faces.
await build({
  entryPoints: [join(root, 'web', 'start.js')],
  outfile: join(out, 'start.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'linked',
  logLevel: 'info',
});
// The faces on their own, for the design page (site/avatars.html).
await build({
  entryPoints: [join(root, 'web', 'faces.js')],
  outfile: join(out, 'faces.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
await copyFile(join(root, 'web', 'index.html'), join(out, 'index.html'));
await copyFile(join(root, 'web', 'app.css'), join(out, 'app.css'));
await copyFile(join(root, 'build', 'icon.svg'), join(out, 'icon.svg'));

// Inter (OFL-1.1), served by the editor itself: the page's CSP allows no remote fonts.
const fonts = join(root, 'node_modules', '@fontsource-variable', 'inter');
await mkdir(join(out, 'fonts'), { recursive: true });
for (const subset of ['latin', 'latin-ext']) {
  for (const style of ['normal', 'italic']) {
    const file = `inter-${subset}-wght-${style}.woff2`;
    await copyFile(join(fonts, 'files', file), join(out, 'fonts', file));
  }
}
await copyFile(join(fonts, 'LICENSE'), join(out, 'fonts', 'Inter-LICENSE.txt'));
