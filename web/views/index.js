// The built-in views, and which one a doc opens in. A view is a doc's editor:
// the one thing here that has state (caret, undo, what is drawn), so it is
// built in, not extended; a view knows nothing of rules (src/rules/), nor a
// rule of views. A view gives one format an editor of its own, with its UI and
// settings, and can be switched off. It is a declaration: { id, name, about (one
// line), extensions (null: any file no other view claims), always (true: cannot
// be switched off), createView (options → a view, see web/views/plain/view.js),
// settings: [field, ...] }, a field being { key, type, label, hint?, default,
// group?, when? } and shown in this order on the view's page in Settings:
// - type 'switch' (a boolean), 'choice' (one of `options`: [[value, label], ...])
//   or 'number' (an integer from `min` to `max`, by `step`, with a `unit`?);
// - `group`, on the first field of a group, is the group's heading;
// - `when`, { key: value | [values] } or { key: { not: value } } on the view's
//   other fields, shows the field only then.
// The view's own tools (toolbar, outline, focus mode) are part of it and
// switched by its settings; every view passes the one contract in
// test/views.test.js. To add a view, write one in a folder here and list it in
// VIEWS. A doc opens in the view that is on and claims its extension, else in
// the Plain text view, for any text file.

import { claims, viewSettings } from '../../src/core/settings.js';
import { markdown } from './markdown/index.js';
import { plain } from './plain/index.js';

const CLAIMING = [markdown];

export const VIEWS = [markdown, plain];

/** The view the doc named `name` opens in under `settings`: { id, createView, settings }, with its view's id and settings. */
export function viewFor(name, settings) {
  const view = CLAIMING.find((v) => claims(v, name) && viewSettings(settings, v).enabled) ?? plain;
  return { id: view.id, createView: view.createView, settings: viewSettings(settings, view) };
}
