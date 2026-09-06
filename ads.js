/**
 * Google Ads conversion tag (gtag.js) — loader + conversion sender.
 *
 * WHY THIS EXISTS, and what it reverses. On 2026-09-04 (v1.79) the
 * decision was explicitly to keep gtag OFF the page and feed Google Ads
 * by OFFLINE CONVERSION IMPORT instead — click ids are captured in
 * tracking.js and stored server-side for that purpose. Two days later
 * the campaign's own diagnostics read "Eligible (Misconfigured) — your
 * website is missing a Google tag" while running Maximize-conversions
 * bidding on zero conversion signal, and the export half of the offline
 * plan had never been built. Offline import also cannot ever clear that
 * diagnostic and optimizes worse (batched and hours late, versus a
 * real-time hit). So: tag on the page, privacy.html rewritten to match.
 * The click-id capture STAYS — it costs nothing and remains the only way
 * to reconcile our own numbers against Google's.
 *
 * WHAT IT LOADS: Google's conversion tag only. No Google Analytics
 * property, no remarketing/audience list, no ad serving of any kind —
 * the games show no ads. gtag sets a first-party `_gcl_au` cookie.
 *
 * ── THE FOUR GATES ──────────────────────────────────────────────────
 * Nothing loads unless all four pass. Each is load-bearing:
 *
 *   1. CONFIGURED. GOOGLE_ADS_ID empty → total no-op, not even a script
 *      element. This file therefore ships safe BEFORE the Ads account is
 *      set up, which matters because /rel pushes straight to production.
 *   2. OUR OWN ORIGIN. official-intelligence.art and its subdomains
 *      only. This is what keeps the tag out of the CrazyGames iframe and
 *      off the itch.io CDN embed — both host the same files, and both
 *      have their own rules about third-party tags. It also covers
 *      localhost and file:// for free.
 *   3. NOT INSTALLED. An ad click ALWAYS lands in a browser tab, never
 *      inside an installed PWA or the Play TWA shell — so suppressing
 *      standalone display mode costs literally zero conversions, and it
 *      keeps advertising code out of the Play Store build. That is not
 *      a nicety: a TWA loads this live origin (see PLAY_STORE.md, "the
 *      trap"), so without this gate a web-only change would silently
 *      alter what the Play listing's Data Safety form has to declare.
 *   4. NOT EEA/UK/CH. See the geo block below — this is the gate that
 *      replaces a consent banner.
 *
 * Plus the ordinary opt-outs (sticky ?track=false, ?dev=true), read
 * DIRECTLY here rather than through tracking.js / DevMode, because this
 * file must run in the HEAD — see the ordering note in index.html.
 *
 * ── ORDERING, THE PART THAT BREAKS SILENTLY ─────────────────────────
 * gtag.js reads the click id (`?gclid=` / `?wbraid=` / `?gbraid=`) out of
 * the address bar when it executes. tracking.js STRIPS those params on
 * load. gtag.js is async, so "loaded from the head" does not guarantee it
 * wins the race — on a slow connection it would routinely execute after
 * the strip and attribute nothing, with no error anywhere. So the strip
 * now WAITS on Ads.whenReady(). Both halves of that contract have a
 * comment; do not remove one without the other.
 */
