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
    const STATE = { MENU: 'menu', PLAYING: 'playing', GAME_OVER: 'gameOver', LEADERBOARD: 'leaderboard' };

    let state          = STATE.MENU;
    let activeType     = null;     // 's1'..'s4', 'q1'..'q4'
    let level          = 0;        // current puzzle index, 1-based
    let solvedCount    = 0;
    let totalSolveTime = 0;        // ms — sum of (now - puzzleStartTimeMs) per solved puzzle
    let timeRemaining  = 0;        // ms — single carry-over pool, ticks down during PLAYING
    let lastTickTime   = 0;        // ms epoch — for delta-based timer
    let timerHandle    = null;
    let puzzleStartMs  = 0;        // ms epoch when current puzzle finished building

    let callbacks = null;

    // DOM refs (populated in init)
    let menuEl, hudEl, gameOverEl, leaderboardEl, solveTransitionEl;
    let hudType, hudLevel, hudTimer, hudScore, hudQuit;
    let solveHeadline, solveBanked;
    let gameOverScore, gameOverTime, gameOverRank, gameOverName, gameOverSave, gameOverMenu;
    let leaderboardSelect, leaderboardEntries, leaderboardEmpty, leaderboardClose, menuLeaderboardBtn;

    // Inter-puzzle transition: blocks repeat-onSolve and gates input. Player
    // taps to advance (no auto-timeout) so they have time to read the banked
    // message; the tap is captured by both the popup's click handler and
    // game.js's handlePointer (when isInTransition() is true).
    let inTransition = false;

    function $(id) { return document.getElementById(id); }

    function init(cbs) {
        callbacks = cbs || {};

        menuEl             = $('menu');
        hudEl              = $('hud');
        gameOverEl         = $('gameOver');
        leaderboardEl      = $('leaderboard');
        solveTransitionEl  = $('solveTransition');

        hudType  = $('hudType');
        hudLevel = $('hudLevel');
        hudTimer = $('hudTimer');
        hudScore = $('hudScore');
        hudQuit  = $('hudQuitBtn');

        solveHeadline = $('solveHeadline');
        solveBanked   = $('solveBanked');

        gameOverScore = $('gameOverScore');
        gameOverTime  = $('gameOverTime');
        gameOverRank  = $('gameOverRank');
        gameOverName  = $('gameOverName');
        gameOverSave  = $('gameOverSaveBtn');
        gameOverMenu  = $('gameOverMenuBtn');

        leaderboardSelect  = $('leaderboardSelect');
        leaderboardEntries = $('leaderboardEntries');
        leaderboardEmpty   = $('leaderboardEmpty');
        leaderboardClose   = $('leaderboardCloseBtn');
        menuLeaderboardBtn = $('menuLeaderboardBtn');

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
            btn.addEventListener('click', () => startGame(mode));
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
        // Tap the popup to advance to the next puzzle. handlePointer in
        // game.js wires the same advance() to canvas clicks.
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
        [menuEl, hudEl, gameOverEl, leaderboardEl].forEach((el) => {
            if (!el) return;
            el.classList.toggle('visible', set.has(el));
        });
    }

    function clearTransition() {
        inTransition = false;
        if (solveTransitionEl) solveTransitionEl.classList.remove('visible');
    }

    // Player tapped during the inter-puzzle transition — proceed to the next
    // puzzle. No-op if not currently transitioning, so accidental rapid clicks
    // after the next puzzle loads don't cascade into double-advances.
    function advance() {
        if (!inTransition) return;
        if (state !== STATE.PLAYING) return;
        clearTransition();
        startNextPuzzle();
    }

    function goToMenu() {
        state = STATE.MENU;
        stopTimer();
        clearTransition();
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
    function dimsForLevel(lev, quadMode) {
        const minDim = quadMode ? MARATHON.MIN_DIM_QUAD : MARATHON.MIN_DIM_SINGULAR;
        let rowGrowth = 0, colGrowth = 0;
        for (let L = 2; L <= lev; L++) {
            const m = L % 4;
            if (m === 3 || m === 0) rowGrowth++;
            else                    colGrowth++;
        }
        return {
            rows: minDim + rowGrowth,
            cols: minDim + colGrowth
        };
    }

    function tileCount(logical) {
        // Visible/interactable tiles (quad counts each 2×2 sub-tile group as 1).
        return logical.rows * logical.cols;
    }

    function timeForPuzzle(logical, quadMode) {
        const per = quadMode ? MARATHON.TIME_PER_TILE_QUAD : MARATHON.TIME_PER_TILE_SINGULAR;
        return tileCount(logical) * per * 1000;
    }

    function timeCapForPuzzle(logical, quadMode) {
        const cap = quadMode ? MARATHON.TIME_CAP_PER_TILE_QUAD : MARATHON.TIME_CAP_PER_TILE_SINGULAR;
        return tileCount(logical) * cap * 1000;
    }

    function startGame(type) {
        activeType     = type;
        level          = 0;
        solvedCount    = 0;
        totalSolveTime = 0;
        timeRemaining  = 0;        // first puzzle gets only its fresh allotment, no carry-over
        startNextPuzzle();
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

        // Carry-over + fresh allotment, capped by THIS puzzle's cap.
        const fresh = timeForPuzzle(logical, decoded.quadMode);
        const cap   = timeCapForPuzzle(logical, decoded.quadMode);
        timeRemaining = Math.min(cap, timeRemaining + fresh);

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
    // (e.g. 0.25 → keep 75%) and play a shake/flash + floating "−Xs" indicator
    // on the HUD timer so the cost is unmissable. No-op if a transition is in
    // flight (between puzzles) or we're not actively playing.
    function onHintUsed() {
        if (state !== STATE.PLAYING || inTransition) return;
        const penaltyMs = timeRemaining * MARATHON.HINT_PENALTY_FRACTION;
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
        stopTimer();

        const elapsed = Date.now() - puzzleStartMs;
        totalSolveTime += elapsed;
        solvedCount++;

        // Compute the projected next-puzzle starting time + how much of the
        // current leftover actually carries forward (rest is lost to the cap).
        const decoded   = decodeType(activeType);
        const nextLogical = dimsForLevel(level + 1, decoded.quadMode);
        const fresh     = timeForPuzzle(nextLogical, decoded.quadMode);
        const cap       = timeCapForPuzzle(nextLogical, decoded.quadMode);
        const nextStart = Math.min(cap, timeRemaining + fresh);
        const bankedMs  = Math.max(0, nextStart - fresh);

        // Reflect the solve in the HUD score immediately — keeps the HUD in
        // sync with the transition popup, so when the popup hides the score
        // doesn't suddenly jump.
        if (hudScore) {
            hudScore.textContent = I18n.t('marathon.solvedCount', {
                n: solvedCount, s: solvedCount === 1 ? '' : 's'
            });
        }

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
        renderGameOver();
        showOnly(gameOverEl);
    }

    function quitToMenu() {
        clearTransition();
        if (callbacks.quit) callbacks.quit();
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
        hudScore.textContent = I18n.t('marathon.solvedCount', { n: solvedCount, s: solvedCount === 1 ? '' : 's' });
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

    function renderGameOver() {
        gameOverScore.textContent = I18n.t('marathon.solvedCount', { n: solvedCount, s: solvedCount === 1 ? '' : 's' });
        gameOverTime.textContent  = I18n.t('marathon.totalTime', { t: fmtTimePrecise(totalSolveTime) });

        // Project where this score WOULD land if saved.
        const board = loadBoard(activeType);
        const rank  = computeRank(board, solvedCount, totalSolveTime);
        if (solvedCount > 0 && rank <= MARATHON.LEADERBOARD_TOP_N) {
            gameOverRank.textContent = I18n.t('marathon.newBest', { r: rank });
            gameOverRank.hidden = false;
        } else {
            gameOverRank.textContent = '';
            gameOverRank.hidden = true;
        }
        gameOverName.value = '';
        gameOverSave.disabled = solvedCount === 0;
        gameOverSave.textContent = I18n.t('marathon.save');
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
            sessionId:     getSessionId()
            // seed / events reserved for future replay validation.
        };
    }

    async function saveScore() {
        if (state !== STATE.GAME_OVER) return;
        if (solvedCount === 0) return;     // no zero-score entries
        const name = ((gameOverName.value || '').trim().slice(0, 16)) || 'Player';

        gameOverSave.disabled    = true;
        gameOverSave.textContent = I18n.t('marathon.save') + '…';

        const payload = buildPayload(name);

        try {
            await flushPending();          // opportunistically retry earlier failed submissions
            const data = await submitToServer(payload);
            if (Array.isArray(data.top)) saveBoard(activeType, data.top);
            if (typeof data.rank === 'number' && gameOverRank) {
                if (data.rank <= MARATHON.LEADERBOARD_TOP_N) {
                    gameOverRank.textContent = I18n.t('marathon.newBest', { r: data.rank });
                    gameOverRank.hidden = false;
                } else {
                    gameOverRank.hidden = true;
                }
            }
        } catch (e) {
            Logger.warn('Marathon: score submission failed, queueing for retry', e);
            // Persist locally so the player at least sees their entry on this
            // device, AND queue the payload for retry on the next save attempt.
            const board = loadBoard(activeType);
            board.push({ name, solved: solvedCount, totalMs: totalSolveTime, date: Date.now() });
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

        gameOverSave.textContent = I18n.t('marathon.saved');
    }

    function paintLeaderboard(board) {
        leaderboardEntries.innerHTML = '';
        if (board.length === 0) {
            leaderboardEmpty.hidden = false;
            return;
        }
        leaderboardEmpty.hidden = true;
        board.forEach((entry, i) => {
            const li     = document.createElement('li');
            const rank   = document.createElement('span'); rank.className   = 'lbRank';   rank.textContent   = '#' + (i + 1);
            const name   = document.createElement('span'); name.className   = 'lbName';   name.textContent   = entry.name;
            const solved = document.createElement('span'); solved.className = 'lbSolved'; solved.textContent = entry.solved + ' solved';
            const time   = document.createElement('span'); time.className   = 'lbTime';   time.textContent   = fmtTimePrecise(entry.totalMs);
            li.appendChild(rank);
            li.appendChild(name);
            li.appendChild(solved);
            li.appendChild(time);
            leaderboardEntries.appendChild(li);
        });
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

    function isPlaying()       { return state === STATE.PLAYING; }
    function isMenuVisible()   { return state === STATE.MENU; }
    function isInTransition()  { return inTransition; }

    return { init, onSolve, onHintUsed, onPuzzleReady, advance, isPlaying, isMenuVisible, isInTransition };
})();
