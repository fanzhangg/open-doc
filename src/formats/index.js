// What a doc's format adds to plain text, by file extension. Each hook is
// optional, pure, and may only refuse:
//
// - mergeLine(base, ours, theirs, merged): whether a line both sides changed
//   may be merged by character into `merged`; if not, the line conflicts.

import markdown from './markdown/index.js';

const BY_EXTENSION = { md: markdown, markdown };

/** The format of the doc at `path`, or undefined for plain text. */
export function formatOf(path) {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase();
  return extension ? BY_EXTENSION[extension] : undefined;
}
