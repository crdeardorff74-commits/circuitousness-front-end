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

// Leaderboard replay: cap on the dead time played between two recorded
// moves (ms). Recordings keep the player's REAL timestamps (and quit/
// resume gaps are already edited out at resume time by
// Game.restoreRecording), but a player who simply sat and thought for
// ten minutes mid-solve would otherwise make every watcher sit through
// those ten minutes. The replay compresses any inter-move gap beyond
// this to exactly this long — pacing under the cap is untouched, so
// replays stay faithful except during genuine dead air.
const REPLAY_MAX_GAP_MS = 15000;

const AppConfig = {
    // TODO: set when back-end is deployed
    GAME_API: 'https://circuitousness-api.onrender.com/api',

    // TODO: shared auth/settings API for the Official Intelligence site
    AUTH_API: 'https://official-intelligence-api.onrender.com'
};

// ---- First-visit detection -------------------------------------------
// "First visit" = this browser has never played: none of the consumed
// auto-start flag, a saved mode pick, or a saved leaderboard name. The
// latter two stop a RETURNING player who predates the auto-start feature
// from being treated as a newcomer.
//
// It lives HERE, in the first file loaded, rather than in marathon.js
// (which owns the auto-start) because index.html has to know the answer
// BEFORE FIRST PAINT — it decides whether the intro disclaimer is
// rendered at all, and a decision made at DOMContentLoaded flashes the
// gag for a frame first. marathon.js and intro.js both defer to this so
// there is exactly one definition of "new player".
//
// Worker-safe: the function only touches localStorage when CALLED, and
// sw.js's importScripts never calls it.
const FIRST_VISIT_AUTOSTART_KEY = PROJECT_SLUG + '_firstVisitAutoStarted_v1';
const FIRST_VISIT_KEYS = [
    FIRST_VISIT_AUTOSTART_KEY,
    PROJECT_SLUG + '_mode',
    PROJECT_SLUG + '_lastPlayerName',
];
// localStorage unavailable (private mode, quota) → NOT a first visit.
// Nothing can be consumed without storage, so every load would look
// brand new and the player would be locked into the newcomer path.
function isFirstVisitBrowser() {
    try {
        for (let i = 0; i < FIRST_VISIT_KEYS.length; i++) {
            if (localStorage.getItem(FIRST_VISIT_KEYS[i])) return false;
        }
        return true;
    } catch (e) { return false; }
}

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

// iOS Safari detection — used by music.js for the gesture-blessing
// workaround (iPad Safari only lets <audio>.play() succeed on elements
// first played inside a user-gesture handler). No longer affects URLs:
// audio now comes from the shared music host on every platform.
// The iPad-disguised-as-Mac case (iPadOS 13+ Safari) reports platform =
// 'MacIntel' with maxTouchPoints > 1; catch that too.
const IS_IOS_AUDIO = (typeof navigator !== 'undefined') && (
    navigator.userAgent.indexOf('iPad')   !== -1 ||
    navigator.userAgent.indexOf('iPhone') !== -1 ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
);

// Shared static audio host for ALL Official Intelligence games (the
// `oi-music` Netlify site — see oi-music/CLAUDE.md at the umbrella root).
// Serves direct 200s with CORS + immutable caching, which retired both
// old workarounds at once: no more GitHub-releases origin (Safari can't
// follow its 302s in <audio>, and fetch+decode got no CORS headers) and
// no more per-platform routing through the Render back-end proxy (which
// was burning the Render bandwidth allowance). Same base on every
// platform; audio.js derives its SFX URL from this host too.
const MUSIC_HOST = 'https://music.official-intelligence.art';

// Gameplay music. music.js fetches the per-game playlist from the umbrella
// API (AUTH_API/api/songs?game=<slug>) and resolves each row's filename
// against this base URL. The pool is shared across games — the admin
// tool's song memberships decide what plays where, not file location.
const MUSIC_BASE_URL = MUSIC_HOST + '/Music/';

