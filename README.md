# opendoc

Co-author plain markdown with AI agents. Comments live in a sidecar file next
to the doc (`plan.md` → `plan.md.opendoc.json`), anchored to the text so they
survive edits by either side.

Status: early. This repo holds the format spec, the core library and the
CLI; the local editor and the agent skill come next.

- [Format spec](spec/SPEC.md) and [JSON Schema](spec/opendoc.schema.json)
- [Example doc](spec/examples/plan.md) and [its sidecar](spec/examples/plan.md.opendoc.json)

## CLI

```bash
opendoc comment plan.md --quote "ship all six features" "Is six realistic?" --as fzhan --kind human
opendoc comments plan.md                 # open threads, with line numbers
opendoc inbox plan.md --as claude        # threads waiting on claude
opendoc wait plan.md --as claude         # block until one is, mark it, print it
opendoc reply plan.md t_k3x9q2m7pa "Cut to three." --as claude
opendoc resolve plan.md t_k3x9q2m7pa --as claude
opendoc mv plan.md q4-plan.md            # moves the sidecar too
```

Every command takes `--json`. `--as` defaults to `OPENDOC_AS`; `--kind`
defaults to `agent`. Exit codes: 0 ok, 1 error, 2 bad input, 3 `wait` timed
out, 4 sidecar busy. A thread is in someone's inbox when its latest message is
from a human and mentions them or no one.

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
