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
  settings: [],
};
