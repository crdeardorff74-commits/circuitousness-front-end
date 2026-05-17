// Gameplay music — mirrors TANTЯO's music subsystem at a reduced scope.
//
// One playlist (gameplay), shuffled with avoid-immediate-repeat. Auto-
// advance on `ended`. Start when Marathon enters a game, stop on game over
// / quit. Single reusable HTMLAudioElement, blessed by the first user
// interaction so iOS Safari doesn't block the auto-advance plays.
//
// Mute is wired through the Settings popup (settings.js). When muted, the
// underlying audio is paused — fresh start on unmute (avoids streaming
// silently in the background while the player has it off).
//
// iOS/iPad caveat: <audio> can't follow GitHub's 302 redirects. Desktop
// and Android handle the redirect fine; iOS would need a backend proxy
// (same workaround TANTЯO uses).

const Music = (function () {
    const CACHE_KEY    = PROJECT_SLUG + '_songLibrary_v1';
    const API_URL      = (typeof AppConfig === 'object' && AppConfig && AppConfig.AUTH_API)
                         ? AppConfig.AUTH_API + '/api/songs?game=' + PROJECT_SLUG : null;

    // [{ id, name, url }, ...] — sourced from cache first, then live API.
    let playlist     = [];
    // Indices into playlist, shuffled. Drained one-per-song; refilled when
    // empty so every song plays once per cycle. Last-played tracked so a
    // bag refill doesn't immediately repeat the song that just ended.
    let queue        = [];
    let queuePos     = 0;
    let lastPlayedId = null;

    let audio        = null;   // single reusable HTMLAudioElement
    let shouldPlay   = false;  // true while in a Marathon game session
    let muted        = false;  // mirror of Settings.isMusicMuted()

    // --- Bootstrap from localStorage cache so first-play has something to
    // play even before the API fetch lands. Empty if no prior cache —
    // start() will be a no-op until refreshFromAPI populates the list.
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.songs)) playlist = data.songs;
        }
    } catch (e) {}

    // --- Live refresh from the umbrella API. Non-blocking; cached playlist
    // stays in use until this lands (and beyond, if it fails).
    async function refreshFromAPI() {
        if (!API_URL) return;
        try {
            const resp = await fetch(API_URL);
            if (!resp.ok) return;
            const data = await resp.json();
            const rows = (data && data.lists && Array.isArray(data.lists.gameplay))
                         ? data.lists.gameplay : [];
            // Defensive: don't wipe a populated cache with an empty API
            // response (could be a bad deploy on the admin side).
            if (rows.length === 0) {
                if (typeof Logger !== 'undefined') Logger.warn('Music: API returned no gameplay songs; keeping cached playlist');
                return;
            }
            // Sort by position-then-label so a song marked position=0 in
            // the admin UI always plays first in the shuffle's order.
            // (Shuffle still randomizes, but new playlists with the same
            // membership produce stable bags.)
            rows.sort(function (a, b) {
                const ap = (a.position == null) ? Infinity : a.position;
                const bp = (b.position == null) ? Infinity : b.position;
                if (ap !== bp) return ap - bp;
                return (a.label || '').localeCompare(b.label || '');
            });
            const songs = rows.map(function (r) {
                return { id: r.key, name: r.label, url: MUSIC_BASE_URL + r.filename };
            });
            playlist = songs;
            try { localStorage.setItem(CACHE_KEY, JSON.stringify({ songs: songs })); } catch (e) {}
            // Invalidate any pre-built queue since the membership changed.
            queue = []; queuePos = 0;
        } catch (e) {
            if (typeof Logger !== 'undefined') Logger.warn('Music: API fetch failed; using cached playlist', e);
        }
    }
    refreshFromAPI();

    function ensureAudio() {
        if (audio) return audio;
        audio = new Audio();
        audio.preload = 'auto';
        audio.addEventListener('ended', advanceToNext);
        audio.addEventListener('error', function () {
            if (typeof Logger !== 'undefined') Logger.warn('Music: audio error, skipping song', audio.error);
            advanceToNext();
        });
        return audio;
    }

    function refillQueue() {
        if (playlist.length === 0) { queue = []; queuePos = 0; return; }
        const indices = [];
        for (let i = 0; i < playlist.length; i++) indices.push(i);
        // Fisher-Yates.
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
        }
        // Avoid back-to-back of the song that just played at the bag boundary.
        if (lastPlayedId && playlist.length > 1 && playlist[indices[0]].id === lastPlayedId) {
            const tmp = indices[0]; indices[0] = indices[1]; indices[1] = tmp;
        }
        queue = indices;
        queuePos = 0;
    }
    function pickNext() {
        if (queuePos >= queue.length) refillQueue();
        if (queue.length === 0) return null;
        const song = playlist[queue[queuePos++]];
        if (song) lastPlayedId = song.id;
        return song;
    }
    function playSong(song) {
        if (!song) return;
        const a = ensureAudio();
        a.src = song.url;
        a.volume = 1;
        const p = a.play();
        if (p && p.catch) p.catch(function (err) {
            // Autoplay rejection (no user gesture yet, iOS quirk, etc).
            // We keep shouldPlay true so the NEXT start() attempt — which
            // happens after a definite user gesture — will succeed.
            if (typeof Logger !== 'undefined') Logger.warn('Music: play rejected', err);
        });
    }
    function advanceToNext() {
        if (!shouldPlay || muted) return;
        playSong(pickNext());
    }

    function start() {
        shouldPlay = true;
        if (muted) return;
        if (playlist.length === 0) return;  // no playlist yet; refresh may still arrive
        const a = ensureAudio();
        // If we have a current song queued and just paused (e.g. mute toggled
        // off mid-game), resume from where we left off instead of restarting.
        if (a.src && a.currentTime > 0 && a.paused && !a.ended) {
            const p = a.play();
            if (p && p.catch) p.catch(function () {});
            return;
        }
        playSong(pickNext());
    }
    function stop() {
        shouldPlay = false;
        if (audio) {
            try { audio.pause(); } catch (e) {}
            // Clear src so the next session starts fresh rather than
            // resuming a song the player has probably forgotten about.
            audio.removeAttribute('src');
            audio.load();
        }
        queue = []; queuePos = 0;
    }

    function setMuted(b) {
        muted = !!b;
        if (muted) {
            if (audio) {
                try { audio.pause(); } catch (e) {}
            }
        } else if (shouldPlay) {
            start();
        }
    }
    function isMuted() { return muted; }

    return {
        start:    start,
        stop:     stop,
        setMuted: setMuted,
        isMuted:  isMuted,
    };
})();
