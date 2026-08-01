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
    // Size is LOGICAL tiles. 15 is the ceiling because generation cost
    // climbs steeply — a 14×14 singular build already medians ~68s (see
    // tests/bench-median.js), and the point of the timing readout is to
    // find where that becomes unacceptable for a daily puzzle.
    const SIZE_FLOOR = 4,   SIZE_CEIL = 15;
    const TWIN_FLOOR = 10,  TWIN_CEIL = 80;   // percent
    const GATE_FLOOR = 0,   GATE_CEIL = 20;
    // Opening positions — the live PotD's current behavior, so the first
    // generation from a fresh panel is the baseline to compare against:
    // singular 3-4 path sizes, 30% coverage, 3 gates.
    const DEF_SIZE_MIN = 6, DEF_SIZE_MAX = 9;
    const DEF_TWIN_MIN = 30, DEF_TWIN_MAX = 30;
    const DEF_GATE_MIN = 3,  DEF_GATE_MAX = 3;

    const HISTORY_MAX = 10;   // generations kept in the panel's log

    let history = [];         // [{ label, ms }, …] newest first
    let generating = false;

    function randInt(lo, hi) {
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    }

    // Roll one puzzle's parameters from the panel's ranges.
    //   p = { sizeMin, sizeMax, twinMin, twinMax, gateMin, gateMax,
    //         pathCount, quadMode }   (twin* as 0..1 fractions)
    // Returns PHYSICAL sub-tile dims, which is what Maze.setDimensions
    // and the worker both consume.
    function rollParams(p) {
        // Quad boards need even physical dims (each visible tile is a 2×2
        // sub-tile group), so the roll happens in logical tiles and is
        // doubled — which also makes the size range mean the same thing
        // to the player in both modes.
        const mul = p.quadMode ? 2 : 1;
        // Both axes roll from the same range, then the pair is ORDERED so
        // the board is always wider than tall (or square) — never taller
        // than wide. Screens are landscape far more often than not, and a
        // tall board wastes the width it does have. Portrait players get
        // the same board rotated 90° at load (see loadIntoPlay), so this
        // costs them nothing: one canonical puzzle, two presentations.
        const a = randInt(p.sizeMin, p.sizeMax);
        const b = randInt(p.sizeMin, p.sizeMax);
        return {
            rows:         Math.min(a, b) * mul,
            cols:         Math.max(a, b) * mul,
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

    // True while game.js's Marathon starter/lookahead pre-gen is
    // building in ITS worker — a competing build inflates our timing.
    // Read off the panel's own status line rather than reaching into
    // game.js's closure state, which isn't exposed.
    function preGenBusy() {
        const el = document.getElementById('preGenStatus');
        return !!(el && el.textContent && el.textContent.indexOf('building') !== -1);
    }

    function initDebugUI() {
        const btn     = document.getElementById('pg2GenBtn');
        const resultEl = document.getElementById('pg2Result');
        const logEl   = document.getElementById('pg2Log');
        if (!btn) return;

        const readSize = bindRangePair('pg2SizeMin', 'pg2SizeMax', 'pg2SizeFill', 'pg2SizeVal',
            (a, b) => (a === b) ? (a + ' tiles') : (a + '–' + b + ' tiles'));
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
        const quadCheck = document.getElementById('pg2QuadCheck');

        function readParams() {
            const size = readSize(), twin = readTwin(), gate = readGate();
            return {
                sizeMin: size.lo, sizeMax: size.hi,
                twinMin: twin.lo / 100, twinMax: twin.hi / 100,
                gateMin: gate.lo, gateMax: gate.hi,
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
                const logical = r.quadMode ? 2 : 1;
                // Canonical dims, W×H — always landscape or square now.
                const label = (r.cols / logical) + '×' + (r.rows / logical) +
                              (r.quadMode ? 'q' : '') + ' ' + r.pathCount + 'p';
                if (resultEl) {
                    resultEl.textContent =
                        label + (rotated ? ' ↻portrait' : '') +
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
        SIZE_FLOOR, SIZE_CEIL, TWIN_FLOOR, TWIN_CEIL, GATE_FLOOR, GATE_CEIL,
        DEF_SIZE_MIN, DEF_SIZE_MAX, DEF_TWIN_MIN, DEF_TWIN_MAX, DEF_GATE_MIN, DEF_GATE_MAX,
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
