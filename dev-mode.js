// Developer mode — enabled by appending ?dev=true to the URL.
//
// Three responsibilities:
//   1. Ctrl+D toggles the `<html>` element between mode-game and
//      mode-debug, swapping the debug-panel UI in/out without a reload.
//      The initial mode is still set by the inline script in index.html
//      from ?debug=true; ?dev=true only enables the LIVE TOGGLE.
//   2. A polling watcher detects when a new UTC day arrives and asks
//      Potd.devSeedAllSlots() to generate + submit all 8 of today's
//      puzzles. Also fires once at boot so a freshly-loaded dev session
//      doesn't have to wait for the next midnight rollover to seed.
//   3. Exposes DevMode.isActive() so future admin/analytics tracking
//      code can suppress event submissions from dev-mode sessions
//      (the user's own runs shouldn't pollute aggregate stats).
//
// Loaded LAST in the script chain (after potd.js, game.js) so all the
// modules it touches are guaranteed available.

const DevMode = (function () {
    const active = (new URLSearchParams(window.location.search)).get('dev') === 'true';

    // Poll cadence for the daily-rollover watcher. 1 minute is fine —
    // the player won't notice a 60s lag in seeding the next day's
    // puzzles, and tighter polling would just waste CPU.
    const ROLLOVER_POLL_MS = 60 * 1000;

    function todayUTC() {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, '0');
        const d = String(now.getUTCDate()).padStart(2, '0');
        return y + '-' + m + '-' + d;
    }

    // Ctrl+D handler — toggles between mode-game and mode-debug on
    // <html>. preventDefault stops the browser's default "bookmark
    // this page" action. Skips when the user is typing in an input
    // (so typing "d" in the gameOverName field with Ctrl held by
    // accident doesn't yank the UI out from under them).
    function bindCtrlD() {
        document.addEventListener('keydown', function (ev) {
            if (!ev.ctrlKey) return;
            if (ev.key !== 'd' && ev.key !== 'D') return;
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            ev.preventDefault();
            const html = document.documentElement;
            if (html.classList.contains('mode-debug')) {
                html.classList.remove('mode-debug');
                html.classList.add('mode-game');
                if (typeof Logger !== 'undefined') Logger.info('[dev] Ctrl+D → game mode');
            } else {
                html.classList.remove('mode-game');
                html.classList.add('mode-debug');
                if (typeof Logger !== 'undefined') Logger.info('[dev] Ctrl+D → debug mode');
            }
        });
    }

    // Daily-rollover watcher. Tracks the UTC date last seen; when the
    // current UTC date differs, fires Potd.devSeedAllSlots so the next
    // day's puzzles are generated + submitted ahead of player demand.
    // Also fires once at startup so a freshly-loaded dev session
    // immediately tops up today's seeding.
    let lastSeenDate = todayUTC();
    let seedingInFlight = false;
    function kickPotdSeed(why) {
        if (seedingInFlight) return;
        if (typeof Potd === 'undefined' || !Potd.devSeedAllSlots) return;
        seedingInFlight = true;
        if (typeof Logger !== 'undefined') Logger.info('[dev] kicking PotD seed (' + why + ')');
        Potd.devSeedAllSlots()
            .catch(function (e) {
                if (typeof Logger !== 'undefined') Logger.warn('[dev] PotD seed failed', e);
            })
            .then(function () { seedingInFlight = false; });
    }
    function startRolloverWatcher() {
        setInterval(function () {
            const now = todayUTC();
            if (now !== lastSeenDate) {
                if (typeof Logger !== 'undefined') Logger.info('[dev] UTC day rolled ' + lastSeenDate + ' → ' + now);
                lastSeenDate = now;
                kickPotdSeed('day rollover');
            }
        }, ROLLOVER_POLL_MS);
    }

    function init() {
        bindCtrlD();
        startRolloverWatcher();
        // Initial seed for today — give the rest of the page a beat to
        // finish booting (PotD module init, fetch first, etc.) before
        // queueing a bunch of worker generations behind it.
        setTimeout(function () { kickPotdSeed('initial boot'); }, 2000);
        if (typeof Logger !== 'undefined') {
            Logger.info('[dev] dev mode active — Ctrl+D toggles debug panel; PotD daily watcher running');
        }
    }

    if (active) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        isActive: function () { return active; }
    };
})();
