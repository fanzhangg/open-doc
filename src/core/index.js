// The format's core (spec/SPEC.md): anchors, comments and mentions on a
// doc's text. The same in Node and the browser.
export { CONTEXT_LENGTH, createAnchor, locate } from './anchor.js';
export { FORMAT_VERSION, askedOf, newId, parseSidecar, peopleOf, serializeSidecar, threadsOf, validAnchor } from './comments.js';
export { mentionSpans, parseMentions, sameName } from './mentions.js';
