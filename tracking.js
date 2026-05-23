// Visit / engagement tracking — mirrors TANTЯO's pattern.
//
// One POST /api/visit on page load creates a server-side PageVisit row
// and returns its id. From then on, each meaningful event (game start,
// finish, share click, credits-link click) PATCHes that visit row with
// the relevant delta. The data feeds an admin dashboard at
// official-intelligence-web/admin/circuitousness/.
//
// SUPPRESSION:
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
    let inFlightVisit = false;

    function isSuppressed() {
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

    // POST /api/visit — first call only. Subsequent calls are no-ops
    // (visit_id already set). Returns a Promise that resolves to the
    // visitId so the page-init code can chain other tracking calls
    // after the visit row exists.
    function recordVisit() {
        if (isSuppressed()) return Promise.resolve(0);
        if (visitId !== 0 || inFlightVisit) return Promise.resolve(visitId);
        const base = apiBase();
        if (!base) return Promise.resolve(0);
        inFlightVisit = true;
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
        };
        return fetch(base + '/visit', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        }).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (data) {
            visitId = (data && typeof data.visit_id === 'number') ? data.visit_id : -1;
            inFlightVisit = false;
            return visitId;
        }).catch(function () {
            visitId = -1;
            inFlightVisit = false;
            return -1;
        });
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
    function recordShare(platform) {
        withVisit(function (id) {
            silentFetch(apiBase() + '/visit/' + id + '/shared', {
                method:  'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ platform: platform || 'unknown' }),
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

    return {
        recordVisit:        recordVisit,
        recordStart:        recordStart,
        recordFinish:       recordFinish,
        recordShare:        recordShare,
        recordCreditsClick: recordCreditsClick,
        // Exposed for diagnostics — admin/dev can paste
        // `Tracking.visitId()` in the console to see what they were
        // tagged with this session.
        visitId:            function () { return visitId; },
    };
})();
