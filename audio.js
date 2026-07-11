// Sound effects for Circuitousness.
//
// Triggers (wired by marathon.js / game.js):
//   new puzzle starts      → cinematic_bass  (Marathon onPuzzleReady + PotD startPuzzle)
//   two paths overlap      → glitch  (looped while the overlap persists)
//   twin twist breaks line → fail | audience_disappointed | audience_gasp
//   completed path broken  → audience_awww (fires on ANY pathsWon true→false,
//                            including own-rotation, twin twist, hint, etc.)
//   join one path of many  → applause
//   puzzle solved          → applause_long
//   game over, no rank     → fail_long | audience_disappointed
//   game over, top-N       → audience_cheer
//   game over, rank #1     → audience_cheer_long
//
// Selection: each TYPE has its own shuffle bag (Fisher-Yates over 1..count).
// Every play() draws the next index from the bag; when the bag is exhausted
// it reshuffles. So no variant of a type repeats until every other variant
// of that type has been played. OR-triggers pick the TYPE uniformly first
// (each named type equally likely regardless of pool size), then draw a
// variant from that type's bag.
//
// Playback: Web Audio API (decoded AudioBuffer + BufferSource). NOT
// <audio> elements — the audio-element path requires every element to be
// "blessed" by a user gesture before .play() will work on iPad Safari,
// and cloning a blessed element doesn't preserve the blessing. Web Audio
// bypasses the gesture restriction entirely once the AudioContext is
// resumed (which we do on first interaction).
//
// MP3 URL: always proxied through the back-end (AppConfig.GAME_API +
// /music/SFX/). Two reasons it's always the proxy, not just on iOS:
//   1. fetch() needs CORS headers to read response bytes for decode;
//      GitHub doesn't set them.
//   2. iOS Safari can't follow GitHub's 302 redirects in audio fetches.
// SFX files are small (a few KB each) so proxy load is negligible.

