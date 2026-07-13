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
    const MUSIC_MODE_KEY  = PROJECT_SLUG + '_setting_musicMode';
    const MUSIC_PRIOR_KEY = PROJECT_SLUG + '_setting_musicPriorMode';
    const SFX_MUTED_KEY   = PROJECT_SLUG + '_setting_sfxMuted';
    // Sub-mute that gates ONLY the audience-flavored SFX (anything starting
    // with `audience_` or `applause`/`applause_long`). When false, the
    // celebratory/dismay reactions stay quiet but the mechanical cues
    // (cinematic_bass on puzzle start, fail/gasp on twin-twist surprise,
    // glitch_overlap on path crossing, jump_scare on hint) still play.
    // Forced off (UI grayed out, effective value = false) when sfxMuted
    // is true — there's no audible difference, so we mirror that state.
    const AUDIENCE_REACTIONS_KEY = PROJECT_SLUG + '_setting_audienceReactions';
    const MUSIC_VOL_KEY   = PROJECT_SLUG + '_setting_musicVolume';
    // Limits music picks to songs the admin flagged `instrumental` (no
    // lyrics). music.js also bootstrap-reads this key directly (covers
    // picks before init() runs) but Settings owns all writes to it.
    const INSTRUMENTAL_KEY = PROJECT_SLUG + '_setting_musicInstrumentalOnly';
    const SFX_VOL_KEY     = PROJECT_SLUG + '_setting_sfxVolume';
    const BG_ENABLED_KEY  = PROJECT_SLUG + '_setting_backgroundEnabled';
    // Visual tuning — mirrors the render.js defaults. Defaults must stay
    // in sync with render.js / index.html debug-slider defaults so the
    // first-paint visuals match the persisted state on fresh installs.
    const TILE_COLOR_KEY  = PROJECT_SLUG + '_setting_tileColor';
    const TILE_FACE_KEY   = PROJECT_SLUG + '_setting_tileFaceOpacity';
    const PATH_COLOR_KEY  = PROJECT_SLUG + '_setting_pathColor';
    const PATH_ALPHA_KEY  = PROJECT_SLUG + '_setting_pathOpacity';
    const PATH_WIDTH_KEY  = PROJECT_SLUG + '_setting_pathWidth';
    const BEVEL_KEY       = PROJECT_SLUG + '_setting_bevelThickness';
    const DEF_TILE_COLOR  = '#153050';
    const DEF_TILE_FACE   = 0.80;
    const DEF_PATH_COLOR  = '#ff2424';
    const DEF_PATH_ALPHA  = 0.11;
    const DEF_PATH_WIDTH  = 0.18;
    const DEF_BEVEL       = 0.07;

    // Valid music modes (mirrors the dropdown options + Music.setMode).
    // 'none' doubles as mute — when selected, audio is paused.
    const MUSIC_MODES = ['none', 'game_playlist', 'credits', 'game_plus_credits'];

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
    function loadEnum(key, allowed, defaultVal) {
        try {
            const v = localStorage.getItem(key);
            if (v !== null && allowed.indexOf(v) !== -1) return v;
        } catch (e) {}
        return defaultVal;
    }
    function storeString(key, v) {
        try { localStorage.setItem(key, String(v)); } catch (e) {}
    }

    // musicMode is the source of truth for playback mode and mute state
    // (mode='none' === muted). Legacy MUSIC_MUTED_KEY is honored on first
    // boot — if the player had toggled mute under the old single-toggle
    // scheme, treat it as mode='none' so their preference carries forward.
    let musicMode = loadEnum(MUSIC_MODE_KEY, MUSIC_MODES, null);
    if (musicMode === null) {
        const legacyMuted = loadBool(MUSIC_MUTED_KEY, false);
        musicMode = legacyMuted ? 'none' : 'game_playlist';
    }
    // priorMode = the last non-none mode the player chose. The mute button
    // toggles between 'none' and this; the dropdown defaults to this when
    // unmuting. Without it, unmuting from a 'credits' or 'game_plus_credits'
    // selection would silently revert to 'game_playlist'.
    let priorMode = loadEnum(MUSIC_PRIOR_KEY, MUSIC_MODES.filter(m => m !== 'none'), 'game_playlist');
    if (musicMode !== 'none') priorMode = musicMode;

    let sfxMuted          = loadBool(SFX_MUTED_KEY,   false);
    let audienceReactions = loadBool(AUDIENCE_REACTIONS_KEY, true);
    // Default volumes: music slightly below full so peaks have headroom on
    // built-in laptop/phone speakers; SFX noticeably lower so the puzzle
    // cues (cinematic_bass, applause, fail) don't overpower a song playing
    // underneath. Players can adjust both via the Settings popup sliders.
    let musicVolume       = loadFloat(MUSIC_VOL_KEY,  0.88);
    let sfxVolume         = loadFloat(SFX_VOL_KEY,    0.42);
    let instrumentalOnly  = loadBool(INSTRUMENTAL_KEY, false);
    let backgroundEnabled = loadBool(BG_ENABLED_KEY,  true);
    // Visual tuning state — read once at boot, pushed into Render in init().
    function loadHexColor(key, defaultVal) {
        try {
            const v = localStorage.getItem(key);
            if (v && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
        } catch (e) {}
        return defaultVal;
    }
    let tileColor        = loadHexColor(TILE_COLOR_KEY, DEF_TILE_COLOR);
    let tileFaceOpacity  = loadFloat(TILE_FACE_KEY,  DEF_TILE_FACE);
    let pathColor        = loadHexColor(PATH_COLOR_KEY, DEF_PATH_COLOR);
    let pathOpacity      = loadFloat(PATH_ALPHA_KEY, DEF_PATH_ALPHA);
    let pathWidth        = loadFloat(PATH_WIDTH_KEY, DEF_PATH_WIDTH);
    let bevelThickness   = loadFloat(BEVEL_KEY,      DEF_BEVEL);

    function isMusicMuted()       { return musicMode === 'none'; }
    function getMusicMode()       { return musicMode; }
    function isSfxMuted()         { return sfxMuted; }
    function getMusicVolume()     { return musicVolume; }
    function getSfxVolume()       { return sfxVolume; }
    function isBackgroundEnabled(){ return backgroundEnabled; }
    // Persisted user preference for audience reactions. Returns the raw
    // stored value — DOESN'T short-circuit on sfxMuted; callers that
    // want the "effective" enabled state (false when SFX is muted)
    // use isAudienceReactionsEffective() below. The raw getter is for
    // the UI toggle's checked state — when SFX is later unmuted, the
    // user expects their preference to be remembered as it was.
    function isAudienceReactionsEnabled() { return audienceReactions; }
    function isAudienceReactionsEffective() { return !sfxMuted && audienceReactions; }
    function isInstrumentalOnly() { return instrumentalOnly; }

    function setMusicMode(mode) {
        if (MUSIC_MODES.indexOf(mode) === -1) return;
        if (musicMode === mode) return;
        musicMode = mode;
        if (mode !== 'none') priorMode = mode;
        storeString(MUSIC_MODE_KEY, musicMode);
        storeString(MUSIC_PRIOR_KEY, priorMode);
        // Legacy key tracks mute state so older code paths (if any) still see
        // consistent values. Removable once nothing reads MUSIC_MUTED_KEY.
        storeBool(MUSIC_MUTED_KEY, musicMode === 'none');
        if (typeof Music !== 'undefined') {
            if (Music.setMode)  Music.setMode(musicMode === 'none' ? priorMode : musicMode);
            if (Music.setMuted) Music.setMuted(musicMode === 'none');
        }
        syncToggleUI();
    }
    // Back-compat shim — mute toggle routes through setMusicMode. Muting
    // remembers the prior mode so unmuting restores the player's choice
    // (credits, game_plus_credits) instead of silently reverting to default.
    function setMusicMuted(v) {
        if (v) setMusicMode('none');
        else   setMusicMode(priorMode || 'game_playlist');
    }
    function setSfxMuted(v) {
        sfxMuted = !!v;
        storeBool(SFX_MUTED_KEY, sfxMuted);
        if (typeof Sfx !== 'undefined' && Sfx.setMuted) Sfx.setMuted(sfxMuted);
        // SFX mute also gates the audience-reactions sub-toggle: the
        // EFFECTIVE state (used by Sfx.play to filter audience_*/applause_*)
        // is (!sfxMuted && audienceReactions). Push that re-resolved value
        // to Sfx so the filter tracks the SFX-mute change without needing
        // the user to also toggle audience-reactions explicitly. UI sync
        // below also grays out the audience-reactions row when sfxMuted.
        if (typeof Sfx !== 'undefined' && Sfx.setAudienceReactionsEnabled) {
            Sfx.setAudienceReactionsEnabled(isAudienceReactionsEffective());
        }
        syncToggleUI();
    }
    function setAudienceReactionsEnabled(v) {
        audienceReactions = !!v;
        storeBool(AUDIENCE_REACTIONS_KEY, audienceReactions);
        if (typeof Sfx !== 'undefined' && Sfx.setAudienceReactionsEnabled) {
            Sfx.setAudienceReactionsEnabled(isAudienceReactionsEffective());
        }
        syncToggleUI();
    }
    function setInstrumentalOnly(v) {
        instrumentalOnly = !!v;
        storeBool(INSTRUMENTAL_KEY, instrumentalOnly);
        if (typeof Music !== 'undefined' && Music.setInstrumentalOnly) {
            Music.setInstrumentalOnly(instrumentalOnly);
        }
        syncToggleUI();
    }
    function setMusicVolume(v) {
        musicVolume = Math.max(0, Math.min(1, +v || 0));
        storeFloat(MUSIC_VOL_KEY, musicVolume);
        if (typeof Music !== 'undefined' && Music.setVolume) Music.setVolume(musicVolume);
        if (musicVolPctEl) musicVolPctEl.textContent = Math.round(musicVolume * 100) + '%';
    }
    function setSfxVolume(v) {
        sfxVolume = Math.max(0, Math.min(1, +v || 0));
        storeFloat(SFX_VOL_KEY, sfxVolume);
        if (typeof Sfx !== 'undefined' && Sfx.setVolume) Sfx.setVolume(sfxVolume);
        if (sfxVolPctEl) sfxVolPctEl.textContent = Math.round(sfxVolume * 100) + '%';
    }
    function setBackgroundEnabled(v) {
        backgroundEnabled = !!v;
        storeBool(BG_ENABLED_KEY, backgroundEnabled);
        if (typeof Render !== 'undefined' && Render.setBackgroundEnabled) {
            Render.setBackgroundEnabled(backgroundEnabled);
        }
        syncToggleUI();
    }
    // --- Visual tuning getters/setters ---
    // Each setter persists + pushes to Render so the live canvas updates
    // immediately as the player drags a slider or opens the color picker.
    function getTileColor()        { return tileColor; }
    function getTileFaceOpacity()  { return tileFaceOpacity; }
    function getPathColor()        { return pathColor; }
    function getPathOpacity()      { return pathOpacity; }
    function getPathWidth()        { return pathWidth; }
    function getBevelThickness()   { return bevelThickness; }
    function setTileColor(v) {
        if (!/^#[0-9a-fA-F]{6}$/.test(v || '')) return;
        tileColor = v;
        storeString(TILE_COLOR_KEY, v);
        if (typeof Render !== 'undefined' && Render.setTileColor) Render.setTileColor(v);
    }
    function setPathColor(v) {
        if (!/^#[0-9a-fA-F]{6}$/.test(v || '')) return;
        pathColor = v;
        storeString(PATH_COLOR_KEY, v);
        if (typeof Render !== 'undefined' && Render.setPathColor) Render.setPathColor(v);
    }
    function setTileFaceOpacity(v) {
        tileFaceOpacity = Math.max(0, Math.min(1, +v || 0));
        storeFloat(TILE_FACE_KEY, tileFaceOpacity);
        if (typeof Render !== 'undefined' && Render.setTileFaceAlpha) Render.setTileFaceAlpha(tileFaceOpacity);
        if (tileFacePctEl) tileFacePctEl.textContent = Math.round(tileFaceOpacity * 100) + '%';
    }
    function setPathOpacity(v) {
        pathOpacity = Math.max(0, Math.min(1, +v || 0));
        storeFloat(PATH_ALPHA_KEY, pathOpacity);
        if (typeof Render !== 'undefined' && Render.setPathOpacity) Render.setPathOpacity(pathOpacity);
        if (pathAlphaPctEl) pathAlphaPctEl.textContent = Math.round(pathOpacity * 100) + '%';
    }
    function setPathWidth(v) {
        pathWidth = Math.max(0, Math.min(1, +v || 0));
        storeFloat(PATH_WIDTH_KEY, pathWidth);
        if (typeof Render !== 'undefined' && Render.setPathWidth) Render.setPathWidth(pathWidth);
        if (pathWidthPctEl) pathWidthPctEl.textContent = pathWidth.toFixed(2);
    }
    function setBevelThickness(v) {
        bevelThickness = Math.max(0, Math.min(1, +v || 0));
        storeFloat(BEVEL_KEY, bevelThickness);
        if (typeof Render !== 'undefined' && Render.setBevelThickness) Render.setBevelThickness(bevelThickness);
        if (bevelPctEl) bevelPctEl.textContent = bevelThickness.toFixed(2);
    }
    // Reset the 5 visual settings back to the DEF_* constants at top of
    // file. Each setter handles persistence + Render push + display update,
    // so this is just a thin orchestrator. Sliders re-sync via syncVisualUI
    // at the end so their thumb positions catch up to the new values.
    function resetVisualsToDefaults() {
        setTileColor(DEF_TILE_COLOR);
        setTileFaceOpacity(DEF_TILE_FACE);
        setPathColor(DEF_PATH_COLOR);
        setPathOpacity(DEF_PATH_ALPHA);
        setPathWidth(DEF_PATH_WIDTH);
        setBevelThickness(DEF_BEVEL);
        syncVisualUI();
    }

    // DOM refs. The mute-button-as-speaker pattern is lifted from TANTЯO;
    // the music playlist dropdown drives playMode (none / game playlist /
    // credits / game playlist + credits).
    let musicPlaylistEl, musicMuteBtnEl, sfxMuteBtnEl, bgToggleEl, audienceToggleEl, audienceRowEl;
    let instrumentalToggleEl, instrumentalRowEl;
    let musicVolEl, sfxVolEl, musicVolPctEl, sfxVolPctEl;
    let tileColorEl, tileFaceEl, pathColorEl, pathAlphaEl, pathWidthEl, bevelEl;
    let tileFacePctEl, pathAlphaPctEl, pathWidthPctEl, bevelPctEl;
    let resetVisualsBtnEl;
    let overlayEl, closeBtnEl;
    // Both DOM triggers route here: #settingsBtn (menu top-right) and
    // #hudSettingsBtn (in the in-game HUD, just left of QUIT).
    let openBtnEls = [];
    function syncToggleUI() {
        const muted = (musicMode === 'none');
        if (musicMuteBtnEl) {
            musicMuteBtnEl.textContent = muted ? '🔇' : '🔊';
            musicMuteBtnEl.classList.toggle('muted', muted);
        }
        if (sfxMuteBtnEl) {
            sfxMuteBtnEl.textContent = sfxMuted ? '🔇' : '🔊';
            sfxMuteBtnEl.classList.toggle('muted', sfxMuted);
        }
        if (musicPlaylistEl) {
            musicPlaylistEl.value = musicMode;
        }
        if (bgToggleEl) bgToggleEl.setAttribute('aria-checked', backgroundEnabled ? 'true' : 'false');
        // Audience reactions toggle: aria-checked reflects the raw stored
        // preference (so toggling SFX mute off later restores the user's
        // visible setting). The row gets a .disabled class when SFX is
        // muted — styles.css fades it + the CSS pointer-events:none on
        // .disabled stops clicks. The toggle's own click handler also
        // bails when sfxMuted as belt-and-braces.
        if (audienceToggleEl) audienceToggleEl.setAttribute('aria-checked', audienceReactions ? 'true' : 'false');
        if (audienceRowEl) audienceRowEl.classList.toggle('disabled', sfxMuted);
        if (instrumentalToggleEl) instrumentalToggleEl.setAttribute('aria-checked', instrumentalOnly ? 'true' : 'false');
        // Instrumental Only is moot when the selected mode includes the End
        // Credits pool (all-lyrics): gray the row out. aria-checked keeps
        // the raw stored preference so switching back restores the user's
        // visible setting; music.js independently ignores the flag in
        // credits-including modes.
        if (instrumentalRowEl) {
            instrumentalRowEl.classList.toggle('disabled',
                musicMode === 'credits' || musicMode === 'game_plus_credits');
        }
    }
    function syncVolumeUI() {
        if (musicVolEl)    musicVolEl.value    = Math.round(musicVolume * 100);
        if (sfxVolEl)      sfxVolEl.value      = Math.round(sfxVolume * 100);
        if (musicVolPctEl) musicVolPctEl.textContent = Math.round(musicVolume * 100) + '%';
        if (sfxVolPctEl)   sfxVolPctEl.textContent   = Math.round(sfxVolume   * 100) + '%';
    }
    function syncVisualUI() {
        if (tileColorEl)    tileColorEl.value    = tileColor;
        if (pathColorEl)    pathColorEl.value    = pathColor;
        // Slider domains mirror the debug-panel sliders in index.html:
        //   tile face / path opacity → 0..100 (pct, ÷100 to get 0..1)
        //   path width                → 5..45 (÷100 to get 0.05..0.45)
        //   bevel thickness           → 1..20 (÷100 to get 0.01..0.20)
        if (tileFaceEl)     tileFaceEl.value     = Math.round(tileFaceOpacity * 100);
        if (pathAlphaEl)    pathAlphaEl.value    = Math.round(pathOpacity * 100);
        if (pathWidthEl)    pathWidthEl.value    = Math.round(pathWidth * 100);
        if (bevelEl)        bevelEl.value        = Math.round(bevelThickness * 100);
        if (tileFacePctEl)  tileFacePctEl.textContent  = Math.round(tileFaceOpacity * 100) + '%';
        if (pathAlphaPctEl) pathAlphaPctEl.textContent = Math.round(pathOpacity * 100) + '%';
        if (pathWidthPctEl) pathWidthPctEl.textContent = pathWidth.toFixed(2);
        if (bevelPctEl)     bevelPctEl.textContent     = bevelThickness.toFixed(2);
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
        overlayEl        = document.getElementById('settingsOverlay');
        closeBtnEl       = document.getElementById('settingsCloseBtn');
        musicPlaylistEl  = document.getElementById('settingMusicPlaylist');
        musicMuteBtnEl   = document.getElementById('settingMusicMuteBtn');
        sfxMuteBtnEl     = document.getElementById('settingSfxMuteBtn');
        bgToggleEl       = document.getElementById('settingBackground');
        audienceToggleEl = document.getElementById('settingAudienceReactions');
        audienceRowEl    = document.getElementById('settingAudienceReactionsRow');
        instrumentalToggleEl = document.getElementById('settingInstrumentalOnly');
        instrumentalRowEl    = document.getElementById('settingInstrumentalOnlyRow');
        musicVolEl       = document.getElementById('settingMusicVolume');
        sfxVolEl         = document.getElementById('settingSfxVolume');
        musicVolPctEl    = document.getElementById('settingMusicVolumeDisplay');
        sfxVolPctEl      = document.getElementById('settingSfxVolumeDisplay');
        tileColorEl      = document.getElementById('settingTileColor');
        tileFaceEl       = document.getElementById('settingTileFaceOpacity');
        pathColorEl      = document.getElementById('settingPathColor');
        pathAlphaEl      = document.getElementById('settingPathOpacity');
        pathWidthEl      = document.getElementById('settingPathWidth');
        bevelEl          = document.getElementById('settingBevel');
        tileFacePctEl    = document.getElementById('settingTileFaceOpacityDisplay');
        pathAlphaPctEl   = document.getElementById('settingPathOpacityDisplay');
        pathWidthPctEl   = document.getElementById('settingPathWidthDisplay');
        bevelPctEl       = document.getElementById('settingBevelDisplay');
        resetVisualsBtnEl = document.getElementById('settingResetVisuals');
        openBtnEls       = ['settingsBtn', 'hudSettingsBtn']
                              .map((id) => document.getElementById(id))
                              .filter(Boolean);

        // Hand initial mute + volume state to consumers so they boot in
        // the right state, not "audible at default volume until first
        // toggle/slide".
        if (typeof Sfx !== 'undefined') {
            if (Sfx.setVolume) Sfx.setVolume(sfxVolume);
            if (Sfx.setMuted)  Sfx.setMuted(sfxMuted);
            // Push the resolved (sfxMuted-aware) audience-reactions
            // setting so the Sfx filter is correct from the first play(),
            // not just after a settings toggle.
            if (Sfx.setAudienceReactionsEnabled) Sfx.setAudienceReactionsEnabled(isAudienceReactionsEffective());
        }
        if (typeof Music !== 'undefined') {
            if (Music.setVolume) Music.setVolume(musicVolume);
            // Hand the mode straight to Music (priorMode if muted) so the
            // shuffle pool is correct from the first start(). Muting goes
            // through setMuted to keep the audio paused on boot.
            if (Music.setMode)   Music.setMode(musicMode === 'none' ? priorMode : musicMode);
            if (Music.setMuted)  Music.setMuted(musicMode === 'none');
            // music.js bootstrap-reads the same key, so this is normally a
            // no-op — belt-and-braces for ordering edge cases.
            if (Music.setInstrumentalOnly) Music.setInstrumentalOnly(instrumentalOnly);
        }
        // Render reads its own initial bg-enabled flag from Settings in
        // Render.init (so the first paint matches persisted state), but
        // re-push here too as a belt-and-braces for ordering edge cases.
        if (typeof Render !== 'undefined') {
            if (Render.setBackgroundEnabled) Render.setBackgroundEnabled(backgroundEnabled);
            // Visual tuning — push persisted values so the first paint
            // matches the slider positions in the settings UI. Without
            // these, fresh-install defaults match but any persisted
            // overrides would only kick in after the player touched
            // the settings popup.
            if (Render.setTileColor)       Render.setTileColor(tileColor);
            if (Render.setTileFaceAlpha)   Render.setTileFaceAlpha(tileFaceOpacity);
            if (Render.setPathColor)       Render.setPathColor(pathColor);
            if (Render.setPathOpacity)     Render.setPathOpacity(pathOpacity);
            if (Render.setPathWidth)       Render.setPathWidth(pathWidth);
            if (Render.setBevelThickness)  Render.setBevelThickness(bevelThickness);
        }
        syncVolumeUI();
        syncVisualUI();
        syncToggleUI();

        openBtnEls.forEach((el) => el.addEventListener('click', open));
        if (closeBtnEl) closeBtnEl.addEventListener('click', close);
        // Volume sliders — `input` event fires continuously during drag,
        // so the audio reacts in real time. The setter persists every
        // change; rapid drags = many localStorage writes, which is fine
        // (sync, single-key, microseconds).
        if (musicVolEl) musicVolEl.addEventListener('input', () => setMusicVolume(musicVolEl.value / 100));
        if (sfxVolEl)   sfxVolEl.addEventListener('input',   () => setSfxVolume(sfxVolEl.value / 100));
        // Visual tuning sliders + color picker. `input` fires continuously
        // during drag so the canvas updates live (Render setters all call
        // draw() internally), matching the responsiveness of the debug
        // panel's sliders that these are lifted from.
        if (tileColorEl) tileColorEl.addEventListener('input', () => setTileColor(tileColorEl.value));
        if (tileFaceEl)  tileFaceEl.addEventListener('input',  () => setTileFaceOpacity(tileFaceEl.value / 100));
        if (pathColorEl) pathColorEl.addEventListener('input', () => setPathColor(pathColorEl.value));
        if (pathAlphaEl) pathAlphaEl.addEventListener('input', () => setPathOpacity(pathAlphaEl.value / 100));
        if (pathWidthEl) pathWidthEl.addEventListener('input', () => setPathWidth(pathWidthEl.value / 100));
        if (bevelEl)     bevelEl.addEventListener('input',     () => setBevelThickness(bevelEl.value / 100));
        if (resetVisualsBtnEl) resetVisualsBtnEl.addEventListener('click', resetVisualsToDefaults);
        // Click-outside-to-close — only fires when the click lands on the
        // overlay backdrop itself, NOT a child element. Matches TANTЯO's
        // settings overlay UX.
        if (overlayEl) {
            overlayEl.addEventListener('click', (ev) => {
                if (ev.target === overlayEl) close();
            });
        }
        // Mute buttons (TANTЯO-style speaker icon).
        if (musicMuteBtnEl) {
            musicMuteBtnEl.addEventListener('click', () => setMusicMuted(musicMode !== 'none'));
        }
        if (sfxMuteBtnEl) {
            sfxMuteBtnEl.addEventListener('click', () => setSfxMuted(!sfxMuted));
        }
        // Music playlist dropdown — four modes (none / game / credits /
        // game+credits). 'none' doubles as mute; the mute button and this
        // dropdown stay in sync via syncToggleUI.
        if (musicPlaylistEl) {
            musicPlaylistEl.addEventListener('change', () => {
                setMusicMode(musicPlaylistEl.value);
            });
        }
        if (bgToggleEl) {
            bgToggleEl.addEventListener('click', () => setBackgroundEnabled(!backgroundEnabled));
        }
        if (instrumentalToggleEl) {
            instrumentalToggleEl.addEventListener('click', () => {
                // Defensive: refuse the toggle in credits-including modes.
                // The .disabled CSS already blocks pointer-events but a
                // stray keyboard activation would still get through.
                if (musicMode === 'credits' || musicMode === 'game_plus_credits') return;
                setInstrumentalOnly(!instrumentalOnly);
            });
        }
        if (audienceToggleEl) {
            audienceToggleEl.addEventListener('click', () => {
                // Defensive: refuse the toggle when SFX is muted. The
                // .disabled CSS already blocks pointer-events but a stray
                // keyboard activation or programmatic click would still
                // get through without this guard.
                if (sfxMuted) return;
                setAudienceReactionsEnabled(!audienceReactions);
            });
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
        getMusicMode:         getMusicMode,
        isSfxMuted:           isSfxMuted,
        getMusicVolume:       getMusicVolume,
        getSfxVolume:         getSfxVolume,
        isBackgroundEnabled:  isBackgroundEnabled,
        isAudienceReactionsEnabled:   isAudienceReactionsEnabled,
        isAudienceReactionsEffective: isAudienceReactionsEffective,
        isInstrumentalOnly:   isInstrumentalOnly,
        getTileColor:         getTileColor,
        getTileFaceOpacity:   getTileFaceOpacity,
        getPathColor:         getPathColor,
        getPathOpacity:       getPathOpacity,
        getPathWidth:         getPathWidth,
        getBevelThickness:    getBevelThickness,
        setMusicMode:         setMusicMode,
        setMusicMuted:        setMusicMuted,
        setSfxMuted:          setSfxMuted,
        setMusicVolume:       setMusicVolume,
        setSfxVolume:         setSfxVolume,
        setBackgroundEnabled: setBackgroundEnabled,
        setAudienceReactionsEnabled: setAudienceReactionsEnabled,
        setInstrumentalOnly:  setInstrumentalOnly,
        setTileColor:         setTileColor,
        setTileFaceOpacity:   setTileFaceOpacity,
        setPathColor:         setPathColor,
        setPathOpacity:       setPathOpacity,
        setPathWidth:         setPathWidth,
        setBevelThickness:    setBevelThickness,
        resetVisualsToDefaults: resetVisualsToDefaults,
        open:  open,
        close: close,
    };
})();
