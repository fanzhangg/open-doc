// The Markdown harness: a line merged by character is kept only when it
// renders as the same merge of the rendered lines, since merging next to
// markup can pair a `*` from one side with a `*` from the other.

import { mergeLine } from '../core/merge.js';
import { project } from '../markdown/project.js';

const rendered = (line) => project(line).text;

export const markdownHarness = {
  id: 'markdown-harness',
  name: 'Markdown harness',
  about: 'Merge buddies\' edits and outside changes into Markdown docs only where they keep how each line renders.',
  extensions: ['md', 'markdown'],
  mergeLine: (base, ours, theirs, merged) => rendered(merged) === mergeLine(rendered(base), rendered(ours), rendered(theirs)),
};
