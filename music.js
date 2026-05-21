// Gameplay music — implements the intro-then-shuffle paradigm (universal
// rule 7b). Two pools from the admin API:
//   INTRO   (MUSIC_INTRO_LIST_NAME)   — curated artistic sequence. Plays
//                                       ONCE per player in position order,
//                                       then never re-plays as a sequence.
//   SHUFFLE (MUSIC_SHUFFLE_LIST_NAME) — random pool that plays forever
//                                       after the intro is exhausted. Falls
//                                       back to the INTRO list if empty,
//                                       so single-list projects still get
//                                       post-intro variety.
//
// Per-player intro progress lives in localStorage (an array of remaining
// song IDs + a fingerprint of the source order). Admin reorders of the
// intro list mismatch the fingerprint and restart the intro for everyone —
// deliberate authorial intent ("new album release, listen to it").
//
// Single reusable HTMLAudioElement. Auto-advance on `ended`. Start on
// Marathon.startGame, stop on game over / quit. Queue state persists
// across stop() so song progression continues between games rather than
// restarting.
//
// Mute is wired through the Settings popup (settings.js). When muted the
// underlying audio is paused; unmute resumes mid-song. Volume similarly
// flows from Settings — slider drag applies live via audio.volume.
//
// iOS/iPad caveat: <audio> can't follow GitHub's 302 redirects. Desktop
// and Android handle the redirect fine; iOS would need a backend proxy.

