// The Milkdown plugins that decide how markdown parses into the editor's
// document. The editor and the rendered-text conformance tests both use this
// list, so the tests check the document the page really builds.

import { $node, $prose, $remark } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import {
  bulletListSchema, commonmark, imageSchema, linkSchema, listItemSchema, orderedListSchema, syncHeadingIdPlugin, syncListOrderPlugin,
} from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import { withFrontMatter } from '../src/markdown/project.js';

// CommonMark does not close `**熟悉：**直接` (a run after full-width
// punctuation, before a CJK letter); this reads and writes it as bold, the
// same way the core projection (src/markdown/project.js) does.
const cjkFriendly = $remark('cjkFriendly', () => remarkCjkFriendly);

// remark gives `![alt](a.png)` a null title, and Milkdown's image node only
// takes a string, so it would leave the image out of the document and the
// next save would delete it from the file. An empty title writes back as no
// title.
const image = imageSchema.extendSchema((schema) => (ctx) => {
  const base = schema(ctx);
  return {
    ...base,
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (state, node, type) => state.addNode(type, { src: node.url ?? '', alt: node.alt ?? '', title: node.title ?? '' }),
    },
  };
});

// Text typed right after a link is not part of it.
const link = linkSchema.extendSchema((schema) => (ctx) => ({ ...schema(ctx), inclusive: false }));

// YAML front matter reads as the core projection reads it (withFrontMatter):
// one block of source, shown and saved as written, which nothing formats.
const frontMatterSyntax = $remark('frontMatter', () => function frontMatter() {
  const parse = this.parser;
  this.parser = (markdown, file) => withFrontMatter(String(markdown), (text) => parse(text, file));
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push({ handlers: { yaml: (node) => (node.value ? `---\n${node.value}\n---` : '---\n---') } });
});
const frontMatterNode = $node('front_matter', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  parseDOM: [{ tag: 'pre.pj-front-matter', preserveWhitespace: 'full', priority: 60 }],
  toDOM: () => ['pre', { class: 'pj-front-matter' }, ['code', 0]],
  parseMarkdown: {
    match: ({ type }) => type === 'yaml',
    runner: (state, node, type) => {
      state.openNode(type);
      if (node.value) state.addText(node.value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'front_matter',
    runner: (state, node) => state.addNode('yaml', undefined, node.textContent),
  },
}));

// On every change Milkdown walks the whole doc twice: to give each heading
// an id, and to keep ordered list items' labels in step. In a long doc that
// is most of a keystroke. Ids are not used (a `#heading` link is found by the
// heading's text), so they are left out; labels are kept in step as
// Milkdown does, but only in the top-level blocks a change touched.
const listOrder = $prose((ctx) => new Plugin({
  key: new PluginKey('ponjo-list-order'),
  appendTransaction(transactions, oldState, { doc, tr }) {
    if (transactions.some((t) => t.getMeta('addToHistory') === false || !t.isGeneric)) return null;
    const start = oldState.doc.content.findDiffStart(doc.content);
    if (start === null) return null;
    const end = Math.max(start, oldState.doc.content.findDiffEnd(doc.content).b);
    const [ordered, bullet, item] = [orderedListSchema, bulletListSchema, listItemSchema].map((schema) => schema.type(ctx));
    const labelled = (attrs, index, order = 1) => {
      const changed = attrs.label !== `${index + order}.`;
      attrs.label = `${index + order}.`;
      return changed;
    };
    const visit = (node, pos, parent, index) => {
      if (node.type === bullet && node.maybeChild(0)?.type === item && node.child(0).attrs.listType === 'ordered') {
        tr.setNodeMarkup(pos, ordered, { spread: true });
        node.forEach((child, offset, i) => {
          const attrs = { ...child.attrs };
          if (child.type === item && labelled(attrs, i)) tr.setNodeMarkup(pos + 1 + offset, undefined, attrs);
        });
      } else if (node.type === item && parent.type === ordered) {
        const attrs = { ...node.attrs, listType: 'ordered' };
        if (labelled(attrs, index, parent.attrs.order ?? 1) || node.attrs.listType !== 'ordered') tr.setNodeMarkup(pos, undefined, attrs);
      }
    };
    const [from, to] = [start, end].map((pos) => doc.resolve(pos).index(0));
    doc.forEach((node, pos, i) => {
      if (i < from || i > to) return;
      visit(node, pos, doc, i);
      node.descendants((child, at, parent, index) => visit(child, pos + 1 + at, parent, index));
    });
    return tr.docChanged ? tr.setMeta('addToHistory', false) : null;
  },
}));

const swapped = new Map([
  [imageSchema.ctx, image.ctx], [imageSchema.node, image.node], [linkSchema.ctx, link.ctx], [linkSchema.mark, link.mark],
  [syncListOrderPlugin, listOrder], [syncHeadingIdPlugin, []],
]);

// Typed Markdown stays text and the toolbar is the one formatting entry, so
// the preset's input rules and formatting shortcuts are left out. Lists and
// tables keep their Enter and Tab keys.
const FORMATTING = /^(InputRule<|Keymap<(emphasis|strong|inlineCode|paragraph|heading|blockquote|codeBlock|bulletListKeymap|orderedList|strikethrough)>)/;
const kept = (plugin) => !FORMATTING.test(plugin.meta?.displayName ?? '');

export const markdownPlugins = [commonmark.map((plugin) => swapped.get(plugin) ?? plugin), gfm, cjkFriendly, frontMatterSyntax, frontMatterNode].flat().filter(kept);
