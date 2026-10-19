// The built-in plugins, and which view a doc opens in. A plugin gives one
// format a view of its own, with its UI and settings, and can be switched
// off. It is a declaration: { id, name, about (one line), extensions,
// createView (options → a view, see web/views/plain.js), settings: { key:
// default boolean }, labels: { key: its name in Settings } }. A doc opens in
// the view of a plugin that is on and claims its extension, else in the
// plain view, the app's own, for any text file.

import { pluginSettings } from '../../src/core/settings.js';
import { createPlainView } from '../views/plain.js';
import { markdown } from './markdown/index.js';

export const PLUGINS = [markdown];

/**
 * The view the doc named `name` opens in under `settings`: { id, createView,
 * settings }, with its plugin's id and settings, both null for the plain view.
 */
export function viewFor(name, settings) {
  const extension = /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase();
  const plugin = PLUGINS.find((p) => p.extensions.includes(extension) && pluginSettings(settings, p).enabled);
  if (!plugin) return { id: null, createView: createPlainView, settings: null };
  return { id: plugin.id, createView: plugin.createView, settings: pluginSettings(settings, plugin) };
}
