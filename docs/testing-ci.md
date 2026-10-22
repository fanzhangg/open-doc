# Testing and CI/CD (draft)

How Ponjo is tested and shipped, derived from
[architecture](architecture.md), [SPEC](../spec/SPEC.md),
[PROJECT](../spec/PROJECT.md) and [agent config](agent-config.md).
Each test guards a rule there; a test that guards none is not needed.

## Principles

1. **Test invariants, not code paths.** Lost text first, then everything
   else.
2. **The format is a contract.** Its tests are fixtures in
   `spec/conformance/` that any tool can run. Anchors run in Node and in the
   browser. The markdown editor's rendered text matches the markdown
   projection on fixtures and on every markdown file in the repository.
3. **Agents are always faked.** A fake agent script edits its copy and
   prints a reply. No test runs Claude Code, Codex or a model.
4. **Every platform, every PR.** Rename, scripts and process trees differ
   most on Windows.
5. **Real files and processes, fake time.** Integration tests use a temp
   folder, real child processes and an injected clock.

Layers: **unit** (pure, `src/core`), **integration** (DocService and
Runner on real files with the fake script, in the test process, standing in
for a window), **e2e** (the packaged app, under xvfb on Linux).

## Tests

### Format — unit, conformance

- Reading (§4): the first of duplicate ids kept; thread order; a reply
  without its first comment hidden; a thread resolved only when its latest
  comment says so.
- **Any order or duplication of lines reads to the same threads** (property
  test). This is what makes `merge=union` safe.
- Unknown major refused; a bad
  line reported, skipped and kept on rewrite; unknown fields kept.
- Writing (§5): the file replaced whole, never torn; only a human sets
  `resolved`.
- Mentions (§6): `@name` matches a buddy's name, case-insensitively.
- A doc's text: UTF-8 only, no byte order mark, LF; written back with its
  byte order mark and CRLF.
- Anchors on the doc's text: exact → context → fuzzy → detached.

### Model — unit, property

- Three-way merge, fuzzed: **the human's text always survives**; the
  buddy's overlapping change is dropped and reported as a conflict;
  disjoint edits merge; the result is deterministic.
- Undo: each change of a run whose new text is still found is put back;
  text changed since, by anyone, stays.
- The inbox: a thread waits on X only after a comment by this user that
  @mentions X, or mentions no one in a thread X opened or was @mentioned in;
  another user id asks no one.
- Same fixtures, same output in Node and the browser.

### DocService — integration

- Writes one at a time; the disk checked before each; an outside write (an
  editor, `git pull`) merged, the typing winning where they overlap, the
  outside version saved.
- Versions saved before and after each buddy edit, before each outside
  change, undo and restore; each can be restored.
- Killed mid-write: the doc and sidecar are intact.
- Two git branches changing one sidecar, merged with `merge=union`, read to
  the expected threads.

### Runner — integration, fake script

- The script runs in a new folder holding only the copy, gets the prompt on
  stdin and `PONJO_DOC`, `PONJO_PROJECT` and `PONJO_BUDDY`, and its stdout becomes the
  reply; the folder is gone after.
- **The human edits during a run**: the human's text stays and the reply is
  marked `conflict`; nothing asks the user.
- Two runs on one doc at once: both edits land, merged one at a time.
- Exit non-zero: the reply is marked `failed` with the end of the output;
  @mentioning again runs again; after a restart, unanswered asks run again.
- Runs only on docs open in a window.
- The shipped scripts, as text: each passes the project folder only when
  there is one, on `sh` and `.cmd`.

### Buddy files — unit, integration

- `<Name>.md`: the file name is the name, the text who it is; a
  renamed file is a renamed buddy; a `Clippy.md` is not a buddy;
  `.ponjo/` created with the first buddy; only the opened folder's counts.
- Doc mode reaches Clippy only, also inside a project folder.
- Clippy's text is the user's `buddies/Clippy.md`, the same in every doc
  and in its runs; empty or missing, Clippy is as it ships; it keeps its
  name and cannot be deleted.
- One agent script runs every buddy, with `PONJO_BUDDY` set;
  **nothing in `.ponjo/` or a sidecar chooses a program**.
- The same project's buddies have the same faces and colors everywhere;
  Clippy and up to seven buddies all have different colors.

### App — e2e

- **No process outlives the app**, agent children included; the app listens
  on no port.
- One app per machine; a second launch hands its files to the first.
- The main flow: open a doc and a folder, @mention a buddy, the fake agent
  edits, Undo on its reply, Cmd+Z undoes only the human's edit, restore a version.

### Sharing — two machines, by hand

After each deploy of the relay (README, Deploying the relay). The owner on
machine A runs the app from `main` with no `PONJO_RELAY`; the teammate is
on machine B, on another network (a phone's hotspot will do), in a browser.

1. **Invite.** A opens a project, Team > Invite link. The link is
   `https://share.ponjo.app/team?room=…`. B opens it, picks a name, and
   is told it waits for the owner.
2. **Allow.** A is notified; in Team, Edit and Allow. B's page shows the
   project's first doc, editable, in a moment. B reloads: in at once.
3. **Both typing.** Both type in the same paragraph at once for a minute.
   Each sees the other's keys as they type; nothing is lost, and the file
   on A holds both. A sets B to Read: B's tools go; back to Edit.
4. **Sleep and wake.** A sleeps (close the lid) for two minutes. B says the
   host went away. A wakes: within 30 seconds B is back in the doc by
   itself, with A's text, and both type again.
5. **Idle.** Leave both untouched for ten minutes, then type: still live.
6. **A new link ends the old one.** A makes a New link. B's page says the
   link no longer works; B opens the new link and is in at once, without
   Allow. A removes B: B's page says so.

## CI

| Stage | Trigger | Runs | On failure |
| --- | --- | --- | --- |
| PR | push to a PR | lint; unit and conformance (Node and browser); integration on Linux, macOS, Windows; web build | blocks merge |
| main | merge | all of PR, e2e on three platforms, nightly installers | blocks the nightly build |
| Nightly | schedule | long merge fuzz, stress | opens an issue |
| Release | version tag | all of main, draft release | blocks publishing |

- A PR that changes `spec/` changes `spec/conformance/` too.
- CI holds no model API keys.

## CD

- Channels: **nightly** (every main), **beta** and **stable** (tags). A
  release is drafted by CI and published by a person.
- Installers: macOS dmg (signed and notarized), Windows NSIS, Linux AppImage.
- The app follows semver. The format's major changes only with the spec,
  its fixtures and a note on what happens to old files.

## Stretch goals

- **Clean install**: installing the signed app on a clean VM and running the
  main flow before each release.
- **Real agents**: run the shipped Claude Code and Codex scripts for real,
  to catch a program changing its flags. First by hand before a release on
  the maintainer's own subscription; later a weekly CI run with a
  subscription token. No pay-per-token API key.
- **Auto-update**: needs a macOS Developer ID; checking is a network call,
  so off by default, and it applies only when the app quits.
