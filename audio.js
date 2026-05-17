// Sound effects for Circuitousness.
//
// Triggers (wired by marathon.js / game.js):
//   new puzzle starts      → cinematic_bass
//   two paths overlap      → glitch  (looped while the overlap persists)
//   twin twist breaks line → fail | audience_boo | audience_disappointed | audience_gasp
//   join one path of many  → applause
//   puzzle solved          → applause_long
//   game over, no rank     → fail_long | audience_boo | audience_disappointed
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
// All MP3s live in a single GitHub release; filenames are <type>_<N>.mp3.
// Direct URLs work on desktop + Android. iPad Safari can't follow GitHub's
// 302 redirects in <audio> elements — mirror via the back-end if/when iOS
// support is needed.

const Sfx = (function () {
    const BASE_URL = 'https://github.com/crdeardorff74-commits/circuitousness-front-end/releases/download/SFX/';

    // Variant counts per type. Filename pattern: <type>_<1..count>.mp3.
    const POOLS = {
        applause:                5,
        applause_long:           7,
        audience_boo:            3,
        audience_cheer:          5,
        audience_cheer_long:     1,
        audience_disappointed:   3,
        audience_gasp:          10,
        audience_shocked:        8,
        cinematic_bass:         13,
        fail:                   17,
        fail_long:               3,
        glitch:                  7,
        jump_scare:              3,
    };

    let volume = 0.6;
    let muted  = false;

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

    // Lazy-load + cache one Audio per variant; clone on play so overlapping
    // triggers don't restart the cached element mid-playback.
    const cache = new Map();   // 'type/idx' → HTMLAudioElement template
    function getTemplate(type, idx) {
        const key = type + '/' + idx;
        let a = cache.get(key);
        if (!a) {
            a         = new Audio(BASE_URL + type + '_' + idx + '.mp3');
            a.preload = 'auto';
            cache.set(key, a);
        }
        return a;
    }

    // Resolve a trigger spec (string OR array of strings) to one concrete pick.
    function pickVariant(spec) {
        const types = Array.isArray(spec) ? spec : [spec];
        const type  = types[Math.floor(Math.random() * types.length)];
        if (!POOLS[type]) {
            if (typeof Logger !== 'undefined') Logger.warn('Sfx: unknown type', type);
            return null;
        }
        return { type: type, idx: nextIndex(type) };
    }

    // Ducking: any new play() fades whatever is currently playing down to 0
    // over FADE_OUT_MS, then pauses it. Keeps overlapping cues from
    // muddying each other — the most recent trigger always reads cleanly.
    // Natural end-of-clip removes the entry first, so loop chains that
    // hand off via 'ended' don't fade themselves out.
    const FADE_OUT_MS  = 200;
    const FADE_STEP_MS = 20;
    const active = new Set();  // entries: { audio, fadeInterval, onEnded }

    function fadeOutEntry(entry) {
        if (entry.fadeInterval) return;
        const startVol  = entry.audio.volume;
        const startTime = Date.now();
        entry.fadeInterval = setInterval(function () {
            const t = Math.min(1, (Date.now() - startTime) / FADE_OUT_MS);
            entry.audio.volume = Math.max(0, startVol * (1 - t));
            if (t >= 1) {
                clearInterval(entry.fadeInterval);
                entry.fadeInterval = null;
                try { entry.audio.pause(); } catch (e) {}
                entry.audio.removeEventListener('ended', entry.onEnded);
                active.delete(entry);
            }
        }, FADE_STEP_MS);
    }
    function fadeOutAll() {
        for (const entry of active) fadeOutEntry(entry);
    }

    // Fire-and-forget play. Returns the live element so callers can attach
    // listeners or stop it early (used by playLoop for chaining).
    function play(spec) {
        if (muted) return null;
        const pick = pickVariant(spec);
        if (!pick) return null;
        fadeOutAll();
        const tmpl = getTemplate(pick.type, pick.idx);
        const a    = tmpl.cloneNode();
        a.volume   = volume;
        const entry = { audio: a, fadeInterval: null, onEnded: null };
        entry.onEnded = function () {
            if (entry.fadeInterval) {
                clearInterval(entry.fadeInterval);
                entry.fadeInterval = null;
            }
            active.delete(entry);
        };
        active.add(entry);
        a.addEventListener('ended', entry.onEnded, { once: true });
        const p = a.play();
        if (p && p.catch) {
            p.catch(function (err) {
                if (typeof Logger !== 'undefined') Logger.warn('Sfx: play failed', pick.type, pick.idx, err);
                a.removeEventListener('ended', entry.onEnded);
                active.delete(entry);
            });
        }
        return a;
    }

    // Looped play: picks one variant from `spec`'s shuffle bag and repeats
    // THAT variant via HTMLAudioElement.loop until stopLoop(key) fires.
    // (Earlier version chained through the pool — corrected after feedback
    // that the overlap glitch should be a single repeating cue, not a
    // rotating one.) Each fresh playLoop() call draws a new variant.
    const loops = new Map();   // key → { currentAudio }
    function playLoop(key, spec) {
        if (loops.has(key)) return;
        const a = play(spec);
        if (!a) return;
        a.loop = true;
        loops.set(key, { currentAudio: a });
    }
    function stopLoop(key) {
        const state = loops.get(key);
        if (!state) return;
        if (state.currentAudio) {
            // Fade out for a smooth stop instead of an abrupt cut — same
            // ducking pathway play() uses when a new sound interrupts.
            for (const entry of active) {
                if (entry.audio === state.currentAudio) { fadeOutEntry(entry); break; }
            }
        }
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
    let audioCtx = null;
    function getAudioCtx() {
        if (audioCtx) return audioCtx;
        try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (Ctor) audioCtx = new Ctor();
        } catch (e) { audioCtx = null; }
        return audioCtx;
    }
    function click() {
        if (muted) return;
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

    function setVolume(v) { volume = Math.max(0, Math.min(1, v)); }
    function setMuted(b)  {
        muted = !!b;
        if (muted) stopAllLoops();
    }

    // Eager preload: kicks off fetches for every variant at module init so
    // the first play doesn't pay a network round-trip (the symptom was a
    // noticeable lag between puzzle-show and cinematic_bass). Browsers cap
    // concurrent connections per origin (~6) so this queues — order matters
    // for the ones that fire earliest in a session. cinematic_bass first
    // because it plays on every puzzle start; applause_long next because
    // it plays on every solve. Everything else trails in POOLS order.
    // `audio.load()` is necessary on top of preload='auto' because browsers
    // (especially mobile) frequently ignore the attribute as a hint.
    const PRELOAD_FIRST = ['cinematic_bass', 'applause_long'];
    function preloadType(type) {
        const count = POOLS[type];
        if (!count) return;
        for (let idx = 1; idx <= count; idx++) {
            const a = getTemplate(type, idx);
            try { a.load(); } catch (e) {}
        }
    }
    function preloadAll() {
        const done = new Set();
        for (const t of PRELOAD_FIRST) { preloadType(t); done.add(t); }
        for (const t of Object.keys(POOLS)) if (!done.has(t)) preloadType(t);
    }
    preloadAll();

    return {
        play: play,
        playLoop: playLoop,
        stopLoop: stopLoop,
        stopAllLoops: stopAllLoops,
        click: click,
        setVolume: setVolume,
        setMuted: setMuted,
    };
})();
