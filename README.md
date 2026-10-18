# <img src="build/logo.svg" alt="OpenDoc" width="280" height="80">

A markdown editor to co-author docs with multiple AI buddies. 

The app gives you an intuitive and non-intrusive way to write with multiple personalized AI buddies in the same text editor. Docs stay plain markdown files on your machine, with comments in a sidecar file next to them. A few principles:

- **You are in control:** AI buddies never take over the doc. They make only small, scoped changes to what you asked about; the app shows what each run changed, and you can undo it in one click.
- **Real-time collaboration:** No handing the doc back and forth between you and an AI agent. You and your AI buddies edit and comment in the doc at the same time without blocking each other.
- **Many AI buddies, not just one:** The magic happens when many personalized AI buddies see the same doc and threads you do, and act through the same edits and comments. Just see how they interact with you and with each other.
- **Familiar experience:** Just like your favorite doc collaboration app: edit, comment and @mention. You already know how to use it.
- **Open:** Open source, plain markdown with an open comment format, and works with any command-line agent (Claude Code, Codex or your own command).

## Download

Nightly installers for macOS (`.dmg`) and Windows are on the [nightly release](https://github.com/fanzhangg/open-doc/releases/tag/nightly), rebuilt from `main` after every change that passes the checks. They are pre-release builds.

## Getting started

1. Install the app, or build it from source (see below).
2. Open a markdown file or a folder.
3. Select some text, add a comment and @mention a buddy. Its reply and any edits show up in the doc as it works.

Buddies run on a command-line agent you already have, such as Claude Code or Codex. See [Agent Config](docs/agent-config.md) to set one up.

## Development

Requires Node 20 or later.

```bash
npm install
npm run build                 # bundle the editor into dist/web
npm run desktop               # build and launch the desktop app
npm run desktop -- path/to/doc.md   # open a doc (or a folder) directly

npm run lint
npm test                      # unit and integration tests
npm run test:stress           # stress tests
npm run smoke:desktop         # launch the built app and check it

npm run pack:desktop          # unpacked app in release/
npm run dist:desktop          # installer in release/
```

## Learn more

- [Product vision](docs/product-vision.md)
- [Architecture](docs/architecture.md)
- [UX Design System](https://fanzhangg.github.io/open-doc/design.html)
- [Sidecar Config Spec](spec/SPEC.md)

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/fanzhangg/open-doc). Before opening a pull request, run `npm run lint` and `npm test`.
