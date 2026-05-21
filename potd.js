/**
 * potd.js — Puzzle of the Day mode.
 *
 * State machine: MENU → BUILDING → PLAYING → SOLVED → MENU.
 *
 * Lifecycle:
 *   1. Player picks a slot from the main menu.
 *   2. ensurePuzzleAvailable(slot) GETs /api/potd/today — always 200,
 *      possibly with a partial puzzles list. Whatever's already seeded
 *      we use directly; missing slots get generated via a dedicated
 *      Web Worker. The clicked slot generates first, the player starts
 *      playing as soon as it's ready, and the remaining missing slots
 *      keep generating in the background.
 *   3. Each generated slot is seeded IMMEDIATELY via POST /api/potd/seed
 *      (single slot at a time). If we lose a race (409 = another player
 *      already seeded it), we GET /api/potd/today/<slot> for the
 *      canonical snapshot and substitute it locally so the on-screen
 *      puzzle matches what subsequent players see.
 *   4. POST /api/potd/start → token + eligible flag. Ineligible means
 *      the player has started this slot today before (quit + retry).
 *   5. Load the snapshot, start a count-up timer, play.
 *   6. On solve, POST /api/potd/submit. Eligible submissions store + rank;
 *      ineligible ones are accepted but not stored.
 *
 * Robustness: per-slot cooperative seeding means a player closing their
 * browser mid-generation only leaves un-seeded slots for the next
 * player to fill in. The server's set converges toward 8 as players
 * cycle through; no single player has to complete the full set.
 *
 * Puzzle sizing (per the user spec): width and height each randomly
 * chosen in [10, 20], with (w + h) / 2 ≥ 15. Quad slots round to even.
 *
 * No time cap by design — PotD is the "take your time, solve it cleanly"
 * mode. The server's MAX_SESSION_MS (6h) bounds the token; longer than
 * that and the player has to /start again.
 */

