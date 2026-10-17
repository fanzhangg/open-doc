# <img src="build/logo.svg" alt="OpenDoc" width="280" height="80">

Co-author plain markdown with AI buddies. Comments live in a sidecar file
next to the doc (`plan.md` → `plan.md.opendoc.jsonl`), anchored to the text
so they follow it as it changes.

Status: early. A desktop app (Electron) for macOS, Windows and Linux.

## How it works

Select text, comment, and @mention a buddy: `@Clippy tighten this`. The buddy
edits the doc, may comment on other passages, and replies in the thread. Its
edits can be undone from the reply; where you changed the same text, your
text wins. Cmd+Z undoes only your own typing. See [user experience](docs/user-experience.md).

A **buddy** is a markdown file, `<Name>.md`: the first line is its persona,
the rest its instructions. Clippy is built in and in every doc; every other
buddy belongs to a project, in its `.opendoc/buddies/`, and travels with it
([buddies and projects](spec/PROJECT.md)).

What runs a buddy is an **agent**: Claude Code or Codex, through a script in
`agents/` in the config folder. The script gets the prompt on stdin and copies
of the doc and its comments in its working folder, and prints the reply
([agent config](docs/agent-config.md)).

The config folder is `~/Library/Application Support/OpenDoc` on macOS,
`%APPDATA%\OpenDoc` on Windows and `~/.config/opendoc` on Linux
(`OPENDOC_CONFIG_DIR` overrides it). It also holds `settings.json` and each
doc's version history.

- [Architecture](docs/architecture.md)
- [Format spec](spec/SPEC.md), with an [example doc](spec/examples/plan.md)
- [File management](docs/file-management.md)
- [Testing and CI](docs/testing-ci.md)

## Development

```bash
npm install
npm run desktop                      # home page: Open Project, recent projects, Settings
npm run desktop -- path/to/plan.md   # open a doc
npm run desktop -- path/to/project   # open a folder as a project

npm run lint
npm run build           # bundles the editor into dist/web
npm test
npm run smoke:desktop   # launch the app and check it end to end, with a fake agent

npm run pack:desktop    # the desktop app, unpacked, in release/
npm run dist:desktop    # its installer in release/
```

The installer is not signed yet, so Windows SmartScreen warns before running
it. `npm run icon:desktop` generates the Clippy avatar, application logo and
document icons from `web/faces.js` into `build/`.

Requires Node 20 or later.
