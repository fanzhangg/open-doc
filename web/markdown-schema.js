// The Milkdown plugins that decide how markdown parses into the editor's
// document. The editor and the rendered-text conformance tests both use this
// list, so the tests check the document the page really builds.

import { $remark } from '@milkdown/kit/utils';
import { commonmark, imageSchema } from '@milkdown/kit/preset/commonmark';
import { gfm, extendListItemSchemaForTask } from '@milkdown/kit/preset/gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';

// CommonMark does not close `**熟悉：**直接` (a run after full-width
// punctuation, before a CJK letter); this reads and writes it as bold, the
// same way the core projection (src/core/project.js) does.
const cjkFriendly = $remark('cjkFriendly', () => remarkCjkFriendly);

// remark gives `![alt](a.png)` a null title, and Milkdown's image node only
// takes a string, so it would leave the image out of the document and the
// next save would delete it from the file. An empty title writes back as no
// title.
export const image = imageSchema.extendSchema((schema) => (ctx) => {
  const base = schema(ctx);
  return {
    ...base,
    parseMarkdown: {
      ...base.parseMarkdown,
      runner: (state, node, type) => state.addNode(type, { src: node.url ?? '', alt: node.alt ?? '', title: node.title ?? '' }),
    },
  };
});

// A list item made in the editor ("- ", the toolbar, the "/" menu) is tight,
// as people write lists; Milkdown's default would save it with a blank line
// after every item. Items split from one keep its spacing, and items read
// from the file keep theirs.
const listItem = extendListItemSchemaForTask.extendSchema((schema) => (ctx) => {
  const base = schema(ctx);
  return { ...base, attrs: { ...base.attrs, spread: { default: false, validate: 'boolean' } } };
});

const swapped = new Map([
  [imageSchema.ctx, image.ctx], [imageSchema.node, image.node],
  [extendListItemSchemaForTask.ctx, listItem.ctx], [extendListItemSchemaForTask.node, listItem.node],
]);

export const markdownPlugins = [commonmark, gfm].flat().map((plugin) => swapped.get(plugin) ?? plugin).concat(cjkFriendly);