const Potd = (() => {
    const STATE = {
        MENU:     'menu',
        BUILDING: 'building',
        PLAYING:  'playing',
        SOLVED:   'solved',
    };
    let state = STATE.MENU;

    const SLOTS = ['s1', 's2', 's3', 's4', 'q1', 'q2', 'q3', 'q4'];

    // Per the user: random size in [8, 14] for each axis, average ≥ 10.
    // Rejection sampling — keep-rate is high in this range.
    const SIZE_MIN     = 8;
    const SIZE_MAX     = 14;
    const SIZE_AVG_MIN = 10;

    // ── DOM refs (populated in init) ──
    let menuEl, hudEl, buildBannerEl, hudType, hudTimerVal, hudHintBtn;

    // ── Cached puzzle set + active attempt ──
    let puzzles      = null;   // { date, byslot: { s1: snapshot, ... } }
    let currentSlot  = null;
    let sessionToken = null;
    let eligible     = true;
    let puzzleStartMs = 0;
    let displayInterval = null;

    // ── Helpers ──

    function apiBase() {
        return (typeof AppConfig === 'object' && AppConfig && AppConfig.GAME_API) ? AppConfig.GAME_API : '';
    }
    function projectSlug() {
        return (typeof PROJECT_SLUG === 'string') ? PROJECT_SLUG : 'circuitousness';
    }
    function todayUTC() {
        const d = new Date();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return d.getUTCFullYear() + '-' + m + '-' + day;
    }

    // Per-browser UUID for server-side abuse forensics. Same shape as
    // marathon.js's getSessionId — share storage if marathon already has one.
    function sessionIdKey() { return projectSlug() + '_session_id'; }
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

    function slotConfig(slot) {
        return { quadMode: slot[0] === 'q', pathCount: parseInt(slot[1], 10) };
    }

    function generateDims(quadMode) {
        // Rejection sample: pick W and H in range, retry until avg ≥ 15.
        while (true) {
            let w, h;
            if (quadMode) {
                // Even values only — quad puzzles need divisible-by-2 dims.
                w = SIZE_MIN + 2 * Math.floor(Math.random() * ((SIZE_MAX - SIZE_MIN) / 2 + 1));
                h = SIZE_MIN + 2 * Math.floor(Math.random() * ((SIZE_MAX - SIZE_MIN) / 2 + 1));
            } else {
                const span = SIZE_MAX - SIZE_MIN + 1;
                w = SIZE_MIN + Math.floor(Math.random() * span);
                h = SIZE_MIN + Math.floor(Math.random() * span);
            }
            if ((w + h) / 2 >= SIZE_AVG_MIN) return { w, h };
        }
    }

    // ── Banner / HUD helpers ──

    function showBanner(text) {
        if (!buildBannerEl) return;
        buildBannerEl.textContent = text;
        buildBannerEl.classList.add('visible');
    }
    function hideBanner() {
        if (buildBannerEl) buildBannerEl.classList.remove('visible');
    }
    function showHud() {
        if (menuEl) menuEl.classList.remove('visible');
        if (hudEl)  hudEl.classList.add('visible');
    }
    function hideHud() {
        if (hudEl) hudEl.classList.remove('visible');
    }
    function showMenu() {
        if (hudEl)  hudEl.classList.remove('visible');
        if (menuEl) menuEl.classList.add('visible');
        refreshMenuIndicators();
    }

    function fmtTime(ms) {
        const totalSec = Math.floor(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m + ':' + String(s).padStart(2, '0');
    }
    function startTimerDisplay() {
        stopTimerDisplay();
        const update = () => {
            if (hudTimerVal) hudTimerVal.textContent = fmtTime(Date.now() - puzzleStartMs);
        };
        update();
        displayInterval = setInterval(update, 200);
    }
    function stopTimerDisplay() {
        if (displayInterval) { clearInterval(displayInterval); displayInterval = null; }
    }

    // ── localStorage state per slot per day ──
    //   key = <slug>_potd_<YYYY-MM-DD>_<slot>
    //   value = 'started' | 'solved'

    function stateKey(slot, date) {
        return projectSlug() + '_potd_' + date + '_' + slot;
    }
    function getSlotState(slot, date) {
        try { return localStorage.getItem(stateKey(slot, date)) || null; }
        catch (e) { return null; }
    }
    function setSlotState(slot, date, value) {
        try { localStorage.setItem(stateKey(slot, date), value); }
        catch (e) {}
    }

    function refreshMenuIndicators() {
        const date = puzzles ? puzzles.date : todayUTC();
        document.querySelectorAll('.menuModeBtn').forEach((btn) => {
            const slot = btn.dataset.mode;
            if (!slot || SLOTS.indexOf(slot) < 0) return;
            const s = getSlotState(slot, date);
            btn.classList.toggle('potd-solved',  s === 'solved');
            btn.classList.toggle('potd-started', s === 'started');
        });
    }

    // ── Server API helpers ──

    // GET /api/potd/today — always 200, possibly with a partial puzzles
    // list (cooperative seeding means the server may have, say, 3 of 8
    // until other players fill in the rest). Returns { date, byslot } or
    // null if the server is unreachable.
    async function fetchTodaysPuzzles() {
        const base = apiBase();
        if (!base) return null;
        try {
            const resp = await fetch(base + '/potd/today');
            if (resp.ok) {
                const data = await resp.json();
                const set = { date: data.date, byslot: {} };
                for (const p of (data.puzzles || [])) set.byslot[p.slot] = p.snapshot;
                return set;
            }
        } catch (e) { /* network error */ }
        return null;
    }

    // Single-slot fetch — used when our seed POST loses a race (409) so
    // we substitute the canonical snapshot into our local cache before
    // resolving the slot's waiter. Returns the snapshot or null.
    async function fetchSingleSlot(date, slot) {
        const base = apiBase();
        if (!base) return null;
        try {
            const resp = await fetch(base + '/potd/today/' + encodeURIComponent(slot));
            if (resp.ok) {
                const data = await resp.json();
                return data.snapshot || null;
            }
        } catch (e) { /* offline */ }
        return null;
    }

    // POST /api/potd/seed — single slot. Returns { ok, status }:
    //   201 ok           → we won the race, server now has our snapshot
    //   409 already_seeded → another player beat us; caller fetches theirs
    //   other            → offline / error; caller falls back to local-only play
    async function postSeedSingle(date, slot, snapshot) {
        const base = apiBase();
        if (!base) return { ok: false, status: 0 };
        try {
            const resp = await fetch(base + '/potd/seed', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ date, slot, snapshot }),
            });
            return { ok: resp.ok, status: resp.status };
        } catch (e) { return { ok: false, status: 0 }; }
    }

    async function postStart(date, slot) {
        const base = apiBase();
        if (!base) return null;
        try {
            const resp = await fetch(base + '/potd/start', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ date, slot, sessionId: getSessionId() }),
            });
            if (resp.ok) return await resp.json();
        } catch (e) { /* offline */ }
        return null;
    }

    async function postSubmit(payload) {
        const base = apiBase();
        if (!base) return null;
        try {
            const resp = await fetch(base + '/potd/submit', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload),
            });
            if (resp.ok) return await resp.json();
        } catch (e) { /* offline */ }
        return null;
    }

    // ── Background puzzle-generation queue ──
    //
    // Lazy + prioritized: player clicks a slot, that slot generates first
    // (in a dedicated Web Worker so the main thread stays interactive),
    // the player starts playing as soon as it's ready, and the remaining
    // 7 slots keep generating in the background. If the player quits and
    // picks a different un-generated slot, it gets moved to the front of
    // the queue (after whatever's currently in-flight — single-slot
    // generation isn't interruptible mid-`Maze.init`).
    //
    // Once all 8 are local, POST /api/potd/seed sends the set to the
    // back-end. 409 (someone else seeded first) re-fetches the server's
    // canonical set for future picks — the player's currently-loaded
    // puzzle keeps playing locally to avoid yanking the rug.

    let queue              = [];          // ordered slots awaiting gen; queue[0] is in-flight when inFlight=true
    let inFlight           = false;
    let slotWaiters        = new Map();   // slot → [resolve, …] callbacks
    let serverFetchAttempted = false;

    // Dedicated worker — independent Maze instance, no collision with
    // marathon's pre-gen worker. Lazily spun up on first need.
    let potdWorker         = null;
    let potdWorkerAvailable = true;
    let potdWorkerNextId   = 0;
    let potdWorkerCallbacks = new Map();  // id → { resolve, reject }

    function ensurePotdWorker() {
        if (potdWorker || !potdWorkerAvailable) return potdWorker;
        try {
            potdWorker = new Worker('maze-worker.js?t=' + Date.now());
            potdWorker.onmessage = function (e) {
                if (!e.data || e.data.type !== 'ready') return;
                const id = e.data.id;
                const cb = potdWorkerCallbacks.get(id);
                if (cb) {
                    potdWorkerCallbacks.delete(id);
                    cb.resolve(e.data.state);
                }
            };
            potdWorker.onerror = function (err) {
                potdWorkerAvailable = false;
                potdWorker = null;
                // Reject all pending callbacks so awaits unwind cleanly.
                for (const [, cb] of potdWorkerCallbacks) cb.reject(err);
                potdWorkerCallbacks.clear();
            };
        } catch (e) {
            potdWorkerAvailable = false;
            potdWorker = null;
        }
        return potdWorker;
    }

    function requestWorkerMaze(opts) {
        return new Promise((resolve, reject) => {
            const w = ensurePotdWorker();
            if (!w) return reject(new Error('worker unavailable'));
            const id = ++potdWorkerNextId;
            potdWorkerCallbacks.set(id, { resolve, reject });
            w.postMessage({
                type: 'generate',
                id,
                rows: opts.rows, cols: opts.cols,
                pathCount: opts.pathCount, quadMode: opts.quadMode,
            });
        });
    }

    // Generate one puzzle: maze in the worker, then gates on the main
    // thread (gates.js isn't imported in the worker, and assignGates
    // is fast — ~ms for a 14×14). save/restore the player's live Maze
    // + Gates state around the gate-assignment dance so a background
    // gen during play doesn't clobber the player's current puzzle.
    async function generateOneViaWorker(slot) {
        const cfg = slotConfig(slot);
        const dims = generateDims(cfg.quadMode);
        const mazeSnap = await requestWorkerMaze({
            rows: dims.h, cols: dims.w,
            pathCount: cfg.pathCount, quadMode: cfg.quadMode,
        });

        const savedMazeState  = (Maze.grid && Maze.ROWS > 0) ? Maze.snapshotState() : null;
        const savedQuadMode   = Maze.quadMode;
        const savedPathCount  = Maze.pathCount;
        const savedGatesState = (typeof Gates !== 'undefined' && Gates.snapshot) ? Gates.snapshot() : null;

        let gatesSnap = null;
        let pristineMazeSnap = null;
        try {
            Maze.setQuadMode(cfg.quadMode);
            Maze.setPathCount(cfg.pathCount);
            Maze.loadSnapshot(mazeSnap);
            // Take a fresh deep-copy snapshot BEFORE assignGates calls
            // Maze.solutionEdges. In quad mode solutionEdges temporarily
            // mutates the grid via rotateQuad to un-scramble for the walk,
            // and its `restoreState` only replaces the LIVE grid reference
            // — the worker's mazeSnap.grid stays in its post-mutation
            // (un-scrambled, solved) state. Returning mazeSnap directly
            // would then load the puzzle as already-solved at play time.
            pristineMazeSnap = Maze.snapshotState();
            if (typeof Gates !== 'undefined') {
                const stride = cfg.quadMode ? 2 : 1;
                Gates.assignGates(Maze.ROWS, Maze.COLS, Maze.solutionEdges(), 4, stride);
                gatesSnap = Gates.snapshot();
            }
        } finally {
            Maze.setQuadMode(savedQuadMode);
            Maze.setPathCount(savedPathCount);
            if (savedMazeState) {
                // Restore the player's live puzzle. loadSnapshot already
                // runs updateHighlighted; recompute again afterwards so
                // the restored gates state is folded into the walk.
                Maze.loadSnapshot(savedMazeState);
                if (typeof Gates !== 'undefined') {
                    if (savedGatesState) Gates.restore(savedGatesState);
                    else Gates.clear();
                }
                if (Maze.recompute) Maze.recompute();
            } else {
                // No live puzzle to restore — player is at the menu while
                // background gen runs. Just blank the maze + gates;
                // recompute would crash trying to walk a null entry.
                Maze.clear();
                if (typeof Gates !== 'undefined') Gates.clear();
            }
        }
        return { maze: pristineMazeSnap || mazeSnap, gates: gatesSnap };
    }

    // Fallback when the worker can't spawn (file:// origin, very old
    // browser). Main-thread generation, blocks the UI — matches the
    // pre-iteration behavior.
    async function generateOneOnMain(slot) {
        const cfg = slotConfig(slot);
        const dims = generateDims(cfg.quadMode);
        Maze.setQuadMode(cfg.quadMode);
        Maze.setPathCount(cfg.pathCount);
        Maze.setDimensions(dims.w, dims.h);
        await Maze.init();
        let gatesSnap = null;
        if (typeof Gates !== 'undefined') {
            const stride = cfg.quadMode ? 2 : 1;
            Gates.assignGates(Maze.ROWS, Maze.COLS, Maze.solutionEdges(), 4, stride);
            gatesSnap = Gates.snapshot();
        }
        return { maze: Maze.snapshotState(), gates: gatesSnap };
    }

    function resolveSlotWaiters(slot, snap) {
        const arr = slotWaiters.get(slot);
        if (arr) {
            for (const r of arr) { try { r(snap); } catch (e) {} }
            slotWaiters.delete(slot);
        }
    }

    // Single-flight processor. While inFlight is true, no other invocation
    // does anything; queue mutations made during a slot's await get
    // picked up on the next loop iteration.
    //
    // Each slot self-seeds immediately after generation — POSTs to
    // /api/potd/seed with this single slot. On 409 (another player
    // already seeded it), GETs the canonical snapshot and substitutes
    // it before resolving the waiter. That way the player's on-screen
    // puzzle is always the same as what the leaderboard's scoring,
    // regardless of who closed their browser mid-gen earlier.
    async function runQueue() {
        if (inFlight) return;
        inFlight = true;
        while (queue.length > 0) {
            const slot = queue[0];
            if (puzzles && puzzles.byslot[slot]) {
                queue.shift();
                resolveSlotWaiters(slot, puzzles.byslot[slot]);
                continue;
            }
            let snap = null;
            try {
                snap = ensurePotdWorker()
                    ? await generateOneViaWorker(slot)
                    : await generateOneOnMain(slot);
            } catch (e) {
                if (typeof Logger !== 'undefined') Logger.warn('PotD gen failed', slot, e);
            }
            queue.shift();
            if (snap) {
                if (!puzzles) puzzles = { date: todayUTC(), byslot: {} };
                // Try to seed this slot. If we lose the race, swap in
                // the server's canonical snapshot so our local play is
                // consistent with what other players will see.
                const seedResult = await postSeedSingle(puzzles.date, slot, snap);
                if (!seedResult.ok && seedResult.status === 409) {
                    const canonical = await fetchSingleSlot(puzzles.date, slot);
                    if (canonical) snap = canonical;
                }
                puzzles.byslot[slot] = snap;
                resolveSlotWaiters(slot, snap);
            }
        }
        inFlight = false;
    }

    // Returns a Promise that resolves with the slot's snapshot once gen
    // completes. Moves the slot to the front of the queue (after the
    // currently in-flight one, if any) and ensures the remaining slots
    // are queued behind it.
    function prioritizeAndAwait(slot) {
        if (puzzles && puzzles.byslot[slot]) {
            return Promise.resolve(puzzles.byslot[slot]);
        }
        // Move requested slot to the front (after in-flight if any).
        // If the slot is ALREADY the in-flight one (queue[0] + inFlight)
        // leave it alone — we'd otherwise demote it to position 1.
        const idx = queue.indexOf(slot);
        const isInFlightSlot = (idx === 0 && inFlight);
        if (!isInFlightSlot) {
            if (idx >= 0) queue.splice(idx, 1);
            queue.splice(inFlight ? 1 : 0, 0, slot);
        }
        // Append remaining ungenerated slots so the background continues
        // through all 8 once the priority slot lands.
        for (const s of SLOTS) {
            if (s === slot) continue;
            if (puzzles && puzzles.byslot[s]) continue;
            if (queue.indexOf(s) >= 0) continue;
            queue.push(s);
        }
        const p = new Promise((resolve) => {
            if (!slotWaiters.has(slot)) slotWaiters.set(slot, []);
            slotWaiters.get(slot).push(resolve);
        });
        runQueue();
        return p;
    }

    async function ensurePuzzleAvailable(slot) {
        const wantDate = todayUTC();

        // Date rolled over since the cache was built — reset everything.
        if (puzzles && puzzles.date !== wantDate) {
            puzzles               = null;
            serverFetchAttempted  = false;
            queue                 = [];
            slotWaiters.clear();
        }
        if (!puzzles) puzzles = { date: wantDate, byslot: {} };
        if (puzzles.byslot[slot]) return puzzles.byslot[slot];

        // First request of the session: try the server. The response is
        // always 200 — possibly with a partial puzzles list. Whatever's
        // already seeded we use directly; missing slots get generated +
        // seeded by us cooperatively (other players will do the same).
        if (!serverFetchAttempted) {
            serverFetchAttempted = true;
            showBanner('Loading today\'s puzzles…');
            await maybeServerReset();
            const fetched = await fetchTodaysPuzzles();
            if (fetched) {
                puzzles = fetched;
                if (puzzles.byslot[slot]) return puzzles.byslot[slot];
            }
        }

        showBanner('Generating today\'s puzzle…');
        return prioritizeAndAwait(slot);
    }

    // ── Start a puzzle ──

    async function startPuzzle(slot) {
        if (state !== STATE.MENU) return;
        if (SLOTS.indexOf(slot) < 0) return;

        state = STATE.BUILDING;

        // Hide the menu so the loading/generating banner has a clean
        // backdrop. Matches marathon's pattern. If we bail (error, user
        // declines the ineligible-retry disclaimer), bailToMenu restores it.
        // ensurePuzzleAvailable owns the banner text — it knows whether
        // we're fetching from the server or generating locally.
        if (menuEl) menuEl.classList.remove('visible');

        let snapshot;
        try {
            snapshot = await ensurePuzzleAvailable(slot);
        } catch (e) {
            bailToMenu();
            return;
        }
        if (!snapshot) {
            bailToMenu();
            return;
        }
        const date = (puzzles && puzzles.date) || todayUTC();

        // Already solved today? Refuse to restart (the eligibility gate is
        // also enforced server-side, but bailing here avoids the round-trip).
        const local = getSlotState(slot, date);
        if (local === 'solved') {
            bailToMenu();
            return;
        }

        // Issue session token + check eligibility. Server is the source
        // of truth: even if the player cleared localStorage, a prior
        // PotdSession row for (date, slot, sessionId) makes the new one
        // ineligible.
        const startData = await postStart(date, slot);
        sessionToken = startData ? startData.sessionToken : null;
        eligible     = startData ? !!startData.eligible    : true;

        // Disclaimer for ineligible retries — in-page modal (see #potdDisclaimerOverlay).
        if (!eligible) {
            const ok = await showDisclaimerModal();
            if (!ok) {
                bailToMenu();
                return;
            }
        }

        // Persist 'started' so menu indicator + future eligibility check
        // both see it. Server's PotdSession is what's authoritative; this
        // mirrors it client-side so the menu shows the correct state
        // even when offline.
        setSlotState(slot, date, 'started');

        // Load the snapshot.
        const cfg = slotConfig(slot);
        Maze.setQuadMode(cfg.quadMode);
        Maze.setPathCount(cfg.pathCount);
        Maze.loadSnapshot(JSON.parse(JSON.stringify(snapshot.maze)));
        if (snapshot.gates && typeof Gates !== 'undefined' && Gates.restore) {
            Gates.restore(snapshot.gates);
            if (Maze.recompute) Maze.recompute();
        } else if (typeof Gates !== 'undefined') {
            Gates.clear();
        }

        Render.refit();
        Render.draw();

        // Start a fresh recording anchored on the just-loaded snapshot,
        // so the player's solve moves (including gate rotations) end up
        // in Game.recording.moves where onSolve can pick them up to
        // include in the leaderboard submission.
        if (typeof Game !== 'undefined' && Game.startRecording) {
            Game.startRecording();
        }

        // HUD setup: type label, timer reset.
        if (hudType && typeof I18n !== 'undefined' && I18n.t) {
            hudType.textContent = I18n.t('marathon.mode' + slot.toUpperCase());
        }
        currentSlot = slot;
        puzzleStartMs = Date.now();
        startTimerDisplay();

        // Hide menu first (showHud removes .visible from menuEl), THEN hide
        // the banner. Reverse order would briefly expose the menu in the
        // gap between banner-down and menu-down.
        showHud();
        hideBanner();
        state = STATE.PLAYING;
    }

    // ── Solve detection (called from game.js's refresh when Maze.won flips) ──

    async function onSolve() {
        if (state !== STATE.PLAYING) return;
        state = STATE.SOLVED;
        stopTimerDisplay();

        const timeMs = Date.now() - puzzleStartMs;
        const date = puzzles.date;
        const slot = currentSlot;

        setSlotState(slot, date, 'solved');

        // Submit. The events payload is the current recording from Game.
        let recording = null;
        try {
            if (typeof Game !== 'undefined' && Game.recording) {
                recording = JSON.parse(JSON.stringify(Game.recording));
            }
        } catch (e) { /* fall through with null */ }

        let result = null;
        // Only submit when the run is still eligible. Hints flip eligible
        // to false client-side; the server doesn't know about hints, so
        // we have to gate the /submit ourselves to keep ineligible runs
        // off the leaderboard.
        if (sessionToken && eligible) {
            const lastName = (() => {
                try { return localStorage.getItem(projectSlug() + '_lastPlayerName') || ''; }
                catch (e) { return ''; }
            })();
            result = await postSubmit({
                sessionToken,
                timeMs,
                events: recording ? recording.moves : null,
                name: lastName,
                clientVersion: (typeof PAGE_VERSION === 'string') ? PAGE_VERSION : null,
            });
        }

        // Defer the modal briefly so the player sees the win-state visual
        // (gold lit channels, etc.) before the dialog covers the canvas.
        const rank           = (result && typeof result.rank === 'number') ? result.rank : null;
        const submittedOk    = !!(result && result.eligible !== false);
        const wasOffline     = !sessionToken;
        await new Promise((res) => setTimeout(res, 250));
        await showSolveModal({ timeMs, rank, submittedOk, wasOffline });
        quitToMenu();
    }

    // ── Result + disclaimer modals (replace browser alert() / confirm()) ──

    // Generic Continue/Cancel confirm modal — body element is the modal's
    // overlay div, button IDs are passed in so the same wiring serves both
    // the disclaimer and the hint-use prompt.
    function showConfirmModal(overlayId, continueBtnId, cancelBtnId) {
        return new Promise((resolve) => {
            const overlay = document.getElementById(overlayId);
            if (!overlay) return resolve(false);
            const continueBtn = document.getElementById(continueBtnId);
            const cancelBtn   = document.getElementById(cancelBtnId);
            function close(result) {
                overlay.style.display = 'none';
                if (continueBtn) continueBtn.removeEventListener('click', onContinue);
                if (cancelBtn)   cancelBtn.removeEventListener('click', onCancel);
                overlay.removeEventListener('click', onBackdrop);
                resolve(result);
            }
            function onContinue() { close(true); }
            function onCancel()   { close(false); }
            function onBackdrop(e) { if (e.target === overlay) close(false); }
            if (continueBtn) continueBtn.addEventListener('click', onContinue);
            if (cancelBtn)   cancelBtn.addEventListener('click', onCancel);
            overlay.addEventListener('click', onBackdrop);
            overlay.style.display = 'flex';
        });
    }

    function confirmHintUse() {
        return showConfirmModal('potdHintConfirmOverlay', 'potdHintConfirmContinueBtn', 'potdHintConfirmCancelBtn');
    }

    function noteHintUsed() {
        // Hint used during PotD play → run is no longer eligible. The
        // server's session token is still "eligible" from /start's
        // perspective (it doesn't know about hints), but the front-end
        // suppresses the /submit call entirely when eligible=false, so
        // the score doesn't reach the leaderboard.
        eligible = false;
    }

    function isEligible() {
        return eligible;
    }

    function showDisclaimerModal() {
        return showConfirmModal('potdDisclaimerOverlay', 'potdDisclaimerContinueBtn', 'potdDisclaimerCancelBtn');
    }

    function showSolveModal({ timeMs, rank, submittedOk, wasOffline }) {
        return new Promise((resolve) => {
            const card      = document.getElementById('potdSolveTransition');
            if (!card) return resolve();
            const timeEl    = document.getElementById('potdSolveTime');
            const rankEl    = document.getElementById('potdSolveRank');
            const ineligEl  = document.getElementById('potdSolveIneligible');
            const offlineEl = document.getElementById('potdSolveOffline');

            const t = (key, vars) =>
                (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, vars) : key;

            if (timeEl) timeEl.textContent = t('marathon.totalTime', { t: fmtTime(timeMs) });
            if (rankEl) {
                if (submittedOk && rank !== null) {
                    rankEl.textContent = t('potd.solved.rankFmt', { r: rank });
                    rankEl.hidden = false;
                } else {
                    rankEl.hidden = true;
                }
            }
            if (ineligEl)  ineligEl.hidden  = !!submittedOk || wasOffline;
            if (offlineEl) offlineEl.hidden = !wasOffline;

            // Tap-to-dismiss: marathon-style. Tap on the card itself
            // advances; canvas taps are blocked because Potd is in the
            // SOLVED state and the handlePointer guard will skip them.
            function close() {
                card.classList.remove('visible');
                card.removeEventListener('click', onClose);
                resolve();
            }
            function onClose() { close(); }
            card.addEventListener('click', onClose);
            card.classList.add('visible');
        });
    }

    function quitToMenu() {
        stopTimerDisplay();
        state = STATE.MENU;
        currentSlot = null;
        sessionToken = null;
        Maze.clear();
        Render.draw();  // wipe the canvas so the menu doesn't paint over a stale puzzle
        showMenu();
    }

    // Used when startPuzzle aborts before play starts (loading failure,
    // already-solved slot, declined disclaimer). Just hide the banner +
    // re-show the menu + reset state — no canvas / timer cleanup needed
    // since nothing was loaded.
    function bailToMenu() {
        hideBanner();
        showMenu();
        state = STATE.MENU;
    }

    // ── Init ──

    // DEV: when true, every page load wipes PotD state — locally AND on
    // the server (via POST /api/potd/dev-reset). Lets the dev test the
    // fresh-play flow repeatedly without waiting for the UTC day to roll
    // over. Flip to false (and remove the back-end's /api/potd/dev-reset
    // route) before public release.
    const RESET_ON_LOAD = true;
    let serverResetDone = false;   // single-flight per page load

    function resetLocalState() {
        try {
            const slug = projectSlug();
            const prefix = slug + '_potd_';
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.indexOf(prefix) === 0) toRemove.push(key);
            }
            for (const k of toRemove) localStorage.removeItem(k);
            // Also nuke the persisted sessionId — without this, the server
            // still sees this browser as a returning client (PotdSession
            // table keys eligibility by sessionId) so every replay would
            // come back ineligible. A fresh sessionId regenerates on the
            // next getSessionId() call.
            localStorage.removeItem(slug + '_session_id');
        } catch (e) { /* private mode — silent */ }
    }

    // Fire the back-end's dev-reset endpoint once per page load before the
    // first /api/potd/today call. Wipes today's PotdPuzzle / PotdScore /
    // PotdSession rows so the GET returns 404 and the front-end regenerates
    // a fresh set. No-op if the endpoint isn't deployed or unreachable.
    async function maybeServerReset() {
        if (!RESET_ON_LOAD || serverResetDone) return;
        serverResetDone = true;
        const base = apiBase();
        if (!base) return;
        try {
            await fetch(base + '/potd/dev-reset', { method: 'POST' });
        } catch (e) { /* offline / endpoint missing — silent */ }
    }

    function init() {
        if (RESET_ON_LOAD) resetLocalState();

        menuEl        = document.getElementById('menu');
        hudEl         = document.getElementById('hud');
        buildBannerEl = document.getElementById('buildingBanner');
        hudType       = document.getElementById('hudType');
        hudHintBtn    = document.getElementById('hudHintBtn');
        const timerEl = document.getElementById('hudTimer');
        hudTimerVal   = timerEl ? timerEl.querySelector('.hudTimerVal') : null;

        const quitBtn = document.getElementById('hudQuitBtn');
        if (quitBtn) {
            quitBtn.addEventListener('click', () => {
                if (state === STATE.PLAYING || state === STATE.SOLVED) quitToMenu();
            });
        }

        // Initial menu indicators (in case the page loads with a PotD
        // selection already in localStorage from a prior session).
        refreshMenuIndicators();

        // Re-render indicators when the player switches modes — the
        // body's mode-* class hides the ::after badge in non-PotD mode,
        // but the underlying .potd-solved class should reflect today's
        // localStorage state whenever the player returns to PotD.
        if (typeof ModePicker !== 'undefined' && ModePicker.onChange) {
            ModePicker.onChange((mode) => {
                if (mode === 'potd') refreshMenuIndicators();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        startPuzzle,
        onSolve,
        quitToMenu,
        isPlaying:           () => state === STATE.PLAYING,
        isBuilding:          () => state === STATE.BUILDING,
        isInSolveTransition: () => state === STATE.SOLVED,
        isEligible,
        confirmHintUse,
        noteHintUsed,
        refreshMenuIndicators,
        get SLOTS() { return SLOTS.slice(); },
    };
})();
