// The Markdown editor plugin: Markdown docs as formatted text (view.js),
// with a toolbar and outline (chrome.js), and its settings. How
// Markdown merges is the Markdown harness's (src/plugins/markdown.js), a
// plugin of its own, so it applies whatever view a doc is in.

export const markdown = {
  id: 'markdown',
  name: 'Markdown editor',
  about: 'Edit Markdown docs as formatted text, with a toolbar and an outline.',
  extensions: ['md', 'markdown'],
  // Loaded with the first Markdown doc.
  createView: (options) => import('./view.js').then((view) => view.createMarkdownView(options)),
  settings: { outline: true, focus: false },
  labels: { outline: 'Outline', focus: 'Focus mode' },
};
