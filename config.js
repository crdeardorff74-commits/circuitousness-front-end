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

// Cross-origin assets (precached by sw.js, drawn by render.js).
const BACKGROUND_IMAGE_URL =
    'https://github.com/crdeardorff74-commits/circuitousness-front-end/releases/download/Images/level1.jpg';

// Mode-button thumbnails for the Marathon menu. Files are named
// {grid-base}x{paths}.png — `1x{N}.png` for regular tiles, `4x{N}.png` for
// quad. marathon.js wires src per button at init time.
const THUMBNAIL_URL_BASE =
    'https://github.com/crdeardorff74-commits/circuitousness-front-end/releases/download/Images/';

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
    // Per-puzzle starting time, seconds × tile count.
    TIME_PER_TILE_SINGULAR: 2,
    TIME_PER_TILE_QUAD:    4,
    // Carry-over cap after a solve, seconds × tile count of the JUST-FINISHED puzzle.
    TIME_CAP_PER_TILE_SINGULAR: 7,
    TIME_CAP_PER_TILE_QUAD:    12,

    // Puzzle progression. Dims grow one dim at a time, period-4 cycle:
    // (singular) 8×8 → 8×9 → 9×9 → 10×9 → 10×10 → 10×11 → 11×11 → 12×11 → …
    // (quad)    6×6 → 6×7 → 7×7 → 8×7  → 8×8  → 8×9  → 9×9  → 10×9  → …
    // Logical dims — quad mode's underlying maze is 2× per axis. Same step
    // pattern for both, just a different starting size. No upper cap.
    MIN_DIM_SINGULAR: 8,
    MIN_DIM_QUAD:    6,

    // Leaderboard storage. Top N entries kept per game type.
    LEADERBOARD_TOP_N: 10,

    // After a solve, wait for the player to click before building the next
    // puzzle — gives them time to read the banked-time message instead of
    // being whisked into the next puzzle. (Was a fixed auto-advance, but
    // players reported it was too easy to miss the win cue and feel like
    // the game was running ahead of them.)

    // Each hint use lops off this fraction of the player's remaining time.
    // 0.25 = lose 25% (keep 75%) — a meaningful penalty without being brutal.
    HINT_PENALTY_FRACTION: 0.25,

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