// Music playback follows the intro-then-shuffle paradigm (universal rule
// 7b). Two list knobs from the admin API's `lists.*`:
//   INTRO   — curated artistic sequence. Plays ONCE per player in position
//             order, then never replays as a sequence. Admin edits
//             reconcile against saved per-player progress (new songs
//             queue in, played songs stay played) — they no longer
//             restart the sequence for existing players (see music.js
//             syncIntroState).
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
    // floored at TIME_FLOOR. Final formula at runtime:
    //   schedule = START_TIME_*[pathCount-1]
    //              - solvedCount × TIME_DECREASE_PER_SOLVE
    //   sizeCap  = TIME_PER_TILE_SINGULAR[pathCount-1] × rows × cols
    //              (singular only — quad skips the cap)
    //   fresh_ms = max(TIME_FLOOR, min(schedule, sizeCap)) × 1000
    //   carried  = min(timeRemaining, MAX_CARRY_SECONDS)
    // Arrays indexed by pathCount-1 → entries for 1, 2, 3, 4 paths.
    START_TIME_SINGULAR:     [120, 160, 200, 240],
    START_TIME_QUAD:         [180, 240, 320, 380],
    TIME_DECREASE_PER_SOLVE: 10,
    TIME_FLOOR:              30,
    // Size cap on fresh time (seconds per tile, singular only). Keeps the
    // early grant proportional to the grid instead of handing out the
    // flat START_TIME schedule — which was tuned back when singular
    // Marathon opened at 8×8-10×10, and on today's 4×4 start would grant
    // 120s for a board solvable in twenty.
    //
    // ⚠ RAISED 2026-08-06 from [1.875, 2.5, 3.125, 3.75] (user call).
    // At 1.875 the opening 4×4 granted exactly 30 SECONDS, against a
    // measured ~100s that a first-time player actually takes on their
    // first board. New players were being wiped out before solving
    // anything — and 70% of them never reached puzzle 3, which says the
    // early curve was mis-tuned for EVERYONE, not just newcomers.
    //
    // The old value was really solving a different problem: unlimited
    // banking let good players hoard 20 minutes within a few levels, and
    // starving the grant was an indirect fix whose collateral damage
    // landed entirely on whoever was slowest. MAX_CARRY_SECONDS below now
    // bounds hoarding DIRECTLY, so this can be generous without re-opening
    // that.
    //
    // At 5.0 the opening 4×4 grants 80s, and the cap stops binding around
    // puzzle 4 — from there the declining schedule governs exactly as
    // before, so mid/late game is untouched. Quad starts never shrank, so
    // quad still skips the cap entirely.
    //
    // WHY 5.0 AND NOT SOMETHING TIGHTER — modelled against real per-tile
    // solve rates (scratchpad check-timing.js walks these constants
    // through the actual arithmetic). Puzzles solved before the clock
    // runs out:
    //
    //                       learning  competent  strong  expert
    //   OLD 1.875/tile             0         12      20      27
    //   NEW 5.0/tile               6         11      16      19
    //
    // The old tuning handed a score of ZERO to every player slower than
    // "competent" — which is most of them, and matches the funnel's 70%
    // who never reached puzzle 3. That is the bug being fixed.
    //
    // Above ~3.5 the value stops affecting skilled players at all (3.5
    // and 5.0 both give 11/16/19): once the cap stops binding, the
    // declining schedule governs and it is the same for everyone. So the
    // extra generosity is FREE past that point and buys exactly one
    // thing — a first board a genuine newcomer can finish. The failure
    // modes are wildly asymmetric: too tight means score 0 and leave;
    // too loose just means tension arrives on board 3 instead of board 1.
    //
    // Accepted cost: the top-end spread compresses (expert 27 → 19), so
    // the leaderboard separates strong from expert less sharply.
    TIME_PER_TILE_SINGULAR:  [5.0, 5.5, 6.0, 6.5],
    // Ceiling on CARRIED-OVER time (seconds) — the most a player may
    // bring INTO a puzzle from previous ones. This puzzle's own fresh
    // grant is then added on top:
    //     timeRemaining = min(timeRemaining, MAX_CARRY_SECONDS) + fresh
    //
    // ⚠ THIS IS A CARRY CAP, NOT A TOTAL CAP, AND THE DIFFERENCE IS THE
    // WHOLE POINT. v1.56 capped the TOTAL at 150s, and since grants are
    // themselves 80-120s the cap bound on literally every puzzle: the
    // clock read exactly 2:30 at the start of every board for the rest
    // of the run, no matter how well the player played. Banking rewarded
    // nothing. Capping the carry instead means the starting clock always
    // moves — solve fast and you bring more in, solve slowly and you
    // bring less — while hoarding stays impossible BY CONSTRUCTION: you
    // can never enter a puzzle with more than this, so the 20-minute
    // cushions that made unlimited banking untenable simply can't form.
    //
    // A carry cap also needs no claw-back guard. The old total cap did:
    // quad skips the size cap and can be granted 380s, so min(total,150)
    // would have handed that over and immediately taken 230 back. Adding
    // the grant AFTER the cap can never subtract what was just awarded.
    //
    // Tuning: 90 gives a competent player a starting clock in the
    // 150-210s band that rises and falls with the grant schedule instead
    // of flatlining. Lower it to tighten the mid-game.
    //
    // KNOWN LIMIT: for competent-and-better players the grant exceeds
    // what they consume, so they sit AT the carry cap most of the run and
    // skill barely separates them. The real lever for that is making the
    // grant taper — TIME_DECREASE_PER_SOLVE is currently cancelled out by
    // the START_TIME bump at every tier-up — but that's a difficulty
    // retune, not a banking fix, and it should be measured before it's
    // changed.
    MAX_CARRY_SECONDS:       90,

    // Puzzle progression. Each solve grows EITHER rows or cols by one
    // (never both), randomly BUT wider-first: cols never fall behind rows
    // (at square the growth is always cols; once wider, 50/50), so grids
    // meander between square and wide and are never taller than wide.
    // The sequence is rolled fresh at startGame and lazily extended by
    // `dimsForLevel`, so pre-gen's lookahead pins the upcoming choices
    // and any later call for the same level returns the same dims.
    // Logical dims — quad mode's underlying maze is 2× per axis. No
    // upper cap.
    MIN_DIM_SINGULAR: 8,
    MIN_DIM_QUAD:    3,
    // Per-path-count minimum-dim override. Both are now effectively dead
    // knobs kept as documented fallbacks: startDimsFor (below) pins ALL
    // singular starts to 4×4, and QUAD_4PATH equals the plain quad
    // floor — q4 starts 3×3 logical like every other quad count
    // (2026-07-16: 8 → 6 → 4; 2026-07-28: 3 with the quad-start shrink).
    // Rationale: even 3×3 logical is a 6×6 physical maze — more room
    // than the 4×4 the singular 4-path
    // generator handles fine. SINGULAR_4PATH's 10 dates from the ORIGINAL
    // linear placement that couldn't reliably fit 4 paths even at 8×8;
    // the backtracking `place()` search in maze.js (which undoes paths
    // 2/3 when path 4 gets boxed out) made 4-path builds succeed even on
    // tiny grids — worst case a few seconds of retries in the strict loop.
    MIN_DIM_SINGULAR_4PATH: 10,
    MIN_DIM_QUAD_4PATH:      3,
    // Min logical dim for THIS (quadMode, pathCount). Since the 5×5
    // singular unification only the quad branch is reachable via
    // startDimsFor, but the function is kept whole as the documented
    // fallback. Adding overrides (3-path, etc.) is a matter of adding
    // the constant above + a branch here.
    minDimFor: function (quadMode, pathCount) {
        if (pathCount === 4) {
            return quadMode ? this.MIN_DIM_QUAD_4PATH : this.MIN_DIM_SINGULAR_4PATH;
        }
        return quadMode ? this.MIN_DIM_QUAD : this.MIN_DIM_SINGULAR;
    },
    // Level-1 start dims as {rows, cols} (cols = width). Singular starts
    // 4×4 logical, quad 3×3 logical (= 6×6 physical) — every path tier,
    // in BOTH Zen/Practice and Marathon. Singular dropped 5×5 → 4×4 with
    // the 2026-07 progressive-type revamp: a run now opens on a tiny
    // 1-path warm-up and the tier ramp does the difficulty work. Quad
    // dropped 4×4 → 3×3 logical 2026-07-28 (user call): 4×4 logical is
    // already a 64-sub-tile board — a big first bite, especially at the
    // first-run fast track's quad hand-off.
    // (History: singular 1-path went 4×4 → 4×5/5×5 → 6×6 → 5×5 → 4×4;
    // 2/3/4-path sat on the 6/8/10 MIN_DIM floors until Debug-mode
    // testing showed the backtracking 4-path generator is fine on tiny
    // grids.) Quad keeps the minDimFor floors (3 for every count):
    // logical dims are 2× physical, so quad 3×3 is still a 6×6 maze.
    // The per-solve row/col growth (with tier drops) climbs from here.
    // Callers: marathon.js dimsForLevel (adds growth per level) and
    // game.js STARTER_PLAN (pre-gen at Marathon's level-1 dims).
    startDimsFor: function (quadMode, pathCount) {
        if (!quadMode) {
            return { rows: 4, cols: 4 };
        }
        const d = this.minDimFor(quadMode, pathCount);
        return { rows: d, cols: d };
    },

    // Leaderboard storage. Top N entries shown per game type.
    // Per universal rule 7a: 20.
    LEADERBOARD_TOP_N: 20,

    // Surge leaderboard ERA. Appended to the local board / pending-submit
    // / own-recording localStorage keys, so bumping it retires every
    // cached client-side score at once.
    //
    // ⚠ BUMP THIS whenever a balance change makes scores incomparable —
    // a run's score is only meaningful against others played under the
    // same clock. Set to 'v2' on 2026-08-06 with the time rebalance
    // (TIME_PER_TILE_SINGULAR raised, MAX_CARRY_SECONDS added), which made
    // early puzzles markedly more generous.
    //
    // This only clears the CLIENT. The server side is a separate, manual
    // step: POST /api/admin/wipe-leaderboards with {"scope":"marathon"}.
    // ⚠ Do NOT call that endpoint without a scope — the default wipes
    // PotD's boards and sessions too, which have nothing to do with a
    // Surge rebalance and are real player history.
    LEADERBOARD_ERA: 'v2',

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

    // Progressive-mode tier tuning. A Zen/Marathon run ramps its path
    // count 1→MAX_PATHS: every TIER_LENGTH puzzles the path count steps
    // up and the growth accumulator drops back TIER_DROP steps. With
    // DROP 1 the accumulator drop exactly cancels the new level's +1,
    // so each tier opens at the SAME size as the last puzzle solved —
    // "same board, one more color". After MAX_PATHS the growth is
    // endless. Progression is a pure function of level — see
    // marathon.js pathCountForLevel / growthStepsForLevel.
    // History: 5/3 originally (each tier opened 2 sizes smaller). User
    // insight (2026-07-23): more paths on a SMALLER grid stacks two
    // easing effects — fewer tiles AND higher path density (fewer
    // filler decoys, more doubly-constrained tiles) — creating a
    // difficulty dip at every tier boundary. 4/1 makes size the
    // monotonic difficulty axis and path count the variety axis;
    // 4 paths arrive at puzzle 13 instead of 16. If the 4-path arrival
    // (~8×9) feels abrupt in playtesting, the softer variant is
    // TIER_DROP 2 (a one-size breather per boundary).
    TIER_LENGTH: 4,
    TIER_DROP:   1,
    MAX_PATHS:   4,

    // Twin-tile coverage ramp across a run (user call 2026-07-31): no
    // twins on puzzles 1-2, a single twin set at TWIN_RAMP_START_LEVEL,
    // then coverage climbs linearly to maze.js's full TWIN_COVERAGE
    // (30%) at TWIN_RAMP_FULL_LEVEL and plateaus there. The scale is a
    // pure function of level, mirroring pathCountForLevel — applies to
    // every Zen/Marathon run (progressive AND legacy fixed-path types,
    // singular and quad alike). PotD and debug builds don't pass a
    // scale and stay at full coverage.
    // twinScaleForLevel returns the 0..1 multiplier for TWIN_COVERAGE:
    //   L1-2 → 0;  L3 → 0.1 (with maze.js's ≥1-group rule that lands
    //   exactly one set);  +0.1 per level;  L12+ → 1.
    TWIN_RAMP_START_LEVEL: 3,
    TWIN_RAMP_FULL_LEVEL:  12,
    twinScaleForLevel: function (lev) {
        const a = this.TWIN_RAMP_START_LEVEL;
        const b = this.TWIN_RAMP_FULL_LEVEL;
        if (lev < a)  return 0;
        if (lev >= b) return 1;
        return (lev - a + 1) / (b - a + 1);
    },

    // ----- Onboarding staircase -----
    // ONE new thing per puzzle, each on its own board. These four levels
    // must stay DISTINCT and in this order, because every one of them
    // pops a tooltip and two on the same puzzle means one lands under the
    // other. That is exactly what kept happening while these were tuned
    // (2026-08-02, three rounds of it).
    //
    //   L3  TWIN_RAMP_START_LEVEL  — first colored tiles  → twinTiles tip
    //   L4  ZEN_GATE_START_LEVEL   — first red gate       → gates tip
    //   L5  (literal in marathon.js onPuzzleReady)        → potdNudge tip
    //   L6  LOCK_TIP_MIN_LEVEL     — earliest lock tip    → lockTile tip
    //
    // Levels are INTERNAL. On the first-visit auto-start run the two
    // warm-up puzzles push the displayed numbers up by 2, so a
    // first-timer meets these on puzzles 5, 6, 7 and 8.
    //
    // First gate on a Zen run; before this the board is gate-free. Gates
    // are the mechanic newcomers find most confusing (they rotate in
    // unison — the opposite of the per-tile lesson a first puzzle is
    // teaching), and Zen is where brand-new players land. Marathon is
    // untouched: it's chosen deliberately, and its clock makes an easier
    // opening a scoring advantage rather than a kindness. Read by
    // game.js's gate-placement block. History: 3 → 5 → back to 3 → 4.
    ZEN_GATE_START_LEVEL: 4,
    // Earliest puzzle the 30-second lock tip may be scheduled on
    // (marathon.js scheduleLockTip). Every other tip fires at a puzzle
    // BOUNDARY; this one is on a timer, so without a floor it drops on
    // top of whatever the boundary just put up. Sits one puzzle past the
    // PotD nudge so it's last in the staircase.
    LOCK_TIP_MIN_LEVEL: 6,

    // Compressed tier ladder for the FIRST-VISIT auto-start Zen run only
    // (marathon.js autoStartFirstPractice → levelConfig). Entry i = how
    // many puzzles that run spends at (i+1) paths before stepping up, so
    // [3,2,2,2] means 3 one-path puzzles, then 2 each at 2/3/4 paths —
    // 9 puzzles total, after which the run switches to QUAD tiles and
    // resets to 1 path (FIRST_RUN_QUAD_RESET_PATHS).
    //
    // Why a separate ladder: a first session that only ever shows
    // singular tiles teaches "this game is bigger grids", which is a thin
    // reason to return (D1 was the failed CrazyGames metric). Reaching
    // quad inside one session shows there's a second mechanic. The
    // compression is on the VARIETY axis only — growth steps still
    // accrue one per solve with the usual TIER_DROP, so grid size climbs
    // exactly as it always did and each tier still opens at the size of
    // the last puzzle solved.
    //
    // The quad hand-off deliberately resets to 1 path: a 4-path quad
    // would stack the hardest generator, the least familiar mechanic and
    // extra gates all at once, AND it's the slowest build in the game.
    // At 1 path / 3×3 logical the first quad board is exactly the
    // pre-built 'q' STARTER (game.js STARTER_PLAN), which
    // invalidatePreGen preserves — so the reveal is instant instead of
    // showing "Building puzzle…" at the worst possible moment.
    //
    // Sum is the knob that matters: raise entries to delay the quad
    // reveal, lower them to pull it in. (The tiers only apply to the
    // 'fast' variant below.)
    //
    // FIRST-RUN A/B/C/D EXPERIMENT (user call 2026-07-29, replacing the
    // short-lived FIRST_RUN_FAST_TRACK boolean): each NEW player's
    // auto-start run randomly draws one of four ladder variants, the
    // draw is stamped on their first_run_stats row, and the admin
    // panel's First-Time Players section breaks engagement out per
    // variant — after a few days of data the winner gets locked in for
    // the rest of the CrazyGames trial via FIRST_RUN_VARIANT_FORCE.
    //   'fast'     — the compressed FIRST_RUN_TIERS ladder above + quad
    //                hand-off (the v1.16 behavior).
    //   'standard' — the normal Zen ladder: TIER_LENGTH (4) whole
    //                puzzles per path count.
    //   'extended' — a slower ladder: FIRST_RUN_EXTENDED_TIER_LENGTH
    //                (6) puzzles per path count.
    //   'single'   — 1 path forever; the grid just keeps growing.
    // ASSIGNMENT IS SERVER-SIDE since 2026-08-01 (user call). The client
    // used to draw uniformly at random per browser — unbiased, but at
    // n=45 the arms had landed 6/8/14/17, which is ordinary sampling
    // noise yet expensive when every arm is that thin. The server now
    // hands out the LEAST-USED arm when it creates the row (which only
    // happens once the player actually plays, so bouncers can't consume
    // slots), and the client adopts what comes back.
    //
    // This works because the four ladders are IDENTICAL for the first
    // FIRST_RUN_SHARED_LEVELS puzzles — the earliest divergence is the
    // fast track's 2-path step at puzzle 4 — so the client needs no
    // variant at all until then, and an unknown variant simply runs the
    // standard ladder (which matches every arm over that stretch). The
    // sync fires on the player's first move of puzzle 1, leaving three
    // whole puzzles for the round trip. If the answer somehow hasn't
    // arrived by the divergence point, marathon.js draws locally and
    // LOCKS that arm, sending it so the server records what was actually
    // played. Keep this in step with FIRST_RUN_TIERS[0].
    FIRST_RUN_SHARED_LEVELS: 3,
    // FIRST_RUN_VARIANT_FORCE: null = server assigns per new player;
    // set to one of the four names to lock every new player to it (the
    // client then forces it locally AND asserts it to the server, so the
    // lock-in works without a back-end deploy).
    //
    // LOCKED to 'standard' 2026-08-05, when the CrazyGames trial ended and
    // the traffic that made the experiment measurable stopped with it. NOT
    // because standard won — at 53 engaged players per arm nothing could
    // win, and every behavioural column in the ladder table came down to
    // 1-7 players. Locking is about cleaning up FUTURE measurement: on
    // organic traffic a four-way split will never reach significance, and
    // leaving it running dilutes every other thing we try to measure.
    // 'standard' is the neutral baseline, and since all four ladders are
    // identical through puzzle 3 — where ~70% of players are lost — the
    // arm barely touches the population we actually need to keep.
    FIRST_RUN_VARIANT_FORCE: 'standard',
    FIRST_RUN_VARIANTS: ['fast', 'standard', 'extended', 'single'],
    FIRST_RUN_EXTENDED_TIER_LENGTH: 6,
    FIRST_RUN_TIERS: [3, 2, 2, 2],
    FIRST_RUN_QUAD_RESET_PATHS: 1,

    // WARM-UP PUZZLES — added 2026-08-02, REMOVED 2026-08-05.
    // A new player's run opened on a 3×3, then a 3-row × 4-col, before
    // the standard 4×4. The premise was that the opening was too hard.
    // The data said otherwise: 86.5% of new players solve at least one
    // puzzle, and of those who never reached three real ones, 81% had
    // already solved something before leaving. Never a difficulty
    // problem.
    //
    // What they actually did was add two more near-identical boards to
    // the front of a run that loses ~20% of its players per
    // near-identical board — measured at 19.3% / 20.2% / 21.3% on the
    // 3×3, the 4×3 and the 4×4, three boards differing in nothing but
    // size. They spent a newcomer's most valuable twenty seconds on
    // puzzles with no challenge, no colour and nothing to discover,
    // which is what CrazyGames' quality guidance warns against directly
    // ("no overly repetitive or boring tasks", "balanced and well-paced").
    //
    // Their real contribution was diagnostic: splitting the funnel's 0
    // bucket revealed that 223 players SUCCEED and leave anyway, which
    // reframed the whole problem from difficulty to reward. THAT
    // ANALYTICS SURVIVES THEM — `first_run_stats.warmup_puzzles` and the
    // admin histogram's -2 / -1 buckets are deliberately kept for the
    // historical rows and for old cached clients still reporting. They
    // just stop growing. Don't clean them up.

    // ----- First session: PRACTICE → SURGE -----
    // A brand-new player used to be dropped into Zen. Two failed
    // CrazyGames trials say that was wrong, and the structural reason is
    // that ⚠ ZEN HAS NO TERMINAL STATE: a Zen run only ends when the
    // player quits, so the game never gets a moment to make a pitch —
    // every retention surface fires at someone already leaving (only
    // 9.2% ever voluntarily started anything after their first run).
    // Surge ends FOR them, at tension, with a number attached, and
    // "maybe I can do better" is a reason to press a button.
    //
    // So the first session is now: three clearly-labelled PRACTICE
    // puzzles, then a pitch, then real Surge.
    //
    // Each practice puzzle introduces exactly ONE thing, because the
    // funnel showed abandon rates roughly DOUBLING (20% → 32-39%) on any
    // board that introduced a mechanic. Spreading them is the whole
    // point; do not merge these into two.
    //   1. the basic twist-to-connect loop, nothing else
    //   2. + twin tiles      (fires the animated twin demo)
    //   3. + gates           (fires the animated gate demo)
    //
    // TWO gates on board 3, not one (user call 2026-08-21, and the
    // game-wide floor in game.js's target formula matches): all gates
    // share one rotation delta, so a LONE gate is trivial — one twist
    // parks it clear of the route and nothing else moves. The mechanic's
    // actual bite is that clearing one gate can swing another INTO the
    // way, and a single-gate board can't even hint at that. Still one
    // mechanic, so the one-thing-per-board rule above holds.
    //
    // `twinScale` / `gates` are passed EXPLICITLY rather than left to the
    // ramps (TWIN_RAMP_START_LEVEL, ZEN_GATE_START_LEVEL): those are
    // tuned for a long ladder and would put both mechanics on the same
    // early board. `teachGate` asks assignGates for a gate that genuinely
    // blocks the route — a decorative one teaches nothing (only ~20% of
    // random placements actually obstruct; see gates-test.js).
    //
    // Sizes stay small and grow by one step so the sequence feels like
    // progress without ever being the difficulty.
    FIRST_RUN_PRACTICE: [
        { rows: 4, cols: 4, twinScale: 0,   gates: 0, teachGate: false },
        { rows: 4, cols: 5, twinScale: 0.1, gates: 0, teachGate: false },
        { rows: 5, cols: 5, twinScale: 0.1, gates: 2, teachGate: true  },
    ],

    // Aspect cap on grid growth: neither logical dimension may grow to
    // MORE than this ratio × the other. Growth still favors the
    // viewport's long axis (landscape runs wide, portrait runs tall),
    // but without a cap the 50/50 phase could drift into ribbon grids
    // (a 4×12 was observed). A ratio — not a fixed unit gap — so the
    // allowed spread scales with the grid (user call, superseding the
    // brief fixed-2-units version): at 1.5, 4×6 early, 10×15 late.
    // (Loosened 1.3 → 1.5, 2026-07-23 user call.) Enforced per roll in
    // ensureGrowthSequence.
    MAX_ASPECT_RATIO: 1.5,

    // 2 progressive game types: singular ('s') and quad ('q'). The path
    // count is no longer part of the type — it ramps within the run (see
    // the tier constants above). History: was 8 fixed types s1..s4/q1..q4
    // (singular/quad × 1-4 paths); those ids live on in PotD's slots
    // (potd.js SLOTS), legacy saved runs, and retired leaderboards.
    TYPES: ['s', 'q']
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
