# Contributing to Ponjo

Thanks for helping. People and AI agents both contribute here; the same rules apply to both.

## Start here

- What we build and why: [product vision](docs/product-vision.md), [user experience](docs/user-experience.md).
- How it is built: [architecture](docs/architecture.md). Comment format: [SPEC](spec/SPEC.md).
- Try it without installing: the [online demo](https://fanzhangg.github.io/open-doc/preview/?folder).

## Pick an issue

- `good first issue`: small, with clear acceptance; a good first PR.
- `ready`: requirements agreed; anyone may take it.
- `needs-decision`: still being discussed. Join the discussion, but don't send code yet.

Comment on the issue before you start so we can assign it to you. For anything not in an issue, open one first and agree on what to do before writing code.

## Set up

Node 20 or later, then follow [README › Development](README.md#development):

```bash
npm install
npm run desktop     # build and launch the app
```

## Before you open a PR

```bash
npm run lint
npm run build
npm test
```

- Read your own diff hunk by hunk.
- Keep it minimal: code only for what the issue needs, no unused abstractions, config or dependencies.
- UI changes follow the design system: [design](site/design.html) and [avatars](site/avatars.html) ([live](https://fanzhangg.github.io/open-doc/design.html)).
- Build paths with `node:path`, never by joining strings with `/`: CI runs on Windows and macOS.
- Don't loosen lint rules (`eslint.config.js`, `.dependency-cruiser.js`, `knip.config.js`) to get a change through. If a rule blocks you, ask in the issue.

## The PR

- One issue per PR. Say `Closes #n` in the body.
- Describe the core change and why, not every step.
- CI builds the app and runs a smoke test on Windows and macOS; a maintainer reviews and merges.