const Ads = (() => {
    'use strict';

    const ID    = (typeof GOOGLE_ADS_ID === 'string') ? GOOGLE_ADS_ID.trim() : '';
    const LABEL = (typeof GOOGLE_ADS_SOLVE_LABEL === 'string') ? GOOGLE_ADS_SOLVE_LABEL.trim() : '';

    // How long the strip is allowed to wait on gtag.js before giving up
    // and running anyway. The strip is not optional — a landing URL that
    // keeps its click id gets bookmarked and shared, and re-attributes
    // every later visit to one dead ad click — so a gtag.js that never
    // arrives (offline, blocked by an extension, DNS failure) must not
    // be able to leave the id in the address bar forever.
    const READY_TIMEOUT_MS = 4000;

    let ready = false;          // gtag.js settled: loaded, failed, or timed out
    let waiters = [];
    const fired = {};           // conversion label → true, once per page load

    // ── Gate 2: our own origin ───────────────────────────────────────
    // Subdomain-anchored so `official-intelligence.art.evil.com` cannot
    // match. `circuitousness.official-intelligence.art` is the game;
    // `official-intelligence.art` is the umbrella site the ad may land on
    // instead — one tag id covers both, and gtag's default `auto` cookie
    // domain puts _gcl_au on the shared apex, so a click that lands on
    // the site and converts in the game needs no cross-domain linker.
    function isOwnOrigin() {
        if (typeof location === 'undefined') return false;
        if (location.protocol !== 'https:') return false;   // rules out file:// and plain-http dev
        return /(^|\.)official-intelligence\.art$/i.test(location.hostname || '');
    }

    // ── Gate 3: not an installed app ─────────────────────────────────
    function isInstalled() {
        try {
            if (navigator.standalone === true) return true;   // iOS home-screen
            return window.matchMedia
                && window.matchMedia('(display-mode: standalone)').matches;
        } catch (e) { return false; }
    }

    // ── Gate 4: no advertising cookie in the EEA / UK / Switzerland ──
    // This is what lets the game carry a conversion tag with NO consent
    // banner, and it is the reason privacy.html can say plainly that the
    // tag is not loaded there. Google's EU user consent policy (and
    // Consent Mode v2 behind it) applies to users in those countries; we
    // do not target ads there, so the cheapest correct answer is to not
    // set the cookie at all rather than to build a banner in front of a
    // game whose whole design goal is one click to gameplay.
    //
    // Timezone, not language or IP: it needs no network round trip, is
    // available before first paint, and is not defeated by a player who
    // simply prefers French. It OVER-blocks — Europe/Moscow and
    // Europe/Istanbul are not EEA, and a European traveller in Ohio
    // reads as Ohio — and over-blocking is the correct direction to err
    // when the cost is a handful of untracked conversions in markets the
    // campaign does not buy. An unreadable timezone blocks too.
    const EEA_TZ_PREFIX = 'Europe/';
    // EEA/EFTA territories that sit outside the Europe/ tree.
    const EEA_TZ_EXTRA = [
        'Atlantic/Azores', 'Atlantic/Madeira', 'Atlantic/Canary',
        'Atlantic/Faroe', 'Atlantic/Reykjavik', 'Atlantic/Jan_Mayen',
        'Arctic/Longyearbyen', 'Indian/Reunion', 'Indian/Mayotte',
        'America/Guadeloupe', 'America/Martinique', 'America/Cayenne',
        'America/Miquelon', 'America/Marigot', 'America/St_Barthelemy',
        'Pacific/Reunion'
    ];
    function isEEA() {
        let tz = null;
        try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
        if (!tz) return true;                                  // unreadable → assume yes
        if (tz.indexOf(EEA_TZ_PREFIX) === 0) return true;
        return EEA_TZ_EXTRA.indexOf(tz) !== -1;
    }

    // ── Ordinary opt-outs ────────────────────────────────────────────
    // Deliberately duplicated from tracking.js / dev-mode.js rather than
    // imported: this file runs in the head, before either of those has
    // loaded, and it has to make its decision there (gate 2 above). Three
    // cheap reads is the right price for that. The sticky key MUST stay
    // identical to tracking.js's — a player who opted out of our own
    // counters has not agreed to be measured by Google either.
    function isOptedOut() {
        const slug = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness');
        let params = null;
        try { params = new URLSearchParams(location.search || ''); } catch (e) {}
        if (params && params.get('dev') === 'true') return true;
        const t = params ? params.get('track') : null;
        if (t === 'false') return true;
        if (t === 'true')  return false;
        try { return localStorage.getItem(slug + '_trackOptOut_v1') === '1'; }
        catch (e) { return false; }
    }

    const active = !!ID && isOwnOrigin() && !isInstalled() && !isEEA() && !isOptedOut();

    // ── Load ─────────────────────────────────────────────────────────
    function settle() {
        if (ready) return;
        ready = true;
        const list = waiters;
        waiters = [];
        for (let i = 0; i < list.length; i++) {
            try { list[i](); } catch (e) { /* a waiter must not block the rest */ }
        }
    }

    function load() {
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        // Conversion measurement only. No page-level ad personalization
        // signals are sent, and no remarketing list is built from this.
        window.gtag('config', ID, { allow_ad_personalization_signals: false });

        const s = document.createElement('script');
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ID);
        // settle() on BOTH outcomes: a blocked or failed gtag.js must
        // still release the URL strip waiting behind it.
        s.onload  = settle;
        s.onerror = settle;
        (document.head || document.documentElement).appendChild(s);
        setTimeout(settle, READY_TIMEOUT_MS);
    }

    if (active) {
        load();
    } else {
        // Inactive is the common case (installed app, CrazyGames, EEA,
        // dev). Waiters must still run, immediately — otherwise the URL
        // strip would never happen on any of those loads.
        ready = true;
    }

    // ── Public API ───────────────────────────────────────────────────

    // Run `cb` once gtag.js has settled — or immediately when the tag is
    // not active at all. Used by tracking.js to hold the click-id strip
    // until gtag has had its chance to read the id. Never throws, never
    // drops a callback.
    function whenReady(cb) {
        if (typeof cb !== 'function') return;
        if (ready) { try { cb(); } catch (e) {} return; }
        waiters.push(cb);
    }

    // Send one conversion. `name` is a local key, not Google's label —
    // the label lives in config.js so it can be pasted from the Ads UI
    // without touching code.
    //
    // ONCE PER PAGE LOAD, per name. A visit that solves eleven puzzles is
    // one conversion, not eleven: the signal we are buying is "this click
    // produced someone who plays", and letting a long session outvote ten
    // short ones would teach the bidder to chase outliers.
    function conversion(name) {
        if (!active || !LABEL || fired[name]) return;
        fired[name] = true;
        try {
            window.gtag('event', 'conversion', {
                send_to: ID + '/' + LABEL,
                value: 1.0,
                currency: 'USD',
            });
        } catch (e) { /* fire-and-forget, exactly like every other tracker here */ }
    }

    function isActive() { return active; }

    return { whenReady: whenReady, conversion: conversion, isActive: isActive };
})();

if (typeof window !== 'undefined') window.Ads = Ads;
