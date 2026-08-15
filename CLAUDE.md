# Circuitousness Front-End — Claude Instructions

Universal rules live in `../../CLAUDE.md`. Read those first.

## Session notes
Read `NOTES.md` (in this folder) at the start of every session. It's the running log of decisions, next steps, and project-specific gotchas that aren't visible in the code. Updated automatically by `/release` and `/rel`, and manually by `/note`.

## Project name
`PROJECT_NAME` is defined in `config.js` (currently `'Circuitousness'`). Change it
there to rename the project — every other file references it.

## Terminology — "ganged" in player copy, `twin` in code (deliberate split)
(Renamed 2026-08-15, user call.) The lockstep-rotation mechanic is called
**"ganged"** in every player-facing string — the electronics term for
controls mechanically coupled so operating one operates all, chosen because
groups grew past two members and "twins" stopped fitting. Each locale uses
its natural coupled/linked-motion term (es/pt acopladas, fr couplées,
de/nl gekoppelt, it accoppiate, pl sprzężone, ru сцепленные, tr bağlı,
ar مترابطة, hi जुड़ी, ja 連動, ko 연동, zh 联动).

**Code and data keep `twin`** — `_twin` is a wire format baked into every
stored snapshot and server-side recording, and identifiers
(`assignTwins`, `TWIN_COVERAGE`, i18n KEY names like `tooltip.twinTiles`,
element ids like `pg2TwinMin`/`meTwins`) follow it. Do not rename those;
do not let "twin" back into player-facing copy.
Recorded per universal rule b, which was softened 2026-08-07 to make gamepad
optional. Circuitousness ships keyboard and touch only, and that is a decision,
not an unfinished task: the game is grid-cursor navigation against a clock, so a
d-pad walking a cursor across the board loses to both mouse and touch. It would
be an input nobody chooses.

Consequence for copy: **no store listing, marketing blurb or store-page feature
line may claim gamepad support.** `../../STORE_LISTINGS.md` carries the same
warning.

## Version Bumping
Always bump both numbers together — they MUST match (mismatch causes an
infinite refresh loop):
- `APP_VERSION` in `sw.js`
- `PAGE_VERSION` in `index.html`

Use `/release` or `/rel` from inside this folder — that command bumps both
versions and updates `NOTES.md`. It does **not** zip; it prints the zip command
below for you to run yourself (Claude doesn't zip — the antivirus flags it).

## Deployment Zip
The zip is named `<PROJECT_NAME>.zip` (so currently `Circuitousness.zip`) and excludes
`CLAUDE.md`, `NOTES.md`, the zip itself, `nul`, the one-off song-art files
`heart-art.html` / `heart-art-bg.jpg`, the marketing cover generators
`cover-art.html` / `cover-art-v2.html`, and the title-O tuning pages
`title-o-tuner.html` / `icon-o-tuner.html`. It is
**flat — root files only** (the `icons/` and `images/` subfolders are not
zipped). You generate it manually; Claude never does.

Run this in PowerShell from anywhere when you're ready to package a release:

```powershell
$d = 'C:\Users\Ryan\Personal\Official Intelligence\circuitousness\circuitousness-front-end'
$z = 'Circuitousness.zip'
$exclude = @('CLAUDE.md','NOTES.md','nul','heart-art.html','heart-art-bg.jpg','cover-art.html','cover-art-v2.html','title-o-tuner.html','icon-o-tuner.html', $z)
$p = Join-Path $d $z
if (Test-Path $p) { Remove-Item $p }
$files = Get-ChildItem $d -File | Where-Object { $exclude -notcontains $_.Name }
Compress-Archive -Path $files.FullName -DestinationPath $p
Write-Host "Zipped $($files.Count) files into $z"
```
