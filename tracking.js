// Visit / engagement tracking — mirrors TANTЯO's pattern.
//
// One POST /api/visit on page load creates a server-side PageVisit row
// and returns its id. From then on, each meaningful event (game start,
// finish, share click, credits-link click) PATCHes that visit row with
// the relevant delta. The data feeds an admin dashboard at
// official-intelligence-web/admin/circuitousness/.
//
// SUPPRESSION:
//   - localhost / 127.0.0.1  — local dev loads never reach production
//     stats, regardless of any ?dev / ?debug flag. ALL Tracking.*
//     methods short-circuit before any POST. (Belt-and-braces: the
//     back-end also drops visits whose origin/referrer is localhost.)
//   - ?track=false — STICKY per-browser opt-out (persists to
//     localStorage; ?track=true clears). The universal-rule flag —
//     covers tooling that reloads the page without query params.
//   - DevMode.isActive() (?dev=true)  — the dev's own runs don't
//     pollute aggregate stats. ALL Tracking.* methods short-circuit
//     before any POST when dev mode is on. Per-load, NOT sticky.
//   - Bot UAs — filtered SERVER-SIDE in POST /api/visit. Bot visits
//     return visit_id=-1 and the client silently skips further PATCHes.
//   - Worker context — `window` undefined; nothing to track from a
//     worker, the typeof guard handles that.
//
// All POSTs are fire-and-forget — no callbacks, no error surfacing.
// Tracking failures must NEVER block gameplay; the cost of a missed
// event is a slightly incomplete stats page, which is acceptable.
//
// DELIVERY ROBUSTNESS (added 2026-07-26): every funnel milestone queues
// behind the visit POST (withVisit awaits it for the visit_id), and on a
// cold Render dyno that POST can take 30-60s. iOS Safari kills the page's
// network the moment it's backgrounded, and mobile glance-sessions are
// routinely shorter than the cold start — so the server had the visit row
// (the POST arrived) but never received a single milestone PATCH: rows
// showing ○○○ on the admin funnel despite real play. Three mitigations:
//   1. keepalive:true on the visit POST and every PATCH — requests
//      already in flight survive the page being closed/backgrounded.
//   2. Milestones (agreed/started/finished/solved) persist to a
//      localStorage queue when fired and are removed only when their
//      PATCH confirms (response ok). Share/credits/donate clicks are
//      excluded — small, rare, and always fired from a live page.
//   3. On the next page load, leftover entries from PREVIOUS loads are
//      flushed to POST /api/visit/late-milestones, keyed by a
//      client-minted per-load uuid (clientUuid on the visit POST) with a
//      session_id fallback lookup server-side.

