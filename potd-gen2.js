/**
 * potd-gen2.js — the Puzzle-of-the-Day generator (v2). LIVE since
 * 2026-08-01; the v1 sizing it replaced lived in potd.js's generateDims.
 *
 * Two consumers, one definition:
 *   • potd.js calls defaultParams() + rollParams() for every daily slot,
 *     so the DEF_* block below is the PotD's difficulty configuration.
 *   • the debug panel (?debug=true) drives the same rollParams through
 *     sliders that OPEN on those same numbers, so it stays a faithful
 *     preview of production rather than a separate universe. It keeps its
 *     own worker and its own load-into-play path, and still seeds nothing.
 *
 * (The file name is historical — it was the experimental v2 while the
 * ranges were being tuned. Renaming it means touching index.html's script
 * list and is deliberately left alone.)
 *
 * WHY v2: the v1 generator's only random axis was board size, rolled
 * from a narrow per-slot window (singular 5-9, quad 8-14 sub-tiles) with
 * twin coverage pinned at maze.js's 30% and gates pinned at 3. Every
 * day's s2 therefore feels like the last day's s2. v2 rolls three
 * independent axes per puzzle, each from a RANGE the tuner picks:
 *
 *   • board size    — one range, sampled INDEPENDENTLY per axis, so
 *                     6-9 yields 6×9 and 8×7 as readily as 7×7.
 *                     Expressed in LOGICAL tiles (what the player sees):
 *                     doubled to physical sub-tiles in quad mode.
 *   • twin coverage — 10-80% of the board inside some twin group. Needs
 *                     maze.js's setTwinCoverageTarget: the per-run ramp
 *                     scale is clamped to 1 and so tops out at the 30%
 *                     TWIN_COVERAGE constant, which is the FLOOR of the
 *                     interesting range here, not the ceiling.
 *   • gate count    — 0-20 requested. assignGates degrades gracefully
 *                     (no two gates on adjacent vertices), so the
 *                     PLACED count is reported separately — on a small
 *                     board a request for 20 lands far fewer, and that
 *                     gap is exactly what the tuner needs to see.
 *
 * Path count and quad mode are NOT rolled — they're fixed by the slot
 * (s1-s4 / q1-q4), the axis the eight daily puzzles vary along by design.
 * The panel selects them instead, so a tuner can explore the rolled axes
 * within one slot shape.
 *
 * Generation runs in its own Web Worker (an independent Maze instance,
 * so an in-progress build can't disturb the board on screen), with a
 * main-thread fallback if the worker can't spawn. Gates are assigned on
 * the main thread afterwards — gates.js isn't imported in the worker —
 * using the same save/restore dance potd.js uses.
 *
 * TIMING CAVEAT: the reported milliseconds are browser wall-clock and
 * include whatever else the machine is doing. game.js's Marathon
 * starter pre-gen runs its own worker in the background for the first
 * few seconds after a debug-page load; the result line flags a run that
 * overlapped it, because that run's number is inflated.
 */

