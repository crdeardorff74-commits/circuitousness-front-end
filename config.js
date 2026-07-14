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
const BACKGROUND_IMAGE_COUNT = 50;

// Mode-button thumbnails for the Marathon menu. Files are named
// {grid-base}x{paths}.png — `1x{N}.png` for regular tiles, `4x{N}.png` for
// quad. marathon.js wires src per button at init time.
const THUMBNAIL_URL_BASE =
    'https://github.com/crdeardorff74-commits/circuitousness-front-end/releases/download/Images/';

// Delay (ms) after a puzzle is solved before the success popup / credits
// cover the board — gives the player a moment to actually see the completed
// (gold) circuit, which matters most on phones where the popup fills the
// screen. In Marathon/Practice a tap during this window reveals the popup
// early; in PotD it's a fixed pause.
const SOLVE_REVEAL_DELAY_MS = 1000;

const AppConfig = {
    // TODO: set when back-end is deployed
    GAME_API: 'https://circuitousness-api.onrender.com/api',

    // TODO: shared auth/settings API for the Official Intelligence site
    AUTH_API: 'https://official-intelligence-api.onrender.com'
};

// Canonical public URL for share links. window.location is unreliable on
// itch.io — the game runs in a CDN iframe, so location is an opaque CDN URL
// rather than the listing page — so every share/copy-link action uses this
// fixed URL instead, on every host. (Worker-safe: a plain string, no DOM.)
const SHARE_URL = 'https://digeratist.itch.io/circuitousness';

// True on any CrazyGames origin — the published-game host
// (games.crazygames.com) or the per-game dev-portal preview subdomains
// (e.g. circuitousness.game-files.crazygames.com). Per CrazyGames QA
// requirements, several behaviors key off this:
//   - intro warning auto-skips (≤1-click-to-gameplay rule: with the menu
//     as the landing screen, any mode card is the one click; intro.js)
//   - custom fullscreen controls suppressed (prohibited — CG provides its
//     own fullscreen; the intro skip covers this since the toggle + key
//     shortcuts only register from the intro's init)
//   - share surfaces + cross-promo credits links hidden (no links to
//     playable versions elsewhere; html.is-crazygames CSS in styles.css)
//   - service worker registration skipped (PWA install is meaningless in
//     their iframe, and the SW update flow could reload mid-QA)
// Worker-safe: `location` exists in both window and worker scopes.
const IS_CRAZYGAMES = (typeof location !== 'undefined') &&
    /(^|\.)crazygames\.com$/i.test(location.hostname || '');

// Mirror the flag onto <html> so styles.css can gate rules on it (same
// mechanism as the .is-safari class set in index.html). The typeof guard
// keeps this file worker-safe for sw.js's importScripts.
if (IS_CRAZYGAMES && typeof document !== 'undefined') {
    document.documentElement.classList.add('is-crazygames');
}

