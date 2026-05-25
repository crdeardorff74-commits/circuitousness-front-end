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
    // Per-mode physical sub-tile dim ranges (the dims the generator
    // actually consumes). Quad needs different — and even — values
    // because each player-facing quad-tile is a 2×2 group of sub-tiles.
    // The two modes were originally on the same range, but at parity
    // singular felt right while quad felt cramped (3 quad-tiles per
    // axis is very tight). Doubled quad to 12–24 felt too sprawling,
    // so quad now sits at the midpoint — physically larger than
    // singular's range, but quad-tile counts that still feel manageable
    // as a daily exercise. 10/18/14 → 5–9 quad-tiles per axis with an
    // average cap of 7.
    const SIZE_MIN          = 6;
    const SIZE_MAX          = 12;
    // Rejection-sample CEILING on the (W+H)/2 average — pairs whose
    // average exceeds this get re-rolled. Without it, lopsided rolls
    // (one axis at min, the other at max) would land bigger than the
    // distribution targets. Per-mode so quad can have a larger absolute
    // cap that's still a sensible fraction of its own range.
    const SIZE_AVG_MAX      = 9;
    const SIZE_MIN_QUAD     = 10;
    const SIZE_MAX_QUAD     = 18;
    const SIZE_AVG_MAX_QUAD = 14;

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
        // Per-mode physical dim range. Singular's range was the
        // original target; quad sits between "use singular's range
        // directly" (felt cramped, 3×3 quad-tile floor) and "double
        // singular's range" (felt sprawling, 6×6 quad-tile floor).
        // Current values target a 5×5 quad-tile floor / 9×9 ceiling
        // with avg ≤ 7 quad-tiles per axis.
        const min    = quadMode ? SIZE_MIN_QUAD     : SIZE_MIN;
        const max    = quadMode ? SIZE_MAX_QUAD     : SIZE_MAX;
        const avgCap = quadMode ? SIZE_AVG_MAX_QUAD : SIZE_AVG_MAX;
        // Rejection sample: pick W and H in [min, max], re-roll until
        // (W+H)/2 ≤ avgCap. Caps overall size so neither axis can land
        // far on the large end while the other is also moderately
        // large — keeps puzzles approachable as a daily exercise.
        while (true) {
            let w, h;
            if (quadMode) {
                // Even values only — quad puzzles need divisible-by-2
                // sub-tile dims so each 2×2 quad-tile fits cleanly.
                // (min/max are already even from the *2, so stepping by
                // 2 covers the full range.)
                const span = (max - min) / 2 + 1;
                w = min + 2 * Math.floor(Math.random() * span);
                h = min + 2 * Math.floor(Math.random() * span);
            } else {
                const span = max - min + 1;
                w = min + Math.floor(Math.random() * span);
                h = min + Math.floor(Math.random() * span);
            }
            if ((w + h) / 2 <= avgCap) return { w, h };
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
        // Re-paint the menu indicators every time we write. Without this,
        // a 'solved' write during onSolve doesn't reach the buttons until
        // something else (init, ModePicker.onChange to 'potd') happens to
        // call refreshMenuIndicators — so a player who solves a PotD slot
        // and goes straight to the leaderboard sees the same fresh cards
        // until they bounce out to Marathon and back. The buttons may be
        // hidden right now (we're mid-puzzle); querySelectorAll still
        // finds them and the next menu reveal paints correctly.
        // refreshMenuIndicators is a hoisted function declaration below,
        // so this forward reference is safe at runtime.
        refreshMenuIndicators();
    }

    // Per-(date, slot) localStorage record of the server's last-seen
    // generated_at timestamp. Used by reconcileGeneratedAt to detect
    // when a slot's underlying puzzle has been re-seeded server-side
    // (e.g., by the dev-reset endpoint or — eventually — by the next
    // UTC day's rollover). Storing per slot rather than per date so
    // partial reseeds (cooperative seeding mid-day) don't false-trigger
    // wipes on slots that didn't change.
    function genAtKey(slot, date) {
        return projectSlug() + '_potd_genAt_' + date + '_' + slot;
    }
    // Reconcile local PotD state against a fresh /potd/today response.
    // Two paths:
    //
    //   1. Slots PRESENT in the response — compare generatedAt timestamps.
    //      A mismatch means the puzzle was re-seeded since this client
    //      last saw it (dev-reset + new player, or server-side data
    //      churn); the local 'solved'/'started' state refers to a
    //      different puzzle than the server actually has, so wipe it.
    //
    //   2. Slots ABSENT from the response — if we've EVER seen a server
    //      puzzle for this slot (lastSeen genAt non-null), the server has
    //      since dropped it. This is the cross-browser dev-reset case:
    //      Browser A clicks Reset → server PotdPuzzle rows wiped → some
    //      slots get re-seeded before Browser B reloads, some don't yet.
    //      Slots not in the response stayed wiped server-side, so the
    //      stale local state on Browser B is now meaningless. Wipe both
    //      the state and the genAt record so a future re-seed registers
    //      as a fresh first-sight (not a mismatch-of-stale).
    //
    //   Exception: a slot with lastSeen=null (never seen a server puzzle)
    //   and a local 'solved'/'started' state means the player solved a
    //   purely-local puzzle whose seed POST never reached the server —
    //   offline play, or a 409 race. Leave that state alone; wiping it
    //   would erase the player's only record of an actual solve.
    function reconcileGeneratedAt(date, puzzlesList) {
        if (!date || !Array.isArray(puzzlesList)) return;
        const serverSlots = new Set();
        // Path 1: slots present in the response. Always record the slot
        // in serverSlots BEFORE checking generatedAt — old back-end
        // deployments don't return that field, but the slot IS still on
        // the server, and path 2 below would otherwise wrongly treat it
        // as "absent" and wipe local state. The generatedAt comparison
        // (when available) handles re-seed detection; without it we just
        // skip that comparison but still trust the slot's presence.
        for (const p of puzzlesList) {
            if (!p || !p.slot) continue;
            serverSlots.add(p.slot);
            if (!p.generatedAt) continue;
            let lastSeen = null;
            try { lastSeen = localStorage.getItem(genAtKey(p.slot, date)); }
            catch (e) { /* private mode — skip */ }
            if (lastSeen !== p.generatedAt) {
                if (lastSeen !== null) {
                    try { localStorage.removeItem(stateKey(p.slot, date)); }
                    catch (e) {}
                }
                try { localStorage.setItem(genAtKey(p.slot, date), p.generatedAt); }
                catch (e) {}
            }
        }
        // Path 2: slots absent from the response. The fetch succeeded
        // (this function is only called from inside the response-ok
        // branch of fetchTodaysPuzzles), so absent-from-response means
        // "server doesn't have this slot right now" — re-seed pending,
        // dev-reset, etc. Wipe local state regardless of whether we
        // have a genAt record for it, because (a) without the back-end
        // generatedAt-field deployment we'd never have one even for
        // legitimate state, and (b) the only case the previous
        // lastSeen!==null guard protected — pure-offline play whose
        // seed POST never reached the server — leaves the local state
        // unable to post a score anyway, so wiping costs the player
        // nothing they could have actually used.
        for (const slot of SLOTS) {
            if (serverSlots.has(slot)) continue;
            try {
                localStorage.removeItem(stateKey(slot, date));
                localStorage.removeItem(genAtKey(slot, date));
            } catch (e) {}
        }
        // After potentially clearing slot states, refresh the menu so the
        // badges reflect the (now-empty) localStorage. Cheap; no-op when
        // nothing changed.
        refreshMenuIndicators();
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
    // null if every attempt fails (server unreachable or unresponsive).
    //
    // Timeout + retry rationale: the per-attempt cap originally existed
    // for Render free-tier cold starts (30+ seconds of hang with no
    // error). Even on paid tier, transient slowness still happens
    // (DB pool exhaustion, brief GC pause, deploy mid-flight) and an 8s
    // cap occasionally trips on requests that would have succeeded in
    // 9-10s. A single retry covers those cases without the user staring
    // at "Loading today's puzzles…" for the entire window of one really
    // long hang. Worst case (both attempts time out): ~16.5s, then
    // ensurePuzzleAvailable falls through to local generation.
    const FETCH_TIMEOUT_MS     = 8000;
    const FETCH_MAX_ATTEMPTS   = 2;
    const FETCH_RETRY_DELAY_MS = 500;

    // Single fetch attempt — returns { ok, data } on success or
    // { ok: false, reason } on any failure (network error, abort,
    // non-2xx). Separated from the outer retry loop so each attempt
    // gets its own AbortController + timeout pair.
    async function attemptFetchTodaysPuzzles(base) {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS) : null;
        try {
            const resp = await fetch(base + '/potd/today', ctrl ? { signal: ctrl.signal } : undefined);
            if (resp.ok) {
                const data = await resp.json();
                return { ok: true, data: data };
            }
            return { ok: false, reason: 'http ' + resp.status };
        } catch (e) {
            return { ok: false, reason: e && e.name === 'AbortError'
                ? 'timeout after ' + FETCH_TIMEOUT_MS + 'ms'
                : (e && e.message) || String(e) };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    async function fetchTodaysPuzzles() {
        const base = apiBase();
        if (!base) return null;
        let lastReason = null;
        for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
            const result = await attemptFetchTodaysPuzzles(base);
            if (result.ok) {
                const data = result.data;
                const set = { date: data.date, byslot: {} };
                for (const p of (data.puzzles || [])) set.byslot[p.slot] = p.snapshot;
                // Staleness check — wipes 'solved'/'started' state for any
                // slot whose server-side puzzle has been re-seeded since
                // this client last saw it. Catches the cross-browser
                // dev-reset case: Browser A clicks Reset PotD, the server
                // drops + (eventually) re-seeds today's PotdPuzzle rows,
                // but Browser B's localStorage still claims to have
                // solved them. Comparing generated_at per slot lets
                // Browser B notice and self-clean on its next /today fetch.
                reconcileGeneratedAt(data.date, data.puzzles || []);
                // Persist for instant load on next visit. Saving here
                // (rather than at each call site) keeps the cache write
                // in lockstep with the canonical server response, which
                // is the safest source to trust.
                savePuzzlesCache(set.date, set.byslot);
                pruneOldPuzzleCaches(set.date);
                return set;
            }
            lastReason = result.reason;
            if (attempt < FETCH_MAX_ATTEMPTS) {
                // Brief pause before retrying — gives the back-end a
                // moment to recover from whatever caused the first
                // attempt to fail (transient connection pool exhaustion,
                // brief GC pause, deploy mid-flight, etc.).
                await new Promise(function (res) { setTimeout(res, FETCH_RETRY_DELAY_MS); });
            }
        }
        // All attempts failed. Log enough context to diagnose without
        // spelunking — the silent null return historically made hung
        // fetches a pain to track down.
        if (typeof Logger !== 'undefined') {
            Logger.warn('PotD: /today fetch failed after ' + FETCH_MAX_ATTEMPTS + ' attempts:', lastReason);
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
    //   other            → offline / error; caller falls back to local-only
    //                       play (which then 404s on /potd/start and shows
    //                       "Offline" on the solve modal — historically the
    //                       single most opaque failure mode in PotD).
    //
    // Per-attempt timeout + single retry mirrors fetchTodaysPuzzles —
    // unbounded fetch was the silent-hang root cause, and one retry
    // covers transient back-end slowness (DB pool exhaustion, brief GC
    // pause) without making the player wait 30+s on a truly down server.
    const SEED_TIMEOUT_MS     = 8000;
    const SEED_MAX_ATTEMPTS   = 2;
    const SEED_RETRY_DELAY_MS = 500;
    async function attemptSeedSingle(base, date, slot, snapshot) {
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, SEED_TIMEOUT_MS) : null;
        try {
            const resp = await fetch(base + '/potd/seed', Object.assign({
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ date, slot, snapshot }),
            }, ctrl ? { signal: ctrl.signal } : {}));
            return { ok: resp.ok, status: resp.status };
        } catch (e) {
            return { ok: false, status: 0, reason: e && e.name === 'AbortError'
                ? 'timeout after ' + SEED_TIMEOUT_MS + 'ms'
                : (e && e.message) || String(e) };
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    async function postSeedSingle(date, slot, snapshot) {
        const base = apiBase();
        if (!base) return { ok: false, status: 0 };
        let last = null;
        for (let attempt = 1; attempt <= SEED_MAX_ATTEMPTS; attempt++) {
            last = await attemptSeedSingle(base, date, slot, snapshot);
            // 201 = success, 409 = lost race (caller handles). Both are
            // terminal — no retry. Only transient failures (5xx, network
            // abort, timeout) get retried.
            if (last.ok) return last;
            if (last.status === 409) return last;
            if (attempt < SEED_MAX_ATTEMPTS) {
                await new Promise(function (res) { setTimeout(res, SEED_RETRY_DELAY_MS); });
            }
        }
        // Both attempts failed. Surface the failure clearly — historically
        // a silent fall-through to "local snap only, server has nothing"
        // caused the subsequent /potd/start to 404 and the player to see
        // an "Offline" message on solve despite being online.
        if (typeof Logger !== 'undefined') {
            Logger.warn('PotD: /potd/seed failed after ' + SEED_MAX_ATTEMPTS + ' attempts',
                { slot: slot, status: last && last.status, reason: last && last.reason });
        }
        return last || { ok: false, status: 0 };
    }

    // Inner request: just the POST, no recovery logic. Lets postStart
    // distinguish a network failure (return null) from a "server says
    // not_generated" (404 → caller can re-seed and retry).
    async function attemptPostStart(base, date, slot) {
        try {
            const resp = await fetch(base + '/potd/start', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ date, slot, sessionId: getSessionId() }),
            });
            if (resp.ok) return { ok: true, data: await resp.json() };
            return { ok: false, status: resp.status };
        } catch (e) {
            return { ok: false, status: 0 };
        }
    }
    async function postStart(date, slot) {
        const base = apiBase();
        if (!base) return null;
        const first = await attemptPostStart(base, date, slot);
        if (first.ok) return first.data;
        // 404 from /potd/start means the server doesn't have a
        // PotdPuzzle row for (date, slot) yet — even though
        // ensurePuzzleAvailable should have seeded it. This is the
        // recurring "Offline despite being online" trap: the seed POST
        // failed silently (server hiccup, transient 5xx), runQueue
        // fell through with a local snap, and now start can't proceed.
        // Recovery: re-seed from the local snap (which we still have in
        // puzzles.byslot[slot]) and retry start once. Only the 404 path
        // gets this recovery — other failures (timeout, network) just
        // return null and let the solve modal show "Offline".
        if (first.status === 404 && puzzles && puzzles.byslot && puzzles.byslot[slot]) {
            if (typeof Logger !== 'undefined') {
                Logger.warn('PotD: /potd/start 404 — re-seeding and retrying', { slot: slot });
            }
            const seedResult = await postSeedSingle(date, slot, puzzles.byslot[slot]);
            // Either we won (201) or someone seeded in the meantime
            // (409) — either way the row should exist now.
            if (seedResult.ok || seedResult.status === 409) {
                const retry = await attemptPostStart(base, date, slot);
                if (retry.ok) return retry.data;
            }
        }
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
    // Resolution state for serverFetchPromise. Promises don't expose a
    // synchronous "have you settled yet?" — we track it ourselves so
    // ensurePuzzleAvailable can suppress the "Loading today's puzzles…"
    // banner on the cache-already-warm path (e.g. after init()'s pre-warm
    // resolved before the user clicked). Without this, repeat clicks
    // flashed "Loading…" for one frame even though the await was
    // instantaneous, which read as a misleading network-wait blip
    // followed by the real "Generating…" banner.
    let serverFetchResolved = false;

    // Helper — fire fetchTodaysPuzzles into serverFetchPromise if no
    // fetch is in flight. Centralizes the resolution-tracking so all
    // three caller sites (init pre-warm, ensurePuzzleAvailable cache-hit
    // branch, ensurePuzzleAvailable cache-miss branch) agree on when
    // serverFetchResolved flips. devSeedAllSlots intentionally keeps its
    // own merge logic (it replaces `puzzles` wholesale rather than
    // merging into byslot) — that's dev-only and silent so the banner
    // suppression isn't relevant there.
    function ensureServerFetch() {
        if (serverFetchPromise) return;
        serverFetchResolved = false;
        serverFetchPromise = fetchTodaysPuzzles().then(function (fetched) {
            if (fetched) {
                for (const k in fetched.byslot) puzzles.byslot[k] = fetched.byslot[k];
            }
        }).finally(function () {
            serverFetchResolved = true;
        });
    }

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
            serverFetchResolved   = false;
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
            ensureServerFetch();
            return puzzles.byslot[slot];
        }

        // Cache miss for THIS slot. Now we genuinely need the server
        // (it might have what we don't). Share the in-flight promise so
        // a player click that happens WHILE devSeedAllSlots's fetch is
        // still pending awaits the same result instead of skipping the
        // load step (which would show "Generating…" while actually
        // waiting on the server).
        ensureServerFetch();
        // Only show "Loading today's puzzles…" if the fetch is still
        // in flight. After init's pre-warm completes, serverFetchResolved
        // is true and the await below is effectively instant — we'd
        // rather skip straight to "Generating…" than flash a misleading
        // network-wait banner for one frame.
        if (!puzzles.byslot[slot] && !serverFetchResolved) {
            showBanner('Loading today\'s puzzles…');
        }
        await serverFetchPromise;
        if (puzzles.byslot[slot]) return puzzles.byslot[slot];

        showBanner('Generating today\'s puzzle…');
        return prioritizeAndAwait(slot);
    }

    // ── Start a puzzle ──

    async function startPuzzle(slot) {
        // Diagnostic: log when a click is silently rejected by the state
        // guard. Helps catch the "click did nothing, second click worked"
        // case — if the user sees this warn in the console on a failed
        // click, the state machine got stuck in a non-MENU state.
        if (state !== STATE.MENU) {
            if (typeof Logger !== 'undefined' && Logger.warn) {
                Logger.warn('PotD.startPuzzle: rejected, state =', state, 'slot =', slot);
            }
            return;
        }
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

        // Compute the date up front so postStart can fire in parallel
        // with ensurePuzzleAvailable. The two endpoints are independent:
        // /potd/today returns the snapshot, /potd/start issues a session
        // token + reports eligibility — neither needs the other's
        // response. Sequential awaits added an extra round-trip of
        // latency for no functional reason. We prefer puzzles.date when
        // the pre-warm fetch has already populated it (server-authoritative
        // for the rollover edge), falling back to client UTC otherwise.
        const date = (puzzles && puzzles.date) || todayUTC();

        // Already solved today? Refuse to restart (the eligibility gate is
        // also enforced server-side, but bailing here avoids the round-trip).
        // This runs BEFORE the network fire-off so we never burn a session
        // token on a slot we already know the player can't post a score for.
        const local = getSlotState(slot, date);
        if (local === 'solved') {
            bailToMenu();
            return;
        }

        // Sequential: ensurePuzzleAvailable MUST complete before postStart,
        // because the server's /potd/start endpoint refuses to issue a
        // session token for a slot that hasn't been seeded server-side yet
        // (returns 404). ensurePuzzleAvailable is what seeds it — either by
        // pulling from the /today response or, on a cache miss, by
        // generating locally + POSTing /potd/seed.
        //
        // A previous version of this code fired both via Promise.all to
        // shave one network round-trip. That worked when the slot was
        // already seeded (the common case once a day is warm) but broke
        // every first-play scenario — fresh users, first-of-the-day picks,
        // and especially post-dev-reset plays would race /start ahead of
        // the seed POST, /start would 404, sessionToken would land null,
        // and the solve modal would falsely tell the player they were
        // offline. The marginal speed win wasn't worth the silent
        // failure mode. The pre-warm in init() still hides the /today
        // round-trip behind the intro screen, so cache-warm clicks are
        // still effectively instant; the only cost of sequential here is
        // one /start round-trip latency, which is small compared to
        // anything seeding-related.
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

        // PotD bypasses game.js's newPuzzle, so we also have to manually
        // reset the SFX diff baselines (lastPathsWon / lastWon / lastJoined
        // in game.js's closure). Without this, the first refresh() during
        // this PotD play diffs against the previous marathon game's stale
        // state and can fire spurious applause on the player's first tile
        // click — particularly with 1-/2-/3-path PotD slots whose unused
        // path slots default to `true` and read as "newly connected"
        // against the prior 4-path marathon's all-false baseline.
        if (typeof Game !== 'undefined' && Game.resetSfxBaselines) {
            Game.resetSfxBaselines();
        }

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
        // transition silences playback cleanly. Phase switch makes next
        // pickNext draw from the intro/shuffle pool instead of menu_only.
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(false);
            if (Music.start)        Music.start();
        }
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
        // First-play educational tooltips:
        //   • potdHint — appears immediately so the player reads the
        //     hint-disqualification rule BEFORE they're tempted to use
        //     one.
        //   • lockTile — scheduled 30s in so it appears once the player
        //     is mid-solve. Shared seen-flag with marathon's lockTile
        //     trigger, so a player who saw the tip in one mode doesn't
        //     see it again in the other.
        if (typeof Tooltip !== 'undefined') {
            Tooltip.showOnce('potdHint',
                (typeof I18n !== 'undefined' && I18n.t)
                    ? I18n.t('tooltip.potdHint')
                    : 'Using HINT for help will disqualify you for the Puzzle of the Day leaderboards');
            scheduleLockTip();
        }
    }
    // Same lock-tip scheduling pattern marathon uses — see marathon.js
    // for the rationale. Cancelled on puzzle exit (quit-to-menu / solve)
    // so the tip can't fire over a non-puzzle screen.
    let lockTipTimerHandle = null;
    const LOCK_TIP_DELAY_MS = 30000;
    function scheduleLockTip() {
        cancelLockTip();
        if (typeof Tooltip === 'undefined' || Tooltip.isSeen('lockTile')) return;
        lockTipTimerHandle = setTimeout(function () {
            lockTipTimerHandle = null;
            if (state !== STATE.PLAYING) return;
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
        if (typeof Tooltip !== 'undefined' && Tooltip.cancelPending) {
            Tooltip.cancelPending('lockTile');
        }
    }

    // ── Solve detection (called from game.js's refresh when Maze.won flips) ──

    async function onSolve() {
        if (state !== STATE.PLAYING) return;
        state = STATE.SOLVED;
        stopTimerDisplay();
        // Cancel the lock-tip timer — it would otherwise pop up over the
        // solve modal if the player solved within 30s.
        cancelLockTip();
        // Drop any active first-play tooltip without marking seen, so
        // it'll fire again on the player's next puzzle. The solve modal
        // + end-credits scene shouldn't have a play-time tip layered on
        // top of them.
        if (typeof Tooltip !== 'undefined' && Tooltip.dismissActive) {
            Tooltip.dismissActive(false);
        }

        // Solve SFX (stage 1): immediate applause as soon as the player
        // connects the puzzle. Mirrors marathon.onSolve's same call —
        // both modes get the celebratory audio cue at the moment the
        // win state flips, before any submission round-trip. Stop any
        // sustained overlap-loop first (same defensive pattern marathon
        // uses) so the SFX channel is clear. The stage-2 audience_cheer
        // fires later, after the submit returns, gated on top-N rank.
        if (typeof Sfx !== 'undefined') {
            if (Sfx.stopLoop) Sfx.stopLoop('glitch_overlap');
            Sfx.play('applause_long');
        }

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

        // Pull the player's last-saved name to pre-fill the input. Shared
        // with marathon via the same _lastPlayerName key, so typing once
        // in either mode populates both.
        const lastName = (function () {
            try { return localStorage.getItem(projectSlug() + '_lastPlayerName') || ''; }
            catch (e) { return ''; }
        })();

        // Brief pause so the player sees the win-state visuals (gold lit
        // channels, etc.) before the modal covers the canvas.
        await new Promise((res) => setTimeout(res, 250));

        // Music swap, credits, tracking, share — same as before; these
        // are time-independent of submission so they fire as soon as the
        // solve resolves rather than waiting on a name-input round-trip.
        if (typeof Music !== 'undefined' && Music.stop) Music.stop();
        if (typeof Credits !== 'undefined' && Credits.start) Credits.start();
        if (typeof Tracking !== 'undefined' && Tracking.recordFinish) Tracking.recordFinish();
        if (typeof Share !== 'undefined' && Share.maybeShowPopup) Share.maybeShowPopup();

        const wasOffline = !sessionToken;
        const canSubmit  = !!sessionToken && eligible;

        // Show the solve modal. If we can submit, the modal collects a
        // name and resolves with the entered string when the player clicks
        // Save (or hits Enter). Otherwise it's informational only and
        // resolves on a tap-anywhere — there's no point asking for a name
        // when no score is going to be posted.
        let enteredName = '';
        if (canSubmit) {
            enteredName = await showSolveModal({ timeMs, awaitName: true, lastName });
        } else {
            await showSolveModal({ timeMs, awaitName: false, wasOffline });
            quitToMenu();
            return;
        }

        // Trim + clamp the same way marathon does. Persist BEFORE the
        // submit so an offline / failed POST still leaves the player's
        // chosen name on disk for next time (universal rule 7a). Only
        // persist actual user input — don't write the 'Anonymous' fallback.
        const trimmedName = (enteredName || '').trim().slice(0, 16);
        if (trimmedName) {
            try { localStorage.setItem(projectSlug() + '_lastPlayerName', trimmedName); }
            catch (e) { /* localStorage unavailable */ }
        }
        const submittedName = trimmedName || 'Anonymous';

        // Submit with the entered name.
        let result = null;
        try {
            result = await postSubmit({
                sessionToken,
                timeMs,
                events: recording ? recording.moves : null,
                // Songs that played during this puzzle, replayed by
                // Music.startScriptedPlayback during /potd/scores/<id>/recording
                // playback. PotD's existing `events` field is a flat
                // moves array (vs marathon's full-recording objects),
                // so musicEvents rides as a separate top-level field.
                musicEvents: recording ? recording.musicEvents : null,
                name: submittedName,
                clientVersion: (typeof PAGE_VERSION === 'string') ? PAGE_VERSION : null,
            });
        } catch (e) { /* submission failed — fall through with null result */ }

        // Did the player make the visible top-N? If so, jump straight to
        // the leaderboard with their entry highlighted; otherwise return
        // to menu (below-cap submissions are persisted on the server but
        // not visible on the displayed board, and jumping to a leaderboard
        // that doesn't show the player's row would be confusing).
        const rank           = (result && typeof result.rank === 'number') ? result.rank : null;
        const submittedOk    = !!(result && result.eligible !== false);
        const scoreId        = (result && typeof result.id === 'number') ? result.id : null;
        const TOP_N          = (typeof MARATHON === 'object' && MARATHON.LEADERBOARD_TOP_N) || 20;
        const madeLeaderboard = submittedOk && rank != null && rank <= TOP_N;

        // NOTE: no stage-2 audience-cheer SFX on Save. The stage-1
        // applause_long fired the moment the puzzle solved, which is the
        // celebratory cue. The Save click is a quiet bookkeeping action —
        // any SFX layered onto it gets immediately faded by the music
        // transition in quitToLeaderboard (Sfx.fadeOneShots +
        // Music.start → playSong → fadeOneShots), producing a "blast"
        // sound that startles the player. Rank is communicated visually
        // by the highlighted leaderboard row.
        if (madeLeaderboard) {
            quitToLeaderboard(slot, {
                id:     scoreId,
                name:   submittedName,
                timeMs: timeMs,
            });
        } else {
            quitToMenu();
        }
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

    // Show the post-solve modal.
    //
    // Two modes, controlled by `awaitName`:
    //  - awaitName=true:  eligible online run. Show name input + Save
    //                     button; resolve with the entered name when the
    //                     player clicks Save / presses Enter. Tap-elsewhere
    //                     does NOT dismiss in this mode (we need the name).
    //                     Rank is intentionally not shown here — submission
    //                     happens after the player saves, so we don't know
    //                     rank yet; the leaderboard view shows it with the
    //                     player's row highlighted.
    //  - awaitName=false: ineligible (hint used) or offline run. Show the
    //                     status message; resolve when the player taps
    //                     anywhere on the card. No submission will follow.
    //                     Promise resolves with '' since no name was taken.
    function showSolveModal({ timeMs, awaitName, lastName, wasOffline }) {
        return new Promise((resolve) => {
            const card      = document.getElementById('potdSolveTransition');
            if (!card) return resolve('');
            const timeEl    = document.getElementById('potdSolveTime');
            const rankEl    = document.getElementById('potdSolveRank');
            const ineligEl  = document.getElementById('potdSolveIneligible');
            const offlineEl = document.getElementById('potdSolveOffline');
            const nameRow   = document.getElementById('potdSolveNameRow');
            const nameInput = document.getElementById('potdSolveName');
            const saveBtn   = document.getElementById('potdSolveSaveBtn');
            const continueEl= document.getElementById('potdSolveContinue');

            const t = (key, vars) =>
                (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, vars) : key;

            if (timeEl)    timeEl.textContent = t('marathon.totalTime', { t: fmtTime(timeMs) });
            // Rank only meaningful AFTER submission. In await-name mode the
            // submission hasn't fired yet, so always hide; the leaderboard
            // view tells the player where they landed.
            if (rankEl)    rankEl.hidden    = true;
            // Status messages only when there's no name entry happening.
            if (ineligEl)  ineligEl.hidden  = awaitName || wasOffline;
            if (offlineEl) offlineEl.hidden = !wasOffline;
            // Tap-to-continue hint only shown in dismiss-on-tap mode.
            if (continueEl) continueEl.hidden = !!awaitName;

            if (awaitName) {
                if (nameInput) {
                    nameInput.value    = lastName || '';
                    nameInput.disabled = false;
                }
                if (saveBtn) {
                    saveBtn.disabled    = false;
                    saveBtn.textContent = t('marathon.save');
                }
                if (nameRow) nameRow.hidden = false;
            } else {
                if (nameRow) nameRow.hidden = true;
            }

            function close(name) {
                card.classList.remove('visible');
                card.removeEventListener('click', onTap);
                if (saveBtn)   saveBtn.removeEventListener('click', onSave);
                if (nameInput) nameInput.removeEventListener('keydown', onKey);
                if (nameRow)   nameRow.hidden = true;
                // Tear down the iOS on-screen keyboard if it was painted.
                // No-op on desktop / Android / non-standalone iOS, so the
                // call is safe to make unconditionally.
                if (typeof Marathon !== 'undefined' && Marathon.teardownMobileKeyboard) {
                    Marathon.teardownMobileKeyboard();
                }
                resolve(name || '');
            }
            function onTap()  { if (!awaitName) close(''); }
            function onSave(e) {
                if (e) e.stopPropagation();
                close(nameInput ? nameInput.value : '');
            }
            function onKey(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    close(nameInput ? nameInput.value : '');
                }
            }

            card.addEventListener('click', onTap);
            if (awaitName) {
                if (saveBtn)   saveBtn.addEventListener('click', onSave);
                if (nameInput) nameInput.addEventListener('keydown', onKey);
            }
            card.classList.add('visible');

            // Auto-focus so the player can type immediately. Wrapped in
            // try/catch — iOS Safari (especially standalone PWA) sometimes
            // refuses focus() outside a direct gesture stack. Silent failure
            // is fine; the player can just tap the input.
            if (awaitName && nameInput) {
                try { nameInput.focus(); } catch (e) { /* */ }
            }
            // iOS PWA standalone: paint the shared custom keyboard so the
            // player can type (the native keyboard doesn't reliably show
            // for inputs in standalone mode). Wired through Marathon's
            // public API since marathon owns the keyboard implementation.
            // Enter on the custom keyboard fires onSave, identical to the
            // hardware Enter handler above. No-op everywhere else.
            if (awaitName && nameInput
                && typeof Marathon !== 'undefined'
                && Marathon.setupMobileKeyboard) {
                Marathon.setupMobileKeyboard(nameInput, () => onSave());
            }
        });
    }

    function quitToMenu() {
        stopTimerDisplay();
        state = STATE.MENU;
        currentSlot = null;
        sessionToken = null;
        // Cancel any pending lock-tip timer — without this, a player
        // who quits within 30s of puzzle start would see the tip on
        // the menu.
        cancelLockTip();
        // Hide any active first-play tooltip without marking seen, so
        // the tip will re-appear on the player's next puzzle.
        if (typeof Tooltip !== 'undefined' && Tooltip.dismissActive) {
            Tooltip.dismissActive(false);
        }
        // Defensive: tear down the iOS on-screen keyboard if the player
        // hits Quit mid-name-entry. showSolveModal's close() also tears
        // down, but a side-channel exit (HUD Quit button) bypasses that —
        // without this the keyboard would linger on the menu. No-op on
        // non-iOS-standalone platforms.
        if (typeof Marathon !== 'undefined' && Marathon.teardownMobileKeyboard) {
            Marathon.teardownMobileKeyboard();
        }
        // Kill any sustained SFX loops (currently just 'glitch_overlap', but
        // stopAllLoops is forward-safe for future sustained cues). Without
        // this, quitting mid-puzzle while paths were overlapping leaves the
        // glitch loop running on the main menu indefinitely.
        if (typeof Sfx !== 'undefined' && Sfx.stopAllLoops) Sfx.stopAllLoops();
        // Fade any lingering one-shots (audience_cheer, applause_long, etc.).
        // Music.start below ALSO triggers a fade via its own playSong hook,
        // but that path only fires when music is enabled — this defensive
        // call catches the music-disabled case where the player's solve
        // SFX would otherwise persist into the menu silence.
        if (typeof Sfx !== 'undefined' && Sfx.fadeOneShots) Sfx.fadeOneShots();
        // Restart music with a fresh menu_only pool song UNLESS the
        // current track is already a menu song (avoids interrupting
        // ongoing menu music). Mirrors marathon.js's goToMenu —
        // see the comment there for the full rationale.
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(true);
            const alreadyMenu = Music.isMenuSongPlaying && Music.isMenuSongPlaying();
            if (!alreadyMenu) {
                if (Music.stop)  Music.stop();
                if (Music.start) Music.start();
            }
        }
        // Tear the credits down before returning to menu. Covers both the
        // post-solve dismiss path (modal tap → quitToMenu) and the in-game
        // Quit button (which doesn't trigger credits, but Credits.stop is
        // a safe no-op when nothing's rolling).
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
        Maze.clear();
        Render.draw();  // wipe the canvas so the menu doesn't paint over a stale puzzle
        showMenu();
    }

    // Same teardown as quitToMenu, but hand off to Marathon's leaderboard
    // view instead of the menu — used after a PotD solve when the player
    // ranked in the top N, so they land on the board with their entry
    // highlighted. Marathon.showPotdLeaderboard handles the mode swap,
    // pendingHighlight wiring, and rendering.
    function quitToLeaderboard(slot, highlight) {
        stopTimerDisplay();
        state = STATE.MENU;
        currentSlot = null;
        sessionToken = null;
        cancelLockTip();
        // Defensive — onSolve already dismisses, but this path can also
        // be reached from Marathon.showPotdLeaderboard (cross-module
        // entry), so we cover it directly.
        if (typeof Tooltip !== 'undefined' && Tooltip.dismissActive) {
            Tooltip.dismissActive(false);
        }
        // Tear down the iOS keyboard if showSolveModal somehow exited
        // without going through close() (defensive — close() itself also
        // tears down, but redundancy is cheap). No-op on non-iOS.
        if (typeof Marathon !== 'undefined' && Marathon.teardownMobileKeyboard) {
            Marathon.teardownMobileKeyboard();
        }
        if (typeof Sfx !== 'undefined' && Sfx.stopAllLoops) Sfx.stopAllLoops();
        // Same one-shot fade as quitToMenu — audience_cheer / applause_long
        // shouldn't bleed into the leaderboard view.
        if (typeof Sfx !== 'undefined' && Sfx.fadeOneShots) Sfx.fadeOneShots();
        // Same music chain as quitToMenu — leaderboard view is also
        // a "back at menu" state. Skips the stop+start restart if a
        // menu pool song is already playing (see marathon.js goToMenu
        // for the full rationale).
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(true);
            const alreadyMenu = Music.isMenuSongPlaying && Music.isMenuSongPlaying();
            if (!alreadyMenu) {
                if (Music.stop)  Music.stop();
                if (Music.start) Music.start();
            }
        }
        if (typeof Credits !== 'undefined' && Credits.stop) Credits.stop();
        Maze.clear();
        Render.draw();
        if (typeof Marathon !== 'undefined' && Marathon.showPotdLeaderboard) {
            Marathon.showPotdLeaderboard(slot, highlight);
        } else {
            // Fallback: if Marathon isn't loaded for some reason, don't
            // strand the player on a blank canvas — drop them at the menu.
            showMenu();
        }
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
    //
    // Order matters: local wipe + UI refresh fire FIRST (synchronously),
    // then the server wipe runs over its (potentially slow) network
    // round-trip. Without that ordering, a user who clicks Reset and
    // reloads before the server fetch completes would never trigger the
    // local wipe — which lives after the await — and the page would
    // come back painted with the same checkmarks they thought they
    // cleared.
    async function devReset() {
        const base = apiBase();
        // Local-state wipe FIRST — synchronous, fast, can't be aborted
        // by a quick page reload. Includes both the localStorage keys
        // AND the in-memory caches so the menu indicators update
        // immediately on the next refresh call.
        resetLocalState();
        puzzles              = null;
        serverFetchPromise   = null;
        serverFetchResolved  = false;
        queue                = [];
        slotWaiters.clear();
        refreshMenuIndicators();
        // Server-side wipe SECOND — this can hang on a cold backend,
        // but the local visual state has already updated so the user
        // sees an immediate response. The server-reachability flag in
        // the returned status object tells the debug-UI caller which
        // outcome message to surface.
        let serverOk = false;
        if (base) {
            try {
                const resp = await fetch(base + '/potd/dev-reset', { method: 'POST' });
                serverOk = resp.ok;
            } catch (e) { /* offline / endpoint missing — leave serverOk false */ }
        }
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

        // Day-rollover watcher: polls every minute for the UTC date to
        // change, and on change wipes the in-memory puzzles cache + re-
        // paints the menu indicators. Without this, a long-running page
        // session sitting open across UTC midnight would keep showing
        // yesterday's solved-state badges (state keys are per-date, but
        // refreshMenuIndicators isn't called automatically). The next
        // time the player clicks a slot, ensurePuzzleAvailable's own
        // date-mismatch reset would handle the data side, but the menu
        // wouldn't have updated until then. dev-mode.js has its own
        // rollover watcher that ALSO kicks devSeedAllSlots for the new
        // day — this one is purely UI-side and runs for every player.
        let lastSeenDate = todayUTC();
        setInterval(function () {
            const now = todayUTC();
            if (now === lastSeenDate) return;
            lastSeenDate = now;
            // Reset the in-memory cache so ensurePuzzleAvailable will
            // fetch fresh from the server. ensurePuzzleAvailable itself
            // also handles date mismatches, but resetting here means the
            // pre-warm fires immediately on rollover rather than waiting
            // for the next slot click.
            puzzles             = null;
            serverFetchPromise  = null;
            serverFetchResolved = false;
            queue               = [];
            slotWaiters.clear();
            refreshMenuIndicators();
        }, 60 * 1000);

        // Pre-warm today's puzzle set on page load so the slot-click path
        // doesn't pay the network round-trip up front. The pattern mirrors
        // ensurePuzzleAvailable's own warm-up branch: seed `puzzles` from
        // localStorage cache (instant) and kick fetchTodaysPuzzles() into
        // serverFetchPromise. By the time the player has dismissed the
        // intro and picked a slot, the network call is usually done — the
        // click path's await on serverFetchPromise returns immediately.
        // The fetch is dedupe-keyed by serverFetchPromise, so even if the
        // player clicks during the warm-up they share this in-flight
        // request rather than starting a redundant one. Harmless one GET
        // per page load for players who never click PotD.
        if (!puzzles) {
            const today = todayUTC();
            const cached = loadPuzzlesCache(today);
            puzzles = cached || { date: today, byslot: {} };
        }
        ensureServerFetch();
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
            serverFetchResolved   = false;
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
            serverFetchResolved = false;
            serverFetchPromise = fetchTodaysPuzzles().then(function (fetched) {
                if (fetched) puzzles = fetched;
            }).finally(function () {
                serverFetchResolved = true;
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
