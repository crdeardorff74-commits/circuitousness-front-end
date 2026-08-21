/**
 * platform-redirect.js — Official Intelligence universal helper
 *
 * Problem: when the game is played on a phone/tablet from an EXTERNAL embed
 * (itch.io's CDN iframe), "Add to Home Screen" bookmarks the itch.io listing
 * page (its "Run game" intro) instead of this PWA — the manifest / start_url
 * only take effect on the game's real origin. So mobile players who install
 * from itch.io land back on itch's intro, not the game's.
 *
 * Fix: on mobile, nudge the player from the itch embed over to TARGET (the
 * game's own origin), where the PWA installs correctly. Two stages, matching
 * the chosen "auto, then tap fallback" behavior:
 *   1. Seamless auto-redirect. Works when we're TOP-LEVEL on itch's CDN
 *      (itch's fullscreen launch) or anywhere top-navigation is permitted.
 *      A harmless no-op when the embedding iframe's sandbox forbids it.
 *   2. Tap fallback overlay. itch's in-page iframe sandbox omits
 *      top-navigation but allows popups, so the overlay's PRIMARY button opens
 *      TARGET in a new tab — landing the player on the real origin, top-level,
 *      where Add to Home Screen installs the actual PWA.
 *      The overlay also offers a SECONDARY "play in this window" link: a plain
 *      same-frame anchor to TARGET. Navigating the iframe's OWN browsing
 *      context is never sandbox-blocked, so this is the guaranteed-playable
 *      fallback for the rare browser/sandbox that swallows the new-tab open —
 *      the game loads on the real origin inside the frame (fully playable,
 *      just not installable from there). Two distinct anchors, never a
 *      scripted window.open, so there's no double-open and no popup-blocker
 *      fragility — both are trusted user-gesture navigations.
 *
 * Loaded FIRST, in <head>, so the auto attempt runs before any game UI paints.
 * NOT importScripts()'d by sw.js (it touches window/document). Overlay text is
 * pulled from I18n (rule 5); the lookup is deferred to a task after
 * DOMContentLoaded so I18n has detected the language by then, with an English
 * fallback if I18n is somehow unavailable.
 *
 * Inert on desktop, in an installed/standalone PWA, on the game's own
 * origin, and inside NON-itch embeds (CrazyGames and other game portals we
 * submit to forbid redirecting players off-portal) — so it can never loop
 * and never fires where it shouldn't.
 */
