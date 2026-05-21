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
    const MUSIC_VOL_KEY   = PROJECT_SLUG + '_setting_musicVolume';
    const SFX_VOL_KEY     = PROJECT_SLUG + '_setting_sfxVolume';
    const BG_ENABLED_KEY  = PROJECT_SLUG + '_setting_backgroundEnabled';

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
    function loadFloat(key, defaultVal) {
        try {
            const raw = localStorage.getItem(key);
            if (raw !== null) {
                const v = parseFloat(raw);
                if (isFinite(v) && v >= 0 && v <= 1) return v;
            }
        } catch (e) {}
        return defaultVal;
    }
    function storeFloat(key, v) {
        try { localStorage.setItem(key, String(v)); } catch (e) {}
    }

    let musicMuted        = loadBool(MUSIC_MUTED_KEY, false);
    let sfxMuted          = loadBool(SFX_MUTED_KEY,   false);
    let musicVolume       = loadFloat(MUSIC_VOL_KEY,  0.6);
    let sfxVolume         = loadFloat(SFX_VOL_KEY,    0.6);
    let backgroundEnabled = loadBool(BG_ENABLED_KEY,  true);

    function isMusicMuted()       { return musicMuted; }
    function isSfxMuted()         { return sfxMuted; }
    function getMusicVolume()     { return musicVolume; }
    function getSfxVolume()       { return sfxVolume; }
    function isBackgroundEnabled(){ return backgroundEnabled; }

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
    function setMusicVolume(v) {
        musicVolume = Math.max(0, Math.min(1, +v || 0));
        storeFloat(MUSIC_VOL_KEY, musicVolume);
        if (typeof Music !== 'undefined' && Music.setVolume) Music.setVolume(musicVolume);
    }
    function setSfxVolume(v) {
        sfxVolume = Math.max(0, Math.min(1, +v || 0));
        storeFloat(SFX_VOL_KEY, sfxVolume);
        if (typeof Sfx !== 'undefined' && Sfx.setVolume) Sfx.setVolume(sfxVolume);
    }
    function setBackgroundEnabled(v) {
        backgroundEnabled = !!v;
        storeBool(BG_ENABLED_KEY, backgroundEnabled);
        if (typeof Render !== 'undefined' && Render.setBackgroundEnabled) {
            Render.setBackgroundEnabled(backgroundEnabled);
        }
        syncToggleUI();
    }

    // Mirror persisted state into the toggle button aria-checked attrs.
    // CSS keys off [aria-checked="true"] to slide the knob and color the
    // track, so this single attribute drives the visual.
    let musicToggleEl, sfxToggleEl, bgToggleEl, musicVolEl, sfxVolEl, overlayEl, closeBtnEl;
    // Both DOM triggers route here: #settingsBtn (menu top-right) and
    // #hudSettingsBtn (in the in-game HUD, just left of QUIT).
    let openBtnEls = [];
    function syncToggleUI() {
        if (musicToggleEl) musicToggleEl.setAttribute('aria-checked', musicMuted ? 'false' : 'true');
        if (sfxToggleEl)   sfxToggleEl.setAttribute('aria-checked',   sfxMuted   ? 'false' : 'true');
        if (bgToggleEl)    bgToggleEl.setAttribute('aria-checked',    backgroundEnabled ? 'true' : 'false');
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
        bgToggleEl    = document.getElementById('settingBackground');
        musicVolEl    = document.getElementById('settingMusicVolume');
        sfxVolEl      = document.getElementById('settingSfxVolume');
        openBtnEls    = ['settingsBtn', 'hudSettingsBtn']
                            .map((id) => document.getElementById(id))
                            .filter(Boolean);

        // Hand initial mute + volume state to consumers so they boot in
        // the right state, not "audible at default volume until first
        // toggle/slide".
        if (typeof Sfx !== 'undefined') {
            if (Sfx.setVolume) Sfx.setVolume(sfxVolume);
            if (Sfx.setMuted)  Sfx.setMuted(sfxMuted);
        }
        if (typeof Music !== 'undefined') {
            if (Music.setVolume) Music.setVolume(musicVolume);
            if (Music.setMuted)  Music.setMuted(musicMuted);
        }
        // Render reads its own initial bg-enabled flag from Settings in
        // Render.init (so the first paint matches persisted state), but
        // re-push here too as a belt-and-braces for ordering edge cases.
        if (typeof Render !== 'undefined' && Render.setBackgroundEnabled) {
            Render.setBackgroundEnabled(backgroundEnabled);
        }
        if (musicVolEl) musicVolEl.value = Math.round(musicVolume * 100);
        if (sfxVolEl)   sfxVolEl.value   = Math.round(sfxVolume * 100);
        syncToggleUI();

        openBtnEls.forEach((el) => el.addEventListener('click', open));
        if (closeBtnEl) closeBtnEl.addEventListener('click', close);
        // Volume sliders — `input` event fires continuously during drag,
        // so the audio reacts in real time. The setter persists every
        // change; rapid drags = many localStorage writes, which is fine
        // (sync, single-key, microseconds).
        if (musicVolEl) musicVolEl.addEventListener('input', () => setMusicVolume(musicVolEl.value / 100));
        if (sfxVolEl)   sfxVolEl.addEventListener('input',   () => setSfxVolume(sfxVolEl.value / 100));
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
        if (bgToggleEl) {
            bgToggleEl.addEventListener('click', () => setBackgroundEnabled(!backgroundEnabled));
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
        isMusicMuted:         isMusicMuted,
        isSfxMuted:           isSfxMuted,
        getMusicVolume:       getMusicVolume,
        getSfxVolume:         getSfxVolume,
        isBackgroundEnabled:  isBackgroundEnabled,
        setMusicMuted:        setMusicMuted,
        setSfxMuted:          setSfxMuted,
        setMusicVolume:       setMusicVolume,
        setSfxVolume:         setSfxVolume,
        setBackgroundEnabled: setBackgroundEnabled,
        open:  open,
        close: close,
    };
})();
