// The Markdown view: Markdown docs as formatted text (view.js), with a
// toolbar and outline (chrome.js), and its settings. How Markdown merges is a
// rule's (src/rules/markdown.js), apart from this view, so it applies
// whatever view a doc is in.

export const markdown = {
  id: 'markdown',
  name: 'Markdown editor',
  about: 'Edit Markdown docs as formatted text, with a toolbar and an outline.',
  extensions: ['md', 'markdown'],
  // Loaded with the first Markdown doc.
  limits: { chars: 100_000, blockChars: 10_000 }, // docs/architecture.md, Latency
  createView: (options) => import('./view.js').then((view) => view.createMarkdownView(options)),
  settings: [
    { key: 'font', type: 'choice', label: 'Document font', options: [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']], default: 'sans', group: 'Page' },
    { key: 'width', type: 'choice', label: 'Text width', options: [['normal', 'Normal'], ['wide', 'Wide']], default: 'normal' },
    { key: 'outline', type: 'switch', label: 'Outline', default: true, group: 'Tools' },
    { key: 'focus', type: 'switch', label: 'Focus mode', default: false },
    { key: 'wordCount', type: 'switch', label: 'Word count', default: false },
  ],
};
