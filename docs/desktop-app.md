## Desktop App Design

### Summary

Turn the browser editor into a desktop app. The app opens a markdown file
from its own Open dialog, from the OS (double-click, "Open with", drag onto
the window or dock icon, or a command-line path), and keeps every setting in
one user-level file, so a font picked once applies to every doc and every
launch. The CLI, the sidecar format and the agent loop do not change.

Related docs:

- [Product design](product-design.md): what OpenDoc is and why
- [Format spec](../spec/SPEC.md): sidecar format and write protocol (unchanged)
- [README](../README.md): current usage (to be updated when this ships)

### Problem

- The editor runs as `opendoc serve X.md` in a terminal and opens a browser
  tab. Opening a doc means using a terminal; you cannot double-click a `.md`
  file or pick one from a dialog.
- Settings do not stick. The page saves them in `localStorage`, which the
  browser keys by origin, including the port. `serve` picks a new random port
  on every run, so every run starts with default settings: the font, theme,
  width and even the commenter's name reset.
- Agent options exist only as `serve` flags, so they have to be typed again
  on every run.

### Goals

- **Open a doc like any desktop file.** File > Open, Open Recent,
  drag and drop, double-click in Explorer or Finder, "Open with OpenDoc",
  and `OpenDoc plan.md` from a shell.
- **Create a doc in any folder.** Pick a folder (or make a new one) and a
  name, or create one next to the doc you have open, without a terminal.
- **Global settings.** Every setting (name, theme, font, width, outline,
  word count, focus mode, agent options) is stored once per user, applies to
  every open window right away, and is still in effect the next time the app
  starts.
- **Set up the agent in the app.** Everything the `serve --agent` flags do
  today (which agent, its name, what it answers, model, limits, executable,
  isolation, a custom command) is set in Settings > Agent, with no terminal.
- **Same editor and the same files.** The page, the anchoring, the save
  splicing and the agent dispatcher are reused as they are. Docs edited in the
  app stay plain markdown that the CLI and agents read and write as before.

### Non-goals (first release)

- Auto-update, a Mac App Store or Microsoft Store build.
- Tabs or a file tree in one window. One window per doc, like Typora.
- Per-doc settings. Every setting is global for now.
- Network collaboration (unchanged from the product non-goals).

### Experience

**Launching with no file** shows a small start window: New doc, Open, and the
recent docs (up to 10, with their folder). Dropping a `.md` file on it opens
the file.

**Opening a doc** opens one window for it. The title bar shows the file name;
the header is the current editor header. If the doc is already open, its
window is focused instead of opening a second one.

Ways to open a doc:

| From | How |
| --- | --- |
| The app | File > Open (Ctrl/Cmd+O), File > Open Recent, start window list |
| The app | Drag a `.md` onto any window or the start window |
| The OS | Double-click a `.md` / `.markdown` file once OpenDoc is chosen as its app |
| The OS | Right-click > Open with > OpenDoc |
| The OS | Drag a file onto the app or dock/taskbar icon |
| The OS | Taskbar jump list (Windows) or dock menu (macOS) recent docs |
| A shell | `OpenDoc plan.md` (and later `opendoc open plan.md`) |

Opening `X.md.opendoc.json` opens `X.md`. Any other file type is refused with
a message. The app registers for `.md` and `.markdown` as an option; it does
not make itself the default app without the user choosing it.

**Creating a doc** writes an empty markdown file and opens it in a new window.
The sidecar is created later, on the first comment, as it is today.

| From | How |
| --- | --- |
| The app | File > New Doc (Ctrl/Cmd+N), or New doc in the start window: a dialog to pick the folder and the name |
| The app | File > New Doc in This Folder (Ctrl/Cmd+Alt+N): creates `Untitled.md` next to the open doc, with no dialog |
| The OS | Right-click in a folder > New > Markdown Document (Windows; registered by the installer) |
| A shell | `OpenDoc notes/idea.md` for a file that does not exist: asks "Create idea.md in notes?" |

