// Markdown as a format: a line merged by character is kept only when it
// renders as the same merge of the rendered lines, since merging next to
// markup can pair a `*` from one side with a `*` from the other.

import { mergeLine } from '../../core/merge.js';
import { project } from './project.js';

const rendered = (line) => project(line).text;

export default {
  mergeLine: (base, ours, theirs, merged) => rendered(merged) === mergeLine(rendered(base), rendered(ours), rendered(theirs)),
};
