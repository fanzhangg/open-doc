# <img src="build/logo.svg" alt="Ponjo" width="212" height="80">

An editor to co-author local text files with your human and AI buddies.

- **Real-time collaboration, humans and AI buddies together:** You and your AI buddies edit, comment and @mention in the same doc at the same time. No handoffs, no syncing between tools.
- **You are in control:** AI buddies work beside you through comments and edits. Every change an AI buddy makes is shown and can be undone in one click, so they never take over your doc.
- **Teammates in a browser:** Invite people to a project with a link. They open it in a browser, with no install or account, and once you let them in they read or edit any doc in it with you, seeing who is here and where each person's cursor is. Your computer hosts the project, so it is shared while the app is open.
- **Open & private:** Open source, plain text files with an open comment format, and works with any command-line agent. Your docs stay on your machine: teammates' edits pass through a relay that stores nothing, and Ponjo keeps nothing on a server.

Still not convinced? See the [online demo](https://ponjo.app/preview/?folder)

## Download

Nightly installers for macOS (`.dmg`) and Windows are on the [nightly release](https://github.com/ponjo-app/ponjo/releases/tag/nightly), rebuilt from `main` after every change that passes the checks. They are pre-release builds.

## Getting started

1. Install the app, or build it from source (see below).
2. Open a text file or a folder. Markdown files open in the Markdown editor, other text files as plain text.
3. Select some text, add a comment and @mention an AI buddy. Its reply and any edits show up in the doc as it works.

Buddies run on a command-line agent you already have, such as Claude Code or Codex. See [Agent Config](docs/agent-config.md) to set one up.

## Development

Requires Node 20 or later.

```bash
npm install
npm run build                 # bundle the editor into dist/web
npm run desktop               # build and launch the desktop app
npm run desktop -- path/to/doc.md   # open a doc (or a folder) directly
PONJO_RELAY=ws://127.0.0.1:8787 npm run desktop   # share through the relay run locally (`npx wrangler dev` in relay/, after the build), not wss://share.ponjo.app

npm run lint
npm ci --prefix relay         # once: wrangler, which runs the relay locally for the tests
npm test                      # unit and integration tests
npm run test:stress           # stress tests
npm run test:perf             # each view keeps its latency promise at its limits
npm run smoke:desktop         # launch the built app and check it

npm run pack:desktop          # unpacked app in release/
npm run dist:desktop          # installer in release/
```

### Deploying the relay

The relay and the teammate's page are one Cloudflare Worker at `share.ponjo.app` ([relay/wrangler.toml](relay/wrangler.toml)). Its owner deploys it from a clean checkout of `main`, signed in to Cloudflare with wrangler (`npx wrangler login` in relay/, once):

```bash
npm ci && npm run build       # the page it serves, in dist/web
cd relay
npx wrangler deploy --dry-run # check
npx wrangler deploy
```

Then check it on two machines: [the sharing checklist](docs/testing-ci.md#sharing--two-machines-by-hand).

## Learn more

- [Product vision](docs/product-vision.md)
- [User experience](docs/user-experience.md)
- [Architecture](docs/architecture.md)
- [Markdown view](docs/markdown-view.md)
- [UX Design System](https://ponjo.app/design.html)
- [Sidecar Config Spec](spec/SPEC.md)

## Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/ponjo-app/ponjo). Before opening a pull request, run `npm run lint` and `npm test`.

## License

[MIT](LICENSE)
