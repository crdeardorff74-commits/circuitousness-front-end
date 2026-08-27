# Circuitousness Front-End — Claude Instructions

Universal rules live in `../../CLAUDE.md`. Read those first.

## Session notes
Read `NOTES.md` (in this folder) at the start of every session. It's the running log of decisions, next steps, and project-specific gotchas that aren't visible in the code. Updated automatically by `/release` and `/rel`, and manually by `/note`.

## Project name
`PROJECT_NAME` is defined in `config.js` (currently `'Circuitousness'`). Change it
there to rename the project — every other file references it.

## Terminology — "Echo" in player copy, `twin` in code (deliberate split)
(Renamed "twins" → "ganged" 2026-08-15, then **"ganged" → "Echo" 2026-08-27**,
both user calls. "Ganged" is the electronics term for controls mechanically
coupled so operating one operates all — exactly right for an EE, opaque to
everyone else, and "gang" carries a negative connotation besides.) The
lockstep-rotation mechanic is called **"Echo"** in every player-facing string:
**echo tiles**, an **echo group**. Each locale uses its own word for an echo
(es/pt/it eco, fr écho, de/nl Echo, pl echo, ru эхо, tr yankı, ar صدى,
hi प्रतिध्वनि, ja エコー, ko 에코, zh 回声).

The name drove the ANIMATION (same call): a group no longer twists in unison.
The touched tile spins first and each ring partner starts the instant the one
before it lands, so the turn travels around the group like an echo. See
`render.js` `animateRotationAt` / `ECHO_MAX_TOTAL_MS`. Copy must no longer say
the group rotates "in unison" / "together" — GATES still do, and that contrast
is now a real one.

The CLICK SFX follows the sequence too — one per tile, not one per input.
`animateRotationAt` takes an `opts.onStep` callback (render owns the tempo, so
render is what knows when each partner moves) and game.js passes `ECHO_CLICK`
from the three sites that already click on step 0: live rotate, hint, live
undo. Replay rotations and the tutorial demo pass nothing and stay silent, as
they always were — do not make this unconditional inside render.

**Code and data keep `twin`** — `_twin` is a wire format baked into every
stored snapshot and server-side recording, and identifiers
(`assignTwins`, `TWIN_COVERAGE`, i18n KEY names like `tooltip.twinTiles`,
element ids like `pg2TwinMin`/`meTwins`) follow it. The mosaic LAYOUT field
`ganged` (and its `g<pct>` save-code segment) likewise stays — stored data, not
copy. Do not rename those; do not let "twin" or "ganged" back into
player-facing copy.
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
