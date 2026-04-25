# circuitousness-front-end — Session Notes

Newest entries on top. See universal rule 9 in `../CLAUDE.md` for what belongs here.

## 2026-04-25 — DPR fix: render in device pixels

- **The persistent "thin lines at tile boundaries inside path channels" bug ate ~10 iterations.** Root cause: Canvas anti-aliasing on non-integer DPR displays (Windows scaling 1.25/1.5). With the usual `ctx.scale(dpr)` setup, integer CSS coords land on FRACTIONAL device pixels — adjacent tiles' fillRect/stroke edges had AA-mismatched pixels at every shared boundary, showing as faint cross-channel lines. **Fix:** compute everything in device pixels (`canvas.width = grid + 2*pad` directly, `ctx.setTransform(1,0,0,1,0,0)` — no DPR scaling), force `cellSize` even, `cellAt` converts incoming CSS pointer coords to device pixels. Earlier attempts (per-cell gridline skip, channel extension by bevel-thickness, removing L/R bevel contrast, fillRect-instead-of-stroke for straights) ALL FAILED because they fought the symptom on the CSS side; only device-pixel rendering eliminates it.
- **Game now framed as a "circuit"** — entry/exit notches connect via an external connector around the grid perimeter, drawn as ONE polyline through `drawCircuitOutline` so every corner is a smooth `lineJoin='round'` bend (separate strokes had visible butt-cap seams). Lit palette is `LIT_GREEN` while in progress, flips to `LIT_GOLD` the moment `Maze.won` becomes true (single `litPalette()` drives every lit element). User mused about renaming the game to something circuit-related but didn't commit.
- **Twin locking** added — `TWIN_PAIR_COUNT` tile pairs (one path-tile + one filler each) rotate together via `_twin = { partner, color }` tags. Cross tiles deliberately excluded (4-rotation-symmetric → coupling would be invisible). Per-pair pastel palette derived programmatically from a base hex via `paletteFromBase` (additive lighten for top, multiplicative darken for bot/right). Hint-locked twins lock their partner too (with the same rotation delta) so they can't desync.
- **Cheat → Hint** rename (i18n key, button id, JS function). Hint-locked path tiles now also light their solution lane gold *before* the connecting chain reaches them — red bevel = locked, gold groove = confirmed-correct.
- **Difficulty thresholds scale with SIZE** in `maze.js`: `MIN_PATH_LENGTH = round(SIZE * 2.25)`, `MIN_PUZZLE_LENGTH = round(SIZE * 1.75)`, `MIN_SHORTCUT_TWISTS = round(SIZE * 1.25)`, `MAX_DFS_STEPS = SIZE² * 125`, `TWIN_PAIR_COUNT = max(1, SIZE−5)`. Retry counts (`MAX_PATH_GEN_TRIES`, `MAX_REROLL_ATTEMPTS`, etc.) stay constant — they tune search algorithms, not difficulty.
- **`MIN_PUZZLE_LENGTH` is on BFS shortest-*possible* path** (treats rotation as free, since the player controls it), not on the intended DFS path. Without this, a puzzle with a long intended path but a short alternative shortcut still felt trivial — the player completes the shortest path, not the DFS one. Endpoint picker now takes farthest-of-`ENDPOINT_SAMPLES=5` random configs so the BFS floor is reachable on attempt 1.
- **Right-click rotates CCW**; touch and left-click rotate CW. `contextmenu` handler suppresses the browser menu only on the canvas.
- **Path channel `pathChannel` extends endpoints by 0 px now** — earlier attempts to extend by 1 or by `b` (bevel thickness) caused visible "tabs" sticking out of cells at terminating channels. The DPR fix made those workarounds unnecessary.

