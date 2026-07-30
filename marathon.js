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
    // Practice is Marathon with the clock and the leaderboard removed: the
    // timer never starts (so the game only ends when the player quits) and
    // nothing is submitted. Set per-run in startGame from the active mode;
    // every branch that touches the countdown, hint penalty, or score save
    // gates on this. Same state machine + puzzle flow as Marathon otherwise.
    let isPractice     = false;
    // True only during the one-time first-visit auto-started Practice run
    // (see autoStartFirstPractice). Gates the in-HUD "How to Solve" button
    // — a brand-new player skipped the menu entirely, so this run is the
    // only surface where the tutorial entry point must live. Cleared by
    // every subsequent startGame (3rd arg omitted → false) and by goToMenu
    // (covers the PotD path, which starts games without startGame).
    let isFirstRunAutoStart = false;
    // Deferred "started" tracking milestone for the auto-start run. The
    // player didn't choose to play — we dropped them in — so recordStart
    // is held here until their first committed puzzle action (game.js
    // recordMove → notifyPuzzleInteraction). Null everywhere else: normal
    // starts record immediately in startGame, and goToMenu clears this so
    // a no-touch bail never counts as a start.
    let deferredStartTracking = null;
    // Consumed-flag key for the one-time auto-start. Deliberately its own
    // key (not _mode / _lastPlayerName) so the semantics stay "the intro
    // auto-start has fired once", independent of what else the player did.
    const AUTO_START_KEY = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness')
        + '_firstVisitAutoStarted_v1';
    let activeType     = null;     // 's' / 'q' (progressive); legacy 's1'..'q4' via resumed old saves
    let sessionToken   = null;     // server-issued cheat-proof timing token (from /api/game/start)
    let level          = 0;        // current puzzle index, 1-based
    let solvedCount    = 0;
    // Hints used across the whole marathon run — submitted with the score
    // and used as the primary tiebreaker on the leaderboard (fewer hints
    // wins before total_ms is even considered). Reset to 0 in startGame,
    // incremented inside onHintUsed.
    let hintsUsed      = 0;
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
    // Epoch of the run's /game/start — persisted with the run save so a
    // resumed marathon knows how old its sessionToken is (the server
    // rejects submits more than MAX_SESSION_MS ≈ 6h after token issue;
    // see saveScore's pending-queue gate).
    let runStartedAtMs = 0;
    // True while the CURRENT puzzle is actually on-screen and playable
    // (set in onPuzzleReady, cleared when a build starts / the run ends).
    // saveRunState uses it to tell a mid-puzzle save (full board
    // snapshot) from a mid-BUILD save (level already ++'d and fresh time
    // already granted for a puzzle that never appeared — must be rolled
    // back to a boundary save or the resume would double-grant).
    let puzzleLive = false;

    // Per-game accumulated recordings. Each entry is a deep clone of
    // Game.recording captured in onSolve() right before the next puzzle
    // overwrites it. Shipped with the score submission so the run can
    // be replayed from any leaderboard view.
    let recordings = [];

    let callbacks = null;

    // DOM refs (populated in init)
    let menuEl, hudEl, gameOverEl, leaderboardEl, solveTransitionEl, replayHudEl;
    let hudType, hudLevel, hudTimer, hudQuit, hudHowTo;
    let solveHeadline, solveBanked, solveTierUp, solveMoves;
    let gameOverScore, gameOverTime, gameOverRank, gameOverName, gameOverSave, gameOverMenu, gameOverNameRow;
    let gameOverPotdHook;
    let leaderboardTileTabsEl, leaderboardPathTabsEl, leaderboardEntries, leaderboardEmpty, leaderboardClose, menuLeaderboardBtn;
    let leaderboardTabsEl;
    let menuCreditsBtn, creditsPopupEl, creditsPopupMenu;
    let replayLabel, replayStopBtn;

    // Which mode's leaderboard the user is currently viewing. Drives both
    // the dropdown's option labels (same slot set, different naming
    // convention) and the API + cache routing in fetch/render. Defaults
    // to whatever ModePicker says is active when the leaderboard opens.
    let leaderboardMode = 'marathon';

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
    const TRANSITION_QUIET_MS = 333;
    let transitionQuietUntil = 0;
    // Pending timer that reveals the solve popup after SOLVE_REVEAL_DELAY_MS,
    // during which the completed (gold) puzzle is left uncovered. Non-null
    // only while that delay is running.
    let solvePopupTimer = null;

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
        hudHowTo = $('hudHowToBtn');

        solveHeadline = $('solveHeadline');
        solveBanked   = $('solveBanked');
        solveTierUp   = $('solveTierUp');
        solveMoves    = $('solveMoves');

        gameOverScore   = $('gameOverScore');
        gameOverTime    = $('gameOverTime');
        gameOverRank    = $('gameOverRank');
        gameOverName    = $('gameOverName');
        gameOverSave    = $('gameOverSaveBtn');
        gameOverMenu    = $('gameOverMenuBtn');
        gameOverNameRow = gameOverEl ? gameOverEl.querySelector('.gameOverNameRow') : null;
        gameOverPotdHook = $('gameOverPotdHook');
        // PotD comeback hook → menu with the Puzzle of the Day tab live
        // (slot grid + streak strip visible) rather than launching a slot
        // directly — game-over is a browsing moment, not a committed one.
        // SAVE-FIRST: when the name row is up (player ranked top-N),
        // Save is deliberately the only other exit on the card (the menu
        // button hides in that state) — the hook must not become a
        // silent score-discarder (user nearly hit this at rank 2). Kick
        // off the same submit Save would (input name, empty →
        // 'Anonymous'), THEN navigate: saveScore's post-submit UI hops
        // are state-guarded, so leaving GAME_OVER immediately just skips
        // them while the POST proceeds in the background. Non-ranking
        // players have the row hidden and nothing pending — plain
        // navigation (calling saveScore for them would CREATE
        // submissions the Save-less design never made).
        if (gameOverPotdHook) gameOverPotdHook.addEventListener('click', () => {
            if (gameOverNameRow && !gameOverNameRow.hidden) saveScore();
            goToMenu();
            if (typeof ModePicker !== 'undefined' && ModePicker.setMode) ModePicker.setMode('potd');
        });

        leaderboardTileTabsEl = $('leaderboardTileTabs');
        leaderboardPathTabsEl = $('leaderboardPathTabs');
        leaderboardEntries = $('leaderboardEntries');
        leaderboardEmpty   = $('leaderboardEmpty');
        leaderboardClose   = $('leaderboardCloseBtn');
        menuLeaderboardBtn = $('menuLeaderboardBtn');
        leaderboardTabsEl  = $('leaderboardTabs');

        menuCreditsBtn   = $('menuCreditsBtn');
        creditsPopupEl   = $('creditsPopup');
        creditsPopupMenu = $('creditsPopupMenuBtn');

        replayLabel   = $('replayLabel');
        replayStopBtn = $('replayStopBtn');

        // Wire mode buttons + populate thumbnails. Thumbnail filenames are
        // {1 or 4}x{pathCount}.png — the leading 1/4 is the grid-base
        // (regular vs quad), the trailing digit is the path count. The
        // progressive Zen/Marathon cards ('s'/'q', no path digit) reuse
        // the 3-path art — busier than the tier-1 board the run actually
        // opens on, but it reads better at card size (user call).
        document.querySelectorAll('.menuModeBtn').forEach((btn) => {
            const mode = btn.getAttribute('data-mode');
            const thumb = btn.querySelector('img.modeThumb');
            if (thumb && typeof THUMBNAIL_URL_BASE === 'string') {
                const base  = mode[0] === 'q' ? '4' : '1';
                const paths = mode[1] || '3';
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
                    // Marathon and Practice share startGame — the second arg
                    // flips the untimed/no-leaderboard Practice variant.
                    startGame(mode, pickedMode === 'practice');
                }
            });
        });
        if (menuLeaderboardBtn) menuLeaderboardBtn.addEventListener('click', showLeaderboard);
        if (menuCreditsBtn)     menuCreditsBtn.addEventListener('click', showCredits);
        // goToMenu already tears the credits roll down (Credits.stop) and
        // restarts menu music — the popup's exit needs nothing extra.
        if (creditsPopupMenu)   creditsPopupMenu.addEventListener('click', goToMenu);
        if (hudQuit)            hudQuit.addEventListener('click', () => {
            // First-time-player funnel: on the auto-start run this button
            // reads "📅 Daily & More" — record the click HERE, not inside
            // quitToMenu, because the in-run PotD nudge's action also
            // routes through quitToMenu and must not count as a
            // Daily-&-More click.
            if (isFirstRunAutoStart && typeof Tracking !== 'undefined'
                && Tracking.firstRunDailyMoreClicked) {
                Tracking.firstRunDailyMoreClicked();
            }
            quitToMenu();
        });
        // In-HUD tutorial entry — only ever visible during the first-visit
        // auto-started Practice run (see isFirstRunAutoStart). Tutorial.open
        // snapshots + restores the live Maze/Gates around the teaching
        // puzzle, so opening mid-run is safe; game.js's undo() additionally
        // gates on Tutorial.isOpen so Ctrl+Z can't poke the swapped grid.
        // Ignored during the between-puzzles transition: advance() rebuilds
        // the maze under the tutorial's feet otherwise.
        if (hudHowTo) hudHowTo.addEventListener('click', () => {
            if (inTransition) return;
            if (typeof Tutorial !== 'undefined' && Tutorial.open) Tutorial.open();
        });
        if (gameOverSave)       gameOverSave.addEventListener('click', saveScore);
        if (gameOverMenu)       gameOverMenu.addEventListener('click', goToMenu);
        if (gameOverName)       gameOverName.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') saveScore();
        });
        if (leaderboardClose)   leaderboardClose.addEventListener('click', goToMenu);
        // Two-tier sub-tab selector. Marathon boards use only the
        // tile-type row (Singular/Quad → 's'/'q', one board per
        // progressive type); PotD combines it with the path row
        // (1/2/3/4, plus the Streak/Career all-time chips) to pick the
        // slot identifier 's1'..'q4' — see getActiveBoardType /
        // setActiveBoardType below. The path row is CSS-hidden outside
        // PotD mode. Both rows use the shared .lbSubTab visual.
        // wireSubTabRow: takes the row element + default-button selector,
        // wires click handlers (toggling .active and re-rendering), and
        // sets the default-button's .active class so the panel renders
        // something sensible before any explicit selection.
        function wireSubTabRow(rowEl, defaultSelector) {
            if (!rowEl) return;
            rowEl.querySelectorAll('.lbSubTab').forEach((btn) => {
                btn.addEventListener('click', () => {
                    rowEl.querySelectorAll('.lbSubTab').forEach((b) => b.classList.remove('active'));
                    btn.classList.add('active');
                    renderLeaderboard();
                });
            });
            const first = rowEl.querySelector(defaultSelector);
            if (first) first.classList.add('active');
        }
        wireSubTabRow(leaderboardTileTabsEl, '.lbSubTab[data-tile="s"]');
        wireSubTabRow(leaderboardPathTabsEl, '.lbSubTab[data-paths="1"]');
        // Tab click handlers — switch the active leaderboard mode and
        // re-render with the new mode's fetch + render branch.
        if (leaderboardTabsEl) {
            leaderboardTabsEl.querySelectorAll('.lbTab').forEach((btn) => {
                btn.addEventListener('click', () => setLeaderboardMode(btn.dataset.mode));
            });
        }
        if (replayStopBtn)      replayStopBtn.addEventListener('click', stopReplay);
        // Continue-your-run cards (saved-run resume) + their discard ✕.
        document.querySelectorAll('[data-run-resume]').forEach((btn) => {
            btn.addEventListener('click', () => resumeRun(btn.getAttribute('data-run-resume')));
        });
        document.querySelectorAll('[data-run-discard]').forEach((btn) => {
            btn.addEventListener('click', () => clearRunSave(btn.getAttribute('data-run-discard')));
        });
        // Cards are mode-gated — repaint when the player switches tabs.
        if (typeof ModePicker !== 'undefined' && ModePicker.onChange) {
            ModePicker.onChange(refreshContinueCards);
        }
        // Checkpoint on tab close / backgrounding so a killed tab mid-run
        // is resumable. pagehide is the reliable mobile signal; the
        // visibilitychange fallback covers browsers that skip pagehide on
        // process kill. Both are no-ops unless a run is in progress.
        window.addEventListener('pagehide', saveRunState);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveRunState();
        });
        // Tap the popup to advance to the next puzzle. The canvas does NOT
        // route here — see comment on the inTransition declaration above.
        if (solveTransitionEl)  solveTransitionEl.addEventListener('click', advance);

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
        [menuEl, hudEl, gameOverEl, leaderboardEl, replayHudEl, creditsPopupEl].forEach((el) => {
            if (!el) return;
            el.classList.toggle('visible', set.has(el));
        });
    }

    function clearTransition() {
        inTransition = false;
        transitionQuietUntil = 0;
        if (solvePopupTimer !== null) { clearTimeout(solvePopupTimer); solvePopupTimer = null; }
        if (solveTransitionEl) solveTransitionEl.classList.remove('visible');
    }

    // Actually show the solve popup (fires on the reveal-delay timeout, or
    // early when the player taps during the delay). Arms the quiet window so
    // the revealing tap doesn't immediately advance past the popup.
    function showSolveTransition() {
        if (solvePopupTimer !== null) { clearTimeout(solvePopupTimer); solvePopupTimer = null; }
        if (solveTransitionEl) solveTransitionEl.classList.add('visible');
        transitionQuietUntil = Date.now() + TRANSITION_QUIET_MS;
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
        // Reveal-delay phase: the popup hasn't appeared yet. Absorb the
        // winning tap (quiet window), then let a deliberate tap reveal the
        // popup early — never skip straight to the next puzzle here, so a
        // stray tap can't blow past the just-solved board AND its popup.
        if (solvePopupTimer !== null) {
            if (now < transitionQuietUntil) {
                transitionQuietUntil = now + TRANSITION_QUIET_MS;
                return;
            }
            showSolveTransition();
            return;
        }
        if (now < transitionQuietUntil) {
            transitionQuietUntil = now + TRANSITION_QUIET_MS;
            return;
        }
        clearTransition();
        // true → the solved board is still on the canvas; startNextPuzzle
        // sends it tumbling away (the 3D spin transition) before the
        // build blanks it.
        startNextPuzzle(true);
    }

    function goToMenu() {
        // Bail out of an in-flight replay before changing state. Game's
        // own isReplaying flag stays true until the async loop wakes up,
        // sees the flag, and exits — that's fine because we'll be on the
        // menu before the next paint anyway.
        if (state === STATE.REPLAYING && typeof Game !== 'undefined' && Game.cancelReplay) {
            Game.cancelReplay();
        }
        // If a finished replay is holding on its final frame, release it
        // so startReplayWithEvents' continuation runs (it sees state !==
        // REPLAYING below and skips the leaderboard return; the menu
        // music this function starts makes its handoff a no-op).
        releaseReplayHold();
        state = STATE.MENU;
        stopTimer();
        clearTransition();
        // Wipe the last puzzle from the canvas — the menu overlays it
        // translucently and a lingering board reads as clutter. Only the
        // canvas: the body background image lives on documentElement
        // (Render.applyBodyBackground), and Render.draw on a cleared Maze
        // just blanks the canvas over it. game.js's undo() bails on a null
        // grid, so a stray Ctrl+Z at the menu can't resurrect the board.
        // PotD's own menu return (potd.js showMenu) mirrors this wipe.
        if (typeof Maze !== 'undefined' && Maze.clear) {
            Maze.clear();
            if (typeof Render !== 'undefined' && Render.draw) Render.draw();
        }
        // Tear down any in-flight board-spin transition — without this a
        // quit during the spin window would strand the canvas with the
        // spin-hold class and the NEXT game's board would be invisible.
        if (typeof Render !== 'undefined' && Render.cancelSpin) Render.cancelSpin();
        // CrazyGames engagement signal (no-op off-CG / when not playing).
        if (typeof CgSdk !== 'undefined') CgSdk.gameplayStop();
        // The one-time auto-start run (if that's what we're leaving) is
        // over — from here on the player navigates normally. Hiding the
        // button here (not just clearing the flag) covers PotD, whose
        // startPuzzle path shows #hud without going through startGame /
        // startNextPuzzle, so it would never re-hide a stale button.
        // Same PotD-coverage reasoning for restoring the Quit label.
        isFirstRunAutoStart = false;
        // Auto-start run abandoned without a single puzzle interaction —
        // the deferred "started" milestone dies here, uncounted (that's
        // the point: a no-touch bail is not a start).
        deferredStartTracking = null;
        if (hudHowTo) hudHowTo.hidden = true;
        if (hudQuit) {
            hudQuit.setAttribute('data-i18n', 'marathon.quit');
            hudQuit.textContent = I18n.t('marathon.quit');
        }
        // Cancel any pending lock-tip timer — without this, a player who
        // quits within 30s of puzzle start would see the lock tip pop up
        // on the menu (contextually wrong; the tip's about mid-puzzle
        // tile-locking).
        cancelLockTip();
        // Hide any active first-play tooltip + drop the queue WITHOUT
        // marking seen. The player didn't actually click Got It — they
        // navigated away — so the same tip will fire again next puzzle.
        if (typeof Tooltip !== 'undefined' && Tooltip.dismissActive) {
            Tooltip.dismissActive(false);
        }
        // Fade any lingering one-shot SFX (audience_cheer / cheer_long /
        // applause_long / disappointed / etc.) on the way out. Music.start
        // below ALSO triggers a fade via its own playSong hook, but only
        // when music is enabled — this defensive call handles the
        // music-disabled case where the player's game-over SFX would
        // otherwise persist into the menu silence.
        if (typeof Sfx !== 'undefined' && Sfx.fadeOneShots) Sfx.fadeOneShots();
        // Tear the credits down before returning to menu — covers every exit
        // path from the game-over screen (Back to menu, Save, leaderboard).
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
        // Same idea for the iOS standalone on-screen keyboard — if the
        // game-over name input painted one, remove it on every exit so
        // it doesn't linger over the menu/leaderboard.
        teardownMobileKeyboard();
        // Back at menu — restart music with a fresh menu_only pool
        // song IF the current track isn't already from the menu pool.
        // Without the isMenuSongPlaying gate, closing the leaderboard
        // while a menu song was already playing would yank it off and
        // replace it with a different menu song — annoying mid-listen.
        // setMenuPhase is always called so the next pickNext (when
        // the current song ends naturally) draws from the menu pool
        // even on the "already playing menu music, no restart" path.
        // start() respects muted: if the player has music off, the
        // stop+start chain is a no-op silently.
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(true);
            const alreadyMenu = Music.isMenuSongPlaying && Music.isMenuSongPlaying();
            if (!alreadyMenu) {
                if (Music.stop)  Music.stop();
                if (Music.start) Music.start();
            }
        }
        pendingHighlight = null;   // leaving the leaderboard drops the highlight
        puzzleLive = false;
        showOnly(menuEl);
        // Surface/refresh the Continue card for whatever run is saved.
        refreshContinueCards();
    }

    // CREDITS menu button — roll the end credits on demand, without a game
    // ending. Same audio/visual flow as the game-over roll: stop the menu
    // music first (Credits.start schedules the credits track a beat later),
    // swap the menu for the floating #creditsPopup card (share row + Back
    // to Menu). State stays MENU — nothing game-related is in flight, and
    // goToMenu (the popup's only exit) is a no-op-safe re-entry that tears
    // the credits down and restarts menu music.
    function showCredits() {
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        showOnly(creditsPopupEl);
        if (typeof Credits !== 'undefined' && Credits.start) Credits.start();
    }

    // All-time PotD board types compose the same way as slots — tile
    // prefix + the chip's data-paths value — but the value is 'streak'
    // or 'career' instead of a digit (so 'sstreak', 'qcareer', …).
    // Returns the kind for such a type, or null for a playable slot.
    // These types are leaderboard-view-only: they never reach the game
    // flow (setActiveBoardType is only ever called with real slots).
    function alltimeKind(type) {
        const m = /^[sq](streak|career)$/.exec(type || '');
        return m ? m[1] : null;
    }

    // Combined board-type getter. Marathon collapsed to one board per
    // tile type ('s' / 'q' — the progressive types), so in marathon mode
    // only the tile row matters (the path row is CSS-hidden there). PotD
    // still composes tile + board tab (1/2/3/4 paths, or the PotD-only
    // Streak / Career chips → all-time types, see alltimeKind). Defaults
    // conservatively if a control is missing (e.g. during init before
    // DOM refs are populated).
    function getActiveBoardType() {
        const tileBtn = leaderboardTileTabsEl
                        ? leaderboardTileTabsEl.querySelector('.lbSubTab.active')
                        : null;
        const tile    = (tileBtn && tileBtn.dataset.tile) || 's';
        if (leaderboardMode === 'marathon') return tile;
        const pathBtn = leaderboardPathTabsEl
                        ? leaderboardPathTabsEl.querySelector('.lbSubTab.active')
                        : null;
        const paths   = (pathBtn && pathBtn.dataset.paths) || '1';
        return tile + paths;
    }
    // Combined board-type setter: drives the tab rows from an identifier.
    // Accepts 1-char progressive types ('s'/'q' — tile row only, the
    // hidden path row is left untouched) and 2-char PotD slots. Used by
    // every code path that used to set the old dropdown directly
    // (showPotdLeaderboard, saveScore success, etc). No-ops if the type
    // is malformed or the rows aren't wired yet.
    function setActiveBoardType(type) {
        if (!type || typeof type !== 'string' || type.length < 1 || type.length > 2) return;
        const tile  = type[0];
        const paths = type.length === 2 ? type[1] : null;
        if (leaderboardTileTabsEl) {
            leaderboardTileTabsEl.querySelectorAll('.lbSubTab').forEach((b) => {
                b.classList.toggle('active', b.dataset.tile === tile);
            });
        }
        if (paths && leaderboardPathTabsEl) {
            leaderboardPathTabsEl.querySelectorAll('.lbSubTab').forEach((b) => {
                b.classList.toggle('active', b.dataset.paths === paths);
            });
        }
    }

    function showLeaderboard() {
        // Returning from a replay (state was REPLAYING) preserves the
        // tab the user was viewing before they hit Watch. Every other
        // entry path (menu button, save-score → leaderboard) defaults
        // the tab to whatever mode the player has selected in the main
        // menu's MODE chip — avoids dumping a PotD-player onto a
        // Marathon board and vice versa. Practice has no board of its
        // own, so its players default to the Puzzle of the Day board
        // (the flagship competitive view) rather than Marathon.
        const fromReplay = state === STATE.REPLAYING;
        state = STATE.LEADERBOARD;
        // Save-score → leaderboard leaves credits rolling unless we tear
        // them down here; the leaderboard view would otherwise sit on top
        // of the scrolling overlay.
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
        // Same reason for the iOS standalone on-screen keyboard — the
        // save path goes directly here (skipping goToMenu's teardown),
        // so we'd otherwise leave the keyboard floating over the
        // leaderboard. teardownMobileKeyboard is a no-op when no
        // keyboard is present (non-iOS, or never opened).
        teardownMobileKeyboard();
        if (!fromReplay) {
            const picked = (typeof ModePicker !== 'undefined' && ModePicker.getMode)
                ? ModePicker.getMode()
                : 'marathon';
            // Only Marathon-mode players default to the Marathon board.
            // PotD players and Practice players (Practice has no board of
            // its own) both land on the Puzzle of the Day board.
            const initialMode = picked === 'marathon' ? 'marathon' : 'potd';
            applyLeaderboardMode(initialMode, /*render=*/false);
        }
        renderLeaderboard();
        showOnly(leaderboardEl);
    }

    // Called from Potd.onSolve when the player ranked on today's board:
    // jumps directly from the solve modal into the PotD leaderboard view
    // with the player's row highlighted (.lbHighlight) and scrolled to
    // center. Bypasses the menu-mode default in showLeaderboard so the
    // PotD player doesn't briefly see the marathon tab before landing on
    // their own board.
    //
    //   slot       — 's1'..'s4' / 'q1'..'q4' for today's board to render
    //   highlight  — { id?, name, timeMs } matched by entryMatchesHighlight.
    //                id-match when the server save succeeded; the
    //                name+timeMs fallback covers local-only / id-less
    //                saves.
    function showPotdLeaderboard(slot, highlight) {
        pendingHighlight = highlight || null;
        setActiveBoardType(slot);
        state = STATE.LEADERBOARD;
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
        applyLeaderboardMode('potd', /*render=*/false);
        renderLeaderboard();
        showOnly(leaderboardEl);
    }

    function setLeaderboardMode(mode) {
        if (mode !== 'potd' && mode !== 'marathon') return;
        if (mode === leaderboardMode) return;
        applyLeaderboardMode(mode, /*render=*/true);
    }

    // Internal: update mode state + tab highlighting; optionally trigger a
    // re-render. Called by both setLeaderboardMode (user clicked a tab,
    // wants the new mode's data) and showLeaderboard (just entering the
    // view, render happens separately).
    function applyLeaderboardMode(mode, render) {
        leaderboardMode = mode;
        if (leaderboardTabsEl) {
            leaderboardTabsEl.querySelectorAll('.lbTab').forEach((btn) => {
                btn.classList.toggle('active', btn.dataset.mode === mode);
            });
        }
        // The whole path row is PotD-only now (marathon has one board per
        // tile type) — CSS hides it plus the Streak/Career chips unless
        // this class is on. Marathon's getActiveBoardType never reads the
        // path row, so whatever chip is active there can safely persist
        // for the player's return to the PotD tab.
        if (leaderboardEl) leaderboardEl.classList.toggle('lbModePotd', mode === 'potd');
        if (render) renderLeaderboard();
    }

    // ----- Game flow -----

    // Progressive types ('s' / 'q') ramp their path count within the run
    // as a pure function of level: tiers of MARATHON.TIER_LENGTH puzzles,
    // path count stepping 1 → MAX_PATHS.
    function pathCountForLevel(lev) {
        return Math.min(MARATHON.MAX_PATHS,
            Math.floor((lev - 1) / MARATHON.TIER_LENGTH) + 1);
    }
    // Growth-accumulator steps at `lev` given the path count in effect
    // there: +1 per solve, minus TIER_DROP for each tier transition
    // crossed. With TIER_DROP 1 the drop cancels the new level's +1, so
    // each tier opens at the SAME dims as the last puzzle solved (the
    // retraced growthSequence prefix is identical — rolled axis entries
    // are pinned, see ensureGrowthSequence). Rationale for same-size
    // transitions in config.js's TIER_* comment.
    //
    // Taking `paths` as a parameter (rather than reading
    // pathCountForLevel) is what lets the first-run fast track reuse
    // this: its tiers are shorter, but the same "one step per solve,
    // minus one per tier crossed" arithmetic applies, so the size curve
    // and the same-size tier openings are identical to a normal run.
    function growthStepsFor(lev, paths) {
        return Math.max(0, (lev - 1) - (paths - 1) * MARATHON.TIER_DROP);
    }
    // With TIER_LENGTH 4 / TIER_DROP 1: L1-4 → L-1; L5-8 → L-2;
    // L9-12 → L-3; L13+ → L-4 (endless growth at MAX_PATHS).
    function growthStepsForLevel(lev) {
        return growthStepsFor(lev, pathCountForLevel(lev));
    }
    // Path count in effect at `lev` for a decoded type: progressive
    // types compute it from the level; legacy 2-char types are fixed.
    function pathCountFor(decoded, lev) {
        return decoded.progressive ? pathCountForLevel(lev) : decoded.pathCount;
    }

    // ----- First-visit ladder experiment -----
    // The auto-start run walks one of FOUR ladder variants, drawn
    // randomly per new player in autoStartFirstPractice and stamped on
    // the player's first_run_stats row (Tracking.firstRunBegin) so the
    // admin panel can compare engagement per variant. Definitions + the
    // FIRST_RUN_VARIANT_FORCE lock-in knob live on the MARATHON config.
    // Everything here is inert for every other run (levelConfig only
    // consults the variant while isFirstRunAutoStart).
    let firstRunVariant = null;
    const FIRST_RUN_VARIANT_KEY = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness')
        + '_firstRunVariant_v1';
    function pickFirstRunVariant() {
        const pool = (Array.isArray(MARATHON.FIRST_RUN_VARIANTS) && MARATHON.FIRST_RUN_VARIANTS.length)
            ? MARATHON.FIRST_RUN_VARIANTS
            : ['fast', 'standard', 'extended', 'single'];
        const forced = MARATHON.FIRST_RUN_VARIANT_FORCE;
        const v = (forced && pool.indexOf(forced) !== -1)
            ? forced
            : pool[Math.floor(Math.random() * pool.length)];
        firstRunVariant = v;
        // Persisted for attribution durability (the stats row is keyed to
        // the browser and outlives this session) — not read back by
        // gameplay, which only cares during the one auto-start run.
        try { localStorage.setItem(FIRST_RUN_VARIANT_KEY, v); } catch (e) {}
        return v;
    }
    // The compressed 'fast' ladder — only that variant uses the tiers.
    function firstRunTiers() {
        if (!isFirstRunAutoStart || firstRunVariant !== 'fast') return null;
        const t = MARATHON.FIRST_RUN_TIERS;
        return (Array.isArray(t) && t.length) ? t : null;
    }
    // Last level of the fast track's singular phase; quad begins at +1.
    function firstRunSingularLevels() {
        const tiers = firstRunTiers();
        if (!tiers) return 0;
        return tiers.reduce(function (n, count) { return n + count; }, 0);
    }
    function firstRunPathCount(lev) {
        const tiers = firstRunTiers();
        let acc = 0;
        for (let i = 0; i < tiers.length; i++) {
            acc += tiers[i];
            if (lev <= acc) return i + 1;
        }
        return MARATHON.MAX_PATHS;
    }
    // True while the ACTIVE run is the fast-tracked first-visit one.
    // Legacy fixed-path types are excluded: the fast track only makes
    // sense over a progressive ladder, and the auto-start always starts
    // 's' anyway — the guard just keeps a resumed legacy save safe.
    function onFirstRunFastTrack() {
        return isFirstRunAutoStart && !!firstRunTiers()
            && decodeType(activeType).progressive;
    }

    // The single source of truth for "what does level `lev` of the
    // CURRENT run look like": { quadMode, pathCount, growthSteps }.
    // Replaces the old decodeType-plus-pathCountFor pairs at every call
    // site, because on the fast track quadMode varies BY LEVEL rather
    // than being fixed by the type string.
    function levelConfig(lev) {
        const decoded = decodeType(activeType);
        // First-run experiment variants (see the MARATHON.FIRST_RUN_*
        // comment in config.js). 'fast' routes through the tier machinery
        // below via onFirstRunFastTrack; 'standard' (and a missing
        // variant — stale cached config, defensive) falls through to the
        // normal ladder; 'extended' and 'single' get their own ladders
        // here. Growth accrues one step per solve in every variant — the
        // experiment only varies the PATH-COUNT axis, exactly like the
        // fast track always did.
        if (isFirstRunAutoStart && decoded.progressive) {
            if (firstRunVariant === 'extended') {
                const len = MARATHON.FIRST_RUN_EXTENDED_TIER_LENGTH || (MARATHON.TIER_LENGTH + 2);
                const paths = Math.min(MARATHON.MAX_PATHS, Math.floor((lev - 1) / len) + 1);
                return {
                    quadMode:    false,
                    pathCount:   paths,
                    growthSteps: growthStepsFor(lev, paths),
                    progressive: true
                };
            }
            if (firstRunVariant === 'single') {
                return {
                    quadMode:    false,
                    pathCount:   1,
                    growthSteps: lev - 1,
                    progressive: true
                };
            }
        }
        if (!onFirstRunFastTrack()) {
            const paths = pathCountFor(decoded, lev);
            return {
                quadMode:    decoded.quadMode,
                pathCount:   paths,
                growthSteps: decoded.progressive ? growthStepsFor(lev, paths) : lev - 1,
                progressive: decoded.progressive
            };
        }
        const singularLevels = firstRunSingularLevels();
        if (lev <= singularLevels) {
            const paths = firstRunPathCount(lev);
            return {
                quadMode:    false,
                pathCount:   paths,
                growthSteps: growthStepsFor(lev, paths),
                progressive: true
            };
        }
        // Quad phase. The run restarts the NORMAL progressive ladder in
        // quad mode from its own level 1, so the hand-off puzzle is a
        // 1-path 3×3-logical quad (the pre-built 'q' starter) and the
        // pace reverts to standard tiers from there — the fast track's
        // job (show every kind of play) is done by this point, and a
        // player still going at puzzle 20 wants the real game's cadence.
        const qLev  = lev - singularLevels;
        const paths = Math.max(MARATHON.FIRST_RUN_QUAD_RESET_PATHS || 1,
                               pathCountForLevel(qLev));
        return {
            quadMode:    true,
            pathCount:   paths,
            growthSteps: growthStepsFor(qLev, paths),
            progressive: true
        };
    }

    // 's'  → { quadMode: false, pathCount: null, progressive: true }
    // 's3' → { quadMode: false, pathCount: 3,    progressive: false }
    // Legacy 2-char types survive in old saved runs (loadRunSave) and
    // PotD's slot ids (which have their own decoder) — the fixed-path
    // branch keeps those resumable/replayable. For progressive types
    // pathCount is null; use pathCountFor(decoded, level).
    function decodeType(t) {
        const progressive = t.length === 1;
        return {
            quadMode:    t[0] === 'q',
            pathCount:   progressive ? null : parseInt(t[1], 10),
            progressive: progressive
        };
    }

    // Rolls the random growth axes ('r'/'c') until the sequence holds at
    // least `count` entries. Callers pass growthStepsForLevel(lev) (or
    // lev-1 for legacy fixed-path types); tier drops re-read the FIRST
    // entries, which stay pinned once rolled — pre-gen's lookahead and
    // the retrace-the-same-dims tier behavior both depend on that.
    // Same behavior for regular and quad (singular starts 4×4 logical,
    // quad 3×3; each quad step adds 2× sub-tiles per axis). No upper cap.
    function ensureGrowthSequence(count) {
        while (growthSequence.length < count) {
            // Random growth axis with a LONG-AXIS-FIRST invariant keyed to
            // the viewport: on landscape screens cols never fall behind
            // rows (grid meanders between square and WIDE), on portrait
            // screens rows never fall behind cols (square ↔ TALL) — growth
            // favors the axis the screen has room for, so cells shrink as
            // slowly as possible. At square, always grow the long axis;
            // once ahead, 50/50. History: plain 50/50 → wider-first
            // (2026-07-16, half of all runs started by growing taller,
            // which read wrong on landscape) → viewport-keyed (2026-07-17,
            // portrait support: unconditional wider-first shrank cells
            // fastest on a portrait phone's scarce axis). Orientation is
            // sampled per roll, so rotating mid-run steers only FUTURE
            // growth — already-rolled entries stay pinned (pre-gen's
            // lookahead depends on that).
            const rGrown = growthSequence.reduce((n, g) => n + (g === 'r' ? 1 : 0), 0);
            const cGrown = growthSequence.length - rGrown;
            const portrait   = window.innerHeight > window.innerWidth;
            const longAxis   = portrait ? 'r' : 'c';
            const shortAxis  = portrait ? 'c' : 'r';
            const longGrown  = portrait ? rGrown : cGrown;
            const shortGrown = portrait ? cGrown : rGrown;
            // Aspect cap (MARATHON.MAX_ASPECT_RATIO): if growing the long
            // axis would push it past ratio × the short one, the roll is
            // FORCED onto the short axis — no more ribbon grids, with the
            // allowed spread scaling as the grid grows (at the current
            // 1.5: 4×6 early, 10×15 late). Dims here = square start base
            // + grown counts, keyed to the SINGULAR base (4) on purpose:
            // the sequence is shared across modes (the fast track replays
            // its prefix in quad, which starts 3×3), so one base must
            // govern every roll — the ~1-unit skew this gives quad's cap
            // math is within the cap's aesthetic tolerance. Growing the
            // short axis can never violate the cap at base ≥3.
            // Enforced per roll, so every prefix of the sequence honors
            // the cap too (tier drops replay prefixes). After a device
            // rotation flips the long axis (or on a legacy pre-cap
            // sequence already past the ratio), the long-axis-first
            // branch + forced-short rolls converge the grid back toward
            // square as new entries are rolled.
            const base     = MARATHON.startDimsFor(false, 1).rows;  // square base (4)
            const longDim  = base + longGrown;
            const shortDim = base + shortGrown;
            let axis;
            if (longDim + 1 > shortDim * MARATHON.MAX_ASPECT_RATIO) {
                axis = shortAxis;
            } else if (longGrown > shortGrown && Math.random() < 0.5) {
                axis = shortAxis;
            } else {
                axis = longAxis;
            }
            growthSequence.push(axis);
        }
    }
    // Logical dims at `lev` for a level config (see levelConfig), which
    // has already resolved the tier sawtooth for progressive types and
    // the monotonic lev-1 for legacy fixed-path ones. The shared
    // growthSequence prefix means a tier drop retraces earlier dims
    // exactly — and, on the fast track, that the quad phase re-reads the
    // same rolled axes from the start.
    function dimsForLevel(lev, cfg) {
        const start = MARATHON.startDimsFor(cfg.quadMode, cfg.pathCount);
        const steps = cfg.growthSteps;
        ensureGrowthSequence(steps);
        let rowGrowth = 0, colGrowth = 0;
        for (let i = 0; i < steps; i++) {
            if (growthSequence[i] === 'r') rowGrowth++;
            else                           colGrowth++;
        }
        return {
            rows: start.rows + rowGrowth,
            cols: start.cols + colGrowth
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
    // matches the wantR/wantC it passes to newPuzzle. Each entry also
    // carries its OWN pathCount/quadMode: at a tier boundary the next
    // level's path count differs from the current one, and pre-gen must
    // build + cache under the future config, not the current globals.
    function upcomingDims(count) {
        if (state !== STATE.PLAYING) return [];
        const out = [];
        for (let i = 1; i <= count; i++) {
            const lev      = level + i;
            // Per-level config, not a once-per-call decode: on the
            // first-run fast track quadMode flips partway through the
            // lookahead window, and pre-gen must build each entry under
            // the config that level will actually run with.
            const cfg      = levelConfig(lev);
            const logical  = dimsForLevel(lev, cfg);
            const physRows = cfg.quadMode ? logical.rows * 2 : logical.rows;
            const physCols = cfg.quadMode ? logical.cols * 2 : logical.cols;
            out.push({
                rows: physRows, cols: physCols,
                pathCount: cfg.pathCount,
                quadMode:  cfg.quadMode
            });
        }
        return out;
    }

    // Per-puzzle fresh allotment under the difficulty-ramp model: starts at
    // MARATHON.START_TIME_*[pathCount-1] and shaves TIME_DECREASE_PER_SOLVE
    // seconds for every prior solve, floored at TIME_FLOOR. Singular is
    // additionally capped by TIME_PER_TILE_SINGULAR × logical tile count,
    // so the small 5×5 starts grant proportionally small time instead of
    // the full schedule value (which was tuned for 8×8-10×10 starts and
    // let players bank 20 minutes in a few levels). The cap stops binding
    // once grid growth crosses the declining schedule; quad starts never
    // shrank, so quad skips the cap. Banking is unlimited; the caller
    // just adds the result to timeRemaining with no cap.
    function timeForPuzzle(quadMode, pathCount, solvedCount, logicalDims) {
        const starts = quadMode ? MARATHON.START_TIME_QUAD : MARATHON.START_TIME_SINGULAR;
        const idx    = Math.max(0, Math.min(starts.length - 1, (pathCount | 0) - 1));
        let fresh    = starts[idx] - solvedCount * MARATHON.TIME_DECREASE_PER_SOLVE;
        if (!quadMode && logicalDims) {
            const cap = MARATHON.TIME_PER_TILE_SINGULAR[idx] * logicalDims.rows * logicalDims.cols;
            if (cap < fresh) fresh = cap;
        }
        return Math.max(MARATHON.TIME_FLOOR, Math.round(fresh)) * 1000;
    }

    // ----- Saved-run persistence (Continue-your-run) -----
    //
    // One save slot PER MODE (marathon / practice) so a quick Marathon
    // sprint can't clobber a 30-puzzle Zen run. Saved at every puzzle-
    // ready + solve boundary, on Quit, and on pagehide/tab-hide; cleared
    // on game-over and whenever a fresh run of the same mode starts.
    // The menu's Continue card (refreshContinueCards) offers the resume.
    //
    // Mid-puzzle saves carry the full board snapshot + the in-progress
    // recording, so a resume restores the exact state the player left —
    // no retry-scumming a bad puzzle by quitting (the clock and board
    // come back exactly as saved).

    function runSaveKey(mode) { return PROJECT_SLUG + '_run_save_' + mode + '_v1'; }
    function currentRunMode() { return isPractice ? 'practice' : 'marathon'; }

    function loadRunSave(mode) {
        try {
            const raw = localStorage.getItem(runSaveKey(mode));
            if (!raw) return null;
            const save = JSON.parse(raw);
            if (!save || save.v !== 1) return null;
            // 's'/'q' = progressive runs; the optional digit keeps saves
            // from before the progressive revamp (fixed-path 's1'..'q4')
            // resumable via decodeType's legacy branch.
            if (typeof save.type !== 'string' || !/^[sq][1-4]?$/.test(save.type)) return null;
            if (!(save.level >= 1)) return null;
            return save;
        } catch (e) { return null; }
    }
    function clearRunSave(mode) {
        try { localStorage.removeItem(runSaveKey(mode)); } catch (e) {}
        refreshContinueCards();
    }

    function saveRunState() {
        if (state !== STATE.PLAYING) return;
        // The one-time auto-start run is a menu-skipping tutorial surface,
        // not a run the player chose — a "Continue your run" card for it
        // on a brand-new player's second visit would only confuse.
        if (isFirstRunAutoStart) return;
        if (!activeType) return;
        // Nothing worth resuming yet: no solves banked and no moves made.
        // (Also keeps a fresh no-touch run from writing a "Puzzle 1" card.)
        const rec = (typeof Game !== 'undefined') ? Game.recording : null;
        if (solvedCount === 0 && !(rec && Array.isArray(rec.moves) && rec.moves.length > 0)) return;

        let saveLevel     = level;
        let saveRemaining = timeRemaining;
        const midPuzzle   = puzzleLive && !inTransition;
        if (!puzzleLive && !inTransition) {
            // Build in flight: startNextPuzzle already advanced `level` and
            // granted the next puzzle's fresh time, but that puzzle never
            // appeared. Roll both back so the boundary-resume's own
            // startNextPuzzle replays the grant exactly once. (The timer
            // never ticks during a build, so the subtraction is exact.)
            const cfg     = levelConfig(level);
            const logical = dimsForLevel(level, cfg);
            const fresh   = timeForPuzzle(cfg.quadMode, cfg.pathCount, solvedCount, logical);
            saveLevel     = level - 1;
            saveRemaining = Math.max(0, timeRemaining - fresh);
            if (saveLevel < 1 && solvedCount === 0) return;   // nothing to resume
        }

        const save = {
            v: 1,
            mode: currentRunMode(),
            type: activeType,
            level: saveLevel,
            solvedCount, hintsUsed, totalSolveTime,
            timeRemaining: saveRemaining,
            growthSequence: growthSequence.slice(),
            sessionToken, runStartedAtMs,
            // Practice never submits a score, so its completed-puzzle
            // recordings would persist for nothing — and Zen runs are
            // exactly the long ones that would bloat localStorage. The
            // CURRENT puzzle's recording (below) is still saved in both
            // modes; it's one puzzle and the resume continues its
            // timeline.
            recordings: isPractice ? [] : recordings,
            boundary: !midPuzzle,
            savedAtMs: Date.now(),
        };
        if (midPuzzle) {
            save.maze  = Maze.snapshotState();
            save.gates = (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null;
            save.recording = rec;
            save.puzzleElapsedMs = Math.max(0, Date.now() - puzzleStartMs);
        }
        try {
            localStorage.setItem(runSaveKey(save.mode), JSON.stringify(save));
        } catch (e) {
            // Quota — the accumulated recordings are far and away the
            // heaviest field. Drop them and retry: the resume still works,
            // the eventual score submit just ships without a replay.
            try {
                save.recordings = [];
                save.recordingsDropped = true;
                localStorage.setItem(runSaveKey(save.mode), JSON.stringify(save));
            } catch (e2) { /* storage truly unavailable — no resume */ }
        }
        refreshContinueCards();
    }

    // Resume a saved run. Boundary saves re-enter through startNextPuzzle
    // (fresh random puzzle — identical to what advance() would have
    // built); mid-puzzle saves restore the exact board, clock, and
    // in-progress recording the player left.
    function resumeRun(mode) {
        if (state !== STATE.MENU) return;
        const save = loadRunSave(mode);
        if (!save) { refreshContinueCards(); return; }

        isPractice          = mode === 'practice';
        isFirstRunAutoStart = false;
        deferredStartTracking = null;
        activeType     = save.type;
        level          = save.level;
        solvedCount    = save.solvedCount || 0;
        hintsUsed      = save.hintsUsed || 0;
        totalSolveTime = save.totalSolveTime || 0;
        timeRemaining  = save.timeRemaining || 0;
        growthSequence = Array.isArray(save.growthSequence) ? save.growthSequence : [];
        recordings     = Array.isArray(save.recordings) ? save.recordings : [];
        sessionToken   = save.sessionToken || null;
        runStartedAtMs = save.runStartedAtMs || 0;
        pendingHighlight = null;

        // Keep the mode picker (body class, subtitle, persisted pick) in
        // step with what's actually being played.
        if (typeof ModePicker !== 'undefined' && ModePicker.setMode) ModePicker.setMode(mode);

        // Same game-phase music handoff as startGame — see the comment
        // there for the iPad stop+start rationale.
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(false);
            const stillMenu = Music.isMenuSongPlaying && Music.isMenuSongPlaying();
            if (stillMenu && Music.stop) Music.stop();
            if (Music.start) Music.start();
        }
        // The original run's start was recorded in its own visit; this
        // visit's funnel needs its own "chose to play" milestone.
        if (typeof Tracking !== 'undefined' && Tracking.recordStart) {
            Tracking.recordStart(isPractice ? 'practice' : 'marathon', activeType);
            // First-time-player funnel: the auto-start run never saves,
            // so any resumed run is by definition outside it.
            if (Tracking.firstRunOutsideStart) Tracking.firstRunOutsideStart();
        }

        if (save.boundary || !save.maze) {
            // Between puzzles: startNextPuzzle owns level++, the fresh time
            // grant, HUD, state flip, and the build.
            startNextPuzzle();
        } else {
            state = STATE.PLAYING;
            puzzleLive = true;
            showOnly(hudEl);
            // Progressive types carry no fixed pathCount — derive both
            // the tier's count and the mode from the saved level (legacy
            // types pass through their fixed digit). Resumed runs are
            // never the auto-start one (it doesn't save), so levelConfig
            // takes its normal-progression branch here.
            const cfg = levelConfig(level);
            Maze.setQuadMode(cfg.quadMode);
            Maze.setPathCount(cfg.pathCount);
            Maze.loadSnapshot(save.maze);
            if (save.gates && typeof Gates !== 'undefined' && Gates.restore) {
                Gates.restore(save.gates);
                if (Maze.recompute) Maze.recompute();
            } else if (typeof Gates !== 'undefined' && Gates.clear) {
                Gates.clear();
            }
            Render.refit();
            Render.draw();
            // Same bypass-newPuzzle housekeeping PotD's snapshot load does:
            // SFX diff baselines, then adopt the saved recording (AFTER
            // loadSnapshot — restoreRecording anchors undo on the live
            // board).
            if (typeof Game !== 'undefined') {
                if (Game.resetSfxBaselines) Game.resetSfxBaselines();
                if (Game.restoreRecording)  Game.restoreRecording(save.recording || null);
            }
            const logical = {
                rows: cfg.quadMode ? save.maze.rows / 2 : save.maze.rows,
                cols: cfg.quadMode ? save.maze.cols / 2 : save.maze.cols,
            };
            updateHud(logical);
            if (hudHowTo) hudHowTo.hidden = true;
            // Same Pause/Quit label startNextPuzzle sets for normal runs —
            // a resumed run quits/checkpoints identically.
            if (hudQuit) {
                hudQuit.setAttribute('data-i18n', 'marathon.pauseQuit');
                hudQuit.textContent = I18n.t('marathon.pauseQuit');
            }
            // Clock resumes where it stopped; the current puzzle's solve
            // time keeps accruing from its pre-quit elapsed.
            puzzleStartMs = Date.now() - (save.puzzleElapsedMs || 0);
            if (!isPractice) startTimer();
            if (typeof Sfx !== 'undefined') Sfx.play('cinematic_bass');
            if (typeof CgSdk !== 'undefined') CgSdk.gameplayStart();
            if (typeof Tooltip !== 'undefined') scheduleLockTip();
            saveRunState();   // refresh savedAt so the slot reflects the live run
        }
    }

    // Menu Continue cards — one per saved mode, shown only on that mode's
    // tab (the player's persisted mode pick lands them on the right tab
    // anyway). Static label is data-i18n; the "Puzzle N · type" detail is
    // painted here.

    // i18n key for a run's type label at level `lev`. Legacy fixed-path
    // types map straight to their marathon.modeS1..modeQ4 key; progressive
    // types reuse the SAME 8 keys ("Singular · N paths" per language) with
    // the digit computed from the level's tier — no new translations.
    // pathCountForLevel clamps at MAX_PATHS, so the digit is always 1-4.
    // `cfg` (optional) = the levelConfig of the run actually in play. Pass
    // it for the LIVE run: the first-run fast track walks its own path
    // ladder and switches to quad tiles mid-run while activeType stays
    // 's', so neither the letter nor the digit can be read off the type
    // string there. Omit it for saved runs (refreshContinueCards), which
    // are never fast-tracked and whose level alone determines the tier.
    function typeLabelKey(type, lev, cfg) {
        if (type.length === 2) return 'marathon.mode' + type.toUpperCase();
        const letter = cfg ? (cfg.quadMode ? 'Q' : 'S') : type.toUpperCase();
        const paths  = cfg ? cfg.pathCount : pathCountForLevel(lev);
        return 'marathon.mode' + letter + paths;
    }

    function refreshContinueCards() {
        const picked = (typeof ModePicker !== 'undefined' && ModePicker.getMode)
            ? ModePicker.getMode() : 'practice';
        for (const mode of ['marathon', 'practice']) {
            const card = $('continueRunCard-' + mode);
            if (!card) continue;
            const save = loadRunSave(mode);
            const show = !!save && picked === mode;
            card.hidden = !show;
            if (show) {
                const detailEl = card.querySelector('.continueRunDetail');
                if (detailEl) {
                    // Boundary saves resume INTO level+1 (startNextPuzzle
                    // increments); mid-puzzle saves resume level itself.
                    const n = save.boundary ? save.level + 1 : save.level;
                    detailEl.textContent =
                        I18n.t('menu.continuePuzzle', { n: n })
                        + ' · ' + I18n.t(typeLabelKey(save.type, n));
                }
            }
        }
    }

    function startGame(type, practice, firstRunAutoStart) {
        isPractice       = !!practice;
        // Only autoStartFirstPractice passes the 3rd arg — every normal
        // start (menu card click) leaves it undefined, clearing the flag.
        isFirstRunAutoStart = !!firstRunAutoStart;
        // Choosing a fresh run of this mode abandons its saved one (the
        // Continue card was right there). The OTHER mode's save survives —
        // one slot per mode.
        clearRunSave(practice ? 'practice' : 'marathon');
        runStartedAtMs   = Date.now();
        activeType       = type;
        sessionToken     = null;  // cleared until /api/game/start resolves
        level            = 0;
        solvedCount      = 0;
        hintsUsed        = 0;     // fresh hint count per run, bumped by onHintUsed
        totalSolveTime   = 0;
        timeRemaining    = 0;     // first puzzle gets only its fresh allotment, no carry-over
        recordings       = [];    // fresh recording buffer for this game
        pendingHighlight = null;  // any prior-game highlight is stale once a new run begins
        growthSequence   = [];    // fresh random row/col growth sequence per game
        // Switch music to game phase — next pickNext (when the current
        // menu song ends, or on a skip) will pull from the intro/shuffle
        // pool instead of the menu_only pool. start() is still called so
        // music kicks in if it wasn't already (e.g. player toggled music
        // on for the first time at game start, after declining at intro).
        // Stop+start when a menu song is still playing: setMenuPhase only
        // flips a flag — it doesn't actively change the currently-playing
        // song. On most browsers Music.start() falls through to
        // advanceToNext (audio.paused === false because music's been
        // playing) and picks a fresh game-pool song. But iPad Safari can
        // leave the audio briefly paused by the time we get here, which
        // makes Music.start() take its resume branch and just un-pause
        // the SAME menu song — the player keeps hearing menu music
        // throughout the game. Forcing a stop+start when
        // isMenuSongPlaying() reports true clears the audio src so the
        // next start() advances. Mirrors the inverse pattern used by
        // goToMenu (game→menu).
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(false);
            const stillMenu = Music.isMenuSongPlaying && Music.isMenuSongPlaying();
            if (stillMenu && Music.stop) Music.stop();
            if (Music.start) Music.start();
        }
        // Engagement tracking: one start per game (not per puzzle). Practice
        // reports its own mode so the funnel can tell the two apart.
        // EXCEPT the first-visit auto-start: the player didn't pick this
        // game — we dropped them in — so "started" is deferred until their
        // first committed puzzle action (notifyPuzzleInteraction, called by
        // game.js recordMove). No interaction → no start recorded; the
        // visit stays a reached-menu-only row in the funnel.
        deferredStartTracking = null;
        if (typeof Tracking !== 'undefined' && Tracking.recordStart) {
            if (isFirstRunAutoStart) {
                deferredStartTracking = { mode: isPractice ? 'practice' : 'marathon', gameType: type };
            } else {
                Tracking.recordStart(isPractice ? 'practice' : 'marathon', type);
                // First-time-player funnel: a menu-chosen start is play
                // OUTSIDE the initial auto-start run (no-op unless this
                // browser was a tracked first-timer).
                if (Tracking.firstRunOutsideStart) Tracking.firstRunOutsideStart();
            }
        }
        // Fire-and-forget: ask the server for a cheat-proof timing token.
        // Game continues regardless — if the request fails (offline / cold
        // back-end / network blip) we stay with sessionToken=null and the
        // submit will fall through to the local-fallback path with no
        // public leaderboard entry. Better than blocking play on a flaky
        // request, and the front-end already handles local-only saves.
        // Skipped entirely in Practice — it never submits a score.
        if (!isPractice) requestSessionToken(type);
        startNextPuzzle();
    }

    // One-time first-visit auto-start: skip the menu and drop a brand-new
    // player straight into the gentlest puzzle (1-path singular Zen, 5×5
    // via MARATHON.startDimsFor) so they see gameplay before ever
    // having to decode the menu's mode/type choices. Called by intro.js at
    // the two "player just cleared the intro" points (the I-agree dismiss,
    // and the CrazyGames auto-skip bail where there is no intro). Returns
    // true when it started a game — the caller then skips its own menu-music
    // startup, since startGame already handles the game-phase music.
    //
    // "First visit" = none of: the consumed flag, a saved mode pick, or a
    // saved leaderboard name. The extra two keys stop the auto-start from
    // surprising RETURNING players who predate this feature (they know the
    // menu already). Players who visited before but never touched either
    // key get one auto-start into Practice — which is where the menu's
    // default card would have landed them anyway.
    //
    // localStorage-unavailable (private mode, quota): bail to the menu.
    // Without storage the flag can't persist, and auto-starting EVERY visit
    // would lock repeat private-mode players out of the menu flow.
    function autoStartFirstPractice() {
        if (state !== STATE.MENU) return false;
        const slug = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness');
        let seen;
        try {
            seen = localStorage.getItem(AUTO_START_KEY)
                || localStorage.getItem(slug + '_mode')
                || localStorage.getItem(slug + '_lastPlayerName');
        } catch (e) { return false; }
        if (seen) return false;
        // Consume BEFORE starting: if startGame throws for any reason we
        // still never re-trigger, and the player gets the normal menu on
        // their next load rather than a repeating broken auto-start.
        try { localStorage.setItem(AUTO_START_KEY, '1'); } catch (e) {}
        // Draw this player's ladder variant BEFORE opening the stats row
        // so the row is stamped with it from the first sync (the A/B/C/D
        // engagement comparison keys off that stamp).
        const variant = pickFirstRunVariant();
        // First-time-player funnel: this is the ONE moment we know the
        // browser is brand new, so open its FirstRunStats row now — a
        // player who bails without touching anything should still count
        // (as 0 initial-run puzzles), unlike the deferred recordStart
        // below which deliberately requires an interaction.
        if (typeof Tracking !== 'undefined' && Tracking.firstRunBegin) {
            Tracking.firstRunBegin(variant);
        }
        startGame('s', true, true);
        return true;
    }

    // Called by game.js recordMove on every committed live puzzle action
    // (rotate / gate / lock / hint — replays never reach recordMove). Only
    // meaningful while startGame has a deferred auto-start "started"
    // milestone parked; a no-op the rest of the time. One-shot: clears the
    // slot BEFORE the PATCH so a re-entrant call can't double-record.
    function notifyPuzzleInteraction() {
        if (!deferredStartTracking) return;
        const d = deferredStartTracking;
        deferredStartTracking = null;
        if (typeof Tracking !== 'undefined' && Tracking.recordStart) {
            Tracking.recordStart(d.mode, d.gameType);
        }
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

    // `spinFromSolved` — true only on the advance() path, where the
    // just-solved board is still painted on the canvas: snapshot it and
    // send it tumbling into the distance (Render.spinOutBoard) before the
    // startPuzzle callback blanks the canvas for the build. The matching
    // spin-IN fires from onPuzzleReady via Render.spinInBoard. First
    // puzzles (startGame) and resume boundaries pass nothing — there's no
    // solved board to spin away, but the arriving puzzle still tumbles IN
    // like every later one (primeSpinIn hides the build behind the same
    // hold class with the spin-out window pre-elapsed).
    function startNextPuzzle(spinFromSolved) {
        if (spinFromSolved && typeof Render !== 'undefined' && Render.spinOutBoard) {
            Render.spinOutBoard();
        } else if (typeof Render !== 'undefined' && Render.primeSpinIn) {
            Render.primeSpinIn();
        }
        // Pause the clock during the build — would otherwise eat into the
        // player's allotment for the puzzle they can't even see yet.
        // Restarts in onPuzzleReady once the new puzzle is on-screen.
        stopTimer();
        // Build starting — the previous board is no longer the live
        // puzzle. saveRunState treats the build window as a boundary
        // (with the level/time grant below rolled back).
        puzzleLive = false;

        level++;
        const cfg       = levelConfig(level);
        const paths     = cfg.pathCount;
        const logical   = dimsForLevel(level, cfg);
        const physRows  = cfg.quadMode ? logical.rows * 2 : logical.rows;
        const physCols  = cfg.quadMode ? logical.cols * 2 : logical.cols;

        // Carry-over + fresh allotment. solvedCount = (level - 1) here
        // (incremented in onSolve before the player advances). No cap on
        // banking — the running total just grows. `logical` feeds the
        // singular size cap on fresh time. Progressive runs' path-indexed
        // START_TIME arrays give a natural bump at each tier-up.
        const fresh = timeForPuzzle(cfg.quadMode, paths, solvedCount, logical);
        timeRemaining = timeRemaining + fresh;

        state = STATE.PLAYING;
        showOnly(hudEl);
        updateHud(logical);
        // First-visit auto-start run: surface the How-to-Solve button in the
        // HUD (the player never saw the menu's one). It occupies the timer's
        // center slot — always free here because the auto-start run is
        // Practice, and Practice hides #hudTimer (body.mode-practice CSS).
        // Held back until the firstPlay tip has been acknowledged — the tip
        // carries its own How-to-Solve action button, and its onAcknowledge
        // hook (see onPuzzleReady) reveals this one the moment the tip is
        // dismissed. Without the gate, both would be on-screen at once and
        // the HUD button would upstage the tip that's introducing it.
        // Tooltip-less fallback (stale cached page): button shows as before.
        const firstPlayAcked = (typeof Tooltip === 'undefined') || !Tooltip.isSeen
            || Tooltip.isSeen('firstPlay');
        if (hudHowTo) hudHowTo.hidden = !isFirstRunAutoStart || !firstPlayAcked;
        // Same run: "Quit" would read as "leave the game" to a player who
        // doesn't know a menu exists — relabel it to advertise that the
        // menu (PotD / Marathon / quad types) is behind it. The data-i18n
        // attribute is swapped too so a mid-run language change re-renders
        // the right string. Restored by goToMenu and by any normal start
        // (isFirstRunAutoStart false → pause/quit branch).
        // Normal Marathon/Zen runs say "Pause/Quit" — quitting checkpoints
        // the run (saveRunState) rather than abandoning it. PotD keeps the
        // plain marathon.quit label via goToMenu's restore, since its quit
        // genuinely discards the attempt.
        if (hudQuit) {
            const quitKey = isFirstRunAutoStart ? 'marathon.moreModes' : 'marathon.pauseQuit';
            hudQuit.setAttribute('data-i18n', quitKey);
            hudQuit.textContent = I18n.t(quitKey);
        }

        if (callbacks.startPuzzle) {
            callbacks.startPuzzle({
                rows:      physRows,
                cols:      physCols,
                pathCount: paths,
                quadMode:  cfg.quadMode
            });
        }
        // Timer starts when puzzle is actually on-screen (onPuzzleReady).
    }

    // Called from game.js once newPuzzle's worker build has loaded a snapshot
    // and the puzzle is visible. Anchors the per-puzzle clock and starts the
    // countdown so build time isn't deducted from the player's allotment.
    function onPuzzleReady() {
        if (state !== STATE.PLAYING) return;
        puzzleLive = true;
        // Kick the 3D spin-IN if a spin-out (advance) or primed run-start
        // spin (startNextPuzzle) is pending (returns the ms until the
        // board is fully visible; 0 when no spin — mid-puzzle resumes,
        // reduced-motion). The puzzle clock is anchored
        // and started AFTER that window so the transition never eats
        // Marathon play time: puzzleStartMs shifts forward by the delay,
        // and startTimer waits it out (guarded — a quit during the few
        // hundred ms must not start a timer on the menu).
        const spinDelayMs = (typeof Render !== 'undefined' && Render.spinInBoard)
            ? Render.spinInBoard() : 0;
        puzzleStartMs = Date.now() + spinDelayMs;
        // Checkpoint the run at every puzzle boundary — a crash or killed
        // tab from here on resumes at this puzzle instead of losing the run.
        saveRunState();
        // Practice is untimed — no countdown, so the game only ever ends when
        // the player quits. Marathon starts its per-puzzle clock here.
        if (!isPractice) {
            if (spinDelayMs > 0) {
                const spinLevel = level;
                setTimeout(function () {
                    if (state === STATE.PLAYING && puzzleLive
                        && level === spinLevel && !isPractice) {
                        startTimer();
                    }
                }, spinDelayMs);
            } else {
                startTimer();
            }
        }
        // Fires immediately — deliberately overlapping the outbound
        // tumble (user-tuned: tried at tumble-start and at settle, the
        // original immediate timing felt best).
        if (typeof Sfx !== 'undefined') Sfx.play('cinematic_bass');
        // CrazyGames engagement signal (no-op off-CG). Deduped internally, so
        // firing on every puzzle of a run is fine; the state-PLAYING guard
        // above keeps replays (state REPLAYING) from ever reporting.
        if (typeof CgSdk !== 'undefined') CgSdk.gameplayStart();
        // One-time PotD nudge for the first-visit auto-start run: fires as
        // puzzle 5 appears — i.e. right after the player's FOURTH SOLVE —
        // in EVERY ladder variant. This is the retention pitch the
        // auto-start otherwise hides (a menu-skipping first-timer never
        // sees the Puzzle of the Day exists). History: puzzle 3
        // (2026-07-22 original) → first 3-path solve (user call: let them
        // grasp that paths ramp too) → first 2-path solve (2026-07-23:
        // proves the multi-path mechanic landed) → FIXED at 4 solves
        // (2026-07-29, user call): the ladder A/B/C/D experiment made a
        // path-count trigger uneven — the 'single' variant never reaches
        // 2 paths at all — and a variant-independent trigger keeps the
        // nudge column comparable across variants. The shallow-quit case
        // is covered by the SAME-KEY pitch in quitToMenu — whichever
        // surface fires first wins, the seen-flag silences the other. The
        // action jumps straight into today's 1-path daily: tear the Zen
        // run down, flip the picker, start the slot.
        if (isFirstRunAutoStart && level === 5
            && typeof Tooltip !== 'undefined' && Tooltip.showOnce) {
            Tooltip.showOnce('potdNudge', I18n.t('tooltip.potdNudge'), {
                label: I18n.t('mode.potd.name'),
                onClick: function () {
                    // First-time-player funnel: the nudge converted.
                    if (typeof Tracking !== 'undefined' && Tracking.firstRunNudgeClicked) {
                        Tracking.firstRunNudgeClicked();
                    }
                    quitToMenu();
                    if (typeof ModePicker !== 'undefined' && ModePicker.setMode) ModePicker.setMode('potd');
                    if (typeof Potd !== 'undefined' && Potd.startPuzzle) Potd.startPuzzle('s1');
                }
            });
        }
        // Background shuffle has already fired at the START of the build
        // (in game.js startPuzzle callback) so the new image is visible
        // throughout the "Building puzzle…" wait — not after it.
        // First-play educational tooltips:
        //   • firstPlay — the goal statement for brand-new players. The
        //     auto-start run skips the menu AND the tutorial, so without
        //     this the very first puzzle appears with zero explanation of
        //     what to do. Queued first so it outranks anything else that
        //     fires this puzzle; showOnce's seen-flag ends it, and a
        //     dismiss-by-transition (solve before Got It) re-fires it on
        //     the next auto-start puzzle by design.
        //   • marathonHint — appears immediately so the player reads it
        //     before they start tapping tiles (the 25%-time penalty info
        //     is most useful BEFORE the timer is ticking on real moves).
        //   • lockTile — scheduled 30s in so it appears once the player
        //     is mid-solve and has plausibly noticed they want to lock a
        //     tile in place. Cancelled if the puzzle ends first.
        // (A quad-tiles explainer tooltip briefly lived here — fired on
        // the first quad puzzle after the fast-track hand-off. Removed by
        // user call 2026-07-28: conceptually the player is still twisting
        // one unified tile, and describing the four sub-tiles' position
        // shuffle explains the implementation, not the experience. The
        // solve-card's "New tile type" cue is announcement enough; don't
        // re-add without a rethink.)
        if (typeof Tooltip !== 'undefined') {
            if (isFirstRunAutoStart) {
                // Action button opens the How-to-Solve tutorial straight
                // from the tip (label reuses the tutorial.menuButton key —
                // same wording as the HUD button it previews). The
                // onAcknowledge hook reveals the in-HUD How-to-Solve
                // button the moment EITHER button dismisses the tip — the
                // button stays hidden until then (see the hudHowTo gating
                // in the HUD-setup block above) so the tip is the one
                // thing introducing it.
                Tooltip.showOnce('firstPlay',
                    (typeof I18n !== 'undefined' && I18n.t)
                        ? I18n.t('tooltip.firstPlay')
                        : 'Twist the tiles to connect the path and complete the circuit!',
                    {
                        label: (typeof I18n !== 'undefined' && I18n.t)
                            ? I18n.t('tutorial.menuButton')
                            : '❓ How to Solve',
                        onClick: function () {
                            if (inTransition) return;
                            if (typeof Tutorial !== 'undefined' && Tutorial.open) Tutorial.open();
                        }
                    },
                    function () {
                        if (hudHowTo && isFirstRunAutoStart) hudHowTo.hidden = false;
                    });
            }
            // The marathonHint tip is all about the 25%-time penalty, which
            // doesn't exist in Practice (untimed, free hints) — skip it there.
            // The lock tip is still relevant to both modes.
            if (!isPractice) {
                Tooltip.showOnce('marathonHint',
                    (typeof I18n !== 'undefined' && I18n.t)
                        ? I18n.t('tooltip.marathonHint')
                        : 'Use HINT for help strategically, as it will cost you 25% of your remaining time every time you use it');
            }
            scheduleLockTip();
        }
    }
    // Lock-tip scheduling — see onPuzzleReady comment. Stored in a
    // module-level handle so quit / game-over paths can cancel before
    // the timer fires (otherwise the lock tip would pop up over the
    // menu or game-over screen, where it's contextually wrong).
    let lockTipTimerHandle = null;
    const LOCK_TIP_DELAY_MS = 30000;
    function scheduleLockTip() {
        cancelLockTip();
        if (typeof Tooltip === 'undefined' || Tooltip.isSeen('lockTile')) return;
        lockTipTimerHandle = setTimeout(function () {
            lockTipTimerHandle = null;
            // Re-check the state — the player may have quit between
            // the scheduling and the firing. Only show during PLAYING.
            if (state !== STATE.PLAYING) return;
            // Never fire under the How-to-Solve overlay: the tutorial is
            // teaching this exact lesson in richer form RIGHT NOW, and a
            // tip queued here would greet the player the moment they
            // close it (seen in the wild 2026-07-26 — the 30s timer beat
            // a slow read of the tutorial). Finishing the tutorial sets
            // the watched flag that suppresses this tip for good; an
            // early close just lets the next puzzle reschedule.
            if (typeof Tutorial !== 'undefined' && Tutorial.isOpen && Tutorial.isOpen()) return;
            Tooltip.showOnce('lockTile',
                (typeof I18n !== 'undefined' && I18n.t)
                    ? I18n.t('tooltip.lockTile')
                    : 'If you are sure that a tile is rotated correctly, you can press and hold to lock it in place (along with its twin, if it has one)');
        }, LOCK_TIP_DELAY_MS);
    }
    function cancelLockTip() {
        if (lockTipTimerHandle !== null) {
            clearTimeout(lockTipTimerHandle);
            lockTipTimerHandle = null;
        }
        // Also drop any already-queued lock-tip (queued but not yet shown).
        if (typeof Tooltip !== 'undefined' && Tooltip.cancelPending) {
            Tooltip.cancelPending('lockTile');
        }
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
        // Practice has no clock and no leaderboard, so hints are free: no
        // time penalty, no run-wide hint count to track. The hint itself is
        // applied by game.js regardless — this hook only owns the cost.
        if (isPractice) return;
        // Bump the run-wide hint counter BEFORE applying the time penalty.
        // Order doesn't matter functionally — they're independent — but
        // counting first means the increment happens unconditionally
        // (even if the penalty math somehow throws), which keeps the
        // leaderboard count truthful.
        hintsUsed += 1;
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

    // Twists-vs-minimum stats for the Zen solve popup. Player count =
    // every committed action that physically twisted the board: tile and
    // gate rotations, undos (an undo spins the board back — rotating a
    // wrong tile and taking it back cost two twists), and resets (one
    // twist each, same rationale — and crucially a reset never REFUNDS
    // the moves it wipes; they're already in the recording and stay
    // counted). Pure lock moves are
    // free. Hints don't count as twists — they VOID the stat: any hint in
    // the recording hides the line entirely (see below). The floor comes
    // from the recording (game.js
    // stamps minMoves at startRecording) so it survives the saved-run
    // resume round-trip. Returns null — caller hides the line — when
    // either side is unavailable (e.g. a run saved before the feature).
    function solveMoveStats() {
        const rec = (typeof Game !== 'undefined') ? Game.recording : null;
        if (!rec || typeof rec.minMoves !== 'number' || rec.minMoves <= 0) return null;
        let moves = 0;
        for (const m of rec.moves) {
            // ANY hint use suppresses the whole line (return null →
            // caller hides it): the twists-vs-minimum stat is a measure
            // of the player's own solving, and a hint-assisted puzzle
            // isn't that — hint-spamming to the solution used to print
            // "Perfect — solved in the minimum twists!" (user-reported).
            // Deliberately includes 0-turn hints: the tile was already
            // right, but the player didn't know that without help.
            if (m.type === 'hint') return null;
            if (m.type === 'rotate' || m.type === 'gate' || m.type === 'undo'
                || m.type === 'reset') moves++;
        }
        if (moves <= 0) return null;
        return { moves, min: rec.minMoves };
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

        // First-time-player funnel: a solve inside the auto-start run
        // advances the initial-run puzzle count; any other run's solve is
        // "outside the initial run" (both calls no-op unless this browser
        // was a tracked first-timer — see tracking.js). PotD solves make
        // the matching outside call in potd.js onSolve.
        if (typeof Tracking !== 'undefined') {
            if (isFirstRunAutoStart) {
                if (Tracking.firstRunPuzzleSolved) Tracking.firstRunPuzzleSolved();
            } else if (Tracking.firstRunOutsideSolve) {
                Tracking.firstRunOutsideSolve();
            }
        }

        // Practice never reaches gameOver() (it's untimed and ends only on
        // Quit), so the engagement funnel's "finished" milestone — which
        // Marathon fires from gameOver() — would otherwise never fire for the
        // now-default Practice mode, leaving Practice play as "started, never
        // finished". Fire it on the FIRST Practice solve so the visit is
        // marked finished. We only care that the visitor finished *a* puzzle,
        // not how many — and the server's /finished flag is a sticky per-visit
        // boolean anyway — so gating on solvedCount === 1 records exactly the
        // signal we want without re-PATCHing on every subsequent solve.
        if (isPractice && solvedCount === 1 &&
            typeof Tracking !== 'undefined' && Tracking.recordFinish) {
            Tracking.recordFinish();
        }

        // Audio-context tally: was music / SFX audible at the moment of
        // this solve? Fired on EVERY solve (marathon + practice) — the
        // stat is per-puzzle, not per-visit. Replays never reach onSolve
        // (the STATE.PLAYING guard at the top), so watched replays don't
        // count. Missing module/getter defaults to "off" — matches the
        // no-audio experience the player actually had.
        // isEffectivelyMuted (not isMuted) so the CrazyGames container mute
        // counts as "off" — a CG player is far likelier to hit the site's
        // mute button than to open our Settings, and the stat's question is
        // whether audio was AUDIBLE, not what the in-game toggle says.
        if (typeof Tracking !== 'undefined' && Tracking.recordSolve) {
            Tracking.recordSolve(
                (typeof Music !== 'undefined' && Music.isEffectivelyMuted) ? !Music.isEffectivelyMuted() : false,
                (typeof Sfx   !== 'undefined' && Sfx.isEffectivelyMuted)   ? !Sfx.isEffectivelyMuted()   : false,
                // Alternate-solve telemetry: did the winning route differ
                // from the designed one? (Measures how often alternates
                // actually happen in the wild — see Maze.solvedViaAlternate.)
                (typeof Maze !== 'undefined' && Maze.solvedViaAlternate) ? Maze.solvedViaAlternate() : false
            );
        }

        // Project the next puzzle's starting clock for the transition popup.
        // solvedCount was just incremented above, so it already reflects
        // the "puzzles solved BEFORE the next one starts" count that
        // timeForPuzzle wants. The next puzzle's dims (level + 1 — level
        // itself increments in startNextPuzzle) feed the singular size
        // cap; dimsForLevel is deterministic, so this projection matches
        // what startNextPuzzle will grant. No cap on banking — all of
        // leftover carries.
        const curCfg      = levelConfig(level);
        const nextCfg     = levelConfig(level + 1);
        const nextPaths   = nextCfg.pathCount;
        const nextLogical = dimsForLevel(level + 1, nextCfg);
        const fresh       = timeForPuzzle(nextCfg.quadMode, nextPaths, solvedCount, nextLogical);
        const nextStart = timeRemaining + fresh;
        const bankedMs  = timeRemaining;

        // Build + show the transition popup. Headline names the puzzle that
        // was just solved; subline tells the player what they're carrying
        // into the next puzzle.
        if (solveTransitionEl && solveHeadline && solveBanked) {
            solveHeadline.textContent = I18n.t('marathon.solveHeadline', { n: level });
            // Tier-up cue: the NEXT puzzle steps the path count up (a
            // progressive-run tier boundary). Announce it on the popup so
            // the jump doesn't read as a random difficulty spike; hidden
            // on every ordinary advance and always for legacy runs.
            if (solveTierUp) {
                // Two mutually-exclusive cues share this slot. The quad
                // hand-off (fast track only) takes precedence and is
                // checked first: at that boundary the path count RESETS
                // to 1, so the tier-up test below is false anyway — but
                // the switch to a brand-new mechanic is the bigger news
                // and must be announced, or the next board looks broken.
                const quadUp = nextCfg.quadMode && !curCfg.quadMode;
                const tierUp = !quadUp && nextCfg.progressive && nextPaths > curCfg.pathCount;
                solveTierUp.hidden = !(quadUp || tierUp);
                solveTierUp.classList.toggle('quadReveal', quadUp);
                if (quadUp) {
                    solveTierUp.textContent = I18n.t('marathon.solveQuadUp');
                } else if (tierUp) {
                    solveTierUp.textContent = I18n.t('marathon.solveTierUp', { n: nextPaths });
                }
            }
            if (isPractice) {
                // No clock to bank — just confirm the count and prompt the
                // player onward. #solveContinue already shows "Tap to continue".
                solveBanked.textContent = I18n.t('marathon.solvePractice', { n: solvedCount });
                // Zen moves feedback: twists made vs the scramble's floor.
                // Game.recording is still the just-solved puzzle's here —
                // the next startRecording only fires in startNextPuzzle.
                // "moves <= min" (not ===) counts as perfect: beating the
                // floor is only possible via an alternate completion the
                // generator failed to suppress, and that deserves the
                // gold line, not a broken-looking "24 · minimum: 26".
                if (solveMoves) {
                    const stats = solveMoveStats();
                    solveMoves.hidden = !stats;
                    if (stats) {
                        const perfect = stats.moves <= stats.min;
                        solveMoves.classList.toggle('perfect', perfect);
                        // Solve rate = minimum / twists, so fewer wasted
                        // twists reads as a higher score. The perfect line
                        // omits it — it's 100% by definition, and beating
                        // the floor would print an odd >100%.
                        solveMoves.textContent = perfect
                            ? I18n.t('marathon.solveMovesPerfect', { m: stats.moves })
                            : I18n.t('marathon.solveMoves', {
                                  m: stats.moves,
                                  b: stats.min,
                                  p: Math.round(stats.min / stats.moves * 100)
                              });
                    }
                }
            } else {
                if (solveMoves) solveMoves.hidden = true;
                const tStr = fmtTime(nextStart);
                const bSec = Math.floor(bankedMs / 1000);
                if (bSec > 0) {
                    solveBanked.textContent = I18n.t('marathon.solveBankedFull', { b: bSec, t: tStr });
                } else {
                    solveBanked.textContent = I18n.t('marathon.solveBankedZero', { t: tStr });
                }
            }
            // Delay the popup so the completed (gold) puzzle stays visible
            // for a moment first — the win SFX still fires immediately above.
            // A tap during the delay reveals it early (see advance()).
            const delay = (typeof SOLVE_REVEAL_DELAY_MS === 'number') ? SOLVE_REVEAL_DELAY_MS : 0;
            if (solvePopupTimer !== null) clearTimeout(solvePopupTimer);
            if (delay > 0) {
                solvePopupTimer = setTimeout(showSolveTransition, delay);
            } else {
                showSolveTransition();
            }
        }

        // No auto-timeout — player taps (popup or canvas) to call advance().

        // Boundary checkpoint: the solve (and its recording) is banked, so
        // quitting/crashing during the transition popup resumes into the
        // NEXT puzzle rather than replaying this one.
        saveRunState();
    }

    function gameOver() {
        state = STATE.GAME_OVER;
        puzzleLive = false;
        // The run ended for real — nothing to continue.
        clearRunSave(currentRunMode());
        stopTimer();
        clearTransition();
        // Cancel the pending lock-tip timer so it can't fire over the
        // game-over screen.
        cancelLockTip();
        // Drop any active tooltip too — the game-over screen + end-
        // credits roll shouldn't have a play-time tip sitting on top of
        // them. Pass false so the tip isn't marked seen; it'll fire
        // again on the player's next puzzle.
        if (typeof Tooltip !== 'undefined' && Tooltip.dismissActive) {
            Tooltip.dismissActive(false);
        }
        if (callbacks.quit) callbacks.quit();
        // Stop gameplay music; the end-credits sequence will start its own
        // credits track a beat later (Credits.start schedules the music swap).
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        // Engagement tracking: finish fires on game-over (time runs out
        // or zero-solve quit triggers it). Sticky server-side — only the
        // first finish per visit lands in the funnel.
        if (typeof Tracking !== 'undefined' && Tracking.recordFinish) Tracking.recordFinish();
        // Share popup gate (Share module owns the dismissal + count).
        if (typeof Share !== 'undefined' && Share.maybeShowPopup) Share.maybeShowPopup();
        // CrazyGames engagement signal (no-op off-CG): the run is over — the
        // game-over card / credits roll isn't active play.
        if (typeof CgSdk !== 'undefined') CgSdk.gameplayStop();
        // Zero-solve game-overs aren't eligible to rank, so fire the
        // "no rank" SFX immediately. For non-zero scores we wait for
        // the leaderboard fetch in renderGameOver — the right SFX
        // depends on the rank.
        if (typeof Sfx !== 'undefined') {
            Sfx.stopLoop('glitch_overlap');
            if (solvedCount === 0) {
                Sfx.play(['fail_long', 'audience_disappointed']);
            }
        }
        renderGameOver();
        showOnly(gameOverEl);
        // Roll the end credits behind the game-over card. body.credits-rolling
        // (set by Credits.start) repositions #gameOver into the upper third
        // and strips its full-screen backdrop so the scroll is visible.
        if (typeof Credits !== 'undefined' && Credits.start) Credits.start();
    }

    function quitToMenu() {
        // First-run auto-start quit (the "📅 Daily & More" button): the one
        // graceful exit every SHALLOW first session passes through — the
        // in-run nudge (onPuzzleReady, first 2-path solve) never fires for
        // players who leave earlier than that. Capture the state before
        // the teardown below mutates it; the pitch itself fires after
        // goToMenu so it overlays the menu. SAME seen-key as the in-run
        // nudge — whichever surface fires first wins, so no player ever
        // sees the pitch twice.
        const pitchOnMenu = isFirstRunAutoStart && state === STATE.PLAYING;
        // Quit no longer abandons the run — checkpoint it first so the
        // menu offers Continue. (No-op unless a run is actually in
        // progress; the auto-start run and zero-progress runs are
        // filtered inside saveRunState.)
        saveRunState();
        clearTransition();
        if (callbacks.quit) callbacks.quit();
        // Kill any sustained SFX loops (currently just 'glitch_overlap', but
        // stopAllLoops is forward-safe for future sustained cues). Without
        // this, quitting mid-puzzle while paths were overlapping leaves the
        // glitch loop running on the main menu indefinitely.
        if (typeof Sfx !== 'undefined' && Sfx.stopAllLoops) Sfx.stopAllLoops();
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        // If the player quit mid-game-over (or credits were rolling for any
        // other reason), tear the credits down before returning to menu.
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
        goToMenu();
        if (pitchOnMenu && typeof Tooltip !== 'undefined' && Tooltip.showOnce) {
            Tooltip.showOnce('potdNudge', I18n.t('tooltip.potdNudge'), {
                label: I18n.t('mode.potd.name'),
                onClick: function () {
                    // First-time-player funnel: the nudge converted (menu
                    // pitch variant — same flag as the in-run variant,
                    // they're mutually exclusive per player via the
                    // shared seen-key).
                    if (typeof Tracking !== 'undefined' && Tracking.firstRunNudgeClicked) {
                        Tracking.firstRunNudgeClicked();
                    }
                    // Already at the menu — just flip the tab and start
                    // the easiest daily slot (same landing as the in-run
                    // nudge's action).
                    if (typeof ModePicker !== 'undefined' && ModePicker.setMode) ModePicker.setMode('potd');
                    if (typeof Potd !== 'undefined' && Potd.startPuzzle) Potd.startPuzzle('s1');
                }
            });
        }
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
        // Progressive runs re-render this on every startNextPuzzle, so the
        // label's path digit tracks the current tier automatically.
        hudType.textContent  = I18n.t(typeLabelKey(activeType, level, levelConfig(level)));
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

    // ----- iOS-standalone on-screen keyboard -----
    // Mirrors TANTЯO's pattern (leaderboard.js): iOS PWAs in standalone
    // ("Add to Home Screen") mode don't reliably surface the system
    // keyboard when an input gets focus — so we build a custom one and
    // set the input to readOnly to suppress the (missing) native
    // keyboard cue. Desktop + Android + iOS-Safari-non-standalone all
    // get the native keyboard path (no custom UI).
    //
    // window.navigator.standalone === true ONLY for iOS PWA standalone.
    // We don't paint the keyboard otherwise.
    const KBD_ID = 'customKeyboard';
    // Tracks which input the on-screen keyboard is currently bound to so
    // teardown can restore that input's state (readOnly, placeholder)
    // without each caller having to remember a ref. Set in setup, cleared
    // in teardown — null when no keyboard is up.
    let mobileKeyboardOwnerInput = null;
    function isStandaloneIos() {
        return !!(window.navigator && window.navigator.standalone);
    }
    function teardownMobileKeyboard() {
        const kbd = document.getElementById(KBD_ID);
        if (kbd) kbd.remove();
        // Restore the owner input's editability so a later non-standalone
        // session (different browser / same input element) gets native
        // keyboard back. The placeholder reset is harmless when not
        // applicable.
        if (mobileKeyboardOwnerInput) {
            mobileKeyboardOwnerInput.readOnly = false;
            try {
                mobileKeyboardOwnerInput.placeholder = I18n.t('marathon.namePlaceholder');
            } catch (e) { /* i18n may not be ready in edge cases */ }
            mobileKeyboardOwnerInput = null;
        }
    }
    // Build the on-screen keyboard for an iOS-standalone PWA input. Takes
    // the input element to type into and an onEnter callback that fires
    // when the player taps ↵. No-op on every other platform — desktop,
    // Android, and iOS Safari (non-standalone) use the native keyboard
    // path. Reused by both marathon's game-over name entry and PotD's
    // solve-modal name entry, since the iOS keyboard limitation applies
    // identically to any text input in standalone mode.
    function setupMobileKeyboard(input, onEnter) {
        // Always tear down first so a re-render (state change → game-over
        // → state change → game-over) doesn't stack duplicates and so
        // the keyboard always references the CURRENT input element.
        teardownMobileKeyboard();
        if (!isStandaloneIos() || !input) return;

        mobileKeyboardOwnerInput = input;
        input.readOnly = true;
        try {
            input.placeholder = I18n.t('marathon.tapKeyboard');
        } catch (e) { /* fall back to existing placeholder */ }

        // Capacity check matches the input's maxlength=16 — type once on
        // the source of truth (the DOM attribute) so changes only need
        // to happen in one place.
        const maxLen = parseInt(input.getAttribute('maxlength'), 10) || 16;
        let isShifted = false;

        const kbd = document.createElement('div');
        kbd.id = KBD_ID;
        kbd.setAttribute('aria-hidden', 'true');   // assistive tech uses the real input

        // Same layout as TANTЯO — number row, three QWERTY rows, then a
        // function row with shift+space+backspace.
        const rows = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

        // Helper: create a key with both touchend + click bound so iOS
        // doesn't double-fire AND so a stylus that doesn't generate touch
        // events still works. preventDefault on touchend stops the
        // synthesized click; we wire click separately for non-touch.
        function makeKey(label, onTap, extraClass) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'kbdKey' + (extraClass ? ' ' + extraClass : '');
            btn.textContent = label;
            btn.addEventListener('touchend', (e) => { e.preventDefault(); onTap(); });
            btn.addEventListener('click', (e) => { e.preventDefault(); onTap(); });
            return btn;
        }
        function refreshLetterCaseDisplay() {
            kbd.querySelectorAll('.kbdLetter').forEach((b) => {
                const c = b.dataset.char;
                b.textContent = isShifted ? c.toUpperCase() : c.toLowerCase();
            });
            const shiftBtn = kbd.querySelector('.kbdShift');
            if (shiftBtn) shiftBtn.classList.toggle('active', isShifted);
        }
        function appendChar(c) {
            if (!input) return;
            if (input.value.length >= maxLen) return;
            input.value += c;
            // Surface the change for any listeners (Save-btn enable logic
            // is on submit, not on input — but future-proof).
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Build the 4 character rows.
        rows.forEach((row, rowIdx) => {
            const rowEl = document.createElement('div');
            rowEl.className = 'kbdRow';
            // Insert shift to the LEFT of the last row (zxcvbnm).
            if (rowIdx === 3) {
                rowEl.appendChild(makeKey('⇧', () => {
                    isShifted = !isShifted;
                    refreshLetterCaseDisplay();
                }, 'kbdShift'));
            }
            for (const ch of row) {
                const isLetter = /[a-z]/i.test(ch);
                const key = makeKey(ch, () => {
                    const out = isLetter && isShifted ? ch.toUpperCase() : ch;
                    appendChar(out);
                }, isLetter ? 'kbdLetter' : 'kbdDigit');
                if (isLetter) key.dataset.char = ch;
                rowEl.appendChild(key);
            }
            // Backspace on the right of the bottom row.
            if (rowIdx === 3) {
                rowEl.appendChild(makeKey('⌫', () => {
                    if (input.value.length > 0) {
                        input.value = input.value.slice(0, -1);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, 'kbdBack'));
            }
            kbd.appendChild(rowEl);
        });

        // Function row: space (wide) + enter. Enter calls the caller-
        // supplied onEnter — marathon passes saveScore, PotD passes the
        // modal's resolve-with-typed-name. Lets the player submit without
        // lifting their finger off the keyboard.
        const fnRow = document.createElement('div');
        fnRow.className = 'kbdRow';
        fnRow.appendChild(makeKey('␣', () => appendChar(' '), 'kbdSpace'));
        fnRow.appendChild(makeKey('↵', () => { if (typeof onEnter === 'function') onEnter(); }, 'kbdEnter'));
        kbd.appendChild(fnRow);

        document.body.appendChild(kbd);
    }

    async function renderGameOver() {
        gameOverScore.textContent = I18n.t('marathon.solvedCount', { n: solvedCount, s: solvedCount === 1 ? '' : 's' });
        gameOverTime.textContent  = I18n.t('marathon.totalTime', { t: fmtTimePrecise(totalSolveTime) });
        // PotD comeback hook (D1 retention) — game-over is the one moment
        // every Marathon session passes through, and it previously said
        // nothing about tomorrow. Streak line + next-puzzles countdown
        // when a daily streak is alive (loss aversion does the work);
        // plain Puzzle-of-the-Day invite + countdown otherwise. Static
        // countdown — no ticker; second-precision doesn't matter on this
        // card. Reuses existing keys (potd.streak.solveLine,
        // potd.countdown, mode.potd.name) — zero new i18n.
        if (gameOverPotdHook) {
            const midnight = Date.parse(potdTodayUTC() + 'T00:00:00Z') + 86400000;
            const remain   = Math.max(0, midnight - Date.now());
            const h   = Math.floor(remain / 3600000);
            const m   = Math.floor((remain % 3600000) / 60000);
            const sec = Math.floor((remain % 60000) / 1000);
            const tStr = h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
            const cur = (typeof PotdStreaks !== 'undefined' && PotdStreaks.getStreaks)
                ? (PotdStreaks.getStreaks().current || 0)
                : 0;
            // Two lines: the mode name ALWAYS leads (a bare "🔥 1-day
            // streak · new puzzles in …" after a MARATHON run read as a
            // confusing claim about marathon itself — user caught it);
            // the sub-line carries the streak (when alive) + countdown.
            gameOverPotdHook.textContent = '';
            const mainLine = document.createElement('span');
            mainLine.className   = 'potdHookMain';
            mainLine.textContent = I18n.t('mode.potd.name');
            const subLine = document.createElement('span');
            subLine.className   = 'potdHookSub';
            subLine.textContent = (cur >= 1 ? I18n.t('potd.streak.solveLine', { n: cur }) + ' · ' : '')
                + I18n.t('potd.countdown', { t: tStr });
            gameOverPotdHook.appendChild(mainLine);
            gameOverPotdHook.appendChild(subLine);
            gameOverPotdHook.hidden = false;
        }
        gameOverRank.textContent  = '';
        gameOverRank.hidden       = true;
        gameOverName.value        = '';
        gameOverSave.disabled     = true;
        gameOverSave.textContent  = I18n.t('marathon.save');
        // "Back to menu" button visibility is the inverse of the name-entry
        // row's: when the player ranks in top-N they only see Save (which
        // accepts an empty input → 'Anonymous' on the server, so a no-op
        // Save click is the equivalent of "back without saving" without
        // adding a redundant button). Default-show here covers the
        // zero-score and below-cap branches; the top-N branch flips it
        // off alongside un-hiding the name row.
        if (gameOverMenu) gameOverMenu.hidden = false;

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
            // Hide "Back to menu" when the name-entry row is visible. The
            // Save button doubles as both "save with this name" and "save
            // anonymously without typing" — clicking Save on an empty
            // input submits as 'Anonymous'. A separate Back-to-menu
            // alongside would just be a third path to the same outcome
            // (the player ends up on the leaderboard after either click).
            if (gameOverMenu) gameOverMenu.hidden = true;
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
            // iOS PWA standalone: paint the custom on-screen keyboard
            // since the native one won't appear. No-op on every other
            // platform (desktop / Android / iOS Safari non-standalone).
            setupMobileKeyboard(gameOverName, saveScore);
            if (typeof Sfx !== 'undefined') {
                Sfx.play(rank === 1 ? 'audience_cheer_long' : 'audience_cheer');
            }
            // CrazyGames page-level celebration (confetti; no-op off-CG).
            // Their docs say to use happytime sparingly — ranking on the
            // global top-20 board is exactly the "reaching a highscore"
            // moment they describe, and it's rare by construction.
            if (typeof CgSdk !== 'undefined') CgSdk.happytime();
        } else if (typeof Sfx !== 'undefined') {
            // Ineligible: same SFX as the zero-solve path. Leaves the row
            // hidden / no rank text — the player still sees score + time.
            Sfx.play(['fail_long', 'audience_disappointed']);
        }
    }

    // ----- Leaderboard storage -----
    //
    // Server-primary with local fallback. Submissions try the API; on failure
    // they save to localStorage (so the player still sees their score on this
    // device) AND get queued for retry on the next successful submission.
    // Reads paint the local cache first for instant UX, then refresh from the
    // server in the background.

    function boardKey(mode, type) {
        // Marathon's key is per-type only (cumulative all-time board).
        // PotD's key is per-date + type so a stale yesterday board
        // doesn't paint over an empty fresh-today one.
        if (mode === 'potd') {
            // All-time boards are cumulative — no date in the key (a
            // cached copy is still meaningful tomorrow, unlike the
            // per-day slot boards where yesterday's cache would paint
            // over an empty fresh-today board).
            if (alltimeKind(type)) {
                return PROJECT_SLUG + '_potd_lb_alltime_' + type;
            }
            return PROJECT_SLUG + '_potd_lb_' + potdTodayUTC() + '_' + type;
        }
        return PROJECT_SLUG + '_lb_' + type;
    }
    function pendingKey()    { return PROJECT_SLUG + '_lb_pending'; }
    function sessionIdKey()  { return PROJECT_SLUG + '_session_id'; }
    function ownRecKey(type) { return PROJECT_SLUG + '_own_rec_' + type; }

    // Same UTC-date format PotD uses server-side for its date keys; kept
    // local here so this module doesn't have to reach into the Potd
    // module just to format a board cache key.
    function potdTodayUTC() {
        const d = new Date();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return d.getUTCFullYear() + '-' + m + '-' + day;
    }

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

    function loadBoard(mode, type) {
        // Backwards-compat shim: callers from the submit/flush paths
        // pass only the type and operate on marathon boards.
        if (typeof type === 'undefined') { type = mode; mode = 'marathon'; }
        try {
            const raw = localStorage.getItem(boardKey(mode, type));
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
    }
    function saveBoard(mode, type, board) {
        if (typeof board === 'undefined') { board = type; type = mode; mode = 'marathon'; }
        try { localStorage.setItem(boardKey(mode, type), JSON.stringify(board)); }
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
        if (!resp.ok) {
            // Carry the status so callers can tell a permanent rejection
            // (4xx — e.g. an expired sessionToken on a run resumed >6h
            // after it started) from a retryable network/server failure.
            const err = new Error('HTTP ' + resp.status);
            err.status = resp.status;
            throw err;
        }
        return resp.json();
    }

    async function fetchBoardFromServer(mode, type) {
        // Backwards-compat: submit/flush paths pass only the type.
        if (typeof type === 'undefined') { type = mode; mode = 'marathon'; }
        const base = apiBase();
        if (!base) throw new Error('No GAME_API configured');
        let url;
        const kind = mode === 'potd' ? alltimeKind(type) : null;
        if (kind) {
            // Streak / Career — cumulative boards over the whole
            // potd_scores history for one tile set ('s' or 'q').
            url = base + '/potd/alltime?set=' + encodeURIComponent(type[0])
                + '&kind=' + encodeURIComponent(kind)
                + '&limit=' + MARATHON.LEADERBOARD_TOP_N;
        } else if (mode === 'potd') {
            url = base + '/potd/board?date=' + encodeURIComponent(potdTodayUTC())
                + '&slot=' + encodeURIComponent(type)
                + '&limit=' + MARATHON.LEADERBOARD_TOP_N;
        } else {
            url = base + '/leaderboards/' + encodeURIComponent(type)
                + '?limit=' + MARATHON.LEADERBOARD_TOP_N;
        }
        const resp = await fetch(url);
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
            catch (e) {
                // 4xx = the server examined and rejected this payload
                // (expired/used token, malformed) — it will never succeed,
                // so requeueing would retry it forever. Only transient
                // failures (network, 5xx) stay queued.
                if (!(e && e.status >= 400 && e.status < 500)) remaining.push(p);
            }
        }
        savePending(remaining);
    }

    function buildPayload(name) {
        return {
            type:          activeType,
            name:          name,
            solved:        solvedCount,
            totalMs:       totalSolveTime,
            // Hints used across the whole run — primary tiebreaker on the
            // server's leaderboard sort (fewer hints wins before total_ms
            // is considered). See models.py's Score docstring.
            hintsUsed:     hintsUsed,
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
        const name = rawName || 'Anonymous';

        // Persist the entered name so the next high-score input pre-fills
        // (universal rule 7a). Save BEFORE the server submit so the name
        // sticks even if the player is offline / submission queues for retry.
        // Only persist actual user input — don't write the 'Anonymous' fallback.
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
                hintsUsed:    hintsUsed,
                totalMs:      totalSolveTime,
                date:         Date.now(),
                events:       recordings,
                hasRecording: recordings.length > 0,
            });
            // Mirror server sort: solved DESC, hints ASC, totalMs ASC.
            // Older cached entries without hintsUsed (from before this
            // column existed) fall through as 0, which sorts them as
            // "no hints used" — same default the server uses for legacy
            // rows.
            board.sort((a, b) => {
                if (b.solved !== a.solved) return b.solved - a.solved;
                const ah = a.hintsUsed || 0;
                const bh = b.hintsUsed || 0;
                if (ah !== bh) return ah - bh;
                return a.totalMs - b.totalMs;
            });
            if (board.length > MARATHON.LEADERBOARD_TOP_N) board.length = MARATHON.LEADERBOARD_TOP_N;
            saveBoard(activeType, board);

            // Queue for retry — but not when the server just REJECTED it
            // (4xx, e.g. a token expired past MAX_SESSION_MS on a resumed
            // run): that payload can never succeed, and flushPending
            // would re-fail it on every future save. The local-board
            // entry above still shows the player their score.
            if (!(e && e.status >= 400 && e.status < 500)) {
                const pending = loadPending();
                pending.push(payload);
                savePending(pending);
            }
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
            : { name: name, solved: solvedCount, hintsUsed: hintsUsed, totalMs: totalSolveTime };
        setActiveBoardType(activeType);
        showLeaderboard();
    }

    // Match a leaderboard entry against pendingHighlight. id-match is
    // exact when the server save succeeded; the name+stats fallback
    // covers local-only saves (id-less entries). Handles both
    // shapes:
    //   marathon entry → { name, solved, totalMs }
    //   potd entry     → { name, timeMs }
    function entryMatchesHighlight(entry) {
        if (!pendingHighlight) return false;
        if (pendingHighlight.id != null && entry.id != null) {
            return entry.id === pendingHighlight.id;
        }
        if (pendingHighlight.timeMs != null && entry.timeMs != null) {
            return entry.name === pendingHighlight.name
                && entry.timeMs === pendingHighlight.timeMs;
        }
        // Marathon local-save match — include hintsUsed in the tuple so
        // two same-name+solved+totalMs entries (which is now possible to
        // tie on, since hints break the tie) don't both highlight. Entries
        // from before the hints column existed have no hintsUsed; default
        // both sides to 0 so the comparison is well-defined for them too.
        const entryHints     = (typeof entry.hintsUsed === 'number') ? entry.hintsUsed : 0;
        const highlightHints = (typeof pendingHighlight.hintsUsed === 'number') ? pendingHighlight.hintsUsed : 0;
        return entry.name      === pendingHighlight.name
            && entry.solved    === pendingHighlight.solved
            && entryHints      === highlightHints
            && entry.totalMs   === pendingHighlight.totalMs;
    }

    function paintLeaderboard(board, mode) {
        if (typeof mode === 'undefined') mode = leaderboardMode;
        leaderboardEntries.innerHTML = '';
        if (board.length === 0) {
            leaderboardEmpty.hidden = false;
            return;
        }
        leaderboardEmpty.hidden = true;
        // Cross-reference for the player's own recording — keyed by score
        // id. Lets the Watch button work on the player's own entry even
        // when the server doesn't return events on this entry. PotD has
        // no per-mode own-recording stash today (the recording always
        // travels with the entry from the server), so just skip the
        // cross-ref there.
        const boardType    = getActiveBoardType();
        const alltime      = mode === 'potd' ? alltimeKind(boardType) : null;
        const ownRecording = mode === 'potd' ? null : loadOwnRecording(boardType);
        let highlightedEl = null;
        board.forEach((entry, i) => {
            const li     = document.createElement('li');
            // No highlight matching on all-time boards: their entries
            // carry only {name, value}, so entryMatchesHighlight's
            // undefined-vs-undefined fallback tuple would false-match
            // any same-named row when a solve highlight is pending.
            if (!alltime && entryMatchesHighlight(entry)) {
                li.classList.add('lbHighlight');
                highlightedEl = li;
            }
            const rank = document.createElement('span'); rank.className = 'lbRank'; rank.textContent = '#' + (i + 1);
            const name = document.createElement('span'); name.className = 'lbName'; name.textContent = entry.name;
            li.appendChild(rank);
            li.appendChild(name);
            // Marathon entries carry a `solved` count (puzzles cleared in
            // the run) + a `totalMs` total run time. PotD entries are a
            // single-puzzle solve — `timeMs` is the only metric, no
            // count column.
            if (alltime) {
                // Streak / Career rows: rank, name, one value column
                // (longest streak in days, or total solves). Two padding
                // spans keep the shared 6-column grid aligned; the value
                // takes the .lbSolved slot + color since it IS the
                // primary metric here. No Watch button ever — these
                // entries aggregate many solves, there's no single
                // recording to play.
                li.appendChild(document.createElement('span'));
                li.appendChild(document.createElement('span'));
                const n   = (typeof entry.value === 'number') ? entry.value : 0;
                const val = document.createElement('span');
                val.className   = 'lbSolved';
                val.textContent = alltime === 'streak'
                    ? I18n.t('potd.lb.days',   { n: n, s: n === 1 ? '' : 's' })
                    : I18n.t('potd.lb.solves', { n: n, s: n === 1 ? '' : 's' });
                li.appendChild(val);
                leaderboardEntries.appendChild(li);
                return;
            }
            if (mode === 'potd') {
                // Padding span for the `solved` column — PotD is a
                // single puzzle, no count to show. (Without the span,
                // PotD entries collapse leftward in the shared 6-column
                // grid.) The hints column DOES show on PotD now —
                // hints_used is the primary leaderboard tiebreaker on
                // the server-side PotD sort (ahead of time_ms), so the
                // player needs to see it. Older PotD entries from
                // before the column existed have no hintsUsed; treat
                // undefined as 0 (matches the server's column DEFAULT
                // for legacy rows). Same i18n key + pluralization
                // pattern as the marathon branch below.
                li.appendChild(document.createElement('span'));
                const hintN = (typeof entry.hintsUsed === 'number') ? entry.hintsUsed : 0;
                const hints = document.createElement('span');
                hints.className   = 'lbHints';
                hints.textContent = I18n.t('marathon.lbHints', { n: hintN, s: hintN === 1 ? '' : 's' });
                li.appendChild(hints);
                const time = document.createElement('span');
                time.className   = 'lbTime';
                time.textContent = fmtTimePrecise(entry.timeMs);
                li.appendChild(time);
            } else {
                // Hints column — primary tiebreaker on the server sort, so
                // the player needs to see it. Entries from before the
                // column existed have no hintsUsed field; treat undefined
                // as 0 (matching the server's NULL→0 default for legacy
                // rows). Translation via marathon.lbSolved /
                // marathon.lbHints (compact row-stat form per language;
                // separate from the longer marathon.solvedCount sentence
                // used on the game-over screen). The English {s} switch
                // pluralizes "hint" → "hint"/"hints"; non-English locales
                // use a single count-form that reads OK regardless of N.
                const hintN  = (typeof entry.hintsUsed === 'number') ? entry.hintsUsed : 0;
                const solved = document.createElement('span');
                solved.className   = 'lbSolved';
                solved.textContent = I18n.t('marathon.lbSolved', { n: entry.solved });
                const hints  = document.createElement('span');
                hints.className   = 'lbHints';
                hints.textContent = I18n.t('marathon.lbHints', { n: hintN, s: hintN === 1 ? '' : 's' });
                const time   = document.createElement('span');
                time.className   = 'lbTime';
                time.textContent = fmtTimePrecise(entry.totalMs);
                li.appendChild(solved);
                li.appendChild(hints);
                li.appendChild(time);
            }
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
                // Glyph + label as SEPARATE nodes: portrait phones hide
                // the .lbWatchLabel span via CSS (glyph-only button frees
                // row width for player names — user request 2026-07-28).
                // The aria-label keeps the button named when the visible
                // text is just "▶".
                watch.textContent = '▶ ';
                const watchLabel = document.createElement('span');
                watchLabel.className   = 'lbWatchLabel';
                watchLabel.textContent = I18n.t('marathon.watch');
                watch.appendChild(watchLabel);
                watch.setAttribute('aria-label', I18n.t('marathon.watch'));
                // Resolve the launch action for this entry's recording
                // source: own/local events play directly; server-backed
                // entries fetch first, via the PotD- or marathon-specific
                // endpoint.
                let launch;
                if (directEvents) {
                    const evCopy = directEvents;
                    const name   = entry.name;
                    launch = () => startReplayWithEvents(evCopy, name);
                } else if (mode === 'potd') {
                    const id = entry.id;
                    launch = () => startPotdReplay(id);
                } else {
                    const id = entry.id;
                    launch = () => startReplay(id);
                }
                // PotD only: watching a replay of a slot the player hasn't
                // played yet reveals the solution — a cheating vector. Gate
                // behind Potd.guardWatch, which warns + forfeits today's
                // eligibility on that slot before allowing the watch (and is
                // a silent pass-through once the player has played it).
                // Marathon puzzles are per-run random, so no gate there.
                if (mode === 'potd' && typeof Potd !== 'undefined' && Potd.guardWatch) {
                    const slot = getActiveBoardType();
                    watch.addEventListener('click', async () => {
                        if (await Potd.guardWatch(slot)) launch();
                    });
                } else {
                    watch.addEventListener('click', launch);
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
        const type = getActiveBoardType();
        const mode = leaderboardMode;

        // Paint local cache immediately so the UI is never blank. Each
        // mode has its own cache namespace.
        paintLeaderboard(loadBoard(mode, type), mode);

        // Refresh from server; update cache + re-render if user is still
        // on this (mode, type) pair when the fetch resolves.
        try {
            const fresh = await fetchBoardFromServer(mode, type);
            saveBoard(mode, type, fresh);
            if (state === STATE.LEADERBOARD &&
                leaderboardMode === mode &&
                getActiveBoardType() === type) {
                paintLeaderboard(fresh, mode);
            }
        } catch (e) {
            // Stay with the cached view painted above.
        }
    }

    // ----- Replay (watching another player's recording) -----

    // Resolve fn of the post-completion hold in startReplayWithEvents —
    // non-null only while a finished replay is lingering on its final
    // solved frame waiting for the user to click Stop (or quit to menu).
    let replayHoldResolve = null;

    function releaseReplayHold() {
        if (!replayHoldResolve) return false;
        const res = replayHoldResolve;
        replayHoldResolve = null;
        res();
        return true;
    }

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

    // PotD-board Watch buttons route here. Different from marathon's
    // /api/scores/<id>/recording in shape: marathon submits `events` as
    // an ARRAY OF FULL RECORDINGS (one per puzzle in the run), while
    // PotD submits `events` as a FLAT MOVES ARRAY for the single
    // puzzle. So we have to reconstruct a recording on the client by
    // fetching the puzzle snapshot for the score's (date, slot) and
    // pairing it with the moves before handing off to Game.replayAll
    // (which wants the marathon shape: array of recordings).
    async function startPotdReplay(scoreId) {
        if (state === STATE.REPLAYING) return;
        const base = apiBase();
        if (!base) return;

        let rec;
        try {
            const resp = await fetch(base + '/potd/scores/' + encodeURIComponent(scoreId) + '/recording');
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            rec = await resp.json();
        } catch (e) {
            Logger.warn('Marathon: failed to fetch PotD recording', e);
            return;
        }

        // Today-only for now — /api/potd/today/<slot> only serves the
        // current UTC date's snapshot. The leaderboard view also only
        // shows today's scores, so a replay request should always be
        // for today; bail loudly if it isn't (older history needs a
        // date-aware endpoint).
        if (rec.date !== potdTodayUTC()) {
            Logger.warn('Marathon: PotD replay for non-today date not supported', rec.date);
            return;
        }

        const slot = rec.slot;
        if (!slot) {
            Logger.warn('Marathon: PotD recording missing slot', rec);
            return;
        }
        let puzzle;
        try {
            const resp = await fetch(base + '/potd/today/' + encodeURIComponent(slot));
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            puzzle = await resp.json();
        } catch (e) {
            Logger.warn('Marathon: failed to fetch PotD puzzle snapshot for replay', e);
            return;
        }
        if (!puzzle || !puzzle.snapshot || !puzzle.snapshot.maze) {
            Logger.warn('Marathon: PotD puzzle snapshot missing maze data', puzzle);
            return;
        }

        // Build a full recording matching Game.replayAll's expectations.
        // slot is 's1'..'s4' / 'q1'..'q4' — leading char encodes quad
        // mode, trailing digit is the path count.
        const quadMode  = slot[0] === 'q';
        const pathCount = parseInt(slot[1], 10) || 1;
        const moves       = Array.isArray(rec.events)       ? rec.events       : [];
        const musicEvents = Array.isArray(rec.musicEvents)  ? rec.musicEvents  : [];
        const reconstructed = {
            quadMode:     quadMode,
            pathCount:    pathCount,
            initialState: puzzle.snapshot.maze,
            gates:        puzzle.snapshot.gates || null,
            moves:        moves,
            // Music events ride alongside moves so the watcher hears
            // the same songs the original player heard. PotD's submit
            // sends musicEvents as a top-level field (vs marathon's
            // events-is-full-recording shape), so we read it the same
            // way — defaulting to [] for older recordings that
            // pre-date this field.
            musicEvents:  musicEvents,
        };

        // Wrap in a one-element array so the puzzle-counter reads 1/1
        // (not 1/<num-moves>) and replayAll's per-puzzle loop fires
        // exactly once.
        await startReplayWithEvents([reconstructed], rec.name || '');
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

        const completed = await Game.replayAll(events, (idx, total) => {
            updateReplayHud(name, idx + 1, total);
        });

        // Natural finish: hold on the final solved frame instead of
        // bouncing straight back to the leaderboard — the watcher wants
        // to SEE the last tile twist land and the path light up. The
        // hold resolves when the user clicks Stop replay (stopReplay)
        // or quits to the menu (goToMenu calls releaseReplayHold).
        // Cancelled replays skip the hold — the user already asked to
        // leave. The last replay song keeps playing through the hold;
        // the menu-music handoff below runs once the hold releases.
        if (completed && state === STATE.REPLAYING) {
            await new Promise((res) => { replayHoldResolve = res; });
        }

        // Kill any replay-driven SFX the moment the replay is over — the
        // same cleanup quitToMenu does for live play. The overlap-glitch
        // loop in particular keeps running once refresh() starts it
        // (user quit a replay right as a red-overlap kicked in and the
        // loop played on over the next screen); straddling one-shots
        // fade too. Placed AFTER the hold on purpose: a natural finish
        // lingers on the solved frame with its applause still part of
        // the moment, and no loop survives a solve anyway (the solve
        // diff stops it) — so this is a no-op there and a genuine
        // silencer on cancels.
        if (typeof Sfx !== 'undefined') {
            if (Sfx.stopAllLoops)  Sfx.stopAllLoops();
            if (Sfx.fadeOneShots)  Sfx.fadeOneShots();
        }

        // Replay's scripted playback stops its scheduled timer chain when the
        // recording ends, but doesn't pause the currently-playing audio — so
        // without this transition, the last replay song bleeds into the
        // leaderboard view. Same pattern as goToMenu: flip to menu phase,
        // restart with a menu-pool song unless we're already on one (the
        // gate avoids interrupting menu music that happens to be playing,
        // though in practice scripted playback will have overwritten it).
        // Fires whether the replay completed naturally or was cancelled —
        // either way audio should hand back to the menu pool. goToMenu
        // does its own transition on the Quit-to-menu path, but the
        // alreadyMenu gate makes the double-call a no-op.
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(true);
            const alreadyMenu = Music.isMenuSongPlaying && Music.isMenuSongPlaying();
            if (!alreadyMenu) {
                if (Music.stop)  Music.stop();
                if (Music.start) Music.start();
            }
        }

        // Whether the replay finished naturally or was cancelled mid-stream,
        // return to the leaderboard view IF the user hasn't navigated away
        // (e.g. cancelled via Quit-to-menu instead of Stop).
        if (state === STATE.REPLAYING) {
            showLeaderboard();
        }
    }

    function stopReplay() {
        // Post-completion hold: playback already finished and we're
        // lingering on the solved frame — Stop now means "back to the
        // leaderboard", which the released hold's continuation handles.
        if (releaseReplayHold()) return;
        if (typeof Game !== 'undefined' && Game.cancelReplay) Game.cancelReplay();
    }

    function isPlaying()       { return state === STATE.PLAYING; }
    function isMenuVisible()   { return state === STATE.MENU; }
    function isInTransition()  { return inTransition; }
    function isReplaying()     { return state === STATE.REPLAYING; }

    // DEV: drops all leaderboard-related localStorage entries so the
    // next render shows whatever the server is currently holding.
    // Paired with the back-end's /api/admin/wipe-leaderboards
    // endpoint by the debug-panel button; either one without the
    // other only fixes half the picture. Wipes: cached marathon boards
    // (_lb_<type>), cached PotD boards (_potd_lb_<date>_<type>),
    // pending offline submissions (_lb_pending), per-type own-recording
    // bookkeeping (_own_rec_<type>), and the player's last-saved name
    // (_lastPlayerName) since that's a leaderboard-adjacent value.
    function wipeLocalLeaderboards() {
        try {
            const prefixes = [
                PROJECT_SLUG + '_lb_',
                PROJECT_SLUG + '_potd_lb_',
                PROJECT_SLUG + '_own_rec_',
            ];
            const exactKeys = [
                PROJECT_SLUG + '_lastPlayerName',
            ];
            const stale = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                if (exactKeys.indexOf(k) >= 0) { stale.push(k); continue; }
                for (const p of prefixes) {
                    if (k.indexOf(p) === 0) { stale.push(k); break; }
                }
            }
            for (const k of stale) localStorage.removeItem(k);
            // Re-render any open leaderboard view so the wipe is visible
            // immediately (otherwise the user still sees the stale list).
            if (typeof leaderboardEl !== 'undefined' && leaderboardEl &&
                leaderboardEl.classList.contains('visible')) {
                renderLeaderboard();
            }
            return { wiped: stale.length };
        } catch (e) {
            return { wiped: 0, error: e && e.message || String(e) };
        }
    }

    return { init, onSolve, onHintUsed, onPuzzleReady, advance, isPlaying, isMenuVisible, isInTransition, isReplaying, upcomingDims,
             autoStartFirstPractice,
             notifyPuzzleInteraction,
             wipeLocalLeaderboards,
             showPotdLeaderboard,
             // Reusable iOS-standalone keyboard helpers — exposed so PotD's
             // solve-modal name entry can share the same on-screen keyboard
             // marathon's game-over name input uses. (input, onEnter) for
             // setup; teardown is parameterless (the keyboard owner is
             // tracked internally).
             setupMobileKeyboard, teardownMobileKeyboard, isStandaloneIos,
             getSolvedCount: () => solvedCount,
             // Zen (untimed, no leaderboard) vs Marathon. Read by game.js
             // to hold gates back on a Zen run's opening puzzles.
             isZenRun: () => isPractice };
})();
