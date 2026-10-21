// Two dependencies are quadratic in the length of one paragraph, so a doc
// with no blank lines (a Bible, a verse a line: one paragraph of megabytes)
// took a minute to open: micromark merges a paragraph's text tokens with a
// splice per run, and Milkdown's serializer copies a paragraph's children once
// per child. Until that is fixed upstream, the bundles fix them as they are
// built. A build fails when either file has changed, so a new version of
// either is looked at rather than quietly slow again.

import { readFile } from 'node:fs/promises';

const PATCHES = [
  {
    file: /micromark[\\/]lib[\\/]initialize[\\/]text\.js$/,
    edits: [["    while (++index <= events.length) {\n      if (enter === undefined) {\n        if (events[index] && events[index][1].type === \"data\") {\n          enter = index;\n          index++;\n        }\n      } else if (!events[index] || events[index][1].type !== \"data\") {\n        // Don’t do anything if there is one data token.\n        if (index !== enter + 2) {\n          events[enter][1].end = events[index - 1][1].end;\n          events.splice(enter + 2, index - enter - 2);\n          index = enter + 2;\n        }\n        enter = undefined;\n      }\n    }\n", "    // (opendoc: in one pass, not a splice per run.)\n    let write = 0;\n    while (++index < events.length) {\n      if (events[index][0] === \"enter\" && events[index][1].type === \"data\" && events[index + 2]?.[1].type === \"data\") {\n        enter = index;\n        while (events[index + 2]?.[1].type === \"data\") index += 2;\n        events[enter][1].end = events[index][1].end;\n        events[write++] = events[enter];\n        events[write++] = events[enter + 1];\n        index++;\n      } else {\n        events[write++] = events[index];\n      }\n    }\n    events.length = write;\n"]],
  },
  {
    file: /@milkdown[\\/]transformer[\\/]lib[\\/]index\.js$/,
    edits: [["\t\t\t\t\t\treturn nextChildren.slice(0, -1).concat(this.#maybeMergeChildren(next));\n", "\t\t\t\t\t\tnextChildren[nextChildren.length - 1] = this.#maybeMergeChildren(next);\n\t\t\t\t\t\treturn nextChildren;\n"], ["\t\t\t\treturn nextChildren.concat(child);\n", "\t\t\t\tnextChildren.push(child);\n\t\t\t\treturn nextChildren;\n"]],
  },
];

/** The esbuild plugin that patches them. */
export const patchDeps = {
  name: 'patch-deps',
  setup(build) {
    for (const { file, edits } of PATCHES) {
      build.onLoad({ filter: file }, async ({ path }) => {
        let contents = await readFile(path, 'utf8');
        for (const [from, to] of edits) {
          if (!contents.includes(from)) throw new Error(`${path} has changed: check scripts/patch-deps.js`);
          contents = contents.replace(from, to);
        }
        return { contents, loader: 'js' };
      });
    }
  },
};
