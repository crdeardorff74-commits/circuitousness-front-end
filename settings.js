// Settings — menu-only popup with Music and SFX mute toggles.
//
// Intentionally not available during gameplay: closing the popup would
// effectively pause the timer and defeat leaderboard timing guarantees.
// Universal place to add more settings later (volume sliders, language,
// animation toggles, etc.) — the toggle-switch pattern below is the
// template.
//
// Persistence: each toggle's muted state is stored under a slug-namespaced
// localStorage key. Setters propagate to the consumer modules (Sfx / Music)
// so a toggle flip silences/restores audio immediately.

const Settings = (function () {
    const MUSIC_MUTED_KEY = PROJECT_SLUG + '_setting_musicMuted';
    const SFX_MUTED_KEY   = PROJECT_SLUG + '_setting_sfxMuted';

    function loadBool(key, defaultVal) {
        try {
            const v = localStorage.getItem(key);
            if (v === 'true')  return true;
            if (v === 'false') return false;
        } catch (e) {}
        return !!defaultVal;
    }
    function storeBool(key, v) {
        try { localStorage.setItem(key, v ? 'true' : 'false'); }
        catch (e) {}
    }

    let musicMuted = loadBool(MUSIC_MUTED_KEY, false);
    let sfxMuted   = loadBool(SFX_MUTED_KEY,   false);

    function isMusicMuted() { return musicMuted; }
    function isSfxMuted()   { return sfxMuted; }

    function setMusicMuted(v) {
        musicMuted = !!v;
        storeBool(MUSIC_MUTED_KEY, musicMuted);
        if (typeof Music !== 'undefined' && Music.setMuted) Music.setMuted(musicMuted);
        syncToggleUI();
    }
    function setSfxMuted(v) {
        sfxMuted = !!v;
        storeBool(SFX_MUTED_KEY, sfxMuted);
        if (typeof Sfx !== 'undefined' && Sfx.setMuted) Sfx.setMuted(sfxMuted);
        syncToggleUI();
    }

    // Mirror persisted state into the toggle button aria-checked attrs.
    // CSS keys off [aria-checked="true"] to slide the knob and color the
    // track, so this single attribute drives the visual.
    let musicToggleEl, sfxToggleEl, overlayEl, closeBtnEl;
    // Both DOM triggers route here: #settingsBtn (menu top-right) and
    // #hudSettingsBtn (in the in-game HUD, just left of QUIT).
    let openBtnEls = [];
    function syncToggleUI() {
        if (musicToggleEl) musicToggleEl.setAttribute('aria-checked', musicMuted ? 'false' : 'true');
        if (sfxToggleEl)   sfxToggleEl.setAttribute('aria-checked',   sfxMuted   ? 'false' : 'true');
    }

    function open() {
        // No gameplay guard: the player can open Settings mid-game if
        // they want — the timer keeps ticking underneath, so any time
        // they spend in the popup is their own. Treated as a deliberate
        // trade rather than a stealth pause.
        if (overlayEl) overlayEl.classList.add('visible');
    }
    function close() {
        if (overlayEl) overlayEl.classList.remove('visible');
    }

    function init() {
        overlayEl     = document.getElementById('settingsOverlay');
        closeBtnEl    = document.getElementById('settingsCloseBtn');
        musicToggleEl = document.getElementById('settingMusic');
        sfxToggleEl   = document.getElementById('settingSfx');
        openBtnEls    = ['settingsBtn', 'hudSettingsBtn']
                            .map((id) => document.getElementById(id))
                            .filter(Boolean);

        // Hand initial mute state to consumers so they boot in the right
        // state, not "audible until first toggle".
        if (typeof Sfx   !== 'undefined' && Sfx.setMuted)   Sfx.setMuted(sfxMuted);
        if (typeof Music !== 'undefined' && Music.setMuted) Music.setMuted(musicMuted);
        syncToggleUI();

        openBtnEls.forEach((el) => el.addEventListener('click', open));
        if (closeBtnEl) closeBtnEl.addEventListener('click', close);
        // Click-outside-to-close — only fires when the click lands on the
        // overlay backdrop itself, NOT a child element. Matches TANTЯO's
        // settings overlay UX.
        if (overlayEl) {
            overlayEl.addEventListener('click', (ev) => {
                if (ev.target === overlayEl) close();
            });
        }
        if (musicToggleEl) {
            musicToggleEl.addEventListener('click', () => setMusicMuted(!musicMuted));
        }
        if (sfxToggleEl) {
            sfxToggleEl.addEventListener('click', () => setSfxMuted(!sfxMuted));
        }
        // Esc closes the popup. Cheap escape hatch on top of the close
        // button — feels natural for a modal.
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && overlayEl && overlayEl.classList.contains('visible')) {
                close();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        isMusicMuted: isMusicMuted,
        isSfxMuted:   isSfxMuted,
        setMusicMuted: setMusicMuted,
        setSfxMuted:   setSfxMuted,
        open:  open,
        close: close,
    };
})();