## 2026-04-25 — First playable: 12×12 maze with self-crossing path support
- Game concept (per the user): random grid of straight/elbow/cross tiles, all randomly rotated. Player rotates tiles to connect a continuous path from entry port to exit port on the perimeter. Lit gold = currently connected to entry. Win when the lit path reaches the exit.
- **Cross tiles must support self-crossing paths.** A cross has two non-touching lanes (N–S + E–W); the same solution path can use BOTH lanes (enters via N, exits S, wanders, comes back, enters E, exits W). My initial build forbade this (single-visit DFS, crosses only as filler decoys); user corrected — generator now uses port-walking DFS that lets a cell be revisited iff: (a) first lane was opposite-pair, (b) second lane uses the perpendicular opposite pair (the cross's other lane). Elbow first lanes can never get a second lane.
- Generator is permissive about crosses but doesn't *bias* toward them — many puzzles will have no path-crossings. If the player wants more crosses, add a bias (e.g. preferring exit ports that re-enter visited cells).
- `_solution` field stashed on path tiles for debugging — peek with `Maze.grid[r][c]._solution` in the console. Cross tiles record `_solution: 0` since rotation doesn't affect their connectivity.
- Controls: click/tap rotates a tile 90° CW. `N` key or click on the win banner generates a new puzzle.
- **PWA gotcha:** `sw.js` won't register from `file://`. Preview panel and `python -m http.server` both work fine.
- Open / next: levels & scoring (user said "later"), tile rotation animation (currently snaps), optional cross-bias for harder puzzles, multi-path levels (which would change generation entirely).

## 2026-04-25 — Added PROJECT_SLUG (universal rule 1 update)
- Universal rule 1 now defines two constants per project: `PROJECT_NAME` (display) and `PROJECT_SLUG` (lowercase ASCII identifier). Done because the rename earlier today exposed how many slug-shaped strings sit outside `PROJECT_NAME`'s reach.
- `config.js` now declares both. `sw.js` pulls the slug in via `importScripts('/config.js')` (worker context can't read page globals). `i18n.js` derives `LANG_STORAGE_KEY` from the slug. `index.html` builds its sessionStorage refresh key from the slug.
- **Worker-safety constraint:** `config.js` must stay free of DOM/window references at module top level so `importScripts()` doesn't blow up. Currently safe (only constants + `Logger`). If anything DOM-shaped gets added to `config.js`, gate it behind `typeof window !== 'undefined'`.

## 2026-04-25 — Renamed twixt → twixted
- The original name "Twixt" collides with the **Twixt** strategy board game (1962, Alex Randolph; trademark likely held by Hasbro via the Avalon Hill acquisition). Even though video games (USPTO Class 9/41) and board games (Class 28) sit in different trademark classes, the *likelihood-of-confusion* test could go either way, and SEO would be a permanent fight against the existing game. Rebranding now is cheap insurance.
- Renamed everywhere: folder (`twixt-front-end` → `twixted-front-end`), `PROJECT_NAME` constant, manifest name/short_name/description, page `<title>` and `<h1>`, SW `CACHE_NAME` slug (`twixt-v` → `twixted-v`), `localStorage` key (`twixt_lang`), `sessionStorage` key (`twixt_sw_refreshed`), and the placeholder API URL in `config.js`.
- Project will be a **video game** of some other kind — explicitly NOT a board game (which makes the trademark concern less acute, but renaming was still the right call).

## 2026-04-25 — Project scaffolded (as `twixt`)
- Created via `/create twixt`. Versions at `0.01`. No favicon yet.
- Main JS named `game.js` because the project is intended to be a game.
- Three-input modules (`gamepad.js`, `touch-controls.js`, `controls-config.js`) are skeletons only — APIs declared, bodies stubbed. `DEFAULT_KEYBOARD` / `DEFAULT_GAMEPAD` need filling in once gameplay actions are designed.
- Next: TBD — first feature.

## Process insight worth keeping
- Universal rule 1 promises that renaming "should require touching only `PROJECT_NAME`," but in practice the lowercase project slug threads through several places that aren't covered by that constant: folder names, `CACHE_NAME` in `sw.js`, `localStorage`/`sessionStorage` namespacing keys, the manifest, and any deploy URLs. If we rename a project later, expect to touch all of those by hand. (Could be solved cleanly by adding a `PROJECT_SLUG` constant alongside `PROJECT_NAME` — worth doing as a universal change someday, not now.)
