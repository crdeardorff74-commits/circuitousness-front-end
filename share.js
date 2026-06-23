// Social share buttons — mirrors TANTЯO's pattern with two surfaces:
//
//   1. MINIMALIST ROW (always shown) — small icons on the score popup
//      (#gameOverShareRow inside #gameOver, and #potdShareRow inside
//      #potdSolveTransition).
//
//   2. ENJOYING-THE-GAME POPUP (shown once per browser, until dismissed)
//      — the bigger #shareOverlay popup with a friendly "share with
//      your friends" message. Fires AFTER THE 2ND FINISH (cumulative
//      across Marathon game-overs and PotD solves in the same session).
//      "Don't show again" stores a localStorage flag that prevents the
//      popup forever on that browser.
//
// Both surfaces route through the same per-platform link builders +
// the same `recordShareClick` hook, so click tracking and platform
// labels stay consistent between the two.
//
// SHARE_URL defaults to the current page URL — change here if the game
// gets a canonical short URL (itch.io page, custom domain, etc.).
// SHARE_TEXT comes from the i18n key `share.text` so localized share
// blurbs can be tuned per language.

const Share = (function () {
    const FINISH_THRESHOLD       = 2;
    const DISMISSED_LS_KEY       = PROJECT_SLUG + '_share_dismissed';
    const FINISH_COUNT_LS_KEY    = PROJECT_SLUG + '_share_finish_count';

    function getShareUrl() {
        // Canonical share URL from config.js. window.location is the opaque
        // CDN URL inside itch's iframe, so always prefer the fixed URL.
        if (typeof SHARE_URL !== 'undefined' && SHARE_URL) return SHARE_URL;
        if (typeof window === 'undefined' || !window.location) return '';
        return window.location.origin + window.location.pathname;
    }
    function getShareText() {
        if (typeof I18n !== 'undefined' && I18n.t) return I18n.t('share.text');
        return 'Check out ' + (typeof PROJECT_NAME !== 'undefined' ? PROJECT_NAME : 'this game') + '!';
    }

    // Copy text to the clipboard, returning true on success. execCommand
    // first because navigator.clipboard.writeText is blocked inside itch.io's
    // cross-origin game iframe (no clipboard-write permission) and rejects
    // silently there; execCommand works on a user gesture in iframes. Falls
    // back to the modern API for top-level pages.
    function copyToClipboard(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:-9999px;left:0;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, text.length);
            var ok = document.execCommand && document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) return true;
        } catch (e) {}
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try { navigator.clipboard.writeText(text); return true; } catch (e) {}
        }
        return false;
    }

    // Per-platform URL builders. Each takes the destination URL + the
    // share-blurb text and returns a fully-encoded share intent URL.
    // Falsy return = handled inline (Copy Link uses navigator.clipboard
    // directly, no nav).
    const BUILDERS = {
        twitter:  function (url, text) { return 'https://x.com/intent/tweet?text='     + encodeURIComponent(text) + '&url=' + encodeURIComponent(url); },
        facebook: function (url, text) { return 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url); },
        reddit:   function (url, text) { return 'https://www.reddit.com/submit?url='   + encodeURIComponent(url)  + '&title=' + encodeURIComponent(text); },
        whatsapp: function (url, text) { return 'https://wa.me/?text='                 + encodeURIComponent(text + ' ' + url); },
        telegram: function (url, text) { return 'https://t.me/share/url?url='          + encodeURIComponent(url)  + '&text='  + encodeURIComponent(text); },
        copylink: function (url, text) { return null; },  // see handleClick
    };

    function handleClick(platform, ev, fromPopup) {
        if (ev && ev.preventDefault) ev.preventDefault();
        const url   = getShareUrl();
        const text  = getShareText();
        // Record the click immediately, tagged by source: 'popup' = the
        // "Enjoying it?" prompt, 'score' = the game-over / "Solved!" cards.
        // (Suppressed at the Tracking layer in dev / on localhost.)
        if (typeof Tracking !== 'undefined' && Tracking.recordShare) {
            Tracking.recordShare(platform, fromPopup ? 'popup' : 'score');
        }
        const build = BUILDERS[platform];
        if (!build) return;
        if (platform === 'copylink') {
            if (copyToClipboard(url)) flashCopiedFeedback(ev && ev.currentTarget);
            return;
        }
        const target = build(url, text);
        if (target) window.open(target, '_blank', 'noopener');
    }

    // Brief visual confirmation when copy-link succeeds. Adds a class
    // for ~1.5s, CSS handles the actual styling. No-op if no element
    // was passed (e.g., programmatic Share.click call).
    function flashCopiedFeedback(el) {
        if (!el) return;
        el.classList.add('share-copied');
        // Swap the visible label to "Copied!" for the popup copy button (its
        // <span data-i18n="share.copyLink"> label). The minimalist icon
        // buttons have no label span, so they just get the CSS flash.
        var label = el.querySelector('[data-i18n="share.copyLink"]');
        var prev = null;
        if (label) {
            prev = label.textContent;
            label.textContent = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t('share.copied') : 'Copied!';
        }
        setTimeout(function () {
            el.classList.remove('share-copied');
            if (label) label.textContent = prev;
        }, 1500);
    }

    // Wire every element with [data-share-platform] to handleClick.
    // Used by both the minimalist rows (in #gameOver / #potdSolveTransition)
    // and the larger popup (#shareOverlay). Idempotent — calling twice
    // doesn't double-bind because addEventListener is on each element
    // only once, but the dataset-marker check makes it explicit.
    function wireButtons(root) {
        const scope = root || document;
        const buttons = scope.querySelectorAll('[data-share-platform]');
        for (const btn of buttons) {
            if (btn.dataset.shareBound === '1') continue;
            btn.dataset.shareBound = '1';
            const platform = btn.dataset.sharePlatform;
            // Buttons inside the "Enjoying it?" popup are the deliberate
            // surface; everything else (the score-popup icon rows) is the
            // accidental-prone one that gets deferred + binned.
            const fromPopup = !!(btn.closest && btn.closest('#shareOverlay'));
            btn.addEventListener('click', function (ev) { handleClick(platform, ev, fromPopup); });
        }
    }

    // -------- The "Enjoying the game?" popup --------

    function isDismissed() {
        try { return localStorage.getItem(DISMISSED_LS_KEY) === 'true'; }
        catch (e) { return false; }
    }
    function markDismissed() {
        try { localStorage.setItem(DISMISSED_LS_KEY, 'true'); } catch (e) {}
    }
    function getFinishCount() {
        try { return parseInt(localStorage.getItem(FINISH_COUNT_LS_KEY) || '0', 10) || 0; }
        catch (e) { return 0; }
    }
    function bumpFinishCount() {
        const next = getFinishCount() + 1;
        try { localStorage.setItem(FINISH_COUNT_LS_KEY, String(next)); } catch (e) {}
        return next;
    }

    function showPopup() {
        const overlay = document.getElementById('shareOverlay');
        if (!overlay) return;
        overlay.classList.add('visible');
    }
    function hidePopup() {
        const overlay = document.getElementById('shareOverlay');
        if (!overlay) return;
        overlay.classList.remove('visible');
    }

    // Called from marathon.gameOver and potd.onSolve. Bumps the finish
    // count and shows the popup when threshold is met, unless the user
    // has previously dismissed it. The bump happens unconditionally so
    // the threshold logic is self-consistent across sessions.
    function maybeShowPopup() {
        const count = bumpFinishCount();
        if (isDismissed()) return;
        if (count < FINISH_THRESHOLD) return;
        // Defer so the score popup paints first — otherwise the share
        // overlay can appear before the player sees their result.
        setTimeout(showPopup, 600);
    }

    function init() {
        // Wire all currently-known share buttons (mini rows + popup).
        wireButtons(document);
        // Close button + backdrop click + Don't-show-again wiring.
        const overlay     = document.getElementById('shareOverlay');
        const closeBtn    = document.getElementById('shareCloseBtn');
        const dismissBtn  = document.getElementById('shareDismissBtn');
        if (overlay) {
            overlay.addEventListener('click', function (ev) {
                // Clicks on the popup CARD don't bubble here as
                // outside-clicks unless they reached the overlay itself.
                if (ev.target === overlay) hidePopup();
            });
        }
        if (closeBtn)   closeBtn.addEventListener('click',   hidePopup);
        if (dismissBtn) dismissBtn.addEventListener('click', function () {
            markDismissed();
            hidePopup();
        });

        // Outbound-link click tracking (capture phase so it fires even if a
        // link's own handler were to stop propagation). Two link families:
        //   • ASPCA donation link in the share popup — matched STRUCTURALLY
        //     (any <a> inside .share-donate), not by a data-attr, because
        //     that <a> is injected via i18n innerHTML and a marker attribute
        //     would have to be duplicated across all 15 translation strings
        //     (and would be wiped + re-added on every language switch).
        //   • Credits-scroll links — credits.txt's anchors carry a
        //     [data-credit-link="<short-id>"] attribute set in index.html.
        // Dev-mode / localhost suppression is handled at the Tracking layer.
        document.addEventListener('click', function (ev) {
            const donateLink = ev.target && ev.target.closest && ev.target.closest('.share-donate a');
            if (donateLink) {
                if (typeof Tracking !== 'undefined' && Tracking.recordDonateClick) {
                    Tracking.recordDonateClick();
                }
                return;
            }
            let el = ev.target;
            while (el && el !== document.body) {
                if (el.dataset && el.dataset.creditLink) {
                    if (typeof Tracking !== 'undefined' && Tracking.recordCreditsClick) {
                        Tracking.recordCreditsClick(el.dataset.creditLink);
                    }
                    return;
                }
                el = el.parentNode;
            }
        }, { capture: true });
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        maybeShowPopup: maybeShowPopup,
        showPopup:      showPopup,
        hidePopup:      hidePopup,
        wireButtons:    wireButtons,
        // Dev affordance: paste `Share.resetDismiss()` in console to
        // re-arm the popup without clearing all localStorage.
        resetDismiss:   function () {
            try {
                localStorage.removeItem(DISMISSED_LS_KEY);
                localStorage.removeItem(FINISH_COUNT_LS_KEY);
            } catch (e) {}
        },
    };
})();
