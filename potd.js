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
        // Strip any stale visual-state classes the timer container may
        // have inherited from a prior marathon run — particularly
        // `.urgent` (added by marathon when timeRemaining < 10s and
        // never removed on game-over), which would otherwise paint the
        // PotD count-up timer red.
        const timerEl = document.getElementById('hudTimer');
        if (timerEl) {
            timerEl.classList.remove('urgent');
            timerEl.classList.remove('penalty');
        }
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

    // ── localStorage cache for today's puzzle SNAPSHOTS ──
    //
    // Snapshots are immutable per (date, slot) — once seeded, they're the
    // canonical puzzle for that slot on that day forever. Caching them
    // locally means a returning player loads instantly on next visit
    // instead of paying the network round-trip + DB query (~1-3s even on
    // paid Render) just to get back the same bytes the server gave us
    // last time. We STILL fetch from the server in the background so
    // newly-seeded slots get picked up — the cache just provides the
    // fast path for slots we've already seen.
    //
    // Key includes the date so yesterday's cache doesn't poison today's.
    // pruneOldPuzzleCaches walks all our potd_puzzles_* entries and drops
    // anything that isn't today's, so localStorage doesn't grow forever.
    function puzzlesCacheKey(date) {
        return projectSlug() + '_potd_puzzles_' + date;
    }
    function loadPuzzlesCache(date) {
        try {
            const raw = localStorage.getItem(puzzlesCacheKey(date));
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || data.date !== date || !data.byslot) return null;
            return data;
        } catch (e) { return null; }
    }
    function savePuzzlesCache(date, byslot) {
        try {
            localStorage.setItem(puzzlesCacheKey(date), JSON.stringify({ date: date, byslot: byslot }));
        } catch (e) { /* quota exceeded — skip silently */ }
    }
    function pruneOldPuzzleCaches(keepDate) {
        try {
            const prefix = projectSlug() + '_potd_puzzles_';
            const stale = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(prefix) === 0 && k !== prefix + keepDate) {
                    stale.push(k);
                }
            }
            for (const k of stale) localStorage.removeItem(k);
        } catch (e) {}
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
    // null if the server is unreachable or didn't respond within the
    // timeout. The timeout matters specifically on Render's free tier
    // — cold starts can hang for 30+ seconds with no error, and without
    // it `ensurePuzzleAvailable`'s await on this fetch would leave the
    // player stuck on "Loading today's puzzles…" forever rather than
    // falling through to local generation.
    const FETCH_TIMEOUT_MS = 8000;
    async function fetchTodaysPuzzles() {
        const base = apiBase();
        if (!base) return null;
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
        try {
            const resp = await fetch(base + '/potd/today', ctrl ? { signal: ctrl.signal } : undefined);
            if (resp.ok) {
                const data = await resp.json();
                const set = { date: data.date, byslot: {} };
                for (const p of (data.puzzles || [])) set.byslot[p.slot] = p.snapshot;
                // Persist for instant load on next visit. Saving here
                // (rather than at each call site) keeps the cache write
                // in lockstep with the canonical server response, which
                // is the safest source to trust.
                savePuzzlesCache(set.date, set.byslot);
                pruneOldPuzzleCaches(set.date);
                return set;
            }
        } catch (e) {
            // Logger.warn so a hung fetch (cold-start timeout, CORS,
            // offline) surfaces in the console — the silent null return
            // made these very hard to diagnose.
            if (typeof Logger !== 'undefined') {
                Logger.warn('PotD: /today fetch failed', e && e.name === 'AbortError'
                    ? 'timeout after ' + FETCH_TIMEOUT_MS + 'ms'
                    : (e && e.message) || e);
            }
        } finally {
            if (timer) clearTimeout(timer);
        }
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
    // serverFetchPromise: the in-flight (or resolved) fetch promise for
    // today's puzzles. Multiple callers (player click, dev-mode boot
    // seed) share this single promise so a slow Render cold start
    // doesn't trigger a redundant fetch — and crucially, callers can
    // `await` it instead of skipping the load step just because someone
    // ELSE started the fetch. null = never started; non-null = either
    // pending or settled (either way, await is safe and cheap).
    let serverFetchPromise = null;

    // Dedicated worker — independent Maze instance, no collision with
    // marathon's pre-gen worker. Lazily spun up on first need. Stays
    // recoverable: a single error nulls the reference so the next call
    // tries a fresh worker; after MAX_WORKER_FAILURES consecutive
    // failures we give up permanently and fall through to main-thread
    // generation. Without this resilience a long-lived dev page that
    // hit one transient worker hiccup would freeze the UI on every
    // subsequent generation for the rest of the session.
    const MAX_WORKER_FAILURES = 3;
    let potdWorker          = null;
    let potdWorkerAvailable = true;
    let potdWorkerFailures  = 0;
    let potdWorkerNextId    = 0;
    let potdWorkerCallbacks = new Map();  // id → { resolve, reject }

    function ensurePotdWorker() {
        if (potdWorker || !potdWorkerAvailable) return potdWorker;
        try {
            potdWorker = new Worker('maze-worker.js?t=' + Date.now());
            potdWorker.onmessage = function (e) {
                if (!e.data || e.data.type !== 'ready') return;
                // Successful response — clear the failure counter so
                // transient hiccups don't accumulate into a permanent
                // disable across long sessions.
                potdWorkerFailures = 0;
                const id = e.data.id;
                const cb = potdWorkerCallbacks.get(id);
                if (cb) {
                    potdWorkerCallbacks.delete(id);
                    cb.resolve(e.data.state);
                }
            };
            potdWorker.onerror = function (err) {
                potdWorkerFailures++;
                // ErrorEvent fields are the only useful detail (the
                // event object itself stringifies to "Event" — useless
                // for diagnosis). filename/lineno point at the failing
                // line inside the worker; .message describes what blew.
                const detail = {
                    message:  err && err.message,
                    filename: err && err.filename,
                    line:     err && err.lineno,
                    col:      err && err.colno,
                    fails:    potdWorkerFailures,
                };
                if (typeof Logger !== 'undefined') {
                    Logger.warn('PotD worker error', detail);
                }
                // Discard this worker instance — next ensurePotdWorker()
                // call spins up a fresh one. Only permanently disable
                // after multiple consecutive failures so a one-off doesn't
                // condemn the rest of the session to main-thread builds.
                potdWorker = null;
                if (potdWorkerFailures >= MAX_WORKER_FAILURES) {
                    potdWorkerAvailable = false;
                    if (typeof Logger !== 'undefined') {
                        Logger.warn('PotD worker: ' + potdWorkerFailures +
                            ' consecutive failures — falling back to main-thread generation');
                    }
                }
                // Reject pending callbacks so awaits unwind cleanly.
                for (const [, cb] of potdWorkerCallbacks) cb.reject(err);
                potdWorkerCallbacks.clear();
            };
        } catch (e) {
            // Synchronous construction error (file:// origin, blocked
            // by CSP, etc) — these don't get a chance to recover, so
            // disable permanently right away.
            if (typeof Logger !== 'undefined') {
                Logger.warn('PotD worker: construction failed', e && e.message);
            }
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
                // ErrorEvent stringifies to "Event" so log the useful
                // fields explicitly — without this, the only message
                // reaching the console was unhelpful in diagnosing
                // why a generation actually failed.
                if (typeof Logger !== 'undefined') {
                    const detail = (e && e.message)
                        ? { slot: slot, message: e.message, filename: e.filename, line: e.lineno }
                        : { slot: slot, error: e };
                    Logger.warn('PotD gen failed', detail);
                }
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
            serverFetchPromise    = null;
            queue                 = [];
            slotWaiters.clear();
        }
        // Seed from localStorage cache if available — gives an instant
        // first click without waiting for the network round-trip. The
        // background fetch below still updates `puzzles` if the server
        // has slots we didn't have cached (e.g., a slot another player
        // seeded after our last visit).
        if (!puzzles) {
            const cached = loadPuzzlesCache(wantDate);
            puzzles = cached || { date: wantDate, byslot: {} };
        }
        if (puzzles.byslot[slot]) {
            // Even on cache hit, kick the server fetch in the background
            // so other slots' cache stays warm. Fire-and-forget — no
            // await, no banner.
            if (!serverFetchPromise) {
                serverFetchPromise = fetchTodaysPuzzles().then(function (fetched) {
                    if (fetched) {
                        // Merge: server-known slots beat cached ones (they're
                        // canonical), but we keep any cached slots the server
                        // hasn't reported yet (cooperative seeding may not
                        // have completed for them).
                        for (const k in fetched.byslot) puzzles.byslot[k] = fetched.byslot[k];
                    }
                });
            }
            return puzzles.byslot[slot];
        }

        // Cache miss for THIS slot. Now we genuinely need the server
        // (it might have what we don't). Share the in-flight promise so
        // a player click that happens WHILE devSeedAllSlots's fetch is
        // still pending awaits the same result instead of skipping the
        // load step (which would show "Generating…" while actually
        // waiting on the server).
        if (!serverFetchPromise) {
            serverFetchPromise = fetchTodaysPuzzles().then(function (fetched) {
                if (fetched) {
                    for (const k in fetched.byslot) puzzles.byslot[k] = fetched.byslot[k];
                }
            });
        }
        if (!puzzles.byslot[slot]) showBanner('Loading today\'s puzzles…');
        await serverFetchPromise;
        if (puzzles.byslot[slot]) return puzzles.byslot[slot];

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

        // Wipe whatever was last painted on the canvas (e.g. a Marathon
        // puzzle from before the player switched modes) so the
        // "Generating…" banner doesn't show over the prior game's tiles.
        // Mode-picker doesn't itself clear, and switching modes from
        // marathon's game-over state leaves the canvas intact.
        if (typeof Maze !== 'undefined' && Maze.clear) Maze.clear();
        if (typeof Render !== 'undefined' && Render.draw) Render.draw();
        // Show a banner immediately so the player always has visual
        // feedback during the startPuzzle pipeline. ensurePuzzleAvailable
        // may replace the text below (with "Loading today's puzzles…" or
        // "Generating today's puzzle…") if it has work to do; on the
        // cache-hit path it doesn't touch the banner, which is the case
        // that previously left a dead screen for several seconds while
        // postStart awaited a session token over the network.
        showBanner('Loading today\'s puzzle…');

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
        // ineligible. The banner above stays up during this await so
        // the player doesn't see a blank screen while we wait for the
        // session-token round-trip.
        const startData = await postStart(date, slot);
        sessionToken = startData ? startData.sessionToken : null;
        eligible     = startData ? !!startData.eligible    : true;

        // Disclaimer for ineligible retries — in-page modal (see #potdDisclaimerOverlay).
        if (!eligible) {
            // Hide the loading banner so it doesn't sit underneath the
            // disclaimer card — the disclaimer is the player's full
            // attention here.
            hideBanner();
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

        // Music kicks in once the puzzle is actually loaded and about to be
        // playable — matches marathon.js's "music starts at game-start"
        // pattern. Music.stop() lives in quitToMenu so PotD's solve→menu
        // transition silences playback cleanly.
        if (typeof Music !== 'undefined' && Music.start) Music.start();
        // Engagement tracking: one start per PotD slot. The slot string
        // (s1..s4, q1..q4) goes into the gameType column so the admin
        // breakdown can distinguish PotD plays of each type.
        if (typeof Tracking !== 'undefined' && Tracking.recordStart) Tracking.recordStart('potd', slot);

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
        // Stop gameplay music and roll the end-credits sequence behind the
        // solve modal. Credits.start kicks the credits track on a delay so
        // the music swap doesn't feel abrupt; the solve modal positions
        // itself in the upper third via body.credits-rolling.
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        if (typeof Credits !== 'undefined' && Credits.start) Credits.start();
        // Engagement tracking: solving a PotD = "finished a puzzle". Same
        // sticky-server-side behavior as marathon gameOver.
        if (typeof Tracking !== 'undefined' && Tracking.recordFinish) Tracking.recordFinish();
        // Share popup gate (Share module owns dismissal + threshold).
        if (typeof Share !== 'undefined' && Share.maybeShowPopup) Share.maybeShowPopup();
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
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        // Tear the credits down before returning to menu. Covers both the
        // post-solve dismiss path (modal tap → quitToMenu) and the in-game
        // Quit button (which doesn't trigger credits, but Credits.stop is
        // a safe no-op when nothing's rolling).
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
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

    // DEV: manual reset wired to the debug page's "Reset PotD (today)"
    // button. Wipes localStorage's PotD state AND today's server-side
    // PotdPuzzle / PotdScore / PotdSession rows, then nukes the
    // in-memory cache so the next slot click re-fetches from scratch.
    // Lets the dev test the fresh-play flow without waiting for the
    // UTC day to roll over. Remove the back-end's /api/potd/dev-reset
    // route + this function + the debug button before public release.
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

    // Public dev hook. Returns a small status object the caller can
    // surface in the debug UI. Any in-flight background generation is
    // left to drain naturally — its seed POST will just land in the
    // post-reset (empty) server set, which is benign.
    async function devReset() {
        const base = apiBase();
        let serverOk = false;
        if (base) {
            try {
                const resp = await fetch(base + '/potd/dev-reset', { method: 'POST' });
                serverOk = resp.ok;
            } catch (e) { /* offline / endpoint missing — leave serverOk false */ }
        }
        resetLocalState();
        // In-memory cache wipe — so the next slot click re-fetches and,
        // finding nothing, regenerates fresh puzzles + reseeds the server.
        puzzles              = null;
        serverFetchPromise   = null;
        queue                = [];
        slotWaiters.clear();
        refreshMenuIndicators();
        return { serverOk: serverOk, serverReachable: !!base };
    }

    function init() {
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

    // Dev-mode hook (used by dev-mode.js's daily watcher in ?dev=true
    // sessions). Quiet variant of ensurePuzzleAvailable that processes
    // all 8 slots without showing a player-facing banner: silently
    // fetches whatever's already seeded from the server, queues the
    // missing slots, and awaits the queue draining. Each generated slot
    // self-seeds via the existing runQueue path (POST /api/potd/seed),
    // so by the time this resolves all 8 are on the server.
    async function devSeedAllSlots() {
        const wantDate = todayUTC();
        // Date rolled — same reset the player-facing path does.
        if (puzzles && puzzles.date !== wantDate) {
            puzzles               = null;
            serverFetchPromise    = null;
            queue                 = [];
            slotWaiters.clear();
        }
        // Seed from local cache first so a session that already knows
        // about today's puzzles doesn't burn worker cycles re-generating
        // them. Cached slots were obtained from the server at some point
        // (they only enter the cache via a successful fetchTodaysPuzzles
        // write), and PotD snapshots are immutable per date+slot, so a
        // cache hit reliably means "the server has this slot".
        if (!puzzles) {
            const cached = loadPuzzlesCache(wantDate);
            puzzles = cached || { date: wantDate, byslot: {} };
        }

        // Share the in-flight fetch with ensurePuzzleAvailable — if a
        // player clicks a slot WHILE this fetch is pending, they'll
        // await the same promise instead of triggering a duplicate
        // request (or worse, skipping the load + queueing a redundant
        // generation that the server would 409 on).
        if (!serverFetchPromise) {
            if (typeof Logger !== 'undefined') Logger.info('[dev] PotD ' + wantDate + ': fetching server-seeded set…');
            serverFetchPromise = fetchTodaysPuzzles().then(function (fetched) {
                if (fetched) puzzles = fetched;
            });
        }
        await serverFetchPromise;

        const missing = SLOTS.filter((s) => !puzzles.byslot[s]);
        if (typeof Logger !== 'undefined') {
            Logger.info('[dev] PotD ' + wantDate + ': ' +
                (SLOTS.length - missing.length) + '/' + SLOTS.length +
                ' already seeded' +
                (missing.length ? '; generating ' + missing.join(', ') : ''));
        }
        if (missing.length === 0) return;

        const tasks = missing.map((slot) => {
            if (queue.indexOf(slot) < 0) queue.push(slot);
            return new Promise((resolve) => {
                if (!slotWaiters.has(slot)) slotWaiters.set(slot, []);
                slotWaiters.get(slot).push(resolve);
            });
        });
        runQueue();
        await Promise.all(tasks);
        if (typeof Logger !== 'undefined') {
            Logger.info('[dev] PotD ' + wantDate + ': all ' + SLOTS.length + ' slots seeded');
        }
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
        devReset,
        devSeedAllSlots,
        get SLOTS() { return SLOTS.slice(); },
    };
})();