const Tracking = (function () {
    // -1 = bot / declined; 0 = not yet initialized; positive = real visit.
    let visitId = 0;
    // The in-flight POST /visit promise. Events that fire while the visit
    // row is still being created (common on a cold Render dyno, where the
    // first request takes 30-60s) await THIS instead of being dropped —
    // a dropped /started is how the daily digest ended up showing more
    // puzzles completed than started.
    let visitPromise = null;

    // Local dev loads (localhost / 127.0.0.1) must NEVER reach the
    // production stats — not the visit row, not referrers, nothing. This
    // mirrors sw.js's own localhost cache-bypass check so dev vs prod is
    // one consistent signal. The back-end repeats this guard (origin /
    // referrer) so a stale cached client predating this check is still
    // dropped server-side.
    function isLocalHost() {
        if (typeof location === 'undefined') return false;
        // file:// pages are never real player traffic — that's the
        // editor's preview pane auto-opening index.html on every edit
        // (or a double-clicked local copy). The protocol check needs no
        // storage and no query param, so unlike the sticky ?track=false
        // flag it survives the pane's fresh ephemeral profiles (rows
        // kept appearing under brand-new session_ids, 2026-07-24) and
        // works before any server-side guard deploys.
        if (location.protocol === 'file:') return true;
        if (!location.hostname) return false;
        return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }
    // Sticky per-browser opt-out via the universal ?track=false flag
    // (mirrors TANTЯO's sticky opt-out): seen once, it persists to
    // localStorage so SUBSEQUENT loads in the same browser stay
    // suppressed even when they don't carry the query — dev tooling
    // (editor preview panes) reopens index.html on its own without
    // params, and a session of such loads posted real "(direct)"
    // desktop rows on 2026-07-23 because this project only honored the
    // per-load ?dev=true. ?track=true clears the flag. Evaluated once
    // at module init; try/catch covers workers/private mode.
    const stickyOptOut = (function () {
        const key = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness')
            + '_trackOptOut_v1';
        let t = null;
        try { t = new URLSearchParams(location.search || '').get('track'); } catch (e) {}
        // The query param decides THIS load unconditionally — storage is
        // only the persistence layer, so a sandboxed/file:// context
        // where localStorage throws still honors an explicit
        // ?track=false (the original version returned false from its
        // catch, silently tracking exactly the loads that asked not to
        // be).
        if (t === 'false') {
            try { localStorage.setItem(key, '1'); } catch (e) {}
            return true;
        }
        if (t === 'true') {
            try { localStorage.removeItem(key); } catch (e) {}
            return false;
        }
        try { return localStorage.getItem(key) === '1'; } catch (e) { return false; }
    })();
    function isSuppressed() {
        if (isLocalHost()) return true;
        if (stickyOptOut) return true;
        return (typeof DevMode !== 'undefined') && DevMode.isActive && DevMode.isActive();
    }
    function apiBase() {
        return (typeof AppConfig !== 'undefined' && AppConfig && AppConfig.GAME_API) || null;
    }

    // Coarse device-type detection. Phone = UA contains 'Mobile' OR
    // touch + narrow viewport. Tablet = touch + wider viewport.
    // Desktop = everything else. Same buckets Tantro uses so the admin
    // page's pie charts match the categories the data carries.
    function detectDeviceType() {
        if (typeof navigator === 'undefined') return 'desktop';
        const ua = navigator.userAgent || '';
        if (/Mobi|Android.*Mobile/i.test(ua)) return 'phone';
        if (/Tablet|iPad/i.test(ua)) return 'tablet';
        if (navigator.maxTouchPoints > 1 && (window.innerWidth || 0) <= 900) return 'phone';
        if (navigator.maxTouchPoints > 1) return 'tablet';
        return 'desktop';
    }
    function detectOS() {
        if (typeof navigator === 'undefined') return 'Other';
        const ua = navigator.userAgent || '';
        if (/Windows/i.test(ua))                 return 'Windows';
        if (/iPad|iPhone|iPod/i.test(ua))        return 'iOS';
        if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'iOS';
        if (/Android/i.test(ua))                 return 'Android';
        if (/Mac OS X|Macintosh/i.test(ua))      return 'macOS';
        if (/Linux/i.test(ua))                   return 'Linux';
        return 'Other';
    }

    // Single thin wrapper around fetch — every Tracking call routes
    // through here so suppression / no-API / catch-all error handling
    // is in exactly one place. Always silent (no .then, no .catch
    // surfacing). 5s implicit timeout via AbortController so a hung
    // tracking POST doesn't accumulate forever.
    function silentFetch(url, opts) {
        if (isSuppressed()) return;
        const base = apiBase();
        if (!base) return;
        const ctrl  = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
        // keepalive: an in-flight PATCH survives the page being closed or
        // backgrounded (iOS Safari kills ordinary fetches instantly on
        // either). Ignored by browsers that don't know the option.
        const finalOpts = Object.assign({ keepalive: true }, opts || {}, ctrl ? { signal: ctrl.signal } : {});
        try {
            const p = fetch(url, finalOpts);
            if (p && p.then) {
                p.then(function () { if (timer) clearTimeout(timer); })
                 .catch(function () { if (timer) clearTimeout(timer); });
            } else if (timer) {
                clearTimeout(timer);
            }
            return p;
        } catch (e) {
            if (timer) clearTimeout(timer);
        }
    }

    // Persistent per-browser id — the SAME localStorage key marathon.js /
    // potd.js use for scores/sessions — stamped on the visit so the
    // daily-summary email can recognize return players across days.
    // Read-or-create (creating it here on page load means the game modules
    // reuse the same id). Best-effort: private mode just yields null.
    function _persistentSessionId() {
        try {
            var key = (typeof PROJECT_SLUG !== 'undefined' ? PROJECT_SLUG : 'circuitousness') + '_session_id';
            var id = localStorage.getItem(key);
            if (!id) {
                id = (window.crypto && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : (Date.now().toString(36) + Math.random().toString(36).slice(2));
                localStorage.setItem(key, id);
            }
            return id;
        } catch (e) { return null; }
    }

    // Client-minted id for THIS page load, sent as clientUuid on the visit
    // POST and stored on the server row. Exists so a LATER load can still
    // attach this load's milestones if the page dies before the visit
    // POST's response delivers the numeric visit_id (see the delivery-
    // robustness note in the header). Same generator fallback chain as
    // _persistentSessionId.
    const loadUuid = (function () {
        try {
            return (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : (Date.now().toString(36) + Math.random().toString(36).slice(2));
        } catch (e) {
            return Date.now().toString(36) + Math.random().toString(36).slice(2);
        }
    })();

    // ---- Pending-milestone queue (localStorage) --------------------
    // Entries: { id, uuid, sid, m, p, t } — id is removal handle, uuid ties
    // the entry to its originating load, m/p are the milestone name and
    // PATCH payload, t a wall-clock stamp for the staleness cap. Entries
    // are added when a milestone FIRES and removed only when its PATCH
    // response comes back ok — so anything the page's death (or a failed/
    // aborted PATCH) left behind gets flushed by the next load. All
    // best-effort: private mode / quota just means no queue, which is the
    // pre-queue status quo.
    const QUEUE_KEY = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness')
        + '_pendingMilestones_v1';
    function _queueRead() {
        try {
            const a = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function _queueWrite(list) {
        try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list)); } catch (e) {}
    }
    function _queueAdd(milestone, payload) {
        if (isSuppressed()) return null;
        const id = loadUuid + ':' + Math.random().toString(36).slice(2);
        let list = _queueRead();
        list.push({
            id:   id,
            uuid: loadUuid,
            sid:  _persistentSessionId(),
            m:    milestone,
            p:    payload || null,
            t:    Date.now(),
        });
        // Growth cap — a session solving dozens of puzzles offline could
        // otherwise accrete unboundedly. Oldest entries drop first; the
        // funnel booleans they carry are almost certainly duplicated by
        // newer entries anyway (agreed/started/finished are sticky).
        if (list.length > 60) list = list.slice(list.length - 60);
        _queueWrite(list);
        return id;
    }
    function _queueRemove(id) {
        if (!id) return;
        const list = _queueRead();
        const out = list.filter(function (e) { return !e || e.id !== id; });
        if (out.length !== list.length) _queueWrite(out);
    }
    // Attach queue-removal to a milestone PATCH's promise: confirmed
    // delivery (response ok) clears the entry; anything else leaves it
    // for the next load's flush.
    function _confirmDelivery(p, qid) {
        if (!qid || !p || !p.then) return;
        p.then(function (r) { if (r && r.ok) _queueRemove(qid); })
         .catch(function () {});
    }
    // Flush milestones stranded by PREVIOUS loads. One POST per dead load
    // (rarely more than one). Runs shortly after module init — early
    // enough that even another glance-session usually gets it out, late
    // enough that DevMode (loaded after this file) is defined for the
    // isSuppressed check. Deliberately NOT silentFetch: its 5s abort would
    // kill the request on the exact cold-dyno stall that strands
    // milestones in the first place. Raw fetch + keepalive instead — no
    // timeout, and the request survives the page dying mid-flight, which
    // is also why clearing the queue optimistically (before the response)
    // is acceptable: once issued, a keepalive request almost always
    // completes, and a retry loop risks double-counting server-side
    // accumulators instead.
    function _flushStaleMilestones() {
        if (isSuppressed()) return;
        const base = apiBase();
        if (!base) return;
        const list = _queueRead();
        if (!list.length) return;
        const now = Date.now();
        const stale = list.filter(function (e) {
            return e && e.uuid && e.uuid !== loadUuid && e.m &&
                   (now - (e.t || 0)) < 48 * 3600 * 1000;  // matches the server's 48h lookup window
        });
        // Keep only this load's own entries (none exist this early, but a
        // slow flush timer racing a fast milestone shouldn't eat it).
        _queueWrite(list.filter(function (e) { return e && e.uuid === loadUuid; }));
        if (!stale.length) return;
        const byUuid = {};
        stale.forEach(function (e) {
            (byUuid[e.uuid] = byUuid[e.uuid] || []).push(e);
        });
        Object.keys(byUuid).slice(0, 5).forEach(function (u) {
            const entries = byUuid[u];
            try {
                fetch(base + '/visit/late-milestones', {
                    method:    'POST',
                    headers:   { 'Content-Type': 'application/json' },
                    keepalive: true,
                    body: JSON.stringify({
                        clientUuid: u,
                        sessionId:  entries[0].sid || _persistentSessionId(),
                        milestones: entries.map(function (e) { return { m: e.m, p: e.p }; }),
                    }),
                }).catch(function () {});
            } catch (e) {}
        });
    }

    // POST /api/visit — first call only. Subsequent calls are no-ops
    // (visit_id already set). Returns a Promise that resolves to the
    // visitId so the page-init code can chain other tracking calls
    // after the visit row exists.
    // Load context set by platform-redirect.js (runs first, in <head>, so the
    // flag exists by the time we POST). embedded = ran inside an external
    // embed (itch iframe / CDN); redirected = platform-redirect nudged the
    // player to the real origin. Lets the funnel separate redirect handoffs
    // from genuine on-site visits. Defaults to false if the flag is absent
    // (redirect script didn't load, or a non-embed origin).
    function _loadContext() {
        try {
            var f = (typeof window !== 'undefined') && window.__platformRedirect;
            return { embedded: !!(f && f.embedded), redirected: !!(f && f.fired) };
        } catch (e) { return { embedded: false, redirected: false }; }
    }

    function recordVisit() {
        if (isSuppressed()) return Promise.resolve(0);
        if (visitId !== 0) return Promise.resolve(visitId);
        if (visitPromise) return visitPromise;
        const base = apiBase();
        if (!base) return Promise.resolve(0);
        const ctx = _loadContext();
        const payload = {
            referrer:     (typeof document !== 'undefined' && document.referrer) || null,
            userAgent:    (typeof navigator !== 'undefined' && navigator.userAgent) || null,
            language:     (typeof I18n !== 'undefined' && I18n.getBrowserLanguage)
                              ? I18n.getBrowserLanguage()
                              : (typeof navigator !== 'undefined' && navigator.language) || null,
            screenWidth:  (typeof screen !== 'undefined') ? screen.width  : null,
            screenHeight: (typeof screen !== 'undefined') ? screen.height : null,
            deviceType:   detectDeviceType(),
            os:           detectOS(),
            sessionId:    _persistentSessionId(),
            clientUuid:   loadUuid,
            embedded:     ctx.embedded,
            redirected:   ctx.redirected,
        };
        // keepalive so the row is created (and stamped with clientUuid)
        // even when the page dies mid-request — the whole point of the
        // late-milestone flush is that the row exists to attach to.
        visitPromise = fetch(base + '/visit', {
            method:    'POST',
            headers:   { 'Content-Type': 'application/json' },
            keepalive: true,
            body:      JSON.stringify(payload),
        }).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (data) {
            visitId = (data && typeof data.visit_id === 'number') ? data.visit_id : -1;
            return visitId;
        }).catch(function () {
            visitId = -1;
            return -1;
        });
        return visitPromise;
    }

    // Helper for the PATCH endpoints — they all need a real visitId
    // before they can fire. If recordVisit hasn't completed yet, we
    // await it; if visitId is -1 (bot / no API), skip silently.
    async function withVisit(fn) {
        if (isSuppressed()) return;
        if (visitId === 0) await recordVisit();
        if (visitId <= 0) return;
        fn(visitId);
    }

    // The player dismissed the opening warning / "I agree" intro and reached
    // the mode menu. The funnel milestone between visit and start — lets the
    // admin separate "bailed at the warning" from "reached the menu but never
    // picked a card". No payload; the server flips a sticky boolean.
    function recordAgreed() {
        const qid = _queueAdd('agreed', null);
        withVisit(function (id) {
            _confirmDelivery(
                silentFetch(apiBase() + '/visit/' + id + '/agreed', { method: 'PATCH' }),
                qid);
        });
    }
    function recordStart(mode, gameType) {
        const payload = { mode: mode || null, gameType: gameType || null };
        const qid = _queueAdd('started', payload);
        withVisit(function (id) {
            _confirmDelivery(
                silentFetch(apiBase() + '/visit/' + id + '/started', {
                    method:  'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                }),
                qid);
        });
    }
    function recordFinish() {
        const qid = _queueAdd('finished', null);
        withVisit(function (id) {
            _confirmDelivery(
                silentFetch(apiBase() + '/visit/' + id + '/finished', { method: 'PATCH' }),
                qid);
        });
    }
    // One call per puzzle SOLVE (marathon, practice, PotD — callers'
    // state guards exclude replays), carrying whether music / SFX were
    // audible at that moment. The server accumulates per-visit on/off
    // counters so the admin page can show "% of puzzles solved with
    // music on" — a per-solve tally, unlike the sticky funnel booleans.
    function recordSolve(musicOn, sfxOn) {
        const payload = { music: !!musicOn, sfx: !!sfxOn };
        const qid = _queueAdd('solved', payload);
        withVisit(function (id) {
            _confirmDelivery(
                silentFetch(apiBase() + '/visit/' + id + '/solved', {
                    method:  'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify(payload),
                }),
                qid);
        });
    }
    // `kind` tags the share source for the stats breakdown:
    //   'popup' — from the "Enjoying it?" popup
    //   'score' — from a game-over / "Solved!" card share row
    // Omitted/empty → recorded without a source (legacy behavior).
    function recordShare(platform, kind) {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/shared', {
                method:  'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ platform: platform || 'unknown', kind: kind || '' }),
            });
        });
    }
    function recordCreditsClick(linkId) {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/credits-clicked', {
                method:  'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ link: linkId || 'unknown' }),
            });
        });
    }
    // ASPCA donation-link click in the share popup. No payload — there's a
    // single donation link, so the server just flips a sticky boolean
    // (mirrors the shared_game flag, not the credits-CSV accumulator).
    function recordDonateClick() {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/donate-clicked', { method: 'PATCH' });
        });
    }

    // Flush any milestones stranded by previous loads. 1.5s delay: clears
    // the initial load burst, and guarantees DevMode (a later script tag)
    // exists for _flushStaleMilestones's isSuppressed check. Window guard
    // keeps a worker context (importScripts) inert.
    if (typeof window !== 'undefined') {
        setTimeout(_flushStaleMilestones, 1500);
    }

    return {
        recordVisit:        recordVisit,
        recordAgreed:       recordAgreed,
        recordStart:        recordStart,
        recordFinish:       recordFinish,
        recordSolve:        recordSolve,
        recordShare:        recordShare,
        recordCreditsClick: recordCreditsClick,
        recordDonateClick:  recordDonateClick,
        // Exposed for diagnostics — admin/dev can paste
        // `Tracking.visitId()` in the console to see what they were
        // tagged with this session.
        visitId:            function () { return visitId; },
    };
})();
