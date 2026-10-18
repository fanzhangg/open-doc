// The format's core (spec/SPEC.md): rendered text, anchors, comments and
// mentions. The same in Node and the browser.
export { project, sourceRange, lineOf } from './project.js';
export { AnchorError, CONTEXT_LENGTH, createAnchor, findQuote, locate } from './anchor.js';
export { FORMAT_VERSION, askedOf, newId, parseSidecar, peopleOf, serializeSidecar, threadsOf, validAnchor } from './comments.js';
export { mentionSpans, parseMentions, sameName } from './mentions.js';
