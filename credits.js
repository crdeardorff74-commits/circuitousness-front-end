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
    // Pixels-per-frame scroll speed. Matches TANTЯO's 0.5px/frame so the
    // visual cadence feels familiar — slow enough to read, fast enough to
    // get through the credits in a reasonable time on most viewports.
    const SCROLL_SPEED = 0.5;
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
        scrollY = screenHeight;
        scroll.style.top = scrollY + 'px';

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

    function animate() {
        if (!paused) {
            scrollY -= SCROLL_SPEED;
            const { scroll } = getElements();
            if (scroll) scroll.style.top = scrollY + 'px';
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

        const { overlay } = getElements();
        if (overlay) {
            overlay.style.display = 'none';
            overlay.style.cursor  = '';
            if (clickHandler)     overlay.removeEventListener('click',     clickHandler);
            if (mouseMoveHandler) overlay.removeEventListener('mousemove', mouseMoveHandler);
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
