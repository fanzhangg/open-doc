---
name: verify-before-push
description: Checks to run in the opendoc repo before committing or pushing a change, and how to ship it. Use before any commit, push, or PR here, and whenever a change touches src/server, desktop/ or web/. A push to main rebuilds the nightly installers that users download.
---

# Verify before you push

A push to main rebuilds the nightly installers. CI (`.github/workflows/desktop.yml`)
publishes them only when lint passes and the packaged app opens a doc on
Windows and macOS. It runs the unit tests once, on Linux, but a failure there
does not hold back the nightly, so run them yourself first.

## 1. Read your own diff

Run `git diff` (or `git diff --staged`) and read every hunk before committing.
Check that each hunk sits in the function or object you meant. An edit can
apply cleanly in the wrong place and still parse: 78934ae put a server method
inside the `SECURITY_HEADERS` object, which made every response throw and
crashed every doc window on open.

## 2. Run the checks

```bash
npm run lint      # ESLint; no-undef catches code pasted into the wrong scope
npm run build     # bundles web/ into dist/web
npm test          # node --test; a test or test file times out after 5 min
```

If the change touches `src/server/`, `desktop/` or `web/`, also open a doc in
the real app:

```bash
npm run smoke:desktop
```

It launches the app on a fixture doc, checks that the editor loads it, that a
setting survives a relaunch, and that the bundled CLI runs. It uses a temp
profile, so a running OpenDoc and your settings are not touched.

Do not commit if any of these fail. If a failure is not caused by your change,
say so and show the output instead of working around it.

## 3. Ship through a pull request

Push a branch and open a PR against main rather than pushing to main directly.
The PR runs the same smoke test on Windows and macOS, so a build that only
breaks on one of them shows up before merge. Merge once it is green, unit
tests included; the nightly is rebuilt from main.

## Windows notes

- Creating symlinks needs admin rights or Developer Mode. In tests, link
  folders with `symlink(target, path, 'junction')`, which works without them.
- Paths: build them with `node:path` (`join`, `relative`, `sep`), never by
  joining strings with `/`. Convert to `/` only for display or doc-relative
  names.