const Music = (function () {
    const INTRO_NAME    = (typeof MUSIC_INTRO_LIST_NAME === 'string' && MUSIC_INTRO_LIST_NAME)
                          ? MUSIC_INTRO_LIST_NAME : null;
    const SHUFFLE_NAME  = (typeof MUSIC_SHUFFLE_LIST_NAME === 'string' && MUSIC_SHUFFLE_LIST_NAME)
                          ? MUSIC_SHUFFLE_LIST_NAME : null;
    // Cache schema changed at v3 (two pools instead of one playlist), so
    // bumping the key cleanly drops old v2 caches that have the wrong shape.
    const CACHE_KEY        = PROJECT_SLUG + '_songLibrary_v3';
    const INTRO_REMAIN_KEY = PROJECT_SLUG + '_introRemaining_v1';
    const INTRO_FINGER_KEY = PROJECT_SLUG + '_introFingerprint_v1';
    const API_URL          = (typeof AppConfig === 'object' && AppConfig && AppConfig.AUTH_API)
                             ? AppConfig.AUTH_API + '/api/songs?game=' + PROJECT_SLUG : null;

    // Two pools, parsed from the API. introPlaylist preserves the curated
    // position order; shufflePlaylist holds the post-intro random pool
    // (may === introPlaylist if no separate SHUFFLE list is configured).
    let introPlaylist   = [];
    let shufflePlaylist = [];
    // Per-player intro progress: song IDs not yet played, in curated order.
    // null = uninitialized (loaded lazily after the playlist is known).
    let introRemaining  = null;

    // Shuffle bag (post-intro phase). Indices into shufflePlaylist.
    let queue        = [];
    let queuePos     = 0;
    let lastPlayedId = null;

    let audio        = null;   // single reusable HTMLAudioElement
    let shouldPlay   = false;  // true while in a Marathon game session
    let muted        = false;  // mirror of Settings.isMusicMuted()
    let paused       = false;  // user-initiated pause via the now-playing ⏸ button
    let volume       = 0.6;    // 0..1, mirror of Settings.musicVolume slider

    let currentSong  = null;             // last song handed to playSong; null when nothing playing
    let onSongChange = null;             // callback fn(currentSong, paused) — wired by the UI

    // History for prev navigation. Append every successfully-played song;
    // skipPrev rewinds historyPos. advanceToNext checks if we're before
    // history.length-1 and re-plays the next history entry instead of
    // pulling a fresh one (so prev → forward replays the same sequence).
    let history      = [];
    let historyPos   = -1;

    // --- Bootstrap from localStorage cache so first-play has something to
    // play even before the API fetch lands. Empty if no prior cache —
    // start() will be a no-op until refreshFromAPI populates the lists.
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            if (data) {
                if (Array.isArray(data.intro))   introPlaylist   = data.intro;
                if (Array.isArray(data.shuffle)) shufflePlaylist = data.shuffle;
            }
        }
    } catch (e) {}
    // If no separate shuffle pool exists, fall back to the intro pool so
    // post-intro phase still has songs to draw from.
    if (shufflePlaylist.length === 0) shufflePlaylist = introPlaylist;
    syncIntroState();

    // --- Live refresh from the umbrella API. Non-blocking; cached pools
    // stay in use until this lands (and beyond, if it fails).
    async function refreshFromAPI() {
        if (!API_URL) return;
        try {
            const resp = await fetch(API_URL);
            if (!resp.ok) {
                if (typeof Logger !== 'undefined') Logger.warn('Music: API responded ' + resp.status);
                return;
            }
            const data = await resp.json();
            const lists = (data && data.lists) ? data.lists : {};
            const introRows   = (INTRO_NAME   && Array.isArray(lists[INTRO_NAME]))   ? lists[INTRO_NAME]   : [];
            const shuffleRows = (SHUFFLE_NAME && Array.isArray(lists[SHUFFLE_NAME])) ? lists[SHUFFLE_NAME] : [];
            // Defensive: don't wipe a populated cache with an empty API
            // response (could be a bad deploy on the admin side). If BOTH
            // lists came back empty, keep the existing cached pools.
            if (introRows.length === 0 && shuffleRows.length === 0) {
                if (typeof Logger !== 'undefined') Logger.warn('Music: API returned no songs for intro="' + INTRO_NAME + '" or shuffle="' + SHUFFLE_NAME + '"; keeping cached pools');
                return;
            }
            introPlaylist   = mapAndSort(introRows);
            shufflePlaylist = mapAndSort(shuffleRows);
            if (shufflePlaylist.length === 0) shufflePlaylist = introPlaylist;
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({
                    intro:   introPlaylist,
                    shuffle: (shufflePlaylist === introPlaylist) ? [] : shufflePlaylist,
                }));
            } catch (e) {}
            // Shuffle bag invalidates on membership change; intro state
            // re-syncs (fingerprint mismatch → restart intro for player).
            queue = []; queuePos = 0;
            syncIntroState();
            // If a game was started before this API call landed (cache was
            // empty / nothing to play), kick off playback now. Without
            // this, the player has to start a fresh game for music to begin.
            if (shouldPlay && !muted && !paused && !currentSong) {
                start();
            }
        } catch (e) {
            if (typeof Logger !== 'undefined') Logger.warn('Music: API fetch failed; using cached pools', e);
        }
    }
    refreshFromAPI();

    function mapAndSort(rows) {
        const copy = rows.slice();
        copy.sort(function (a, b) {
            const ap = (a.position == null) ? Infinity : a.position;
            const bp = (b.position == null) ? Infinity : b.position;
            if (ap !== bp) return ap - bp;
            return (a.label || '').localeCompare(b.label || '');
        });
        return copy.map(function (r) {
            return { id: r.key, name: r.label, url: MUSIC_BASE_URL + r.filename };
        });
    }

    // --- Per-player intro progress ------------------------------------
    // The intro plays ONCE per player. State persists across page loads /
    // sessions via localStorage. Admin reorders restart it for everyone.
    function introFingerprint(songs) {
        return songs.map(function (s) { return s.id; }).join('|');
    }
    function syncIntroState() {
        if (introPlaylist.length === 0) {
            introRemaining = [];
            return;
        }
        const currentFp = introFingerprint(introPlaylist);
        let savedFp = null;
        try { savedFp = localStorage.getItem(INTRO_FINGER_KEY); } catch (e) {}
        if (savedFp !== currentFp) {
            // Order changed (or first time ever) — restart the intro.
            introRemaining = introPlaylist.map(function (s) { return s.id; });
            try {
                localStorage.setItem(INTRO_FINGER_KEY, currentFp);
                localStorage.setItem(INTRO_REMAIN_KEY, JSON.stringify(introRemaining));
            } catch (e) {}
            return;
        }
        // Same fingerprint — restore saved progress.
        try {
            const raw = localStorage.getItem(INTRO_REMAIN_KEY);
            introRemaining = raw ? JSON.parse(raw) : introPlaylist.map(function (s) { return s.id; });
        } catch (e) {
            introRemaining = introPlaylist.map(function (s) { return s.id; });
        }
        if (!Array.isArray(introRemaining)) introRemaining = [];
    }
    function persistIntroRemaining() {
        try { localStorage.setItem(INTRO_REMAIN_KEY, JSON.stringify(introRemaining || [])); }
        catch (e) {}
    }

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

    // --- Picking the next song ---------------------------------------
    // Intro pool is drained first, ONCE per player. After that, every
    // pickNext call returns from the shuffle pool.
    function pickIntroSong() {
        if (!introRemaining || introRemaining.length === 0) return null;
        while (introRemaining.length > 0) {
            const id = introRemaining.shift();
            persistIntroRemaining();
            const song = findInList(introPlaylist, id);
            if (song) return song;
            // Song was deleted from the admin since the intro started —
            // silently skip and try the next remaining id.
        }
        return null;
    }
    function refillShuffleQueue() {
        if (shufflePlaylist.length === 0) { queue = []; queuePos = 0; return; }
        const indices = [];
        for (let i = 0; i < shufflePlaylist.length; i++) indices.push(i);
        // Fisher-Yates.
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
        }
        // Avoid back-to-back of the song that just played at the bag boundary.
        if (lastPlayedId && shufflePlaylist.length > 1 && shufflePlaylist[indices[0]].id === lastPlayedId) {
            const tmp = indices[0]; indices[0] = indices[1]; indices[1] = tmp;
        }
        queue = indices;
        queuePos = 0;
    }
    function pickShuffleSong() {
        if (shufflePlaylist.length === 0) return null;
        if (queuePos >= queue.length) refillShuffleQueue();
        if (queue.length === 0) return null;
        const song = shufflePlaylist[queue[queuePos++]];
        if (song) lastPlayedId = song.id;
        return song;
    }
    function pickNext() {
        return pickIntroSong() || pickShuffleSong();
    }
    function findInList(list, id) {
        for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }
    function findById(id) {
        return findInList(introPlaylist, id) || findInList(shufflePlaylist, id);
    }

    function playSong(song) {
        if (!song) return;
        currentSong = song;
        paused      = false;
        notifySongChange();
        const a = ensureAudio();
        a.src = song.url;
        a.volume = volume;
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
        // If skipPrev rewound us into history, going forward replays the
        // existing sequence rather than diverging into a fresh next.
        if (historyPos < history.length - 1) {
            historyPos++;
            const song = findById(history[historyPos]);
            if (song) { playSong(song); return; }
        }
        const song = pickNext();
        if (song) {
            history.push(song.id);
            historyPos = history.length - 1;
            playSong(song);
        }
    }

    function start() {
        shouldPlay = true;
        paused     = false;
        if (muted) return;
        if (introPlaylist.length === 0 && shufflePlaylist.length === 0) return;  // nothing to play yet
        const a = ensureAudio();
        // Resume mid-song if we have one queued (e.g. mute toggled off
        // mid-game, or the player un-paused after a long settings dive).
        if (a.src && a.currentTime > 0 && a.paused && !a.ended) {
            const p = a.play();
            if (p && p.catch) p.catch(function () {});
            notifySongChange();
            return;
        }
        advanceToNext();
    }
    function stop() {
        shouldPlay  = false;
        paused      = false;
        if (audio) {
            try { audio.pause(); } catch (e) {}
            audio.removeAttribute('src');
            audio.load();
        }
        // INTENTIONALLY preserve `queue` / `queuePos` / `history` /
        // `lastPlayedId` / `introRemaining` across stops so the curated
        // playlist progresses BETWEEN games. Only the audio element +
        // current-song bookkeeping reset (so the Now Playing UI hides).
        currentSong = null;
        notifySongChange();
    }

    function setMuted(b) {
        muted = !!b;
        if (muted) {
            if (audio) try { audio.pause(); } catch (e) {}
            notifySongChange();
        } else if (shouldPlay) {
            start();
        }
    }

    // --- Now-playing controls -----------------------------------------
    function skipNext() {
        if (!shouldPlay) return;
        advanceToNext();
    }
    function skipPrev() {
        if (!shouldPlay) return;
        if (historyPos > 0) {
            historyPos--;
            const song = findById(history[historyPos]);
            if (song) { playSong(song); return; }
        }
        // No prior song — restart current from the beginning.
        if (audio) try { audio.currentTime = 0; } catch (e) {}
    }
    function togglePause() {
        if (!shouldPlay || !audio) return;
        if (paused) {
            const p = audio.play();
            if (p && p.catch) p.catch(function () {});
            paused = false;
        } else {
            try { audio.pause(); } catch (e) {}
            paused = true;
        }
        notifySongChange();
    }

    function isMuted()        { return muted; }
    function isPaused()       { return paused; }
    function isPlaying()      { return shouldPlay && !muted && !paused && !!currentSong; }
    function getCurrentSong() { return currentSong; }
    function getVolume()      { return volume; }
    function setVolume(v) {
        volume = Math.max(0, Math.min(1, v));
        // Apply live so dragging the slider mid-song changes loudness
        // immediately rather than waiting for the next track.
        if (audio) {
            try { audio.volume = volume; } catch (e) {}
        }
    }
    function setOnSongChange(cb) { onSongChange = (typeof cb === 'function') ? cb : null; }
    function notifySongChange() {
        if (onSongChange) {
            try { onSongChange(currentSong, paused); }
            catch (e) { if (typeof Logger !== 'undefined') Logger.warn('Music: onSongChange threw', e); }
        }
    }

    return {
        start:           start,
        stop:            stop,
        setMuted:        setMuted,
        isMuted:         isMuted,
        isPaused:        isPaused,
        isPlaying:       isPlaying,
        togglePause:     togglePause,
        skipNext:        skipNext,
        skipPrev:        skipPrev,
        setVolume:       setVolume,
        getVolume:       getVolume,
        getCurrentSong:  getCurrentSong,
        setOnSongChange: setOnSongChange,
    };
})();

// Now Playing UI wiring. Lives in music.js because the DOM updates are
// tightly coupled to song-change events the module emits; keeping it
// here avoids a one-off external file just to bridge two callbacks.
(function () {
    function initNowPlayingUI() {
        const el       = document.getElementById('nowPlaying');
        const titleEl  = document.getElementById('nowPlayingTitle');
        const pauseBtn = document.getElementById('nowPlayingPause');
        const prevBtn  = document.getElementById('nowPlayingPrev');
        const nextBtn  = document.getElementById('nowPlayingNext');
        if (!el || !titleEl) return;

        if (prevBtn)  prevBtn.addEventListener('click',  function () { Music.skipPrev(); });
        if (nextBtn)  nextBtn.addEventListener('click',  function () { Music.skipNext(); });
        if (pauseBtn) pauseBtn.addEventListener('click', function () { Music.togglePause(); });

        Music.setOnSongChange(function (song, paused) {
            if (song && !Music.isMuted()) {
                el.classList.add('visible');
                titleEl.textContent = song.name || '';
                if (pauseBtn) pauseBtn.textContent = paused ? '▶' : '⏸';
            } else {
                el.classList.remove('visible');
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNowPlayingUI);
    } else {
        initNowPlayingUI();
    }
})();
