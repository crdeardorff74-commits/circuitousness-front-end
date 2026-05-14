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
        const preGenCache = new Map();              // "r,c,paths" → snapshot
        let worker          = null;
        let workerAvailable = true;                  // flips to false on Worker construction/runtime error
        let preGenSize      = null;                  // {rows, cols, pathCount} of the in-flight worker request
        let preGenStartTime = 0;
        let pathCount       = 1;                     // 1, 2, or 3
        let quadMode        = false;                 // 2×2 sub-tile groups rotate as one unit
        // Cache key includes pathCount AND quadMode so cross-mode collisions
        // can't return a stale wrong-mode snapshot.
        function cacheKey(r, c) { return r + ',' + c + ',' + pathCount + ',' + (quadMode ? 'Q' : 'q'); }
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
                        const key = s.rows + ',' + s.cols + ',' + respCount + ',' + (respQuad ? 'Q' : 'q');
                        preGenCache.set(key, s);
                        preGenSize = null;
                        fillPreGenQueue();
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
        function requestBuild(rows, cols) {
            const w = ensureWorker();
            if (!w) return false;
            preGenSize = { rows: rows, cols: cols, pathCount: pathCount, quadMode: quadMode };
            preGenStartTime = Date.now();
            w.postMessage({
                type: 'generate', rows: rows, cols: cols,
                pathCount: pathCount, quadMode: quadMode
            });
            return true;
        }
        // Walk PREGEN_LOOKAHEAD progression steps ahead and queue the first
        // size that's neither cached nor currently being built. Worker can
        // only do one at a time, so this is called both after each puzzle
        // is shown AND after each worker response — chains the queue.
        function fillPreGenQueue() {
            if (!ensureWorker()) return;
            if (preGenSize) return;
            let r = Maze.ROWS, c = Maze.COLS;
            for (let i = 0; i < PREGEN_LOOKAHEAD; i++) {
                const next = nextSize(r, c);
                r = next.rows; c = next.cols;
                if (!preGenCache.has(cacheKey(r, c))) {
                    requestBuild(r, c);
                    return;
                }
            }
        }
        function invalidatePreGen() {
            preGenCache.clear();
        }
        function waitForPreGen(rows, cols) {
            return new Promise(function (resolve) {
                const k = cacheKey(rows, cols);
                const check = function () {
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
                quadScramble: s.quadScramble ? s.quadScramble.map((row) => row.slice()) : null
            };
        }
        function startRecording() {
            recording = {
                startTime: 0,                      // set lazily on first move
                quadMode: !!Maze.quadMode,
                pathCount: Maze.pathCount,
                initialState: deepCloneSnapshot(Maze.snapshotState()),
                moves: []
            };
        }
        function recordMove(move) {
            if (!recording || isReplaying) return;
            // Anchor timestamps to the player's FIRST move, not the puzzle's
            // build time. Otherwise pre-play idle time (worker generation,
            // user reading the puzzle) inflates t-offsets and replay waits
            // the same dead time before applying the first move. Also matches
            // the leaderboard semantics — solve time starts at first action.
            if (recording.moves.length === 0) recording.startTime = Date.now();
            move.t = Date.now() - recording.startTime;
            recording.moves.push(move);
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

        function refresh() {
            Render.draw();
            const justWon = Maze.won && !lastWon;
            if (justWon) {
                if (typeof Marathon !== 'undefined' && Marathon.isPlaying()) {
                    // Marathon owns progression — score the solve and queue
                    // the next (larger) puzzle. Banner stays hidden in game mode.
                    Marathon.onSolve();
                } else {
                    banner.classList.add('visible');
                    if (replayBtn && recording && !isReplaying) replayBtn.hidden = false;
                }
            } else if (!Maze.won && lastWon) {
                banner.classList.remove('visible');
            }
            lastWon = Maze.won;
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
            }
        }
        async function replay() {
            if (!recording || isReplaying) return;
            isReplaying = true;
            replayCancelled = false;
            replayBtn.disabled = true;
            // Restore the initial scrambled state.
            Maze.loadSnapshot(deepCloneSnapshot(recording.initialState));
            Render.draw();
            // Schedule each move at its recorded offset, paced from now.
            const start = Date.now();
            for (const move of recording.moves) {
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
                applyReplayMove(move);
                Render.draw();
                if (Maze.won) banner.classList.add('visible');
            }
            isReplaying = false;
            replayCancelled = false;
            replayBtn.disabled = false;
        }
        if (replayBtn) replayBtn.addEventListener('click', replay);

        async function newPuzzle(rows, cols) {
            // Bail out of any in-progress replay BEFORE the isBuilding gate
            // — the user clicking "next puzzle" mid-replay should always
            // abort the playback even if a build is somehow already pending.
            cancelReplay();
            if (isBuilding) return;
            isBuilding = true;
            banner.classList.remove('visible');

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
                Maze.loadSnapshot(cached);
                preGenCache.delete(wantKey);
            } else if (!ensureWorker()) {
                // Worker unavailable (file:// origin or unsupported browser).
                // Build directly on the main thread; banner after 500ms.
                if (wantResize) invalidatePreGen();
                const bannerTimer = setTimeout(function () {
                    buildingBanner.classList.add('visible');
                }, 500);
                await Maze.init();
                clearTimeout(bannerTimer);
                buildingBanner.classList.remove('visible');
            } else {
                // Cache miss. Two sub-cases:
                //   inFlight=true  → worker is already building exactly
                //     what we want. Send 'hurry' so it ships best-so-far
                //     instead of finishing the strict canonical search.
                //   inFlight=false → genuine fresh build (initial load,
                //     dim change, or worker is on a different size);
                //     start a request for our dims.
                // Banner shows "Loading…" or "Building puzzle…" only if
                // the wait exceeds 500ms.
                if (wantResize) invalidatePreGen();
                const inFlight = preGenSize
                    && preGenSize.rows === wantR
                    && preGenSize.cols === wantC
                    && preGenSize.pathCount === pathCount
                    && preGenSize.quadMode === quadMode;
                if (!inFlight) {
                    requestBuild(wantR, wantC);
                } else if (worker) {
                    worker.postMessage({ type: 'hurry' });
                }
                const bannerTimer = setTimeout(function () {
                    buildingBanner.textContent = inFlight ? 'Loading…' : 'Building puzzle…';
                    buildingBanner.classList.add('visible');
                }, 500);
                await waitForPreGen(wantR, wantC);
                clearTimeout(bannerTimer);
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
            lastWon = Maze.won;
            // Start a fresh recording for the new puzzle. Hide any leftover
            // replay button from the previous puzzle.
            startRecording();
            if (replayBtn) replayBtn.hidden = true;
            refresh();

            // Refill the lookahead cache (queues the next missing size).
            fillPreGenQueue();
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
            get recording() { return recording; }   // debug/test access
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
                    if (pathCount !== opts.pathCount || quadMode !== opts.quadMode) {
                        pathCount = opts.pathCount;
                        quadMode  = opts.quadMode;
                        Maze.setPathCount(pathCount);
                        Maze.setQuadMode(quadMode);
                        invalidatePreGen();
                        preGenSize = null;
                        Render.refit();
                    }
                    await newPuzzle(opts.rows, opts.cols);
                    Marathon.onPuzzleReady();
                },
                // Cancel any in-flight visual state when the player abandons
                // a game or time expires — leaves the engine in a sane idle.
                quit: function () {
                    cancelReplay();
                    if (banner) banner.classList.remove('visible');
                }
            });
        }

        // Click / tap → rotate the tile under the pointer. Tap rotates CW
        // (the natural single-input default). Mouse buttons swap that pairing
        // so the secondary button matches the touch default: LEFT-click is
        // CCW, RIGHT-click is CW.
        function handlePointer(ev, ccw) {
            if (isBuilding || isReplaying) return;
            // Marathon between-puzzles state: any tap advances instead of
            // rotating a tile (the player has already won; rotating now would
            // break the gold path they're looking at).
            if (typeof Marathon !== 'undefined' && Marathon.isInTransition()) {
                Marathon.advance();
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const x = (ev.clientX !== undefined ? ev.clientX : ev.touches[0].clientX) - rect.left;
            const y = (ev.clientY !== undefined ? ev.clientY : ev.touches[0].clientY) - rect.top;
            const cell = Render.cellAt(x, y);
            if (!cell) return;
            const ok = Maze.rotate(cell.row, cell.col, ccw);
            if (ok) {
                recordMove({ type: 'rotate', r: cell.row, c: cell.col, ccw: !!ccw });
                Render.animateRotationAt(cell.row, cell.col, ccw);
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

        function clearPress() {
            if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
        }
        function startPress(canvasX, canvasY) {
            clearPress();
            longPressFired = false;
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
        if (isDebugMode) {
            // 'N' for a new puzzle
            window.addEventListener('keydown', (ev) => {
                if (ev.key === 'n' || ev.key === 'N') newPuzzle();
            });
            // Click the win banner to start a new puzzle
            banner.addEventListener('click', () => { newPuzzle(); });
        }

        // Hint: snap a random unsolved path tile to its solution and lock it red
        const hintBtn = document.getElementById('hintBtn');
        if (hintBtn) {
            hintBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (isBuilding) return;
                // Don't run hint during the between-puzzles transition; the
                // player's already won, hint would just lock a tile on a
                // puzzle they're about to leave behind. Treat it as a no-op.
                if (typeof Marathon !== 'undefined' && Marathon.isInTransition()) return;
                const pick = Maze.hint();
                if (pick) {
                    recordMove({ type: 'hint', r: pick.r, c: pick.c });
                    // Hint always rotates CW (applyHintAt advances rotation
                    // toward the solution by `turns` 90° steps). Skip the
                    // animation when turns=0 (tile was already at solution).
                    if (pick.turns > 0) Render.animateRotationAt(pick.r, pick.c, false, pick.turns);
                    // Marathon penalty — only when actually playing (not in
                    // debug or between puzzles). Marathon.onHintUsed handles
                    // the timer cut and the visual feedback.
                    if (typeof Marathon !== 'undefined' && Marathon.isPlaying()) {
                        Marathon.onHintUsed();
                    }
                }
                refresh();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
