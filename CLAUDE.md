# Circuitousness Front-End — Claude Instructions

Universal rules live in `../../CLAUDE.md`. Read those first.

## Session notes
Read `NOTES.md` (in this folder) at the start of every session. It's the running log of decisions, next steps, and project-specific gotchas that aren't visible in the code. Updated automatically by `/release` and `/rel`, and manually by `/note`.

## Project name
`PROJECT_NAME` is defined in `config.js` (currently `'Circuitousness'`). Change it
there to rename the project — every other file references it.

## Version Bumping
Always bump both numbers together — they MUST match (mismatch causes an
infinite refresh loop):
- `APP_VERSION` in `sw.js`
- `PAGE_VERSION` in `index.html`

Use `/release` or `/rel` from inside this folder — that command bumps both
versions and regenerates the deploy zip in one step.

## Deployment Zip
The zip is named `<PROJECT_NAME>.zip` (so currently `Circuitousness.zip`) and excludes
`CLAUDE.md`, the zip itself, and `nul`. Generated only on `/release` / `/rel`,
not automatically on every change.