const Sfx = (function () {
    const BASE_URL = AppConfig.GAME_API + '/music/SFX/';

    // Variant counts per type. Filename pattern: <type>_<1..count>.mp3.
    const POOLS = {
        applause:                4,
        applause_long:           7,
        audience_awww:           6,
        audience_cheer:          5,
        audience_cheer_long:     1,
        audience_disappointed:   3,
        audience_gasp:          10,
        audience_shocked:        8,
        cinematic_bass:         13,
        fail:                   17,
        fail_long:               3,
        glitch:                  6,
        jump_scare:              3,
    };

    let volume = 0.6;
    let muted  = false;
    // Platform-level mute (CrazyGames container mute button, via cg-sdk.js).
    // Not persisted, independent of the player's own SFX setting, and per
    // CG rules it wins over in-game toggles — every play entry point gates
    // on it, so unmuting SFX in Settings can't produce sound while the
    // container is muted. Off-CG nothing ever sets it.
    let externalMuted = false;
    // Sub-mute that gates the audience-flavored SFX only (anything matching
    // audience_* or applause | applause_*). True = play normally; false =
    // play() silently no-ops for those types. Settings module pushes the
    // effective value (false when sfxMuted is true) so Sfx doesn't need
    // to re-check the parent mute setting. Default true so a fresh
    // install hears the full reaction palette.
    let audienceReactionsEnabled = true;
    // Test whether a type belongs to the "audience reactions" category.
    // Anything starting with audience_ (gasp / awww / cheer / etc.) plus
    // applause and applause_long. cinematic_bass, fail*, glitch,
    // jump_scare etc. stay independent of this toggle — those are
    // mechanical cues, not audience reactions.
    function isAudienceReactionType(type) {
        if (!type) return false;
        return type === 'applause'
            || type.indexOf('audience_') === 0
            || type.indexOf('applause_') === 0;
    }

    // Per-type throttle: don't replay an effect of the same type within
    // THROTTLE_MS. Players chaining the same trigger rapidly (twisting
    // twins, joining paths in a sweep, mashing through a solve) would
    // otherwise hear the same exclamation back to back, which gets
    // annoying fast. For OR-triggers the throttle filters the type
    // list — any non-throttled type in the spec can still play.
    const THROTTLE_MS  = 7000;
    const lastPlayedAt = new Map();          // type → ms timestamp
    const warnedUnknownTypes = new Set();    // de-dupe console noise

    // Per-type shuffle bag: { order: [permutation of 1..count], pos: cursor }.
    const bags = {};
    function reshuffle(type) {
        const count = POOLS[type];
        const order = [];
        for (let i = 1; i <= count; i++) order.push(i);
        for (let i = order.length - 1; i > 0; i--) {
            const j   = Math.floor(Math.random() * (i + 1));
            const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
        }
        bags[type] = { order: order, pos: 0 };
    }
    function nextIndex(type) {
        if (!bags[type] || bags[type].pos >= bags[type].order.length) reshuffle(type);
        return bags[type].order[bags[type].pos++];
    }

    // Web Audio context. Created lazily, resumed on first user gesture.
    // Same context drives click(), gateClick(), AND the buffer-source
    // SFX playback below — sharing one context keeps the audio routing
    // sane and is required on iOS (which only allows one context per
    // page, and only after a gesture).
    let audioCtx = null;
    function getAudioCtx() {
        if (audioCtx) return audioCtx;
        try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (Ctor) audioCtx = new Ctor();
        } catch (e) { audioCtx = null; }
        return audioCtx;
    }
    // iOS Safari starts the AudioContext in 'suspended' state and won't
    // play anything until ctx.resume() runs INSIDE a user-gesture handler.
    // Capture the first click/touchend/keydown and resume — once
    // resumed, all later buffer-source plays work without further
    // gesture restrictions.
    let unlocked = false;
    function unlockAudio() {
        if (unlocked) return;
        const ctx = getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(function () {});
        }
        unlocked = true;
    }
    if (typeof document !== 'undefined') {
        // 'contextmenu' included because right-click = CW rotate: on the CG
        // first-visit auto-start a player can right-click tiles for a long
        // while before ever producing a 'click' — their rotate SFX would
        // stay silent until the first left-click unlocked the context.
        ['click', 'contextmenu', 'touchend', 'keydown'].forEach(function (evt) {
            document.addEventListener(evt, unlockAudio, { capture: true });
        });
    }

    // Decoded AudioBuffer cache: 'type/idx' → AudioBuffer. Populated by
    // preloadAll() at module init via fetch + decodeAudioData. A missing
    // entry at play time means the fetch is still in flight — we skip
    // that play silently rather than block.
    const buffers   = new Map();
    const fetching  = new Set();   // 'type/idx' values currently being fetched
    function loadBuffer(type, idx) {
        const key = type + '/' + idx;
        if (buffers.has(key)) return Promise.resolve(buffers.get(key));
        if (fetching.has(key)) return Promise.resolve(null);
        const ctx = getAudioCtx();
        if (!ctx) return Promise.resolve(null);
        fetching.add(key);
        const url = BASE_URL + type + '_' + idx + '.mp3';
        return fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (ab) { return ctx.decodeAudioData(ab); })
            .then(function (buf) {
                buffers.set(key, buf);
                fetching.delete(key);
                return buf;
            })
            .catch(function (e) {
                fetching.delete(key);
                if (typeof Logger !== 'undefined') Logger.warn('Sfx: load failed', key, e.message);
                return null;
            });
    }

    // Active playbacks for ducking: any new play() fades all in-progress
    // SFX down to 0 over FADE_OUT_MS via Web Audio's linearRampToValueAtTime,
    // then stops the source. Keeps overlapping cues from muddying each
    // other — the most recent trigger always reads cleanly. Loop entries
    // also live here; stopLoop fades them via the same path.
    const FADE_OUT_MS = 200;
    const active = new Set();   // entries: { source, gain, loopKey, fadeT }

    function fadeOutEntry(entry) {
        if (entry.fadeT) return;
        const ctx = getAudioCtx();
        if (!ctx) {
            active.delete(entry);
            return;
        }
        const t0 = ctx.currentTime;
        // cancelScheduledValues drops any pending automation (e.g. an
        // earlier fade-in ramp); setValueAtTime then anchors the current
        // gain so the ramp starts from there (not from the original
        // target).
        try {
            entry.gain.gain.cancelScheduledValues(t0);
            entry.gain.gain.setValueAtTime(entry.gain.gain.value, t0);
            entry.gain.gain.linearRampToValueAtTime(0, t0 + FADE_OUT_MS / 1000);
        } catch (e) {}
        entry.fadeT = setTimeout(function () {
            try { entry.source.stop(); } catch (e) {}
            active.delete(entry);
        }, FADE_OUT_MS);
    }
    function fadeOutAll() {
        for (const entry of active) fadeOutEntry(entry);
    }
    // Public-API variant: fade only the one-shot entries (those without
    // a loopKey). Leaves sustained loops alone — relevant when a
    // transition wants to silence celebratory cues like audience_cheer
    // / applause_long but shouldn't kill the glitch_overlap loop that
    // signals an ongoing path-crossing state.
    function fadeOneShots() {
        for (const entry of active) {
            if (!entry.loopKey) fadeOutEntry(entry);
        }
    }

    // Internal one-shot start. Handles both regular plays and looped
    // plays (opts.loop=true sets source.loop, opts.loopKey tracks it
    // in `loops` so stopLoop can find it). Returns the entry object
    // (or null if buffer wasn't ready, audio context is unavailable,
    // etc.) — callers shouldn't depend on a specific shape beyond
    // "truthy means playback started."
    function startSource(type, idx, opts) {
        const ctx = getAudioCtx();
        if (!ctx) return null;
        const buf = buffers.get(type + '/' + idx);
        if (!buf) return null;
        fadeOutAll();
        const source = ctx.createBufferSource();
        source.buffer = buf;
        if (opts && opts.loop) source.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        source.connect(gain).connect(ctx.destination);
        const entry = { source: source, gain: gain, fadeT: null, loopKey: (opts && opts.loopKey) || null };
        source.onended = function () {
            if (entry.fadeT) { clearTimeout(entry.fadeT); entry.fadeT = null; }
            active.delete(entry);
            // Only clear the loops slot if WE still own it. A stale entry
            // that's finishing its fade-out must not evict a newer loop
            // that re-claimed the same key (e.g. glitch_overlap toggling
            // off→on faster than FADE_OUT_MS) — otherwise the new loop is
            // orphaned: audible but untracked, so stopLoop can never find
            // it and it plays forever.
            if (entry.loopKey && loops.get(entry.loopKey) === entry) {
                loops.delete(entry.loopKey);
            }
        };
        active.add(entry);
        try { source.start(0); } catch (e) {
            active.delete(entry);
            return null;
        }
        return entry;
    }

    // Fire-and-forget play. Returns the entry (truthy) on successful
    // start, null otherwise — callers historically depended only on
    // null-vs-truthy so the shape change from HTMLAudioElement to entry
    // object is invisible to them.
    //
    // Throttling (universal rule): filter the spec's types to those that
    // (a) exist in POOLS and (b) haven't played in the last THROTTLE_MS.
    // Pick uniformly among the survivors; if all are throttled, play
    // nothing. The bag position is only advanced for the type that
    // actually plays — throttled types don't burn through their shuffle.
    function play(spec, skipThrottle) {
        if (muted || externalMuted) return null;
        const allTypes = Array.isArray(spec) ? spec : [spec];
        const now = Date.now();
        const eligible = [];
        for (const t of allTypes) {
            if (!POOLS[t]) {
                if (!warnedUnknownTypes.has(t)) {
                    warnedUnknownTypes.add(t);
                    if (typeof Logger !== 'undefined') Logger.warn('Sfx: unknown type', t);
                }
                continue;
            }
            // Audience-reactions sub-mute filter. When disabled, every
            // audience_* / applause / applause_long type drops out of the
            // OR-pool. Mechanical cues (cinematic_bass, fail, glitch,
            // jump_scare, etc.) are unaffected.
            if (!audienceReactionsEnabled && isAudienceReactionType(t)) continue;
            if (!skipThrottle) {
                const last = lastPlayedAt.get(t) || 0;
                if (now - last < THROTTLE_MS) continue;
            }
            eligible.push(t);
        }
        if (eligible.length === 0) return null;
        const type = eligible[Math.floor(Math.random() * eligible.length)];
        const idx  = nextIndex(type);
        const entry = startSource(type, idx, null);
        if (entry) lastPlayedAt.set(type, now);
        // If the buffer wasn't ready yet, kick a load so a subsequent
        // play of the same variant succeeds. The just-attempted play
        // is silently dropped — no synchronous wait.
        if (!entry && !buffers.has(type + '/' + idx)) loadBuffer(type, idx);
        return entry;
    }

    // Looped play: picks one variant from `spec`'s shuffle bag and repeats
    // THAT variant via BufferSource.loop=true until stopLoop(key) fires.
    // Each fresh playLoop() call draws a new variant.
    const loops = new Map();   // key → entry from startSource
    function playLoop(key, spec) {
        if (loops.has(key)) return;
        if (muted || externalMuted) return;
        const allTypes = Array.isArray(spec) ? spec : [spec];
        // Loops are sustained state indicators (e.g. the path-overlap
        // glitch) — they should fire whenever the state re-enters,
        // even within the per-type throttle window. Don't filter by
        // throttle, just by validity.
        const valid = allTypes.filter(function (t) { return !!POOLS[t]; });
        if (valid.length === 0) return;
        const type = valid[Math.floor(Math.random() * valid.length)];
        const idx  = nextIndex(type);
        const entry = startSource(type, idx, { loop: true, loopKey: key });
        if (entry) loops.set(key, entry);
        else if (!buffers.has(type + '/' + idx)) loadBuffer(type, idx);
    }
    function stopLoop(key) {
        const entry = loops.get(key);
        if (!entry) return;
        // Fade out for a smooth stop instead of an abrupt cut — same
        // ducking pathway play() uses when a new sound interrupts.
        fadeOutEntry(entry);
        loops.delete(key);
    }
    function stopAllLoops() {
        const keys = Array.from(loops.keys());
        for (const k of keys) stopLoop(k);
    }

    // Synthesized rotation click — short filtered-noise burst via Web Audio.
    // No asset to load. Bypasses the ducking pipeline (active set / fade-out)
    // because the click is so brief and quiet that mixing it with whatever
    // else is playing reads cleaner than fading the louder cue down for it.
    // Slight per-call jitter on the filter cutoff keeps consecutive clicks
    // from sounding mechanically identical.
    const CLICK_VOLUME    = 0.18;   // relative to master `volume`
    const CLICK_DURATION  = 0.03;   // seconds
    function click() {
        if (muted || externalMuted) return;
        const ctx = getAudioCtx();
        if (!ctx) return;
        // Generate a one-shot white-noise buffer the length of the click.
        const len    = Math.max(1, Math.floor(ctx.sampleRate * CLICK_DURATION));
        const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const data   = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src    = ctx.createBufferSource();
        src.buffer   = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type  = 'lowpass';
        filter.frequency.value = 3000 + Math.random() * 1500;  // 3.0 – 4.5 kHz
        const gain   = ctx.createGain();
        const peak   = volume * CLICK_VOLUME;
        const t0     = ctx.currentTime;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + 0.001);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + CLICK_DURATION);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(t0);
        src.stop(t0 + CLICK_DURATION + 0.01);
    }

    // Gate-rotation click — same noise-burst family as click() so the two
    // feel related, but distinctly "thockier": bandpass with a narrow Q at
    // a lower center frequency gives a tonal mechanical resonance instead
    // of the tile click's soft lowpass tap, and double the duration with
    // a slightly higher peak reads as a heavier, more deliberate action
    // (which a gate rotation is — it cascades through every gate at once).
    // Like click(), this bypasses the play() ducking/throttle pipeline.
    const GATE_CLICK_VOLUME   = 0.22;
    const GATE_CLICK_DURATION = 0.06;
    function gateClick() {
        if (muted || externalMuted) return;
        const ctx = getAudioCtx();
        if (!ctx) return;
        const len    = Math.max(1, Math.floor(ctx.sampleRate * GATE_CLICK_DURATION));
        const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
        const data   = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src    = ctx.createBufferSource();
        src.buffer   = buffer;
        const filter = ctx.createBiquadFilter();
        filter.type  = 'bandpass';
        filter.Q.value = 4;
        filter.frequency.value = 600 + Math.random() * 250;  // 0.6 – 0.85 kHz
        const gain   = ctx.createGain();
        const peak   = volume * GATE_CLICK_VOLUME;
        const t0     = ctx.currentTime;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(peak, t0 + 0.001);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + GATE_CLICK_DURATION);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(t0);
        src.stop(t0 + GATE_CLICK_DURATION + 0.01);
    }

    function setVolume(v) { volume = Math.max(0, Math.min(1, v)); }
    function setMuted(b)  {
        muted = !!b;
        if (muted) stopAllLoops();
    }
    // True when the player CAN'T hear SFX for any reason — their own
    // setting OR the platform mute. For "was audio audible" questions
    // (solve-audio stats); isMuted() stays the player's-own-setting
    // predicate.
    function isEffectivelyMuted() { return muted || externalMuted; }
    // CrazyGames container mute (see externalMuted above). Mirrors
    // setMuted's loop handling and additionally fades in-flight one-shots
    // so the mute lands immediately, not at the next cue. Loops don't
    // auto-resume on unmute — same semantics as the in-game SFX toggle,
    // and the loop re-fires when its game state next re-enters.
    function setExternalMuted(b) {
        externalMuted = !!b;
        if (externalMuted) {
            stopAllLoops();
            fadeOneShots();
        }
    }
    function setAudienceReactionsEnabled(b) {
        audienceReactionsEnabled = !!b;
    }

    // Eager preload: kicks off fetches+decodes for every variant at
    // module init so the first play doesn't pay a network round-trip
    // (the symptom was a noticeable lag between puzzle-show and
    // cinematic_bass). cinematic_bass first because it plays on every
    // puzzle start; applause_long next because it plays on every solve.
    // Everything else trails in POOLS order.
    const PRELOAD_FIRST = ['cinematic_bass', 'applause_long'];
    function preloadType(type) {
        const count = POOLS[type];
        if (!count) return;
        for (let idx = 1; idx <= count; idx++) {
            loadBuffer(type, idx);
        }
    }
    function preloadAll() {
        const done = new Set();
        for (const t of PRELOAD_FIRST) { preloadType(t); done.add(t); }
        for (const t of Object.keys(POOLS)) if (!done.has(t)) preloadType(t);
    }
    // Wait for the AudioContext to exist before preloading — decodeAudioData
    // is a method on the context. getAudioCtx() creates it lazily, so a
    // single call from here is sufficient; preload kicks off immediately.
    if (getAudioCtx()) preloadAll();

    return {
        play: play,
        playLoop: playLoop,
        stopLoop: stopLoop,
        stopAllLoops: stopAllLoops,
        // Fade out every one-shot currently in `active` (skips loops).
        // Used by Music's playSong + the menu/leaderboard exit paths so
        // a lingering audience_cheer doesn't bleed into the next song
        // or the main menu.
        fadeOneShots: fadeOneShots,
        click: click,
        gateClick: gateClick,
        setVolume: setVolume,
        setMuted: setMuted,
        setExternalMuted: setExternalMuted,
        isEffectivelyMuted: isEffectivelyMuted,
        // Read-back for the solve-audio tracking stat (mirrors Music.isMuted).
        isMuted: function () { return muted; },
        setAudienceReactionsEnabled: setAudienceReactionsEnabled,
    };
})();
