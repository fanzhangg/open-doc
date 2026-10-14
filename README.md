# opendoc

Co-author plain markdown with AI agents. Comments live in a sidecar file next
to the doc (`plan.md` → `plan.md.opendoc.json`), anchored to the text so they
survive edits by either side.

Status: early. This repo currently holds the format spec and the core
anchoring library; the CLI, local editor and agent skill come next.

- [Format spec](spec/SPEC.md) and [JSON Schema](spec/opendoc.schema.json)
- [Example doc](spec/examples/plan.md) and [its sidecar](spec/examples/plan.md.opendoc.json)

## Core library

```js
import { project, findQuote, createAnchor, reanchorThreads } from 'opendoc';

const { text } = project(markdown);            // rendered text, markup removed
const range = findQuote(text, 'ship all six'); // or a selection from the editor
const anchor = createAnchor(text, range.start, range.end);

// After the doc changes:
const { threads } = reanchorThreads(project(newMarkdown).text, sidecar.threads);
```

Re-anchoring tries an exact match, then the unchanged text around the quote
(context bracket), then a fuzzy match, and otherwise marks the thread
`detached` without losing it. See [SPEC.md §3](spec/SPEC.md#3-anchors).

## Development

```bash
npm install
npm test
```

Requires Node 20 or later.