- The New Doc dialog is the OS save dialog. It opens in the open doc's
  folder, else the last folder used, else Documents. It can make a new
  folder (on macOS this needs the `createDirectory` dialog option).
- The name gets `.md` added if it has no `.md` or `.markdown` extension.
- New Doc never overwrites. The file is created with exclusive create
  (`wx`); if the name is taken, the app offers to open the existing doc
  instead. New Doc in This Folder picks the next free name (`Untitled 2.md`,
  ...).
- **File > Rename** (also clicking the doc name in the header) renames the
  doc and its sidecar together, using the same code as `opendoc mv`, so a
  quickly created `Untitled.md` can be named later without losing comments.
  The window keeps its place and history; the server switches to the new
  path.

**Settings** open from the header button, Ctrl/Cmd+, or the app menu, using the
existing Settings dialog. A change applies at once to every open window and is
saved. Quitting and relaunching keeps it. Settings sections:

- General: your name in comments
- Appearance: theme, font, page width
- Editor: outline, word count, focus mode
- Agent (new): see below
- Shortcuts: the existing list

**Settings > Agent** sets up the co-author agent. It replaces the
`serve --agent` flags:

| Setting | Replaces | Notes |
| --- | --- | --- |
| Agent on/off | `--agent` | Off by default |
| Agent | `--agent-cmd` | Claude Code, or Custom command with `{promptFile}`, `{threadsFile}`, `{doc}` |
| Name | `--agent <name>` | The `@name` used in comments, default `claude` |
| Answers | `--mentions-only` | Every comment not addressed to someone else, or only `@name` comments |
| Model | `--model` | Claude Code only; blank uses Claude Code's default |
| Max turns, run time, runs per hour, budget | `--max-turns`, `--run-timeout`, `--runs-per-hour`, `--max-budget-usd` | Same defaults as today |
| Claude Code path | `--agent-bin` | Blank finds it on PATH and in the usual install folders |
| Isolated runs | `--agent-isolated` | Shown with the note that it needs `ANTHROPIC_API_KEY` |