const PotdGen2 = (() => {
    // ── Slider bounds (the tunable space, not the defaults) ──
    // Size is PHYSICAL SUB-TILES, stepping by 2, and means the same thing
    // in both modes: a 10 is a 10-sub-tile axis whether that reads as 10
    // singular tiles or 5 quad tiles. (It was logical tiles doubled for
    // quad, which made a "15" quad board 30 sub-tiles — the slider read as
    // one unit and behaved as another.) The step of 2 is what lets one
    // control serve both: quad needs even sub-tile dims so each 2×2 group
    // fits. It bounds only what the RANGE can express — inside the range,
    // singular still rolls odd sizes too (see rollParams).
    // The 20 ceiling is well past where generation gets expensive — that
    // headroom is deliberate, since finding the point where cost becomes
    // unacceptable for a daily puzzle is what the timing readout is for.
    const SIZE_FLOOR = 4,   SIZE_CEIL = 20;   // sub-tiles, step 2
    const SIZE_STEP  = 2;
    const TWIN_FLOOR = 10,  TWIN_CEIL = 80;   // percent
    const GATE_FLOOR = 0,   GATE_CEIL = 20;
    // Twin group size. 2 is the floor because a "group" of 1 is just a
    // tile; 16 is the ceiling because that's the palette size, and the
    // palette also caps the group COUNT (colours never repeat), so the
    // most tiles that can be coupled is 16 × max regardless of what twin
    // coverage asks for.
    const GROUP_FLOOR = 2,  GROUP_CEIL = 16;
    // Area window for rows × cols in SUB-TILES — the same unit the size
    // slider uses, and the unit cost scales with (the maze is built at
    // sub-tile resolution in both modes, so a quad board is no cheaper per
    // sub-tile than a singular one). Stepped by 10 because a 12rem track
    // can't meaningfully resolve 200 discrete positions.
    const TILES_FLOOR = 20, TILES_CEIL = 300, TILES_STEP = 10;
    // ── THE LIVE VALUES (chosen 2026-08-01 after tuning in the panel) ──
    // These are no longer just the panel's opening positions: potd.js
    // generates every daily puzzle from them via defaultParams(), so this
    // block IS the PotD's difficulty configuration. Change a number here
    // and tomorrow's puzzles change with it.
    // The 6 floor is load-bearing, not taste (raised from 4 on 2026-08-01
    // before v2 ever seeded a day). A floor of 4 let the area window
    // produce 4:1 boards — 16×4, 15×4, quad 16×4 = 8×2 tiles — and those
    // CANNOT be built at 3-4 paths. maze.js's multi-path branch is
    // `while (bestCount < target)` with no attempt ceiling, so it never
    // settles for fewer paths; it spins. An s4/q4 slot rolling one of
    // those shapes would simply never generate its daily puzzle. 6 keeps
    // the widest shape near 13×6, which builds.
    const DEF_SIZE_MIN = 6, DEF_SIZE_MAX = 16;
    // The area window is the DOMINANT control at these settings: a 6-16
    // size range rolls boards from 36 to 256 sub-tiles, and this clamps
    // almost all of them into 50-80. That's deliberate — the size range
    // supplies the SHAPE (how square or oblong), the window pins the
    // actual amount of board, and generation cost tracks area far more
    // closely than it tracks either axis.
    const DEF_TILES_MIN = 50, DEF_TILES_MAX = 80;
    const DEF_TWIN_MIN = 11, DEF_TWIN_MAX = 42;
    const DEF_GATE_MIN = 2,  DEF_GATE_MAX = 6;
    const DEF_GROUP_MIN = 2, DEF_GROUP_MAX = 6;

    const HISTORY_MAX = 10;   // generations kept in the panel's log

    let history = [];         // [{ label, ms }, …] newest first
    let generating = false;

    function randInt(lo, hi) {
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    }

    // Walk a board's dimensions until rows × cols lands inside the area
    // window [minT, maxT].
    //
    // Too small: grow whichever axis is currently SMALLER, ties to the
    // WIDTH. Too big: shrink whichever axis is currently LARGER, ties to
    // the HEIGHT. Both rules pick the cheapest single step toward the
    // target, and both tie-breaks exist for the same reason — at
    // rows === cols, growing the height or shrinking the width would tip
    // the board portrait, so each takes the other axis instead. Landscape
    // is preserved at every step, not just at the end.
    //
    // `step` is 2 in quad mode so dims stay even (2×2 groups must divide
    // cleanly) and 1 in singular.
    //
    // The MAXIMUM WINS when both can't hold: growth stops as soon as the
    // board reaches minT, which can overshoot maxT by one step when the
    // window is narrow (min 100 / max 100 from a 9×11 = 99, say). Running
    // the shrink pass second means the ceiling — the one that bounds
    // generation cost and screen fit — is always respected, and the floor
    // is best-effort. The SIZE_FLOOR/SIZE_CEIL guards can't trigger at the
    // sliders' real bounds (4×4 = 16 is far under any minimum, and 20×20 =
    // 400 is above any maximum) but they guarantee termination if those
    // bounds ever move.
    function fitToTileRange(rows, cols, minT, maxT, step) {
        let r = rows, c = cols;
        while (r * c < minT) {
            if (r < c) {
                if (r + step > SIZE_CEIL) break;
                r += step;
            } else {
                if (c + step > SIZE_CEIL) break;
                c += step;
            }
        }
        while (r * c > maxT) {
            if (c > r) {
                if (c - step < SIZE_FLOOR) break;
                c -= step;
            } else {
                if (r - step < SIZE_FLOOR) break;
                r -= step;
            }
        }
        return { rows: r, cols: c };
    }

    // The tuned live configuration, shaped for rollParams. potd.js calls
    // this for every daily slot, so the DEF_* block above is the single
    // definition of PotD difficulty — the debug panel's sliders open on
    // the same numbers, which is what makes the panel a faithful preview
    // of production rather than a separate universe.
    //
    // quadMode / pathCount still come from the SLOT (s1-s4, q1-q4), not
    // from here: those are the axis the eight daily puzzles vary along by
    // design, and everything else is rolled per puzzle.
    function defaultParams(quadMode, pathCount) {
        return {
            sizeMin:  DEF_SIZE_MIN,  sizeMax:  DEF_SIZE_MAX,
            minTiles: DEF_TILES_MIN, maxTiles: DEF_TILES_MAX,
            twinMin:  DEF_TWIN_MIN / 100, twinMax: DEF_TWIN_MAX / 100,
            groupMin: DEF_GROUP_MIN, groupMax: DEF_GROUP_MAX,
            gateMin:  DEF_GATE_MIN,  gateMax:  DEF_GATE_MAX,
            pathCount: pathCount, quadMode: !!quadMode,
            // Mosaic never comes from a PotD slot — the eight daily
            // puzzles are s1-s4 / q1-q4 — so it defaults off here and is
            // only ever turned on by the debug panel's Tiles radio.
            mosaicMode: false,
        };
    }

    // Roll one puzzle's parameters from the panel's ranges.
    //   p = { sizeMin, sizeMax, twinMin, twinMax, gateMin, gateMax,
    //         pathCount, quadMode }   (twin* as 0..1 fractions)
    // Returns PHYSICAL sub-tile dims, which is what Maze.setDimensions
    // and the worker both consume — and, since the size range is now
    // expressed in sub-tiles too, no conversion happens on the way.
    function rollParams(p) {
        // The slider's step of 2 is a constraint on what the RANGE can
        // express, not on what gets rolled inside it. Only quad actually
        // needs even dims (each 2×2 group has to divide cleanly), so quad
        // steps by 2 while singular rolls every integer in the range — a
        // 6-10 range gives quad {6,8,10} and singular {6,7,8,9,10}. Losing
        // the odd sizes in singular would have thrown away half the size
        // variety for a constraint that mode doesn't have.
        const evenSpan = Math.floor((p.sizeMax - p.sizeMin) / SIZE_STEP) + 1;
        const roll = p.quadMode
            ? () => p.sizeMin + SIZE_STEP * Math.floor(Math.random() * evenSpan)
            : () => randInt(p.sizeMin, p.sizeMax);
        // Both axes roll from the same range, then the pair is ORDERED so
        // the board is always wider than tall, or square — never taller
        // than wide. Screens are landscape far more often than not, and a
        // tall board wastes the width it does have. Portrait players get
        // the same board rotated 90° at load (see loadIntoPlay), so this
        // costs them nothing: one canonical puzzle, two presentations.
        const a = roll();
        const b = roll();
        const wanted = { rows: Math.min(a, b), cols: Math.max(a, b) };
        // Area window, applied to the ordered pair so the grow/shrink rules
        // and "stay landscape" agree. Recorded when it moves the dims so the
        // panel can show what the roll originally wanted — a window that's
        // silently rewriting most rolls is worth seeing.
        const dims = fitToTileRange(wanted.rows, wanted.cols, p.minTiles, p.maxTiles,
                                    p.quadMode ? SIZE_STEP : 1);
        const moved = (dims.rows !== wanted.rows || dims.cols !== wanted.cols);
        return {
            rows:         dims.rows,
            cols:         dims.cols,
            resizedFrom:  moved ? wanted : null,
            // Continuous, not stepped — coverage is a budget fraction, so
            // any value in the range is meaningful.
            twinCoverage: p.twinMin + Math.random() * (p.twinMax - p.twinMin),
            // Group sizes are rolled PER GROUP inside maze.js, not here —
            // the range is passed through so sizes can vary within one
            // board rather than one size being picked for the whole board.
            twinGroupMin: p.groupMin,
            twinGroupMax: p.groupMax,
            gateTarget:   randInt(p.gateMin, p.gateMax),
            pathCount:    p.pathCount,
            quadMode:     p.quadMode,
            mosaicMode:   !!p.mosaicMode,
        };
    }

    // ── Worker plumbing ───────────────────────────────────────────────
    // Deliberately its own worker rather than borrowing potd.js's: this
    // module is debug-only and must not be able to disturb the live
    // PotD generation queue. Same recovery shape as potd.js's — one
    // error discards the instance, repeated errors fall back to
    // main-thread builds for the rest of the session.
    const MAX_WORKER_FAILURES = 3;
    let worker          = null;
    let workerAvailable = true;
    let workerFailures  = 0;
    let workerNextId    = 0;
    let workerCallbacks = new Map();   // id → { resolve, reject }

    function ensureWorker() {
        if (worker || !workerAvailable) return worker;
        try {
            worker = new Worker('maze-worker.js?t=' + Date.now());
            worker.onmessage = function (e) {
                if (!e.data || e.data.type !== 'ready') return;
                workerFailures = 0;
                const cb = workerCallbacks.get(e.data.id);
                if (cb) {
                    workerCallbacks.delete(e.data.id);
                    cb.resolve(e.data.state);
                }
            };
            worker.onerror = function (err) {
                workerFailures++;
                if (typeof Logger !== 'undefined') {
                    Logger.warn('PotD v2 worker error', {
                        message: err && err.message,
                        filename: err && err.filename,
                        line: err && err.lineno,
                        fails: workerFailures,
                    });
                }
                worker = null;
                if (workerFailures >= MAX_WORKER_FAILURES) workerAvailable = false;
                for (const [, cb] of workerCallbacks) cb.reject(err);
                workerCallbacks.clear();
            };
        } catch (e) {
            if (typeof Logger !== 'undefined') {
                Logger.warn('PotD v2 worker: construction failed', e && e.message);
            }
            workerAvailable = false;
            worker = null;
        }
        return worker;
    }

    function requestWorkerMaze(roll) {
        return new Promise((resolve, reject) => {
            const w = ensureWorker();
            if (!w) return reject(new Error('worker unavailable'));
            const id = ++workerNextId;
            workerCallbacks.set(id, { resolve, reject });
            w.postMessage({
                type: 'generate',
                id,
                rows: roll.rows, cols: roll.cols,
                pathCount: roll.pathCount, quadMode: roll.quadMode,
                mosaicMode: roll.mosaicMode,
                twinCoverage: roll.twinCoverage,   // absolute override
                twinGroupMin: roll.twinGroupMin,
                twinGroupMax: roll.twinGroupMax,
            });
        });
    }

    // Walk the LOADED board's twin rings and report what was actually
    // built: how many groups, their size spread, and the coverage reached.
    //
    // Worth measuring rather than assuming, because two settings can fight:
    // the 16-colour palette caps the group COUNT, so no board can couple
    // more than 16 × (max group size) tiles no matter what twin coverage
    // asks for. Requesting 80% with a 2-4 size range on a 300-cell board
    // yields 64 tiles (21%), and without this readout that gap is silent.
    //
    // Quad rings are keyed by each member quad's top-left sub-tile, so the
    // walk steps by 2 there and each member counts as 4 sub-tiles.
    function twinStats() {
        const quad = !!Maze.quadMode;
        const step = quad ? 2 : 1;
        const seen = new Set();
        const sizes = [];
        let coupled = 0;
        for (let r = 0; r < Maze.ROWS; r += step) {
            for (let c = 0; c < Maze.COLS; c += step) {
                const t = Maze.grid[r] && Maze.grid[r][c];
                if (!t || !t._twin) continue;
                const start = r + ',' + c;
                if (seen.has(start)) continue;
                seen.add(start);
                let ring = 1;
                let cur = t._twin.partner;
                // Bounded walk — loadSnapshot's sanitizer already strips
                // broken rings, but never trust a ring to terminate.
                for (let guard = 0; guard < 4096 && cur !== start; guard++) {
                    if (seen.has(cur)) break;
                    seen.add(cur);
                    ring++;
                    const p = cur.split(',');
                    const nt = Maze.grid[+p[0]] && Maze.grid[+p[0]][+p[1]];
                    if (!nt || !nt._twin) break;
                    cur = nt._twin.partner;
                }
                sizes.push(ring);
                coupled += ring * (quad ? 4 : 1);
            }
        }
        return {
            groups: sizes.length,
            min: sizes.length ? Math.min.apply(null, sizes) : 0,
            max: sizes.length ? Math.max.apply(null, sizes) : 0,
            coverage: coupled / (Maze.ROWS * Maze.COLS),
        };
    }

    // Place gates on a just-built maze and read back the metrics the
    // tuner cares about. Saves and restores the LIVE Maze + Gates around
    // the whole dance for the same reason potd.js does: assignGates
    // needs Maze.solutionEdges(), which in quad mode temporarily
    // un-scrambles the grid, so the board must be loaded here — and the
    // player may have a puzzle on screen.
    //
    // Returns { maze, gates, gatesPlaced, minMoves }. The maze snapshot
    // is re-taken AFTER loadSnapshot and BEFORE solutionEdges for the
    // quad reason documented in potd.js: solutionEdges' restore only
    // swaps the live grid reference, leaving the worker's snapshot in
    // its un-scrambled (solved!) state.
    function placeGates(mazeSnap, roll) {
        const savedMaze       = (Maze.grid && Maze.ROWS > 0) ? Maze.snapshotState() : null;
        const savedQuadMode   = Maze.quadMode;
        const savedMosaicMode = Maze.mosaicMode;
        const savedPathCount  = Maze.pathCount;
        const savedGates     = (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null;

        let out = { maze: mazeSnap, gates: null, gatesPlaced: 0, minMoves: null, twins: null };
        try {
            Maze.setQuadMode(roll.quadMode);
            // Mosaic scrambles POSITIONS as well as rotations, so — exactly
            // like quad — solutionEdges has to un-scramble before it can
            // read the solved routes. That only happens when the flag is on,
            // and without it gates would be assigned against the player's
            // scrambled board and could land right on a solution edge.
            // minSolveMoves below needs it for the same reason.
            if (Maze.setMosaicMode) Maze.setMosaicMode(roll.mosaicMode);
            Maze.setPathCount(roll.pathCount);
            Maze.loadSnapshot(mazeSnap);
            out.maze = Maze.snapshotState();
            // Board is loaded here and nowhere else on this thread — the
            // only chance to measure what the worker actually built.
            out.twins = twinStats();
            if (typeof Gates !== 'undefined') {
                const stride   = roll.quadMode ? 2 : 1;
                const altEdges = Maze.alternateRouteEdges ? Maze.alternateRouteEdges() : null;
                Gates.assignGates(Maze.ROWS, Maze.COLS, Maze.solutionEdges(),
                                  roll.gateTarget, stride, altEdges);
                out.gates = Gates.snapshot();
                out.gatesPlaced = (Gates.list || []).length;
                if (Maze.recompute) Maze.recompute();
            }
            // Difficulty proxy: the minimum rotations a perfect solver
            // needs (tiles + twin groups priced as one, plus gates).
            // Worth logging next to the time — a slow build that yields
            // a trivially short solve is a bad trade.
            if (Maze.minSolveMoves) {
                try { out.minMoves = Maze.minSolveMoves(); } catch (e) { out.minMoves = null; }
            }
        } finally {
            Maze.setQuadMode(savedQuadMode);
            if (Maze.setMosaicMode) Maze.setMosaicMode(savedMosaicMode);
            Maze.setPathCount(savedPathCount);
            if (savedMaze) {
                Maze.loadSnapshot(savedMaze);
                if (typeof Gates !== 'undefined') {
                    if (savedGates) Gates.restore(savedGates);
                    else Gates.clear();
                }
                if (Maze.recompute) Maze.recompute();
            } else {
                Maze.clear();
                if (typeof Gates !== 'undefined') Gates.clear();
            }
        }
        return out;
    }

    // Main-thread fallback. Blocks the UI for the whole build, and the
    // coverage override MUST be reset afterwards — unlike the worker's
    // Maze, this one is the live game's.
    async function buildOnMain(roll) {
        Maze.setQuadMode(roll.quadMode);
        if (Maze.setMosaicMode) Maze.setMosaicMode(roll.mosaicMode);
        Maze.setPathCount(roll.pathCount);
        if (Maze.setTwinCoverageTarget) Maze.setTwinCoverageTarget(roll.twinCoverage);
        if (Maze.setTwinGroupSizeRange) {
            Maze.setTwinGroupSizeRange(roll.twinGroupMin, roll.twinGroupMax);
        }
        Maze.setDimensions(roll.rows, roll.cols);
        try {
            await Maze.init();
            return Maze.snapshotState();
        } finally {
            if (Maze.setTwinCoverageTarget) Maze.setTwinCoverageTarget(null);
            if (Maze.setTwinGroupSizeRange) Maze.setTwinGroupSizeRange(null, null);
        }
    }

    // Generate one v2 puzzle. Resolves to
    //   { maze, gates, roll, gatesPlaced, minMoves, mazeMs, gatesMs, totalMs }
    async function generate(params) {
        const roll = rollParams(params);
        const t0 = performance.now();
        const mazeSnap = ensureWorker()
            ? await requestWorkerMaze(roll)
            : await buildOnMain(roll);
        const t1 = performance.now();
        const placed = placeGates(mazeSnap, roll);
        const t2 = performance.now();
        return {
            maze: placed.maze, gates: placed.gates,
            roll,
            gatesPlaced: placed.gatesPlaced,
            minMoves: placed.minMoves,
            twins: placed.twins,
            mazeMs: t1 - t0, gatesMs: t2 - t1, totalMs: t2 - t0,
        };
    }

    // Is the viewport taller than it is wide? Portrait players get the
    // board rotated (see loadIntoPlay). Sampled per generation rather than
    // watched — a mid-solve re-orientation is the renderer's problem, not
    // the generator's.
    function isPortrait() {
        return window.innerHeight > window.innerWidth;
    }

    // Put a generated puzzle on screen and make it playable. Mirrors the
    // board-load tail of potd.js's startPuzzle, minus everything
    // session-shaped (no server token, no timer, no leaderboard, no
    // tracking) — this is a board to look at and solve, nothing more.
    //
    // Returns true if the board was rotated for a portrait viewport.
    function loadIntoPlay(res) {
        // Externally-loaded boards bypass Game.newPuzzle, which is what
        // normally clears the win banner — without this the previous
        // puzzle's "Path connected — tap for a new puzzle" stays painted
        // over the fresh board (reported 2026-08-01).
        if (typeof Game !== 'undefined' && Game.clearWinBanner) Game.clearWinBanner();

        Maze.setQuadMode(res.roll.quadMode);
        // Must be set BEFORE loadSnapshot, same as quadMode: the flag is
        // what makes every mosaic branch live, and the snapshot's layout is
        // only meaningful once it is on.
        if (Maze.setMosaicMode) Maze.setMosaicMode(res.roll.mosaicMode);
        Maze.setPathCount(res.roll.pathCount);
        Maze.loadSnapshot(JSON.parse(JSON.stringify(res.maze)));
        if (res.gates && typeof Gates !== 'undefined' && Gates.restore) {
            Gates.restore(res.gates);
            if (Maze.recompute) Maze.recompute();
        } else if (typeof Gates !== 'undefined') {
            Gates.clear();
        }
        Render.refit();
        Render.draw();

        // PORTRAIT PRESENTATION. Boards are generated landscape (rollParams
        // orders the axes), so a portrait screen would letterbox one badly.
        // Rotate it 90° instead — the stored snapshot stays canonical, and
        // a rotation is the SAME puzzle, so every player solves the same
        // board whatever their screen. Always clockwise, so all portrait
        // players see one agreed orientation rather than a coin flip.
        // Square boards are skipped: rotating one changes nothing about the
        // fit and would only make two players' screens disagree.
        // Game.applyBoardRotation is the single orchestrator for the
        // Maze+Gates pairing (see maze.js's rotateBoard comment) and does
        // its own recompute + refit.
        let rotated = false;
        if (Maze.ROWS !== Maze.COLS && isPortrait() &&
            typeof Game !== 'undefined' && Game.applyBoardRotation) {
            rotated = !!Game.applyBoardRotation(false);
        }

        // Same bypass-newPuzzle housekeeping PotD needs: re-seed the SFX
        // diff baselines so the first click doesn't fire stale applause,
        // and anchor a fresh recording on the board as PRESENTED (after any
        // rotation, so replays match what the player actually saw).
        if (typeof Game !== 'undefined') {
            if (Game.resetSfxBaselines) Game.resetSfxBaselines();
            if (Game.startRecording)    Game.startRecording();
        }
        return rotated;
    }

    // ── Debug panel ───────────────────────────────────────────────────

    // Two-knob range control: two overlaid range inputs whose thumbs are
    // the only pointer-interactive parts (see the .pg2Range rules in
    // styles.css). Returns a getter for the {lo, hi} pair.
    //
    // The z-index dance is what keeps both knobs reachable when they sit
    // on top of each other: whichever knob is in the upper half of the
    // track is raised, so there's always a knob on top that can be
    // dragged back toward the middle. Without it, a pair parked at the
    // maximum is stuck — the top input's thumb swallows every grab.
    function bindRangePair(loId, hiId, fillId, valId, fmt) {
        const lo   = document.getElementById(loId);
        const hi   = document.getElementById(hiId);
        const fill = document.getElementById(fillId);
        const val  = document.getElementById(valId);
        if (!lo || !hi) return function () { return { lo: 0, hi: 0 }; };
        const min = parseInt(lo.min, 10), max = parseInt(lo.max, 10);

        function paint() {
            const a = parseInt(lo.value, 10), b = parseInt(hi.value, 10);
            if (fill) {
                fill.style.left  = ((a - min) / (max - min) * 100) + '%';
                fill.style.width = ((b - a)   / (max - min) * 100) + '%';
            }
            if (val) val.textContent = fmt(a, b);
            const mid = (min + max) / 2;
            lo.style.zIndex = (a >= mid) ? '4' : '2';
            hi.style.zIndex = '3';
        }
        // Clamp rather than push: each knob stops at the other, so a
        // dragged knob never drags its partner along. lo === hi is legal
        // and means "this exact value every time".
        lo.addEventListener('input', function () {
            if (parseInt(lo.value, 10) > parseInt(hi.value, 10)) lo.value = hi.value;
            paint();
        });
        hi.addEventListener('input', function () {
            if (parseInt(hi.value, 10) < parseInt(lo.value, 10)) hi.value = lo.value;
            paint();
        });
        paint();
        return function () {
            return { lo: parseInt(lo.value, 10), hi: parseInt(hi.value, 10) };
        };
    }

    function median(nums) {
        if (!nums.length) return 0;
        const s = nums.slice().sort((a, b) => a - b);
        const m = s.length >> 1;
        return (s.length % 2) ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    function secs(ms) { return (ms / 1000).toFixed(2) + 's'; }

    // True while game.js's Marathon starter/lookahead pre-gen is building
    // in ITS worker — a competing build inflates our timing, so a run that
    // overlaps one gets flagged in the readout.
    function preGenBusy() {
        return !!(typeof Game !== 'undefined' && Game.isPreGenBusy && Game.isPreGenBusy());
    }

    function initDebugUI() {
        const btn     = document.getElementById('pg2GenBtn');
        const resultEl = document.getElementById('pg2Result');
        const logEl   = document.getElementById('pg2Log');
        if (!btn) return;

        const readSize = bindRangePair('pg2SizeMin', 'pg2SizeMax', 'pg2SizeFill', 'pg2SizeVal',
            (a, b) => (a === b) ? (a + ' sub-tiles') : (a + '–' + b + ' sub-tiles'));
        const readTwin = bindRangePair('pg2TwinMin', 'pg2TwinMax', 'pg2TwinFill', 'pg2TwinVal',
            (a, b) => (a === b) ? (a + '%') : (a + '–' + b + '%'));
        const readGroup = bindRangePair('pg2GroupMin', 'pg2GroupMax', 'pg2GroupFill', 'pg2GroupVal',
            (a, b) => (a === b) ? String(a) : (a + '–' + b));
        const readGate = bindRangePair('pg2GateMin', 'pg2GateMax', 'pg2GateFill', 'pg2GateVal',
            (a, b) => (a === b) ? String(a) : (a + '–' + b));

        const pathSlider = document.getElementById('pg2PathSlider');
        const pathVal    = document.getElementById('pg2PathVal');
        if (pathSlider && pathVal) {
            pathSlider.addEventListener('input', function () {
                pathVal.textContent = pathSlider.value;
            });
        }
        const readTiles = bindRangePair('pg2TilesMin', 'pg2TilesMax', 'pg2TilesFill', 'pg2TilesVal',
            (a, b) => (a === b) ? String(a) : (a + '–' + b));
        // Tile grouping — Singular / Quad / Mosaic radios (was a lone Quad
        // checkbox before mosaic made it a three-way choice). Read at
        // generate time rather than watched, like every other control here.
        function readTileMode() {
            const checked = document.querySelector('input[name="pg2Tiles"]:checked');
            return checked ? checked.value : 'singular';
        }

        // "14 pieces (4×3 5×2 8×4 16×5), 38 singular". Empty string outside
        // mosaic mode. `dissolved` counts pieces broken back into singular
        // cells because their interiors had no valid filling (see maze.js
        // solveGroupFillers) — worth surfacing because a dissolved piece is
        // indistinguishable from ordinary singular fill on the board. It is
        // only ever non-zero on a MAIN-THREAD build: the worker counts it in
        // its own Maze instance and the snapshot does not carry it, which is
        // why it is shown when present rather than always printing a 0 that
        // would be misleading on the usual (worker) path.
        function mosaicSummary() {
            if (!Maze.mosaicStats) return '';
            const s = Maze.mosaicStats();
            if (!s) return '';
            const spread = Object.keys(s.bySize)
                .map(Number).sort((a, b) => a - b)
                .map((size) => size + '×' + s.bySize[size]).join(' ');
            return '\n' + s.pieces + ' pieces (' + spread + '), ' +
                   s.singles + ' singular' +
                   (s.dissolved ? ' · ' + s.dissolved + ' dissolved' : '');
        }

        function readParams() {
            const size = readSize(), twin = readTwin(), gate = readGate(), tiles = readTiles();
            const group = readGroup();
            const tileMode = readTileMode();
            return {
                sizeMin: size.lo, sizeMax: size.hi,
                twinMin: twin.lo / 100, twinMax: twin.hi / 100,
                groupMin: group.lo, groupMax: group.hi,
                gateMin: gate.lo, gateMax: gate.hi,
                minTiles: tiles.lo, maxTiles: tiles.hi,
                pathCount: pathSlider ? parseInt(pathSlider.value, 10) : 1,
                quadMode:   tileMode === 'quad',
                mosaicMode: tileMode === 'mosaic',
            };
        }

        function renderLog() {
            if (!logEl) return;
            if (!history.length) { logEl.textContent = ''; return; }
            const med = median(history.map((h) => h.ms));
            const lines = history.map((h) => h.label + '  ' + secs(h.ms));
            logEl.textContent = 'median ' + secs(med) + ' of ' + history.length + '\n' + lines.join('\n');
        }

        async function generateAndPlay() {
            if (generating) return;
            generating = true;
            btn.disabled = true;
            // Drop the previous solve's win banner NOW, not when the build
            // lands — a big board can take ten seconds, and leaving "Path
            // connected — tap for a new puzzle" up that whole time reads as
            // the click having done nothing. loadIntoPlay clears it too, for
            // callers that don't come through this button.
            if (typeof Game !== 'undefined' && Game.clearWinBanner) Game.clearWinBanner();
            const competing = preGenBusy();
            const started = performance.now();
            // Live elapsed counter — a 14×14 singular build runs over a
            // minute, and a frozen "Generating…" reads as a hang.
            const tick = setInterval(function () {
                if (resultEl) {
                    resultEl.textContent = 'Generating… ' + secs(performance.now() - started);
                }
            }, 100);
            try {
                const res = await generate(readParams());
                const rotated = loadIntoPlay(res);
                const r = res.roll;
                // Canonical dims in SUB-TILES, W×H — always landscape or
                // square now, and the same unit the size slider uses. Quad
                // adds the player-facing tile count, since a 10×8 quad
                // board is only 5×4 tiles to solve.
                const label = r.cols + '×' + r.rows + ' ' + r.pathCount + 'p' +
                              (r.quadMode ? ' q(' + (r.cols / 2) + '×' + (r.rows / 2) + ')' : '') +
                              (r.mosaicMode ? ' mosaic' : '') +
                              // ⤓ shrunk to fit the ceiling, ⤒ grown to reach
                              // the floor — with the dims the roll wanted.
                              (r.resizedFrom
                                  ? (r.resizedFrom.rows * r.resizedFrom.cols > r.rows * r.cols ? ' ⤓' : ' ⤒') +
                                    r.resizedFrom.cols + '×' + r.resizedFrom.rows
                                  : '');
                if (resultEl) {
                    resultEl.textContent =
                        label + (rotated ? ' ↻portrait' : '') +
                        ' · ' + (r.rows * r.cols) + ' sub-tiles' +
                        // Requested coverage → achieved, then the groups
                        // that produced it. The two diverge whenever the
                        // 16-colour group cap binds; seeing both is the
                        // only way to tell a coverage setting that took
                        // from one that was quietly unreachable.
                        ' · twins ' + Math.round(r.twinCoverage * 100) + '%' +
                        (res.twins
                            ? '→' + Math.round(res.twins.coverage * 100) + '%' +
                              ' (' + res.twins.groups + ' grps ' +
                              (res.twins.min === res.twins.max
                                  ? res.twins.min
                                  : res.twins.min + '–' + res.twins.max) + ')'
                            : '') +
                        ' · gates ' + res.gatesPlaced + '/' + r.gateTarget +
                        (res.minMoves != null ? ' · ' + res.minMoves + ' moves' : '') +
                        // Mosaic layout: how many pieces the packer fitted,
                        // their size spread, and how many cells were left to
                        // singular fill. Read off the LOADED board, so it
                        // describes what is actually on screen. Worth
                        // showing because "the packer stopped early" and
                        // "the packer did well" look identical otherwise.
                        (mosaicSummary() || '') +
                        '\n' + secs(res.totalMs) + ' total (maze ' + secs(res.mazeMs) +
                        ', gates ' + Math.round(res.gatesMs) + 'ms)' +
                        ((competing || preGenBusy()) ? '\n⚠ pre-gen ran alongside — time inflated' : '');
                }
                history.unshift({ label: label, ms: res.totalMs });
                if (history.length > HISTORY_MAX) history.pop();
                renderLog();
            } catch (e) {
                if (resultEl) {
                    resultEl.textContent = 'Generation failed: ' + ((e && e.message) ? e.message : e);
                }
                if (typeof Logger !== 'undefined') Logger.warn('PotD v2 generate failed', e);
            } finally {
                clearInterval(tick);
                generating = false;
                btn.disabled = false;
            }
        }

        btn.addEventListener('click', generateAndPlay);
        // Exposed so the panel's F5 shortcut (index.html) can fire the
        // same action as the button.
        api.generateAndPlay = generateAndPlay;
    }

    const api = {
        generate,
        loadIntoPlay,
        rollParams,
        defaultParams,
        isPortrait,
        initDebugUI,
        // Bounds + defaults, so the markup and the module can't drift
        // apart silently — index.html carries the same numbers and
        // syncDefaults() below asserts them onto the inputs at boot.
        SIZE_FLOOR, SIZE_CEIL, SIZE_STEP, TWIN_FLOOR, TWIN_CEIL, GATE_FLOOR, GATE_CEIL,
        TILES_FLOOR, TILES_CEIL, TILES_STEP, GROUP_FLOOR, GROUP_CEIL,
        DEF_SIZE_MIN, DEF_SIZE_MAX, DEF_TWIN_MIN, DEF_TWIN_MAX, DEF_GATE_MIN, DEF_GATE_MAX,
        DEF_TILES_MIN, DEF_TILES_MAX, DEF_GROUP_MIN, DEF_GROUP_MAX,
        get history() { return history.slice(); },
    };
    return api;
})();

// Self-init: the debug panel markup sits above the script loader in
// index.html, so the elements already exist by the time this runs. In
// game mode the panel is display:none and the handlers simply never
// fire — and dev-mode.js's Ctrl+D can reveal it mid-session, which
// works because the wiring happened here regardless of mode.
PotdGen2.initDebugUI();
