// The Milkdown plugins that decide how markdown parses into the editor's
// document. The editor and the rendered-text conformance tests both use this
// list, so the tests check the document the page really builds.

import { $remark } from '@milkdown/kit/utils';
import { commonmark, imageSchema, linkSchema } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';

// CommonMark does not close `**熟悉：**直接` (a run after full-width
// punctuation, before a CJK letter); this reads and writes it as bold, the
// same way the core projection (src/core/project.js) does.
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

const swapped = new Map([[imageSchema.ctx, image.ctx], [imageSchema.node, image.node], [linkSchema.ctx, link.ctx], [linkSchema.mark, link.mark]]);

export const markdownPlugins = [commonmark.map((plugin) => swapped.get(plugin) ?? plugin), gfm, cjkFriendly].flat();
