/**
 * intro.js — opening warning splash, modeled after Ridiculousness's
 *            on-air liability disclaimer.
 *
 * Shown ONCE per page load before the main menu becomes interactive.
 * The player's "I agree to solve responsibly" click also serves as the
 * user-gesture the AudioContext + iOS audio elements need to unblock,
 * so we do nothing audio-wise here — audio.js + music.js already wire
 * gesture-blessing globally.
 *
 * Three things controlled from the intro screen:
 *   1. Music on/off  — checkbox bound to Settings.setMusicMuted
 *   2. Full Screen   — checkbox bound to the Fullscreen API
 *                      (vendor-prefixed for Safari/IE)
 *   3. Fullscreen key shortcut — F11, PageUp, PageDown
 *                      (Tantro's exact set, global keydown)
 *
 * The intro is suppressed entirely in debug mode (html.mode-debug) —
 * the debug page bypasses menu/game flow so the warning would be in the
 * way. The intro is also suppressed when the URL carries ?nointro=true,
 * useful for screenshots / dev iteration.
 *
 * The body text's {activity} placeholder is filled from warnings.txt
 * (one phrase per line). Fetch is cache-friendly; first failure falls
 * back to a small embedded list so the screen is never blank.
 */
const Intro = (() => {
    // Hardcoded fallback if warnings.txt fetch fails — keeps the screen
    // functional offline / on cache misses. Single bland placeholder
    // on purpose: the canonical list lives in warnings.txt and is
    // user-curated. If you want richer variety when offline, expand
    // this array OR (better) make sure warnings.txt is precached by
    // the service worker (sw.js's CORE_ASSETS already includes it).
    const FALLBACK_ACTIVITIES = [
        'operating heavy machinery'
    ];

    // Shuffle-bag persistence for warning selection. Without this, plain
    // Math.random() lets the same warning hit two or three times in a row
    // across page loads. We drain one index per intro paint, persist the
    // remaining ones, and reshuffle when the bag empties. The fingerprint
    // key captures the source list's contents so editing warnings.txt
    // invalidates a stale bag (otherwise stored indices could point past
    // the new list's length, or replay just-removed entries).
    // PROJECT_SLUG-namespaced so multiple games on the same origin (e.g.
    // localhost dev) don't share warning state.
    const WARN_REMAIN_KEY = (typeof PROJECT_SLUG !== 'undefined' ? PROJECT_SLUG : 'app') +
                            '_intro_warningRemaining_v1';
    const WARN_FINGER_KEY = (typeof PROJECT_SLUG !== 'undefined' ? PROJECT_SLUG : 'app') +
                            '_intro_warningFingerprint_v1';

    let dismissed = false;

    function isDebugMode() {
        return document.documentElement.classList.contains('mode-debug');
    }
    function urlSuppressed() {
        try {
            return new URLSearchParams(window.location.search).get('nointro') === 'true';
        } catch (e) { return false; }
    }

    // Pick a random activity from a list, returning a string.
    function pickActivity(list) {
        if (!list || list.length === 0) return FALLBACK_ACTIVITIES[0];
        return list[Math.floor(Math.random() * list.length)];
    }

    // Load warnings.txt; resolves with array of trimmed non-empty lines.
    // Returns FALLBACK_ACTIVITIES on any failure (network, parse, etc.).
    async function loadWarnings() {
        try {
            const resp = await fetch('warnings.txt', { cache: 'no-cache' });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const text = await resp.text();
            const lines = text.split(/\r?\n/)
                              .map((s) => s.trim())
                              .filter((s) => s.length > 0 && !s.startsWith('#'));
            return lines.length > 0 ? lines : FALLBACK_ACTIVITIES;
        } catch (e) {
            return FALLBACK_ACTIVITIES;
        }
    }

    // ---- Fullscreen API helpers (vendor-prefixed for Safari/IE) ----
    function getFullscreenElement() {
        return document.fullscreenElement
            || document.webkitFullscreenElement
            || document.mozFullScreenElement
            || document.msFullscreenElement
            || null;
    }
    function requestFullscreen(elem) {
        const fn = elem.requestFullscreen
                || elem.webkitRequestFullscreen
                || elem.mozRequestFullScreen
                || elem.msRequestFullscreen;
        if (!fn) return Promise.reject(new Error('Fullscreen API unsupported'));
        try {
            const ret = fn.call(elem);
            return (ret && ret.then) ? ret : Promise.resolve();
        } catch (e) { return Promise.reject(e); }
    }
    function exitFullscreen() {
        const fn = document.exitFullscreen
                || document.webkitExitFullscreen
                || document.mozCancelFullScreen
                || document.msExitFullscreen;
        if (!fn) return Promise.reject(new Error('Fullscreen API unsupported'));
        try {
            const ret = fn.call(document);
            return (ret && ret.then) ? ret : Promise.resolve();
        } catch (e) { return Promise.reject(e); }
    }
    function toggleFullscreen() {
        if (getFullscreenElement()) {
            exitFullscreen().catch(() => {});
        } else {
            requestFullscreen(document.documentElement).catch(() => {});
        }
    }

    // ---- Title canvas paint -------------------------------------
    // The intro reuses TitleRenderer (same maze-O rendering pipeline
    // as the menu title) on its own canvas — TitleRenderer's animation
    // loop ticks any canvas it was last drawn to, so the menu canvas
    // and intro canvas share the loop without fighting.
    function paintIntroTitle() {
        const c = document.getElementById('introTitleOCanvas');
        if (!c || typeof TitleRenderer === 'undefined') return;
        const rect = c.getBoundingClientRect();
        const size = Math.max(24, Math.min(rect.width, rect.height));
        if (size > 0) TitleRenderer.draw(c, size);
    }

    // ---- Setup ---------------------------------------------------
    async function init() {
        const overlay = document.getElementById('introOverlay');
        if (!overlay) return;

        // Debug mode / URL override: hide and bail.
        if (isDebugMode() || urlSuppressed()) {
            overlay.style.display = 'none';
            dismissed = true;
            return;
        }

        // Fill the body text with a random activity. The template comes
        // from i18n (so it translates per locale); we splice the
        // activity in directly since I18n.t doesn't support runtime
        // interpolation of arbitrary tokens beyond its built-in
        // {n}/{t}/etc.
        // Single async paint: we wait for warnings.txt before showing
        // text so the user never sees the placeholder phrase swap mid-
        // glance. The body element starts at `&nbsp;` (set in
        // index.html) which reserves the line's vertical space, so the
        // overlay layout doesn't jump when text arrives. warnings.txt is
        // in sw.js's CORE_ASSETS — warm caches resolve from the SW near-
        // instantly. On a truly cold first install the body is briefly
        // empty (couple hundred ms), which is the trade-off for
        // eliminating the phrase-A → phrase-B flash players noticed
        // when we used to paint a fallback synchronously then replace.
        const bodyEl = document.getElementById('introBody');
        function setBodyText(activity) {
            if (!bodyEl) return;
            const tpl = (typeof I18n !== 'undefined' && I18n.t)
                ? I18n.t('intro.bodyTemplate')
                : 'Please do not attempt to solve any of these puzzles while {activity}, as that is dangerous and could lead to serious injury.';
            bodyEl.textContent = tpl.replace('{activity}', activity);
        }
        // Localize the activity at a given index. warnings.txt is the
        // canonical English list (user-curated, master count). i18n.js
        // holds per-language `intro.activities` arrays at the SAME
        // indices. If a translation is missing (locale not yet covered,
        // warnings.txt edited but i18n not yet synced, etc.) we fall
        // back to the English entry from warnings.txt so the screen is
        // always populated with SOMETHING. Each activity is also
        // pre-conjugated to fit its locale's bodyTemplate grammar
        // (e.g., French's "pendant que vous {activity}" needs a 2nd-
        // person plural verb form, Japanese's "{activity}中に" needs
        // a verbal noun, etc).
        function localizeActivity(index, englishList) {
            const localList = (typeof I18n !== 'undefined' && I18n.t)
                ? I18n.t('intro.activities')
                : null;
            if (Array.isArray(localList) && typeof localList[index] === 'string' && localList[index]) {
                return localList[index];
            }
            return (englishList && englishList[index]) || englishList[0] || 'doing something dangerous';
        }
        // Shuffle-bag-aware picker: returns indices into `list` such that
        // no entry repeats until all have been shown, then reshuffles. Bag
        // state persists in localStorage across sessions (see WARN_*_KEY
        // above). Lists of 0/1 items short-circuit without touching
        // localStorage — relevant when loadWarnings falls back to the
        // single-item FALLBACK_ACTIVITIES on a fetch failure, so the
        // failure mode doesn't clobber the canonical bag.
        function pickActivityIndex(list) {
            if (!list || list.length === 0) return -1;
            if (list.length === 1) return 0;
            // Pipe-joined content hash. Detects any edit (reorder, add,
            // remove, typo fix) — better than length alone since a same-
            // length edit would leave stale indices in the bag.
            const fp = list.join('|');
            let storedFp = null;
            let remaining = null;
            try {
                storedFp = localStorage.getItem(WARN_FINGER_KEY);
                const raw = localStorage.getItem(WARN_REMAIN_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) remaining = parsed;
                }
            } catch (e) { /* private-mode storage block — fall through to a fresh in-memory shuffle */ }
            // Reshuffle when the list changed (fp mismatch), the bag is
            // missing/empty, or any index is corrupt/out-of-range (defensive
            // against partial reads or future schema changes).
            const stale = !remaining
                       || remaining.length === 0
                       || storedFp !== fp
                       || remaining.some((i) => !Number.isInteger(i) || i < 0 || i >= list.length);
            if (stale) {
                remaining = [];
                for (let i = 0; i < list.length; i++) remaining.push(i);
                // Fisher-Yates shuffle in place.
                for (let i = remaining.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    const tmp = remaining[i]; remaining[i] = remaining[j]; remaining[j] = tmp;
                }
                try { localStorage.setItem(WARN_FINGER_KEY, fp); } catch (e) {}
            }
            const idx = remaining.shift();
            try { localStorage.setItem(WARN_REMAIN_KEY, JSON.stringify(remaining)); } catch (e) {}
            return idx;
        }
        // Pick + paint once, from whatever loadWarnings returns. On
        // success that's the full curated list from warnings.txt; on
        // failure (offline, fetch error, empty file) loadWarnings
        // already substitutes FALLBACK_ACTIVITIES so the body is never
        // permanently blank. No sync pre-paint — see the comment above
        // `setBodyText` for the trade-off.
        loadWarnings().then((list) => {
            // If the player dismissed the intro before the fetch
            // resolved (Escape/Enter on the empty overlay) don't write
            // to a detached DOM node.
            if (dismissed) return;
            const idx = pickActivityIndex(list);
            if (idx < 0) return;
            setBodyText(localizeActivity(idx, list));
        });

        // Paint the title-O canvas. requestAnimationFrame x2 lets the
        // font load + layout settle before measuring (the canvas's CSS
        // size scales with its em-sized parent). Same pattern marathon.js
        // uses for its own title paint.
        requestAnimationFrame(() => {
            paintIntroTitle();
            requestAnimationFrame(paintIntroTitle);
        });

        // ---- Music toggle ----
        // Mirror current saved state, then route changes back through
        // Settings.setMusicMuted (which handles the priorMode dance so
        // unmuting restores the player's previously chosen playlist).
        const musicBox = document.getElementById('introMusicCheckbox');
        if (musicBox && typeof Settings !== 'undefined' && Settings.getMusicMode) {
            musicBox.checked = Settings.getMusicMode() !== 'none';
            musicBox.addEventListener('change', () => {
                if (Settings.setMusicMuted) Settings.setMusicMuted(!musicBox.checked);
            });
        }

        // ---- Fullscreen toggle ----
        // Initial state mirrors the document's actual fullscreen status
        // (might be true if the player F11'd before the intro painted).
        // The change handler fires requestFullscreen INSIDE the gesture
        // path — Safari/iOS require the request to be synchronous with
        // a user input event.
        const fsBox = document.getElementById('introFullscreenCheckbox');
        if (fsBox) {
            fsBox.checked = !!getFullscreenElement();
            fsBox.addEventListener('change', () => {
                if (fsBox.checked) {
                    requestFullscreen(document.documentElement).catch(() => {
                        // Failure (browser denial, no API) — sync the
                        // checkbox back so it doesn't lie about state.
                        fsBox.checked = false;
                    });
                } else {
                    exitFullscreen().catch(() => {});
                }
            });
            // Keep the checkbox honest if the user F11s or escapes
            // out of fullscreen while still on the intro screen.
            const onFsChange = () => { fsBox.checked = !!getFullscreenElement(); };
            ['fullscreenchange', 'webkitfullscreenchange',
             'mozfullscreenchange', 'MSFullscreenChange'].forEach((evt) => {
                document.addEventListener(evt, onFsChange);
            });
        }

        // ---- Keyboard shortcut: F11 / PageUp / PageDown ----
        // Tantro's exact key set. Global so it works during the menu /
        // gameplay too, not just the intro screen. F11 is the browser's
        // own fullscreen shortcut in most cases — wiring our handler
        // doesn't conflict because we call preventDefault only when the
        // page is actually focused.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'F11' || e.key === 'PageUp' || e.key === 'PageDown') {
                e.preventDefault();
                toggleFullscreen();
            }
        });

        // ---- Dismiss button ----
        const agreeBtn = document.getElementById('introAgreeBtn');
        if (agreeBtn) {
            agreeBtn.addEventListener('click', dismiss);
        }
        // Escape also dismisses — common keyboard expectation for any
        // modal-like screen. Only when the intro is the visible overlay.
        document.addEventListener('keydown', (e) => {
            if (dismissed) return;
            if (e.key === 'Escape' || e.key === 'Enter') {
                e.preventDefault();
                dismiss();
            }
        });
    }

    // Fade out + remove. Also un-hides the rest of the UI so the menu
    // can interact normally. dismissed flag short-circuits double calls.
    function dismiss() {
        if (dismissed) return;
        dismissed = true;
        const overlay = document.getElementById('introOverlay');
        if (!overlay) return;
        // CSS transition handles the visual fade; we strip the element
        // after the transition completes so it doesn't keep absorbing
        // any stray taps (pointer-events:none would also work but
        // removal is cleaner and frees the DOM node).
        overlay.classList.add('introDismissing');
        setTimeout(() => {
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 350);  // matches the CSS transition-duration on .introDismissing
        document.documentElement.classList.add('intro-dismissed');
        // Kick off the menu/gameplay music here — this dismiss is fired
        // from a user gesture (button click / Enter / Escape), so the
        // AudioContext can resume and iOS audio elements get blessed
        // synchronously inside the call stack. Music.start() respects
        // Settings.muted (the intro's Music checkbox routes through
        // Settings.setMusicMuted), so if the player unchecked Music on
        // the intro, start() returns early — silent. If the playlist
        // hasn't loaded yet (API still in flight), shouldPlay=true is
        // set inside start() and refreshFromAPI's auto-start hook will
        // pick it up when the lists arrive. Marathon/PotD start() calls
        // later are idempotent.
        // Explicitly mark menu phase so the first pickNext draws from
        // the menu pool (menu_only list in admin) rather than the
        // intro/gameplay pool. Defaults to true on module load anyway,
        // but being explicit here makes the flow easier to follow.
        if (typeof Music !== 'undefined') {
            if (Music.setMenuPhase) Music.setMenuPhase(true);
            if (Music.start)        Music.start();
        }
    }

    // Public surface — exposed for testing / dev override; the auto-init
    // below covers the normal page-load path.
    return { init, dismiss };
})();

// Auto-init on DOMContentLoaded. Earlier than that and the overlay
// markup may not exist yet; later and the player sees the menu briefly
// before the warning paints over it.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => Intro.init());
} else {
    Intro.init();
}
