/**
 * Circuitousness — Engagement analytics
 *
 * Ported from TANTЯO's analytics.js (2026-08-07). Measures the three things
 * a platform trial is graded on — playtime, retention, conversion — and,
 * more usefully, the diagnostics that say WHERE players are lost:
 *
 *   1. PLAYTIME. Nothing in page_visits measured time. This module keeps
 *      two clocks: `visible` (time on page, tab-hidden time excluded) and
 *      `play` (time with a puzzle actually on the board and unpaused).
 *      Both are honest by construction — an idle backgrounded tab accrues
 *      neither, which matters here more than in most games because a
 *      puzzle left open looks identical to one being thought about.
 *   2. PER-PUZZLE OUTCOME. The funnel counted solves and nothing else, so
 *      every puzzle collapsed into a tally. Each attempt now gets a row:
 *      duration, moves, hints, mode, board size, and how it ended.
 *   3. ABANDONMENT. A row is written the moment a board becomes playable
 *      and upgraded on the way out, so walking away mid-puzzle is a
 *      recorded fact with a duration attached rather than an absence of
 *      data. `abandon_secs` on first_run_stats answers this for a player's
 *      first session only; this answers it for every session.
 *
 * DELIVERY (the part that decides whether any of the above survives):
 * mobile glance-sessions are routinely shorter than a cold Render dyno's
 * first response, so "fire and hope" loses exactly the sessions most worth
 * measuring — the same lesson tracking.js learned in 2026-07 and solved
 * with its milestone queue. Every payload is written to a localStorage
 * queue BEFORE it is sent and removed only on a 2xx; whatever is left is
 * flushed on the next page load. Sends use `keepalive` (and `sendBeacon`
 * on the final pagehide) so an in-flight request survives page teardown.
 *
 * IDEMPOTENCE: retries, out-of-order delivery and duplicate beacons are all
 * expected, so the server merges whole state rather than applying deltas —
 * max() for counters, a one-way rank ladder for end_cause. Sending the same
 * payload five times is indistinguishable from sending it once.
 *
 * NOT TRACKED: replays and the demo/AI board. Both run the ordinary play
 * loop and would pour attract-mode time into every average; the call sites
 * are all inside `state === STATE.PLAYING` guards, which replays never
 * satisfy.
 *
 * SUPPRESSION is delegated to tracking.js — one source of truth for
 * localhost / file:// / sticky ?track=false / DevMode. tracking.js calls
 * disable() when suppressed, and nothing here sends until it has a visit
 * id, which a suppressed page never obtains.
 */
