/**
 * cg-sdk.js — CrazyGames HTML5 SDK (v3) wrapper.
 *
 * ONLY active on crazygames.com origins (IS_CRAZYGAMES from config.js).
 * Everywhere else this module is a pure no-op facade: no SDK script is
 * injected, no external request is made, and every method returns
 * immediately — other sites are byte-for-byte unaffected at runtime.
 *
 * What it feeds CrazyGames (Basic Launch: optional; Full Launch: required):
 *   loadingStart/Stop   — their measured load time ("loads in <10s" is an
 *                         explicit benchmark; the first gameplayStart also
 *                         determines the game's initial loading size).
 *   gameplayStart/Stop  — tells their site when active play is happening
 *                         so it defers resource-intensive work; also their
 *                         engagement signal.
 *   happytime()         — page-level celebration (confetti). Their docs say
 *                         to use it SPARINGLY — we fire it only when a run
 *                         ranks on the global top-20 leaderboard.
 *
 * Timing: the SDK script loads async from their CDN, so game code may call
 * gameplayStart() before init resolves (the first-visit auto-start begins
 * at DOMContentLoaded). The facade therefore tracks desired state in
 * booleans and RECONCILES once the SDK is ready — events aren't queued,
 * only the latest state is replayed, which is all the SDK cares about.
 *
 * Call sites:
 *   marathon.js  onPuzzleReady → gameplayStart; goToMenu/gameOver → gameplayStop;
 *                renderGameOver top-20 branch → happytime
 *   potd.js      startPuzzle ready block → gameplayStart; showMenu → gameplayStop
 *   tutorial.js  open → overlayPause; close → overlayResume
 *   Replays fire nothing: marathon's onPuzzleReady bails on state !== PLAYING,
 *   and PotD's ready block only runs for real plays.
 */
const CgSdk = (() => {
    const active = (typeof IS_CRAZYGAMES !== 'undefined' && IS_CRAZYGAMES);

    let sdk = null;               // window.CrazyGames.SDK once init() resolves
    let playing = false;          // our belief: is gameplay active right now
    let pausedByOverlay = false;  // gameplay suspended by a modal (tutorial)
    let loadingStopped = false;   // loadingStop already reported (dedupe)

    // Every SDK call is best-effort: a CDN hiccup or API change must never
    // break the game itself, so everything routes through this guard.
    function call(fn) {
        if (!sdk) return;
        try { fn(); } catch (e) { /* SDK failure is never fatal */ }
    }

    function gameplayStart() {
        if (playing && !pausedByOverlay) return;
        playing = true;
        pausedByOverlay = false;
        call(() => sdk.game.gameplayStart());
    }
    function gameplayStop() {
        if (!playing) return;
        playing = false;
        // Already reported stopped while the overlay was up — don't double-fire.
        const alreadyStopped = pausedByOverlay;
        pausedByOverlay = false;
        if (!alreadyStopped) call(() => sdk.game.gameplayStop());
    }
    // Modal overlays that suspend play WITHOUT leaving the run (the how-to
    // tutorial). Safe to call from the menu too: overlayPause no-ops unless
    // gameplay was actually active, so a menu-opened tutorial fires nothing.
    function overlayPause() {
        if (!playing || pausedByOverlay) return;
        pausedByOverlay = true;
        call(() => sdk.game.gameplayStop());
    }
    function overlayResume() {
        if (!pausedByOverlay) return;
        pausedByOverlay = false;
        if (playing) call(() => sdk.game.gameplayStart());
    }
    function happytime() {
        call(() => sdk.game.happytime());
    }
    function loadingStop() {
        if (loadingStopped) return;
        loadingStopped = true;
        call(() => sdk.game.loadingStop());
    }

    if (active) {
        // "Loading finished" = all static assets in (window load). The
        // first-visit auto-start's 4×4 build takes well under a second and
        // overlaps the tail of asset loading, so window load is an honest
        // marker without cross-module wiring. If the SDK initializes after
        // load already fired, the reconcile below reports start+stop
        // back-to-back — still accurate: loading IS over by then.
        if (document.readyState !== 'complete') {
            window.addEventListener('load', () => loadingStop());
        }

        const s = document.createElement('script');
        s.src = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
        s.async = true;
        s.onload = async () => {
            try {
                if (!window.CrazyGames || !window.CrazyGames.SDK) return;
                await window.CrazyGames.SDK.init();
                sdk = window.CrazyGames.SDK;
            } catch (e) {
                return; // SDK unavailable — facade stays inert
            }
            // Reconcile current state now that calls can actually go out.
            // Order matters: loading events first so the first
            // gameplayStart (= their loading-size marker) lands after them.
            call(() => sdk.game.loadingStart());
            if (loadingStopped || document.readyState === 'complete') {
                loadingStopped = true;
                call(() => sdk.game.loadingStop());
            }
            if (playing && !pausedByOverlay) {
                call(() => sdk.game.gameplayStart());
            }
        };
        document.head.appendChild(s);
    }

    return { gameplayStart, gameplayStop, overlayPause, overlayResume, happytime };
})();
