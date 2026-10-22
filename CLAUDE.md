# Ponjo

A markdown editor where people and AI buddies co-author docs.
Product: docs/product-vision.md, docs/user-experience.md. Design: docs/architecture.md.
Comment format: spec/SPEC.md. Commands: README.md "Development".
Before any commit, push or PR: the verify-before-push skill.

## Working rules

- Agree on requirements and design with the person you work with before implementing.
- Keep the architecture and code minimal: code only for essential complexity; no unused abstractions, config, dependencies or defensive code; reuse before adding, delete before adding.
- Lint rules (`eslint.config.js`, `.dependency-cruiser.js`, `knip.config.js`) and `.claude/settings.json` are the person's to change: agents cannot write them. If a rule blocks you, change the code or ask.
- Never run the desktop smoke test (`npm run smoke:desktop`) without the person's approval; CI runs it on every PR.
- Split big tasks into small goals with clear acceptance boundaries.
- Commits, PRs and docs: core points and essential complexity only, not accidental complexity.
- UI: read the design system `site/design.html` and `site/avatars.html` first (live at https://ponjo.app/design.html) and follow it strictly; if the system itself changes, change it and the tokens in `web/app.css` before the UI.

## Issues and PRs

- Labels: `ready` (agreed, anyone may take it), `needs-decision` (waiting on a person), `human-proposed` / `ai-proposed` (who raised it).
- Before starting an issue, assign it to yourself (an agent assigns the person it works for); if someone else has it, ask first.
- A PR that finishes an issue says `Closes #n` in its body.
- Agents may file issues, but only after the person they work for approves each one. Before a session ends, propose issues for the open problems and follow-ups: one per item, what and why only, labeled `ai-proposed`; check for duplicates first and add to an existing issue instead.
