// Developer mode — ?dev=true in the URL, or Ctrl+D FROM THE INTRO SCREEN.
//
// ACTIVATION WINDOW (2026-08-02): Ctrl+D no longer needs the URL flag, so
// dev mode is reachable on any deployment without editing the address —
// but ONLY while the intro overlay is still on screen. Two groups are
// therefore locked out by construction:
//   • CrazyGames players — intro.js hides the overlay during load and
//     auto-starts, so the window has already closed before anyone can
//     press a key (and IS_CRAZYGAMES is checked outright besides).
//   • anyone already playing — dismissing the intro closes the window,
//     so a player who has started a game can never open the panel.
// Activation is per page load and deliberately NOT persisted: a reload
// puts the intro back, which is the only way back in.
//
// THE TWO DOORS DIFFER. ?dev=true is the only one that reveals the
// destructive dev-action buttons (wipe leaderboards / visits / first-run,
// reset PotD — #dbgDevActions in index.html). Ctrl+D opens the debug
// PANEL only, leaving those hidden: the panel is worth making easy to
// reach, a one-keystroke "delete every leaderboard" is not.
//
// Three responsibilities:
//   1. Ctrl+D toggles the `<html>` element between mode-game and
//      mode-debug, swapping the debug-panel UI in/out without a reload.
//      The initial mode is still set by the inline script in index.html
//      from ?debug=true.
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
    // Two doors, and they are NOT equivalent. ?dev=true activates
    // immediately and is the ONLY one that reveals the destructive
    // dev-action buttons (wipe leaderboards / visits / first-run, reset
    // PotD) — those delete real production data, so reaching them should
    // take deliberately editing the URL. Ctrl+D at the intro opens the
    // debug PANEL for anyone, with those buttons still hidden.
    const urlActive = (new URLSearchParams(window.location.search)).get('dev') === 'true';
    let active = urlActive;
    let initialized = false;

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

    // Is the activation window open? True only while the intro overlay is
    // actually on screen.
    //
    // Checked via computed display rather than the `intro-dismissed` class
    // or offsetParent: the class isn't set on intro.js's DEBUG bail (so it
    // would read as "intro showing" forever in ?debug=true), and
    // offsetParent is null for position:fixed elements in most browsers
    // even when they're perfectly visible. Display covers every way the
    // overlay leaves: hidden on the CG/debug bails, and removed from the
    // DOM 350ms after a normal dismiss.
    //
    // CrazyGames is refused outright as well. intro.js hides the overlay
    // during load so the timing already rules CG out, but the whole point
    // of this gate is that CG players can't reach destructive dev
    // actions — that shouldn't rest on a race being unwinnable.
    function canActivate() {
        if (typeof IS_CRAZYGAMES !== 'undefined' && IS_CRAZYGAMES) return false;
        const ov = document.getElementById('introOverlay');
        if (!ov) return false;
        try {
            return window.getComputedStyle(ov).display !== 'none';
        } catch (e) { return false; }
    }

    // The destructive dev actions (wipe leaderboards / visits / first-run,
    // reset PotD) ship `hidden` so they can't be stumbled into. ONLY the
    // ?dev=true door calls this — activating from the intro deliberately
    // leaves them hidden, so the panel stays explorable without putting a
    // "delete every leaderboard" button one keystroke away.
    function revealDevActions() {
        const el = document.getElementById('dbgDevActions');
        if (el) el.hidden = false;
    }

    // Ctrl+D handler — toggles between mode-game and mode-debug on
    // <html>. preventDefault stops the browser's default "bookmark
    // this page" action. Skips when the user is typing in an input
    // (so typing "d" in the gameOverName field with Ctrl held by
    // accident doesn't yank the UI out from under them).
    //
    // Bound unconditionally; the handler decides whether this particular
    // keystroke is allowed to ACTIVATE. Once dev mode IS active the
    // toggle keeps working for the rest of the session — the gate is on
    // getting in, not on flipping the panel afterwards.
    function bindCtrlD() {
        document.addEventListener('keydown', function (ev) {
            if (!ev.ctrlKey) return;
            if (ev.key !== 'd' && ev.key !== 'D') return;
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
            if (!active) {
                // Window closed → fall through untouched, so Ctrl+D keeps
                // its normal browser meaning for ordinary players.
                if (!canActivate()) return;
                active = true;
                init();
                if (typeof Logger !== 'undefined') Logger.info('[dev] activated from the intro screen');
                // The toggle below switches to mode-debug, which hides the
                // intro overlay for us (html.mode-debug #introOverlay in
                // styles.css). The board starts empty — Marathon never got
                // a mode picked — so the panel's Generate PotD button is
                // the way to put a puzzle on screen.
            }
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

    // Everything dev mode turns ON. Idempotent: reachable from the URL
    // flag at boot OR from the Ctrl+D activation above, never both.
    function init() {
        if (initialized) return;
        initialized = true;
        // URL flag only — see revealDevActions. Ctrl+D activation gets
        // the panel and the PotD watcher, never the wipe buttons.
        if (urlActive) revealDevActions();
        startRolloverWatcher();
        // Initial seed for today — give the rest of the page a beat to
        // finish booting (PotD module init, fetch first, etc.) before
        // queueing a bunch of worker generations behind it.
        setTimeout(function () { kickPotdSeed('initial boot'); }, 2000);
        if (typeof Logger !== 'undefined') {
            Logger.info('[dev] dev mode active — Ctrl+D toggles debug panel; PotD daily watcher running');
        }
    }

    // Ctrl+D is armed on EVERY load — that's what makes activation
    // possible without the URL flag. init() still only runs when dev mode
    // is actually on, so a normal player pays nothing but one keydown
    // listener (no rollover polling, no PotD seeding, no revealed
    // buttons, and Tracking keeps recording them normally).
    function boot() {
        bindCtrlD();
        if (active) init();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    return {
        isActive: function () { return active; }
    };
})();
