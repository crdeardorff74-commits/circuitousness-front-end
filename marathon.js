/**
 * Circuitousness — Marathon mode
 *
 * Top-level UI/state machine layered on top of the puzzle engine. Owns the
 * menu, in-game HUD (type / level / timer / score), game-over flow, and
 * local-only leaderboards (8 boards, one per game type).
 *
 * Game flow:
 *   MENU → user picks mode →
 *   PLAYING (timer counts down, puzzle progressively grows) →
 *   on solve: carry remaining time forward (capped), build next bigger puzzle →
 *   on timer expire: GAME_OVER → optional save to leaderboard → MENU
 *
 * Scoring: rank by puzzles solved, with total solve time as tiebreaker
 * (lower is better). Storage: localStorage[PROJECT_SLUG + '_lb_<type>'].
 *
 * Hooks game.js provides via init({ startPuzzle, quit }):
 *   startPuzzle({ rows, cols, pathCount, quadMode }) — build & display
 *   quit() — abandon current build/puzzle, ready for menu
 *
 * Hooks game.js calls into Marathon:
 *   Marathon.onPuzzleReady() — puzzle is on-screen, start the per-puzzle clock
 *   Marathon.onSolve()       — Maze.won just transitioned to true
 */
const Marathon = (() => {
    const STATE = {
        MENU:        'menu',
        PLAYING:     'playing',
        GAME_OVER:   'gameOver',
        LEADERBOARD: 'leaderboard',
        REPLAYING:   'replaying'   // watching another player's recording from a leaderboard entry
    };

    let state          = STATE.MENU;
    let activeType     = null;     // 's1'..'s4', 'q1'..'q4'
    let sessionToken   = null;     // server-issued cheat-proof timing token (from /api/game/start)
    let level          = 0;        // current puzzle index, 1-based
    let solvedCount    = 0;
    // Per-game growth sequence: one entry per "level transition" (so
    // growthSequence[0] is the choice between puzzle 1 and puzzle 2,
    // growthSequence[1] between 2 and 3, etc). Each entry is 'r' (row
    // grows) or 'c' (col grows). Rolled lazily — `ensureGrowthSequence(N)`
    // extends the array up to index N-1 with fresh 50/50 picks. Reset on
    // startGame() so each new game gets a fresh sequence. Lazy + append-
    // only means pre-gen's lookahead calls pin the upcoming choices, and
    // any later call for the same level returns the same dims.
    let growthSequence = [];
    let totalSolveTime = 0;        // ms — sum of (now - puzzleStartTimeMs) per solved puzzle
    let timeRemaining  = 0;        // ms — single carry-over pool, ticks down during PLAYING
    let lastTickTime   = 0;        // ms epoch — for delta-based timer
    let timerHandle    = null;
    let puzzleStartMs  = 0;        // ms epoch when current puzzle finished building

    // Per-game accumulated recordings. Each entry is a deep clone of
    // Game.recording captured in onSolve() right before the next puzzle
    // overwrites it. Shipped with the score submission so the run can
    // be replayed from any leaderboard view.
    let recordings = [];

    let callbacks = null;

    // DOM refs (populated in init)
    let menuEl, hudEl, gameOverEl, leaderboardEl, solveTransitionEl, replayHudEl;
    let hudType, hudLevel, hudTimer, hudQuit;
    let solveHeadline, solveBanked;
    let gameOverScore, gameOverTime, gameOverRank, gameOverName, gameOverSave, gameOverMenu, gameOverNameRow;
    let leaderboardSelect, leaderboardEntries, leaderboardEmpty, leaderboardClose, menuLeaderboardBtn;
    let replayLabel, replayStopBtn;

    // After a save, the leaderboard view marks the player's just-saved entry
    // with .lbHighlight so they can find it at a glance. Set by saveScore
    // before transitioning to the leaderboard; cleared on goToMenu and at
    // game start. Match by id (server-saved) OR by name+solved+totalMs
    // (local-only fallback when the server submit failed).
    let pendingHighlight = null;

    // Inter-puzzle transition: blocks repeat-onSolve and gates input. Player
    // taps the popup to advance (no auto-timeout) so they have time to read
    // the banked message. Canvas taps are intentionally NOT a route — they're
    // swallowed by game.js handlePointer when isInTransition() — because the
    // click-cascade from mashing through the solve would otherwise skip the
    // transition before the player registers the win.
    let inTransition = false;
    // Click-quiet gate: advance() ignores taps until Date.now() >= this.
    // Each tap (including ignored ones) pushes it out by TRANSITION_QUIET_MS,
    // so a click-cascade from solving by mashing can't skip the transition.
    const TRANSITION_QUIET_MS = 1000;
    let transitionQuietUntil = 0;

    function $(id) { return document.getElementById(id); }

    function init(cbs) {
        callbacks = cbs || {};

        menuEl             = $('menu');
        hudEl              = $('hud');
        gameOverEl         = $('gameOver');
        leaderboardEl      = $('leaderboard');
        solveTransitionEl  = $('solveTransition');
        replayHudEl        = $('replayHud');

        hudType  = $('hudType');
        hudLevel = $('hudLevel');
        hudTimer = $('hudTimer');
        hudQuit  = $('hudQuitBtn');

        solveHeadline = $('solveHeadline');
        solveBanked   = $('solveBanked');

        gameOverScore   = $('gameOverScore');
        gameOverTime    = $('gameOverTime');
        gameOverRank    = $('gameOverRank');
        gameOverName    = $('gameOverName');
        gameOverSave    = $('gameOverSaveBtn');
        gameOverMenu    = $('gameOverMenuBtn');
        gameOverNameRow = gameOverEl ? gameOverEl.querySelector('.gameOverNameRow') : null;

        leaderboardSelect  = $('leaderboardSelect');
        leaderboardEntries = $('leaderboardEntries');
        leaderboardEmpty   = $('leaderboardEmpty');
        leaderboardClose   = $('leaderboardCloseBtn');
        menuLeaderboardBtn = $('menuLeaderboardBtn');

        replayLabel   = $('replayLabel');
        replayStopBtn = $('replayStopBtn');

        // Wire mode buttons + populate thumbnails. Thumbnail filenames are
        // {1 or 4}x{pathCount}.png — the leading 1/4 is the grid-base
        // (regular vs quad), the trailing digit is the path count.
        document.querySelectorAll('.menuModeBtn').forEach((btn) => {
            const mode = btn.getAttribute('data-mode');
            const thumb = btn.querySelector('img.modeThumb');
            if (thumb && typeof THUMBNAIL_URL_BASE === 'string') {
                const base  = mode[0] === 'q' ? '4' : '1';
                const paths = mode[1];
                thumb.src = THUMBNAIL_URL_BASE + base + 'x' + paths + '.png';
            }
            // Click delegates to Potd when the mode picker says so,
            // otherwise marathon owns the click (legacy default). Both
            // modules use the same .menuModeBtn buttons.
            btn.addEventListener('click', () => {
                const pickedMode = (typeof ModePicker !== 'undefined' && ModePicker.getMode)
                    ? ModePicker.getMode()
                    : 'marathon';
                if (pickedMode === 'potd' && typeof Potd !== 'undefined' && Potd.startPuzzle) {
                    Potd.startPuzzle(mode);
                } else {
                    startGame(mode);
                }
            });
        });
        if (menuLeaderboardBtn) menuLeaderboardBtn.addEventListener('click', showLeaderboard);
        if (hudQuit)            hudQuit.addEventListener('click', quitToMenu);
        if (gameOverSave)       gameOverSave.addEventListener('click', saveScore);
        if (gameOverMenu)       gameOverMenu.addEventListener('click', goToMenu);
        if (gameOverName)       gameOverName.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') saveScore();
        });
        if (leaderboardClose)   leaderboardClose.addEventListener('click', goToMenu);
        if (leaderboardSelect)  leaderboardSelect.addEventListener('change', renderLeaderboard);
        if (replayStopBtn)      replayStopBtn.addEventListener('click', stopReplay);
        // Tap the popup to advance to the next puzzle. The canvas does NOT
        // route here — see comment on the inTransition declaration above.
        if (solveTransitionEl)  solveTransitionEl.addEventListener('click', advance);

        // Populate the leaderboard mode dropdown — one option per game type.
        if (leaderboardSelect) {
            for (const t of MARATHON.TYPES) {
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = I18n.t('marathon.mode' + t.toUpperCase());
                leaderboardSelect.appendChild(opt);
            }
        }

        // Paint the maze-O canvas in the menu title. Re-paints on resize
        // because the canvas's CSS size scales with viewport (clamped font).
        const titleCanvas = $('titleOCanvas');
        function paintTitleO() {
            if (!titleCanvas || typeof TitleRenderer === 'undefined') return;
            const rect = titleCanvas.getBoundingClientRect();
            const size = Math.max(24, Math.min(rect.width, rect.height));
            if (size > 0) TitleRenderer.draw(titleCanvas, size);
        }
        // Initial paint after layout settles. The double rAF gives the font
        // a chance to load and reflow the title's em-size before we measure.
        requestAnimationFrame(() => { paintTitleO(); requestAnimationFrame(paintTitleO); });
        let titleOResizeQueued = false;
        window.addEventListener('resize', () => {
            if (titleOResizeQueued) return;
            titleOResizeQueued = true;
            requestAnimationFrame(() => { titleOResizeQueued = false; paintTitleO(); });
        });
        // Re-paint once the Anton font is fully loaded (its line-box may shift
        // the canvas to a new size that the rAF measurements miss).
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(paintTitleO);
        }

        goToMenu();
    }

    function showOnly(...els) {
        const set = new Set(els);
        [menuEl, hudEl, gameOverEl, leaderboardEl, replayHudEl].forEach((el) => {
            if (!el) return;
            el.classList.toggle('visible', set.has(el));
        });
    }

    function clearTransition() {
        inTransition = false;
        transitionQuietUntil = 0;
        if (solveTransitionEl) solveTransitionEl.classList.remove('visible');
    }

    // Player tapped during the inter-puzzle transition — proceed to the next
    // puzzle. No-op if not currently transitioning, so accidental rapid clicks
    // after the next puzzle loads don't cascade into double-advances. Also
    // absorbs taps that arrive inside the quiet window so a click-cascade
    // from mashing through the solve can't skip the transition; every tap
    // resets the window, so the player has to actually pause before
    // advancing.
    function advance() {
        if (!inTransition) return;
        if (state !== STATE.PLAYING) return;
        const now = Date.now();
        if (now < transitionQuietUntil) {
            transitionQuietUntil = now + TRANSITION_QUIET_MS;
            return;
        }
        clearTransition();
        startNextPuzzle();
    }

    function goToMenu() {
        // Bail out of an in-flight replay before changing state. Game's
        // own isReplaying flag stays true until the async loop wakes up,
        // sees the flag, and exits — that's fine because we'll be on the
        // menu before the next paint anyway.
        if (state === STATE.REPLAYING && typeof Game !== 'undefined' && Game.cancelReplay) {
            Game.cancelReplay();
        }
        state = STATE.MENU;
        stopTimer();
        clearTransition();
        pendingHighlight = null;   // leaving the leaderboard drops the highlight
        showOnly(menuEl);
    }

    function showLeaderboard() {
        state = STATE.LEADERBOARD;
        renderLeaderboard();
        showOnly(leaderboardEl);
    }

    // ----- Game flow -----

    // 's3' → { quadMode: false, pathCount: 3 }, 'q1' → { quadMode: true, pathCount: 1 }
    function decodeType(t) {
        return { quadMode: t[0] === 'q', pathCount: parseInt(t[1], 10) };
    }

    // Logical dims for puzzle N (1-based). Returns { rows, cols }.
    // Step pattern (period 4 starting at level 2): cols, rows, rows, cols.
    // Equivalent rule for level L≥2: rows grows when L%4 ∈ {3, 0}, else cols.
    // Same pattern for regular and quad — quad just starts smaller (6×6 vs
    // 8×8) since each step adds 2× sub-tiles per axis. No upper cap.
    function ensureGrowthSequence(lev) {
        // Number of transitions needed = lev - 1 (transition index = level - 2).
        while (growthSequence.length < lev - 1) {
            growthSequence.push(Math.random() < 0.5 ? 'r' : 'c');
        }
    }
    function dimsForLevel(lev, quadMode) {
        const minDim = quadMode ? MARATHON.MIN_DIM_QUAD : MARATHON.MIN_DIM_SINGULAR;
        ensureGrowthSequence(lev);
        let rowGrowth = 0, colGrowth = 0;
        for (let i = 0; i < lev - 1; i++) {
            if (growthSequence[i] === 'r') rowGrowth++;
            else                           colGrowth++;
        }
        return {
            rows: minDim + rowGrowth,
            cols: minDim + colGrowth
        };
    }

    // Game-side pre-gen lookahead. game.js's own `nextSize` produces a
    // DIFFERENT 4×4→5×4→5×5 progression than Marathon's row/col growth
    // cycle — without this hook the pre-gen worker builds sizes Marathon
    // never asks for, every advance misses the cache, and the player sees
    // "Building puzzle…" between every level. game.js calls this when
    // Marathon is the active state machine.
    //
    // Returns PHYSICAL dims (×2 in quad mode) so game.js's cacheKey
    // matches the wantR/wantC it passes to newPuzzle.
    function upcomingDims(count) {
        if (state !== STATE.PLAYING) return [];
        const decoded = decodeType(activeType);
        const out = [];
        for (let i = 1; i <= count; i++) {
            const logical  = dimsForLevel(level + i, decoded.quadMode);
            const physRows = decoded.quadMode ? logical.rows * 2 : logical.rows;
            const physCols = decoded.quadMode ? logical.cols * 2 : logical.cols;
            out.push({ rows: physRows, cols: physCols });
        }
        return out;
    }

    // Per-puzzle fresh allotment under the difficulty-ramp model: starts at
    // MARATHON.START_TIME_*[pathCount-1] and shaves TIME_DECREASE_PER_SOLVE
    // seconds for every prior solve, floored at TIME_FLOOR. Independent of
    // grid size — puzzle time is purely a function of mode + path count +
    // solvedCount. Banking is unlimited; the caller just adds the result
    // to timeRemaining with no cap.
    function timeForPuzzle(quadMode, pathCount, solvedCount) {
        const starts = quadMode ? MARATHON.START_TIME_QUAD : MARATHON.START_TIME_SINGULAR;
        const idx    = Math.max(0, Math.min(starts.length - 1, (pathCount | 0) - 1));
        const start  = starts[idx];
        const fresh  = Math.max(MARATHON.TIME_FLOOR, start - solvedCount * MARATHON.TIME_DECREASE_PER_SOLVE);
        return fresh * 1000;
    }

    function startGame(type) {
        activeType       = type;
        sessionToken     = null;  // cleared until /api/game/start resolves
        level            = 0;
        solvedCount      = 0;
        totalSolveTime   = 0;
        timeRemaining    = 0;     // first puzzle gets only its fresh allotment, no carry-over
        recordings       = [];    // fresh recording buffer for this game
        pendingHighlight = null;  // any prior-game highlight is stale once a new run begins
        growthSequence   = [];    // fresh random row/col growth sequence per game
        if (typeof Music !== 'undefined' && Music.start) Music.start();
        // Fire-and-forget: ask the server for a cheat-proof timing token.
        // Game continues regardless — if the request fails (offline / cold
        // back-end / network blip) we stay with sessionToken=null and the
        // submit will fall through to the local-fallback path with no
        // public leaderboard entry. Better than blocking play on a flaky
        // request, and the front-end already handles local-only saves.
        requestSessionToken(type);
        startNextPuzzle();
    }

    async function requestSessionToken(type) {
        const base = apiBase();
        if (!base) return;
        const sentForType = type;
        try {
            const resp = await fetch(base + '/game/start', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ type: type, sessionId: getSessionId() })
            });
            if (!resp.ok) return;
            const data = await resp.json();
            // Defensive: if the player has already quit/started another
            // game by the time the response lands, don't clobber the
            // newer activeType's token slot.
            if (activeType !== sentForType) return;
            if (data && typeof data.sessionToken === 'string') {
                sessionToken = data.sessionToken;
            }
        } catch (e) {
            // Stays null; submit falls to local fallback. Logged for ops.
            if (typeof Logger !== 'undefined') Logger.warn('Marathon: /game/start failed', e);
        }
    }

    function startNextPuzzle() {
        // Pause the clock during the build — would otherwise eat into the
        // player's allotment for the puzzle they can't even see yet.
        // Restarts in onPuzzleReady once the new puzzle is on-screen.
        stopTimer();

        level++;
        const decoded   = decodeType(activeType);
        const logical   = dimsForLevel(level, decoded.quadMode);
        const physRows  = decoded.quadMode ? logical.rows * 2 : logical.rows;
        const physCols  = decoded.quadMode ? logical.cols * 2 : logical.cols;

        // Carry-over + fresh allotment. solvedCount = (level - 1) here
        // (incremented in onSolve before the player advances). No cap —
        // unlimited banking, so the running total just grows.
        const fresh = timeForPuzzle(decoded.quadMode, decoded.pathCount, solvedCount);
        timeRemaining = timeRemaining + fresh;

        state = STATE.PLAYING;
        showOnly(hudEl);
        updateHud(logical);

        if (callbacks.startPuzzle) {
            callbacks.startPuzzle({
                rows:      physRows,
                cols:      physCols,
                pathCount: decoded.pathCount,
                quadMode:  decoded.quadMode
            });
        }
        // Timer starts when puzzle is actually on-screen (onPuzzleReady).
    }

    // Called from game.js once newPuzzle's worker build has loaded a snapshot
    // and the puzzle is visible. Anchors the per-puzzle clock and starts the
    // countdown so build time isn't deducted from the player's allotment.
    function onPuzzleReady() {
        if (state !== STATE.PLAYING) return;
        puzzleStartMs = Date.now();
        startTimer();
        if (typeof Sfx !== 'undefined') Sfx.play('cinematic_bass');
        // Background shuffle has already fired at the START of the build
        // (in game.js startPuzzle callback) so the new image is visible
        // throughout the "Building puzzle…" wait — not after it.
    }

    function startTimer() {
        stopTimer();
        lastTickTime = Date.now();
        timerHandle = setInterval(tick, 100);
        renderTimer();
    }

    function stopTimer() {
        if (timerHandle !== null) { clearInterval(timerHandle); timerHandle = null; }
    }

    function tick() {
        const now = Date.now();
        timeRemaining -= (now - lastTickTime);
        lastTickTime = now;
        if (timeRemaining <= 0) {
            timeRemaining = 0;
            renderTimer();
            gameOver();
            return;
        }
        renderTimer();
    }

    // Hint penalty: lop MARATHON.HINT_PENALTY_FRACTION off the remaining time
    // (e.g. 0.25 → keep 75%) FLOORED at MARATHON.HINT_PENALTY_MIN_MS so the
    // cost stays meaningful as the timer winds down — otherwise the
    // fractional penalty trends to zero and hints become free. Plays a
    // shake/flash + floating "−Xs" indicator on the HUD timer so the cost
    // is unmissable. No-op if a transition is in flight or we're not playing.
    function onHintUsed() {
        if (state !== STATE.PLAYING || inTransition) return;
        const fractionalMs = timeRemaining * MARATHON.HINT_PENALTY_FRACTION;
        const penaltyMs    = Math.max(MARATHON.HINT_PENALTY_MIN_MS, fractionalMs);
        timeRemaining -= penaltyMs;
        if (timeRemaining < 0) timeRemaining = 0;
        renderTimer();

        if (!hudTimer) return;
        // Re-trigger the keyframe animation by removing + reflowing + re-adding.
        hudTimer.classList.remove('penalty');
        // Force reflow so the next class add restarts the animation.
        void hudTimer.offsetWidth;
        hudTimer.classList.add('penalty');

        const float = document.createElement('span');
        float.className = 'timerPenaltyFloat';
        float.textContent = '−' + Math.ceil(penaltyMs / 1000) + 's';
        hudTimer.appendChild(float);
        // Match the CSS keyframe duration (1.1s); a small buffer guards
        // against animation events not firing (e.g. tab backgrounded).
        setTimeout(() => { if (float.parentNode) float.remove(); }, 1200);
    }

    function onSolve() {
        if (state !== STATE.PLAYING) return;
        if (inTransition) return;     // refresh() can fire again on a re-rotate after the win
        inTransition = true;
        transitionQuietUntil = Date.now() + TRANSITION_QUIET_MS;
        stopTimer();
        if (typeof Sfx !== 'undefined') {
            Sfx.stopLoop('glitch_overlap');  // any lingering overlap-loop dies with the win
            Sfx.play('applause_long');
        }

        // Capture the just-solved puzzle's recording before the next
        // puzzle's startRecording() overwrites Game.recording. JSON
        // round-trip is a cheap deep clone that also strips functions
        // and `undefined` — everything we need to ship is plain data.
        if (typeof Game !== 'undefined' && Game.recording) {
            try { recordings.push(JSON.parse(JSON.stringify(Game.recording))); }
            catch (e) { Logger.warn('Marathon: failed to clone recording', e); }
        }

        const elapsed = Date.now() - puzzleStartMs;
        totalSolveTime += elapsed;
        solvedCount++;

        // Project the next puzzle's starting clock for the transition popup.
        // solvedCount was just incremented above, so it already reflects
        // the "puzzles solved BEFORE the next one starts" count that
        // timeForPuzzle wants. No cap on banking — all of leftover carries.
        const decoded   = decodeType(activeType);
        const fresh     = timeForPuzzle(decoded.quadMode, decoded.pathCount, solvedCount);
        const nextStart = timeRemaining + fresh;
        const bankedMs  = timeRemaining;

        // Build + show the transition popup. Headline names the puzzle that
        // was just solved; subline tells the player what they're carrying
        // into the next puzzle.
        if (solveTransitionEl && solveHeadline && solveBanked) {
            solveHeadline.textContent = I18n.t('marathon.solveHeadline', { n: level });
            const tStr = fmtTime(nextStart);
            const bSec = Math.floor(bankedMs / 1000);
            if (bSec > 0) {
                solveBanked.textContent = I18n.t('marathon.solveBankedFull', { b: bSec, t: tStr });
            } else {
                solveBanked.textContent = I18n.t('marathon.solveBankedZero', { t: tStr });
            }
            solveTransitionEl.classList.add('visible');
        }

        // No auto-timeout — player taps (popup or canvas) to call advance().
    }

    function gameOver() {
        state = STATE.GAME_OVER;
        stopTimer();
        clearTransition();
        if (callbacks.quit) callbacks.quit();
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        // Zero-solve game-overs aren't eligible to rank, so fire the
        // "no rank" SFX immediately. For non-zero scores we wait for
        // the leaderboard fetch in renderGameOver — the right SFX
        // depends on the rank.
        if (typeof Sfx !== 'undefined') {
            Sfx.stopLoop('glitch_overlap');
            if (solvedCount === 0) {
                Sfx.play(['fail_long', 'audience_boo', 'audience_disappointed']);
            }
        }
        renderGameOver();
        showOnly(gameOverEl);
    }

    function quitToMenu() {
        clearTransition();
        if (callbacks.quit) callbacks.quit();
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        goToMenu();
    }

    // ----- Rendering -----

    function fmtTime(ms) {
        // Round UP so the timer never reads "0:00" while there's still time.
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60), s = total % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function fmtTimePrecise(ms) {
        // For elapsed totals — round DOWN.
        const total = Math.max(0, Math.floor(ms / 1000));
        const m = Math.floor(total / 60), s = total % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function updateHud(logical) {
        if (!hudType) return;
        hudType.textContent  = I18n.t('marathon.mode' + activeType.toUpperCase());
        hudLevel.textContent = I18n.t('marathon.hudLevel', { n: level, r: logical.rows, c: logical.cols });
        renderTimer();
    }

    function renderTimer() {
        if (!hudTimer) return;
        // Update only the inner value span — leaves any floating "−Xs"
        // penalty indicator (a sibling child of hudTimer) intact across ticks.
        const valEl = hudTimer.querySelector('.hudTimerVal');
        if (valEl) valEl.textContent = fmtTime(timeRemaining);
        hudTimer.classList.toggle('urgent', timeRemaining < 10000);
    }

    async function renderGameOver() {
        gameOverScore.textContent = I18n.t('marathon.solvedCount', { n: solvedCount, s: solvedCount === 1 ? '' : 's' });
        gameOverTime.textContent  = I18n.t('marathon.totalTime', { t: fmtTimePrecise(totalSolveTime) });
        gameOverRank.textContent  = '';
        gameOverRank.hidden       = true;
        gameOverName.value        = '';
        gameOverSave.disabled     = true;
        gameOverSave.textContent  = I18n.t('marathon.save');

        // Zero score → never eligible to save. Hide the name row up-front
        // (per universal rule 7a) and bail without contacting the server.
        if (solvedCount === 0) {
            if (gameOverNameRow) gameOverNameRow.hidden = true;
            return;
        }

        // Hide until we know whether the score ranks. Re-shown below if eligible.
        if (gameOverNameRow) gameOverNameRow.hidden = true;

        // Refresh the leaderboard from the server so the rank is accurate.
        // Fall back to local cache on timeout/failure (offline). 4 s cap so
        // a hung connection never blocks the game-over screen forever.
        let board = loadBoard(activeType);
        try {
            const fresh = await Promise.race([
                fetchBoardFromServer(activeType),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
            ]);
            saveBoard(activeType, fresh);
            board = fresh;
        } catch (e) {
            // Stick with the cached board — may be stale but it's our best guess.
        }

        // User may have navigated away while the fetch was in flight.
        if (state !== STATE.GAME_OVER) return;

        const rank = computeRank(board, solvedCount, totalSolveTime);
        if (rank <= MARATHON.LEADERBOARD_TOP_N) {
            gameOverRank.textContent = I18n.t('marathon.newBest', { r: rank });
            gameOverRank.hidden = false;
            if (gameOverNameRow) gameOverNameRow.hidden = false;
            gameOverSave.disabled = false;
            // Pre-fill the name field with the player's last-submitted name
            // (universal rule 7a). Mirrors TANTЯO's behavior so returning
            // players don't have to retype every session. localStorage can
            // throw in private mode or when quota is exceeded — fail open.
            if (gameOverName && typeof PROJECT_SLUG === 'string') {
                try {
                    const last = localStorage.getItem(PROJECT_SLUG + '_lastPlayerName');
                    if (last) gameOverName.value = last;
                } catch (e) { /* localStorage unavailable */ }
            }
            // Drop the cursor straight into the name field so the player
            // can type without an intermediate click. Wrapped in try because
            // focus() can throw if the element was already detached (e.g.
            // user navigated away while the leaderboard fetch was in flight).
            if (gameOverName) {
                try { gameOverName.focus(); } catch (e) {}
            }
            if (typeof Sfx !== 'undefined') {
                Sfx.play(rank === 1 ? 'audience_cheer_long' : 'audience_cheer');
            }
        } else if (typeof Sfx !== 'undefined') {
            // Ineligible: same SFX as the zero-solve path. Leaves the row
            // hidden / no rank text — the player still sees score + time.
            Sfx.play(['fail_long', 'audience_boo', 'audience_disappointed']);
        }
    }

    // ----- Leaderboard storage -----
    //
    // Server-primary with local fallback. Submissions try the API; on failure
    // they save to localStorage (so the player still sees their score on this
    // device) AND get queued for retry on the next successful submission.
    // Reads paint the local cache first for instant UX, then refresh from the
    // server in the background.

    function boardKey(type)  { return PROJECT_SLUG + '_lb_' + type; }
    function pendingKey()    { return PROJECT_SLUG + '_lb_pending'; }
    function sessionIdKey()  { return PROJECT_SLUG + '_session_id'; }
    function ownRecKey(type) { return PROJECT_SLUG + '_own_rec_' + type; }

    // Stash the player's just-saved recording locally, keyed by the server's
    // score id. The painter cross-references this so the Watch button works
    // even when the server doesn't surface events on its top-N (older
    // back-end without the `hasRecording` field, payload dropped, etc).
    // One slot per game type — overwritten on each successful save.
    function saveOwnRecording(type, id, events) {
        try {
            localStorage.setItem(ownRecKey(type), JSON.stringify({ id: id, events: events }));
        } catch (e) { Logger.warn('Marathon: failed to store own recording', e); }
    }
    function loadOwnRecording(type) {
        try {
            const raw = localStorage.getItem(ownRecKey(type));
            if (!raw) return null;
            const data = JSON.parse(raw);
            return (data && Array.isArray(data.events)) ? data : null;
        } catch (e) { return null; }
    }

    function loadBoard(type) {
        try {
            const raw = localStorage.getItem(boardKey(type));
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
    }
    function saveBoard(type, board) {
        try { localStorage.setItem(boardKey(type), JSON.stringify(board)); }
        catch (e) { Logger.warn('Marathon: failed to save leaderboard', e); }
    }

    function loadPending() {
        try {
            const raw = localStorage.getItem(pendingKey());
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
    }
    function savePending(arr) {
        try { localStorage.setItem(pendingKey(), JSON.stringify(arr)); }
        catch (e) {}
    }

    // Per-browser ID for server-side abuse forensics (NOT auth). Lazy,
    // persisted across sessions. Falls back to an ephemeral ID if
    // localStorage is unavailable (private mode).
    function getSessionId() {
        let id = '';
        try { id = localStorage.getItem(sessionIdKey()) || ''; } catch (e) {}
        if (id) return id;
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
        id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        try { localStorage.setItem(sessionIdKey(), id); } catch (e) {}
        return id;
    }

    // Where would (solved, totalMs) land if added to `board`? 1-based rank.
    function computeRank(board, solved, totalMs) {
        let r = 1;
        for (const e of board) {
            if (e.solved > solved) r++;
            else if (e.solved === solved && e.totalMs < totalMs) r++;
        }
        return r;
    }

    // ----- Server API -----

    function apiBase() {
        return (typeof AppConfig === 'object' && AppConfig && AppConfig.GAME_API) ? AppConfig.GAME_API : '';
    }

    async function submitToServer(payload) {
        const base = apiBase();
        if (!base) throw new Error('No GAME_API configured');
        const resp = await fetch(base + '/scores/submit', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload)
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
    }

    async function fetchBoardFromServer(type) {
        const base = apiBase();
        if (!base) throw new Error('No GAME_API configured');
        const resp = await fetch(base + '/leaderboards/' + encodeURIComponent(type)
                                 + '?limit=' + MARATHON.LEADERBOARD_TOP_N);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        return Array.isArray(data.entries) ? data.entries : [];
    }

    // Drain the pending queue. Anything that still fails is requeued in order.
    async function flushPending() {
        const pending = loadPending();
        if (pending.length === 0) return;
        const remaining = [];
        for (const p of pending) {
            try { await submitToServer(p); }
            catch (e) { remaining.push(p); }
        }
        savePending(remaining);
    }

    function buildPayload(name) {
        return {
            type:          activeType,
            name:          name,
            solved:        solvedCount,
            totalMs:       totalSolveTime,
            clientVersion: (typeof PAGE_VERSION === 'string' ? PAGE_VERSION : ''),
            sessionId:     getSessionId(),
            // Server-issued timing token from /api/game/start. The server
            // rejects submissions without one or with claimed totalMs that
            // exceeds wall-clock since the token was issued. Null when
            // the start request failed (offline play) → server-side
            // submit will reject → front-end falls through to local
            // fallback path, same as a network failure on submit itself.
            sessionToken:  sessionToken,
            // Move history per solved puzzle, in order. Stored server-side
            // so any top-N entry is replayable via /api/scores/<id>/recording.
            events:        recordings
            // seed reserved for future server-side deterministic replay validation.
        };
    }

    async function saveScore() {
        if (state !== STATE.GAME_OVER) return;
        if (solvedCount === 0) return;     // no zero-score entries
        const rawName = (gameOverName.value || '').trim().slice(0, 16);
        const name = rawName || 'Player';

        // Persist the entered name so the next high-score input pre-fills
        // (universal rule 7a). Save BEFORE the server submit so the name
        // sticks even if the player is offline / submission queues for retry.
        // Only persist actual user input — don't write the 'Player' fallback.
        if (rawName && typeof PROJECT_SLUG === 'string') {
            try { localStorage.setItem(PROJECT_SLUG + '_lastPlayerName', rawName); }
            catch (e) { /* localStorage unavailable */ }
        }

        gameOverSave.disabled    = true;
        gameOverSave.textContent = I18n.t('marathon.save') + '…';

        const payload  = buildPayload(name);
        let savedId    = null;

        try {
            await flushPending();          // opportunistically retry earlier failed submissions
            const data = await submitToServer(payload);
            if (Array.isArray(data.top)) saveBoard(activeType, data.top);
            if (typeof data.id === 'number') savedId = data.id;
        } catch (e) {
            Logger.warn('Marathon: score submission failed, queueing for retry', e);
            // Persist locally so the player at least sees their entry on this
            // device, AND queue the payload for retry on the next save attempt.
            // Stash the events too so the Watch button still works offline —
            // without it, local-fallback entries have no `id` to fetch from
            // the server AND no events to replay from disk, so they'd render
            // without a replay affordance even though the player just played
            // them.
            const board = loadBoard(activeType);
            board.push({
                name,
                solved:       solvedCount,
                totalMs:      totalSolveTime,
                date:         Date.now(),
                events:       recordings,
                hasRecording: recordings.length > 0,
            });
            board.sort((a, b) => {
                if (b.solved !== a.solved) return b.solved - a.solved;
                return a.totalMs - b.totalMs;
            });
            if (board.length > MARATHON.LEADERBOARD_TOP_N) board.length = MARATHON.LEADERBOARD_TOP_N;
            saveBoard(activeType, board);

            const pending = loadPending();
            pending.push(payload);
            savePending(pending);
        }

        // Player may have navigated away during the in-flight submit.
        if (state !== STATE.GAME_OVER) return;

        gameOverSave.textContent = I18n.t('marathon.saved');

        // Stash the recording locally for the Watch button to find later —
        // robust against the server not storing/surfacing events itself.
        // Keyed by server id when we have one; local-only saves (catch
        // branch above) already carry events directly on the entry.
        if (savedId !== null && recordings.length > 0) {
            saveOwnRecording(activeType, savedId, recordings);
        }

        // Transition straight to the leaderboard with the player's row
        // highlighted. id-match for server saves; name+solved+totalMs
        // fallback for local-only saves where the entry has no id yet.
        pendingHighlight = (savedId !== null)
            ? { id: savedId }
            : { name: name, solved: solvedCount, totalMs: totalSolveTime };
        if (leaderboardSelect) leaderboardSelect.value = activeType;
        showLeaderboard();
    }

    // Match a leaderboard entry against pendingHighlight. id-match is
    // exact when the server save succeeded; the name+solved+totalMs
    // fallback covers local-only saves (id-less entries).
    function entryMatchesHighlight(entry) {
        if (!pendingHighlight) return false;
        if (pendingHighlight.id != null && entry.id != null) {
            return entry.id === pendingHighlight.id;
        }
        return entry.name    === pendingHighlight.name
            && entry.solved  === pendingHighlight.solved
            && entry.totalMs === pendingHighlight.totalMs;
    }

    function paintLeaderboard(board) {
        leaderboardEntries.innerHTML = '';
        if (board.length === 0) {
            leaderboardEmpty.hidden = false;
            return;
        }
        leaderboardEmpty.hidden = true;
        // Cross-reference for the player's own recording — keyed by score
        // id. Lets the Watch button work on the player's own entry even
        // when the server doesn't return events on this entry.
        const boardType    = (leaderboardSelect && leaderboardSelect.value) || MARATHON.TYPES[0];
        const ownRecording = loadOwnRecording(boardType);
        let highlightedEl = null;
        board.forEach((entry, i) => {
            const li     = document.createElement('li');
            if (entryMatchesHighlight(entry)) {
                li.classList.add('lbHighlight');
                highlightedEl = li;
            }
            const rank   = document.createElement('span'); rank.className   = 'lbRank';   rank.textContent   = '#' + (i + 1);
            const name   = document.createElement('span'); name.className   = 'lbName';   name.textContent   = entry.name;
            const solved = document.createElement('span'); solved.className = 'lbSolved'; solved.textContent = entry.solved + ' solved';
            const time   = document.createElement('span'); time.className   = 'lbTime';   time.textContent   = fmtTimePrecise(entry.totalMs);
            li.appendChild(rank);
            li.appendChild(name);
            li.appendChild(solved);
            li.appendChild(time);
            // Watch button on any entry with a replayable recording. Sources,
            // in priority order:
            //   1. ownEvents — player's own recording stashed locally by id
            //      (covers the "server save succeeded but server didn't
            //      return events" case, e.g. back-end without hasRecording).
            //   2. localEvents — local-fallback entry that stashed events
            //      on the entry itself because the server submit failed.
            //   3. hasServerRecord — server says it has events; fetch them
            //      via the recording endpoint. Used for other players'
            //      entries.
            // Entries from before the recording feature shipped have none
            // and stay button-less.
            const ownEvents       = (ownRecording && entry.id === ownRecording.id) ? ownRecording.events : null;
            const localEvents     = Array.isArray(entry.events) && entry.events.length > 0
                                    ? entry.events : null;
            const directEvents    = ownEvents || localEvents;
            const hasServerRecord = entry.id && entry.hasRecording;
            if (directEvents || hasServerRecord) {
                const watch = document.createElement('button');
                watch.className   = 'lbWatch';
                watch.type        = 'button';
                watch.textContent = '▶ ' + I18n.t('marathon.watch');
                if (directEvents) {
                    const evCopy = directEvents;
                    const name   = entry.name;
                    watch.addEventListener('click', () => startReplayWithEvents(evCopy, name));
                } else {
                    const id = entry.id;
                    watch.addEventListener('click', () => startReplay(id));
                }
                li.appendChild(watch);
            }
            leaderboardEntries.appendChild(li);
        });
        // Scroll the highlighted row into view so the player sees their entry
        // without scanning. Soft block:'center' looks better than 'start' on
        // mid-list highlights and is a no-op when the list already fits.
        if (highlightedEl) {
            try { highlightedEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
            catch (e) { highlightedEl.scrollIntoView(); }
        }
    }

    async function renderLeaderboard() {
        const type = (leaderboardSelect && leaderboardSelect.value) || MARATHON.TYPES[0];

        // Paint local cache immediately so the UI is never blank.
        paintLeaderboard(loadBoard(type));

        // Refresh from server; update cache + re-render if user is still on this board.
        try {
            const fresh = await fetchBoardFromServer(type);
            saveBoard(type, fresh);
            if (state === STATE.LEADERBOARD &&
                leaderboardSelect && leaderboardSelect.value === type) {
                paintLeaderboard(fresh);
            }
        } catch (e) {
            // Stay with the cached view painted above.
        }
    }

    // ----- Replay (watching another player's recording) -----

    function updateReplayHud(name, n, total) {
        if (!replayLabel) return;
        replayLabel.textContent = I18n.t('marathon.replayingHeader', { name: name, n: n, total: total });
    }

    async function startReplay(scoreId) {
        if (state === STATE.REPLAYING) return;
        const base = apiBase();
        if (!base) return;

        let data;
        try {
            const resp = await fetch(base + '/scores/' + encodeURIComponent(scoreId) + '/recording');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            data = await resp.json();
        } catch (e) {
            Logger.warn('Marathon: failed to fetch recording', e);
            return;
        }
        const events = Array.isArray(data.events) ? data.events : [];
        await startReplayWithEvents(events, data.name || '');
    }

    // Local-events variant — used by the Watch button on entries whose
    // server submit failed, so the events live in localStorage. Same
    // playback path as startReplay; just skips the API fetch.
    async function startReplayWithEvents(events, displayName) {
        if (state === STATE.REPLAYING) return;
        if (!Array.isArray(events) || events.length === 0) return;

        state = STATE.REPLAYING;
        showOnly(replayHudEl);
        const name = displayName || '';
        updateReplayHud(name, 0, events.length);

        await Game.replayAll(events, (idx, total) => {
            updateReplayHud(name, idx + 1, total);
        });

        // Whether the replay finished naturally or was cancelled mid-stream,
        // return to the leaderboard view IF the user hasn't navigated away
        // (e.g. cancelled via Quit-to-menu instead of Stop).
        if (state === STATE.REPLAYING) {
            showLeaderboard();
        }
    }

    function stopReplay() {
        if (typeof Game !== 'undefined' && Game.cancelReplay) Game.cancelReplay();
    }

    function isPlaying()       { return state === STATE.PLAYING; }
    function isMenuVisible()   { return state === STATE.MENU; }
    function isInTransition()  { return inTransition; }
    function isReplaying()     { return state === STATE.REPLAYING; }

    return { init, onSolve, onHintUsed, onPuzzleReady, advance, isPlaying, isMenuVisible, isInTransition, isReplaying, upcomingDims,
             getSolvedCount: () => solvedCount };
})();
