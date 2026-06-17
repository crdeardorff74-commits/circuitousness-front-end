/**
 * Circuitousness - Main entry point
 *
 * Bootstraps i18n, builds the maze, wires up the canvas, and dispatches
 * click/tap events to rotate tiles. Re-renders after every rotation and
 * surfaces a win banner when the highlighted path reaches the exit.
 *
 * Pre-generation: a Web Worker (maze-worker.js) builds the NEXT puzzle on
 * a background thread while the player solves the current one. When the
 * player finishes (or asks for a new puzzle), we hand them the pre-built
 * snapshot instantly instead of waiting on a fresh init.
 */
(function() {
    I18n.init();
    document.title = PROJECT_NAME;
    I18n.applyTranslations();

    GamepadController.init();
    initTouchControls();

    Logger.info(PROJECT_NAME + ' v' + PAGE_VERSION + ' ready');

    // Fire the one-time page-load tracking POST. Defers ~500ms so the
    // request doesn't race the rest of page init for network bandwidth
    // and the cold-start render. Tracking module owns its own
    // suppression (DevMode.isActive bypasses entirely).
    setTimeout(function () {
        if (typeof Tracking !== 'undefined' && Tracking.recordVisit) Tracking.recordVisit();
    }, 500);

    function start() {
        const canvas          = document.getElementById('maze');
        const banner          = document.getElementById('winBanner');
        const buildingBanner  = document.getElementById('buildingBanner');
        if (!canvas) {
            Logger.error(PROJECT_NAME + ': #maze canvas not found');
            return;
        }

        // ?debug=true bypasses Marathon — sliders + manual puzzle progression.
        // Without it, Marathon owns the lifecycle (menu → game → leaderboard).
        const isDebugMode = document.documentElement.classList.contains('mode-debug');

        // Render canvas first so the building banner has something to overlay.
        // Maze.grid is null at this point; Render.draw() handles that gracefully.
        Render.init(canvas);

        let lastWon    = false; // start false so the banner appears even if init() randomly produces a winning rotation
        let isBuilding = false;
        // Monotonic counter — each newPuzzle() invocation captures its
        // own seq and checks against this after every await. If a
        // newer call has incremented it, the older call is "superseded"
        // and bails out before applying any side effects. Replaces the
        // old `if (isBuilding) return;` gate (which silently DROPPED
        // overlapping clicks instead of letting the newer one take
        // over). Without this: the player abandons a slow build (e.g.
        // q4 = 16×16 quad, several seconds), starts a different cached
        // puzzle, then several seconds later the abandoned worker
        // finishes and stomps the active game by loadSnapshot'ing the
        // old puzzle's data on top.
        let newPuzzleSeq = 0;
        // SFX state: refresh() detects per-path completion + overlap-loop
        // transitions by diffing against these. newPuzzle resets both so a
        // fresh puzzle doesn't replay applause for paths that are already
        // connected in the loaded snapshot.
        let lastPathsWon = [false, false, false, false];
        let lastJoined   = false;

        // Progression rule: after a win, the player advances to the next
        // larger size. Sequence alternates which dimension grows so the
        // grid stays close to square: 4×4 → 5×4 → 5×5 → 6×5 → 6×6 → ...
        // Generic rule: smaller dim grows; if equal, rows grow first.
        function nextSize(rows, cols) {
            // In quad mode dims must stay even (whole number of 2×2 quads),
            // so step by 2; otherwise step by 1.
            const step = quadMode ? 2 : 1;
            if (rows > cols) return { rows: rows, cols: cols + step };
            return                  { rows: rows + step, cols: cols };
        }

        // Mirror Maze's current dims back into the debug-panel sliders so
        // the slider position stays in sync with auto-progressed sizes.
        // Programmatic .value assignment doesn't fire input events, so this
        // doesn't recurse into rebuildGrid.
        function syncDebugSliders() {
            const wS = document.getElementById('gridWSlider');
            const wV = document.getElementById('gridWVal');
            const hS = document.getElementById('gridHSlider');
            const hV = document.getElementById('gridHVal');
            // Sliders show LOGICAL dims (quad count when in quad mode).
            const div = quadMode ? 2 : 1;
            const logicalC = Maze.COLS / div;
            const logicalR = Maze.ROWS / div;
            if (wS) wS.value = String(logicalC);
            if (wV) wV.textContent = String(logicalC);
            if (hS) hS.value = String(logicalR);
            if (hV) hV.textContent = String(logicalR);
        }

        // Pre-generation worker. When available, the worker is the sole
        // maze builder — it has its own private Maze instance and builds
        // in parallel while the player solves the current puzzle. When NOT
        // available (e.g. file:// origin), main falls back to Maze.init().
        //
        // Lookahead cache: the worker pre-builds the next PREGEN_LOOKAHEAD
        // sizes in the progression and caches them keyed by "rows,cols".
        // Player advances → consume the matching entry, then queue more
        // builds so the cache stays full. With 3+ buffered, even a fast
        // hint-solver doesn't catch up to the worker on big grids.
        const PREGEN_LOOKAHEAD = 3;
        const preGenCache = new Map();              // "r,c,paths,Q|q" → snapshot
        let worker          = null;
        let workerAvailable = true;                  // flips to false on Worker construction/runtime error
        let preGenSize      = null;                  // {rows, cols, pathCount, quadMode} of the in-flight worker request
        let preGenStartTime = 0;
        let pathCount       = 1;                     // 1, 2, or 3
        let quadMode        = false;                 // 2×2 sub-tile groups rotate as one unit
        // Cache key includes pathCount AND quadMode so cross-mode collisions
        // can't return a stale wrong-mode snapshot. Optional params let
        // starter pre-gen use cache keys that differ from the active
        // globals (e.g. cache an s2 starter while quadMode is currently false).
        function cacheKey(r, c, paths, quad) {
            const p = (paths != null) ? paths : pathCount;
            const q = (quad  != null) ? quad  : quadMode;
            return r + ',' + c + ',' + p + ',' + (q ? 'Q' : 'q');
        }

        // ----- Starter pre-gen -----
        // Marathon has 8 starting puzzle types (s1..s4, q1..q4). At page load
        // we kick off background generation for all 8 at their level-1 dims so
        // that picking ANY mode is instant — no "Building puzzle…" wait on
        // first launch. Runs even in PotD mode since the player may switch
        // to Marathon. Cache survives across games + invalidatePreGen calls
        // (those only wipe lookahead entries built for the previous config).
        //
        // STARTER_PLAN derives from MARATHON.TYPES + MIN_DIM_* constants in
        // config.js so changes to those propagate automatically. Each entry
        // captures everything the worker needs (physical dims + pathCount +
        // quadMode) and the cache key the result will land under.
        const STARTER_PLAN = (function () {
            const out = [];
            if (typeof MARATHON !== 'object' || !MARATHON.TYPES) return out;
            for (const type of MARATHON.TYPES) {
                const quad   = type[0] === 'q';
                const paths  = parseInt(type[1], 10) || 1;
                // Path-count-aware min dim: 4-path needs more grid than the
                // 1/2/3-path baseline (see MARATHON.minDimFor in config.js).
                // Without this, starter pre-gen for s4/q4 would use the baseline
                // 8/6 dims that the strict-mode generator in maze.js will reject
                // for not fitting 4 paths — forcing a long retry loop right when
                // the player is most likely to be waiting.
                const minDim = MARATHON.minDimFor(quad, paths);
                // dimsForLevel(1, quad, paths) returns logical {rows:minDim, cols:minDim};
                // upcomingDims/startPuzzle convert ×2 for quad → PHYSICAL dims.
                const rows = quad ? minDim * 2 : minDim;
                const cols = rows;
                out.push({
                    type:      type,
                    rows:      rows,
                    cols:      cols,
                    pathCount: paths,
                    quadMode:  quad,
                    cacheKey:  cacheKey(rows, cols, paths, quad)
                });
            }
            return out;
        })();
        const STARTER_KEY_SET = new Set(STARTER_PLAN.map((p) => p.cacheKey));
        function ensureWorker() {
            if (worker || !workerAvailable) return worker;
            try {
                worker = new Worker('maze-worker.js?t=' + Date.now());
                worker.onmessage = function (e) {
                    if (!e.data || e.data.type !== 'ready') return;
                    const s = e.data.state;
                    const respCount = e.data.pathCount | 0 || 1;
                    const respQuad  = !!e.data.quadMode;
                    // Accept only if dims, path-count, AND quad-mode match the
                    // latest in-flight request. Stale responses (mode changed
                    // mid-build) are discarded so the wrong-mode snapshot
                    // doesn't poison the cache.
                    if (preGenSize
                        && s.rows === preGenSize.rows
                        && s.cols === preGenSize.cols
                        && respCount === preGenSize.pathCount
                        && respQuad === preGenSize.quadMode) {
                        const key = cacheKey(s.rows, s.cols, respCount, respQuad);
                        preGenCache.set(key, s);
                        const elapsed = ((Date.now() - preGenStartTime) / 1000).toFixed(2);
                        Logger.info('✅ worker built ' +
                            describeBuild(s.rows, s.cols, respCount, respQuad, preGenSize.purpose || 'pre-gen') +
                            ' in ' + elapsed + 's');
                        preGenSize = null;
                        // Lookahead has priority — if it queues something the
                        // starter loop's preGenSize check defers automatically.
                        fillPreGenQueue();
                        ensureStartersBuilt();
                    }
                };
                worker.onerror = function (e) {
                    Logger.warn('Maze worker error; falling back to main-thread generation.', e && e.message);
                    workerAvailable = false;
                    worker = null;
                };
            } catch (err) {
                Logger.warn('Maze worker unavailable (likely file:// origin); using main-thread generation.', err && err.message);
                workerAvailable = false;
                worker = null;
            }
            return worker;
        }
        // Pretty-print a build for the pre-gen console log. `purpose`
        // describes WHY this build was queued — "starter s4", "lookahead
        // L+2", or "player request" — so the log trace tells the story of
        // what the worker is doing at any given moment.
        function describeBuild(rows, cols, paths, quad, purpose) {
            const type = (quad ? 'q' : 's') + paths;
            return purpose + ' ' + type + ' (' + rows + 'x' + cols + ', ' +
                   paths + '-path ' + (quad ? 'quad' : 'singular') + ')';
        }
        // Optional `opts`:
        //   urgent:    true → worker aborts any in-flight build and races
        //                     to start this one. Used when the player is
        //                     waiting on a build (newPuzzle cache miss).
        //   pathCount: override the current global pathCount (used by
        //              starter pre-gen, which queues all 8 starting types
        //              before any game has set a global config).
        //   quadMode:  same as pathCount but for the quad/singular toggle.
        //   purpose:   short string describing why this build was queued,
        //              used in the console log ('starter s2',
        //              'lookahead L+1', 'player request'). Falls back to
        //              'pre-gen' so unlabeled callers still get a line.
        function requestBuild(rows, cols, opts) {
            const w = ensureWorker();
            if (!w) return false;
            const usePaths   = (opts && opts.pathCount != null) ? opts.pathCount : pathCount;
            const useQuad    = (opts && opts.quadMode  != null) ? !!opts.quadMode : quadMode;
            const isUrgent   = !!(opts && opts.urgent);
            const purpose    = (opts && opts.purpose) || 'pre-gen';
            preGenSize = {
                rows: rows, cols: cols, pathCount: usePaths, quadMode: useQuad,
                purpose: purpose
            };
            preGenStartTime = Date.now();
            const desc = describeBuild(rows, cols, usePaths, useQuad, purpose);
            Logger.info('🧩 worker ' + (isUrgent ? 'preempt → ' : 'building ') + desc);
            w.postMessage({
                type: 'generate', rows: rows, cols: cols,
                pathCount: usePaths, quadMode: useQuad,
                urgent: isUrgent
            });
            return true;
        }
        // Walk PREGEN_LOOKAHEAD progression steps ahead and queue the first
        // size that's neither cached nor currently being built. Worker can
        // only do one at a time, so this is called both after each puzzle
        // is shown AND after each worker response — chains the queue.
        //
        // CRITICAL: when Marathon owns the lifecycle, ITS progression
        // (a 4-step row/col growth cycle in marathon.js dimsForLevel) is
        // the source of truth — NOT this file's `nextSize`, which uses a
        // different "grow smaller dim" rule. The two diverge at puzzle 2
        // (e.g. 8x8 → 9x8 here vs 8x9 in Marathon), so pre-gen would
        // build sizes Marathon never asks for and every advance would
        // cache-miss → "Building puzzle…" between every level.
        function fillPreGenQueue() {
            if (!ensureWorker()) return;
            if (preGenSize) return;
            let upcoming;
            if (typeof Marathon !== 'undefined' && Marathon.upcomingDims && Marathon.isPlaying && Marathon.isPlaying()) {
                upcoming = Marathon.upcomingDims(PREGEN_LOOKAHEAD);
            } else if (isDebugMode) {
                // Debug mode owns its own progression via game.js's nextSize.
                // No Marathon to ask, so walk the local progression instead.
                upcoming = [];
                let r = Maze.ROWS, c = Maze.COLS;
                for (let i = 0; i < PREGEN_LOOKAHEAD; i++) {
                    const next = nextSize(r, c);
                    r = next.rows; c = next.cols;
                    upcoming.push({ rows: r, cols: c });
                }
            } else {
                // Game mode at menu (no active Marathon) — the next puzzle
                // depends entirely on which mode the player picks. Don't
                // burn worker cycles on stale lookahead dims left over from
                // the previous game; ensureStartersBuilt handles this idle
                // window instead.
                return;
            }
            for (let i = 0; i < upcoming.length; i++) {
                const dims = upcoming[i];
                if (!preGenCache.has(cacheKey(dims.rows, dims.cols))) {
                    requestBuild(dims.rows, dims.cols, {
                        purpose: 'lookahead L+' + (i + 1)
                    });
                    return;
                }
            }
        }
        // Wipes the lookahead cache (built for the OLD pathCount/quadMode
        // config — those entries are now wrong-mode and would poison the
        // next game). Preserves starter entries — those are per-type
        // pre-built at level-1 dims and remain valid regardless of which
        // type the player just left.
        function invalidatePreGen() {
            for (const k of Array.from(preGenCache.keys())) {
                if (!STARTER_KEY_SET.has(k)) preGenCache.delete(k);
            }
        }

        // Background pre-gen for the 8 Marathon starting puzzles. Called
        // at page load AND chained after every worker response, so any
        // gap in the starter cache (player consumed one, then quit before
        // refill finished) closes on its own as soon as the worker is idle.
        //
        // Defers to fillPreGenQueue during active play — the player
        // needs the NEXT puzzle in their current game more urgently than a
        // future starter for a different mode. Once lookahead is full,
        // starter pre-gen resumes filling its gaps.
        function ensureStartersBuilt() {
            if (!ensureWorker()) return;
            if (preGenSize) return;   // worker busy with something else
            for (const plan of STARTER_PLAN) {
                if (!preGenCache.has(plan.cacheKey)) {
                    requestBuild(plan.rows, plan.cols, {
                        pathCount: plan.pathCount,
                        quadMode:  plan.quadMode,
                        // describeBuild appends the type itself, so just
                        // tag the role here — output reads "starter s4 (...)"
                        purpose:   'starter'
                    });
                    return;
                }
            }
            // All 8 starters cached — nothing to do until one gets consumed.
        }
        // mySeq is optional. When passed, the poll self-cancels if a
        // newer newPuzzle has incremented newPuzzleSeq — without this,
        // a build that's preempted in the worker (its cache key never
        // gets populated because the worker is now building something
        // else) would leave waitForPreGen polling every 50ms forever,
        // leaking the promise and its setTimeout chain. Caller checks
        // supersession again after this resolves before applying any
        // side effects.
        function waitForPreGen(rows, cols, mySeq) {
            return new Promise(function (resolve) {
                const k = cacheKey(rows, cols);
                const check = function () {
                    if (mySeq !== undefined && mySeq !== newPuzzleSeq) {
                        resolve();
                        return;
                    }
                    if (preGenCache.has(k)) resolve();
                    else setTimeout(check, 50);
                };
                check();
            });
        }

        // Move recorder. Eventually feeds the leaderboard so a player's solve
        // can be replayed/audited. Each puzzle starts a fresh recording with
        // a deep-cloned snapshot of the initial scrambled state. Live moves
        // (rotate, lock, hint) are appended with millisecond offsets from
        // the recording's start.
        let recording = null;
        function deepCloneSnapshot(s) {
            return {
                rows:   s.rows,
                cols:   s.cols,
                grid:   s.grid.map((row) => row.map((t) => Object.assign({}, t))),
                entry:  Object.assign({}, s.entry),
                exit:   Object.assign({}, s.exit),
                entry2: s.entry2 ? Object.assign({}, s.entry2) : null,
                exit2:  s.exit2  ? Object.assign({}, s.exit2)  : null,
                entry3: s.entry3 ? Object.assign({}, s.entry3) : null,
                exit3:  s.exit3  ? Object.assign({}, s.exit3)  : null,
                entry4: s.entry4 ? Object.assign({}, s.entry4) : null,
                exit4:  s.exit4  ? Object.assign({}, s.exit4)  : null,
                quadScramble: s.quadScramble ? s.quadScramble.map((row) => row.slice()) : null
            };
        }
        // ── Undo ──────────────────────────────────────────────────────────
        // Snapshot-based, unlimited (capped — see MAX_UNDO_DEPTH). Every
        // committed move funnels through recordMove(); we bank the PRE-move
        // full state there so undo() can step straight back to it via the
        // same Maze.loadSnapshot / Gates.restore pipeline replay uses. A
        // single user action records at most one move, so one undo = one
        // reverted action. undoStack holds states OLDEST→NEWEST; undoBaseState
        // tracks "current committed state" so the next recordMove knows what
        // to bank.
        //
        // Memory: a snapshot is a full grid clone (~64 small tile objects at
        // 8×8, ~144 at 12×12 quad). The cap bounds worst-case use to a few MB
        // even on a marathon-length puzzle, and the stack resets every puzzle
        // (startRecording), so it never accumulates across a run. 200 is far
        // beyond any realistic single-puzzle move count — effectively
        // unlimited for normal play, with a hard ceiling as a safety valve.
        const MAX_UNDO_DEPTH = 200;
        const undoBtnIds = ['undoBtn', 'hudUndoBtn'];
        let undoStack = [];          // pre-move full-state snapshots, oldest→newest
        let undoBaseState = null;    // snapshot of the current committed state

        function captureUndoSnap() {
            return {
                maze:  Maze.snapshotState(),
                gates: (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null
            };
        }
        // Maze.loadSnapshot takes OWNERSHIP of the grid it's handed (grid = s.grid),
        // so a banked snapshot must be cloned before restore or a later move would
        // mutate it in place. Mirrors deepCloneSnapshot but also carries `locked`
        // and `quadScramble` (both part of player-visible state).
        function cloneMazeSnap(s) {
            return {
                rows: s.rows, cols: s.cols,
                grid: s.grid.map((row) => row.map((t) => Object.assign({}, t))),
                entry:  Object.assign({}, s.entry),
                exit:   Object.assign({}, s.exit),
                entry2: s.entry2 ? Object.assign({}, s.entry2) : null,
                exit2:  s.exit2  ? Object.assign({}, s.exit2)  : null,
                entry3: s.entry3 ? Object.assign({}, s.entry3) : null,
                exit3:  s.exit3  ? Object.assign({}, s.exit3)  : null,
                entry4: s.entry4 ? Object.assign({}, s.entry4) : null,
                exit4:  s.exit4  ? Object.assign({}, s.exit4)  : null,
                quadScramble: s.quadScramble ? s.quadScramble.map((row) => row.slice()) : null,
                locked: Array.isArray(s.locked) ? s.locked.slice() : []
            };
        }
        // Reset the undo history to the puzzle's starting state. Called from
        // startRecording so both the Marathon (newPuzzle) and PotD paths get a
        // clean stack anchored on the freshly-loaded board.
        function resetUndo() {
            undoStack = [];
            undoBaseState = captureUndoSnap();
            updateUndoButtons();
        }
        function updateUndoButtons() {
            const enabled = undoStack.length > 0;
            undoBtnIds.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.disabled = !enabled;
            });
        }
        function undo() {
            if (isBuilding || isReplaying) return;
            // Same transition guards as handlePointer/handleHintClick: don't
            // rewind a puzzle the player has already solved and is leaving.
            if (typeof Marathon !== 'undefined' && Marathon.isInTransition && Marathon.isInTransition()) return;
            if (typeof Potd !== 'undefined' && Potd.isInSolveTransition && Potd.isInSolveTransition()) return;
            if (undoStack.length === 0) return;

            const prev = undoStack.pop();
            // Clone before restore (loadSnapshot takes ownership of the grid).
            Maze.loadSnapshot(cloneMazeSnap(prev.maze));
            if (typeof Gates !== 'undefined') {
                if (prev.gates && Gates.restore) Gates.restore(prev.gates);
                else if (Gates.clear) Gates.clear();
                if (Maze.recompute) Maze.recompute();
            }
            undoBaseState = prev;
            // Record the undo as its own replayable move so playback reflects
            // what actually happened — the move, then the player taking it back.
            // applyReplayUndo (in playOneRecording) mirrors this pop against a
            // replay-side state stack. We append rather than going through
            // recordMove so the undo itself doesn't get banked onto undoStack
            // (an undo steps back through history; it isn't itself undoable).
            appendMove({ type: 'undo' });

            if (banner) banner.classList.remove('visible');
            if (Render.clearFadingLanes) Render.clearFadingLanes();
            Render.draw();
            // Re-seed SFX baselines to the restored state and kill any live
            // loop. We deliberately skip refresh() here — its SFX/win state
            // machine would otherwise fire spurious applause/awww on the state
            // jump (or, in debug, re-run win handling). The next real move
            // diffs cleanly against these baselines.
            resetSfxBaselines();
            if (typeof Sfx !== 'undefined' && Sfx.click) Sfx.click();
            updateUndoButtons();
        }

        // True when `id` is a menu-only-pool song. A game recording must
        // never anchor on (or capture) menu music: on replay it would show a
        // bogus menu title and fall silent when that one song ends, since
        // scripted playback suppresses auto-advance. Delegates to Music's
        // pool membership (exposed as Music.isMenuSong); defaults to false
        // when Music is unavailable so we record the song rather than drop it.
        function isMenuMusic(id) {
            return !!(id && typeof Music !== 'undefined'
                      && Music.isMenuSong && Music.isMenuSong(id));
        }
        function startRecording() {
            recording = {
                startTime: 0,                      // set lazily on first move
                quadMode: !!Maze.quadMode,
                pathCount: Maze.pathCount,
                initialState: deepCloneSnapshot(Maze.snapshotState()),
                // Gate state at puzzle start. Without this the replay
                // inherits whatever gates the live game has placed for
                // its current puzzle — a sticking-out-of-grid mismatch
                // when the live puzzle is larger than the replayed one.
                gates: (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null,
                moves: [],
                // Music events: songs that played during this puzzle.
                // [{ t: ms, songId: string }, ...] where t is ms since
                // the first move (same anchor as moves' timestamps).
                // The first entry (t=0) is the song that was playing
                // when the first move happened — captured below from
                // the live Music module. Pre-first-move song changes
                // overwrite this entry rather than appending, so the
                // recording's "starting song" is whatever was actually
                // playing the instant the player started moving.
                // Music.addSongChangeListener (wired in start()) fires
                // the append/overwrite logic.
                musicEvents: []
            };
            // Seed the initial song with whatever's playing right now.
            // The listener below will replace this entry if the song
            // changes BEFORE the first move (pre-move idle), or
            // append new entries AFTER the first move.
            const cur = (typeof Music !== 'undefined' && Music.getCurrentSong)
                        ? Music.getCurrentSong()
                        : null;
            // Skip a menu-pool song: a game recording must never anchor on
            // menu music (see recordSongChange).
            if (cur && cur.id && !isMenuMusic(cur.id)) {
                recording.musicEvents.push({ t: 0, songId: cur.id });
            }
            // Fresh puzzle → fresh undo history anchored on the loaded board.
            resetUndo();
        }
        // Raw append to the active recording — sets the move's timestamp and
        // pushes it, with NO undo bookkeeping. Used both by recordMove (real
        // moves) and undo() (which records an `undo` move so playback replays
        // the undo itself rather than pretending it never happened). Returns
        // false when there's no recording / we're replaying.
        function appendMove(move) {
            if (!recording || isReplaying) return false;
            // Anchor timestamps to the player's FIRST move, not the puzzle's
            // build time. Otherwise pre-play idle time (worker generation,
            // user reading the puzzle) inflates t-offsets and replay waits
            // the same dead time before applying the first move. Also matches
            // the leaderboard semantics — solve time starts at first action.
            if (recording.moves.length === 0) recording.startTime = Date.now();
            move.t = Date.now() - recording.startTime;
            recording.moves.push(move);
            return true;
        }
        function recordMove(move) {
            if (!appendMove(move)) return;
            // Undo: bank the state as it was BEFORE this move (undoBaseState),
            // then advance the base to the new current state. recordMove fires
            // exactly once per committed action and never during replay (the
            // early-return above), so the stack stays in lockstep with moves.
            undoStack.push(undoBaseState);
            if (undoStack.length > MAX_UNDO_DEPTH) undoStack.shift();
            undoBaseState = captureUndoSnap();
            updateUndoButtons();
        }

        // Music-events recorder. Registers once (in start() below) and
        // appends entries to the active recording every time a new song
        // starts. Pre-first-move song changes overwrite the initial
        // entry (so the "starting song" is whatever's actually playing
        // the instant the player begins). Post-first-move song changes
        // append timestamped entries. Skips entirely during replay so
        // scripted playback doesn't loop-record itself.
        function recordSongChange(song /*, paused */) {
            if (!recording || isReplaying) return;
            if (!song || !song.id) return;
            // Never record menu music into a game recording. If the
            // menu→game music handoff hasn't completed yet (iOS timing, or
            // an older cached client), the menu track can momentarily be
            // the current song; recording it makes replays show a bogus
            // menu title and fall silent when it ends. Skipping leaves
            // musicEvents empty until a real gameplay song starts — the
            // replay side treats that as "just keep normal music playing".
            if (isMenuMusic(song.id)) return;
            if (recording.startTime === 0) {
                // Pre-first-move: track the initial song slot.
                if (recording.musicEvents.length === 0) {
                    recording.musicEvents.push({ t: 0, songId: song.id });
                } else {
                    recording.musicEvents[0] = { t: 0, songId: song.id };
                }
            } else {
                recording.musicEvents.push({
                    t: Date.now() - recording.startTime,
                    songId: song.id
                });
            }
        }
        if (typeof Music !== 'undefined' && Music.addSongChangeListener) {
            Music.addSongChangeListener(recordSongChange);
        }

        const replayBtn = document.getElementById('replayBtn');
        let isReplaying = false;
        let replayCancelled = false;
        let replayTimer = null;     // setTimeout id of the in-flight inter-move wait
        let replayResolve = null;   // resolve fn of the in-flight wait promise

        function cancelReplay() {
            if (!isReplaying) return;
            replayCancelled = true;
            if (replayTimer !== null) {
                clearTimeout(replayTimer);
                replayTimer = null;
            }
            // Resolve the pending wait immediately so the replay loop wakes
            // up, sees replayCancelled, and breaks out instead of running
            // the rest of the move queue.
            if (replayResolve) {
                const r = replayResolve;
                replayResolve = null;
                r();
            }
        }

        // Re-seed every SFX state baseline `refresh()` diffs against, plus
        // kill any still-running loops, from whatever's currently loaded
        // into Maze + Render. Two reasons:
        //   (1) Maze.pathsWon's unused slots default to `true` in modes
        //       with fewer than 4 paths (e.g. 1-path → [F,T,T,T]). An
        //       all-false baseline reads those phantom trues as newly
        //       completed paths and fires applause on every puzzle start.
        //   (2) The first refresh() after a puzzle loads would otherwise
        //       fire applause for any genuinely-won path that happens to
        //       already be lit in the loaded snapshot.
        // Called from `newPuzzle` AND exposed on `window.Game` so callers
        // that bypass newPuzzle (PotD's startPuzzle does its own
        // Maze.loadSnapshot + Gates.restore + Maze.recompute pipeline)
        // can also reset the baselines — without that, the first
        // refresh() during a PotD play diffs against the prior Marathon
        // game's stale lastPathsWon and fires spurious applause on the
        // player's first tile click.
        function resetSfxBaselines() {
            lastWon = !!Maze.won;
            const initPaths = Maze.pathsWon || [false, false, false, false];
            lastPathsWon = [!!initPaths[0], !!initPaths[1], !!initPaths[2], !!initPaths[3]];
            lastJoined   = !!(Render.hasJoinedLanes && Render.hasJoinedLanes());
            if (typeof Sfx !== 'undefined' && Sfx.stopLoop) Sfx.stopLoop('glitch_overlap');
        }

        function refresh() {
            Render.draw();
            const justWon = Maze.won && !lastWon;
            if (justWon) {
                if (typeof Potd !== 'undefined' && Potd.isPlaying && Potd.isPlaying()) {
                    // PotD: timed solve → submit to server + back to menu.
                    Potd.onSolve();
                } else if (typeof Marathon !== 'undefined' && Marathon.isPlaying()) {
                    // Marathon owns progression — score the solve and queue
                    // the next (larger) puzzle. Banner stays hidden in game mode.
                    Marathon.onSolve();
                } else {
                    banner.classList.add('visible');
                    if (replayBtn && recording && !isReplaying) replayBtn.hidden = false;
                    // Replay solve: mirror Marathon.onSolve / Potd.onSolve's
                    // celebratory cue without going through their scoring
                    // flows (which would re-submit to the server, etc.).
                    // stopLoop matches the live path's pattern (line ~721
                    // in marathon.js) — any lingering overlap-loop dies
                    // with the win so the loop doesn't bleed into the
                    // brief solved-state pause before the next replay
                    // puzzle (or the leaderboard return on single-puzzle
                    // replay).
                    if (isReplaying && typeof Sfx !== 'undefined') {
                        if (Sfx.stopLoop) Sfx.stopLoop('glitch_overlap');
                        Sfx.play('applause_long');
                    }
                }
            } else if (!Maze.won && lastWon) {
                banner.classList.remove('visible');
            }

            // SFX state machine. Fires whenever Sfx is loaded (defensive —
            // script-order should guarantee it's there). Runs during both
            // live play AND replay — the state-derived cues (path-completion
            // applause + glitch overlap loop) are exactly the SFX a replay
            // viewer expects to hear at the same moments the original
            // player heard them. SFX itself is self-gated on the viewer's
            // current muted/volume settings — players who keep SFX off
            // get a silent replay, those who keep them on get the cues.
            if (typeof Sfx !== 'undefined') {
                const cur = Maze.pathsWon || [false, false, false, false];
                // Intermediate path completion: applause when a single path
                // connects but the puzzle as a whole isn't solved yet.
                // The final-path case is handled by Marathon.onSolve →
                // applause_long; we suppress applause here when Maze.won
                // so the two cues don't stack.
                if (!Maze.won) {
                    for (let i = 0; i < 4; i++) {
                        if (cur[i] && !lastPathsWon[i]) {
                            Sfx.play('applause');
                            break;
                        }
                    }
                }
                // Detect completed-path BREAKS (any pathsWon[i] going from
                // true → false). Fires audience_awww — the "aww, you broke
                // a finished path" reaction. Fires on any cause that
                // disconnects a previously-won entry-to-exit path: own
                // rotation undoing the last winning move, twin twist
                // breaking a remote chain, hint replacing a tile that
                // was part of a completed chain, etc. The twin-twist
                // OR-pick (fail/disappointed/gasp) in handlePointer is
                // a separate, partial-chain-break reaction; this one
                // requires the broken chain to have been complete.
                for (let i = 0; i < 4; i++) {
                    if (!cur[i] && lastPathsWon[i]) {
                        Sfx.play('audience_awww');
                        break;
                    }
                }
                lastPathsWon = [!!cur[0], !!cur[1], !!cur[2], !!cur[3]];

                // Two-paths-overlap loop: rising edge starts the glitch loop,
                // falling edge stops it.
                const joined = !!(Render.hasJoinedLanes && Render.hasJoinedLanes());
                if (joined && !lastJoined)      Sfx.playLoop('glitch_overlap', 'glitch');
                else if (!joined && lastJoined) Sfx.stopLoop('glitch_overlap');
                lastJoined = joined;
            }

            lastWon = Maze.won;
        }

        // Replay-side mirror of the live undo stack. Because replay rebuilds
        // state deterministically by applying moves from initialState, the
        // board at replay-move-i equals the live board at move-i — so pushing
        // the pre-move snapshot before each real move and popping it on an
        // `undo` move lands the replay on exactly the state the live undo did.
        // Reset per recording in playOneRecording (separate from the live
        // undoStack so a post-game replay can't disturb live undo state).
        let replayUndoStack = [];
        let replayBase = null;
        // Apply a recorded `undo` move during playback: step back to the
        // banked pre-move state. Mirrors live undo()'s restore (silent — no
        // SFX state machine, matching the live undo which suppresses it).
        function applyReplayUndo() {
            if (replayUndoStack.length === 0) return;
            const prev = replayUndoStack.pop();
            Maze.loadSnapshot(cloneMazeSnap(prev.maze));
            if (typeof Gates !== 'undefined') {
                if (prev.gates && Gates.restore) Gates.restore(prev.gates);
                else if (Gates.clear) Gates.clear();
                if (Maze.recompute) Maze.recompute();
            }
            replayBase = prev;
            if (Render.clearFadingLanes) Render.clearFadingLanes();
            Render.draw();
            resetSfxBaselines();
        }
        function applyReplayMove(move) {
            if (move.type === 'rotate') {
                if (Maze.rotate(move.r, move.c, move.ccw)) {
                    Render.animateRotationAt(move.r, move.c, move.ccw);
                }
            } else if (move.type === 'lock') {
                Maze.togglePlayerLock(move.r, move.c);
            } else if (move.type === 'hint') {
                const result = Maze.applyHintAt(move.r, move.c);
                if (result && result.turns > 0) {
                    Render.animateRotationAt(move.r, move.c, false, result.turns);
                }
                // Mirror handleHintClick's SFX so replay viewers hear the
                // same audience-reaction cue the live player did. Sfx
                // self-gates on the watcher's current muted/volume
                // settings, so a player who has SFX off hears nothing —
                // matching universal-rule expectations for replay audio.
                if (typeof Sfx !== 'undefined') Sfx.play(['audience_shocked', 'jump_scare']);
            } else if (move.type === 'gate') {
                if (typeof Gates !== 'undefined') {
                    Gates.rotate(move.ccw);
                    if (Maze.recompute) Maze.recompute();
                    Render.animateGateRotation(move.ccw);
                }
            }
        }
        // Core single-puzzle playback. Caller is responsible for the
        // isReplaying lifecycle — replay() flips it per invocation, but
        // replayAll() holds it true across the whole sequence so the
        // gating in handlePointer / hintBtn stays active between puzzles.
        async function playOneRecording(rec) {
            if (!rec) return;
            // Recordings may carry a different mode/dims than the current
            // game state. Sync mode flags + dims BEFORE loadSnapshot so
            // the grid is interpreted correctly.
            if (typeof rec.quadMode === 'boolean') Maze.setQuadMode(rec.quadMode);
            if (typeof rec.pathCount === 'number') Maze.setPathCount(rec.pathCount);
            if (rec.initialState
                && (rec.initialState.rows !== Maze.ROWS || rec.initialState.cols !== Maze.COLS)) {
                Maze.setDimensions(rec.initialState.rows, rec.initialState.cols);
            }
            Maze.loadSnapshot(deepCloneSnapshot(rec.initialState));
            // Restore gates for the puzzle being replayed. Older recordings
            // pre-dating the gates feature have no `gates` field — clear in
            // that case so we don't carry over stale state from prior plays.
            if (typeof Gates !== 'undefined') {
                if (rec.gates) Gates.restore(rec.gates);
                else Gates.clear();
                if (Maze.recompute) Maze.recompute();
            }
            Render.refit();
            Render.draw();
            // Fresh replay-undo stack anchored on the loaded initial state,
            // mirroring resetUndo() on the live side.
            replayUndoStack = [];
            replayBase = captureUndoSnap();
            // Re-seed the SFX diff baselines for the just-loaded snapshot.
            // Without this, the previous game's lastPathsWon/lastWon/
            // lastJoined would still be in place; the first replay-move
            // refresh() would diff against those and could fire spurious
            // applause / leak a stale glitch-loop into the new playback.
            resetSfxBaselines();
            // Hand music control to scripted playback: schedules each
            // recorded song change at its original timestamp so the
            // watcher hears the same songs in the same order at the
            // same offsets the original player heard. Older recordings
            // without musicEvents pass an empty array → no-op (music
            // continues whatever it was already playing). Wrapped in
            // try/finally so a thrown error or cancel still stops the
            // scripted timer chain and returns Music to normal control.
            if (typeof Music !== 'undefined' && Music.startScriptedPlayback) {
                Music.startScriptedPlayback(rec.musicEvents || []);
            }
            try {
                const start = Date.now();
                for (const move of (rec.moves || [])) {
                    if (replayCancelled) break;
                    const wait = Math.max(0, move.t - (Date.now() - start));
                    if (wait > 0) {
                        await new Promise((res) => {
                            replayResolve = res;
                            replayTimer = setTimeout(() => {
                                replayTimer = null;
                                replayResolve = null;
                                res();
                            }, wait);
                        });
                    }
                    if (replayCancelled) break;
                    if (move.type === 'undo') {
                        // Step back through the replay-undo stack. applyReplayUndo
                        // does its own silent draw + baseline reset (mirroring
                        // live undo()); no refresh() so the SFX/win machine
                        // doesn't fire on the state jump.
                        applyReplayUndo();
                    } else {
                        // Bank pre-move state, apply, then advance the base —
                        // the exact order recordMove uses live, so the replay
                        // stack tracks the live one move-for-move.
                        replayUndoStack.push(replayBase);
                        applyReplayMove(move);
                        replayBase = captureUndoSnap();
                        // refresh() — not just Render.draw() — so the SFX
                        // state machine runs after every replay move (the
                        // gate that previously suppressed SFX during replay
                        // was removed). refresh() also handles the win-state
                        // banner add via its justWon branch, so the explicit
                        // `if (Maze.won) banner...` line below is no longer
                        // needed.
                        refresh();
                    }
                }
            } finally {
                if (typeof Music !== 'undefined' && Music.stopScriptedPlayback) {
                    Music.stopScriptedPlayback();
                }
            }
        }

        async function replay() {
            if (!recording || isReplaying) return;
            isReplaying = true;
            replayCancelled = false;
            replayBtn.disabled = true;
            await playOneRecording(recording);
            isReplaying = false;
            replayCancelled = false;
            replayBtn.disabled = false;
        }
        if (replayBtn) replayBtn.addEventListener('click', replay);

        // Cross-puzzle orchestration — Marathon uses this when a player
        // clicks Watch on a leaderboard entry. `events` is the array of
        // per-puzzle recordings from the server. `onPuzzleChange(idx, total)`
        // fires before each puzzle starts so the caller can update HUD text.
        // Returns true on completion, false if cancelled via cancelReplay().
        async function replayAll(events, onPuzzleChange) {
            if (isReplaying || !Array.isArray(events) || events.length === 0) return false;
            isReplaying = true;
            replayCancelled = false;
            let completed = true;
            for (let i = 0; i < events.length; i++) {
                if (replayCancelled) { completed = false; break; }
                if (typeof onPuzzleChange === 'function') {
                    try { onPuzzleChange(i, events.length); } catch (e) {}
                }
                await playOneRecording(events[i]);
                if (replayCancelled) { completed = false; break; }
                // Brief breath between puzzles so the solved state is
                // visible before the next snapshot loads.
                if (i < events.length - 1) {
                    await new Promise((res) => {
                        replayResolve = res;
                        replayTimer = setTimeout(() => {
                            replayTimer = null;
                            replayResolve = null;
                            res();
                        }, 800);
                    });
                }
            }
            isReplaying = false;
            replayCancelled = false;
            return completed;
        }

        async function newPuzzle(rows, cols) {
            // Bail out of any in-progress replay BEFORE the seq-token gate
            // — the user clicking "next puzzle" mid-replay should always
            // abort the playback even if a build is somehow already pending.
            cancelReplay();
            // Capture our seq BEFORE any async work so we can detect being
            // superseded later. ++ first so the OLDER in-flight call sees
            // its seq is now stale.
            const mySeq = ++newPuzzleSeq;
            isBuilding = true;
            banner.classList.remove('visible');
            // Defensive: clear the building banner up front. A previous
            // newPuzzle invocation that the player abandoned mid-build
            // can leave the banner visible because its banner-removal
            // line never runs until the worker eventually completes the
            // abandoned build. Without this clear, the player can end
            // up sitting in a fresh game (cache-hit, instant) with the
            // stale "Building puzzle…" banner still painted on top.
            buildingBanner.classList.remove('visible');

            // No explicit dims AND last puzzle was won → advance progression.
            // (Manual `Game.newPuzzle(r, c)` from the slider keeps that exact
            // size; pressing N or clicking the win banner triggers progression.)
            if (rows === undefined && cols === undefined && lastWon) {
                const next = nextSize(Maze.ROWS, Maze.COLS);
                rows = next.rows;
                cols = next.cols;
            }

            // All Game.newPuzzle callers pass PHYSICAL (sub-tile) dims.
            // Slider handler in index.html does the logical→physical
            // conversion (×2 in quad mode). Auto-progression's nextSize
            // also returns PHYSICAL.
            const wantResize = (rows !== undefined && cols !== undefined &&
                                (rows !== Maze.ROWS || cols !== Maze.COLS));
            if (wantResize) {
                Maze.setDimensions(rows, cols);
            }

            const wantR = Maze.ROWS, wantC = Maze.COLS;
            const wantKey = cacheKey(wantR, wantC);
            const cached = preGenCache.get(wantKey);
            if (cached) {
                // Instant — the lookahead cache already has this size.
                const isStarter = STARTER_KEY_SET.has(wantKey);
                Logger.info('🎯 cache hit ' + (isStarter ? '(starter)' : '(lookahead)') +
                    ' ' + describeBuild(wantR, wantC, pathCount, quadMode, 'player request') +
                    ' — loaded instantly');
                Maze.loadSnapshot(cached);
                preGenCache.delete(wantKey);
            } else if (!ensureWorker()) {
                // Worker unavailable (file:// origin or unsupported browser).
                // Build directly on the main thread; banner after 500ms.
                if (wantResize) invalidatePreGen();
                const bannerTimer = setTimeout(function () {
                    // Self-check supersession before painting the banner —
                    // an older call's timer that fires AFTER a newer call
                    // has taken over would otherwise show "Building…" on
                    // a game that's already loaded.
                    if (mySeq !== newPuzzleSeq) return;
                    buildingBanner.classList.add('visible');
                }, 500);
                await Maze.init();
                clearTimeout(bannerTimer);
                // Supersession: a newer newPuzzle started while we were
                // building on the main thread. Maze.init() already mutated
                // the live Maze (no way to undo that — the newer call will
                // re-init on top), but we MUST skip the rest of the cleanup
                // (Gates, Render.refit, lastWon update) so we don't stomp
                // the newer call's state when its turn comes.
                if (mySeq !== newPuzzleSeq) return;
                buildingBanner.classList.remove('visible');
            } else {
                // Cache miss. Two sub-cases:
                //   inFlight=true  → worker is already building exactly
                //     what we want. Send 'hurry' so it ships best-so-far
                //     instead of finishing the strict canonical search.
                //   inFlight=false → worker is building something else
                //     (a starter for a different mode, an old lookahead,
                //     etc). Send an urgent generate so the worker aborts
                //     that build and races to start ours — the player is
                //     actively waiting on this one. Whatever was aborted
                //     gets re-queued naturally by ensureStartersBuilt /
                //     fillPreGenQueue once the urgent request completes.
                // Banner shows "Loading…" or "Building puzzle…" only if
                // the wait exceeds 500ms.
                if (wantResize) invalidatePreGen();
                const inFlight = preGenSize
                    && preGenSize.rows === wantR
                    && preGenSize.cols === wantC
                    && preGenSize.pathCount === pathCount
                    && preGenSize.quadMode === quadMode;
                if (!inFlight) {
                    requestBuild(wantR, wantC, { urgent: true, purpose: 'player request' });
                } else if (worker) {
                    Logger.info('⚡ worker hurry — player waiting on in-flight build');
                    worker.postMessage({ type: 'hurry' });
                }
                const bannerTimer = setTimeout(function () {
                    // Self-check supersession before painting the banner.
                    if (mySeq !== newPuzzleSeq) return;
                    buildingBanner.textContent = inFlight ? 'Loading…' : 'Building puzzle…';
                    buildingBanner.classList.add('visible');
                }, 500);
                await waitForPreGen(wantR, wantC, mySeq);
                clearTimeout(bannerTimer);
                // Supersession: this is THE bug we're guarding against.
                // The player abandoned this build, started a different
                // puzzle (cache-hit, instant), and is now actively playing
                // it. The worker just finished what we asked for and put
                // it in preGenCache — but loadSnapshot'ing it here would
                // wipe the active game and replace it with the abandoned
                // puzzle's data. The cached snapshot stays in preGenCache
                // intact (no .delete) so it serves a future request for
                // that exact size as a cache hit.
                if (mySeq !== newPuzzleSeq) return;
                buildingBanner.classList.remove('visible');
                Maze.loadSnapshot(preGenCache.get(wantKey));
                preGenCache.delete(wantKey);
            }

            // Resize canvas + sync debug sliders if dimensions changed.
            if (wantResize) {
                Render.refit();
                syncDebugSliders();
            }

            isBuilding = false;
            // Place gates AFTER the build finishes (works for both worker-
            // built and main-thread-built puzzles). In quad mode, gates sit
            // at SUB-TILE vertices and span one sub-tile edge — Maze.ROWS/COLS
            // are physical (sub-tile) dims so the existing interior-vertex
            // iteration just works. Maze.solutionEdges handles the quad
            // un-scramble internally so safe-direction picks are correct.
            // Recompute the walk so any newly-blocked edge is reflected in
            // highlighted before refresh()/draw runs.
            if (typeof Gates !== 'undefined') {
                const solveCount = (typeof Marathon !== 'undefined' && Marathon.getSolvedCount)
                    ? Marathon.getSolvedCount() : 0;
                const target = 4 + Math.floor(solveCount / 3);
                // Quad mode: anchor gates at quad-corners only (every other
                // sub-tile vertex). The prong is still one sub-tile long.
                const stride = Maze.quadMode ? 2 : 1;
                Gates.assignGates(Maze.ROWS, Maze.COLS, Maze.solutionEdges(), target, stride);
                if (Maze.recompute) Maze.recompute();
            }
            resetSfxBaselines();
            if (Render.clearFadingLanes) Render.clearFadingLanes();
            // Start a fresh recording for the new puzzle. Hide any leftover
            // replay button from the previous puzzle.
            startRecording();
            if (replayBtn) replayBtn.hidden = true;
            refresh();

            // Refill the lookahead cache for THIS game's progression first;
            // then top up any starter cache gaps (so consumed starters and
            // any new gaps left by an invalidatePreGen call get re-built).
            // Both functions are no-ops when the worker is busy or their
            // respective conditions don't apply, so call order = priority.
            fillPreGenQueue();
            ensureStartersBuilt();
        }

        async function setPathCount(n) {
            const v = parseInt(n, 10);
            const next = (v === 2 || v === 3 || v === 4) ? v : 1;
            if (pathCount === next) return;
            pathCount = next;
            Maze.setPathCount(pathCount);  // main-thread Maze (loadSnapshot consistency)
            invalidatePreGen();              // cache contents are wrong-mode now
            preGenSize = null;               // any in-flight response will be stale, discard
            // Canvas padding scales with path count so rings have room —
            // refit recomputes cellSize and redraws.
            Render.refit();
            await newPuzzle(Maze.ROWS, Maze.COLS);
        }

        async function setQuadMode(on) {
            const next = !!on;
            if (quadMode === next) return;
            quadMode = next;
            Maze.setQuadMode(quadMode);
            invalidatePreGen();
            preGenSize = null;
            // When toggling quad mode, the current dims may not even be
            // valid (quad mode requires even dims). Snap to a sane default
            // (4×4 logical = 8×8 physical when on, or 4×4 physical when off).
            const logicalSide = 4;
            const physicalSide = next ? logicalSide * 2 : logicalSide;
            await newPuzzle(physicalSide, physicalSide);
        }

        // Expose to the debug-panel controls (index.html) so a grid-size
        // change or path-count change routes through the same pipeline.
        window.Game = {
            newPuzzle: newPuzzle,
            setPathCount: setPathCount,
            setQuadMode: setQuadMode,
            get quadMode() { return quadMode; },
            get recording() { return recording; },  // debug/test access
            replayAll: replayAll,                   // Marathon leaderboard playback
            cancelReplay: cancelReplay,
            get isReplaying() { return isReplaying; },
            // Exposed for PotD: loading a server-built snapshot bypasses
            // newPuzzle, so PotD calls this after Maze.loadSnapshot /
            // Gates.restore / Maze.recompute to start a fresh recording
            // anchored on the loaded state instead of inheriting whatever
            // the previous marathon run left in `recording`.
            startRecording: startRecording,
            // Undo the last committed move. Exposed for tests / future
            // gamepad or controls-config bindings.
            undo: undo,
            get canUndo() { return undoStack.length > 0; },
            // Same bypass concern as startRecording — PotD doesn't route
            // through newPuzzle, so it needs to re-seed the SFX diff
            // baselines explicitly. Without this call, the first refresh()
            // in a PotD play diffs against the previous marathon game's
            // pathsWon/won/joined state and can fire spurious applause /
            // applause_long / glitch-loop SFX on the player's first tile
            // click.
            resetSfxBaselines: resetSfxBaselines,
        };

        // Debug-panel pre-gen status indicator. Polls every 200ms — cheap
        // enough not to matter, and event-driven would miss the ticking
        // elapsed-seconds readout during a long build.
        const preGenStatusEl = document.getElementById('preGenStatus');
        if (preGenStatusEl) {
            setInterval(function () {
                if (!workerAvailable) {
                    preGenStatusEl.textContent = 'Pre-gen: (worker unavailable)';
                    return;
                }
                const cached = Array.from(preGenCache.keys()).map(function (k) { return k.replace(',', 'x'); });
                const cacheText = cached.length ? cached.join(' ') : 'empty';
                let buildText = '';
                if (preGenSize) {
                    const elapsed = ((Date.now() - preGenStartTime) / 1000).toFixed(1);
                    buildText = ' | building ' + preGenSize.rows + 'x' + preGenSize.cols + ' (' + elapsed + 's)';
                }
                preGenStatusEl.textContent = 'Cache: ' + cacheText + buildText;
            }, 200);
        }

        // Kick off the Marathon starter pre-gen as soon as the worker can
        // accept work. Runs regardless of which mode the player initially
        // picks (PotD or Marathon) — they may switch to Marathon at any
        // point, and we want their FIRST puzzle of either mode to be
        // instant. ensureStartersBuilt walks the 8 starter types in order
        // and chains the next request after each worker response.
        ensureStartersBuilt();

        // In debug mode, drop straight into the existing default puzzle. In
        // game mode, hand the lifecycle to Marathon — it'll show the menu,
        // then call our `startPuzzle` callback when the player picks a mode.
        if (isDebugMode) {
            newPuzzle();
        } else if (typeof Marathon !== 'undefined') {
            Marathon.init({
                // Set the requested mode/dims on Maze + Game state, invalidate
                // the pre-gen cache (config has changed), then build & display.
                // Calls Marathon.onPuzzleReady() once the puzzle is on-screen
                // so the per-puzzle clock anchors to "player can see it" — not
                // "we asked the worker to build."
                startPuzzle: async function (opts) {
                    // Wipe the previous puzzle from Maze + canvas so the
                    // stale puzzle isn't briefly visible while the worker
                    // builds the new one. Render.draw clears the canvas
                    // before checking grid, then bails on the null grid.
                    Maze.clear();
                    Render.draw();
                    // Shuffle background HERE (not in onPuzzleReady) so the
                    // new image appears at the START of the build/transition,
                    // alongside "Building puzzle…" — otherwise the old
                    // puzzle's background lingers while the worker runs.
                    if (Render.shuffleBackground) Render.shuffleBackground();
                    // Sync Maze to the requested config every time, regardless of
                    // whether game.js's cached locals match. PotD's startPuzzle
                    // path mutates Maze.setQuadMode/setPathCount directly — it
                    // does NOT route through this callback — so between a PotD
                    // play and the next Marathon click, game.js's locals can be
                    // out of sync with Maze's actual state. The old diff check
                    // gated Maze.set*() on game.js's view of the world, which
                    // meant "PotD quad → Marathon singular when the previous
                    // Marathon was also singular" left Maze.quadMode stuck at
                    // true. Subsequent rotate() entered the quad branch and
                    // crashed dereferencing the null quadScramble; subsequent
                    // newPuzzle's solutionEdges crashed running the un-scramble
                    // dance on a stale-size quadScramble against the new grid.
                    // setPathCount/setQuadMode are trivial assignments — calling
                    // them unconditionally is free.
                    const mazeQuadChanged = Maze.quadMode !== opts.quadMode;
                    const mazePathChanged = Maze.pathCount !== opts.pathCount;
                    Maze.setPathCount(opts.pathCount);
                    Maze.setQuadMode(opts.quadMode);
                    // PreGen worker invalidation is the expensive piece — only
                    // do it when game.js's view actually changed, since PotD's
                    // mutations don't touch the worker and don't require a
                    // rebuild. Render.refit() runs whenever MAZE'S mode shifted
                    // (covering both the normal Marathon mode-switch case and
                    // the PotD-pollution case), so a stale layout from before
                    // can't survive into the new puzzle.
                    if (mazeQuadChanged || mazePathChanged) {
                        Render.refit();
                    }
                    if (pathCount !== opts.pathCount || quadMode !== opts.quadMode) {
                        pathCount = opts.pathCount;
                        quadMode  = opts.quadMode;
                        invalidatePreGen();
                        preGenSize = null;
                    }
                    await newPuzzle(opts.rows, opts.cols);
                    Marathon.onPuzzleReady();
                },
                // Cancel any in-flight visual state when the player abandons
                // a game or time expires — leaves the engine in a sane idle.
                // Hides BOTH banners: winBanner ("You connected the path!")
                // in case the player solved the puzzle but quit before the
                // animation finished, AND buildingBanner ("Building puzzle…")
                // which would otherwise stay stuck on screen if the player
                // quit mid-build (the worker keeps building, its newPuzzle
                // await chain is still pending, and nothing else hides the
                // banner until that await completes — which for a 4-path
                // quad is many seconds). Both removes are unconditional;
                // .classList.remove on an element that doesn't have the
                // class is a no-op.
                quit: function () {
                    cancelReplay();
                    if (banner)         banner.classList.remove('visible');
                    if (buildingBanner) buildingBanner.classList.remove('visible');
                }
            });
        }

        // Click / tap → rotate the tile under the pointer. Tap rotates CW
        // (the natural single-input default). Mouse buttons swap that pairing
        // so the secondary button matches the touch default: LEFT-click is
        // CCW, RIGHT-click is CW.
        function handlePointer(ev, ccw) {
            if (isBuilding || isReplaying) return;
            // Marathon between-puzzles state: swallow canvas taps entirely.
            // Rotating now would break the gold path the player's looking at,
            // and advance is intentionally popup-only so a click-cascade from
            // solving by mashing can't accidentally skip the transition.
            if (typeof Marathon !== 'undefined' && Marathon.isInTransition()) {
                return;
            }
            // Same gate for PotD: the solved card is up — block canvas
            // rotations so the player can't accidentally un-solve the
            // puzzle while reading the result.
            if (typeof Potd !== 'undefined' && Potd.isInSolveTransition && Potd.isInSolveTransition()) {
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const x = (ev.clientX !== undefined ? ev.clientX : ev.touches[0].clientX) - rect.left;
            const y = (ev.clientY !== undefined ? ev.clientY : ev.touches[0].clientY) - rect.top;
            // Gate hit overrides the tile under the pointer — tapping a gate
            // (or its buffer zone) rotates all gates in unison, never the
            // underlying tile.
            if (Render.gateAt) {
                const gate = Render.gateAt(x, y);
                if (gate && typeof Gates !== 'undefined') {
                    Gates.rotate(ccw);
                    recordMove({ type: 'gate', ccw: !!ccw });
                    // Walk uses Gates.edgeBlocked; recompute so highlighted
                    // reflects the new gate state before drawing.
                    if (Maze.recompute) Maze.recompute();
                    Render.animateGateRotation(ccw);
                    if (typeof Sfx !== 'undefined') Sfx.gateClick();
                    refresh();
                    return;
                }
            }
            const cell = Render.cellAt(x, y);
            if (!cell) return;
            // Snapshot pre-rotation state for the twin-twist-break SFX check.
            // Rules per the user:
            //   1. SFX only when the PARTNER tile (B) is what breaks the path,
            //      not the tile the player clicked (A) — directly breaking
            //      your own twist is a choice, not a surprise.
            //   2. Don't count it as a break if the only thing lost is the
            //      tip of the chain (the chain just shortens by B; everything
            //      else is intact).
            // Per-path analysis: in multi-path mode, ANY path that B broke
            // (and A didn't, and isn't just tip-loss) is enough to fire.
            const preTile  = Maze.grid[cell.row] && Maze.grid[cell.row][cell.col];
            const isTwin   = !!(preTile && preTile._twin);
            let aCells = null, bCells = null, preByPath = null, preEntries = null;
            if (isTwin) {
                aCells = new Set();
                bCells = new Set();
                if (Maze.quadMode) {
                    // Quad-twin: rotation cascades over all 4 sub-tiles of
                    // both quads. A-set = clicked quad, B-set = partner quad
                    // (partner key in assignQuadTwins is the partner quad's TL).
                    const aQR = (cell.row >> 1) << 1, aQC = (cell.col >> 1) << 1;
                    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
                        aCells.add((aQR + dr) + ',' + (aQC + dc));
                    }
                    const parts = preTile._twin.partner.split(',');
                    const bQR = parseInt(parts[0], 10), bQC = parseInt(parts[1], 10);
                    for (let dr = 0; dr < 2; dr++) for (let dc = 0; dc < 2; dc++) {
                        bCells.add((bQR + dr) + ',' + (bQC + dc));
                    }
                } else {
                    aCells.add(cell.row + ',' + cell.col);
                    bCells.add(preTile._twin.partner);
                }
                preByPath = [new Set(), new Set(), new Set(), new Set()];
                // Snapshot the full entries (with port pairs) too — used to
                // build the fade visual, which needs the specific lit lane,
                // not just the cell.
                preEntries = (Maze.highlighted || []).slice();
                for (const h of preEntries) {
                    const p = h.path | 0;
                    if (p >= 0 && p < 4) preByPath[p].add(h.row + ',' + h.col);
                }
            }
            const ok = Maze.rotate(cell.row, cell.col, ccw);
            if (ok) {
                recordMove({ type: 'rotate', r: cell.row, c: cell.col, ccw: !!ccw });
                Render.animateRotationAt(cell.row, cell.col, ccw);
                if (typeof Sfx !== 'undefined') Sfx.click();
                if (isTwin && typeof Sfx !== 'undefined') {
                    const postByPath = [new Set(), new Set(), new Set(), new Set()];
                    for (const h of (Maze.highlighted || [])) {
                        const p = h.path | 0;
                        if (p >= 0 && p < 4) postByPath[p].add(h.row + ',' + h.col);
                    }
                    // Lane-level post lookup: keyed by (r, c, lo, hi, path).
                    // Lets us detect when B's pre-walk LANE is gone even though
                    // B's CELL is still lit via a different lane (e.g. an elbow
                    // rotated to a new corner — the cell still glows, but the
                    // old corner that fed the upstream segment is gone, so
                    // everything that depended on that corner is orphaned).
                    const postLaneKeys = new Set();
                    for (const h of (Maze.highlighted || [])) {
                        const lo = Math.min(h.inPort, h.outPort);
                        const hi = Math.max(h.inPort, h.outPort);
                        postLaneKeys.add(h.row + ',' + h.col + ',' + lo + ',' + hi + ',' + (h.path | 0));
                    }
                    let sfxEligible = false;
                    // Collect entries to hand to Render.fadeLanes — the lost
                    // downstream lanes on every path that passed the SFX
                    // gate. Skip cells in bCells so B's own tile/quad stays
                    // visually quiet (it's the "twisted tile" the user
                    // asked us NOT to fade — the fade is for the remainder).
                    const fadeEntries = [];
                    const fadeSeen    = new Set();
                    for (let p = 0; p < 4; p++) {
                        const pre = preByPath[p], post = postByPath[p];
                        let lost = null;
                        for (const k of pre) if (!post.has(k)) (lost || (lost = new Set())).add(k);
                        if (!lost) continue;
                        // (Previously had an `aInLost` filter here that skipped
                        // the path when the rotated tile A's own cell was in
                        // `lost`. The intent was "don't fire on player rotating
                        // and breaking their own simple path." But in a twin
                        // twist, A and B BOTH rotate — so a CCW rotation that
                        // happens to disconnect A's lane (in addition to B
                        // breaking things downstream) was getting filtered out
                        // even though it was a legitimate twin-twist break.
                        // The remaining checks below — bOldLaneGone (B's old
                        // lane is gone) plus remainderUnits.size >= 2 (2+
                        // cells lost downstream of B) — already establish
                        // that B is meaningfully contributing to the break.)
                        // B's old lane gone? True if any pre-walk entry through
                        // B's cells has no matching (same port-pair) entry in
                        // post. Strictly broader than "B in lost": catches the
                        // elbow-still-lit case where B's CELL stays in
                        // highlighted via a different corner but the chain
                        // past B has been cut at B.
                        let bOldLaneGone = false;
                        for (const h of preEntries) {
                            if ((h.path | 0) !== p) continue;
                            if (!bCells.has(h.row + ',' + h.col)) continue;
                            const lo = Math.min(h.inPort, h.outPort);
                            const hi = Math.max(h.inPort, h.outPort);
                            const key = h.row + ',' + h.col + ',' + lo + ',' + hi + ',' + p;
                            if (!postLaneKeys.has(key)) { bOldLaneGone = true; break; }
                        }
                        if (!bOldLaneGone) continue;
                        // The remainder (lost minus B's own cells) needs to
                        // span more than a single "tile" — a quad in quad
                        // mode (the player-perceived unit), otherwise a cell.
                        // A 1-unit remainder feels too minor for SFX + fade.
                        const remainderUnits = new Set();
                        for (const k of lost) {
                            if (bCells.has(k)) continue;
                            if (Maze.quadMode) {
                                const ci = k.indexOf(',');
                                const r = +k.substring(0, ci);
                                const c = +k.substring(ci + 1);
                                remainderUnits.add(((r >> 1) << 1) + ',' + ((c >> 1) << 1));
                            } else {
                                remainderUnits.add(k);
                            }
                        }
                        if (remainderUnits.size < 2) continue;
                        sfxEligible = true;
                        // Stash fade-eligible entries for this path: cells in
                        // `lost` and not in bCells. Dedupe by (cell, lane)
                        // because complete chains list each cell twice
                        // (once each from the fwd + bwd walks meeting).
                        for (const h of preEntries) {
                            if ((h.path | 0) !== p) continue;
                            const k = h.row + ',' + h.col;
                            if (!lost.has(k)) continue;
                            if (bCells.has(k)) continue;
                            const a = Math.min(h.inPort, h.outPort);
                            const b = Math.max(h.inPort, h.outPort);
                            const dedupe = k + ',' + a + ',' + b;
                            if (fadeSeen.has(dedupe)) continue;
                            fadeSeen.add(dedupe);
                            fadeEntries.push(h);
                        }
                    }
                    if (sfxEligible) {
                        // Twin-twist break: surprise reactions only.
                        // audience_awww moved to refresh()'s pathsWon
                        // true→false detection so it fires for ANY
                        // completed-path break, not just twin twists.
                        Sfx.play(['fail', 'audience_disappointed', 'audience_gasp']);
                        if (Render.fadeLanes) Render.fadeLanes(fadeEntries);
                    }
                }
            } else {
                // Rotation rejected. If this tile is part of a twin pair
                // and EITHER side is locked (hint OR player-lock), flash
                // both tiles dramatically — telegraphs the lock
                // relationship so the player understands why the click
                // didn't twist anything.
                const tile = Maze.grid[cell.row][cell.col];
                if (tile._twin) {
                    const parts = tile._twin.partner.split(',');
                    const partner = Maze.grid[parseInt(parts[0], 10)][parseInt(parts[1], 10)];
                    const eitherLocked = tile._hinted || partner._hinted ||
                                          tile._playerLocked || partner._playerLocked;
                    if (eitherLocked) {
                        Render.flashTwinPair(cell.row, cell.col);
                    }
                }
            }
            refresh();
        }

        // Long-press → toggle player-lock on the tile/quad under the pointer.
        // Lifting before LONG_PRESS_MS = normal rotate. The lock action sets
        // longPressFired so the imminent click/touchend handler can suppress
        // the rotate that would otherwise follow.
        const LONG_PRESS_MS = 500;
        const PRESS_MOVE_THRESHOLD = 12; // px — drift larger than this aborts the lock
        let pressTimer = null;
        let longPressFired = false;
        let pressStartX = 0, pressStartY = 0;

        // First-lock-per-page-load toast: explain the unlock gesture once
        // per page load, then stay quiet for the rest of the session. Plain
        // in-memory flag (no localStorage) so a fresh reload shows the
        // hint again — useful both for actual returning players and during
        // dev where reloads are constant.
        const lockToastEl = document.getElementById('lockToast');
        let lockToastShown = false;
        let lockToastTimer = null;
        function maybeShowLockToast(r, c) {
            if (!lockToastEl) return;
            const tile = Maze.grid[r] && Maze.grid[r][c];
            if (!tile || !tile._playerLocked) return;     // toast only on lock, not unlock
            if (lockToastShown) return;
            lockToastShown = true;
            lockToastEl.classList.add('visible');
            if (lockToastTimer) clearTimeout(lockToastTimer);
            lockToastTimer = setTimeout(() => {
                lockToastEl.classList.remove('visible');
                lockToastTimer = null;
            }, 3500);
        }

        // First-ever educational tooltip for a subtle trap: locking a
        // STRAIGHT tile that has an ELBOW twin. A straight tile reads as
        // "correct" in two rotations 180° apart (it's 2-fold symmetric),
        // so the player can't tell which of the two it's actually in — but
        // its lock-stepped elbow twin is NOT symmetric, so committing the
        // straight in the wrong-but-identical-looking orientation freezes
        // the elbow 180° off. Singular puzzles only (quad twins pair whole
        // quads, not per-tile straight/elbow shapes). Lives here in the
        // live long-press handler so it never fires from recorded-move
        // replay. Tooltip.showOnce de-dupes + persists the seen flag.
        function maybeShowTwinStraightLockTip(r, c) {
            if (typeof Tooltip === 'undefined' || !Tooltip.showOnce) return;
            if (Tooltip.isSeen && Tooltip.isSeen('twinStraightLock')) return;
            if (Maze.quadMode) return;                       // Singular puzzles only
            const tile = Maze.grid[r] && Maze.grid[r][c];
            if (!tile || !tile._playerLocked) return;        // fired a lock, not an unlock / blocked toggle
            if (tile.type !== Maze.T_STRAIGHT) return;       // the locked tile must be a straight
            if (!tile._twin) return;                         // ...with a twin...
            const parts = tile._twin.partner.split(',');
            const tr = parseInt(parts[0], 10);
            const tc = parseInt(parts[1], 10);
            const twin = Maze.grid[tr] && Maze.grid[tr][tc];
            if (!twin || twin.type !== Maze.T_ELBOW) return; // ...and that twin must be an elbow
            Tooltip.showOnce('twinStraightLock',
                (typeof I18n !== 'undefined' && I18n.t)
                    ? I18n.t('tooltip.twinStraightLock')
                    : 'Be careful when locking straight tiles that have an elbow twin! You could be locking the twin in the wrong orientation.');
        }

        function clearPress() {
            if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
        }
        function startPress(canvasX, canvasY) {
            clearPress();
            longPressFired = false;
            // Pressing on a gate (or its buffer) never targets the underlying
            // tile — gates can't be locked, only rotated. Skip the long-press
            // timer entirely so the tile beneath the gate isn't accidentally
            // locked.
            if (Render.gateAt && Render.gateAt(canvasX, canvasY)) return;
            pressStartX = canvasX;
            pressStartY = canvasY;
            pressTimer = setTimeout(() => {
                pressTimer = null;
                if (isBuilding) return;
                const cell = Render.cellAt(canvasX, canvasY);
                if (!cell) return;
                Maze.togglePlayerLock(cell.row, cell.col);
                recordMove({ type: 'lock', r: cell.row, c: cell.col });
                longPressFired = true;
                maybeShowLockToast(cell.row, cell.col);
                maybeShowTwinStraightLockTip(cell.row, cell.col);
                refresh();
            }, LONG_PRESS_MS);
        }
        function maybeCancelPress(canvasX, canvasY) {
            if (pressTimer === null) return;
            const dx = canvasX - pressStartX, dy = canvasY - pressStartY;
            if (Math.hypot(dx, dy) > PRESS_MOVE_THRESHOLD) clearPress();
        }

        canvas.addEventListener('mousedown', (ev) => {
            if (ev.button !== 0) return; // only left-button initiates long-press
            const rect = canvas.getBoundingClientRect();
            startPress(ev.clientX - rect.left, ev.clientY - rect.top);
        });
        canvas.addEventListener('mousemove', (ev) => {
            if (pressTimer === null) return;
            const rect = canvas.getBoundingClientRect();
            maybeCancelPress(ev.clientX - rect.left, ev.clientY - rect.top);
        });
        canvas.addEventListener('mouseup', clearPress);
        canvas.addEventListener('mouseleave', clearPress);

        canvas.addEventListener('click', (ev) => {
            if (longPressFired) { longPressFired = false; return; }
            handlePointer(ev, true);                                          // left-click = CCW
        });
        canvas.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            clearPress();
            handlePointer(ev, false);                                          // right-click = CW
        });

        // Touch: long-press → lock; quick tap → rotate CW (single-input default).
        // touchend.preventDefault suppresses the synthetic 300ms click, so the
        // click handler above only fires for actual mouse clicks.
        canvas.addEventListener('touchstart', (ev) => {
            if (ev.touches.length !== 1) { clearPress(); return; }
            const rect = canvas.getBoundingClientRect();
            const t = ev.touches[0];
            startPress(t.clientX - rect.left, t.clientY - rect.top);
        }, { passive: true });
        canvas.addEventListener('touchmove', (ev) => {
            if (pressTimer === null || ev.touches.length !== 1) return;
            const rect = canvas.getBoundingClientRect();
            const t = ev.touches[0];
            maybeCancelPress(t.clientX - rect.left, t.clientY - rect.top);
        }, { passive: true });
        canvas.addEventListener('touchend', (ev) => {
            ev.preventDefault();
            clearPress();
            if (longPressFired) { longPressFired = false; return; }
            handlePointer(ev.changedTouches ? { clientX: ev.changedTouches[0].clientX, clientY: ev.changedTouches[0].clientY } : ev, false);
        }, { passive: false });
        canvas.addEventListener('touchcancel', clearPress);

        // Manual "next puzzle" controls only fire in debug mode. In Marathon
        // mode, advancement is owned by Marathon.onSolve / its game flow.
        // Always register these — the mode check is done at handler-fire
        // time (not boot-time) so the dev-mode Ctrl+D toggle works
        // correctly. Before this, isDebugMode was captured ONCE at boot,
        // so a session that started in game mode and Ctrl+D'd into debug
        // got no win-banner click handler and no 'N' key — the player
        // would solve a puzzle and have no way to advance.
        function inDebugMode() {
            return document.documentElement.classList.contains('mode-debug');
        }
        // 'N' for a new puzzle
        window.addEventListener('keydown', (ev) => {
            if (!inDebugMode()) return;
            // Skip when typing in an input — Ctrl+D dev shortcut already
            // uses the same guard; reuse it here for consistency.
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (ev.key === 'n' || ev.key === 'N') newPuzzle();
        });
        // Click the win banner to start a new puzzle
        banner.addEventListener('click', () => {
            if (inDebugMode()) newPuzzle();
        });

        // Hint: snap a random unsolved path tile to its solution and lock it red.
        // Two buttons share one handler: #hintBtn (debug mode, top-right corner)
        // and #hudHintBtn (game mode, inside the HUD where the score used to be).
        // CSS hides whichever button doesn't match the current mode.
        async function handleHintClick(ev) {
            ev.stopPropagation();
            if (isBuilding || isReplaying) return;
            // Don't run hint during the between-puzzles transition; the
            // player's already won, hint would just lock a tile on a
            // puzzle they're about to leave behind. Treat it as a no-op.
            if (typeof Marathon !== 'undefined' && Marathon.isInTransition()) return;
            // PotD: hint use bumps the hintsUsed counter sent in the
            // submit payload — the server's PotD leaderboard uses
            // hints_used as the primary tiebreaker ahead of time_ms,
            // so a hint-using run still posts but ranks below
            // hint-free runs of any time. (Older policy was "hint =
            // disqualified", with a confirmation modal here. That
            // prompt is gone now — matches Marathon's no-prompt
            // behavior, and the tooltip educates the player about
            // the ranking cost.) On ineligible retries (spent slot)
            // Potd.noteHintUsed still ticks the counter, harmless
            // since no submit will fire for those runs anyway.
            if (typeof Potd !== 'undefined' && Potd.isPlaying && Potd.isPlaying()) {
                if (Potd.noteHintUsed) Potd.noteHintUsed();
            }
            const pick = Maze.hint();
            if (pick) {
                recordMove({ type: 'hint', r: pick.r, c: pick.c });
                if (typeof Sfx !== 'undefined') Sfx.play(['audience_shocked', 'jump_scare']);
                // Hint always rotates CW (applyHintAt advances rotation
                // toward the solution by `turns` 90° steps). Skip the
                // animation when turns=0 (tile was already at solution).
                if (pick.turns > 0) {
                    Render.animateRotationAt(pick.r, pick.c, false, pick.turns);
                    if (typeof Sfx !== 'undefined') Sfx.click();
                }
                // Marathon penalty — only when actually playing (not in
                // debug or between puzzles). Marathon.onHintUsed handles
                // the timer cut and the visual feedback.
                if (typeof Marathon !== 'undefined' && Marathon.isPlaying()) {
                    Marathon.onHintUsed();
                }
            }
            refresh();
        }
        ['hintBtn', 'hudHintBtn'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', handleHintClick);
        });

        // Undo: two buttons share one handler — #undoBtn (debug mode, top-left
        // corner, mirroring #hintBtn) and #hudUndoBtn (game-mode HUD, mirroring
        // #hudHintBtn left of the timer). CSS hides whichever doesn't match the
        // current mode; binding both is safe since only one is visible.
        undoBtnIds.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', (ev) => { ev.stopPropagation(); undo(); });
        });
        // Keyboard parity: Ctrl/⌘+Z is the universal undo gesture. Skip when a
        // text field is focused (name entry) so the browser's native input
        // undo still works there.
        window.addEventListener('keydown', (ev) => {
            if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
            if (ev.key !== 'z' && ev.key !== 'Z') return;
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            ev.preventDefault();
            undo();
        });
        // Initialize button enabled/disabled state for the loaded board.
        updateUndoButtons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
