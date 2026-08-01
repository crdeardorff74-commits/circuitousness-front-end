/**
 * potd-gen2.js — EXPERIMENTAL Puzzle-of-the-Day generator (v2).
 *
 * Runs ONLY from the debug panel (?debug=true). It does not touch the
 * live PotD pipeline in potd.js: nothing here seeds the server, nothing
 * here reads or writes PotD localStorage state, and no shipping code
 * path calls into this module. It exists so the ranges can be tuned by
 * hand before v2 is swapped in for potd.js's generateDims().
 *
 * WHY v2: the live generator's only random axis is board size, rolled
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
 * Path count and quad mode stay panel-selected rather than rolled:
 * in the live PotD they're fixed by the slot (s1-s4 / q1-q4), so the
 * tuner picks the slot shape and explores the three rolled axes within
 * it.
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
    // Area window for rows × cols in SUB-TILES — the same unit the size
    // slider uses, and the unit cost scales with (the maze is built at
    // sub-tile resolution in both modes, so a quad board is no cheaper per
    // sub-tile than a singular one). Stepped by 10 because a 12rem track
    // can't meaningfully resolve 200 discrete positions.
    const TILES_FLOOR = 20, TILES_CEIL = 300, TILES_STEP = 10;
    // Opening positions — roughly the live PotD's current behavior, so the
    // first generation from a fresh panel is a baseline to compare against:
    // mid-size board, 30% coverage, 3 gates.
    const DEF_SIZE_MIN = 6, DEF_SIZE_MAX = 10;
    // Opens at the full span, which is now effectively inert at both ends:
    // the floor of 20 sub-tiles only reaches the very smallest board the
    // size slider can roll (4×4 = 16, nudged to 4×5), and the ceiling of
    // 300 only the very largest. That's the point of the 20 — at the
    // original 100 floor (a 10×10 board) the minimum knob grew the great
    // majority of rolls even at its lowest setting, which quietly made the
    // size range's lower half meaningless. The size range sets the SHAPE
    // that gets rolled; this window then has the final say on area, so it
    // wants a genuine off position.
    const DEF_TILES_MIN = 20, DEF_TILES_MAX = 300;
    const DEF_TWIN_MIN = 30, DEF_TWIN_MAX = 30;
    const DEF_GATE_MIN = 3,  DEF_GATE_MAX = 3;

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
            gateTarget:   randInt(p.gateMin, p.gateMax),
            pathCount:    p.pathCount,
            quadMode:     p.quadMode,
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
                twinCoverage: roll.twinCoverage,   // absolute override
            });
        });
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
        const savedMaze      = (Maze.grid && Maze.ROWS > 0) ? Maze.snapshotState() : null;
        const savedQuadMode  = Maze.quadMode;
        const savedPathCount = Maze.pathCount;
        const savedGates     = (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null;

        let out = { maze: mazeSnap, gates: null, gatesPlaced: 0, minMoves: null };
        try {
            Maze.setQuadMode(roll.quadMode);
            Maze.setPathCount(roll.pathCount);
            Maze.loadSnapshot(mazeSnap);
            out.maze = Maze.snapshotState();
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
        Maze.setPathCount(roll.pathCount);
        if (Maze.setTwinCoverageTarget) Maze.setTwinCoverageTarget(roll.twinCoverage);
        Maze.setDimensions(roll.rows, roll.cols);
        try {
            await Maze.init();
            return Maze.snapshotState();
        } finally {
            if (Maze.setTwinCoverageTarget) Maze.setTwinCoverageTarget(null);
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
        const quadCheck = document.getElementById('pg2QuadCheck');

        function readParams() {
            const size = readSize(), twin = readTwin(), gate = readGate(), tiles = readTiles();
            return {
                sizeMin: size.lo, sizeMax: size.hi,
                twinMin: twin.lo / 100, twinMax: twin.hi / 100,
                gateMin: gate.lo, gateMax: gate.hi,
                minTiles: tiles.lo, maxTiles: tiles.hi,
                pathCount: pathSlider ? parseInt(pathSlider.value, 10) : 1,
                quadMode: !!(quadCheck && quadCheck.checked),
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
                        ' · twins ' + Math.round(r.twinCoverage * 100) + '%' +
                        ' · gates ' + res.gatesPlaced + '/' + r.gateTarget +
                        (res.minMoves != null ? ' · ' + res.minMoves + ' moves' : '') +
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
        initDebugUI,
        // Bounds + defaults, so the markup and the module can't drift
        // apart silently — index.html carries the same numbers and
        // syncDefaults() below asserts them onto the inputs at boot.
        SIZE_FLOOR, SIZE_CEIL, SIZE_STEP, TWIN_FLOOR, TWIN_CEIL, GATE_FLOOR, GATE_CEIL,
        TILES_FLOOR, TILES_CEIL, TILES_STEP,
        DEF_SIZE_MIN, DEF_SIZE_MAX, DEF_TWIN_MIN, DEF_TWIN_MAX, DEF_GATE_MIN, DEF_GATE_MAX,
        DEF_TILES_MIN, DEF_TILES_MAX,
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
