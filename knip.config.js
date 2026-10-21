// npm run lint. No unused files, exports or dependencies. The entries below
// are loaded by path or by another program, where knip cannot see them.

export default {
  entry: [
    'desktop/main.js', // Electron's main process (npm run desktop, electron-builder.yml)
    'desktop/doc-host.js', // forked as the doc host by desktop/main.js
    'desktop/preload.cjs', // the windows' preload (desktop/windows.js)
    'web/{main,start,faces}.js', // bundled by scripts/build.js; site/*.html imports faces.js
    'preview/*.js', // node preview/build.js and the stubs it bundles
    'scripts/*.{js,cjs}',
    'site/site.js', // site/*.html
  ],
  ignoreDependencies: ['@fontsource-variable/inter'], // fonts copied by scripts/build.js
  ignoreBinaries: ['mktemp'], // a system tool (test/runner.test.js)
};