A status line under the agent choice says whether the agent is ready ("Claude
Code found at ...", or what is missing), with a Check again button. Changes
apply to every open doc: the app restarts each doc's dispatcher with the new
options, after the run in progress finishes. Pause, resume and Try again stay
on the agent's avatar in each window, since they are about one doc's runs.

**The agent** is off until the user turns it on once in Settings > Agent; after
that it is on for every doc. The first time it is turned on, the dialog says
what a run is allowed to do (read files, edit this doc, call `opendoc`). The
`.claude` hooks warning that `serve` prints to the terminal is shown in the
dialog and next to the agent's avatar instead.

**Closing** a window stops that doc's server and agent runs. Saving is still
automatic, so there is no "Save changes?" prompt; if a save is in flight the
window waits for it before closing. The last window closed quits the app on
Windows and Linux; on macOS the app stays in the dock as usual.

**File moved or deleted while open:** the page shows a banner (moved or
deleted) and stops saving, instead of failing silently.

### Architecture

```
Electron main process (Node)
├─ app lifecycle, single-instance lock, menus, dialogs, file associations
├─ window manager: one BrowserWindow per open doc, keyed by real path
├─ per doc: startServer(docPath) from src/server/server.js (127.0.0.1, token)
├─ settings store: src/store/settings.js  →  <config dir>/settings.json
└─ app state: <config dir>/state.json (recent docs, window bounds)

BrowserWindow (sandboxed renderer)
└─ loads http://127.0.0.1:<port>/?t=<token>, the existing editor page
   └─ preload: a small window.opendocDesktop API (open, new, recent, reveal)
```

**Electron.** The server, store, watcher and agent dispatcher are Node code
and run unchanged in the main process. Tauri would need a bundled Node
runtime as a sidecar process plus a Rust shell, and its system webview
(WebView2, WKWebView, WebKitGTK) renders fonts and contenteditable
differently per OS. The cost of Electron is a larger download (~100 MB).

**Keep the local HTTP server, one per window.** Each window loads its doc's
server URL, so the page, its API client and the SSE live sync are the same
code in the app and in `opendoc serve`. The token, Host check and CSP stay.
Moving the API to Electron IPC is possible later but not needed for the
first release.

**Settings in a user file, served by the server.** A new
`src/store/settings.js` reads and writes `settings.json` in the user config
directory with the same atomic write as the sidecar:

| OS | Config directory |
| --- | --- |
| Windows | `%APPDATA%\OpenDoc` |
| macOS | `~/Library/Application Support/OpenDoc` |
| Linux | `$XDG_CONFIG_HOME/opendoc` (default `~/.config/opendoc`) |

`OPENDOC_CONFIG_DIR` overrides it (used by tests). The server gets
`GET /api/settings` and `PUT /api/settings` (a partial patch, validated
against a fixed list of keys and values) and sends a `settings` SSE event when
the file changes, so every window, and every `opendoc serve` tab, updates
live. Because this lives in the server, `opendoc serve` gets global settings
too, which fixes the reset bug for browser users as well.

```json
{
  "version": 1,
  "name": "fanzhangg",
  "theme": "system",
  "font": "sans",
  "width": "normal",
  "outline": true,
  "wordCount": false,
  "focus": false,
  "agent": {
    "enabled": false,
    "kind": "claude",
    "name": "claude",
    "command": null,
    "mentionsOnly": false,
    "model": null,
    "maxTurns": 30,
    "runTimeoutMinutes": 10,
    "runsPerHour": 20,
    "maxBudgetUsd": null,
    "bin": null,
    "isolated": false
  }
}
```

Missing keys fall back to the defaults in the editor today; unknown keys are
kept so an older app does not erase a newer app's settings. A corrupt file is
renamed to `settings.json.bak` and defaults are used.

**No flash of default settings.** When the server sends `index.html` it adds
the current theme, font, width and toggles as `data-*` attributes on `<html>`,
so the first paint already uses them. (The CSP does not allow inline scripts,
so this is done in the server, not with an inline script.)

**CLI flags still win.** `opendoc serve --agent claude --model ...` overrides
the saved agent settings for that run without changing the file.

**Agents can call `opendoc` from the app.** Agent runs use
`Bash(opendoc *)`, so `opendoc` must be on the run's PATH. The app ships the
CLI and a small `opendoc` / `opendoc.cmd` shim that runs it with the app's
own runtime (`ELECTRON_RUN_AS_NODE=1`); the dispatcher puts the shim's folder
first on PATH for its runs. Installing the shim on the user's own PATH (like
VS Code's "Install 'code' command") is a later menu item.

**Opening files from the OS.**

- Packaging declares file associations for `.md` and `.markdown`.
- `app.requestSingleInstanceLock()`: a second launch passes its file paths to
  the running app (`second-instance`) and exits. macOS sends `open-file`,
  which can arrive before the app is ready, so it is queued.
- Paths are resolved to real paths before lookup, so the same doc reached
  through two paths opens one window.
- `app.addRecentDocument()` feeds the OS recent lists.

**Security.** `contextIsolation`, `sandbox` and no `nodeIntegration` in the
renderer. A window may only navigate to its own server origin; other links
open in the default browser. The preload API only takes actions the user
started (open dialog, open a recent doc by index, reveal the current file),
never arbitrary paths from the page.

**App state** (`state.json`, not settings): recent docs and the last window
size and position. Not synced between machines and safe to delete.

### Code layout

| Path | Change |
| --- | --- |
| `desktop/main.js` | New: app lifecycle, single instance, menus, open/new dialogs |
| `desktop/files.js` | New: create a doc (exclusive create, next free name), rename doc and sidecar |
| `desktop/state.js` | New: `state.json` (recent docs, last folder, window bounds) |
| `desktop/windows.js` | New: one window per doc, start window, bounds |
| `desktop/preload.cjs` | New: `window.opendocDesktop` |
| `desktop/start.html`, `desktop/start.js` | New: start window (New, Open, recent) |
| `desktop/bin/` | New: `opendoc` and `opendoc.cmd` shims |
| `electron-builder.yml` | New: installers and file associations |
| `src/core/settings.js` | New: defaults and validation, shared by the server and the page |
| `src/store/settings.js` | New: config dir, read, atomic locked write, watch |
| `src/server/server.js` | Settings endpoints and event, settings in `index.html`, moved/deleted doc events, switch to a renamed doc path |
| `src/server/agents/dispatcher.js` | Restart with new options when agent settings change; PATH shim |
| `src/cli/main.js` | `serve` reads saved agent settings; flags override |
| `web/settings.js` | New: the page's copy of the settings, saved through the API, updated by `settings` events |
| `web/ui.js`, `web/main.js` | Use `web/settings.js` instead of `localStorage`; Agent section |
| `web/index.html` | Agent section in Settings |
| `package.json` | `electron` and `electron-builder` as dev dependencies; `desktop` and `dist` scripts |

The npm package (`opendoc` CLI) does not gain Electron as a dependency.

### Plan

Each phase is usable on its own and lands as its own PR.

1. **Global settings in the server.** `src/store/settings.js`, the settings
   endpoints and event, settings rendered into `index.html`, and the page
   switched off `localStorage`. On first load, if there is no settings file
   but the page's `localStorage` has values, the page sends them once so
   nothing is lost. Tests for the store (defaults, unknown keys kept,
   corrupt file, concurrent writes) and the endpoints. This alone fixes the
   reset bug in `opendoc serve`.
2. **Electron shell.** Open a doc from the command line or the Open dialog,
   one window and one server per doc, the start window, recent docs, window
   bounds, close behavior. Creating docs: New Doc (pick folder and name),
   New Doc in This Folder, a shell path to a missing file, and Rename.
   *Done:* `npm run desktop [-- doc.md]`. Notes from building it:
   - The server's `moveTo()` renames the open doc: saves and comment writes
     run one at a time, so a rename waits for a save in flight, and the page
     gets a `renamed` event with the new name.
   - Rename and New Doc use the OS save dialog. On Windows and macOS that
     dialog itself asks "replace?" for an existing name; the app then still
     refuses to overwrite and offers to open the existing doc instead.
   - Closing: the page holds `beforeunload` while an edit is unsaved
     (including typing the editor has not reported yet) and saves it; the app
     retries the close until the page lets go, and after 5 seconds asks
     whether to close anyway. `opendoc serve` gets the browser's "Leave
     site?" prompt from the same handler.
   - The File menu is the only custom menu. Edit is the standard one on macOS
     only (needed for Cmd+C/V there); on Windows and Linux the page handles
     its own shortcuts, so a menu accelerator cannot take Ctrl+Z from the
     editor's history.
   - Preload actions also require user activation (a click or key press), and
     each action is limited to the window it belongs to: the recent list only
     to the start window, rename only to doc windows.
   - Electron fires `ready` only after the ESM entry module has loaded, so
     `desktop/main.js` must not `await app.whenReady()` at the top level.
3. **OS integration.** Single-instance forwarding, `open-file`, drag and
   drop, native menus wired to the page's commands (focus mode, settings,
   shortcuts), Reveal in Explorer/Finder, OS recent documents, moved/deleted
   banner.
   *Done.* Notes from building it:
   - A second launch passes its resolved paths to the running app through
     `requestSingleInstanceLock(additionalData)`, so relative paths resolve
     against the folder the second launch ran in.
   - Drops are read in the preload from the trusted drop event
     (`webUtils.getPathForFile`); the page never supplies a path. Only
     `.md`, `.markdown` and sidecar files are taken; other drops do nothing.
   - The View menu writes settings.json directly (the main process uses
     `src/store/settings.js`) and rebuilds from the same file, so menu
     checkmarks and every open page always agree.
   - Settings…, Keyboard Shortcuts and Focus Mode keep the page's own
     shortcuts: on Windows and Linux the menu shows them without registering
     them (`registerAccelerator: false`), on macOS the menu handles them.
   - The server sends a `missing` event when the doc disappears or comes back.
     `PUT /api/doc` with `recreate: true` writes the page's text back; the
     comments come back only if their sidecar is still there.
   - OS recent documents (`app.addRecentDocument`) only show up in the
     Windows jump list once the app is installed and registered for `.md`
     (phase 5); the macOS dock menu shows them from a checkout.
