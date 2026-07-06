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
    const CREDITS_NAME  = (typeof MUSIC_CREDITS_LIST_NAME === 'string' && MUSIC_CREDITS_LIST_NAME)
                          ? MUSIC_CREDITS_LIST_NAME : null;
    const MENU_NAME     = (typeof MUSIC_MENU_LIST_NAME === 'string' && MUSIC_MENU_LIST_NAME)
                          ? MUSIC_MENU_LIST_NAME : null;
    // Cache schema bumped to v5 — added the menu pool. Old v4 caches
    // (three pools without menu) are dropped cleanly by the key change
    // rather than mis-parsed as the new shape.
    const CACHE_KEY          = PROJECT_SLUG + '_songLibrary_v5';
    const INTRO_REMAIN_KEY   = PROJECT_SLUG + '_introRemaining_v1';
    const INTRO_FINGER_KEY   = PROJECT_SLUG + '_introFingerprint_v1';
    // Credits shuffle-bag persistence. Same pattern as intro warnings'
    // shuffle (per-player, survives across sessions). Without this, every
    // end-credits sequence would start from a fresh random song — but the
    // player would still tend to hear "the song I just heard last time"
    // since each fresh shuffle is independent and the first index is
    // uniformly random over the whole list. Persisting the *remaining*
    // indices means each play cycles through the pool deterministically
    // before any song repeats.
    const CREDITS_REMAIN_KEY = PROJECT_SLUG + '_creditsRemaining_v1';
    const CREDITS_FINGER_KEY = PROJECT_SLUG + '_creditsFingerprint_v1';
    // Same persistence story for the gameplay shuffle bag + the menu-phase
    // shuffle bag — without these, reloading the page (or the SW kicking
    // off a fresh load on update) reset the in-memory bag and the player
    // could hear a "song they just heard" because the new bag's first
    // pick was independent of the old bag's history. Storing the
    // *remaining* indices means the bag carries across sessions and
    // every song actually plays once before any repeats. Fingerprint
    // includes playMode for shuffle so a Settings mode change
    // invalidates the bag cleanly.
    const SHUFFLE_REMAIN_KEY = PROJECT_SLUG + '_shuffleRemaining_v1';
    const SHUFFLE_FINGER_KEY = PROJECT_SLUG + '_shuffleFingerprint_v1';
    const MENU_REMAIN_KEY    = PROJECT_SLUG + '_menuRemaining_v1';
    const MENU_FINGER_KEY    = PROJECT_SLUG + '_menuFingerprint_v1';
    const API_URL          = (typeof AppConfig === 'object' && AppConfig && AppConfig.AUTH_API)
                             ? AppConfig.AUTH_API + '/api/songs?game=' + PROJECT_SLUG : null;

    // Playback mode (mirrors Settings dropdown).
    //   'none'              — muted
    //   'game_playlist'     — intro then gameplay shuffle (default)
    //   'credits'           — credits pool in fixed order (loops)
    //   'game_plus_credits' — intro then combined gameplay+credits shuffle
    // Sequence-mode overrides: when forceCredits is true (set by the end-
    // credits sequence kicked off from Marathon game-over / PotD solve), the
    // next pickNext() always pulls from creditsPlaylist regardless of mode.
    let playMode      = 'game_playlist';
    let forceCredits  = false;

    // Four pools, parsed from the API. introPlaylist preserves the curated
    // position order; shufflePlaylist holds the post-intro random pool
    // (may === introPlaylist if no separate SHUFFLE list is configured).
    // creditsPlaylist is the end-credits pool (falls back to shufflePlaylist
    // if missing, so the credits sequence isn't silent). menuPlaylist is the
    // main-menu / lobby shuffle pool — played whenever inMenuPhase is true
    // (set by intro dismiss + marathon/potd quit-to-menu, cleared on game
    // start). If menuPlaylist is empty, the menu phase falls through to the
    // intro-then-shuffle pipeline below — so adding a menu-only list to the
    // admin is purely additive; deleting it reverts to the old behavior.
    let introPlaylist   = [];
    let shufflePlaylist = [];
    let creditsPlaylist = [];
    let menuPlaylist    = [];
    // Per-player intro progress: song IDs not yet played, in curated order.
    // null = uninitialized (loaded lazily after the playlist is known).
    let introRemaining  = null;

    // Shuffle bag (post-intro phase) — array of REMAINING indices into
    // the active pool that haven't been played yet in the current cycle.
    // `.shift()` consumes the next pick; when the array is empty, refill
    // re-shuffles. Pool depends on playMode: shufflePlaylist for
    // 'game_playlist', [...shufflePlaylist, ...creditsPlaylist] for
    // 'game_plus_credits'. 'credits' mode uses a separate persisted
    // creditsBag below.
    //
    // Persisted across sessions via SHUFFLE_REMAIN_KEY (see persist /
    // load helpers) so reloading the page doesn't reset which songs
    // have already played this cycle — without persistence, a fresh
    // load + the bag's "any random song from the pool" first-pick
    // semantics frequently sounded like an immediate repeat of
    // something the player heard moments ago.
    let queue        = [];
    let queueMode    = 'game_playlist';   // mode the queue was built for
    let lastPlayedId = null;
    // Set to true after the first pickShuffleSong call attempts a
    // localStorage restore — ensures we only try the load once per
    // session, even if the bag is later drained and refilled.
    let shuffleBagLoaded = false;

    // Credits-mode shuffle bag — array of remaining indices into
    // creditsPlaylist that haven't been played yet in the current cycle.
    // Persisted across sessions via CREDITS_REMAIN_KEY so a player never
    // hears the same credits song twice until the whole pool is exhausted.
    // null sentinel = "not yet loaded from localStorage this session"; an
    // empty array = bag drained, will refill on next pick. lastCreditsPlayedId
    // is used to avoid the bag-boundary edge case where a fresh refill
    // happens to put the just-played song first again.
    let creditsBag          = null;
    let lastCreditsPlayedId = null;

    // Menu-phase shuffle bag — independent of the gameplay shuffle (queue)
    // so switching between menu and game doesn't constantly invalidate the
    // bag and cause clumpy "same song twice in a row" behavior. Same
    // remaining-indices + persist pattern as the gameplay queue above.
    let menuQueue        = [];
    let lastMenuPlayedId = null;
    let menuBagLoaded    = false;
    // Phase flag — true while the player is sitting on the main menu (or
    // the opening intro is up), false while a game is active. pickNext
    // checks this first and routes to menuPlaylist when true and that
    // pool has songs.
    let inMenuPhase  = true;

    let audio        = null;   // single reusable HTMLAudioElement
    let shouldPlay   = false;  // true while in a Marathon game session
    let muted        = false;  // mirror of Settings.isMusicMuted()
    let paused       = false;  // user-initiated pause via the now-playing ⏸ button
    let volume       = 0.6;    // 0..1, mirror of Settings.musicVolume slider

    // Consecutive-error counter for the audio element's 'error' listener.
    // Without a cap, a persistent failure (single-song pool with a bad URL,
    // network down, GitHub redirect quirk) would spin advanceToNext →
    // playSong → error → advanceToNext forever, flooding the console and
    // burning CPU on rejected .play() promises. Reset to 0 by the 'playing'
    // listener on any successful playback start.
    const MAX_CONSECUTIVE_ERRORS = 4;
    let consecutiveErrors = 0;

    // True once the player has interacted with the page (click, touch,
    // keypress). Browsers block <audio>.play() before the first user
    // gesture; localhost dev + Chrome's Media Engagement Index let it
    // slip through in some setups, but a fresh production visitor would
    // get nothing. start() refuses to begin playback until this flips
    // so we don't depend on browser leniency. The capture-phase
    // listener below flips it ahead of any bubble-phase handler that
    // calls start() inside the same event (intro dismiss button, mode
    // selector, etc.), so those calls proceed normally.
    let gestureReady = false;

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
                if (Array.isArray(data.credits)) creditsPlaylist = data.credits;
                if (Array.isArray(data.menu))    menuPlaylist    = data.menu;
            }
        }
    } catch (e) {}
    // If no separate shuffle pool exists, fall back to the intro pool so
    // post-intro phase still has songs to draw from.
    if (shufflePlaylist.length === 0) shufflePlaylist = introPlaylist;
    // Credits falls back to shuffle (which already falls back to intro) so
    // the end-credits sequence is never silent even when the admin hasn't
    // configured a dedicated credits pool yet.
    if (creditsPlaylist.length === 0) creditsPlaylist = shufflePlaylist;
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
            // Family-strict platforms (CrazyGames requires PEGI 12): drop
            // songs the admin flagged `explicit` before they reach any
            // playlist. Filtering here — ahead of mapAndSort AND the cache
            // write below — means the CG origin's localStorage cache only
            // ever holds clean pools too, so even the offline/cached path
            // can't surface a flagged song there. Other origins play the
            // full catalog. Intro-order positions are preserved since
            // filter() keeps relative order and mapAndSort sorts by the
            // rows' own position values.
            const familyStrict = (typeof IS_CRAZYGAMES !== 'undefined' && IS_CRAZYGAMES);
            const clean = (rows) => familyStrict ? rows.filter((r) => !r.explicit) : rows;
            const introRows   = clean((INTRO_NAME   && Array.isArray(lists[INTRO_NAME]))   ? lists[INTRO_NAME]   : []);
            const shuffleRows = clean((SHUFFLE_NAME && Array.isArray(lists[SHUFFLE_NAME])) ? lists[SHUFFLE_NAME] : []);
            const creditsRows = clean((CREDITS_NAME && Array.isArray(lists[CREDITS_NAME])) ? lists[CREDITS_NAME] : []);
            const menuRows    = clean((MENU_NAME    && Array.isArray(lists[MENU_NAME]))    ? lists[MENU_NAME]    : []);
            // Defensive: don't wipe a populated cache with an empty API
            // response (could be a bad deploy on the admin side). If ALL
            // lists came back empty, keep the existing cached pools.
            if (introRows.length === 0 && shuffleRows.length === 0 && creditsRows.length === 0 && menuRows.length === 0) {
                if (typeof Logger !== 'undefined') Logger.warn('Music: API returned no songs for intro="' + INTRO_NAME + '", shuffle="' + SHUFFLE_NAME + '", credits="' + CREDITS_NAME + '", or menu="' + MENU_NAME + '"; keeping cached pools');
                return;
            }
            introPlaylist   = mapAndSort(introRows);
            shufflePlaylist = mapAndSort(shuffleRows);
            creditsPlaylist = mapAndSort(creditsRows);
            menuPlaylist    = mapAndSort(menuRows);
            if (shufflePlaylist.length === 0) shufflePlaylist = introPlaylist;
            if (creditsPlaylist.length === 0) creditsPlaylist = shufflePlaylist;
            // menuPlaylist is intentionally NOT given a fallback — if it's
            // empty, pickNext falls through to the regular intro/shuffle
            // path even at the menu, which matches the pre-menu-list
            // behavior.
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({
                    intro:   introPlaylist,
                    shuffle: (shufflePlaylist === introPlaylist) ? [] : shufflePlaylist,
                    credits: (creditsPlaylist === shufflePlaylist || creditsPlaylist === introPlaylist) ? [] : creditsPlaylist,
                    menu:    menuPlaylist,
                }));
            } catch (e) {}
            // Shuffle bags invalidate on membership change; intro state
            // re-syncs (fingerprint mismatch → restart intro for player).
            // All three bags (credits/shuffle/menu) clear their in-memory
            // state; the next pick will either restore a still-valid
            // persisted bag (fingerprint match) or freshly shuffle if the
            // corresponding pool changed. Reset shuffleBagLoaded /
            // menuBagLoaded so the lazy-load logic re-attempts the
            // localStorage restore against the new pool.
            queue = [];
            menuQueue = [];
            creditsBag = null;
            shuffleBagLoaded = false;
            menuBagLoaded    = false;
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
        // Reset the consecutive-error counter on any successful start —
        // if we made it to 'playing', the most recent song was fine and
        // we should let future failures get the full retry budget again.
        audio.addEventListener('playing', function () { consecutiveErrors = 0; });
        audio.addEventListener('error', function () {
            // Skip the spurious "no source" error that some browsers fire
            // when audio.load() runs after removeAttribute('src') in stop().
            // That error isn't a song failure — it's the element resetting —
            // and counting it would burn through the retry budget on a
            // non-problem. After src is properly set, this guard is false
            // and real errors get logged + counted as expected.
            const hasSrc = !!audio.src && audio.src !== window.location.href;
            if (!hasSrc) return;
            if (typeof Logger !== 'undefined') Logger.warn('Music: audio error, skipping song', audio.error);
            consecutiveErrors++;
            if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
                // Persistent failure — bail rather than spin. shouldPlay=false
                // makes advanceToNext short-circuit so naturally-firing 'ended'
                // events don't restart the cascade. The next user-initiated
                // start() call (Settings toggle, mode change, etc.) re-arms
                // shouldPlay and gives the system another shot.
                if (typeof Logger !== 'undefined') {
                    Logger.warn('Music: ' + consecutiveErrors + ' consecutive errors — giving up until next start()');
                }
                shouldPlay = false;
                return;
            }
            advanceToNext();
        });
        return audio;
    }

    // --- iOS audio blessing ----------------------------------------
    // iPad Safari only lets <audio>.play() succeed on elements that
    // were first played inside a user-gesture handler. We create the
    // single reusable Audio element above lazily — without blessing,
    // its first play() call (which often happens asynchronously after
    // an API fetch or a setTimeout) gets blocked.
    //
    // Fix: on the first user gesture, force-create the Audio element
    // if it doesn't already exist and run a silent play() inside the
    // gesture's synchronous call stack. That "blesses" the element for
    // all subsequent play() calls in the page's lifetime, no matter
    // when or from what context they fire.
    //
    // No-op on non-iOS browsers — they have no such restriction and
    // the silent play would just be wasted work.
    if (typeof IS_IOS_AUDIO !== 'undefined' && IS_IOS_AUDIO &&
        typeof document !== 'undefined') {
        let blessed = false;
        // Function expression rather than declaration so the binding is
        // unambiguous in older Safari (function declarations inside
        // blocks have inconsistent hoisting in sloppy mode).
        const blessOnGesture = function () {
            if (blessed) return;
            blessed = true;
            const a = ensureAudio();
            const savedVol = a.volume;
            a.volume = 0;
            const p = a.play();
            if (p && p.then) {
                p.then(function () {
                    a.pause();
                    a.volume = savedVol;
                }).catch(function () {
                    // Bless failed (probably no src yet on some
                    // Safari versions) — try once more on the next
                    // gesture.
                    blessed = false;
                    a.volume = savedVol;
                });
            } else {
                try { a.pause(); } catch (e) {}
                a.volume = savedVol;
            }
        };
        ['click', 'touchend', 'keydown'].forEach(function (evt) {
            document.addEventListener(evt, blessOnGesture, { capture: true });
        });
    }

    // First-gesture detection for the autoplay gate. Capture-phase so this
    // fires BEFORE any bubble-phase handler that calls Music.start() inside
    // the same event (intro Continue button, mode buttons, settings unmute).
    // Without that ordering, the first gesture-blessed start() call would
    // still see gestureReady=false and skip.
    if (typeof document !== 'undefined') {
        const markGestureReady = function () { gestureReady = true; };
        ['click', 'touchend', 'keydown'].forEach(function (evt) {
            document.addEventListener(evt, markGestureReady, { capture: true });
        });
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
    // The shuffle pool depends on the active mode. 'game_playlist' uses
    // the gameplay pool alone; 'game_plus_credits' draws from gameplay +
    // credits combined (so credits songs sprinkle into normal play).
    function activeShufflePool() {
        if (playMode === 'game_plus_credits' && creditsPlaylist.length > 0) {
            // Deduplicate by id in case credits === shuffle (fallback case).
            if (creditsPlaylist === shufflePlaylist) return shufflePlaylist;
            const seen = {};
            const combined = [];
            for (let i = 0; i < shufflePlaylist.length; i++) {
                const s = shufflePlaylist[i];
                if (!seen[s.id]) { seen[s.id] = 1; combined.push(s); }
            }
            for (let i = 0; i < creditsPlaylist.length; i++) {
                const s = creditsPlaylist[i];
                if (!seen[s.id]) { seen[s.id] = 1; combined.push(s); }
            }
            return combined;
        }
        return shufflePlaylist;
    }
    function shuffleFingerprint() {
        // playMode is part of the fingerprint because activeShufflePool()
        // returns a different pool for 'game_plus_credits' than for
        // 'game_playlist'. Same `shufflePlaylist` membership but a
        // mode change still invalidates the bag (indices would point
        // into the wrong pool).
        return playMode + '|' + activeShufflePool().map(function (s) { return s.id; }).join(',');
    }
    function persistShuffleBag() {
        try {
            localStorage.setItem(SHUFFLE_REMAIN_KEY, JSON.stringify(queue || []));
            localStorage.setItem(SHUFFLE_FINGER_KEY, shuffleFingerprint());
        } catch (e) { /* private mode / quota — degrade to in-memory */ }
    }
    function loadShuffleBagFromStorage() {
        // Returns the persisted bag if the pool + mode haven't changed
        // since, null otherwise (caller falls back to a fresh shuffle).
        // Validates each index against the current pool length so a
        // partial / corrupt write can't crash later picks.
        try {
            const fp = localStorage.getItem(SHUFFLE_FINGER_KEY);
            if (fp !== shuffleFingerprint()) return null;
            const raw = localStorage.getItem(SHUFFLE_REMAIN_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            const pool = activeShufflePool();
            for (let i = 0; i < parsed.length; i++) {
                const v = parsed[i];
                if (!Number.isInteger(v) || v < 0 || v >= pool.length) return null;
            }
            return parsed;
        } catch (e) { return null; }
    }
    function refillShuffleQueue() {
        const pool = activeShufflePool();
        if (pool.length === 0) { queue = []; return; }
        const indices = [];
        for (let i = 0; i < pool.length; i++) indices.push(i);
        // Fisher-Yates.
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
        }
        // Avoid back-to-back of the song that just played at the bag boundary.
        if (lastPlayedId && pool.length > 1 && pool[indices[0]].id === lastPlayedId) {
            const tmp = indices[0]; indices[0] = indices[1]; indices[1] = tmp;
        }
        queue = indices;
        queueMode = playMode;
    }
    function pickShuffleSong() {
        // First access this session: try to restore the persisted bag.
        // Only accepted if the fingerprint still matches (same pool +
        // same playMode) — otherwise fall through to a fresh shuffle
        // via the empty-queue refill below.
        if (!shuffleBagLoaded) {
            shuffleBagLoaded = true;
            const persisted = loadShuffleBagFromStorage();
            if (persisted !== null) {
                queue = persisted;
                queueMode = playMode;
            }
        }
        // Mode change since last fill invalidates the queue — the indices
        // point into a stale pool that may not match the new mode.
        if (queueMode !== playMode) { queue = []; }
        const pool = activeShufflePool();
        if (pool.length === 0) return null;
        if (queue.length === 0) refillShuffleQueue();
        if (queue.length === 0) return null;
        const idx = queue.shift();
        const song = pool[idx];
        if (song) lastPlayedId = song.id;
        persistShuffleBag();
        return song;
    }
    // Credits-mode pick: shuffle-bag walk through creditsPlaylist that
    // cycles every song before any repeats. Used by both the 'credits'
    // playMode (Settings dropdown choice) and by the end-credits sequence
    // (forceCredits flag set in startCreditsSequence). Persisted across
    // sessions via CREDITS_REMAIN_KEY so the cycling survives page
    // reloads — without that, every visit would tend to start credits
    // with a uniformly-random song, which in practice often lands on the
    // same one a couple of times in a row.
    function creditsFingerprint() {
        return creditsPlaylist.map(function (s) { return s.id; }).join('|');
    }
    function persistCreditsBag() {
        try {
            localStorage.setItem(CREDITS_REMAIN_KEY, JSON.stringify(creditsBag || []));
            localStorage.setItem(CREDITS_FINGER_KEY, creditsFingerprint());
        } catch (e) { /* private mode / quota — degrade to in-memory bag */ }
    }
    function loadCreditsBagFromStorage() {
        // Returns the persisted bag if the playlist hasn't changed since,
        // null otherwise (caller falls back to a fresh shuffle). Validates
        // each index against the current playlist length so a partial /
        // corrupt write can't crash later picks.
        try {
            const fp = localStorage.getItem(CREDITS_FINGER_KEY);
            if (fp !== creditsFingerprint()) return null;
            const raw = localStorage.getItem(CREDITS_REMAIN_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            for (let i = 0; i < parsed.length; i++) {
                const v = parsed[i];
                if (!Number.isInteger(v) || v < 0 || v >= creditsPlaylist.length) return null;
            }
            return parsed;
        } catch (e) { return null; }
    }
    function refillCreditsBag() {
        if (creditsPlaylist.length === 0) { creditsBag = []; return; }
        const indices = [];
        for (let i = 0; i < creditsPlaylist.length; i++) indices.push(i);
        // Fisher-Yates shuffle in place.
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
        }
        // Bag-boundary avoidance: if the freshly-shuffled first index is
        // the song that JUST played at the end of the previous cycle,
        // swap with position 1 so the player doesn't hear a back-to-back
        // repeat. Skip when the pool has 0 or 1 entries (no alternative).
        if (lastCreditsPlayedId && indices.length > 1
            && creditsPlaylist[indices[0]].id === lastCreditsPlayedId) {
            const tmp = indices[0]; indices[0] = indices[1]; indices[1] = tmp;
        }
        creditsBag = indices;
    }
    function pickCreditsSong() {
        if (creditsPlaylist.length === 0) return null;
        // First access this session: try to restore the persisted bag,
        // fall back to a fresh shuffle. The persisted bag is only
        // accepted if its fingerprint still matches the current playlist
        // — admin reorders / additions / deletions invalidate it.
        if (creditsBag === null) {
            const persisted = loadCreditsBagFromStorage();
            creditsBag = persisted !== null ? persisted : [];
            if (creditsBag.length === 0) refillCreditsBag();
        }
        // Drained — start a new cycle. lastCreditsPlayedId guards
        // against the just-played song landing first again.
        if (creditsBag.length === 0) refillCreditsBag();
        if (creditsBag.length === 0) return null;   // empty playlist
        const idx = creditsBag.shift();
        const song = creditsPlaylist[idx];
        if (song) {
            lastCreditsPlayedId = song.id;
            lastPlayedId = song.id;
        }
        persistCreditsBag();
        return song;
    }
    // Menu-phase shuffle bag (separate from gameplay queue so toggling
    // phase doesn't reset the gameplay shuffle position). Same Fisher-Yates
    // + back-to-back avoidance pattern as pickShuffleSong, plus the same
    // persistence pattern so a page reload during menu music doesn't
    // restart the bag's cycle.
    function menuFingerprint() {
        return menuPlaylist.map(function (s) { return s.id; }).join(',');
    }
    function persistMenuBag() {
        try {
            localStorage.setItem(MENU_REMAIN_KEY, JSON.stringify(menuQueue || []));
            localStorage.setItem(MENU_FINGER_KEY, menuFingerprint());
        } catch (e) {}
    }
    function loadMenuBagFromStorage() {
        try {
            const fp = localStorage.getItem(MENU_FINGER_KEY);
            if (fp !== menuFingerprint()) return null;
            const raw = localStorage.getItem(MENU_REMAIN_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            for (let i = 0; i < parsed.length; i++) {
                const v = parsed[i];
                if (!Number.isInteger(v) || v < 0 || v >= menuPlaylist.length) return null;
            }
            return parsed;
        } catch (e) { return null; }
    }
    function refillMenuQueue() {
        if (menuPlaylist.length === 0) { menuQueue = []; return; }
        const indices = [];
        for (let i = 0; i < menuPlaylist.length; i++) indices.push(i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
        }
        if (lastMenuPlayedId && menuPlaylist.length > 1 && menuPlaylist[indices[0]].id === lastMenuPlayedId) {
            const tmp = indices[0]; indices[0] = indices[1]; indices[1] = tmp;
        }
        menuQueue = indices;
    }
    function pickMenuSong() {
        if (menuPlaylist.length === 0) return null;
        // First access this session: try to restore the persisted bag.
        // Same fingerprint-validated pattern as pickShuffleSong above.
        if (!menuBagLoaded) {
            menuBagLoaded = true;
            const persisted = loadMenuBagFromStorage();
            if (persisted !== null) menuQueue = persisted;
        }
        if (menuQueue.length === 0) refillMenuQueue();
        if (menuQueue.length === 0) return null;
        const idx = menuQueue.shift();
        const song = menuPlaylist[idx];
        if (song) { lastMenuPlayedId = song.id; lastPlayedId = song.id; }
        persistMenuBag();
        return song;
    }
    function pickNext() {
        // forceCredits (the end-credits sequence kicked off from
        // game-over) overrides everything — including menu phase, since
        // the credits roll after the player just finished a game and
        // we DON'T want to switch back to menu music yet.
        if (forceCredits) return pickCreditsSong();
        // Menu phase: shuffle from the menu pool while the player sits
        // on the main menu (or the opening intro is up). Falls through
        // to the regular intro/shuffle pipeline if the menu pool is
        // empty, so projects without a menu_only list get the old
        // behavior unchanged.
        if (inMenuPhase && menuPlaylist.length > 0) return pickMenuSong();
        if (playMode === 'credits') return pickCreditsSong();
        // Both 'game_playlist' and 'game_plus_credits' play the intro first.
        return pickIntroSong() || pickShuffleSong();
    }
    function findInList(list, id) {
        for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return null;
    }
    function findById(id) {
        return findInList(introPlaylist, id)
            || findInList(shufflePlaylist, id)
            || findInList(creditsPlaylist, id)
            || findInList(menuPlaylist, id);
    }
    // True iff `id` is in the menu-only pool. Used by replay (to drop menu
    // tracks from a scripted schedule) and exposed as isMenuSong so the
    // recorder can keep menu music out of game recordings in the first
    // place. Empty menuPlaylist → always false (project with no menu pool).
    function isMenuPoolSong(id) {
        return !!findInList(menuPlaylist, id);
    }

    function playSong(song) {
        if (!song) return;
        // Fade any lingering one-shot SFX (audience_cheer, applause_long,
        // etc.) the instant a new song starts. Without this, a player who
        // finishes a PotD puzzle hears the cheer SFX continue playing
        // over the menu music when they navigate back. Loops (like
        // glitch_overlap) are untouched — fadeOneShots specifically
        // excludes them, since they tend to track ongoing gameplay
        // state that survives across song transitions.
        if (typeof Sfx !== 'undefined' && Sfx.fadeOneShots) Sfx.fadeOneShots();
        currentSong = song;
        paused      = false;
        notifySongChange();
        // Respect the player's mute setting on EVERY song-switch path,
        // not just the start()-initiated ones. advanceToNext is already
        // gated on `muted` at its top, but scripted playback (replay)
        // calls playSong directly from its scheduled timers — without
        // this guard, replaying a game with music muted would still
        // re-fire audio playback on every recorded song change.
        // currentSong + notifySongChange above still fire so the
        // Now Playing UI reflects what WOULD have been playing during
        // the replay, just silently.
        if (muted) return;
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
        // Scripted playback (replay) owns the next-song timeline via
        // setTimeout. The audio's 'ended' handler still fires when a
        // song finishes naturally — but it should NOT pick a fresh
        // song from pickNext, because the scripted schedule will play
        // the next song at its own pre-determined time. Silence
        // between two events is intentional (matches what the
        // original player heard if a song ended early).
        if (scriptedPlayback) return;
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
        // Pre-gesture autoplay gate. The boot path (Marathon.init →
        // goToMenu → Music.start) hits this before the player has
        // interacted with the page; staying silent here avoids stashing
        // shouldPlay=true and having refreshFromAPI's auto-start hook
        // fire later without a gesture behind it. After the player
        // clicks anywhere — the intro Continue button, a mode button,
        // even a stray tap — the capture-phase listener above flips
        // gestureReady and the next start() call proceeds.
        if (!gestureReady) return;
        shouldPlay = true;
        paused     = false;
        if (muted) return;
        if (introPlaylist.length === 0 && shufflePlaylist.length === 0 && creditsPlaylist.length === 0 && menuPlaylist.length === 0) return;  // nothing to play yet
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

    // --- Mode + credits sequence -----------------------------------------
    // setMode is wired from the Settings popup. Changing modes mid-play
    // doesn't interrupt the current song — the next pickNext() respects
    // the new mode (refillShuffleQueue notices queueMode!==playMode and
    // rebuilds from the right pool).
    function setMode(mode) {
        if (mode !== 'none' && mode !== 'game_playlist' &&
            mode !== 'credits' && mode !== 'game_plus_credits') return;
        if (playMode === mode) return;
        playMode = mode;
        // Invalidate the shuffle queue so the next pull picks from the
        // correct pool. Credits cursor preserves position — moving away
        // from credits mode and back resumes where the player left off.
        queue = [];
    }
    function getMode() { return playMode; }

    // Start the end-credits sequence music. Forces the credits pool for
    // the duration of the sequence, regardless of the user's mode choice.
    // Stops any in-flight song first so the credits track starts cleanly
    // rather than fading into whatever was playing.
    function startCreditsSequence() {
        forceCredits = true;
        // Note: deliberately NOT resetting the credits shuffle bag here.
        // The bag's whole purpose is to cycle through every song before
        // repeating any — resetting on each credits roll would defeat
        // that, putting us back to the "first song every time" behavior
        // the bag was added to fix. The bag's fingerprint check + lazy
        // refill handle pool-changed and bag-drained cases naturally.
        // Don't poke the audio if the user has muted music — start() is a
        // no-op when muted anyway, but skipping the pause/load churn keeps
        // the silent-mode startup cheap.
        if (muted) {
            shouldPlay = true;   // remember intent so unmuting resumes
            return;
        }
        if (audio) {
            try { audio.pause(); } catch (e) {}
            audio.removeAttribute('src');
            audio.load();
        }
        shouldPlay = true;
        paused     = false;
        // Clear any in-flight gameplay history so prev doesn't rewind into
        // a song from before credits started — the credits sequence is a
        // fresh listening session conceptually.
        history = []; historyPos = -1;
        advanceToNext();
    }
    // End the end-credits sequence — release the forceCredits override
    // and stop playback. Called when the player dismisses the score popup
    // or otherwise leaves the credits screen.
    function stopCreditsSequence() {
        forceCredits = false;
        stop();
    }
    function stop() {
        shouldPlay  = false;
        paused      = false;
        if (audio) {
            try { audio.pause(); } catch (e) {}
            audio.removeAttribute('src');
            audio.load();
        }
        // INTENTIONALLY preserve `queue` (remaining shuffle indices) /
        // `history` / `lastPlayedId` / `introRemaining` across stops so
        // the curated playlist progresses BETWEEN games. Only the audio
        // element + current-song bookkeeping reset (so the Now Playing
        // UI hides). The shuffle bag is ALSO persisted to localStorage
        // by persistShuffleBag() so it additionally survives page
        // reloads — see SHUFFLE_REMAIN_KEY at top of module.
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
    // Both skip controls short-circuit during scripted playback —
    // the replay's audio is supposed to faithfully reproduce what the
    // original player heard, so the watcher manually skipping would
    // desync the audio from the scripted timeline.
    function skipNext() {
        if (!shouldPlay) return;
        if (scriptedPlayback) return;
        advanceToNext();
    }
    function skipPrev() {
        if (!shouldPlay) return;
        if (scriptedPlayback) return;
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
    // Multi-subscriber song-change listeners (separate from the legacy
    // single-slot onSongChange used by the now-playing UI). Recorder
    // and any future multi-listener consumer use add/remove here.
    const songChangeListeners = [];
    function addSongChangeListener(cb) {
        if (typeof cb !== 'function') return;
        if (songChangeListeners.indexOf(cb) >= 0) return;
        songChangeListeners.push(cb);
    }
    function removeSongChangeListener(cb) {
        const i = songChangeListeners.indexOf(cb);
        if (i >= 0) songChangeListeners.splice(i, 1);
    }
    function notifySongChange() {
        if (onSongChange) {
            try { onSongChange(currentSong, paused); }
            catch (e) { if (typeof Logger !== 'undefined') Logger.warn('Music: onSongChange threw', e); }
        }
        for (let i = 0; i < songChangeListeners.length; i++) {
            try { songChangeListeners[i](currentSong, paused); }
            catch (e) { if (typeof Logger !== 'undefined') Logger.warn('Music: songChangeListener threw', e); }
        }
    }

    // --- Scripted playback (for replay) -------------------------------
    // Plays a fixed schedule of songs at fixed times instead of pulling
    // from the normal pickNext pipeline. Used by the leaderboard replay
    // feature so a player watching another player's run hears the same
    // songs in the same order at the same timestamps the original
    // player heard. Events shape: [{ t: ms, songId: string }, ...]
    // where t is ms-since-replay-start; t=0 means "play immediately on
    // start." Sort order doesn't have to be guaranteed — we sort
    // defensively below.
    //
    // While scriptedPlayback is active, the normal advanceToNext /
    // skipNext / skipPrev paths short-circuit so the scheduled timeline
    // owns playback fully. Pause/resume on the audio element still
    // works (player can pause a replay) but won't picked the next
    // scripted song — that's driven by setTimeout.
    let scriptedPlayback = null;   // { timers: [Number] } when active, null when not
    // Replay-session state for the Now Playing box (separate from the
    // per-puzzle scriptedPlayback above). `replayActive` brackets the
    // whole replay — set by the replay driver (game.js) via setReplayActive
    // — so it stays true across the inter-puzzle gaps of a marathon replay
    // where scriptedPlayback is momentarily null. `replayHadMusic` records
    // whether the recording actually drove any music: it flips true the
    // first time scripted songs are scheduled and stays true for the rest
    // of the session. Together they let the Now Playing box show ONLY when
    // the original player had music on — a music-off run leaves
    // replayHadMusic false, so the box hides even though the watcher's own
    // menu music keeps playing silently underneath.
    let replayActive   = false;
    let replayHadMusic = false;
    function setReplayActive(on) {
        replayActive = !!on;
        // Each new replay session starts assuming no music until scripted
        // playback proves otherwise.
        if (on) replayHadMusic = false;
        // Re-evaluate the Now Playing box immediately: a music-off replay
        // schedules nothing (startScriptedPlayback no-ops without notifying),
        // so this is the only signal that tells the box to hide on start.
        notifySongChange();
    }
    function isReplayActive()    { return replayActive; }
    function didReplayHaveMusic() { return replayHadMusic; }
    function startScriptedPlayback(events) {
        stopScriptedPlayback();
        if (!events || !Array.isArray(events) || events.length === 0) return;
        // Drop menu-pool songs from the schedule. A game recording should
        // never contain menu music, but some PotD recordings (made by
        // clients that recorded before the menu→game music switch landed)
        // captured the menu track as their only music event. Scheduling it
        // would show a bogus menu title in Now Playing AND leave the replay
        // silent once that single song ends, because scripted playback
        // suppresses the normal auto-advance (see advanceToNext). Filtering
        // collapses an all-menu recording to an empty schedule → the no-op
        // return just below → the watcher's normal, still-auto-advancing
        // music simply keeps playing.
        const cleaned = events.filter(function (e) {
            const sid = e && (e.songId || (e.song && e.song.id));
            return sid && !isMenuPoolSong(sid);
        });
        if (cleaned.length === 0) return;
        scriptedPlayback = { timers: [] };
        // The recording drove real music — remember it for the whole replay
        // session so the Now Playing box stays visible across inter-puzzle
        // gaps (where scriptedPlayback briefly returns to null).
        replayHadMusic = true;
        // Refresh the Now Playing UI so it knows replay just started —
        // its callback hides the prev/pause/next controls during
        // scripted playback (since those are owned by the scripted
        // timeline). Without this, the controls stay visible until the
        // first recorded song-change event actually fires playSong.
        notifySongChange();
        // Sort by time ascending so the first event (often t=0) fires first.
        const sorted = cleaned.slice().sort(function (a, b) {
            return (a.t || 0) - (b.t || 0);
        });
        for (let i = 0; i < sorted.length; i++) {
            const e = sorted[i];
            const songId = e.songId || (e.song && e.song.id);
            if (!songId) continue;
            const delay = Math.max(0, e.t || 0);
            // The FIRST sorted event (index 0) is the "song that was
            // playing at this recording's start" anchor — not a deliberate
            // song change. In multi-puzzle marathon replays, each puzzle
            // calls startScriptedPlayback with its own musicEvents, and
            // the next puzzle's anchor frequently matches the song still
            // playing from the previous puzzle (because the original
            // player didn't skip). Without the continuity check below,
            // we'd reset the audio to t=0 on every cross-puzzle handoff
            // — the song the watcher is enjoying would start over every
            // time a puzzle solves. Subsequent events (i > 0) are
            // recorded song CHANGES the original player triggered, so
            // those always fire playSong unconditionally.
            const isAnchor = (i === 0);
            const playIt = function () {
                if (!scriptedPlayback) return;   // stopped between schedule and fire
                if (isAnchor && currentSong && currentSong.id === songId) {
                    // Same song already playing — let it keep going from
                    // wherever the audio element currently is. Later
                    // events in this recording will still fire on their
                    // own setTimeout schedule.
                    return;
                }
                const s = findById(songId);
                if (s) playSong(s);
            };
            if (delay === 0) {
                playIt();
            } else {
                scriptedPlayback.timers.push(setTimeout(playIt, delay));
            }
        }
    }
    function stopScriptedPlayback() {
        if (!scriptedPlayback) return;
        for (let i = 0; i < scriptedPlayback.timers.length; i++) {
            clearTimeout(scriptedPlayback.timers[i]);
        }
        scriptedPlayback = null;
        // Mirror the start side — refresh Now Playing so the controls
        // come back (and the panel itself may need to hide if the user
        // had music muted before the replay started).
        notifySongChange();
    }
    function isScriptedPlayback() { return scriptedPlayback !== null; }

    // Called by intro (true on dismiss), marathon/potd (false on game
    // start, true on quit-to-menu). Toggling the flag DOESN'T interrupt
    // the currently-playing song — the new phase takes effect on the
    // next pickNext (i.e. when the current song ends), which keeps
    // transitions smooth. If the player skips with the ⏭ button right
    // after a phase change, the new pool kicks in immediately.
    function setMenuPhase(on) {
        inMenuPhase = !!on;
    }
    // True iff currentSong's id is in the menu pool. Lets callers (e.g.
    // marathon goToMenu) skip the stop+start "restart menu music"
    // chain when the player is ALREADY hearing menu music — closing
    // the leaderboard while a menu song is playing shouldn't yank that
    // song off and replace it with a fresh menu song. Returns false
    // when nothing is playing or the song is from another pool.
    function isMenuSongPlaying() {
        if (!currentSong) return false;
        for (let i = 0; i < menuPlaylist.length; i++) {
            if (menuPlaylist[i].id === currentSong.id) return true;
        }
        return false;
    }

    return {
        start:                 start,
        stop:                  stop,
        setMuted:              setMuted,
        isMuted:               isMuted,
        isPaused:              isPaused,
        isPlaying:             isPlaying,
        togglePause:           togglePause,
        skipNext:              skipNext,
        skipPrev:              skipPrev,
        setVolume:             setVolume,
        getVolume:             getVolume,
        getCurrentSong:        getCurrentSong,
        setOnSongChange:        setOnSongChange,
        addSongChangeListener:    addSongChangeListener,
        removeSongChangeListener: removeSongChangeListener,
        startScriptedPlayback:    startScriptedPlayback,
        stopScriptedPlayback:     stopScriptedPlayback,
        isScriptedPlayback:       isScriptedPlayback,
        setReplayActive:          setReplayActive,
        isReplayActive:           isReplayActive,
        didReplayHaveMusic:       didReplayHaveMusic,
        setMode:               setMode,
        getMode:               getMode,
        setMenuPhase:          setMenuPhase,
        isMenuSongPlaying:     isMenuSongPlaying,
        isMenuSong:            isMenuPoolSong,
        startCreditsSequence:  startCreditsSequence,
        stopCreditsSequence:   stopCreditsSequence,
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

        const controlsEl = document.getElementById('nowPlayingControls');
        Music.setOnSongChange(function (song, paused) {
            // During a replay the box's visibility follows the ORIGINAL
            // player's music state, not the watcher's: show the recorded
            // song title iff the recording actually had music
            // (didReplayHaveMusic). A run recorded with music off drives no
            // scripted playback, so even though the watcher's own menu music
            // keeps playing silently underneath, the box stays hidden — it
            // must not surface the watcher's menu track as if it were the
            // replay's. Outside a replay it's the normal not-muted check.
            // Controls are hidden throughout a replay because skipNext/
            // skipPrev/pause are owned by the scripted timeline (dead UI).
            const replayActive = (typeof Music.isReplayActive === 'function' && Music.isReplayActive());
            const show = replayActive
                ? (typeof Music.didReplayHaveMusic === 'function' && Music.didReplayHaveMusic())
                : !Music.isMuted();
            if (song && show) {
                el.classList.add('visible');
                titleEl.textContent = song.name || '';
                if (pauseBtn) pauseBtn.textContent = paused ? '▶' : '⏸';
                if (controlsEl) controlsEl.style.display = replayActive ? 'none' : '';
            } else {
                el.classList.remove('visible');
                // Restore control visibility for the next showing — the
                // panel could be hidden mid-replay (e.g. mute toggled
                // while scriptedPlayback is null) and we don't want
                // stale display:none lingering on the controls.
                if (controlsEl) controlsEl.style.display = '';
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNowPlayingUI);
    } else {
        initNowPlayingUI();
    }
})();
