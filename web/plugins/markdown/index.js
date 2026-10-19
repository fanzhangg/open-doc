// The Markdown plugin: Markdown docs as formatted text (view.js), with a
// toolbar, "/" menu and outline (chrome.js), and its settings. Markdown's
// format rules (src/formats/markdown) apply whatever view a doc is in, so
// they are not part of it.

export const markdown = {
  id: 'markdown',
  name: 'Markdown',
  about: 'Edit Markdown docs as formatted text, with a toolbar, a "/" menu and an outline.',
  extensions: ['md', 'markdown'],
  // Loaded with the first Markdown doc.
  createView: (options) => import('./view.js').then((view) => view.createMarkdownView(options)),
  settings: { outline: true, focus: false },
  labels: { outline: 'Outline', focus: 'Focus mode' },
};
