/**
 * Centralized configuration for Circuitousness
 * All API endpoints and shared utilities in one place.
 * This file must be loaded before all other scripts.
 *
 * Per universal rule 1, two constants live here:
 *   PROJECT_NAME — display name (mixed case, may contain non-ASCII).
 *   PROJECT_SLUG — lowercase, hyphen-separated, ASCII-only short identifier
 *                  used by sw.js (CACHE_NAME), i18n.js / index.html (storage
 *                  key namespacing), and any other slug-shaped value.
 *
 * sw.js loads this file via importScripts(), so this file must remain safe
 * to evaluate in a service-worker context — no DOM, window, or document
 * references at module top level.
 */
const PROJECT_NAME = 'Circuitousness';
const PROJECT_SLUG = 'circuitousness';

// Background image pool. 54 files in the GitHub release, named
// level1.jpg .. level54.jpg. render.js draws one at random per puzzle
// via a shuffle bag (no repeats until all 54 have been shown, plus a
// boundary-avoid so a freshly-refilled bag can't open with the same
// image that just played). Not precached by sw.js — too heavy; the
// browser HTTP cache handles repeats well enough.
const BACKGROUND_IMAGE_URL_BASE =
    'https://github.com/crdeardorff74-commits/circuitousness-front-end/releases/download/Images/';
const BACKGROUND_IMAGE_COUNT = 54;

// Mode-button thumbnails for the Marathon menu. Files are named
// {grid-base}x{paths}.png — `1x{N}.png` for regular tiles, `4x{N}.png` for
// quad. marathon.js wires src per button at init time.
const THUMBNAIL_URL_BASE =
    'https://github.com/crdeardorff74-commits/circuitousness-front-end/releases/download/Images/';

// Gameplay music. music.js fetches the per-game playlist from the umbrella
// API (AUTH_API/api/songs?game=<slug>) and resolves each row's filename
// against this base URL. Points at TANTЯO's music release so reused songs
// don't have to be duplicated into a Circuitousness-only releases repo —
// the admin tool already maps song memberships per-game, the underlying
// MP3s can live in one shared repo. Same iPad/iOS caveat as the SFX
// system: GitHub 302 redirects don't follow in <audio> elements; would
// need a backend proxy to support iOS.
const MUSIC_BASE_URL =
    'https://github.com/crdeardorff74-commits/blockchainstorm-frontend/releases/download/Music/';

// Music playback follows the intro-then-shuffle paradigm (universal rule
// 7b). Two list knobs from the admin API's `lists.*`:
//   INTRO   — curated artistic sequence. Plays ONCE per player in position
//             order, then never replays as a sequence (admin reorders auto-
//             restart it via fingerprint mismatch).
//   SHUFFLE — random pool that plays forever after the intro is exhausted.
// If SHUFFLE is empty/missing, music.js falls back to shuffling the INTRO
// list so single-list projects still get post-intro variety.
const MUSIC_INTRO_LIST_NAME   = 'album_intro';
const MUSIC_SHUFFLE_LIST_NAME = 'gameplay';

const AppConfig = {
    // TODO: set when back-end is deployed
    GAME_API: 'https://circuitousness-api.onrender.com/api',

    // TODO: shared auth/settings API for the Official Intelligence site
    AUTH_API: 'https://official-intelligence-api.onrender.com'
};

// ----- Marathon mode tuning -----
// "Tile" here = the visible/interactable unit. Singular: each cell is a tile.
// Quad: each 2×2 sub-tile group is a tile (so a 4×4 quad puzzle = 16 tiles,
// even though the underlying maze is 8×8 sub-tiles).
const MARATHON = {
    // Per-puzzle starting allotment (seconds). Each puzzle solved trims
    // TIME_DECREASE_PER_SOLVE seconds from the NEXT puzzle's fresh time,
    // floored at TIME_FLOOR. Banking is UNLIMITED — leftover time rolls
    // forward without a cap. Final formula at runtime:
    //   fresh_ms = max(TIME_FLOOR,
    //                  START_TIME_*[pathCount-1]
    //                  - solvedCount × TIME_DECREASE_PER_SOLVE) × 1000
    //   timeRemaining += fresh_ms   (no cap on the running total)
    // Arrays indexed by pathCount-1 → entries for 1, 2, 3, 4 paths.
    START_TIME_SINGULAR:     [90, 120, 150, 180],
    START_TIME_QUAD:         [120, 160, 200, 240],
    TIME_DECREASE_PER_SOLVE: 15,
    TIME_FLOOR:              30,

    // Puzzle progression. Each solve grows EITHER rows or cols by one
    // (never both) with a 50/50 random pick per puzzle. The sequence is
    // rolled fresh at startGame and lazily extended by `dimsForLevel`,
    // so pre-gen's lookahead pins the upcoming choices and any later
    // call for the same level returns the same dims. Logical dims —
    // quad mode's underlying maze is 2× per axis. No upper cap.
    MIN_DIM_SINGULAR: 8,
    MIN_DIM_QUAD:    6,

    // Leaderboard storage. Top N entries shown per game type.
    // Per universal rule 7a: 20.
    LEADERBOARD_TOP_N: 20,

    // After a solve, wait for the player to click before building the next
    // puzzle — gives them time to read the banked-time message instead of
    // being whisked into the next puzzle. (Was a fixed auto-advance, but
    // players reported it was too easy to miss the win cue and feel like
    // the game was running ahead of them.)

    // Each hint use lops off this fraction of the player's remaining time,
    // with a floor of HINT_PENALTY_MIN_MS so the cost never falls below a
    // meaningful threshold. Without the floor, the fractional penalty
    // approaches zero as the timer winds down and the player can spam
    // hints to solve a puzzle for nearly free.
    HINT_PENALTY_FRACTION: 0.33,
    HINT_PENALTY_MIN_MS:   10000,

    // 8 game types: singular/quad × 1..4 paths. Stored as keys 's1'..'s4', 'q1'..'q4'.
    TYPES: ['s1', 's2', 's3', 's4', 'q1', 'q2', 'q3', 'q4']
};

/**
 * Lightweight logger with level control.
 * Set Logger.level to 'debug' | 'info' | 'warn' | 'error' | 'off'.
 */
const Logger = {
    level: 'info',
    _levels: { debug: 0, info: 1, warn: 2, error: 3, off: 4 },
    _shouldLog(level) { return this._levels[level] >= this._levels[this.level]; },
    debug(...args) { if (this._shouldLog('debug')) console.log(...args); },
    info(...args)  { if (this._shouldLog('info'))  console.log(...args); },
    warn(...args)  { if (this._shouldLog('warn'))  console.warn(...args); },
    error(...args) { if (this._shouldLog('error')) console.error(...args); }
};
