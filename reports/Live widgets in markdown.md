# Live widgets in markdown: no standard, but one convergent pattern

There is no standard markdown extension for live widgets as of October 2026. CommonMark and GFM define nothing for it, and every tool that renders UI from data invents its own syntax. Those syntaxes nonetheless fall into a small number of families, and one of them clearly dominates for tools that keep a plain `.md` file as the source of truth: **a fenced code block whose info string names the widget type, holding a declarative YAML or JSON spec, rendered by the host as a live view and degrading to a readable code block everywhere else.** Obsidian's native Bases (```` ```base ````), Dataview (```` ```dataview ````), SilverBullet's code widgets, and the LLM-oriented MDMA spec (```` ```mdma ````) all use it. The other families either turn the file into code (MDX, Observable Framework, marimo) or only work inside one app (SilverBullet's `${…}` inline Lua). For open-doc, where agents edit the file and the file must stay portable, the fenced declarative block with host-resolved data sources is the best fit.

## The four families

### 1. Fenced block + declarative spec (portable, agent-friendly)

| Tool | Syntax | Data source | Notes |
|---|---|---|---|
| **Obsidian Bases** (core, 2025+) | ```` ```base ```` with YAML `filters` / `views` / `formulas`; or `![[File.base]]` embed | The vault's file index and frontmatter | First-party, so it's the most widely seen example of the pattern. Same YAML works as a standalone `.base` file ([create base](https://obsidian.md/help/bases/create-base); [syntax](https://help.obsidian.md/bases/syntax)) |
| **Dataview** | ```` ```dataview ```` (DQL), ```` ```dataviewjs ````, inline `` `= this.field` `` | Vault index | Still widely used but effectively unmaintained; original author's last commit June 2024 ([dsebastien guide](https://www.dsebastien.net/the-complete-guide-to-dataview-in-obsidian/)) |
| **Datacore** | ```` ```datacorejsx ```` etc. | Vault index incl. sections, blocks, PDFs | Dataview's successor; React views with state and flicker-free live updates; still beta ([plugin page](https://community.obsidian.md/plugins/datacore); [comparison](https://obsidian.rocks/dataview-vs-datacore-vs-obsidian-bases/)) |
| **MDMA** (Mobile Reality) | ```` ```mdma ```` with YAML `type: form \| table \| chart \| button \| tasklist \| approval-gate \| webhook \| callout \| thinking \| custom` | `{ source, params }` reference that the **host's resolver** fetches; the LLM never inlines the rows. `{{binding}}` expressions against a reactive document store | MIT, 71 stars, 566 commits. remark parser, React/Vue/vanilla renderers, validator with 18 lint rules, prompt pack, MCP server. Designed for LLMs to emit ([repo](https://github.com/MobileReality/mdma)) |
| **Markdown UI** | ```` ```markdown-ui-widget ```` with JSON | Widget-local | React/Svelte packages; only secondary sources found, no confirmed repo ([article](https://www.xugj520.cn/en/archives/create-interactive-technical-documentation-markdown-ui.html)) |

Why this family wins for a file-first editor: the block is inert text to every other markdown tool, so GitHub and other editors show the spec as a code block rather than breaking. The spec is data, not code, so an agent can write and edit it safely, a validator can lint it, and the host decides what it is allowed to fetch.

### 2. Inline expressions in an app-specific language

**SilverBullet** renders `${…}` Space Lua expressions inline as live widgets, hiding the code until the cursor enters it. `${query[[from index.tag "project" where …]]}` renders a live table that updates as the space changes, and widgets can return markdown or DOM with click handlers ([Live Preview](https://edge.silverbullet.md/Live%20Preview); [Space Lua](https://silverbullet.md/Space%20Lua); [widget API](https://silverbullet.md/API/widget)). It's the most fluid authoring experience found, but the Lua runtime and index are SilverBullet-only, and the docs still mark Space Lua experimental. Dashboard tools such as IronFlock use a simpler variant, `{{variable}}` placeholders bound to a data column ([IronFlock](https://ironflock.com/en/docs/iot-dashboards/rich-content/)).

### 3. Markdown as a data-app source (build-time, code-first)

- **Evidence** puts ```` ```sql ```` blocks next to components like `<BarChart data={query}/>` and builds a static site; aimed at SQL analysts ([Evidence](https://evidence.dev/blog/business-intelligence-tools)).
- **Observable Framework** uses reactive ```` ```js ```` cells and `${…}` interpolation in markdown, with data loaders in JS, Python or shell that run at build time ([intro](https://courses.cs.washington.edu/courses/csep590a/25wi/readings/framework/introduction.html)).
- **Quarto** (```` ```{ojs} ```` cells) and **marimo** (reactive `mo.md()` with embedded `mo.ui` controls; `.md` notebook format exists but `.py` is primary) sit in the same notebook tradition ([marimo markdown](https://www.mintlify.com/marimo-team/marimo/markdown)).

These are powerful, but the document becomes a program. They're publishing pipelines, not something a WYSIWYG editor round-trips.

### 4. Components in markdown (MDX, Markdoc)

**MDX** compiles markdown + JSX to JavaScript, so any React component, including ones that fetch live data, can appear in the doc. **Markdoc** (Stripe) is the declarative counterpart: `{% tag attr=… %}` restricted to a schema the host registers, with validation; live data comes from the registered component, not the syntax ([Mintlify comparison](https://www.mintlify.com/library/markdown-vs-mdx); [Markdoc vs MDX](https://dev.to/askrodney/astro-markdoc-readable-declarative-mdx-alternative-9m)). Both break plain-markdown portability (tags render as junk elsewhere) and MDX can't be safely edited by an untrusted agent.

## Adjacent: agent UI specs (not markdown, but the same idea)

The generative-UI world solved the "let an LLM emit UI safely" problem with the same declarative-catalog principle, and these specs are good candidates for the payload *inside* a fenced block:

- **A2UI** (Google, v0.9 April 2026): agent sends JSON describing UI; the client renders it from its own component catalog ([v0.9](https://developers.googleblog.com/en/a2ui-v0-9-generative-ui/)).
- **json-render** (Vercel Labs, Apache-2.0, ~16–17k stars): `defineCatalog` with Zod-typed props; the model can only use catalog components; React/Vue/Svelte/Solid/React Native renderers, streaming ([repo](https://github.com/vercel-labs/json-render)).
- **MCP Apps**: the open-ended alternative; servers ship HTML UIs rendered in sandboxed iframes. Google's June 2026 post shows embedding an A2UI renderer inside an MCP App to combine both ([A2UI + MCP Apps](https://developers.googleblog.com/en/a2ui-and-mcp-apps/); [CopilotKit guide](https://www.copilotkit.ai/blog/the-developer-s-guide-to-generative-ui-in-2026)).

## What this means for open-doc

1. **Use the fenced-block pattern.** An info string such as ```` ```opendoc-widget ```` (or one per type: ```` ```chart ````, ```` ```table ````) with a YAML body. It keeps the `.md` portable, survives byte-preserving saves, and Milkdown can render it with a code-block node view keyed on the language, toggling to source on focus the way SilverBullet does.
2. **Keep data references, not data, in the file.** Copy MDMA's `{ source, params }` idea: `source: ./data/sales.csv`, `source: https://api…/metrics.json`, or a named source declared in config. The Electron main process resolves it, which is where file-access and network allow-lists, caching and refresh intervals belong. The agent never pastes rows into the doc, and diffs stay small.
3. **Declarative catalog over scripts.** A fixed, schema-validated set of widget types (table, chart, metric, list, form) is safe for agents to write and easy to validate with the `ajv` already in the project. Leave an escape hatch (MCP-Apps-style sandboxed iframe) for later rather than allowing `dataviewjs`-style JS in documents.
4. **Consider adopting rather than inventing the payload.** MDMA is the closest existing spec to this exact use (markdown + LLM-authored + host-resolved sources, MIT, remark-based like open-doc's parser), though small. json-render's catalog model or A2UI are larger-ecosystem alternatives for the JSON inside the fence.
5. **Comments and widgets interact.** open-doc's quote-based anchoring targets prose; anchoring a comment to a widget would need to quote the block's spec text, so rendered output that changes with live data shouldn't be part of the anchor.