// iPad / iPhone Safari can't follow GitHub's 302 redirects in <audio>
// elements (error code 4) and `fetch()` for SFX decoding can't read
// GitHub's responses (no CORS headers). On iOS we route music through
// the back-end's /api/music/<tag>/<filename> proxy, which fetches from
// GitHub server-side and streams the response with proper headers.
// (SFX always uses the proxy regardless of platform — fetch+decode
// needs CORS even on desktop. That URL is set in audio.js.)
// The iPad-disguised-as-Mac case (iPadOS 13+ Safari) reports platform =
// 'MacIntel' with maxTouchPoints > 1; catch that too.
const IS_IOS_AUDIO = (typeof navigator !== 'undefined') && (
    navigator.userAgent.indexOf('iPad')   !== -1 ||
    navigator.userAgent.indexOf('iPhone') !== -1 ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// Gameplay music. music.js fetches the per-game playlist from the umbrella
// API (AUTH_API/api/songs?game=<slug>) and resolves each row's filename
// against this base URL. Points at TANTЯO's music release so reused songs
// don't have to be duplicated into a Circuitousness-only releases repo —
// the admin tool already maps song memberships per-game, the underlying
// MP3s can live in one shared repo. On iOS, swaps the GitHub URL for the
// back-end proxy so Safari's redirect-unfollow issue doesn't kill it.
const MUSIC_BASE_URL = IS_IOS_AUDIO
    ? AppConfig.GAME_API + '/music/Music/'
    : 'https://github.com/crdeardorff74-commits/blockchainstorm-frontend/releases/download/Music/';

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
// Optional menu/lobby pool. When the player is on the main menu (between
// games, or right after dismissing the opening intro), music plays from
// this list on shuffle. When a game starts, music switches to the
// intro-then-shuffle paradigm above. Independent of the player's
// Settings.musicMode choice — that controls GAME music, not menu music.
// If the list is empty/missing in the admin, the menu phase silently
// falls through to playing from the intro/shuffle pool instead.
const MUSIC_MENU_LIST_NAME    = 'menu_only';
// End-credits pool. Played during the credits sequence that runs after a
// Marathon ends or a PotD puzzle is solved (regardless of music mode), and
// during regular play when the user picks the "End Credits" / "Gameplay +
// End Credits" mode in Settings. If empty/missing, the gameplay pool is
// used as a fallback so the credits sequence isn't silent.
const MUSIC_CREDITS_LIST_NAME = 'credits';

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
    START_TIME_SINGULAR:     [120, 160, 200, 240],
    START_TIME_QUAD:         [180, 240, 320, 380],
    TIME_DECREASE_PER_SOLVE: 10,
    TIME_FLOOR:              30,

    // Puzzle progression. Each solve grows EITHER rows or cols by one
    // (never both) with a 50/50 random pick per puzzle. The sequence is
    // rolled fresh at startGame and lazily extended by `dimsForLevel`,
    // so pre-gen's lookahead pins the upcoming choices and any later
    // call for the same level returns the same dims. Logical dims —
    // quad mode's underlying maze is 2× per axis. No upper cap.
    MIN_DIM_SINGULAR: 8,
    MIN_DIM_QUAD:    4,
    // Practice mode starts smaller and gentler than Marathon — new players
    // land in Practice (it's the default mode), so singular puzzles start
    // well below Marathon's baseline. The floor scales with path count so
    // more paths get more room: indexed by pathCount-1 → 2-path 6×6,
    // 3-path 8×8. The 1-path entry is superseded by startDimsFor's
    // 5×5 practice start (below) — kept only as the square fallback
    // should that override ever be removed. 4-path is NOT here —
    // it keeps the generator-mandated MIN_DIM_SINGULAR_4PATH (10×10) floor
    // regardless of mode, so the strict 4-path generator has room for all
    // 8 endpoints. Only the SINGULAR floor is lowered; quad already starts
    // at 4 (MIN_DIM_QUAD).
    MIN_DIM_PRACTICE_SINGULAR: [6, 6, 8],
    // Per-path-count minimum-dim override. 4-path puzzles need more grid
    // space than 1/2/3-path: 8 distinct perimeter endpoints + 4 DFS paths
    // competing for non-overlapping cells. At 8×8 (regular MIN_DIM) the
    // generator sometimes fails to place all 4 paths even with thousands
    // of attempts — paired with strict mode in maze.js, that would mean
    // the worker loops a long time. 10×10 (singular) / 6×6 (quad logical
    // = 12×12 physical) is comfortable. Used by minDimFor() below; falls
    // back to MIN_DIM_SINGULAR / MIN_DIM_QUAD when no override is set
    // for a given (quadMode, pathCount).
    MIN_DIM_SINGULAR_4PATH: 10,
    MIN_DIM_QUAD_4PATH:      6,
    // Single source of truth for "what's the min logical dim for THIS
    // (quadMode, pathCount)?". Callers: marathon.js's dimsForLevel,
    // game.js's STARTER_PLAN. Adding more overrides (3-path, etc.) is
    // a matter of adding the constant above + a branch here.
    // `practice` (optional) lowers the singular floor for Practice mode via
    // the per-path-count MIN_DIM_PRACTICE_SINGULAR table. The 4-path bump
    // still wins (those puzzles need the extra room regardless of mode), and
    // quad is unaffected since it already starts at MIN_DIM_QUAD.
    minDimFor: function (quadMode, pathCount, practice) {
        if (pathCount === 4) {
            return quadMode ? this.MIN_DIM_QUAD_4PATH : this.MIN_DIM_SINGULAR_4PATH;
        }
        if (practice && !quadMode) return this.MIN_DIM_PRACTICE_SINGULAR[pathCount - 1];
        return quadMode ? this.MIN_DIM_QUAD : this.MIN_DIM_SINGULAR;
    },
    // Level-1 start dims as {rows, cols} (cols = width) — the square
    // minDimFor baseline everywhere EXCEPT 1-path singular, which starts
    // deliberately smaller: 5×5 in BOTH Zen/Practice and Marathon (history:
    // Practice was 4×4 then 4 tall × 5 wide; Marathon was the flat 8×8
    // MIN_DIM_SINGULAR, then 5×5, then 6×6). The per-solve row/col growth
    // still climbs from there.
    // Callers: marathon.js dimsForLevel (adds growth per level) and
    // game.js STARTER_PLAN (pre-gen at Marathon's level-1 dims).
    startDimsFor: function (quadMode, pathCount, practice) {
        if (!quadMode && pathCount === 1) {
            return { rows: 5, cols: 5 };
        }
        const d = this.minDimFor(quadMode, pathCount, practice);
        return { rows: d, cols: d };
    },

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
    HINT_PENALTY_FRACTION: 0.25,
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
