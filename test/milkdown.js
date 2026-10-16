// Markdown parsed into the editor's ProseMirror document in Node, with the
// page's own Milkdown plugins (web/markdown-schema.js), so tests see the
// document the editor really builds. Milkdown expects a browser: its timers
// talk through window events, and its last step mounts a view in the DOM.
// The parser and serializer are ready before that step, so a stand-in for
// both is enough; the view step then fails, which is expected.

import { Editor, SerializerReady, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { markdownPlugins } from '../web/markdown-schema.js';

let started = null;

function start() {
  started ??= (async () => {
    const events = new EventTarget();
    for (const key of ['addEventListener', 'removeEventListener', 'dispatchEvent']) globalThis[key] ??= events[key].bind(events);
    globalThis.document ??= { body: null };
    let found = null;
    const capture = (ctx) => async () => {
      await ctx.wait(SerializerReady);
      found = { parse: ctx.get(parserCtx), serialize: ctx.get(serializerCtx) };
    };
    await Editor.make().use(markdownPlugins).use(capture).create().catch(() => {});
    if (!found) throw new Error('the Milkdown parser did not start');
    return found;
  })();
  return started;
}

/** @returns {Promise<(markdown: string) => import('@milkdown/kit/prose/model').Node>} */
export async function editorParser() {
  const { parse } = await start();
  // Milkdown logs a node it cannot build and leaves it out; a test should fail instead.
  return (markdown) => {
    const logged = [];
    const error = console.error;
    console.error = (e) => logged.push(e);
    try {
      const doc = parse(markdown);
      if (logged.length > 0) throw new Error(`the editor could not parse part of the markdown: ${logged[0]?.message ?? logged[0]}`);
      return doc;
    } finally {
      console.error = error;
    }
  };
}

/** The markdown the editor writes for a document. */
export async function editorSerializer() {
  return (await start()).serialize;
}
