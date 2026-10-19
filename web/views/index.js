// Which views a doc opens in, by its file extension, its default first:
// Markdown in the Markdown view, any other text in the plain view.

import { createMarkdownView } from './markdown.js';
import { createPlainView } from './plain.js';

const BY_EXTENSION = { md: [createMarkdownView], markdown: [createMarkdownView] };

/** The views the doc named `name` opens in, its default first. */
export function viewsFor(name) {
  const extension = /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase();
  return BY_EXTENSION[extension] ?? [createPlainView];
}
