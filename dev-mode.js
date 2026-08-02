// Developer mode — ?dev=true in the URL, or Ctrl+D FROM THE INTRO SCREEN.
//
// ACTIVATION WINDOW (2026-08-02): Ctrl+D no longer needs the URL flag, so
// dev mode is reachable on any deployment without editing the address —
// but the panel can ONLY BE OPENED while the intro overlay is still on
// screen. Two groups are locked out by construction:
//   • CrazyGames players — intro.js hides the overlay during load and
//     auto-starts, so the window has already closed before anyone can
//     press a key (and IS_CRAZYGAMES is checked outright besides).
//   • anyone already playing — dismissing the intro closes the window,
//     so a player who has started a game can never open the panel.
// Activation is per page load and deliberately NOT persisted: a reload
// puts the intro back, which is the only way back in.
//
// The window applies to ?dev=true as well (tightened 2026-08-02 on user
// report — the flag used to let the panel open mid-game). The flag still
// activates dev mode's BACKGROUND work at boot; what it no longer buys is
// a way into the panel outside the intro. Note this also means a
// ?debug=true session — which starts in the panel with the intro already
// hidden — cannot re-open it after toggling to game mode; reload to get
// it back.
//
// The two doors are equivalent now. They used to differ because the panel
// carried destructive wipe buttons that only ?dev=true revealed; those
// were DELETED outright on 2026-08-02 (user call) rather than hidden,
// since shipping them at all put the admin endpoint URLs in the bundle
// for anyone to read. The endpoints still exist server-side — call them
// by hand when needed.
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
    // ?dev=true activates the background work immediately; Ctrl+D at the
    // intro is the second door (see the header). `active` is mutable
    // because of it. Neither door opens the PANEL outside the intro
    // window — that gate lives in bindCtrlD and applies to both.
    let active = (new URLSearchParams(window.location.search)).get('dev') === 'true';
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

    // Ctrl+D handler — toggles between mode-game and mode-debug on
    // <html>. preventDefault stops the browser's default "bookmark
    // this page" action. Skips when the user is typing in an input
    // (so typing "d" in the gameOverName field with Ctrl held by
    // accident doesn't yank the UI out from under them).
    //
    // THE GATE IS ON OPENING, AND IT APPLIES TO EVERY DOOR (2026-08-02,
    // user call). It used to guard only ACTIVATION, which meant a
    // ?dev=true session could open the panel at any point — mid-game,
    // after the intro was long gone. Now the intro overlay has to be on
    // screen to open the panel no matter how dev mode was switched on;
    // the URL flag buys the background work (rollover watcher, PotD
    // seeding), not a permanent way in.
    //
    // CLOSING is never gated — being unable to leave the panel would be a
    // worse trap than being unable to enter it. In a ?dev=true session
    // the intro overlay is still in the DOM (mode-debug just hides it via
    // CSS), so closing restores it and re-opening works again; the panel
    // only becomes unreachable once the intro is actually dismissed and
    // play begins, which is exactly the intent.
    function bindCtrlD() {
        document.addEventListener('keydown', function (ev) {
            if (!ev.ctrlKey) return;
            if (ev.key !== 'd' && ev.key !== 'D') return;
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

            const html    = document.documentElement;
            const opening = !html.classList.contains('mode-debug');

            if (opening) {
                // Window closed → fall through untouched, so Ctrl+D keeps
                // its normal browser meaning for ordinary players (and for
                // anyone who has started playing, flag or no flag).
                if (!canActivate()) return;
                if (!active) {
                    active = true;
                    init();
                    if (typeof Logger !== 'undefined') Logger.info('[dev] activated from the intro screen');
                }
                // Switching to mode-debug hides the intro overlay for us
                // (html.mode-debug #introOverlay in styles.css). The board
                // starts empty — Marathon never got a mode picked — so the
                // panel's Generate PotD button is the way to put a puzzle
                // on screen.
            }

            ev.preventDefault();
            if (opening) {
                html.classList.remove('mode-game');
                html.classList.add('mode-debug');
                if (typeof Logger !== 'undefined') Logger.info('[dev] Ctrl+D → debug mode');
            } else {
                html.classList.remove('mode-debug');
                html.classList.add('mode-game');
                if (typeof Logger !== 'undefined') Logger.info('[dev] Ctrl+D → game mode');
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