4. **Agent in the app.** Settings > Agent with every option from the table,
   the readiness check, dispatcher restart on change, the `opendoc` shim on
   the run PATH, the hooks warning in the UI, first-time consent text.
   *Done.* Notes from building it:
   - Agent settings are the `agent` object in settings.json; a patch changes
     only the agent keys it names. `src/server/agents/config.js` turns them
     into the dispatcher's adapter, limits and hooks warning.
   - Every server started without `--agent` flags (each desktop window, and
     `opendoc serve`) takes its agent from settings and follows changes: it
     stops starting runs, lets a run in progress finish, then restarts with
     the new options. Closing a window ends a run instead of waiting for it.
   - The agent's program (`agent.command`, `agent.bin`) decides what runs on
     the machine, so `PUT /api/settings` may only clear it. The desktop app
     sets it through the preload after a native dialog showing the exact
     command (or a native file picker for Claude Code); otherwise it is set in
     settings.json or with `--agent-cmd` / `--agent-bin`.
   - Instead of a one-time consent prompt, the switch's description always
     says what a run may do.
   - Inside the app the `opendoc` shim runs the CLI with the app's own
     runtime and `ELECTRON_RUN_AS_NODE=1`, so an agent's `opendoc reply`
     never starts a second app.
5. **Packaging.** electron-builder targets: Windows NSIS installer first,
   then macOS dmg and Linux AppImage. File associations, the Windows
   New > Markdown Document entry, icons, unsigned
   builds to start. A smoke test that launches the built app on a fixture doc
   and checks that the editor loads and a setting survives a relaunch.
   *Done for Windows* (`npm run dist:desktop`); the macOS and Linux targets
   are configured but not built yet. Notes from building it:
   - `electron-builder.yml` sets the app's entry with `extraMetadata.main`,
     so the npm package keeps the core library as its entry.
   - No asar archive: agent runs read the skill file and run the bundled CLI
     from the app's files, outside Electron's archive support.
   - On Windows, electron-builder's own file association would make OpenDoc
     the default class for `.md` (and leave `.md` pointing at a deleted class
     after uninstall), so `build/installer.nsh` registers instead: a
     `OpenDoc.md` type, OpenDoc in "Open with" for `.md` and `.markdown`, and
     a New > Markdown Document entry if no other app has one. Uninstall
     removes only those. macOS and Linux declare the types the usual way.
   - `scripts/smoke-desktop.js` (`npm run smoke:desktop`) launches the
     packaged app (or the checkout's) with remote debugging, a temp settings
     folder and its own profile, so it never touches a running OpenDoc; it
     checks the doc loads, a setting survives a relaunch, and the bundled
     `opendoc` runs with `ELECTRON_RUN_AS_NODE`.
   - The icon is `build/icon.svg`, rendered to `build/icon.png` by
     `scripts/make-icon.cjs`.

### Risks

- **Antivirus and SmartScreen** warn on unsigned Windows installers; macOS
  Gatekeeper blocks unsigned apps without a right-click Open.
- **Port per window.** Each window costs one loopback port and one file
  watcher. Fine for tens of docs; revisit if people keep hundreds open.
- **Agent runs need `claude` on the user's machine.** The app does not
  bundle Claude Code; the Agent section shows when it is not found.

### Open questions

- Which platforms must the first release support? (Windows first is assumed.)
- Is code signing (Windows certificate, Apple Developer ID) in scope for the
  first release?
- Should the app reopen the docs that were open when it quit?
- Should `opendoc serve` stay as a supported browser mode, or become a
  developer-only command once the app exists?
- Should `opendoc open X.md` launch the desktop app when it is installed?
