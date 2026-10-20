// The Plain text plugin: any text file no other plugin claims, as it is, in
// CodeMirror (view.js). Always on: it is where a doc falls back to, so it
// has no switch.

import { createPlainView } from './view.js';

export const plain = {
  id: 'plain',
  name: 'Plain text',
  about: 'Edit any other text file as it is, with no formatting.',
  extensions: null,
  always: true,
  createView: createPlainView,
  settings: [
    { key: 'lineNumbers', type: 'switch', label: 'Line numbers', default: true, group: 'Display' },
    { key: 'wrap', type: 'switch', label: 'Wrap long lines', default: true },
    { key: 'fontSize', type: 'number', label: 'Font size', min: 12, max: 20, step: 1, unit: 'px', default: 14 },
    {
      key: 'whitespace', type: 'choice', label: 'Show whitespace', group: 'Whitespace', default: 'selection',
      options: [['selection', 'Selection'], ['all', 'All'], ['off', 'Off']],
      hint: 'Dots for spaces and arrows for tabs, in the selection only, everywhere, or not at all.',
    },
    { key: 'guides', type: 'switch', label: 'Indent guides', default: true, hint: 'A faint line at each indent level.' },
    {
      key: 'indent', type: 'choice', label: 'Indent with', group: 'Indentation', default: 'auto',
      options: [['auto', 'Auto'], ['tabs', 'Tabs'], ['spaces', 'Spaces']],
      hint: 'Auto follows the file; Tab types this, and Tab and Shift+Tab indent and outdent selected lines.',
    },
    { key: 'tabWidth', type: 'choice', label: 'Spaces per indent', default: 4, options: [[2, '2'], [4, '4'], [8, '8']], when: { indent: { not: 'tabs' } }, hint: 'For a new file, or when indenting with spaces.' },
    { key: 'keepIndent', type: 'switch', label: 'Keep indent on Enter', default: true, hint: 'A new line starts with the indent of the line above.' },
  ],
};
