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
The touched tile spins first and each ring partner follows, starting as the one
before it passes its HALFWAY point (`ECHO_OVERLAP`, set to 0.5 the same day —
strict one-after-the-next read as a queue of separate turns rather than one
travelling wave). See `render.js` `animateRotationAt` / `ECHO_MAX_TOTAL_MS`.
Copy must no longer say the group rotates "in unison" / "together" — GATES
still do, and that contrast is now a real one.

Two things a spinning tile does NOT take with it: its bevel LIGHTING and its
brushed-metal GRAIN. Both are properties of the board, fixed in screen space —
the light via `bevelColorForEdge`’s `spinLightOffsetDeg`, the grain by
un-spinning the CTM for that one pattern fill (`activeSpin`). Both looked fine
across a 200ms unison spin and broke visibly once a partner could hold its
pre-turn angle: the bevels wore their destination shading from frame one, and
the grain snapped 90° out of alignment with every other tile at click time.

The CLICK SFX follows the sequence too — one per tile, not one per input.
`animateRotationAt` takes an `opts.onStep` callback (render owns the tempo, so
render is what knows when each partner moves) and game.js passes `ECHO_CLICK`
from the three sites that already click on step 0: live rotate, hint, live
undo. Replay rotations and the tutorial demo pass nothing and stay silent, as
they always were — do not make this unconditional inside render.

And the LIGHTING waits with it. A unit that has not finished its turn is drawn
in its pre-turn geometry, so each in-flight anim holds that unit’s lit lanes
from a snapshot (`applyLitFreeze` / `preTurnCellOf`) instead of the live map —
otherwise the circuit runs through a lane that has not swung into place. The
lookup mirrors the canvas transform in both axes (which cell it is drawn on,
which port each lane had), and `circuitousness/tests/echo-lit-freeze-test.js`
pins that algebra against the real maze.js.

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
versions, updates `NOTES.md`, and commits + pushes to GitHub. It does **not**
zip (Claude doesn't zip — the antivirus flags it; the user's BAT file does it).

## Git / deploy
This folder IS a git repo (set up 2026-09-05; before that the user uploaded files
through the GitHub web UI by hand — that's what the "Add files via upload" commits
are). Remote: `crdeardorff74-commits/circuitousness-front-end`, branch `main`.

⚠ **Netlify auto-deploys this repo, so pushing publishes the live game.** `/rel`
pushes, which means a release now goes live on its own. The zip for itch and
CrazyGames is still separate and still manual.

Three local settings this repo depends on — none of them survive a fresh clone,
so re-apply them if one is ever made:
- `core.autocrlf false` — the 372 pre-existing commits were web uploads, and
  letting git renormalize line endings would turn one release into a whole-repo diff.
- `git update-index --skip-worktree cover-art.html title-o-tuner.html` — both live
  in the project PARENT locally but exist in the repo root. Without this, every
  commit would stage their deletion and remove them from the live site.
  `.gitignore` cannot do this; it does not apply to already-tracked files.
- `.gitignore` covers the deploy zip, `.claude/`, `images/` (local scratch art,
  referenced by nothing shipped) and `nul`.

⚠ The repo is NOT the same file set as the zip: it keeps `CLAUDE.md` and `NOTES.md`
(the zip excludes them) and carries `cover-art.html` / `title-o-tuner.html`, which
the zip doesn't. Don't "reconcile" the two.

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
