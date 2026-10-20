// The built-in plugins, and which view a doc opens in. A view plugin gives
// one format a view of its own, with its UI and settings, and can be
// switched off. It is a declaration: { id, name, about (one line),
// extensions (null: any file no other plugin claims), always (true: cannot
// be switched off), createView (options → a view, see web/plugins/plain/view.js),
// settings: [field, ...] }, a field being { key, type, label, hint?, default,
// group?, when? } and shown in this order on the plugin's page in Settings:
// - type 'switch' (a boolean), 'choice' (one of `options`: [[value, label], ...])
//   or 'number' (an integer from `min` to `max`, by `step`, with a `unit`?);
// - `group`, on the first field of a group, is the group's heading;
// - `when`, { key: value | [values] } or { key: { not: value } } on the plugin's
//   other fields, shows the field only then.
// A doc opens in the view of a view plugin that is on and claims its
// extension, else in the Plain text plugin's, for any text file. The
// harness plugins (src/plugins/) are listed in Settings with them.

import { pluginSettings } from '../../src/core/settings.js';
import { HARNESSES, extensionOf } from '../../src/plugins/index.js';
import { markdown } from './markdown/index.js';
import { plain } from './plain/index.js';

const CLAIMING = [markdown];

export const PLUGINS = [markdown, plain, ...HARNESSES];

/** The view the doc named `name` opens in under `settings`: { id, createView, settings }, with its plugin's id and settings. */
export function viewFor(name, settings) {
  const extension = extensionOf(name);
  const plugin = CLAIMING.find((p) => p.extensions.includes(extension) && pluginSettings(settings, p).enabled) ?? plain;
  return { id: plugin.id, createView: plugin.createView, settings: pluginSettings(settings, plugin) };
}
