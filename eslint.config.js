// npm run lint. Mainly here for no-undef: code pasted into the wrong scope
// still parses, and only fails when it runs (99ef1e0 fixed one that crashed
// every doc window).

import js from '@eslint/js';
import globals from 'globals';

const browser = ['web/**/*.js', 'site/*.js', 'desktop/start.js', 'preview/doc-stub.js', 'preview/start-stub.js'];

export default [
  { ignores: ['dist/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off', // terminal output is matched on its escape codes
      'no-regex-spaces': 'off',
      'preserve-caught-error': 'off',
    },
  },
  { files: browser, languageOptions: { globals: globals.browser } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
  { files: ['desktop/preload.cjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
