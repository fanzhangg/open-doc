// The built-in harness plugins: what a format adds to plain text where a
// doc's edits merge, in the doc host (a buddy's edit) and in the page (a
// change from outside), whatever view the doc is in. They live in src/, not
// with the view plugins in web/plugins/, since the doc host runs src/ only.
// A harness is a declaration: { id, name, about (one line), extensions,
// ...hooks }, switched on or off like a view plugin (pluginSettings). Each
// hook is optional, pure, and may only refuse:
//
// - mergeLine(base, ours, theirs, merged): whether a line both sides changed
//   may be merged by character into `merged`; if not, the line conflicts.
// - mergeDoc(base, ours, theirs, merged): whether the whole merged text may
//   stand, checked once at the end of a merge; if not, the merge conflicts.

import { pluginSettings } from '../core/settings.js';
import { markdownHarness } from './markdown.js';

export const HARNESSES = [markdownHarness];

/** The extension of the file named `name`, in lower case, or undefined. */
export const extensionOf = (name) => /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase();

/** The harness of the doc at `path` under `settings`: one that is on and claims its extension, else undefined (plain text). */
export function harnessOf(path, settings) {
  const extension = extensionOf(path);
  return HARNESSES.find((h) => h.extensions.includes(extension) && pluginSettings(settings, h).enabled);
}