(function () {
    'use strict';

    // The game's real PWA origin. PROJECT-SPECIFIC — the one line that differs
    // between projects.
    var TARGET = 'https://circuitousness.official-intelligence.art/';

    // English fallbacks, used only if I18n isn't available when the overlay builds.
    var FALLBACK = {
        'redirect.title':    'Play the full version',
        'redirect.body':     'On phones, the game runs best on its own site. Tap below to open it — and you can add it to your home screen from there.',
        'redirect.button':   'Open the full version',
        'redirect.fallback': 'Not opening? Tap here to play in this window.'
    };

    function tr(key) {
        try {
            if (typeof I18n !== 'undefined' && I18n && typeof I18n.t === 'function') {
                var s = I18n.t(key);
                if (s && s !== key) return s;
            }
        } catch (e) { /* fall through to English */ }
        return FALLBACK[key] || key;
    }

    // ─── Eligibility ───
    function isStandalone() {
        try {
            return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                   window.navigator.standalone === true;
        } catch (e) { return false; }
    }

    function isMobile() {
        var ua = navigator.userAgent || '';
        var uaMobile = /Android|iPhone|iPad|iPod|IEMobile|BlackBerry|Opera Mini|Mobile/i.test(ua);
        // iPadOS 13+ Safari reports as MacIntel with a touch screen.
        var iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
        return uaMobile || iPadOS;
    }

    // Running as an external embed rather than on our own origin? Used ONLY
    // for tracking's `embedded` tag — ANY framed/foreign-host load counts,
    // including game portals (CrazyGames etc.) and desktop embeds.
    function isExternalEmbed() {
        var host = location.hostname || '';
        if (/official-intelligence\.art$/i.test(host)) return false; // our own origin → never
        if (/itch\.(io|zone)$/i.test(host)) return true;             // top-level on itch's CDN
        try { return window.top !== window.self; } catch (e) { return true; } // cross-origin access → framed
    }

    // Specifically an ITCH embed? The redirect ACTION below is gated on this,
    // NOT on isExternalEmbed(): portals we deliberately submit to (CrazyGames,
    // Poki, GameDistribution, ...) also host the game in a foreign iframe, and
    // redirecting their players off-portal breaks the play session AND
    // violates portal terms — an instant QA rejection. itch is the one
    // embedder whose mobile flow is broken enough (Add-to-Home-Screen
    // bookmarks itch's listing, not the PWA) to justify the nudge, so only
    // itch's CDN host or an itch.io referrer qualifies. Unknown embedders
    // default to INERT.
    function isItchEmbed() {
        var host = location.hostname || '';
        if (/itch\.(io|zone)$/i.test(host)) return true; // itch's CDN, top-level or framed
        var framed;
        try { framed = window.top !== window.self; } catch (e) { framed = true; }
        return framed && /itch\.io/i.test(document.referrer || '');
    }

    // Expose load context for tracking.js to tag the visit (it fires after
    // this — this script loads first in <head>). `embedded` is true for ANY
    // external-embed load, including desktop, which we deliberately do NOT
    // redirect. `fired` flips true only when this script actually nudges a
    // mobile player to the real origin (Stage 1 auto-redirect + Stage 2
    // overlay). A visit that is embedded && fired && never reached the menu
    // is a redirect HANDOFF, not a rejection of the intro.
    var _embedded = isExternalEmbed();
    try { window.__platformRedirect = { embedded: _embedded, fired: false }; } catch (e) {}

    if (!isMobile() || isStandalone() || !isItchEmbed()) return;

    // Past the guard means this script WILL act (redirect + overlay below),
    // so mark the load as a redirect handoff for tracking.
    try { window.__platformRedirect.fired = true; } catch (e) {}

    var framed;
    try { framed = window.top !== window.self; } catch (e) { framed = true; }

    // ─── Stage 1: seamless auto-redirect (no-op if the sandbox blocks it) ───
    try {
        (framed ? window.top : window).location.replace(TARGET);
    } catch (e) {
        // itch's in-page iframe forbids top-navigation → fall through to overlay.
    }

    // ─── Stage 2: tap fallback overlay ───
    function showOverlay() {
        if (document.getElementById('oiRedirectOverlay') || !document.body) return;

        var overlay = document.createElement('div');
        overlay.id = 'oiRedirectOverlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        // SAFE centering + scroll: the content lives in an inner wrapper
        // with margin:auto rather than justify-content:center on the
        // overlay — a centered flex column that overflows crops BOTH ends
        // with no way to scroll to them (field report 2026-08-21: short
        // landscape phone cut off part of this message). Auto margins
        // center identically when everything fits and collapse to 0 when
        // it doesn't, letting overflow-y:auto expose the whole thing.
        overlay.style.cssText = [
            'position:fixed', 'inset:0', 'z-index:2147483647',
            'display:flex', 'flex-direction:column', 'align-items:center',
            'overflow-y:auto',
            'padding:2rem', 'box-sizing:border-box', 'text-align:center',
            'background:rgba(6,8,16,0.94)',
            'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
            'color:#fff', "font-family:'Segoe UI',system-ui,Arial,sans-serif"
        ].join(';');

        var content = document.createElement('div');
        content.style.cssText = [
            'margin:auto 0', 'display:flex', 'flex-direction:column',
            'align-items:center', 'gap:1.25rem', 'max-width:100%'
        ].join(';');

        // Corner close (×) — language-neutral escape hatch so the overlay never
        // traps a player who'd rather stay on itch.
        var close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close');
        close.style.cssText = [
            'position:absolute', 'top:0.75rem', 'right:1rem',
            'background:none', 'border:none', 'color:#fff',
            'font-size:2.2rem', 'line-height:1', 'cursor:pointer',
            'opacity:0.7', '-webkit-tap-highlight-color:transparent'
        ].join(';');
        close.addEventListener('click', function () { overlay.remove(); });

        var title = document.createElement('div');
        title.textContent = tr('redirect.title');
        title.style.cssText = 'font-size:clamp(1.4rem,5vw,2rem);font-weight:700;line-height:1.2;';

        var body = document.createElement('div');
        body.textContent = tr('redirect.body');
        body.style.cssText = 'font-size:clamp(0.95rem,3.6vw,1.15rem);line-height:1.5;max-width:32rem;opacity:0.9;';

        // PRIMARY: a real anchor with target="_blank" works under itch's
        // sandbox (allow-popups): it opens TARGET top-level in a new tab, where
        // the PWA and Add-to-Home-Screen function correctly.
        var btn = document.createElement('a');
        btn.href = TARGET;
        btn.target = '_blank';
        btn.rel = 'noopener';
        btn.textContent = tr('redirect.button');
        btn.style.cssText = [
            'display:inline-block', 'margin-top:0.5rem', 'padding:0.85rem 1.8rem',
            'font-size:clamp(1rem,4vw,1.2rem)', 'font-weight:700',
            'text-decoration:none', 'color:#06121f',
            'background:linear-gradient(135deg,#5ad1ff,#7c8bff)',
            'border-radius:0.75rem', 'box-shadow:0 6px 24px rgba(90,150,255,0.45)',
            'cursor:pointer', '-webkit-tap-highlight-color:transparent'
        ].join(';');

        // SECONDARY (guaranteed fallback): a plain SAME-FRAME anchor to TARGET.
        // No target="_blank", so the default action navigates the iframe's own
        // browsing context — never sandbox-blocked. The real game loads on its
        // own origin inside the frame: fully playable (just not installable
        // from here). Covers the rare browser that swallows the new-tab open.
        var fallback = document.createElement('a');
        fallback.href = TARGET;
        fallback.rel = 'noopener';
        fallback.textContent = tr('redirect.fallback');
        fallback.style.cssText = [
            'display:inline-block', 'margin-top:0.25rem',
            'font-size:clamp(0.85rem,3.2vw,1rem)', 'line-height:1.4',
            'text-decoration:underline', 'color:#a9c4ff', 'opacity:0.95',
            'cursor:pointer', '-webkit-tap-highlight-color:transparent'
        ].join(';');

        overlay.appendChild(close);
        content.appendChild(title);
        content.appendChild(body);
        content.appendChild(btn);
        content.appendChild(fallback);
        overlay.appendChild(content);
        document.body.appendChild(overlay);
    }

    // Defer to a task AFTER DOMContentLoaded so I18n.init() (also a DCL
    // listener) has set the language before we read translations.
    function scheduleOverlay() { setTimeout(showOverlay, 0); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleOverlay);
    } else {
        scheduleOverlay();
    }
})();
