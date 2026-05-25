// End credits scroller — runs the bottom-to-top scrolling credits sequence
// behind the score popup after a Marathon ends or a PotD puzzle is solved.
// Mirrors TANTЯO's startCreditsAnimation: requestAnimationFrame loop that
// moves a long .credits-content div from off-bottom up past off-top.
//
// Companion to Music.startCreditsSequence / stopCreditsSequence (which
// handle the audio side). The two are kept separate so the visual scroll
// and the credits-music can be triggered/stopped independently if needed.
//
// The score popup (#gameOver / #potdSolveTransition) is drawn on top of
// the overlay via a higher z-index — body.credits-rolling repositions the
// popup to the upper third and strips its full-screen backdrop so the
// scrolling credits show through behind it.

const Credits = (function () {
    // Pixels-per-second scroll speed. Time-based (not frame-based) so the
    // scroll runs at the same wall-clock pace regardless of the device's
    // actual frame rate. Originally was 0.5px/frame which at 60fps is
    // exactly 30px/sec; on iPad Safari (especially in PWA fullscreen)
    // requestAnimationFrame can be throttled well below 60fps under
    // thermal pressure, low-power mode, or just heavier-than-expected
    // animation load — at ~15fps the scroll dropped to roughly 1/4 the
    // expected speed. Time-based motion (`scrollY -= SPEED * deltaMs /
    // 1000`) is frame-rate independent: each frame moves the scroll by
    // whatever the elapsed wall-clock time should account for, so a
    // 30fps device and a 120fps device finish the credits at the same
    // moment, just with different visual smoothness.
    const SCROLL_SPEED_PX_PER_SEC = 30;
    // Cursor auto-hide delay after the last mousemove inside the overlay.
    // Lifted from TANTЯO so the pointer doesn't sit on screen distracting
    // from the scroll.
    const CURSOR_HIDE_MS = 2000;
    // Delay before kicking the credits MUSIC after the visual scroll starts.
    // Gives the player a beat to register that the puzzle is over before the
    // music swaps from gameplay/menu to credits. TANTЯO uses 3s.
    const MUSIC_DELAY_MS = 3000;
    // Grace window at credits start during which click-to-pause is ignored.
    // The player often clicks once or twice extra on the way out of the game
    // (dismissing the last move, racing to clear a popup) — those clicks
    // arrive AT the credits overlay and would otherwise instantly pause the
    // scroll before the player even sees it start.
    const PAUSE_GRACE_MS = 4000;

    let animationId        = null;
    let scrollY            = 0;
    let contentHeight      = 0;
    let paused             = false;
    // Timestamp of the previous rAF tick. 0 means "no prior frame this
    // run" — first tick of each start() just records the timestamp and
    // returns without moving anything. Reset on start() so a fresh
    // credits run doesn't compute a giant delta from a long-stale value.
    // Also updated unconditionally inside animate() (even when paused)
    // so resuming from a pause doesn't catch up via accumulated delta.
    let lastFrameTime      = 0;
    let musicTimeoutId     = null;
    let clickHandler       = null;
    let mouseMoveHandler   = null;
    let cursorHideTimer    = null;
    let active             = false;
    let startedAt          = 0;   // Date.now() when start() ran — for pause grace check

    function getElements() {
        return {
            overlay: document.getElementById('creditsOverlay'),
            scroll:  document.getElementById('creditsScroll'),
        };
    }

    function start() {
        if (active) return;
        const { overlay, scroll } = getElements();
        if (!overlay || !scroll) return;

        active = true;
        startedAt = Date.now();
        // Reset the per-frame delta baseline; the next animate() tick
        // will record `now` and start computing deltas from there.
        // Without this, a credits run that started, stopped, then
        // started again hours later would compute a multi-hour delta
        // on the first frame and instantly scroll off-screen.
        lastFrameTime = 0;
        document.body.classList.add('credits-rolling');

        // Title text comes from PROJECT_NAME so the credits header tracks
        // any rename without a separate edit (universal rule 1).
        const titleDiv = document.getElementById('gameTitle');
        if (titleDiv && typeof PROJECT_NAME === 'string') {
            titleDiv.textContent = PROJECT_NAME.toUpperCase();
        }

        const screenHeight = window.innerHeight;
        overlay.style.display = 'block';
        overlay.style.cursor  = 'none';

        // Click anywhere on the overlay pauses/resumes the scroll. Score
        // popup sits in its own DOM subtree at a higher z-index, so popup
        // clicks don't bubble here and won't accidentally pause.
        // PAUSE_GRACE_MS at the very start swallows clicks — stops the
        // first stray "I was clicking through the game" click from
        // instantly pausing before the player even notices credits started.
        paused = false;
        clickHandler = function () {
            if (Date.now() - startedAt < PAUSE_GRACE_MS) return;
            paused = !paused;
        };
        overlay.addEventListener('click', clickHandler);

        // Show pointer only while the mouse is actually moving over the
        // credits; hide after a beat so it doesn't sit on screen.
        mouseMoveHandler = function () {
            overlay.style.cursor = 'pointer';
            if (cursorHideTimer) clearTimeout(cursorHideTimer);
            cursorHideTimer = setTimeout(function () {
                overlay.style.cursor = 'none';
                cursorHideTimer = null;
            }, CURSOR_HIDE_MS);
        };
        overlay.addEventListener('mousemove', mouseMoveHandler);

        // Start the content fully off-screen below. We measure
        // contentHeight after one rAF so layout has actually rendered.
        // Position is driven by `transform: translate3d` (GPU compositing
        // + sub-pixel rendering for smooth motion) rather than `top:`,
        // which on slower-refresh devices can render choppily because
        // the per-frame delta is often a fractional pixel (0.5 at 60fps).
        // top:0 + a translate3d Y offset keeps the layout box at the
        // natural position; only the visual compositing layer is moved.
        scrollY = screenHeight;
        scroll.style.top = '0';
        scroll.style.transform = `translate3d(0, ${scrollY}px, 0)`;
        scroll.style.willChange = 'transform';

        requestAnimationFrame(function () {
            const content = scroll.querySelector('.credits-content');
            contentHeight = content ? content.offsetHeight : 0;
            if (contentHeight === 0) {
                if (typeof Logger !== 'undefined') Logger.warn('Credits: content height is 0; scroll will not animate');
                return;
            }
            animationId = requestAnimationFrame(animate);
        });

        // Kick the credits music after a short delay so the swap from
        // gameplay/menu music to credits music doesn't feel abrupt. The
        // delay also lets the scroll get rolling first, which reads better.
        if (musicTimeoutId) { clearTimeout(musicTimeoutId); musicTimeoutId = null; }
        musicTimeoutId = setTimeout(function () {
            musicTimeoutId = null;
            if (typeof Music !== 'undefined' && Music.startCreditsSequence) {
                Music.startCreditsSequence();
            }
        }, MUSIC_DELAY_MS);
    }

    function animate(now) {
        // First frame: just stash the timestamp and schedule next — no
        // movement yet (no prior frame to delta against). This also
        // covers the case where some browsers can call rAF without an
        // argument; `now` would be undefined and we'd reset on the
        // following frame.
        if (lastFrameTime === 0 || typeof now !== 'number') {
            if (typeof now === 'number') lastFrameTime = now;
            if (scrollY + contentHeight > 0) {
                animationId = requestAnimationFrame(animate);
            } else {
                animationId = null;
            }
            return;
        }
        const deltaMs = now - lastFrameTime;
        lastFrameTime = now;
        if (!paused) {
            scrollY -= SCROLL_SPEED_PX_PER_SEC * (deltaMs / 1000);
            const { scroll } = getElements();
            // translate3d (GPU compositor) rather than top: — sub-pixel
            // movement renders smoothly. With top:, fractional-pixel
            // increments would round per frame and stutter visibly,
            // particularly on iOS Safari.
            if (scroll) scroll.style.transform = `translate3d(0, ${scrollY}px, 0)`;
        }
        // Stop once the bottom of the content has fully passed the top of
        // the viewport. Overlay stays visible (player still has the score
        // popup to dismiss); they just won't see anything scrolling.
        if (scrollY + contentHeight > 0) {
            animationId = requestAnimationFrame(animate);
        } else {
            animationId = null;
        }
    }

    function stop() {
        if (!active) return;
        active = false;
        document.body.classList.remove('credits-rolling');

        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }
        if (musicTimeoutId) {
            clearTimeout(musicTimeoutId);
            musicTimeoutId = null;
        }
        if (cursorHideTimer) {
            clearTimeout(cursorHideTimer);
            cursorHideTimer = null;
        }

        const { overlay, scroll } = getElements();
        if (overlay) {
            overlay.style.display = 'none';
            overlay.style.cursor  = '';
            if (clickHandler)     overlay.removeEventListener('click',     clickHandler);
            if (mouseMoveHandler) overlay.removeEventListener('mousemove', mouseMoveHandler);
        }
        // Release the GPU-promoted layer hint so the credits-scroll
        // element isn't permanently composited on its own layer when
        // it's not animating. will-change: transform during start()
        // tells the browser to prep a layer; clearing here tells it
        // to fold back into the normal paint tree.
        if (scroll) {
            scroll.style.willChange = '';
            scroll.style.transform  = '';
        }
        clickHandler     = null;
        mouseMoveHandler = null;
        paused           = false;

        if (typeof Music !== 'undefined' && Music.stopCreditsSequence) {
            Music.stopCreditsSequence();
        }
    }

    function isActive() { return active; }

    return {
        start:    start,
        stop:     stop,
        isActive: isActive,
    };
})();
