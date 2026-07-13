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
//   - DevMode.isActive() (?dev=true)  — the dev's own runs don't
//     pollute aggregate stats. ALL Tracking.* methods short-circuit
//     before any POST when dev mode is on.
//   - Bot UAs — filtered SERVER-SIDE in POST /api/visit. Bot visits
//     return visit_id=-1 and the client silently skips further PATCHes.
//   - Worker context — `window` undefined; nothing to track from a
//     worker, the typeof guard handles that.
//
// All POSTs are fire-and-forget — no callbacks, no error surfacing.
// Tracking failures must NEVER block gameplay; the cost of a missed
// event is a slightly incomplete stats page, which is acceptable.

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
        if (typeof location === 'undefined' || !location.hostname) return false;
        return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }
    function isSuppressed() {
        if (isLocalHost()) return true;
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
        const finalOpts = Object.assign({}, opts || {}, ctrl ? { signal: ctrl.signal } : {});
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
            embedded:     ctx.embedded,
            redirected:   ctx.redirected,
        };
        visitPromise = fetch(base + '/visit', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
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
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/agreed', { method: 'PATCH' });
        });
    }
    function recordStart(mode, gameType) {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/started', {
                method:  'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ mode: mode || null, gameType: gameType || null }),
            });
        });
    }
    function recordFinish() {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/finished', { method: 'PATCH' });
        });
    }
    // One call per puzzle SOLVE (marathon, practice, PotD — callers'
    // state guards exclude replays), carrying whether music / SFX were
    // audible at that moment. The server accumulates per-visit on/off
    // counters so the admin page can show "% of puzzles solved with
    // music on" — a per-solve tally, unlike the sticky funnel booleans.
    function recordSolve(musicOn, sfxOn) {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/solved', {
                method:  'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ music: !!musicOn, sfx: !!sfxOn }),
            });
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
