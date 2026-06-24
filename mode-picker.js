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
 * The picker is a chip + popup, lifted verbatim from TANTЯO's Skill /
 * Difficulty pattern (`.menu-dropdown-*`, `.combo-modal-*`, `.selection-*`
 * classes — see styles.css). This module owns the chip's state, the
 * modal's open/close, and the localStorage round-trip.
 *
 * STUB NOTE (current iteration): selecting PotD changes the chip label and
 * persists the choice, but the rest of the front-end still runs the
 * marathon flow underneath. The Potd module + wiring lands in the next
 * iteration; until then the picker is testable in isolation.
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
        updateChipLabel();
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

    // Chip label uses the same i18n key as the modal card name so the
    // (emoji + display name) stays in lockstep across the two surfaces.
    function chipLabel(mode) {
        if (typeof I18n !== 'undefined' && I18n.t) {
            return I18n.t('mode.' + mode + '.name');
        }
        // Fallback for the moment i18n hasn't initialized yet — matches
        // the data-i18n defaults in index.html.
        if (mode === 'potd')     return '📅 Puzzle of the Day';
        if (mode === 'practice') return '🧩 Practice';
        return '🏃 Marathon';
    }

    function updateChipLabel() {
        const btn = document.getElementById('modeBtn');
        if (!btn) return;
        // Update the data-i18n attribute too so a later I18n.setLanguage()
        // → applyTranslations() pass picks up the chip and re-renders it
        // in the new language. Without this the chip would lock to the
        // language that was active at the moment of the last mode switch.
        btn.setAttribute('data-i18n', 'mode.' + currentMode + '.name');
        btn.textContent = chipLabel(currentMode);
    }

    // Menu subtitle follows the active mode — `mode.<m>.desc` instead of
    // marathon's hard-coded tagline. Same data-i18n round-trip pattern as
    // the chip so setLanguage() updates it cleanly.
    function updateMenuSubtitle() {
        const sub = document.querySelector('.menuSubtitle');
        if (!sub) return;
        const key = 'mode.' + currentMode + '.desc';
        sub.setAttribute('data-i18n', key);
        if (typeof I18n !== 'undefined' && I18n.t) {
            sub.textContent = I18n.t(key);
        }
    }

    function updateModalSelection() {
        const overlay = document.getElementById('modeModalOverlay');
        if (!overlay) return;
        overlay.querySelectorAll('.selection-option').forEach((opt) => {
            opt.classList.toggle('selected', opt.dataset.mode === currentMode);
        });
    }

    function init() {
        loadFromStorage();
        updateChipLabel();
        updateMenuSubtitle();
        applyBodyClass();

        const chip    = document.getElementById('modeBtn');
        const overlay = document.getElementById('modeModalOverlay');
        if (!chip || !overlay) return;

        chip.addEventListener('click', () => {
            updateModalSelection();
            overlay.style.display = 'flex';
        });

        overlay.querySelectorAll('.selection-option').forEach((opt) => {
            opt.addEventListener('click', () => {
                const m = opt.dataset.mode;
                if (m) setMode(m);
                overlay.style.display = 'none';
            });
        });

        // Backdrop click closes; click on the inner modal box does not.
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.style.display = 'none';
        });

        // Language-change handling is implicit: the chip carries a
        // data-i18n attribute that I18n.applyTranslations() updates on
        // every setLanguage() call. updateChipLabel keeps the attribute
        // in sync with currentMode whenever the mode changes.
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