const Analytics = (() => {
    'use strict';

    const SLUG = (typeof PROJECT_SLUG === 'string' && PROJECT_SLUG) ? PROJECT_SLUG : 'circuitousness';
    const QUEUE_KEY = SLUG + '_analytics_queue_v1';
    const QUEUE_MAX = 50;                       // oldest dropped past this
    const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    // ── Backstop syncs ──
    // The exit beacon is not guaranteed. Closing the whole BROWSER (rather
    // than the tab) kills the process that would carry an in-flight
    // sendBeacon, so a cold Render dyno never receives it; the payload then
    // waits in the queue until the player's next visit, which may be never.
    // Crashes, OS kills and iOS swipe-aways lose it the same way.
    //
    // So the row is topped up WHILE the puzzle is open, on an escalating
    // schedule: a puzzle whose exit is never heard from still carries a
    // real duration (a lower bound) instead of the 0s stamped at start.
    // Early steps are close together because that is where abandonment
    // happens — a board that reads as impenetrable is closed in seconds.
    // The schedule then stretches out, because the per-IP rate limiter is
    // shared by everyone behind a carrier NAT and a long, healthy session
    // needs no more than a periodic top-up.
    const HEARTBEAT_TICK_MS = 15000;
    const SYNC_STEPS_MS = [15000, 30000, 60000, 120000];  // last step repeats

    // ── State ────────────────────────────────────────────────────────────
    let enabled = true;
    let visitId = null;
    let puzzleIndex = 0;            // 1-based ordinal of the puzzle in this visit
    let current = null;             // the puzzle in progress, or null
    let firstStartMs = null;        // visible-ms elapsed when puzzle 1 started
    let lastSyncedPlayMs = -1;
    let syncStep = 0;               // index into SYNC_STEPS_MS, reset per puzzle
    let heartbeatTimer = null;
    // Menu-surface flags, as a set-shaped object. Each is recorded at most
    // once per visit and rides the session sync (which the server merges as
    // a set union), so no flag needs its own endpoint or its own retry.
    let flags = {};
    // Input-discovery tokens: same one-shot mechanism, own set and own
    // column, so "explored the menus" and "found the controls" stay
    // separate questions.
    let controls = {};
    // Identifies THIS page load. Sent with the load record and again on
    // every session sync, so the server can mark the load as having
    // converted into a real interaction — in either order, any number of
    // times.
    let loadId = null;
    let loadRecorded = false;
    let pendingLoadCtx = null;      // set while waiting out a hidden load
    let queue = [];

    /**
     * A stopwatch that only advances while explicitly running. Used instead
     * of (now - startedAt) everywhere because every clock here has to be
     * pausable: hidden tabs, the pause overlay and menu popups must not
     * accrue play time.
     */
    function makeClock() {
        let accum = 0;
        let anchor = null;
        return {
            start() { if (anchor === null) anchor = Date.now(); },
            stop() {
                if (anchor !== null) { accum += Date.now() - anchor; anchor = null; }
            },
            ms() { return accum + (anchor !== null ? Date.now() - anchor : 0); },
            running() { return anchor !== null; }
        };
    }

    const visibleClock = makeClock();
    const playClock = makeClock();

    function isHidden() {
        return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function apiBase() {
        return (typeof AppConfig !== 'undefined' && AppConfig && AppConfig.GAME_API) || null;
    }

    function uuid() {
        try {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        } catch (e) { /* fall through */ }
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function secs(ms) { return Math.max(0, Math.round(ms / 1000)); }

    // ── Queue ────────────────────────────────────────────────────────────
    // Entries: { id, kind: 'puzzle'|'session'|'load', visitId, body, ts }
    // `visitId` is null for anything produced before the visit POST answered
    // (a fast tap on a cold dyno); those get stamped by setVisitId().

    function loadQueue() {
        try {
            const raw = localStorage.getItem(QUEUE_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            const cutoff = Date.now() - QUEUE_TTL_MS;
            // Stranded orphans can never be resolved: a null visitId means
            // THAT page load never got a visit row, and this load's visit is
            // a different row. Attaching them here would corrupt
            // puzzles-per-session, so they're dropped rather than misfiled.
            // Load records are the exception — they are keyed by their own
            // client id and belong to no visit, so they stay retryable.
            return parsed.filter(e => e && e.ts > cutoff && (e.visitId || e.kind === 'load'));
        } catch (e) {
            return [];
        }
    }

    function persistQueue() {
        try {
            if (queue.length > QUEUE_MAX) queue = queue.slice(queue.length - QUEUE_MAX);
            localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
        } catch (e) {
            // Private mode / quota. The in-memory queue still works for this
            // page; only cross-load retry is lost.
        }
    }

    function enqueue(kind, body) {
        // Only the newest session sync matters — it carries whole state, so
        // an older one is strictly redundant. Puzzle rows are per-puzzle and
        // all kept (each is keyed by its own clientPuzzleId).
        if (kind === 'session') {
            queue = queue.filter(e => !(e.kind === 'session' && e.visitId === visitId));
        }
        const entry = { id: uuid(), kind: kind, visitId: visitId, body: body, ts: Date.now() };
        queue.push(entry);
        persistQueue();
        return entry;
    }

    function dequeue(id) {
        const before = queue.length;
        queue = queue.filter(e => e.id !== id);
        if (queue.length !== before) persistQueue();
    }

    function urlFor(entry) {
        const base = apiBase();
        if (!base) return null;
        if (entry.kind === 'load') return base + '/load';
        return base + '/visit/' + entry.visitId +
            (entry.kind === 'puzzle' ? '/puzzle' : '/session');
    }

    /**
     * Send one queued entry. `final` marks the page-is-going-away path,
     * where sendBeacon is more reliable than fetch on iOS — at the cost of
     * no readable response, so the entry stays queued and is re-sent (and
     * server-side merged away) on the next load.
     */
    function send(entry, final) {
        // Load records carry their own client id and belong to no visit;
        // everything else is visit-scoped and cannot be addressed yet.
        if (!entry.visitId && entry.kind !== 'load') return;
        const url = urlFor(entry);
        if (!url) return;
        const payload = JSON.stringify(entry.body);

        if (final && typeof navigator !== 'undefined' && navigator.sendBeacon) {
            try {
                // Two constraints shape this line, and both are load-bearing:
                //   - POST, because sendBeacon cannot issue a PATCH (hence
                //     both endpoints accepting POST).
                //   - text/plain, because it is a CORS-safelisted content
                //     type. An application/json body would trigger a
                //     preflight, and a beacon fired during page teardown
                //     cannot complete one — the telemetry would silently
                //     vanish cross-origin, which is every real deployment
                //     here (the API is on Render, the game on Netlify).
                //     The back end parses these with force=True to match.
                const blob = new Blob([payload], { type: 'text/plain;charset=UTF-8' });
                if (navigator.sendBeacon(url, blob)) return;
            } catch (e) { /* fall through to fetch */ }
        }

        try {
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: payload,
                keepalive: true
            }).then(res => {
                if (!res) return;
                // 4xx (other than a retryable 429) means the server will
                // never accept this payload — drop it rather than let one
                // poison entry retry on every page load for a week. 5xx and
                // network failures stay queued.
                if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
                    dequeue(entry.id);
                }
            }).catch(() => { /* stays queued for the next flush */ });
        } catch (e) {
            // fetch itself threw (very old browser / keepalive body limit)
        }
    }

    function flushQueue(final) {
        if (!enabled) return;
        queue.slice().forEach(e => {
            if (e.visitId || e.kind === 'load') send(e, final);
        });
    }

    // ── Payload builders ─────────────────────────────────────────────────

    function sessionBody() {
        return {
            sessionSeconds: secs(visibleClock.ms()),
            playSeconds: secs(playClock.ms()),
            timeToFirstStartSeconds: firstStartMs === null ? null : secs(firstStartMs),
            puzzlesStarted: puzzleIndex,
            flags: Object.keys(flags),
            controls: Object.keys(controls),
            // Closes the load → visit link. Sent on every sync rather than
            // once, because the sync that lands might be the only one.
            clientLoadId: loadId
        };
    }

    function puzzleBody(endCause) {
        if (!current) return null;
        return {
            clientPuzzleId: current.id,
            puzzleIndex: current.index,
            mode: current.meta.mode || null,
            gameType: current.meta.gameType || null,
            dims: current.meta.dims || null,
            resumed: !!current.meta.resumed,
            appVersion: typeof PAGE_VERSION !== 'undefined' ? String(PAGE_VERSION) : null,
            durationSeconds: secs(current.clock.ms()),
            moves: current.moves || 0,
            hintsUsed: current.hints || 0,
            // Both of these are only known at the end, and JSON.stringify
            // drops undefined keys — so in_progress/abandoned payloads
            // simply omit them and the server leaves the stored value alone.
            musicOn: current.musicOn,
            alternate: current.alternate,
            endCause: endCause
        };
    }

    function syncSession(final) {
        if (!enabled) return;
        const entry = enqueue('session', sessionBody());
        lastSyncedPlayMs = playClock.ms();
        send(entry, final);
    }

    function syncPuzzle(endCause, final) {
        if (!enabled || !current) return;
        const body = puzzleBody(endCause);
        if (!body) return;
        const entry = enqueue('puzzle', body);
        send(entry, final);
    }

    // ── Lifecycle hooks ──────────────────────────────────────────────────

    /** Stop tracking entirely (dev mode, localhost, sticky opt-out). */
    function disable() {
        enabled = false;
        queue = [];
        flags = {};
        controls = {};
        current = null;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        try { localStorage.removeItem(QUEUE_KEY); } catch (e) { /* private mode */ }
    }

    /**
     * Record that the page was loaded at all — the platform-comparable
     * denominator.
     *
     * page_visits deliberately requires real engagement (its original bot
     * filter), so anyone who loads and leaves is missing from every rate
     * built on it. Rather than change when visit rows are created — which
     * would silently redefine a metric with months of history behind it —
     * this is a separate record, and the session sync later marks it as
     * converted.
     *
     * Called by tracking.js, which owns the device/OS classification and
     * the suppression rules.
     *
     * A load that starts HIDDEN is a prerender or a background tab, not an
     * impression, so it waits until the page is first actually seen. If
     * that never happens, nothing is ever sent.
     */
    function recordPageLoad(ctx) {
        if (!enabled || loadRecorded) return;
        if (isHidden()) { pendingLoadCtx = ctx || {}; return; }
        pendingLoadCtx = null;
        loadRecorded = true;
        const body = Object.assign({}, ctx || {});
        body.clientLoadId = loadId;
        send(enqueue('load', body), false);
    }

    /** The id for this page load. */
    function getLoadId() { return loadId; }

    /**
     * Hand over the visit row id once the visit POST answers. Anything
     * recorded before that point was queued with a null visitId; stamp it
     * now and flush, so a player who solves a practice puzzle before the
     * cold dyno replies still lands their first row.
     */
    function setVisitId(id) {
        if (!enabled || !id || id < 0) return;
        visitId = id;
        let touched = false;
        queue.forEach(e => {
            if (!e.visitId && e.kind !== 'load') { e.visitId = id; touched = true; }
        });
        if (touched) persistQueue();
        flushQueue(false);
    }

    /**
     * A puzzle became playable. `meta` = { mode, gameType, dims, resumed }.
     * The row is written NOW rather than at solve time — a session that
     * opens a board and vanishes is precisely the one worth measuring, and
     * also the one least likely to deliver an exit beacon.
     */
    function puzzleStarted(meta) {
        if (!enabled) return;
        // A puzzle already in progress means the player moved on without a
        // recorded ending (quit to menu, restarted, skipped). Close the old
        // row out rather than orphaning it at in_progress — that state is
        // reserved for "we lost the beacon".
        if (current) {
            current.clock.stop();
            syncPuzzle('abandoned', false);
            current = null;
        }
        puzzleIndex++;
        syncStep = 0;   // the close-together early steps matter most per puzzle
        current = {
            id: uuid(),
            index: puzzleIndex,
            meta: meta || {},
            clock: makeClock(),
            moves: 0,
            hints: 0
        };
        if (firstStartMs === null) firstStartMs = visibleClock.ms();
        if (!isHidden()) { current.clock.start(); playClock.start(); }
        syncPuzzle('in_progress', false);
        syncSession(false);
        startHeartbeat();
    }

    /**
     * Cheap in-memory counter, called from the tile-commit hook. Keeps a
     * live move count so an abandonment beacon can report how far the
     * player actually got, not just how long they were there — the
     * difference between a board someone wrestled with and one they looked
     * at and closed.
     */
    function moveMade() {
        if (!enabled || !current) return;
        current.moves++;
    }

    /** A hint was taken on the current puzzle. */
    function hintUsed() {
        if (!enabled || !current) return;
        current.hints++;
    }

    /**
     * Record a menu-surface flag (the mode menu, How to Solve, settings,
     * the PotD calendar, ...). Circuitousness is the game that found out
     * too late that only 9.2% of players touched ANY menu surface — with
     * everything behind the menu invisible to the other 90%. This is that
     * number, measured continuously instead of discovered by accident.
     *
     * Syncs immediately on first occurrence rather than waiting for the
     * next natural sync: someone who opens How to Solve and then leaves is
     * exactly the player this is meant to catch.
     */
    function flag(name) {
        if (!enabled || !name || flags[name]) return;
        flags[name] = true;
        syncSession(false);
    }

    /**
     * Record an input-discovery token: which input methods the player used
     * (`src_mouse` / `src_touch` / `src_key` / `src_pad`) and which actions
     * they ever performed (`act_rot` / `act_lock` / `act_hint`).
     *
     * The question this answers is a mobile one: a player whose first
     * puzzle ended in 20 seconds and who never once rotated a tile did not
     * find the controls — which looks identical to "too hard" or "boring"
     * in every other metric, and points at a completely different fix.
     *
     * Called from hot paths (every rotation fires this), so the
     * already-seen check comes first and costs one property lookup; only
     * the FIRST occurrence of each token does any work.
     */
    function control(name) {
        if (!enabled || !name || controls[name]) return;
        controls[name] = true;
        syncSession(false);
    }

    /** Play paused (pause overlay, a modal, the tutorial opening over it). */
    function paused() {
        if (!enabled || !current) return;
        current.clock.stop();
        playClock.stop();
    }

    function resumed() {
        if (!enabled || !current || isHidden()) return;
        current.clock.start();
        playClock.start();
    }

    /**
     * The current puzzle ended. `cause` is 'solved' | 'failed' |
     * 'abandoned'; `info` may carry { musicOn, alternate }.
     *
     * 'failed' is Circuitousness-specific — a Surge/Marathon run whose
     * clock ran out on this board. It is a different player experience
     * from walking away, and the panel reports them separately.
     */
    function puzzleEnded(cause, info) {
        if (!enabled || !current) return;
        if (info) {
            if (info.musicOn != null) current.musicOn = !!info.musicOn;
            if (info.alternate != null) current.alternate = !!info.alternate;
            if (info.moves != null) current.moves = Math.max(current.moves, info.moves | 0);
            if (info.hints != null) current.hints = Math.max(current.hints, info.hints | 0);
        }
        current.clock.stop();
        playClock.stop();
        syncPuzzle(cause === 'solved' || cause === 'failed' ? cause : 'abandoned', false);
        current = null;
        syncSession(false);
        stopHeartbeat();
    }

    // ── Page lifecycle ───────────────────────────────────────────────────

    function onHidden(final) {
        visibleClock.stop();
        if (current) {
            current.clock.stop();
            playClock.stop();
            // Provisional: if they come back and solve it, 'solved'
            // overwrites this. If they never come back, `abandoned` plus
            // the duration already on the row is exactly the
            // stuck-vs-bored signal.
            syncPuzzle('abandoned', final);
        }
        syncSession(final);
        stopHeartbeat();
    }

    function onVisible() {
        visibleClock.start();
        // A prerendered / background load becomes a real impression the
        // first time it is actually shown.
        if (pendingLoadCtx && !loadRecorded) recordPageLoad(pendingLoadCtx);
        if (current) { current.clock.start(); playClock.start(); startHeartbeat(); }
    }

    function startHeartbeat() {
        if (!enabled || heartbeatTimer || typeof setInterval !== 'function') return;
        heartbeatTimer = setInterval(() => {
            if (!current || isHidden()) return;
            // Escalating gap, so an idle-but-visible tab never re-POSTs
            // unchanged state and a long session doesn't chatter. A player
            // staring at a hard board IS accruing play time, so this does
            // keep firing — it just slows down.
            const need = SYNC_STEPS_MS[Math.min(syncStep, SYNC_STEPS_MS.length - 1)];
            if (playClock.ms() - lastSyncedPlayMs < need) return;
            syncStep++;
            syncPuzzle('in_progress', false);
            syncSession(false);
        }, HEARTBEAT_TICK_MS);
    }

    function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    function init() {
        // Headless browsers never produce a visit row, so they must not
        // produce analytics rows either. The rest of the suppression rules
        // live in tracking.js, which calls disable() — they depend on
        // DevMode, which loads after this file.
        if (typeof navigator !== 'undefined' && navigator.webdriver) {
            enabled = false;
            return;
        }
        queue = loadQueue();
        loadId = uuid();
        if (!isHidden()) visibleClock.start();

        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', () => {
                if (isHidden()) onHidden(false); else onVisible();
            });
        }
        if (typeof window !== 'undefined' && window.addEventListener) {
            // pagehide is the last reliable hook on iOS (where unload never
            // fires). persisted=true means bfcache — the page may come back,
            // so the state we send is provisional exactly like a tab-hide.
            window.addEventListener('pagehide', () => onHidden(true));
        }
        // Stranded rows from a previous session (killed mid-flight, or a
        // sendBeacon we could never confirm). Server-side merge makes a
        // duplicate harmless.
        flushQueue(false);
    }

    /** Test/debug seam — the Node suite in circuitousness/tests asserts on this. */
    function getState() {
        return {
            enabled: enabled,
            visitId: visitId,
            loadId: loadId,
            loadRecorded: loadRecorded,
            puzzleIndex: puzzleIndex,
            hasCurrentPuzzle: !!current,
            currentMoves: current ? current.moves : 0,
            currentHints: current ? current.hints : 0,
            visibleMs: visibleClock.ms(),
            playMs: playClock.ms(),
            firstStartMs: firstStartMs,
            flags: Object.keys(flags),
            controls: Object.keys(controls),
            queueLength: queue.length,
            queue: queue.slice()
        };
    }

    return {
        init, disable, setVisitId, flag, control,
        recordPageLoad, getLoadId,
        puzzleStarted, moveMade, hintUsed, paused, resumed, puzzleEnded,
        getState,
        // Exposed for the page-lifecycle tests; game code does not call these.
        _onHidden: onHidden, _onVisible: onVisible
    };
})();

if (typeof window !== 'undefined') window.Analytics = Analytics;

// Self-initialize on load: the visible clock has to start at page load,
// which is before any game module runs. navigator.webdriver is readable
// here; the rest of the opt-out rules live in tracking.js, which calls
// Analytics.disable() once DevMode has been evaluated.
Analytics.init();
