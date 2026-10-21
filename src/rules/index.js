// The built-in rules: what a format adds to plain text where a doc's edits
// merge, for an edit that yields (a buddy's, an outside change, an undo), in
// the doc host and in the page alike, whatever view the doc is in. A rule knows nothing of views, and a
// view nothing of rules: they share only the doc's text. They live in src/,
// not with the views in web/views/, since the doc host runs src/ only.
//
// A rule is a declaration: { id, name, about (one line), extensions, ...hooks }.
// Each hook is optional, pure (text in, verdict out; no I/O, no state, no
// handle to the app) and may only refuse. To add a rule, write one in this
// folder and list it in RULES; to add a hook, have the host call it at one
// place and say what it may refuse here:
//
// - mergeLine(base, ours, theirs, merged): whether a line both sides changed
//   may be merged by character into `merged`; if not, the line conflicts.
//
// Each rule is switched on or off alone (ruleSettings).

import { claims, ruleSettings } from '../core/settings.js';
import { markdownRule } from './markdown.js';

export const RULES = [markdownRule];

/** The rules that are on for the doc at `path` under `settings`: those that claim its extension. */
export const rulesOf = (path, settings) => RULES.filter((rule) => claims(rule, path) && ruleSettings(settings, rule).enabled);
