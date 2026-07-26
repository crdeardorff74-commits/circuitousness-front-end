/**
 * tutorial.js — the "How to Solve" interactive walkthrough.
 *
 * Reachable from the main menu (button next to Leaderboards). Opens a modal
 * with a small fixed puzzle on the left and a numbered step list on the right.
 * Each click of "Next" reveals the next bullet AND plays its demonstration on
 * the puzzle — real tile rotations, twin lockstep, player locks, gate spins
 * and the gold win — by driving the real Maze + Render + Gates modules through
 * Render's tutorial render mode (the small canvas borrows the live renderer).
 *
 * The puzzle is hand-authored (not generated) so a single solution path passes
 * the teaching beats in order: elbow start → lock → twin (unison) → twin lock →
 * the straight/elbow-twin trap → unlock+fix → two-gate clear → completion.
 * Tile/gate geometry is documented inline at buildPuzzle()/GATE_SNAPSHOT.
 *
 * Watching to the final step persists `<slug>_tutorialWatched`, which tooltip.js
 * reads to suppress the in-game "how to solve" tooltips (the player has now
 * been shown the same material in a richer form).
 */
const Tutorial = (function () {
    'use strict';

    // Port directions (match maze.js): North, East, South, West.
    const N = 0, E = 1, S = 2, W = 3;
    // Tile types (match maze.js T_*): straight, elbow.
    const STRAIGHT = 0, ELBOW = 1;

    // 6 wide × 7 tall = 42 tiles (a little easter egg). The path snakes the
    // top four rows for beats 1–7, then drops down column 0 and runs along the
    // bottom row to a lower-right exit — a long finale for step 8. Off-path
    // filler (incl. the two twin partners) fills rows 4–5, cols 1–5.
    const ROWS = 7, COLS = 6;

    // Twin pair colors — pulled from maze.js's TWIN_COLORS, deliberately
    // avoiding green (clashes with the lit path) and red (gates / hint locks).
    const COLOR_P1 = '#BF54C9';  // magenta — pair 1 (unison demo)
    const COLOR_P2 = '#C98554';  // amber   — pair 2 (twin lock)
    const COLOR_P3 = '#5BA0C2';  // sky     — pair 3 (straight/elbow-twin trap)

    const WATCHED_KEY = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'app')
                        + '_tutorialWatched';

    // ---- rotation helpers -------------------------------------------------
    // Canonical rotation that carries a tile of `type` between ports a and b.
    function findRot(type, a, b) {
        const base = (type === STRAIGHT) ? [[N, S]] : [[N, E]];
        for (let r = 0; r < 4; r++) {
            for (const pair of base) {
                const ra = (pair[0] + r) & 3, rb = (pair[1] + r) & 3;
                if ((ra === a && rb === b) || (ra === b && rb === a)) return r;
            }
        }
        return 0;
    }
    // A path tile, scrambled one CW step short of its solution unless an
    // explicit initial rotation is given (the trap pair needs a custom start).
    function pathTile(type, a, b, initRot) {
        const sol = findRot(type, a, b);
        const rot = (initRot == null) ? ((sol - 1) & 3) : (initRot & 3);
        return { type: type, rotation: rot, _solution: sol, _path: 0 };
    }
    function filler(type, rot) {
        return { type: type, rotation: (rot | 0) & 3 };
    }
    function twin(tile, partner, color) {
        tile._twin = { partner: partner, color: color };
        return tile;
    }

    // ---- the fixed tutorial puzzle ---------------------------------------
    // Solution path (row,col) in traversal order from the entry at the top of
    // (0,0) to the exit on the left of (3,0):
    //   (0,0)→(0,1)→(0,2)→(0,3)→(0,4)→(0,5)            row 0, L→R
    //   →(1,5)→(1,4)→(1,3)→(1,2)→(1,1)→(1,0)           row 1, R→L
    //   →(2,0)→(2,1)→(2,2)→(2,3)→(2,4)→(2,5)           row 2, L→R
    //   →(3,5)→(3,4)→(3,3)→(3,2)→(3,1)→(3,0)→exit      row 3, R→L
    // Row 4 is all fillers; two of them are the off-path twins of pairs 1 & 2.
    function buildPuzzle() {
        // Every cell starts as a plain filler; path cells overwrite below.
        const grid = [];
        for (let r = 0; r < ROWS; r++) {
            const row = [];
            for (let c = 0; c < COLS; c++) row.push(filler(STRAIGHT, 0));
            grid[r] = row;
        }

        // Row 0
        grid[0][0] = pathTile(ELBOW, N, E);   // start elbow (entry from N)
        grid[0][1] = pathTile(STRAIGHT, W, E);
        grid[0][2] = pathTile(STRAIGHT, W, E, 1);   // pre-aligned: starts horizontal (no twist needed)
        grid[0][3] = pathTile(STRAIGHT, W, E);
        grid[0][4] = pathTile(STRAIGHT, W, E); // PAIR 1 (unison demo)
        grid[0][5] = pathTile(ELBOW, W, S);
        // Row 1
        grid[1][5] = pathTile(ELBOW, N, W);    // PAIR 2 (twin lock)
        grid[1][4] = pathTile(STRAIGHT, E, W, 1);   // pre-aligned
        grid[1][3] = pathTile(STRAIGHT, E, W, 1);   // pre-aligned
        grid[1][2] = pathTile(STRAIGHT, E, W, 1);   // pre-aligned
        grid[1][1] = pathTile(STRAIGHT, E, W);
        grid[1][0] = pathTile(ELBOW, E, S);
        // Row 2
        grid[2][0] = pathTile(ELBOW, N, E);
        grid[2][1] = pathTile(STRAIGHT, W, E);
        // PAIR 3 straight — custom start (rot 0). One CW tap → rot 1, the
        // "trap" horizontal orientation: the straight visibly carries the
        // path, but its elbow twin is then 180° wrong. A second +2 (in the
        // unlock step) reaches rot 3 — still horizontal, now twin-correct.
        grid[2][2] = pathTile(STRAIGHT, W, E, 0);
        grid[2][3] = pathTile(STRAIGHT, W, E, 1);   // pre-aligned
        grid[2][4] = pathTile(STRAIGHT, W, E);
        // PAIR 3 elbow — custom start (rot 3) so the fixed twin offset holds:
        // when the straight hits the trap (rot 1) this is rot 0 (wrong); when
        // the straight reaches rot 3 this is rot 2 = W–S (correct).
        grid[2][5] = pathTile(ELBOW, W, S, 3);
        // Row 3 (R→L), then the path turns DOWN at (3,0) and snakes to the
        // lower-right so the finale (step 8) has a long run of tiles to twist.
        grid[3][5] = pathTile(ELBOW, N, W);
        grid[3][4] = pathTile(STRAIGHT, E, W, 1);   // pre-aligned
        grid[3][3] = pathTile(STRAIGHT, E, W);
        grid[3][2] = pathTile(STRAIGHT, E, W);
        grid[3][1] = pathTile(STRAIGHT, E, W, 1);   // pre-aligned
        grid[3][0] = pathTile(ELBOW, E, S);         // turns the path downward
        // Down column 0, then across row 6 to the bottom-right exit.
        grid[4][0] = pathTile(STRAIGHT, N, S);
        grid[5][0] = pathTile(STRAIGHT, N, S, 0);   // pre-aligned (vertical)
        grid[6][0] = pathTile(ELBOW, N, E);
        grid[6][1] = pathTile(STRAIGHT, W, E);
        grid[6][2] = pathTile(STRAIGHT, W, E, 1);   // pre-aligned
        grid[6][3] = pathTile(STRAIGHT, W, E);
        grid[6][4] = pathTile(STRAIGHT, W, E);
        grid[6][5] = pathTile(ELBOW, W, S);         // exit (bottom-right, exits S)

        // Off-path filler in rows 4–5 (cols 1–5). Two carry the twin partners;
        // varied shapes so the board reads as a real 6×7 = 42 puzzle.
        grid[4][1] = twin(filler(ELBOW, 0), '0,4', COLOR_P1);   // pair 1 partner
        grid[4][2] = filler(STRAIGHT, 1);
        grid[4][3] = filler(ELBOW, 2);
        grid[4][4] = filler(STRAIGHT, 0);
        grid[4][5] = filler(ELBOW, 0);
        grid[5][1] = twin(filler(ELBOW, 1), '1,5', COLOR_P2);   // pair 2 partner
        grid[5][2] = filler(STRAIGHT, 1);
        grid[5][3] = filler(ELBOW, 3);
        grid[5][4] = filler(STRAIGHT, 0);
        grid[5][5] = filler(ELBOW, 2);

        // Wire the on-grid twin back-references.
        twin(grid[0][4], '4,1', COLOR_P1);
        twin(grid[1][5], '5,1', COLOR_P2);
        twin(grid[2][2], '2,5', COLOR_P3);
        twin(grid[2][5], '2,2', COLOR_P3);

        return {
            rows: ROWS, cols: COLS,
            grid: grid,
            entry: { row: 0, col: 0, port: N },
            exit:  { row: 6, col: 5, port: S },   // lower-right corner, exits downward
            entry2: null, exit2: null,
            entry3: null, exit3: null,
            entry4: null, exit4: null,
            quadScramble: null,
            locked: []
        };
    }

    // Two gates that share one rotation `delta`. Worked out so that:
    //   delta 0 — gate A (vertex 4,3) blocks the LATE edge (3,2)-(3,3);
    //   delta 1 — gate A clears, gate B (vertex 4,5) blocks the EARLIER
    //             edge (3,4)-(3,5), receding the lit path;
    //   delta 2 — both clear, path flows.
    // (At every delta the gates' other directions only touch row-3↔row-4
    // filler edges, so earlier beats are never affected.)
    function gateSnapshot() {
        return {
            list: [
                { vr: 4, vc: 3, solutionDir: 0 },   // gate A
                { vr: 4, vc: 5, solutionDir: 3 }    // gate B
            ],
            delta: 0
        };
    }
    // Where the cursor "taps" to rotate the gates (gate A's vertex).
    const GATE_TAP_VERTEX = { vr: 4, vc: 3 };

    // ---- the script -------------------------------------------------------
    // Each step: { key } i18n bullet + { actions } played on Next.
    // action.a: 'rotate' | 'lock' | 'unlock' | 'gate'
    const STEPS = [
        { key: 'tutorial.step1', actions: [
            { a: 'rotate', r: 0, c: 0 }
        ] },
        { key: 'tutorial.step2', actions: [
            { a: 'lock', r: 0, c: 0 }     // just the lock; the path extends in step 3
        ] },
        { key: 'tutorial.step3', actions: [
            // First extend the path up to the colored (twin) tile. (0,2) is
            // pre-aligned, so it lights up "for free" — no twist needed.
            { a: 'rotate', r: 0, c: 1 },
            { a: 'rotate', r: 0, c: 3 },
            // ...then rotate the twin a FEW times, slowly, so its partner
            // (4,1) is clearly seen spinning in unison. 3 steps land it back
            // on a lit (horizontal) orientation.
            { a: 'rotate', r: 0, c: 4, slow: true },
            { a: 'rotate', r: 0, c: 4, slow: true },
            { a: 'rotate', r: 0, c: 4, slow: true }
        ] },
        { key: 'tutorial.step4', actions: [
            { a: 'rotate', r: 0, c: 5 },
            { a: 'rotate', r: 1, c: 5 },  // pair 2 elbow to correct
            { a: 'lock',   r: 1, c: 5 }   // locks partner (4,0) too
        ] },
        { key: 'tutorial.step5', actions: [
            // (1,4)(1,3)(1,2) and (2,3) are pre-aligned and light up for free.
            { a: 'rotate', r: 1, c: 1 },
            { a: 'rotate', r: 1, c: 0 },
            { a: 'rotate', r: 2, c: 0 },
            { a: 'rotate', r: 2, c: 1 },
            { a: 'rotate', r: 2, c: 2 },  // pair 3 straight → trap (elbow 180° wrong)
            { a: 'lock',   r: 2, c: 2 },  // locks elbow twin (2,5) in the wrong orientation
            { a: 'rotate', r: 2, c: 4 }   // path now stalls at the wrong elbow
        ] },
        { key: 'tutorial.step6', actions: [
            { a: 'unlock', r: 2, c: 5 },  // press-hold to unlock (frees the twin too)
            { a: 'rotate', r: 2, c: 5 },  // +2 → straight stays correct, elbow becomes correct
            { a: 'rotate', r: 2, c: 5 }
        ] },
        { key: 'tutorial.step7', actions: [
            { a: 'rotate', r: 3, c: 5 },  // (3,4) is pre-aligned — lights for free
            { a: 'rotate', r: 3, c: 3 },  // path hits the gate-blocked edge
            { a: 'gate' },                // clears it, but an earlier gate engages
            { a: 'gate' }                 // both clear
        ] },
        { key: 'tutorial.step8', actions: [
            // Long finale: twist down column 0 and across the bottom to the
            // lower-right exit. (3,1), (5,0) and (6,2) are pre-aligned and
            // light up for free as the path reaches them.
            { a: 'rotate', r: 3, c: 2 },
            { a: 'rotate', r: 3, c: 0 },   // elbow turns the path downward
            { a: 'rotate', r: 4, c: 0 },
            { a: 'rotate', r: 6, c: 0 },
            { a: 'rotate', r: 6, c: 1 },
            { a: 'rotate', r: 6, c: 3 },
            { a: 'rotate', r: 6, c: 4 },
            { a: 'rotate', r: 6, c: 5 }    // circuit completes → gold
        ] }
    ];

    // ---- timing -----------------------------------------------------------
    const CURSOR_MOVE_MS = 360;   // must match the CSS transition on .tutorial-cursor
    const SETTLE_MS      = 90;
    const ACTION_DWELL_MS = 430;  // pause after a normal tap-rotate
    const SLOW_DWELL_MS  = 700;   // pause after a "slow" demo rotate (twin demo)
    // Press-and-hold (lock / unlock): the ring grows and HOLDS for ~1s before
    // the tile changes (turns white / unlocks), then the ring fades away.
    const LOCK_HOLD_MS   = 1000;
    const LOCK_AFTER_MS  = 320;   // beat between the tile changing and the ring fading
    const RING_FADE_MS   = 320;

    // ---- module state -----------------------------------------------------
    let overlay, modal, canvas, canvasWrap, cursor, ring, stepList, nextBtn, openBtn, closeX;
    let stepIdx = 0;          // how many steps have been revealed/played
    let playing = false;      // an action sequence is running
    let isOpen = false;
    let saved = null;         // pre-open Maze/Gates state to restore on close
    let lastCursorPt = null;  // {x,y} CSS px, for resize repositioning

    function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

    function t(key, fallback) {
        if (typeof I18n !== 'undefined' && I18n.t) {
            const s = I18n.t(key);
            if (s && s !== key) return s;
        }
        return fallback || key;
    }

    function isCoarsePointer() {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    }

    // ---- cursor positioning ----------------------------------------------
    function cellCenterCss(r, c) {
        const m = Render.tutorialMetrics();
        return {
            x: (m.originX + c * m.cellSize + m.cellSize / 2) / m.dpr,
            y: (m.originY + r * m.cellSize + m.cellSize / 2) / m.dpr
        };
    }
    function vertexCss(vr, vc) {
        const m = Render.tutorialMetrics();
        return {
            x: (m.originX + vc * m.cellSize) / m.dpr,
            y: (m.originY + vr * m.cellSize) / m.dpr
        };
    }
    function targetFor(act) {
        if (act.a === 'gate') return vertexCss(GATE_TAP_VERTEX.vr, GATE_TAP_VERTEX.vc);
        return cellCenterCss(act.r, act.c);
    }
    function placeCursor(pt, animate) {
        if (!cursor) return;
        lastCursorPt = pt;
        cursor.style.transition = animate
            ? ('transform ' + CURSOR_MOVE_MS + 'ms cubic-bezier(0.45,0.05,0.25,1)')
            : 'none';
        cursor.style.transform = 'translate(' + pt.x + 'px, ' + pt.y + 'px)';
    }
    // The click/press ring is a child element so JS can drive it with
    // transitions: a quick pulse for a tap, or a grow-hold-fade for a
    // press-and-hold (lock/unlock).
    function ringSet(ms, scale, op) {
        if (!ring) return;
        ring.style.transition = ms > 0
            ? ('transform ' + ms + 'ms ease-out, opacity ' + ms + 'ms ease-out')
            : 'none';
        ring.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
        ring.style.opacity = String(op);
    }
    function ringTap() {                 // quick grow-and-fade
        ringSet(0, 0, 0.9);
        if (ring) void ring.offsetWidth;  // reflow so the pulse restarts
        ringSet(ACTION_DWELL_MS, 1.7, 0);
    }
    function ringGrowHold() {            // press: grow, then stay solid
        ringSet(0, 0, 0.9);
        if (ring) void ring.offsetWidth;
        ringSet(260, 1.05, 0.9);
    }
    function ringFadeOut() { ringSet(RING_FADE_MS, 1.35, 0); }

    // ---- applying a single action ----------------------------------------
    function performAction(act) {
        if (act.a === 'rotate') {
            if (Maze.rotate(act.r, act.c, false)) {
                Render.animateRotationAt(act.r, act.c, false);
            }
        } else if (act.a === 'lock' || act.a === 'unlock') {
            Maze.togglePlayerLock(act.r, act.c);
            Render.draw();
        } else if (act.a === 'gate') {
            if (typeof Gates !== 'undefined') {
                Gates.rotate(false);
                if (Maze.recompute) Maze.recompute();
                Render.animateGateRotation(false);
            }
        }
        if (Maze.recompute) Maze.recompute();
        Render.draw();
    }

    async function playActions(actions) {
        for (let i = 0; i < actions.length; i++) {
            const act = actions[i];
            const pt = targetFor(act);
            const same = lastCursorPt
                && Math.abs(lastCursorPt.x - pt.x) < 0.5
                && Math.abs(lastCursorPt.y - pt.y) < 0.5;
            if (same) {
                await delay(SETTLE_MS);                  // already over the target
            } else {
                placeCursor(pt, true);
                await delay(CURSOR_MOVE_MS + SETTLE_MS);
            }

            if (act.a === 'lock' || act.a === 'unlock') {
                // Press-and-hold: ring grows + holds ~1s, THEN the tile turns
                // white (or unlocks), then the ring disappears.
                ringGrowHold();
                await delay(LOCK_HOLD_MS);
                performAction(act);
                await delay(LOCK_AFTER_MS);
                ringFadeOut();
                await delay(RING_FADE_MS);
            } else {
                ringTap();
                performAction(act);
                await delay(act.slow ? SLOW_DWELL_MS : ACTION_DWELL_MS);
            }
        }
    }

    // ---- step flow --------------------------------------------------------
    function bulletHtml(step) {
        let html = t(step.key, '');
        if (step.key === 'tutorial.step1') {
            // Touch devices get the swipe-direction note; pointer (mouse)
            // devices get the left/right-click note. Plain second sentence.
            html += ' ' + (isCoarsePointer()
                ? t('tutorial.step1Touch', '')
                : t('tutorial.step1Desktop', ''));
        }
        return html;
    }
    // Build ALL bullets up front, display:none (no layout space) so the
    // steps area starts EMPTY and grows one bullet per reveal. History:
    // they used to be pre-built at opacity:0 WITH their layout space
    // reserved, so the modal never resized mid-tutorial — but that
    // reserved height overflowed the steps area on portrait phones and
    // showed a scrollbar before any step was visible. Growing per-reveal
    // means the scrollbar appears only when revealed content actually
    // overflows; the modal getting taller per step is the accepted
    // trade-off (2026-07-17).
    function buildAllBullets() {
        stepList.innerHTML = '';
        STEPS.forEach(function (step) {
            const li = document.createElement('li');
            li.innerHTML = bulletHtml(step);
            li.className = 'tutorial-step-item';   // display:none until revealed
            stepList.appendChild(li);
        });
    }
    function revealBullet(index) {
        const li = stepList.children[index];
        if (!li) return;
        // Two-stage reveal: display first (the bullet enters layout at
        // opacity 0), then --in one frame later so the opacity transition
        // actually runs — flipping display and opacity in the same style
        // recalc skips the fade entirely (transitions don't animate on
        // elements entering layout).
        li.style.display = 'list-item';
        requestAnimationFrame(function () {
            li.classList.add('tutorial-step-item--in');
            // The list can outgrow the steps area on short screens now
            // that it scrolls only when needed — keep the newest bullet
            // in view.
            li.scrollIntoView({ block: 'nearest' });
        });
    }

    function setNextLabel() {
        let key, fallback;
        if (stepIdx >= STEPS.length) { key = 'tutorial.done'; fallback = 'Done'; }
        else if (stepIdx === 0)      { key = 'tutorial.start'; fallback = 'Start'; }
        else                         { key = 'tutorial.next'; fallback = 'Next'; }
        nextBtn.textContent = t(key, fallback);
    }

    async function advance() {
        if (playing) return;
        if (stepIdx >= STEPS.length) { close(); return; }

        playing = true;
        nextBtn.disabled = true;
        nextBtn.classList.add('is-busy');

        const step = STEPS[stepIdx];
        revealBullet(stepIdx);
        await playActions(step.actions);
        stepIdx++;

        // Reaching the final step counts as "watched" → suppress in-game tips.
        if (stepIdx >= STEPS.length) markWatched();

        playing = false;
        nextBtn.disabled = false;
        nextBtn.classList.remove('is-busy');
        setNextLabel();
    }

    function markWatched() {
        try { localStorage.setItem(WATCHED_KEY, '1'); } catch (e) { /* private mode */ }
    }

    // ---- open / close -----------------------------------------------------
    function open() {
        if (isOpen) return;
        if (!overlay) init();
        if (!overlay) return;
        isOpen = true;

        // Snapshot whatever Maze/Gates state exists so we can restore it.
        saved = {
            grid:  (Maze.grid ? Maze.snapshotState() : null),
            gates: (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null,
            quad:  Maze.quadMode,
            paths: Maze.pathCount
        };

        // Reset the step UI. Bullets are built display:none and enter
        // layout one per reveal — the modal starts compact and grows
        // with each step (see buildAllBullets).
        stepIdx = 0;
        playing = false;
        buildAllBullets();
        setNextLabel();
        nextBtn.disabled = false;
        nextBtn.classList.remove('is-busy');

        // Install the fixed puzzle into the live Maze + Gates.
        Maze.setQuadMode(false);
        Maze.setPathCount(1);
        Maze.setDimensions(ROWS, COLS);
        Maze.loadSnapshot(buildPuzzle());
        if (typeof Gates !== 'undefined') {
            Gates.restore(gateSnapshot());
            if (Maze.recompute) Maze.recompute();
        }

        overlay.hidden = false;
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', onResize);

        // CrazyGames: the tutorial modal suspends play without ending the
        // run (only reachable mid-game on the first-visit auto-start).
        // overlayPause no-ops when gameplay isn't active, so menu-opened
        // tutorials report nothing. No-op off-CG.
        if (typeof CgSdk !== 'undefined' && CgSdk.overlayPause) CgSdk.overlayPause();

        // Wait a frame so the canvas has its display size, then bind the
        // renderer to the tutorial canvas and lay out the grid.
        requestAnimationFrame(function () {
            Render.beginTutorial(canvas);
            // Park the cursor over the first tile without animating.
            const first = targetFor(STEPS[0].actions[0]);
            placeCursor(first, false);
            if (cursor) cursor.style.opacity = '1';
        });
    }

    function close() {
        if (!isOpen) return;
        isOpen = false;
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', onResize);

        // Restore the pre-tutorial Maze/Gates BEFORE handing the renderer back,
        // so endTutorial()'s repaint shows the real game state.
        if (saved) {
            if (saved.grid) {
                Maze.setQuadMode(saved.quad);
                Maze.setPathCount(saved.paths);
                Maze.loadSnapshot(saved.grid);
                if (typeof Gates !== 'undefined') {
                    if (saved.gates) Gates.restore(saved.gates); else Gates.clear();
                    if (Maze.recompute) Maze.recompute();
                }
            } else {
                if (Maze.clear) Maze.clear();
                if (typeof Gates !== 'undefined') Gates.clear();
            }
        }
        saved = null;

        Render.endTutorial();
        if (overlay) overlay.hidden = true;

        // Tear down any tooltip that appeared or queued while this overlay
        // was up (e.g. the 30s lock tip firing during a slow read — it
        // used to be sitting there the moment the tutorial closed). NOT
        // marked seen: a tip the player never acknowledged re-queues on
        // the next puzzle as designed, and the tutorial-covered ones
        // (lockTile / twinStraightLock) are suppressed by the watched
        // flag anyway once the final step was reached.
        if (typeof Tooltip !== 'undefined' && Tooltip.dismissActive) Tooltip.dismissActive(false);

        // Resume the CrazyGames gameplay signal if open() paused it (no-op
        // off-CG and when the tutorial was opened from the menu).
        if (typeof CgSdk !== 'undefined' && CgSdk.overlayResume) CgSdk.overlayResume();
    }

    function onKeyDown(ev) {
        if (!isOpen) return;
        if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); }
        else if ((ev.key === 'Enter' || ev.key === ' ') && !playing
                 && document.activeElement !== closeX) {
            ev.preventDefault();
            advance();
        }
    }

    function onResize() {
        // layoutTutorial already re-ran via Render's resize hook; reposition
        // the cursor to its current logical target.
        if (lastCursorPt && stepIdx < STEPS.length) {
            // Recompute from the last action's target if mid-run; otherwise the
            // next step's first action.
            const step = STEPS[Math.min(stepIdx, STEPS.length - 1)];
            if (step && step.actions.length) placeCursor(targetFor(step.actions[0]), false);
        }
    }

    // ---- init -------------------------------------------------------------
    function init() {
        overlay    = document.getElementById('tutorialOverlay');
        modal      = document.getElementById('tutorialModal');
        canvas     = document.getElementById('tutorialCanvas');
        canvasWrap = document.getElementById('tutorialCanvasWrap');
        cursor     = document.getElementById('tutorialCursor');
        ring       = document.getElementById('tutorialCursorRing');
        stepList   = document.getElementById('tutorialStepList');
        nextBtn    = document.getElementById('tutorialNextBtn');
        closeX     = document.getElementById('tutorialCloseX');
        openBtn    = document.getElementById('menuHowToBtn');

        if (nextBtn) nextBtn.addEventListener('click', function () { advance(); });
        if (closeX)  closeX.addEventListener('click', function () { close(); });
        if (openBtn) openBtn.addEventListener('click', function () { open(); });
        // Click on the dim backdrop (outside the modal) closes.
        if (overlay) overlay.addEventListener('click', function (ev) {
            if (ev.target === overlay) close();
        });
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return { open: open, close: close,
        // Live-state predicate for input gating: while the tutorial is open
        // the module has SWAPPED the real Maze/Gates/Render state for the
        // fixed teaching puzzle, so game input paths that survive the modal
        // overlay (keyboard shortcuts — the overlay already blocks pointer
        // input) must no-op or they'd mutate the tutorial grid and desync
        // state that close() restores (e.g. game.js's undo stack).
        isOpen: function () { return isOpen; },
        isWatched: function () {
        try { return localStorage.getItem(WATCHED_KEY) === '1'; } catch (e) { return false; }
    } };
})();
