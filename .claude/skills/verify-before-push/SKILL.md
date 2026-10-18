---
name: verify-before-push
description: Checks to run in the opendoc repo before committing or pushing a change, and how to ship it. Use before any commit, push, or PR here, and whenever a change touches src/host, desktop/ or web/. A push to main rebuilds the nightly installers that users download.
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

If the change touches `src/host/`, `desktop/` or `web/`, also open a doc in
the real app:

```bash
npm run smoke:desktop
```

It launches the app on two fixture docs, checks that each editor loads its
doc and that a buddy (a fake agent script) answers in each, that the app
opens no port and survives its doc host stopping (both on Linux), and that a
setting survives a relaunch. It uses a temp profile, so a running OpenDoc and
your settings are not touched.

Do not commit if any of these fail. If a failure is not caused by your change,
say so and show the output instead of working around it.

## 3. Ship through a pull request

main is protected: every change goes through a PR, and GitHub refuses a
direct push or force push, for agents and the owner alike. Ship like this:

```bash
git switch -c <short-branch-name> origin/main   # or start in a fresh worktree
# commit your change
git push -u origin HEAD
gh pr create --base main --fill
gh pr merge --auto --squash
```

`--auto` merges the PR on its own once the required checks, `package (windows)`
and `package (macos)` (lint, installers, smoke test), pass and one person other
than the author approves it. Merging rebuilds the nightly from main. The `test` job does not block the merge, so look at it
before you walk away: if your change broke a unit test, fix it in the same PR
(`gh pr merge --disable-auto` first if it needs more than a quick push).

If `git push` to main is refused, that is the protection working: open a PR.
Never ask for the rule to be lifted to get a change in.

## Windows notes

- Creating symlinks needs admin rights or Developer Mode. In tests, link
  folders with `symlink(target, path, 'junction')`, which works without them.
- Paths: build them with `node:path` (`join`, `relative`, `sep`), never by
  joining strings with `/`. Convert to `/` only for display or doc-relative
  names.
