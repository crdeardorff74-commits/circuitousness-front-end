/**
 * mode-picker.js — top-level mode selector for the main menu.
 *
 * Three modes today:
 *   'potd'     — Puzzle of the Day (first-player-generates client-side,
 *                server stores, leaderboard resets daily).
 *   'marathon' — Solve as many puzzles as time allows (the original mode).
 *   'practice' — Marathon without the time limit or leaderboards: solve as
 *                many puzzles as you like, untimed, nothing saved. This is
 *                the DEFAULT mode new players land in (see DEFAULT_MODE).
 *
 * The selector is a segmented row of three always-visible buttons
 * (#modeTabs > .menu-mode-tab in index.html). It replaced the original
 * chip + popup pattern (TANTЯO's Skill/Difficulty modal): with only three
 * modes, hiding two of them behind a popup cost more discovery than it
 * saved in space — players never learned the other modes existed. This
 * module owns the .selected/aria-pressed state, the subtitle swap, and
 * the localStorage round-trip.
 *
 * Language changes need no JS round-trip here: each tab carries a static
 * data-i18n key (mode.<m>.name), so I18n.applyTranslations() re-renders
 * them directly. Only the subtitle swaps its key per mode (see
 * updateMenuSubtitle).
 *
 * Public API:
 *   ModePicker.getMode()         — 'potd' | 'marathon' | 'practice'
 *   ModePicker.setMode(m)        — switch programmatically (fires onChange)
 *   ModePicker.onChange(cb)      — cb(newMode) on every change
 *   ModePicker.MODES             — ['potd', 'marathon', 'practice']
 */

const ModePicker = (() => {
    const MODES        = ['potd', 'marathon', 'practice'];
    // Practice is the default landing mode — new players start in the
    // untimed, nothing-saved sandbox (smaller starter puzzle, no leaderboard
    // pressure) rather than being dropped straight into the daily challenge.
    const DEFAULT_MODE = 'practice';
    const STORAGE_KEY  =
        (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'circuitousness') + '_mode';

    let currentMode = DEFAULT_MODE;
    const listeners = [];

    function loadFromStorage() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (MODES.indexOf(saved) >= 0) currentMode = saved;
        } catch (e) { /* private mode / quota — fall back to default */ }
    }
    function saveToStorage() {
        try { localStorage.setItem(STORAGE_KEY, currentMode); }
        catch (e) { /* private mode / quota — silent */ }
    }

    function getMode() { return currentMode; }

    function setMode(m) {
        if (MODES.indexOf(m) < 0) return;
        if (m === currentMode) return;
        currentMode = m;
        saveToStorage();
        updateTabSelection();
        updateMenuSubtitle();
        applyBodyClass();
        for (const cb of listeners) {
            try { cb(currentMode); } catch (e) { /* one listener's bug shouldn't break the rest */ }
        }
    }

    // Body class drives mode-specific UI rules in CSS (e.g. PotD's solved
    // indicator overlay hides when the player switches back to marathon).
    function applyBodyClass() {
        if (!document.body) return;
        for (const m of MODES) {
            document.body.classList.toggle('mode-' + m, m === currentMode);
        }
    }

    function onChange(cb) {
        if (typeof cb === 'function') listeners.push(cb);
    }

    // Highlight the active mode's tab. aria-pressed mirrors .selected so
    // assistive tech announces which of the three toggles is active.
    function updateTabSelection() {
        const wrap = document.getElementById('modeTabs');
        if (!wrap) return;
        wrap.querySelectorAll('.menu-mode-tab').forEach((btn) => {
            const on = btn.dataset.mode === currentMode;
            btn.classList.toggle('selected', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    // Menu subtitle follows the active mode — `mode.<m>.desc` instead of
    // marathon's hard-coded tagline. The data-i18n attribute is swapped
    // alongside the text so a later I18n.setLanguage() →
    // applyTranslations() pass re-renders the right description.
    function updateMenuSubtitle() {
        const sub = document.querySelector('.menuSubtitle');
        if (!sub) return;
        const key = 'mode.' + currentMode + '.desc';
        sub.setAttribute('data-i18n', key);
        if (typeof I18n !== 'undefined' && I18n.t) {
            sub.textContent = I18n.t(key);
        }
    }

    function init() {
        loadFromStorage();
        updateTabSelection();
        updateMenuSubtitle();
        applyBodyClass();

        const wrap = document.getElementById('modeTabs');
        if (!wrap) return;
        wrap.querySelectorAll('.menu-mode-tab').forEach((btn) => {
            btn.addEventListener('click', () => {
                const m = btn.dataset.mode;
                if (m) setMode(m);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        getMode,
        setMode,
        onChange,
        get MODES() { return MODES.slice(); },
    };
})();
