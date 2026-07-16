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
versions and updates `NOTES.md`. It does **not** zip; it prints the zip command
below for you to run yourself (Claude doesn't zip — the antivirus flags it).

## Deployment Zip
The zip is named `<PROJECT_NAME>.zip` (so currently `Circuitousness.zip`) and excludes
`CLAUDE.md`, `NOTES.md`, the zip itself, `nul`, the one-off song-art files
`heart-art.html` / `heart-art-bg.jpg`, the marketing cover generator
`cover-art.html`, and the title-O tuning page `title-o-tuner.html`. It is
**flat — root files only** (the `icons/` and `images/` subfolders are not
zipped). You generate it manually; Claude never does.

Run this in PowerShell from anywhere when you're ready to package a release:

```powershell
$d = 'C:\Users\Ryan\Personal\Official Intelligence\circuitousness\circuitousness-front-end'
$z = 'Circuitousness.zip'
$exclude = @('CLAUDE.md','NOTES.md','nul','heart-art.html','heart-art-bg.jpg','cover-art.html','title-o-tuner.html', $z)
$p = Join-Path $d $z
if (Test-Path $p) { Remove-Item $p }
$files = Get-ChildItem $d -File | Where-Object { $exclude -notcontains $_.Name }
Compress-Archive -Path $files.FullName -DestinationPath $p
Write-Host "Zipped $($files.Count) files into $z"
```
