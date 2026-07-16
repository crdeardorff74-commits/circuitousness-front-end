/**
 * render.js — Circuitousness canvas renderer.
 *
 * Draws the SIZE×SIZE grid of beveled tiles with grooved paths between them.
 * Each tile's WALLS are drawn as beveled polygons that leave the path channel
 * empty: cross = 4 corner squares, straight = two side bars, elbow = an
 * outer-L polygon whose concave corner is replaced by a quarter-arc + a 1×1
 * inner-corner wall whose path-facing corner is also replaced by a quarter-
 * arc. Light is fixed in screen space (top-left), so each wall edge — including
 * each chord along the tessellated arcs — picks its shade by interpolating
 * between the four cardinal palette stops based on its outward normal. The
 * body background image shows through the empty channel; the un-lit channel
 * band composites over it at DIM_ALPHA, and lit segments paint at full
 * opacity on top. Elbow
 * path grooves are stroked along the same quarter-arc as the centerline
 * (radius cellSize/2 around the cell corner shared by both ports). See
 * bevel-test.html for the standalone prototype this polygon approach mirrors.
 *
 * Public API:
 *   Render.init(canvas)     — bind the canvas, install resize handler
 *   Render.draw()           — repaint everything (call after any state change)
 *   Render.cellAt(x, y)     — translate canvas-pixel coords to {row, col} or null
 */

const Render = (() => {
    // Visual constants (relative to cell size)
    const GROOVE_RIM_FRAC = 0.04;  // shadow-rim thickness around the groove
    const ARC_SEGMENTS    = 16;    // chord count per quarter-arc on elbow walls
    const SEAM_OVERLAP    = 0.5;   // px — close canvas AA gaps between adjacent bevel polygons

    // --- DEBUG: live-tunable via debug-panel sliders in index.html ---
    let GROOVE_FRAC      = 0.17;   // groove width as a fraction of cell
    let BEVEL_FRAC       = 0.07;   // bevel thickness as a fraction of cell
    let TILE_FACE_ALPHA  = 0.74;   // opacity of the inner tile-face fill (bevels stay opaque)
    let LOCK_FACE_COLOR  = '#ffffff'; // face color for player-locked tiles (bevels stay normal)
    let COMPLETE_CIRCUITS = false; // false (default) = entry/exit stubs end in square terminal pads; true = paths wrap the grid perimeter
    function setCompleteCircuits(on) {
        COMPLETE_CIRCUITS = !!on;
        // Grid padding depends on this flag (wrap mode scales pad with
        // pathCount for the fanned rings; terminal mode uses a fixed pad),
        // so a full resize is required, not just a redraw.
        if (ctx) resize();
    }
    function setPathWidth(frac) {
        GROOVE_FRAC = frac;
        if (ctx) draw();
    }
    function setBevelThickness(frac) {
        BEVEL_FRAC = frac;
        if (ctx) draw();
    }
    function setTileFaceAlpha(a) {
        TILE_FACE_ALPHA = a;
        if (ctx) draw();
    }
    function setLockFaceColor(c) {
        LOCK_FACE_COLOR = c;
        if (ctx) draw();
    }
    let FACE_TEXTURE_ALPHA = 0.66; // brushed-metal grain strength on tile faces (0 = off)
    function setFaceTexture(a) {
        FACE_TEXTURE_ALPHA = a;
        if (ctx) draw();
    }

    // Colors — slate tile face for normal tiles, crimson for hint-locked tiles.
    // Twin tiles get a per-pair palette derived from their pastel base color
    // (see paletteFromBase below).
    // --- DEBUG: live-tunable via debug panel in index.html ---
    // TILE_PALETTE is derived from a base face color + four fixed bevel-edge
    // deltas (top/left brighter, bot/right darker — top-left lighting). The
    // color picker drives TILE_BASE_COLOR; the deltas are baked-in shading
    // offsets applied to the face color to get the bevel colors.
    const BEVEL_DELTAS = {
        face:  [0,    0,    0  ],
        top:   [35,   40,   48 ],
        left:  [18,   22,   30 ],
        bot:   [-22,  -24,  -29],
        right: [-13,  -14,  -17]
    };
    let TILE_BASE_COLOR = '#204169';
    const TILE_PALETTE = { face: '', top: '', left: '', bot: '', right: '' };
    function recomputeTilePalette() {
        const base = parseColor(TILE_BASE_COLOR);
        const clamp = (c) => Math.max(0, Math.min(255, Math.round(c)));
        const toHex = (r, g, b) => '#' +
            clamp(r).toString(16).padStart(2, '0') +
            clamp(g).toString(16).padStart(2, '0') +
            clamp(b).toString(16).padStart(2, '0');
        for (const k in BEVEL_DELTAS) {
            const [dr, dg, db] = BEVEL_DELTAS[k];
            TILE_PALETTE[k] = toHex(base[0] + dr, base[1] + dg, base[2] + db);
        }
    }
    function setTileColor(hex) {
        TILE_BASE_COLOR = hex;
        recomputeTilePalette();
        if (ctx) draw();
    }
    recomputeTilePalette();  // derive initial palette from defaults

    // Hint-locked tiles use a gold palette — they show a tile in its
    // solved orientation, so gold (the win color) reads as "this is
    // already correct" instead of red's "stop / locked" connotation.
    // The slow pulse in effectivePalette modulates brightness so the
    // tile breathes between this base and a brighter highlight.
    const HINT_PALETTE = {
        face:  '#8b6920',
        top:   '#e0b340',
        left:  '#b88a28',
        bot:   '#44320a',
        right: '#5d4814'
    };
    // Rejection flash (player tries to twist a hint-locked or twin-locked
    // pair) stays red — it's an alarm/stop signal, distinct from the
    // hint's "this is correct" gold.
    const REJECT_PALETTE = {
        face:  '#6b2030',
        top:   '#a04050',
        left:  '#823545',
        bot:   '#3d1018',
        right: '#4f1820'
    };

    // Derive a beveled palette from a base hex. Top/left lighten via additive
    // shift (works on already-bright pastels without saturating), bot/right
    // darken via multiplicative scaling (preserves hue at low brightness).
    const twinPaletteCache = new Map();
    function paletteFromBase(hex) {
        if (twinPaletteCache.has(hex)) return twinPaletteCache.get(hex);
        const n = parseInt(hex.slice(1), 16);
        const r = (n >> 16) & 255;
        const g = (n >> 8) & 255;
        const b = n & 255;
        const clamp = (c) => Math.max(0, Math.min(255, Math.round(c)));
        const toHex = (rr, gg, bb) => '#' +
            clamp(rr).toString(16).padStart(2, '0') +
            clamp(gg).toString(16).padStart(2, '0') +
            clamp(bb).toString(16).padStart(2, '0');
        const palette = {
            face:  hex,
            top:   toHex(r + 50, g + 50, b + 50),
            left:  toHex(r + 25, g + 25, b + 25),
            bot:   toHex(r * 0.50, g * 0.50, b * 0.50),
            right: toHex(r * 0.70, g * 0.70, b * 0.70)
        };
        twinPaletteCache.set(hex, palette);
        return palette;
    }

    // --- DEBUG: live-tunable via color picker in index.html (Render.setPathColor) ---
    let GROOVE_RIM = '#ff0000';      // un-lit channel band color (composited at DIM_ALPHA over the body bg)
    function setPathColor(hex) {
        GROOVE_RIM = hex;
        if (ctx) draw();
    }

    // Lit palette: gold once the circuit is closed (Maze.won), pastel green
    // while it's still being assembled. Same three-tone gradient (lo/base/hi)
    // for both — litStripes interpolates between them in LIT_GRADIENT_STEPS
    // sub-stops for a smooth outer-dark to inner-bright fade.
    // --- DEBUG: live-tunable via debug panel in index.html ---
    let LIT_GOLD     = '#fff500';
    let LIT_GOLD_HI  = '#fefcc8';
    let LIT_GOLD_LO  = '#2d2c01';

    let LIT_GREEN     = '#2aec18';
    let LIT_GREEN_HI  = '#b8ffb3';
    let LIT_GREEN_LO  = '#0e2c0c';

    // Path-2 palette (only used in Maze's two-path+ mode).
    let LIT_BLUE     = '#00e1ff';
    let LIT_BLUE_HI  = '#c2f8ff';
    let LIT_BLUE_LO  = '#032b30';

    // Path-3 palette (only used in three-path mode).
    let LIT_PINK     = '#fe71f7';
    let LIT_PINK_HI  = '#ffdbff';
    let LIT_PINK_LO  = '#2d102d';

    // Path-4 palette (only used in four-path mode).
    let LIT_ORANGE     = '#ff8247';
    let LIT_ORANGE_HI  = '#ffdccc';
    let LIT_ORANGE_LO  = '#341a0f';

    // Joined-paths palette — when two different-color paths share a lane, the
    // overlap lane flashes dark red to flag the conflict instead of being
    // arbitrarily painted with one of the two path colors. Sentinel pathIdx
    // value is JOINED_PATH_IDX (-2); -1 still means "lane not lit".
    const JOINED_PATH_IDX        = -2;
    const JOINED_PULSE_PERIOD_MS = 900;
    const JOINED_PULSE_AMP       = 0.45;
    let LIT_JOINED      = '#a02020';
    let LIT_JOINED_HI   = '#cc4040';
    let LIT_JOINED_LO   = '#4a0000';
    // Ramp-shape overrides for the joined flash (litStripes reads these off
    // the palette). The global LIT_EDGE_LIFT/CORE_* constants assume
    // near-white hi stops; on this dark red palette they produce a thin
    // stark white filament. These values MUST stay in sync with the litOpts
    // in title-renderer.js — the title-O deliberately mimics the joined
    // flash, and both were tuned together via title-o-tuner.html.
    const JOINED_RAMP = { edgeLift: 0.00, coreStart: 0.36, coreFull: 0.60, coreHot: 0.43 };

    function setLitGreenBase(hex)  { LIT_GREEN     = hex; if (ctx) draw(); }
    function setLitGreenLo(hex)    { LIT_GREEN_LO  = hex; if (ctx) draw(); }
    function setLitGreenHi(hex)    { LIT_GREEN_HI  = hex; if (ctx) draw(); }
    function setLitBlueBase(hex)   { LIT_BLUE      = hex; if (ctx) draw(); }
    function setLitBlueLo(hex)     { LIT_BLUE_LO   = hex; if (ctx) draw(); }
    function setLitBlueHi(hex)     { LIT_BLUE_HI   = hex; if (ctx) draw(); }
    function setLitPinkBase(hex)   { LIT_PINK      = hex; if (ctx) draw(); }
    function setLitPinkLo(hex)     { LIT_PINK_LO   = hex; if (ctx) draw(); }
    function setLitPinkHi(hex)     { LIT_PINK_HI   = hex; if (ctx) draw(); }
    function setLitOrangeBase(hex) { LIT_ORANGE    = hex; if (ctx) draw(); }
    function setLitOrangeLo(hex)   { LIT_ORANGE_LO = hex; if (ctx) draw(); }
    function setLitOrangeHi(hex)   { LIT_ORANGE_HI = hex; if (ctx) draw(); }
    function setLitGoldBase(hex)   { LIT_GOLD      = hex; if (ctx) draw(); }
    function setLitGoldLo(hex)     { LIT_GOLD_LO   = hex; if (ctx) draw(); }
    function setLitGoldHi(hex)     { LIT_GOLD_HI   = hex; if (ctx) draw(); }

    // Each path picks up gold when ITS walk reaches the exit, independent of
    // the others. Path 0 = green, path 1 = blue, path 2 = pink, path 3 = orange.
    // pathIdx === JOINED_PATH_IDX → dark-red flash, brightness-modulated by
    // wall-clock time so the rAF loop drives the flicker without needing
    // per-tile state.
    function litPalette(pathIdx) {
        const idx = pathIdx | 0;
        // Snippet override: lets the title-O (and other static snippet
        // renders) force a custom lit gradient, bypassing the normal
        // per-path / won-state palette selection. Caller can pass an
        // explicit hi/lo triplet (matching the curated style of
        // LIT_GREEN/BLUE/PINK/ORANGE/JOINED palettes), or just litColor
        // and we'll derive hi/lo via scaleColor — but the derivation
        // muddies when the base channel is already saturated, so the
        // explicit triplet is preferred.
        if (snippetMode && snippetLitColor) {
            const baseHex = snippetLitColor;
            const hiHex   = snippetLitHi || scaleColor(baseHex, 1.35);
            const loHex   = snippetLitLo || scaleColor(baseHex, 0.45);
            // When litPulse is set, apply the same sine-driven brightness
            // modulation as the in-game JOINED palette so the title-O
            // pulses identically to the path-conflict flash.
            if (snippetLitPulse) {
                const phase  = (Date.now() / JOINED_PULSE_PERIOD_MS) * 2 * Math.PI;
                const factor = 1 + JOINED_PULSE_AMP * Math.sin(phase);
                return {
                    base: scaleColor(baseHex, factor),
                    hi:   scaleColor(hiHex,   factor),
                    lo:   scaleColor(loHex,   factor),
                };
            }
            return { base: baseHex, hi: hiHex, lo: loHex };
        }
        if (idx === JOINED_PATH_IDX) {
            const phase  = (Date.now() / JOINED_PULSE_PERIOD_MS) * 2 * Math.PI;
            const factor = 1 + JOINED_PULSE_AMP * Math.sin(phase);
            return {
                base: scaleColor(LIT_JOINED,    factor),
                hi:   scaleColor(LIT_JOINED_HI, factor),
                lo:   scaleColor(LIT_JOINED_LO, factor),
                edgeLift:  JOINED_RAMP.edgeLift,
                coreStart: JOINED_RAMP.coreStart,
                coreFull:  JOINED_RAMP.coreFull,
                coreHot:   JOINED_RAMP.coreHot,
            };
        }
        const pathsWon = Maze.pathsWon || [Maze.won, true, true, true];
        if (pathsWon[idx]) return { base: LIT_GOLD, hi: LIT_GOLD_HI, lo: LIT_GOLD_LO };
        if (idx === 3) return { base: LIT_ORANGE, hi: LIT_ORANGE_HI, lo: LIT_ORANGE_LO };
        if (idx === 2) return { base: LIT_PINK,   hi: LIT_PINK_HI,   lo: LIT_PINK_LO   };
        if (idx === 1) return { base: LIT_BLUE,   hi: LIT_BLUE_HI,   lo: LIT_BLUE_LO   };
        return                { base: LIT_GREEN,  hi: LIT_GREEN_HI,  lo: LIT_GREEN_LO  };
    }

    // Alpha for the un-lit channel band so the body-bg image shows through
    // it. Tile bevels and lit segments stay opaque.
    // --- DEBUG: live-tunable via slider in index.html (Render.setPathOpacity) ---
    let DIM_ALPHA = 0.14;
    function setPathOpacity(alpha) {
        DIM_ALPHA = alpha;
        if (ctx) draw();
    }

    let canvas = null;
    let ctx = null;
    let cellSize = 0;
    let originX = 0, originY = 0;  // top-left of grid in CSS pixels
    let dpr = 1;

    // Offscreen canvas for the un-lit rim+dark pass. We render to it at full
    // opacity, then drawImage it onto main at DIM_ALPHA in one shot. This
    // matters for cross tiles: stroking each lane separately at α<1 stacks
    // alpha at the intersection (~0.66 instead of 0.42), so the cross center
    // looks denser than the rest of the path. Rendering opaque on the
    // offscreen lets same-color overlaps land identically (no stacking),
    // and a single composite then applies uniform translucency.
    let offCanvas = null;
    let offCtx = null;
    function ensureOffscreen() {
        if (!offCanvas) {
            offCanvas = document.createElement('canvas');
            offCtx    = offCanvas.getContext('2d');
        }
        if (offCanvas.width !== canvas.width || offCanvas.height !== canvas.height) {
            offCanvas.width  = canvas.width;
            offCanvas.height = canvas.height;
        }
    }

    // Background image shuffle bag — Fisher-Yates over 1..BACKGROUND_IMAGE_COUNT
    // so every image plays once before any repeats, plus an avoid-back-to-back
    // swap at refill boundaries so the same image can't appear twice in a row.
    // State is in-memory only — bag resets on page reload, which is fine; the
    // bag is for in-session variety, not a curated player experience.
    let bgBag         = [];
    let bgBagPos      = 0;
    let lastBgIdx     = -1;
    let bgEnabled     = true;   // mirrors Settings.isBackgroundEnabled(); when false, body shows pure black
    let currentBgUrl  = null;   // most recently picked URL — re-applied on enable so toggling on/off doesn't waste bag entries
    function refillBgBag() {
        const count = (typeof BACKGROUND_IMAGE_COUNT === 'number' && BACKGROUND_IMAGE_COUNT > 0)
                      ? BACKGROUND_IMAGE_COUNT : 0;
        if (count === 0) { bgBag = []; bgBagPos = 0; return; }
        bgBag = [];
        for (let i = 1; i <= count; i++) bgBag.push(i);
        for (let i = bgBag.length - 1; i > 0; i--) {
            const j   = Math.floor(Math.random() * (i + 1));
            const tmp = bgBag[i]; bgBag[i] = bgBag[j]; bgBag[j] = tmp;
        }
        // Avoid back-to-back of the image that just played at the bag boundary.
        if (lastBgIdx > 0 && bgBag.length > 1 && bgBag[0] === lastBgIdx) {
            const tmp = bgBag[0]; bgBag[0] = bgBag[1]; bgBag[1] = tmp;
        }
        bgBagPos = 0;
    }
    function nextBgUrl() {
        if (typeof BACKGROUND_IMAGE_URL_BASE !== 'string' || !BACKGROUND_IMAGE_URL_BASE) return null;
        if (bgBagPos >= bgBag.length) refillBgBag();
        if (bgBag.length === 0) return null;
        const idx = bgBag[bgBagPos++];
        lastBgIdx = idx;
        return BACKGROUND_IMAGE_URL_BASE + 'level' + idx + '.jpg';
    }
    // IMPORTANT: bg image is painted on documentElement (<html>), NOT body.
    // body's box can fall short of the visible viewport on iOS Safari
    // (and PWA fullscreen with safe-area-inset / 100dvh quirks),
    // leaving a dark-blue strip along the bottom; html always fills
    // the initial containing block. See the matching CSS rule in
    // styles.css's html { background-color/size/position/repeat } for
    // the rest of the painting setup. Function name kept as
    // applyBodyBackground for backwards-compat with existing callers.
    function applyBodyBackground() {
        const url = nextBgUrl();
        if (!url) return;
        currentBgUrl = url;
        if (bgEnabled) document.documentElement.style.backgroundImage = `url("${url}")`;
        // (if !bgEnabled the bag still advances but the DOM stays empty
        // until setBackgroundEnabled(true) re-applies currentBgUrl)
    }
    // Public alias — Marathon.onPuzzleReady calls this on every puzzle start
    // so the visible bg rotates with the player's progression.
    function shuffleBackground() { applyBodyBackground(); }
    // Settings toggle. When off, html falls back to pure black instead of
    // the CSS default dark navy — matches the "just be black" expectation.
    // Re-applies the CURRENT bag URL (rather than advancing) on enable, so
    // toggling on/off mid-game doesn't waste images from the rotation.
    function setBackgroundEnabled(b) {
        bgEnabled = !!b;
        if (bgEnabled) {
            document.documentElement.style.backgroundColor = '';   // revert to CSS #0a0a2e
            if (currentBgUrl) {
                document.documentElement.style.backgroundImage = `url("${currentBgUrl}")`;
            } else {
                applyBodyBackground();  // first time enabling: pick from bag
            }
        } else {
            document.documentElement.style.backgroundImage = '';
            document.documentElement.style.backgroundColor = '#000';
        }
    }

    function init(c) {
        canvas = c;
        ctx = canvas.getContext('2d');
        window.addEventListener('resize', resize);
        // Sync the bgEnabled flag from Settings BEFORE first apply, so a
        // persisted-disabled user doesn't see an image flash on page load.
        // Settings IIFE has already loaded its localStorage state by now;
        // its .init (DOM-binding) is the part that waits for DOMContentLoaded.
        if (typeof Settings !== 'undefined' && Settings.isBackgroundEnabled) {
            bgEnabled = Settings.isBackgroundEnabled();
            if (!bgEnabled) {
                document.body.style.backgroundColor = '#000';
            }
        }
        applyBodyBackground();
        resize();
    }

    // Resize the maze to (rows, cols), regenerate a fresh puzzle, and redraw.
    // Async because Maze.init() yields between attempts to keep the UI alive
    // on large grids; callers should await this before using the new state.
    async function setGridSize(rows, cols) {
        Maze.setDimensions(rows, cols);
        await Maze.init();
        resize();
    }

    // Padding fraction (per-side) of cell size — controls how much room
    // around the grid is available for the perimeter polylines.
    // 1 path: 0.7 (default). 2 paths: 0.8. 3 paths: 1.0. The grid itself
    // shrinks slightly in multi-path mode but the rings have room to fan
    // out without clipping or overlapping the grid edge.
    // Only used in COMPLETE_CIRCUITS (wrap) mode — terminal-pad mode needs
    // the same fixed room per side regardless of path count, since each
    // endpoint's stub + square pad is local to its own port.
    const TERMINAL_PAD_FRAC = 0.75;
    function padFracFor(pathCount) {
        if (pathCount >= 4) return 1.15;
        if (pathCount === 3) return 1.0;
        if (pathCount === 2) return 0.8;
        return 0.7;
    }

    function resize() {
        // While the How-to-Solve tutorial owns the renderer, a window resize
        // must re-layout the small tutorial canvas, NOT the (hidden) main
        // game canvas. layoutTutorial mirrors this function's device-pixel
        // conventions for the tutorial's own target canvas + grid dims.
        if (tutorialMode) { layoutTutorial(); return; }
        // Make canvas fill the viewport, but leave a small margin
        const margin = Math.min(window.innerWidth, window.innerHeight) * 0.03;
        // Reserve HALF the HUD strip. #hud is an absolutely-positioned
        // overlay, so the flex-centered canvas otherwise slides its top pad
        // — where terminal endpoint pads render — underneath the UNDO/HINT
        // buttons on short viewports. Measuring the live element (0 when
        // hidden, e.g. menu or debug mode) and pairing the reduced height
        // with a matching margin-top centers the canvas lower, clearing the
        // buttons. Half the HUD height is enough because the canvas's own
        // pad region means terminals never touch the canvas's very edge —
        // a full-height reserve (tried first) pushed the grid down more
        // than the overlap warranted.
        let hudReserve = 0;
        const hudEl = document.getElementById('hud');
        if (hudEl) hudReserve = hudEl.getBoundingClientRect().height / 2;
        canvas.style.marginTop = hudReserve + 'px';
        const availW = window.innerWidth  - margin * 2;
        const availH = window.innerHeight - margin * 2 - hudReserve;

        dpr = window.devicePixelRatio || 1;

        // Compute every dimension in DEVICE pixels so all rendering happens
        // on integer device-pixel boundaries. With the usual ctx.scale(dpr)
        // approach, integer CSS coords land on *fractional* device pixels for
        // non-integer DPR displays (1.25, 1.5), which gets anti-aliased and
        // produces faint line artifacts at every tile boundary inside path
        // channels. Drawing in device pixels directly is pixel-perfect.
        // For non-square grids on non-square viewports, derive cellSize from
        // BOTH dimensions independently and take the smaller — that way a
        // wide grid on a landscape monitor uses the full width, while a tall
        // grid on a landscape monitor stays height-bound. (Earlier version
        // used min(width,height) for both viewport and grid, treating both
        // as square — that wasted horizontal space on wide grids.)
        // PAD_FRAC: in wrap mode it scales with pathCount — multi-path mode
        // needs more perimeter room to stack 2-3 rings without clipping or
        // overlapping the grid (grid shrinks slightly to make room). In
        // terminal-pad mode every endpoint is local to its own port, so a
        // fixed pad suffices at any path count (bigger grids in multi-path).
        const PAD_FRAC = COMPLETE_CIRCUITS ? padFracFor(Maze.pathCount) : TERMINAL_PAD_FRAC;
        const cellByW = (availW * dpr) / (Maze.COLS + 2 * PAD_FRAC);
        const cellByH = (availH * dpr) / (Maze.ROWS + 2 * PAD_FRAC);
        cellSize = Math.floor(Math.min(cellByW, cellByH));
        if (cellSize % 2 !== 0) cellSize -= 1; // even cellSize keeps midline integer
        const gridW    = cellSize * Maze.COLS;
        const gridH    = cellSize * Maze.ROWS;
        const pad      = Math.round(cellSize * PAD_FRAC);

        const totalW = gridW + pad * 2;
        const totalH = gridH + pad * 2;

        canvas.style.width  = (totalW / dpr) + 'px';
        canvas.style.height = (totalH / dpr) + 'px';
        canvas.width  = totalW;
        canvas.height = totalH;

        // Identity transform — coordinates passed to the canvas are device pixels.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        originX = Math.round((totalW - gridW) / 2);
        originY = Math.round((totalH - gridH) / 2);

        draw();
    }

    function cellAt(cssX, cssY) {
        // Pointer events deliver CSS pixels; convert to device pixels for lookup.
        const c = Math.floor((cssX * dpr - originX) / cellSize);
        const r = Math.floor((cssY * dpr - originY) / cellSize);
        if (r < 0 || r >= Maze.ROWS || c < 0 || c >= Maze.COLS) return null;
        return { row: r, col: c };
    }

    // ---- bevel polygon helpers (port from bevel-test.html) ----
    //
    // Each tile's walls are drawn as beveled polygons surrounding the path
    // channel. The channel itself is left transparent so the body background
    // shows through; rim+dark+lit overlays then paint over the empty channel.
    // This replaces the earlier full-tile bevel + destination-out cut-out:
    // the wall polygons exclude the channel by construction, so there's
    // nothing to erase.

    function lineIntersect(p1, p2, p3, p4) {
        const denom = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
        if (Math.abs(denom) < 1e-9) return { x: p2.x, y: p2.y };
        const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / denom;
        return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
    }

    // Offset every edge `bevel` pixels inward, then intersect adjacent inset
    // lines to recover the inset polygon's vertices. Verts must be wound CW
    // in screen coords (y-down).
    function insetPolygon(verts, bevel, skipEdges) {
        const n = verts.length;
        const lines = [];
        for (let i = 0; i < n; i++) {
            const a = verts[i];
            const b = verts[(i + 1) % n];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            // Inward normal for CW screen polygon = rotate edge 90° CCW
            const nx = -dy / len, ny = dx / len;
            // Skipped edges keep offset 0 — the inner polygon's vertex at
            // either end of a skipped edge slides out to coincide with the
            // outer polygon (so the face fills the gap where the bevel
            // trapezoid would have been).
            const off = (skipEdges && skipEdges[i]) ? 0 : bevel;
            lines.push({
                a: { x: a.x + nx * off, y: a.y + ny * off },
                b: { x: b.x + nx * off, y: b.y + ny * off }
            });
        }
        const out = [];
        for (let i = 0; i < n; i++) {
            const prev = lines[(i - 1 + n) % n];
            const curr = lines[i];
            out.push(lineIntersect(prev.a, prev.b, curr.a, curr.b));
        }
        return out;
    }

    // Sample N+1 points along an arc (cx, cy), radius r, sweeping from
    // theta1 to theta2 (degrees). Sweep direction is the sign of (theta2 -
    // theta1). Used to tessellate the curved-elbow wall arcs into chord
    // segments that drawBeveledPolygon can consume.
    function arcPoints(cx, cy, r, theta1, theta2, n) {
        const points = [];
        const dt = (theta2 - theta1) / n;
        for (let i = 0; i <= n; i++) {
            const rad = (theta1 + i * dt) * Math.PI / 180;
            points.push({
                x: cx + r * Math.cos(rad),
                y: cy + r * Math.sin(rad)
            });
        }
        return points;
    }

    function parseColor(c) {
        if (c.charAt(0) === '#') {
            return [
                parseInt(c.slice(1, 3), 16),
                parseInt(c.slice(3, 5), 16),
                parseInt(c.slice(5, 7), 16)
            ];
        }
        return c.match(/\d+/g).map(Number);
    }

    function blendRGB(c1, c2, t) {
        const [r1, g1, b1] = parseColor(c1);
        const [r2, g2, b2] = parseColor(c2);
        return 'rgb(' +
            Math.round(r1 + (r2 - r1) * t) + ',' +
            Math.round(g1 + (g2 - g1) * t) + ',' +
            Math.round(b1 + (b2 - b1) * t) + ')';
    }

    // Pick a palette color for an edge by its outward normal, interpolating
    // between cardinal palette stops (right/top/left/bot at 0°/90°/180°/270°).
    // Axis-aligned edges land exactly on a cardinal (t=0) so they return one
    // palette stop unchanged. Arc chords land between stops and pick up a
    // smooth blend, giving the curved walls a continuous shade gradient.
    // Light is fixed in screen space (top-left), so rotated polygons just
    // pick up the right shade by their post-rotation outward normal.
    function bevelColorForEdge(a, b, palette) {
        // Outward normal for a CW screen polygon edge a→b is (dy, -dx).
        const ox = b.y - a.y;
        const oy = -(b.x - a.x);
        // Cardinal angle: 0°=right, 90°=top (UP), 180°=left, 270°=bot (DOWN).
        // Screen y-down means UP = -y, so flip atan2's y argument.
        let angle = -Math.atan2(oy, ox) * 180 / Math.PI;
        if (angle < 0) angle += 360;
        const stops = [palette.right, palette.top, palette.left, palette.bot];
        const i = Math.floor(angle / 90) % 4;
        const j = (i + 1) % 4;
        const t = (angle - i * 90) / 90;
        return blendRGB(stops[i], stops[j], t);
    }

    // Rotate a point by `r` 90° CW steps (0..3) around (cx, cy) in screen coords.
    // Maze rotation is CW per universal port convention (N=0, E=1, S=2, W=3).
    function rotateMaze(p, cx, cy, r) {
        const dx = p.x - cx, dy = p.y - cy;
        if (r === 0) return { x: cx + dx, y: cy + dy };
        if (r === 1) return { x: cx - dy, y: cy + dx };
        if (r === 2) return { x: cx - dx, y: cy - dy };
        return         { x: cx + dy, y: cy - dx };
    }

    // ---- brushed-metal face texture ----
    //
    // A seamlessly-tiling grayscale streak pattern overlaid on every tile
    // face with 'overlay' blending, so it lightens/darkens whatever face
    // color is underneath (slate, twin pastels, hint gold, lock white)
    // without shifting its hue. Two streak scales — short fine grain plus
    // long soft strokes — approximate real brushed metal. Built once,
    // lazily, on an offscreen canvas; drawn in screen space so the grain
    // runs horizontal everywhere and flows unbroken across quad-merged
    // faces (it rotates with a tile only during its spin animation, which
    // reads as the physical tile turning).
    const TEX_SIZE   = 256;      // pattern tile, device px (wraps on both axes)
    const TEX_LAYERS = [         // radius: horizontal blur px; amp: gray-level std
        { radius: 3,  amp: 11 }, // fine grain
        { radius: 28, amp: 14 }  // long streaks
    ];
    let faceTexPattern = null;
    function buildFaceTexPattern() {
        const tex = document.createElement('canvas');
        tex.width = tex.height = TEX_SIZE;
        const tctx = tex.getContext('2d');
        const img  = tctx.createImageData(TEX_SIZE, TEX_SIZE);
        const gray = new Float32Array(TEX_SIZE * TEX_SIZE).fill(128);
        for (const { radius, amp } of TEX_LAYERS) {
            const n = 2 * radius + 1;
            // Box-blurring uniform noise leaves std ≈ 0.2887/√n; rescale so
            // the layer deviates from neutral by `amp` gray levels (std).
            const scale = amp * Math.sqrt(n) / 0.2887;
            const noise = new Float32Array(TEX_SIZE);
            for (let y = 0; y < TEX_SIZE; y++) {
                const row = y * TEX_SIZE;
                for (let x = 0; x < TEX_SIZE; x++) noise[x] = Math.random() - 0.5;
                // Sliding-window box blur with wrap-around so the pattern
                // tiles seamlessly along the streak direction.
                let sum = 0;
                for (let k = -radius; k <= radius; k++) sum += noise[(k + TEX_SIZE) % TEX_SIZE];
                for (let x = 0; x < TEX_SIZE; x++) {
                    gray[row + x] += (sum / n) * scale;
                    sum -= noise[(x - radius + TEX_SIZE) % TEX_SIZE];
                    sum += noise[(x + radius + 1) % TEX_SIZE];
                }
            }
        }
        for (let i = 0; i < gray.length; i++) {
            const g = Math.max(0, Math.min(255, Math.round(gray[i])));
            img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g;
            img.data[i * 4 + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);
        return tctx.createPattern(tex, 'repeat');
    }

    function drawBeveledPolygon(verts, palette, skipEdges, arcEdges, bevelOverride) {
        // BEVEL_FRAC is a fraction of cellSize, but in quad mode the visible
        // tile is 2× cellSize on each side — so double the bevel to keep its
        // visual proportion consistent with non-quad tiles. The inner-quad
        // edges (skipEdges) still receive 0 inset, so this only fattens the
        // outer-quad bevels that frame each 2×2 group.
        // bevelOverride lets small overlays (gates) pick a thinner inset so
        // tiny polygons don't get bevel-dominated.
        const bevelMul = Maze.quadMode ? 2 : 1;
        const bevel = (bevelOverride != null)
            ? bevelOverride
            : Math.max(2, Math.floor(cellSize * BEVEL_FRAC * bevelMul));
        const inner = insetPolygon(verts, bevel, skipEdges);
        const n = verts.length;

        // Inner face — drawn at TILE_FACE_ALPHA so the body background
        // shows through the tile centers. Bevels stay opaque so the
        // beveled edge silhouette remains crisp.
        // palette.faceAlpha overrides for player-locked tiles (opaque).
        const faceAlpha = (palette.faceAlpha !== undefined) ? palette.faceAlpha : TILE_FACE_ALPHA;
        ctx.fillStyle = palette.face;
        ctx.globalAlpha = faceAlpha;
        ctx.beginPath();
        ctx.moveTo(inner[0].x, inner[0].y);
        for (let i = 1; i < n; i++) ctx.lineTo(inner[i].x, inner[i].y);
        ctx.closePath();
        ctx.fill();
        // Brushed-metal grain over the face (the path is still current —
        // fill() doesn't clear it). Strength scales with the face's own
        // opacity so translucent faces get proportionally subtler grain:
        // the background peeking through shouldn't pick up full streaks.
        if (FACE_TEXTURE_ALPHA > 0) {
            if (!faceTexPattern) faceTexPattern = buildFaceTexPattern();
            ctx.fillStyle = faceTexPattern;
            ctx.globalAlpha = faceAlpha * FACE_TEXTURE_ALPHA;
            ctx.globalCompositeOperation = 'overlay';
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;

        // One trapezoid bevel per edge. Each end is extended SEAM_OVERLAP past
        // its shared seam so adjacent trapezoids overlap — closes canvas AA
        // gaps that otherwise leak the background through as faint radial
        // lines along the curved-elbow arcs.
        //
        // When arcEdges is provided (elbow walls), draw arc bevels FIRST and
        // straight bevels SECOND — that way the seam where an arc meets a
        // tile-edge bevel (e.g. at the elbow's port end-points) always has
        // the straight edge bevel on top, so the arc doesn't visibly poke
        // into the straight bevel's territory.
        function drawOneBevel(i) {
            if (skipEdges && skipEdges[i]) return;
            const a   = verts[i];
            const b   = verts[(i + 1) % n];
            const aIn = inner[i];
            const bIn = inner[(i + 1) % n];

            const odx = b.x - a.x, ody = b.y - a.y;
            const oLen = Math.hypot(odx, ody);
            const otx = odx / oLen, oty = ody / oLen;

            const idx = bIn.x - aIn.x, idy = bIn.y - aIn.y;
            const iLen = Math.hypot(idx, idy);
            const itx = idx / iLen, ity = idy / iLen;

            ctx.fillStyle = bevelColorForEdge(a, b, palette);
            ctx.beginPath();
            ctx.moveTo(a.x   - otx * SEAM_OVERLAP, a.y   - oty * SEAM_OVERLAP);
            ctx.lineTo(b.x   + otx * SEAM_OVERLAP, b.y   + oty * SEAM_OVERLAP);
            ctx.lineTo(bIn.x + itx * SEAM_OVERLAP, bIn.y + ity * SEAM_OVERLAP);
            ctx.lineTo(aIn.x - itx * SEAM_OVERLAP, aIn.y - ity * SEAM_OVERLAP);
            ctx.closePath();
            ctx.fill();
        }
        if (arcEdges) {
            for (let i = 0; i < n; i++) if (arcEdges[i]) drawOneBevel(i);
            for (let i = 0; i < n; i++) if (!arcEdges[i]) drawOneBevel(i);
        } else {
            for (let i = 0; i < n; i++) drawOneBevel(i);
        }
    }

    function beveledRect(x, y, w, h, palette, skipEdges) {
        drawBeveledPolygon([
            { x: x,     y: y     },
            { x: x + w, y: y     },
            { x: x + w, y: y + h },
            { x: x,     y: y + h }
        ], palette, skipEdges);
    }

    // Quad mode: which sides of sub-tile (r, c) are inner-quad edges (i.e.,
    // border another sub-tile in the same 2×2 quad). Skipping bevels on these
    // edges lets the 4 sub-tiles' walls visually merge into one big tile face.
    // Returns null when not in quad mode (no edges to skip).
    function quadInnerSides(r, c) {
        if (!Maze.quadMode) return null;
        return {
            top:    (r & 1) === 1,   // bottom row of quad → top edge faces top sibling
            right:  (c & 1) === 0,   // left col of quad → right edge faces right sibling
            bottom: (r & 1) === 0,
            left:   (c & 1) === 1
        };
    }

    // Per-polygon-edge bevel-skip: an edge gets skipped iff it lies along
    // a sub-tile side that is inner-quad. Edge alignment is detected by both
    // endpoints sharing the same x or y at the sub-tile's perimeter.
    function quadSkipEdges(verts, subPx, subPy, cs, inner) {
        if (!inner) return null;
        const eps = 0.5;
        const n = verts.length;
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            const a = verts[i], b = verts[(i + 1) % n];
            let skip = false;
            if (inner.top    && Math.abs(a.y - subPy)         < eps && Math.abs(b.y - subPy)         < eps) skip = true;
            if (inner.bottom && Math.abs(a.y - (subPy + cs))  < eps && Math.abs(b.y - (subPy + cs))  < eps) skip = true;
            if (inner.left   && Math.abs(a.x - subPx)         < eps && Math.abs(b.x - subPx)         < eps) skip = true;
            if (inner.right  && Math.abs(a.x - (subPx + cs))  < eps && Math.abs(b.x - (subPx + cs))  < eps) skip = true;
            out[i] = skip;
        }
        return out;
    }

    // Wall thickness chosen so each wall's inner edge meets the channel rim's
    // outer edge: channel half-width including rim = w/2 + rim. Both pipelines
    // meet at the same coords, so shared edges align even at fractional pixels.
    function wallThickness() {
        // Respect snippet-mode width override so the wall geometry actually
        // moves to expose the wider channel (otherwise a wider path just
        // bleeds underneath the unchanged walls).
        const widthFrac = (snippetMode && snippetWidthFrac != null) ? snippetWidthFrac : GROOVE_FRAC;
        const w   = Math.max(4, Math.floor(cellSize * widthFrac));
        const rim = Math.max(1, Math.floor(cellSize * GROOVE_RIM_FRAC));
        return cellSize / 2 - (w / 2 + rim);
    }

    // ---- per-tile wall renderers ----

    // Bevel-skip helper for a sub-rect within a sub-tile: takes the rect
    // bounds and the inner-quad sides (or null), returns a 4-element
    // skipEdges array [top, right, bottom, left] for the rect.
    function skipForRect(x, y, w, h, subPx, subPy, cs, inner) {
        if (!inner) return null;
        const eps = 0.5;
        return [
            inner.top    && Math.abs(y       - subPy)         < eps,
            inner.right  && Math.abs(x + w   - (subPx + cs))  < eps,
            inner.bottom && Math.abs(y + h   - (subPy + cs))  < eps,
            inner.left   && Math.abs(x       - subPx)         < eps
        ];
    }

    // Cross has both lanes; walls are 4 outer-corner squares. Cross tiles are
    // 4-rotation-symmetric, so rotation has no visual effect.
    function drawCrossWalls(px, py, palette, r, c) {
        const W = wallThickness();
        const cs = cellSize;
        const inner = quadInnerSides(r, c);
        beveledRect(px,          py,          W, W, palette, skipForRect(px,          py,          W, W, px, py, cs, inner));
        beveledRect(px + cs - W, py,          W, W, palette, skipForRect(px + cs - W, py,          W, W, px, py, cs, inner));
        beveledRect(px,          py + cs - W, W, W, palette, skipForRect(px,          py + cs - W, W, W, px, py, cs, inner));
        beveledRect(px + cs - W, py + cs - W, W, W, palette, skipForRect(px + cs - W, py + cs - W, W, W, px, py, cs, inner));
    }

    // One straight lane; walls = the two side-bars flanking the lane.
    function drawStraightWalls(px, py, isVertical, palette, r, c) {
        const W = wallThickness();
        const cs = cellSize;
        const inner = quadInnerSides(r, c);
        if (isVertical) {
            beveledRect(px,          py, W,  cs, palette, skipForRect(px,          py, W,  cs, px, py, cs, inner));
            beveledRect(px + cs - W, py, W,  cs, palette, skipForRect(px + cs - W, py, W,  cs, px, py, cs, inner));
        } else {
            beveledRect(px, py,          cs, W, palette, skipForRect(px, py,          cs, W, px, py, cs, inner));
            beveledRect(px, py + cs - W, cs, W, palette, skipForRect(px, py + cs - W, cs, W, px, py, cs, inner));
        }
    }

    // Elbow lane (canonical = N→E, top-center → middle-right). Path centerline
    // is a quarter-arc of radius cellSize/2 around the top-right corner;
    // outer wall edge sits at radius cs-W, inner wall edge at radius W.
    // Walls:
    //   (a) outer L wrapping the bottom-left, with the concave corner
    //       replaced by a quarter-arc (radius cs-W, sweeping 180° → 90°)
    //       that bulges into the wall interior;
    //   (b) inner-corner square at top-right, with its path-facing corner
    //       replaced by a quarter-arc (radius W, sweeping 90° → 180°).
    // Other rotations rotate both polygons around the tile center.
    function drawElbowWalls(px, py, rotation, palette, r, c) {
        const W  = wallThickness();
        const cs = cellSize;
        const cx = px + cs / 2;
        const cy = py + cs / 2;
        const ax = px + cs;  // arc center for canonical orientation
        const ay = py;
        const inner = quadInnerSides(r, c);

        // Outer L: arcPoints includes both endpoints — (px+W, py) at 180°
        // and (px+cs, py+cs-W) at 90° — so they replace the canonical
        // (W,0) and (cs, cs-W) vertices, with the bulge replacing the
        // concave (W, cs-W) corner.
        // Edge layout (20 verts): E0=top-partial, E1..E16=arc segments,
        // E17=right-partial, E18=bottom, E19=left.
        const outerArc = arcPoints(ax, ay, cs - W, 180, 90, ARC_SEGMENTS);
        const outerL = [
            { x: px,      y: py      },
            ...outerArc,
            { x: px + cs, y: py + cs },
            { x: px,      y: py + cs }
        ].map(p => rotateMaze(p, cx, cy, rotation));
        const outerArcEdges = new Array(outerL.length).fill(false);
        for (let i = 1; i <= ARC_SEGMENTS; i++) outerArcEdges[i] = true;
        drawBeveledPolygon(outerL, palette, quadSkipEdges(outerL, px, py, cs, inner), outerArcEdges);

        // Inner-corner: drop the last arc sample because it equals V0.
        // Edge layout (18 verts): E0=top-partial, E1=right-partial,
        // E2..E16=arc segments, E17=closing chord (treated as arc).
        const innerArc = arcPoints(ax, ay, W, 90, 180, ARC_SEGMENTS);
        const innerCorner = [
            { x: px + cs - W, y: py },
            { x: px + cs,     y: py },
            ...innerArc.slice(0, ARC_SEGMENTS)
        ].map(p => rotateMaze(p, cx, cy, rotation));
        const innerArcEdges = new Array(innerCorner.length).fill(false);
        for (let i = 2; i < innerCorner.length; i++) innerArcEdges[i] = true;
        drawBeveledPolygon(innerCorner, palette, quadSkipEdges(innerCorner, px, py, cs, inner), innerArcEdges);
    }

    // Dispatch on tile type/rotation. T_STRAIGHT rotation 0/2 = vertical lane,
    // 1/3 = horizontal. T_ELBOW uses rotation directly (canonical N→E).
    function drawWalls(px, py, tile, palette, r, c) {
        if (tile.type === Maze.T_CROSS) {
            drawCrossWalls(px, py, palette, r, c);
        } else if (tile.type === Maze.T_STRAIGHT) {
            drawStraightWalls(px, py, (tile.rotation & 1) === 0, palette, r, c);
        } else { // T_ELBOW
            drawElbowWalls(px, py, tile.rotation, palette, r, c);
        }
    }

    // ---- groove path through a tile ----

    // Map a port (N/E/S/W) to the (x, y) point on the cell edge where the channel meets it.
    function portMidpoint(px, py, port) {
        const half = cellSize / 2;
        if (port === Maze.N) return { x: px + half, y: py };
        if (port === Maze.E) return { x: px + cellSize, y: py + half };
        if (port === Maze.S) return { x: px + half, y: py + cellSize };
        return                 { x: px, y: py + half }; // W
    }

    // Channels are drawn in three passes per tile (rims, dark grooves, then any
    // lit overlays) so that cross tiles' two lanes share a single unified rim
    // and dark "+" shape rather than each lane drawing its own rim and clobbering
    // the other lane's groove at the intersection.

    // Layer primitives — operate on whatever path is currently set on ctx.
    // ctx.stroke() does NOT consume the current path, so a single beginPath
    // + path-build can be stroked once per layer with different styles.
    function strokeRimLayer(w, rim) {
        ctx.strokeStyle = effectiveGrooveRim();
        ctx.lineWidth   = w + rim * 2;
        ctx.stroke();
    }

    // Concentric stripes for the lit channel: outer dark (lo) → mid (base) →
    // inner bright (hi), interpolated in LIT_GRADIENT_STEPS sub-steps so the
    // channel reads as a smooth gradient instead of three discrete bands.
    // Outermost width is w + rim*2 — matches the un-lit rim band, so lit
    // channels need no separate rim layer underneath.
    // The color ramp is deliberately non-linear (neon-tube look): the outer
    // part of the band eases from a LIFTED lo (not full dark) toward base,
    // then base → hi snaps in over a narrow transition, and the thin core
    // inside LIT_CORE_FULL pushes past hi toward white — a hot filament
    // with soft, not-too-dark edges.
    // Each segment's local t runs through smoothstep before blending: with
    // plain linear segments the slope jumps at CORE_START/CORE_FULL, and the
    // eye amplifies those slope breaks into visible seams (Mach bands) — the
    // tube read as three flat bands instead of one continuous gradient.
    // Smoothstep flattens the slope to zero at both ends of every segment,
    // so the assembled ramp has a continuous derivative end to end.
    let LIT_GRADIENT_STEPS = 20;
    const LIT_CORE_START = 0.48;  // t where the base → hi ramp begins
    const LIT_CORE_FULL  = 0.84;  // t from which stripes are hi+ (the hot core)
    const LIT_CORE_HOT   = 0.80;  // how far the innermost stripe pushes past hi toward white
    const LIT_EDGE_LIFT  = 0.78;  // outermost stripe starts this far from lo toward base
    function setLitGradientSteps(n) { LIT_GRADIENT_STEPS = n; if (ctx) draw(); }
    function smoothstep(t) { return t * t * (3 - 2 * t); }
    function litStripes(w, rim, pathIdx) {
        const p = litPalette(pathIdx);
        // The ramp SHAPE (not just the colors) can be overridden two ways —
        // the in-game constants assume near-white hi stops, and with a
        // saturated hi the fixed white push reads as a stark thin filament
        // that no color choice can soften:
        //   1. Palette-carried (litPalette's JOINED branch): the joined-red
        //      flash ships its own ramp so it matches the title-O exactly.
        //   2. Snippet opts (renderSnippet / paintSnippetRingMask): the
        //      title-O's litOpts. Palette wins when both are present.
        const coreStart = (p.coreStart != null) ? p.coreStart
                        : (snippetMode && snippetCoreStart != null) ? snippetCoreStart : LIT_CORE_START;
        const coreFull  = (p.coreFull  != null) ? p.coreFull
                        : (snippetMode && snippetCoreFull  != null) ? snippetCoreFull  : LIT_CORE_FULL;
        const coreHot   = (p.coreHot   != null) ? p.coreHot
                        : (snippetMode && snippetCoreHot   != null) ? snippetCoreHot   : LIT_CORE_HOT;
        const edgeLift  = (p.edgeLift  != null) ? p.edgeLift
                        : (snippetMode && snippetEdgeLift  != null) ? snippetEdgeLift  : LIT_EDGE_LIFT;
        const outerW = w + rim * 2;
        const stripes = [];
        for (let i = 0; i < LIT_GRADIENT_STEPS; i++) {
            const t = i / (LIT_GRADIENT_STEPS - 1);
            const lineWidth = Math.max(1, outerW * (1 - t) + 1 * t);
            let color;
            if (t < coreStart) {
                color = blendRGB(p.lo, p.base,
                    edgeLift + (1 - edgeLift) * smoothstep(t / coreStart));
            } else if (t < coreFull) {
                color = blendRGB(p.base, p.hi,
                    smoothstep((t - coreStart) / (coreFull - coreStart)));
            } else {
                color = blendRGB(p.hi, '#ffffff',
                    coreHot * smoothstep((t - coreFull) / (1 - coreFull)));
            }
            stripes.push({ width: lineWidth, color });
        }
        return stripes;
    }

    function strokeLitLayer(w, rim, pathIdx) {
        for (const s of litStripes(w, rim, pathIdx)) {
            ctx.strokeStyle = s.color;
            ctx.lineWidth   = s.width;
            ctx.stroke();
        }
    }

    // Neon glow — lit channels cast their color onto whatever sits beside
    // them (tile bevels, mostly), matching the promo art. Implemented as
    // concentric wide strokes at decreasing alpha with additive ('lighter')
    // compositing: a stepped approximation of a soft falloff. Deliberately
    // NOT ctx.shadowBlur — real gaussian blur is far too slow for the
    // per-frame redraws rotation animations need.
    // Strokes the current path (like strokeLitLayer); does not disturb it.
    const GLOW_LAYERS = [
        { scale: 1.60, alpha: 0.09 },
        { scale: 1.40, alpha: 0.12 },
        { scale: 1.26, alpha: 0.15 },
        { scale: 1.13, alpha: 0.19 },
    ];
    // Won (gold) paths breathe their glow — a celebratory pulse, slower and
    // gentler than the joined-red alarm (whose palette itself flickers via
    // litPalette; its glow inherits that color modulation for free).
    const GOLD_GLOW_PULSE_PERIOD_MS = 1500;
    const GOLD_GLOW_PULSE_AMP      = 0.45;
    function strokeGlowLayer(w, rim, pathIdx) {
        const p = litPalette(pathIdx);
        const outerW = w + rim * 2;
        const idx = pathIdx | 0;
        const pathsWon = Maze.pathsWon || [Maze.won, true, true, true];
        let boost = 1;
        if (idx >= 0 && pathsWon[idx]) {
            const phase = (Date.now() / GOLD_GLOW_PULSE_PERIOD_MS) * 2 * Math.PI;
            boost = 1 + GOLD_GLOW_PULSE_AMP * Math.sin(phase);
        }
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        // Butt caps: the glow ends flush with a dead-end lane's endpoint —
        // no bulb of light past the open end. Round joins still soften the
        // corners along elbows and the terminal rings.
        ctx.lineCap  = 'butt';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = p.base;
        for (const g of GLOW_LAYERS) {
            ctx.globalAlpha = Math.min(1, g.alpha * boost);
            ctx.lineWidth   = outerW * g.scale;
            ctx.stroke();
        }
        ctx.restore();
    }

    // The cell corner shared by the two ports of an elbow lane. The path's
    // quarter-arc is centered there.
    function elbowCorner(px, py, portA, portB) {
        const cs = cellSize;
        const has = (p) => portA === p || portB === p;
        if (has(Maze.N) && has(Maze.E)) return { x: px + cs, y: py      };
        if (has(Maze.E) && has(Maze.S)) return { x: px + cs, y: py + cs };
        if (has(Maze.S) && has(Maze.W)) return { x: px,      y: py + cs };
        return                                 { x: px,      y: py      }; // W-N
    }

    // Lane centerline geometry WITHOUT beginPath — lets callers accumulate
    // many lanes into one combined path (the glow pass strokes a whole
    // path-group at once so overlapping segments paint uniformly).
    function laneGeom(px, py, portA, portB) {
        const a        = portMidpoint(px, py, portA);
        const b        = portMidpoint(px, py, portB);
        const opposite = ((portA + 2) & 3) === portB;
        if (opposite) {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
        } else {
            // Quarter-arc from port A to port B around the corner shared by
            // both ports. Radius = cellSize/2, so the arc passes exactly
            // through both port midpoints. Direction = the short way (≤180°
            // sweep), which is always a 90° quarter-turn for adjacent ports.
            // This matches the curved-elbow walls' inner/outer arcs.
            const corner     = elbowCorner(px, py, portA, portB);
            const startAngle = Math.atan2(a.y - corner.y, a.x - corner.x);
            const endAngle   = Math.atan2(b.y - corner.y, b.x - corner.x);
            const dCW = ((endAngle - startAngle) + 2 * Math.PI) % (2 * Math.PI);
            const anticlockwise = dCW > Math.PI;
            // Snippet mode (title-O): extend each elbow's arc by ~1px of
            // arc-length on both ends so adjacent tiles' butt caps overlap
            // by ~2px at every shared port instead of meeting at a
            // sub-pixel boundary. Without this overlap the AA on butt-cap
            // junctions leaves a hair-thin transparent sliver between the
            // arcs and the body background bleeds through as a dark seam
            // cutting the red O. In-game tiles keep the exact butt-to-butt
            // joins (snippetMode false) so cross intersections stay clean.
            let s = startAngle, e = endAngle;
            if (snippetMode) {
                const eps = 2 / cellSize; // 1px / radius, where radius = cellSize/2
                if (anticlockwise) { s += eps; e -= eps; }
                else               { s -= eps; e += eps; }
                ctx.arc(corner.x, corner.y, cellSize / 2, s, e, anticlockwise);
            } else {
                ctx.moveTo(a.x, a.y);
                ctx.arc(corner.x, corner.y, cellSize / 2, s, e, anticlockwise);
            }
        }
    }

    function pathChannel(px, py, portA, portB) {
        ctx.beginPath();
        laneGeom(px, py, portA, portB);
    }

    function drawChannelRim(px, py, portA, portB, w, rim) {
        pathChannel(px, py, portA, portB);
        strokeRimLayer(w, rim);
    }

    // For straight (opposite-port) channels, fillRect avoids stroke butt-cap
    // AA artifacts at every shared edge between adjacent tiles. Adjacent
    // fillRects share an integer-pixel boundary, so the rendering is
    // pixel-perfect even at fractional device pixels (DPR != 1).
    function drawStraightRim(px, py, isVertical, w, rim) {
        const half = cellSize / 2;
        const channelHalf = w / 2 + rim;
        ctx.fillStyle = effectiveGrooveRim();
        if (isVertical) ctx.fillRect(px + half - channelHalf, py, channelHalf * 2, cellSize);
        else            ctx.fillRect(px, py + half - channelHalf, cellSize, channelHalf * 2);
    }
    function drawStraightLit(px, py, isVertical, w, rim, pathIdx) {
        const half = cellSize / 2;
        const stripes = litStripes(w, rim, pathIdx);
        if (isVertical) {
            const midX = px + half;
            for (const s of stripes) {
                ctx.fillStyle = s.color;
                ctx.fillRect(midX - s.width / 2, py, s.width, cellSize);
            }
        } else {
            const midY = py + half;
            for (const s of stripes) {
                ctx.fillStyle = s.color;
                ctx.fillRect(px, midY - s.width / 2, cellSize, s.width);
            }
        }
    }

    function drawChannelLit(px, py, portA, portB, w, rim, pathIdx) {
        pathChannel(px, py, portA, portB);
        strokeLitLayer(w, rim, pathIdx);
    }

    // ---- entry/exit notches + external circuit connector ----
    // Two modes, chosen by COMPLETE_CIRCUITS:
    //  - terminal pads (default): each entry/exit gets a short stub from
    //    the grid edge into a glowing square ring pad (see drawTerminal).
    //  - wrap mode: the notch is a recessed channel that extends out of the
    //    entry/exit cell into the perimeter padding, and the external
    //    connector continues from the entry notch's outer endpoint around
    //    the grid perimeter to the exit notch's outer endpoint, closing the
    //    circuit. All three (notches + connector + internal cell channels)
    //    share the same rim/dark/lit layering so they read as one
    //    continuous loop.

    function notchLength() {
        // Tied to cellSize, not to the pad — the connector stroke needs room
        // BEYOND the notch endpoint. Keep notch + stroke_half < pad.
        // 0.3 (was 0.4): at 0.4 the single-path perimeter loop's top run
        // grazed the HUD buttons on short-and-wide grids (the canvas is
        // viewport-centered, so the loop can reach up under the HUD strip —
        // observed on CG with the 6×4 Zen puzzle). Pulling the ring in a
        // third clears the buttons by ~12px at that size while the notch
        // grooves + route corners (both keyed off this) shrink in step.
        return Math.max(6, Math.floor(cellSize * 0.3));
    }

    // Outer endpoint of a notch (the point in the perimeter padding that the
    // external connector hooks into). Inner endpoint sits on the grid edge.
    function notchOuterPoint(side, row, col) {
        const px = originX + col * cellSize;
        const py = originY + row * cellSize;
        const len  = notchLength();
        const half = cellSize / 2;
        if (side === Maze.N) return { x: px + half,            y: py - len };
        if (side === Maze.S) return { x: px + half,            y: py + cellSize + len };
        if (side === Maze.W) return { x: px - len,             y: py + half };
        return                      { x: px + cellSize + len,  y: py + half }; // E
    }

    // Outer endpoint of a notch with an explicit length. Allows path 0 and
    // path 1 in two-path mode to use different ring offsets so their
    // perimeter polylines don't overlap.
    function notchOuterPointAt(side, row, col, len) {
        const px = originX + col * cellSize;
        const py = originY + row * cellSize;
        const half = cellSize / 2;
        if (side === Maze.N) return { x: px + half,            y: py - len };
        if (side === Maze.S) return { x: px + half,            y: py + cellSize + len };
        if (side === Maze.W) return { x: px - len,             y: py + half };
        return                      { x: px + cellSize + len,  y: py + half }; // E
    }

    // Square terminal pad at one entry/exit (COMPLETE_CIRCUITS=false mode):
    // a short stub from the grid edge feeds a glowing square ring — the
    // neon "endpoint" look from the promo art. Drawn with the same
    // strokeLitLayer stripes as the paths, so it shares the path's color
    // (and turns gold with it on completion).
    //
    // Geometry is nominal (fractions of cellSize) but clamps to the actual
    // padding available on that side, so smaller layouts (e.g. the tutorial
    // canvas) degrade to a shorter stub / smaller ring instead of clipping
    // at the canvas edge.
    const TERM_RING_HALF_FRAC    = 0.145; // ring centerline half-size
    const TERM_STUB_FRAC         = 0.10;  // visible stub length between grid edge and ring
    const TERM_RING_STROKE_SCALE = 0.72;  // ring band width relative to the path's

    // Shared terminal geometry — used by drawTerminal (crisp stripes), and
    // by the glow pass (trace + erase), so all three always agree.
    function terminalGeom(ep, w, rim) {
        const side  = ep.port;
        const inner = notchInnerPoint(side, ep.row, ep.col);
        const dirX  = side === Maze.W ? -1 : side === Maze.E ? 1 : 0;
        const dirY  = side === Maze.N ? -1 : side === Maze.S ? 1 : 0;
        // The ring is stroked thinner than the path so the pad stays small
        // WITHOUT closing up its dark center hole.
        const ringW = Math.max(3, Math.round(w * TERM_RING_STROKE_SCALE));
        const ringHalfStroke = (ringW + rim * 2) / 2;
        // Actual padding from the grid edge to the canvas edge on this side.
        const gridW = cellSize * Maze.COLS;
        const gridH = cellSize * Maze.ROWS;
        const avail = (side === Maze.N ? originY
                     : side === Maze.S ? canvas.height - originY - gridH
                     : side === Maze.W ? originX
                     :                   canvas.width  - originX - gridW) - 2;
        let ringHalf = cellSize * TERM_RING_HALF_FRAC;
        let stub     = cellSize * TERM_STUB_FRAC;
        // Total outward reach = stub + ring diameter incl. stroke. Shrink
        // the stub first, then the ring (floor: solid square, no hole).
        if (stub + 2 * (ringHalf + ringHalfStroke) > avail) {
            stub = Math.max(0, avail - 2 * (ringHalf + ringHalfStroke));
            if (stub + 2 * (ringHalf + ringHalfStroke) > avail) {
                ringHalf = Math.max(ringHalfStroke + 1, avail / 2 - ringHalfStroke);
            }
        }
        const centerD = stub + ringHalf + ringHalfStroke;
        return {
            inner, dirX, dirY, ringW, ringHalf, ringHalfStroke,
            cx: inner.x + dirX * centerD,
            cy: inner.y + dirY * centerD,
        };
    }

    // Add a terminal's centerline geometry to the CURRENT path (no
    // beginPath) — glow-pass counterpart of laneGeom. includeRing=false
    // traces just the stub (the erase pass handles rings via fillRect
    // instead, to avoid over-erasing past the thinner ring band's edge).
    function traceTerminalGeom(ep, w, rim, includeRing) {
        const g = terminalGeom(ep, w, rim);
        ctx.moveTo(g.inner.x, g.inner.y);
        ctx.lineTo(g.cx - g.dirX * g.ringHalf, g.cy - g.dirY * g.ringHalf);
        if (includeRing) {
            ctx.rect(g.cx - g.ringHalf, g.cy - g.ringHalf, g.ringHalf * 2, g.ringHalf * 2);
        }
    }

    function drawTerminal(ep, w, rim, pathIdx) {
        const g = terminalGeom(ep, w, rim);
        const stubPath = () => {
            ctx.beginPath();
            ctx.moveTo(g.inner.x, g.inner.y);
            ctx.lineTo(g.cx - g.dirX * g.ringHalf, g.cy - g.dirY * g.ringHalf);
        };
        const ringPath = () => {
            ctx.beginPath();
            ctx.rect(g.cx - g.ringHalf, g.cy - g.ringHalf, g.ringHalf * 2, g.ringHalf * 2);
        };

        // No glow here — terminals glow in Pass E (drawGlowPass) as part of
        // their path's union trace, so the glow can't stack additively with
        // the stub's/lanes' and gets the same band + hole erase treatment.

        const prevJoin = ctx.lineJoin;
        ctx.lineJoin = 'round';
        // Stub (grid edge → the ring's near centerline) and ring carry
        // different stroke widths, so they can't share one path — instead
        // their stripes INTERLEAVE, dark→bright in lockstep (stripe colors
        // at each step are identical, only widths differ). Nothing dark is
        // ever painted over an already-bright stripe, so the stub's hot
        // core runs unbroken into the ring's at the T-junction. Round joins
        // soften the ring corners of the wide outer stripes into the promo
        // art's rounded-square silhouette.
        const stubStripes = litStripes(w,       rim, pathIdx);
        const ringStripes = litStripes(g.ringW, rim, pathIdx);
        for (let i = 0; i < stubStripes.length; i++) {
            stubPath();
            ctx.strokeStyle = stubStripes[i].color;
            ctx.lineWidth   = stubStripes[i].width;
            ctx.stroke();
            ringPath();
            ctx.strokeStyle = ringStripes[i].color;
            ctx.lineWidth   = ringStripes[i].width;
            ctx.stroke();
        }
        ctx.lineJoin = prevJoin;
    }

    // Inner endpoint of a notch (the point ON the grid edge at the cell port).
    function notchInnerPoint(side, row, col) {
        const px = originX + col * cellSize;
        const py = originY + row * cellSize;
        const half = cellSize / 2;
        if (side === Maze.N) return { x: px + half,           y: py };
        if (side === Maze.S) return { x: px + half,           y: py + cellSize };
        if (side === Maze.W) return { x: px,                  y: py + half };
        return                      { x: px + cellSize,       y: py + half }; // E
    }

    // Determine which sides (and outer-track corners) a path's polyline
    // traverses. Routing is computed with a constant baseLen — the choice
    // of offsets only affects RENDERING positions, not which corners the
    // polyline goes through.
    function computePathRoute(entry, exit) {
        const baseLen = notchLength();
        const gridW = cellSize * Maze.COLS;
        const gridH = cellSize * Maze.ROWS;
        const corners = [
            { x: originX - baseLen,         y: originY - baseLen },
            { x: originX + gridW + baseLen, y: originY - baseLen },
            { x: originX + gridW + baseLen, y: originY + gridH + baseLen },
            { x: originX - baseLen,         y: originY + gridH + baseLen }
        ];
        const sideLen = [
            corners[1].x - corners[0].x,
            corners[2].y - corners[1].y,
            corners[2].x - corners[3].x,
            corners[3].y - corners[0].y
        ];
        const cornerT = [0, sideLen[0], sideLen[0] + sideLen[1], sideLen[0] + sideLen[1] + sideLen[2]];
        const perimeter = cornerT[3] + sideLen[3];
        function tOf(side, row, col) {
            const half = cellSize / 2;
            const px = originX + col * cellSize;
            const py = originY + row * cellSize;
            if (side === Maze.N) return cornerT[0] + (px + half - corners[0].x);
            if (side === Maze.E) return cornerT[1] + (py + half - corners[1].y);
            if (side === Maze.S) return cornerT[2] + (corners[2].x - (px + half));
            return                      cornerT[3] + (corners[3].y - (py + half));
        }
        const aT = tOf(entry.port, entry.row, entry.col);
        const bT = tOf(exit.port,  exit.row,  exit.col);
        const cwDist = (bT - aT + perimeter) % perimeter;
        const goCW   = cwDist <= perimeter / 2;
        const limit  = goCW ? cwDist : perimeter - cwDist;
        const distFn = goCW ? (cT) => (cT - aT + perimeter) % perimeter
                            : (cT) => (aT - cT + perimeter) % perimeter;
        const cornersOnRoute = [];
        for (let i = 0; i < 4; i++) {
            const d = distFn(cornerT[i]);
            if (d > 0 && d < limit) cornersOnRoute.push({ d, idx: i });
        }
        cornersOnRoute.sort((p, q) => p.d - q.d);
        const cornerIdx = cornersOnRoute.map((c) => c.idx);

        // Sides traversed: entry side → between consecutive corners → exit side.
        // Adjacent corners share a unique side: (TL,TR)=N (TR,BR)=E (BR,BL)=S (BL,TL)=W.
        function commonSide(a, b) {
            const lo = Math.min(a, b), hi = Math.max(a, b);
            if (lo === 0 && hi === 1) return Maze.N;
            if (lo === 1 && hi === 2) return Maze.E;
            if (lo === 2 && hi === 3) return Maze.S;
            if (lo === 0 && hi === 3) return Maze.W;
            return -1;
        }
        const sidesArr = [entry.port];
        for (let i = 0; i + 1 < cornerIdx.length; i++) {
            sidesArr.push(commonSide(cornerIdx[i], cornerIdx[i + 1]));
        }
        if (cornerIdx.length > 0 || entry.port !== exit.port) sidesArr.push(exit.port);
        // Set of unique sides used (for usage tabulation).
        const sidesUsed = new Set(sidesArr);

        // Per-side perimeter-coord intervals — used by drawCircuitOutline to
        // cluster only paths that ACTUALLY overlap on a side, not all paths
        // that touch the side. Stored as { sideIdx: [[pt0, pt1], ...] }.
        const sideSpans = {};
        function pushSpan(side, pt0, pt1) {
            if (pt0 > pt1) { const t = pt0; pt0 = pt1; pt1 = t; }
            if (!sideSpans[side]) sideSpans[side] = [];
            sideSpans[side].push([pt0, pt1]);
        }
        function sideEndOf(s) { return s === 3 ? perimeter : cornerT[s + 1]; }
        if (cornerIdx.length === 0 && entry.port === exit.port) {
            // Both endpoints on the same side, no corners between.
            pushSpan(entry.port, aT, bT);
        } else {
            // Entry side: from aT to whichever end the route heads toward.
            if (goCW) pushSpan(entry.port, aT, sideEndOf(entry.port));
            else      pushSpan(entry.port, cornerT[entry.port], aT);
            // Intermediate sides: full corner-to-corner.
            for (let i = 1; i < sidesArr.length - 1; i++) {
                const s = sidesArr[i];
                pushSpan(s, cornerT[s], sideEndOf(s));
            }
            // Exit side: from the entering corner to bT.
            if (goCW) pushSpan(exit.port, cornerT[exit.port], bT);
            else      pushSpan(exit.port, bT, sideEndOf(exit.port));
        }

        return { corners: cornerIdx, sides: sidesArr, sidesUsed: sidesUsed, sideSpans: sideSpans };
    }

    // The full external loop for ONE entry/exit pair, drawn as one polyline
    // with smooth round joins. Each side traversed by the path uses its own
    // offset from the grid edge — paths that share a perimeter side fan
    // out by rank; paths alone on a side stay close to baseLen.
    function drawCircuitOutlinePair(w, rim, entry, exit, pathIdx, route, pathOffsets) {
        const gridW = cellSize * Maze.COLS;
        const gridH = cellSize * Maze.ROWS;
        // Per-path corners — each axis uses the offset of the bordering side.
        const off = pathOffsets;
        const pathCorners = [
            { x: originX - (off[Maze.W] || 0),         y: originY - (off[Maze.N] || 0)         }, // TL
            { x: originX + gridW + (off[Maze.E] || 0), y: originY - (off[Maze.N] || 0)         }, // TR
            { x: originX + gridW + (off[Maze.E] || 0), y: originY + gridH + (off[Maze.S] || 0) }, // BR
            { x: originX - (off[Maze.W] || 0),         y: originY + gridH + (off[Maze.S] || 0) }  // BL
        ];
        const entryInner = notchInnerPoint(entry.port, entry.row, entry.col);
        const entryOuter = notchOuterPointAt(entry.port, entry.row, entry.col, off[entry.port]);
        const exitOuter  = notchOuterPointAt(exit.port,  exit.row,  exit.col,  off[exit.port]);
        const exitInner  = notchInnerPoint(exit.port,  exit.row,  exit.col);

        ctx.beginPath();
        ctx.moveTo(entryInner.x, entryInner.y);
        ctx.lineTo(entryOuter.x, entryOuter.y);
        for (const idx of route.corners) {
            ctx.lineTo(pathCorners[idx].x, pathCorners[idx].y);
        }
        ctx.lineTo(exitOuter.x, exitOuter.y);
        ctx.lineTo(exitInner.x, exitInner.y);

        const prevJoin = ctx.lineJoin;
        ctx.lineJoin = 'round';
        // Glow first, crisp stripes on top — the opaque stripes re-cover
        // the band so the glow only reads OUTSIDE the path.
        strokeGlowLayer(w, rim, pathIdx);
        strokeLitLayer(w, rim, pathIdx);
        ctx.lineJoin = prevJoin;
    }

    // Draw circuit outlines for all active entry/exit pairs (1, 2, or 3).
    // Each pair uses its own palette: path 0 green, path 1 blue, path 2
    // pink (each turns gold individually on completion). Per-side offsets
    // mean paths alone on a perimeter side stay close to baseLen; paths
    // that SHARE a side fan out by rank between minR (just clear of the
    // grid) and maxR (just inside the canvas padding).
    // All active entry/exit pairs with their path indices — shared by the
    // outline/terminal draw and the glow pass.
    function collectPairs() {
        const pairs = [];
        if (Maze.entry  && Maze.exit)  pairs.push({ entry: Maze.entry,  exit: Maze.exit,  pathIdx: 0 });
        if (Maze.entry2 && Maze.exit2) pairs.push({ entry: Maze.entry2, exit: Maze.exit2, pathIdx: 1 });
        if (Maze.entry3 && Maze.exit3) pairs.push({ entry: Maze.entry3, exit: Maze.exit3, pathIdx: 2 });
        if (Maze.entry4 && Maze.exit4) pairs.push({ entry: Maze.entry4, exit: Maze.exit4, pathIdx: 3 });
        return pairs;
    }

    function drawCircuitOutline(w, rim) {
        const pairs = collectPairs();

        // Terminal-pad mode: no perimeter routing at all — every entry and
        // exit gets a stub + square pad local to its own port. Route/cluster
        // computation below only matters for the wrap-around polylines.
        if (!COMPLETE_CIRCUITS) {
            for (const p of pairs) {
                drawTerminal(p.entry, w, rim, p.pathIdx);
                drawTerminal(p.exit,  w, rim, p.pathIdx);
            }
            return;
        }

        const baseLen = notchLength();
        if (pairs.length === 1) {
            const p0 = pairs[0];
            const offs = {};
            offs[p0.entry.port] = baseLen;
            offs[p0.exit.port]  = baseLen;
            const route = computePathRoute(p0.entry, p0.exit);
            for (const s of route.sidesUsed) offs[s] = baseLen;
            drawCircuitOutlinePair(w, rim, p0.entry, p0.exit, p0.pathIdx, route, offs);
            return;
        }

        // Compute each path's route, then build per-side overlap clusters.
        // Two paths sharing a perimeter side only need to fan out if their
        // ROUTE INTERVALS on that side overlap — paths whose intervals are
        // disjoint (e.g. one along the top of E, another along the bottom)
        // can both sit at baseLen without colliding visually.
        const routes = pairs.map((p) => computePathRoute(p.entry, p.exit));
        const sideClusters = [[], [], [], []]; // each entry: array of clusters, each cluster = list of pairIdx
        for (let side = 0; side < 4; side++) {
            const items = [];
            for (let i = 0; i < pairs.length; i++) {
                const spans = routes[i].sideSpans && routes[i].sideSpans[side];
                if (!spans) continue;
                for (const [lo, hi] of spans) items.push({ pairIdx: i, lo, hi });
            }
            if (items.length === 0) continue;
            items.sort((a, b) => a.lo - b.lo);
            let cur = [items[0].pairIdx];
            let curHi = items[0].hi;
            for (let i = 1; i < items.length; i++) {
                if (items[i].lo <= curHi) {
                    if (cur.indexOf(items[i].pairIdx) < 0) cur.push(items[i].pairIdx);
                    curHi = Math.max(curHi, items[i].hi);
                } else {
                    sideClusters[side].push(cur);
                    cur = [items[i].pairIdx];
                    curHi = items[i].hi;
                }
            }
            sideClusters[side].push(cur);
        }

        // (pairIdx, side) → { size, rank } for the cluster that pair belongs to.
        const clusterInfo = pairs.map(() => ({}));
        for (let side = 0; side < 4; side++) {
            for (const cluster of sideClusters[side]) {
                for (let r = 0; r < cluster.length; r++) {
                    clusterInfo[cluster[r]][side] = { size: cluster.length, rank: r };
                }
            }
        }

        const stroke     = w + rim * 2;
        const halfStroke = stroke / 2;
        const step       = stroke + 2; // center-to-center: full stroke + 2px gap so strokes don't overlap

        // Per-(path, side) offset: alone in its cluster → baseLen; shared
        // cluster → tight ring stack around baseLen, each rank separated by
        // `step`. If the innermost ring would sit inside the grid edge,
        // shift ALL rings outward by the same amount so spacing stays
        // symmetric (vs. just clamping the inner ring, which would squeeze
        // its gap to the next ring).
        const minR = halfStroke + 2;
        function offsetFor(pairIdx, side) {
            const info = clusterInfo[pairIdx][side];
            if (!info || info.size <= 1) return baseLen;
            const center = (info.size - 1) / 2;
            const innerPos = baseLen + (0 - center) * step;
            const shift    = Math.max(0, minR - innerPos);
            return baseLen + (info.rank - center) * step + shift;
        }

        for (let i = 0; i < pairs.length; i++) {
            const offs = {};
            for (const side of routes[i].sidesUsed) offs[side] = offsetFor(i, side);
            drawCircuitOutlinePair(w, rim, pairs[i].entry, pairs[i].exit, pairs[i].pathIdx, routes[i], offs);
        }
    }

    // ---- pulse animation ----
    //
    // Hint tiles (HINT_PALETTE) breathe slowly — visual cue that they're
    // not just twin-colored, they're hint-locked. Their twin partners get
    // a different look: face stays the twin color but the bevels go red,
    // marking them as "yoked to a hint" without making them look fully
    // locked. When the player tries to rotate either tile in a hint+twin
    // pair, both tiles flash red dramatically (mirrored) — the rejection
    // is loud enough that you can see *why* it bounced.

    let animationFrameId   = null;
    let dramaticPulseTiles = null;   // [{r,c}, …] tiles in the active flash
    let dramaticPulseStart = 0;      // 0 = no flash active
    const HINT_PULSE_PERIOD_MS = 1500;
    const HINT_PULSE_AMP       = 0.18;
    const DRAMATIC_PULSE_MS    = 600;
    const DRAMATIC_PULSE_AMP   = 0.85;

    // Broken-chain fade. When a twin twist breaks the OTHER path (the SFX-
    // eligible case), the orphaned downstream lanes don't cut out — they
    // briefly FLASH (extra-bright via additive composite) so the player's
    // eye catches the boo/gasp moment, then ramp from full lit alpha to 0
    // over BROKEN_FADE_MS. Driven by game.js via Render.fadeLanes(entries).
    // Entries reference lane port-pairs by (r, c, a, b); the tile rotations
    // of these cells are unchanged by the twist (A and B are excluded), so
    // the lane is still physically present and renderable from the
    // post-rotation grid state.
    const FLASH_BEFORE_FADE_MS = 200;
    const BROKEN_FADE_MS       = 1500;
    const FADE_LIFE_MS         = FLASH_BEFORE_FADE_MS + BROKEN_FADE_MS;
    const fadingLanes = [];   // [{ r, c, a, b, pathIdx, startTime }]

    // Tile rotation animations — when enabled, tiles spin smoothly to their
    // new orientation rather than snapping. Maze state is mutated immediately
    // on click; this just animates the visual transition. At t=0 the tile is
    // drawn rotated by -delta (looks like the OLD position); at t=1 it's at
    // 0 (the actual NEW position).
    let ANIMATE_ROTATIONS = true;
    const ROTATION_ANIM_MS = 200;
    let rotationAnims = []; // [{ cx, cy, deltaRad, startTime, duration, keys: Set<"r,c"> }]
    let gateAnims     = []; // [{ gate, cx, cy, deltaRad, startTime, duration }] — gates rotate in unison but each spins around its own vertex
    function setAnimateRotations(on) { ANIMATE_ROTATIONS = !!on; }

    // Public API: schedule an animation for a click that already mutated
    // the Maze state. In quad mode the whole 2×2 quad spins together;
    // otherwise just the single tile — plus its twin partner if it has
    // one (twin pairs rotate in lockstep, so the partner needs its own
    // visual spin around its own center).
    function animateRotationAt(r, c, ccw, turns) {
        if (!ANIMATE_ROTATIONS) return;
        const turnCount = turns == null ? 1 : turns;
        if (turnCount === 0) return;   // nothing to animate
        const startTime = Date.now();
        const deltaRad = (ccw ? -Math.PI / 2 : Math.PI / 2) * turnCount;
        function pushTileAnim(tr, tc) {
            rotationAnims.push({
                cx: originX + tc * cellSize + cellSize / 2,
                cy: originY + tr * cellSize + cellSize / 2,
                deltaRad, startTime, duration: ROTATION_ANIM_MS,
                keys: new Set([tr + ',' + tc])
            });
        }
        function pushQuadAnim(qr0, qc0) {
            const keys = new Set();
            keys.add(qr0     + ',' + qc0    );
            keys.add(qr0     + ',' + (qc0+1));
            keys.add((qr0+1) + ',' + qc0    );
            keys.add((qr0+1) + ',' + (qc0+1));
            rotationAnims.push({
                cx: originX + (qc0 + 1) * cellSize,
                cy: originY + (qr0 + 1) * cellSize,
                deltaRad, startTime, duration: ROTATION_ANIM_MS,
                keys
            });
        }
        if (Maze.quadMode) {
            const qr0 = Math.floor(r / 2) * 2;
            const qc0 = Math.floor(c / 2) * 2;
            pushQuadAnim(qr0, qc0);
            // Twin partner quad spins in lockstep, around ITS own center.
            const tile = Maze.grid[qr0] && Maze.grid[qr0][qc0];
            if (tile && tile._twin) {
                const [pr0, pc0] = tile._twin.partner.split(',').map(Number);
                if (pr0 !== qr0 || pc0 !== qc0) pushQuadAnim(pr0, pc0);
            }
        } else {
            pushTileAnim(r, c);
            // Twin partner spins in lockstep, around ITS own center.
            const tile = Maze.grid[r] && Maze.grid[r][c];
            if (tile && tile._twin) {
                const [tr, tc] = tile._twin.partner.split(',').map(Number);
                pushTileAnim(tr, tc);
            }
        }
        // Maze.rotate has changed grid state; the canvas still shows the
        // PRE-rotate scene. Force the next draw to be a full drawCore so
        // partial-redraw frames after it have a correct backdrop outside
        // the dirty region.
        needsFullDraw = true;
        ensureAnimating();
        // Belt-and-braces final frame. On large grids the rAF chain can drop
        // the post-animation frame (when each draw takes 10+ms, intervals
        // can stretch to 30-50ms instead of 16ms), leaving a residual-tilt
        // frame visible. Forcing one draw 30ms past the natural duration
        // guarantees the tile settles cleanly to identity even if the
        // rAF cadence stuttered around the end of the animation.
        setTimeout(function () { if (ctx) draw(); }, ROTATION_ANIM_MS + 30);
    }

    // Compute the current rotation transform for a sub-tile, summed across
    // all active rotation animations that affect it. Returns null if none.
    //
    // Animation interpolates all the way to t=1 (angle = 0). The final
    // identity frame is guaranteed by a setTimeout in animateRotationAt,
    // so even if the rAF chain drops the last frame on a slow draw, we
    // still settle cleanly without leaving a residual tilt on screen.
    function tileRotationTransform(r, c) {
        if (rotationAnims.length === 0) return null;
        const now = Date.now();
        const key = r + ',' + c;
        let totalAngle = 0;
        let cx = 0, cy = 0;
        let found = false;
        for (const anim of rotationAnims) {
            if (!anim.keys.has(key)) continue;
            const t = (now - anim.startTime) / anim.duration;
            if (t >= 1) continue;
            totalAngle += -anim.deltaRad * (1 - t);
            cx = anim.cx; cy = anim.cy;
            found = true;
        }
        return found ? { cx, cy, angle: totalAngle } : null;
    }

    // Wrap a per-tile drawing operation with the rotation transform if any.
    // Operates on the current `ctx` — works for both main and offscreen
    // ctxs (which the draw pipeline swaps via the `ctx` module variable).
    function withTileRotation(r, c, fn) {
        const t = tileRotationTransform(r, c);
        if (!t) { fn(); return; }
        ctx.save();
        ctx.translate(t.cx, t.cy);
        ctx.rotate(t.angle);
        ctx.translate(-t.cx, -t.cy);
        fn();
        ctx.restore();
    }

    function pruneFinishedRotations() {
        if (rotationAnims.length === 0) return;
        const now = Date.now();
        rotationAnims = rotationAnims.filter((a) => (now - a.startTime) < a.duration);
    }

    // Gate rotation animations. All gates rotate in unison (one player tap
    // rotates them all), but each gate spins around its own vertex center —
    // mirroring the twin-tile pattern where partners spin around their own
    // centers, not a shared pivot.
    function animateGateRotation(ccw) {
        if (!ANIMATE_ROTATIONS) return;
        if (typeof Gates === 'undefined' || !Gates.list || Gates.list.length === 0) return;
        const startTime = Date.now();
        const deltaRad = ccw ? -Math.PI / 2 : Math.PI / 2;
        for (const gate of Gates.list) {
            gateAnims.push({
                gate,
                cx: originX + gate.vc * cellSize,
                cy: originY + gate.vr * cellSize,
                deltaRad, startTime, duration: ROTATION_ANIM_MS
            });
        }
        needsFullDraw = true;
        ensureAnimating();
        setTimeout(function () { if (ctx) draw(); }, ROTATION_ANIM_MS + 30);
    }

    function gateRotationTransform(gate) {
        if (gateAnims.length === 0) return null;
        const now = Date.now();
        let cx = 0, cy = 0, angle = 0;
        let found = false;
        for (const anim of gateAnims) {
            if (anim.gate !== gate) continue;
            const t = (now - anim.startTime) / anim.duration;
            if (t >= 1) continue;
            angle += -anim.deltaRad * (1 - t);
            cx = anim.cx; cy = anim.cy;
            found = true;
        }
        return found ? { cx, cy, angle } : null;
    }

    function withGateRotation(gate, fn) {
        const t = gateRotationTransform(gate);
        if (!t) { fn(); return; }
        ctx.save();
        ctx.translate(t.cx, t.cy);
        ctx.rotate(t.angle);
        ctx.translate(-t.cx, -t.cy);
        fn();
        ctx.restore();
    }

    function pruneFinishedGateAnims() {
        if (gateAnims.length === 0) return;
        const now = Date.now();
        gateAnims = gateAnims.filter((a) => (now - a.startTime) < a.duration);
    }

    // Hit-test for gates. Returns the gate object or null. Caller passes
    // CSS pixel coords; internal conversion to device pixels mirrors cellAt.
    function gateAt(cssX, cssY) {
        if (typeof Gates === 'undefined' || !Gates.list || Gates.list.length === 0) return null;
        const x = cssX * dpr;
        const y = cssY * dpr;
        const cs = cellSize;
        for (const gate of Gates.list) {
            const cx = originX + gate.vc * cs;
            const cy = originY + gate.vr * cs;
            if (Gates.hitTest(gate, cs, cx, cy, x, y)) return gate;
        }
        return null;
    }

    function tick() {
        animationFrameId = null;
        draw();   // draw() schedules the next frame if needed
    }
    function ensureAnimating() {
        if (animationFrameId !== null) return;
        animationFrameId = requestAnimationFrame(tick);
    }

    // Start fading the given highlighted entries out — see BROKEN_FADE_MS
    // comment for context. Entries are the original Maze.highlighted shape
    // (row, col, inPort, outPort, path); we normalize to lo/hi port pairs
    // here so the render pass doesn't have to.
    function fadeLanes(entries) {
        if (!entries || entries.length === 0) return;
        const now = Date.now();
        for (const e of entries) {
            const inPort  = e.inPort  | 0;
            const outPort = e.outPort | 0;
            fadingLanes.push({
                r: e.row | 0,
                c: e.col | 0,
                a: Math.min(inPort, outPort),
                b: Math.max(inPort, outPort),
                pathIdx: e.path | 0,
                startTime: now,
            });
        }
        ensureAnimating();
    }
    function clearFadingLanes() {
        fadingLanes.length = 0;
    }
    function shouldKeepAnimating() {
        const grid = Maze.grid;
        if (!grid) return false;
        if (rotationAnims.length > 0) return true;
        if (gateAnims.length > 0) return true;
        if (dramaticPulseStart && (Date.now() - dramaticPulseStart) < DRAMATIC_PULSE_MS) return true;
        for (let r = 0; r < Maze.ROWS; r++) {
            for (let c = 0; c < Maze.COLS; c++) {
                if (grid[r][c]._hinted) return true;
            }
        }
        if (hasJoinedLanes()) return true;
        if (anyPathWon()) return true;   // gold glow breathes until the puzzle is torn down
        if (fadingLanes.length > 0) return true;
        return false;
    }
    // True when any EXISTING path is currently gold. Can't just scan
    // Maze.pathsWon — non-existent paths read `true` there (so the overall
    // `won` AND works), which would keep the pulse loop running forever.
    function anyPathWon() {
        const pw = Maze.pathsWon;
        if (!pw) return !!Maze.won;
        return collectPairs().some((p) => pw[p.pathIdx]);
    }
    // Conflict scan over Maze.highlighted: two entries on the same (cell, lane)
    // with different path indexes means the player has joined two colored paths,
    // and that lane should flash dark red. Used by draw() and shouldKeepAnimating
    // BEFORE buildLitKeys has run (so we can't peek at its -2 sentinels yet).
    function hasJoinedLanes() {
        const h = Maze.highlighted;
        if (!h || h.length === 0) return false;
        const seen = new Map();
        for (const e of h) {
            const a = Math.min(e.inPort, e.outPort), b = Math.max(e.inPort, e.outPort);
            const key = e.row + ',' + e.col + ',' + a + ',' + b;
            const newPath = e.path | 0;
            const prev = seen.get(key);
            if (prev !== undefined && prev !== newPath) return true;
            seen.set(key, newPath);
        }
        return false;
    }
    function flashTwinPair(r, c) {
        const tile = Maze.grid[r][c];
        const tiles = [];
        function addQuad(qr0, qc0) {
            tiles.push({ r: qr0,     c: qc0     });
            tiles.push({ r: qr0,     c: qc0 + 1 });
            tiles.push({ r: qr0 + 1, c: qc0     });
            tiles.push({ r: qr0 + 1, c: qc0 + 1 });
        }
        if (Maze.quadMode) {
            // Pulse spans the WHOLE clicked quad and the WHOLE partner quad —
            // not just the clicked sub-tile and the partner-quad's TL — so the
            // lock relationship reads at quad scale, matching how the player
            // perceives a quad as one tile.
            const qr0 = Math.floor(r / 2) * 2;
            const qc0 = Math.floor(c / 2) * 2;
            addQuad(qr0, qc0);
            if (tile && tile._twin) {
                const [pr0, pc0] = tile._twin.partner.split(',').map(Number);
                if (pr0 !== qr0 || pc0 !== qc0) addQuad(pr0, pc0);
            }
        } else {
            tiles.push({ r: r, c: c });
            if (tile && tile._twin) {
                const parts = tile._twin.partner.split(',');
                tiles.push({ r: parseInt(parts[0], 10), c: parseInt(parts[1], 10) });
            }
        }
        dramaticPulseTiles = tiles;
        dramaticPulseStart = Date.now();
        ensureAnimating();
    }

    function scaleColor(hex, factor) {
        const c = parseColor(hex);
        const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
        return 'rgb(' + clamp(c[0] * factor) + ',' + clamp(c[1] * factor) + ',' + clamp(c[2] * factor) + ')';
    }
    function scalePaletteBrightness(p, factor) {
        return {
            face: scaleColor(p.face, factor),
            top:  scaleColor(p.top,  factor),
            left: scaleColor(p.left, factor),
            bot:  scaleColor(p.bot,  factor),
            right: scaleColor(p.right, factor)
        };
    }
    function blendPalette(p1, p2, t) {
        return {
            face: blendRGB(p1.face, p2.face, t),
            top:  blendRGB(p1.top,  p2.top,  t),
            left: blendRGB(p1.left, p2.left, t),
            bot:  blendRGB(p1.bot,  p2.bot,  t),
            right: blendRGB(p1.right, p2.right, t)
        };
    }

    // Resolve the palette to draw a tile's walls with, accounting for:
    //   • hint-locked tiles — full red palette + subtle breathing pulse
    //   • twin partners of a hint-locked tile — twin-colored face but red
    //     bevels (border), marking them as locked-by-association without
    //     the full red flood
    //   • normal twin tiles — per-pair pastel
    //   • plain tiles — default slate
    // Then layers an ephemeral dramatic-red blend on any tile listed in
    // the in-flight `dramaticPulseTiles`, decaying over DRAMATIC_PULSE_MS.
    function effectivePalette(tile, r, c) {
        const tileLocked  = Maze.isLocked(r, c);
        const isHinted    = tileLocked && tile._hinted;
        const isTwinOfHint = tileLocked && !tile._hinted && tile._twin;

        let palette;
        if (isHinted) {
            palette = HINT_PALETTE;
        } else if (isTwinOfHint) {
            // Twin-of-hint partner: the partner shows its twin face color
            // with gold bevels — signals "locked because of the hint twin"
            // (gold matches the hint's solved-state palette) without
            // flooding the whole partner gold.
            palette = Object.assign({}, HINT_PALETTE, { face: tile._twin.color });
        } else if (tile._twin) {
            // Plain twin pair: pastel face only — bevels stay default slate
            // so twins read as colored "stickers" on normal tiles instead of
            // entirely tinted blocks. Face renders at 110% of the regular
            // tile opacity (clamped to 1) so the twin color reads a little
            // more solidly than a plain tile — tracks the live TILE_FACE_ALPHA
            // so the Settings opacity slider still scales it. (faceAlpha is
            // read at line ~596 in the face draw, falling back to
            // TILE_FACE_ALPHA when unset.)
            palette = Object.assign({}, TILE_PALETTE, {
                face: tile._twin.color,
                faceAlpha: Math.min(1, TILE_FACE_ALPHA * 1.1)
            });
        } else {
            palette = TILE_PALETTE;
        }

        // Subtle hint pulse — slow brightness modulation.
        if (isHinted) {
            const phase  = (Date.now() / HINT_PULSE_PERIOD_MS) * 2 * Math.PI;
            const factor = 1 + HINT_PULSE_AMP * Math.sin(phase);
            palette = scalePaletteBrightness(palette, factor);
        }

        // Player-locked tiles use a palette derived from LOCK_FACE_COLOR
        // (face + standard top/left-lighter, bot/right-darker shading), so
        // the tile reads as visually frozen but still has the directional
        // bevel cue that says "this is a tile, not a flat block." paletteFromBase
        // clamps top/left at 255 — pure white face means only bot/right shade
        // visibly, which is still enough 3D for the lock signal. Applied
        // BEFORE the dramatic pulse so the pulse can blend over it.
        if (tile._playerLocked) {
            palette = paletteFromBase(LOCK_FACE_COLOR);
        }

        // Dramatic pulse — heavy red blend that decays. Both tiles in the
        // affected pair receive it, so the lock relationship reads at a glance.
        if (dramaticPulseStart) {
            const age = Date.now() - dramaticPulseStart;
            if (age < DRAMATIC_PULSE_MS && dramaticPulseTiles) {
                let isTarget = false;
                for (const t of dramaticPulseTiles) {
                    if (t.r === r && t.c === c) { isTarget = true; break; }
                }
                if (isTarget) {
                    const t      = age / DRAMATIC_PULSE_MS;          // 0..1
                    const decay  = 1 - t;                            // fade
                    const wave   = Math.abs(Math.sin(t * Math.PI * 3)); // 1.5 cycles → 3 peaks
                    const alpha  = decay * wave * DRAMATIC_PULSE_AMP;
                    palette      = blendPalette(palette, REJECT_PALETTE, alpha);
                    // Brightness boost on top of the red blend — needed so
                    // the hint primary (now HINT_PALETTE gold) still shows
                    // a visible pulse over the red rejection flash. For
                    // the partner tile this
                    // also intensifies the flash. Cap at +60% peak.
                    const brighten = 1 + decay * wave * 0.6;
                    palette = scalePaletteBrightness(palette, brighten);
                }
            }
        }

        return palette;
    }

    // ---- main draw ----

    // Lane shape helpers — used by per-tile rendering passes and by
    // drawAnimatedFrame's partial-redraw path. (Module-level so both the
    // full and partial draws can share them.)
    function laneIsOpposite(a, b)    { return ((a + 2) & 3) === b; }
    function laneIsVertical(a, b)    { return a === Maze.N || a === Maze.S; }

    // Build the (cell, portPair) → pathIdx lookup used by both Pass B
    // (skip lit lanes) and Pass C (dispatch lit lanes to per-path palette).
    // If two different paths claim the same lane (player has connected
    // colored paths together), the value becomes JOINED_PATH_IDX so the
    // lit pass flashes that lane dark red instead of picking one color.
    function setLit(litKeys, key, newPath) {
        const existing = litKeys.get(key);
        if (existing === undefined) litKeys.set(key, newPath);
        else if (existing !== JOINED_PATH_IDX && existing !== newPath) {
            litKeys.set(key, JOINED_PATH_IDX);
        }
    }
    function buildLitKeys() {
        const grid = Maze.grid;
        const litKeys = new Map();
        for (const h of Maze.highlighted) {
            const a = Math.min(h.inPort, h.outPort), b = Math.max(h.inPort, h.outPort);
            setLit(litKeys, h.row + ',' + h.col + ',' + a + ',' + b, h.path | 0);
        }
        // Hint-locked path tiles light up even before the live walk reaches
        // them, so the player sees the hint contributing to the chain.
        for (let r = 0; r < Maze.ROWS; r++) {
            for (let c = 0; c < Maze.COLS; c++) {
                if (!Maze.isLocked(r, c)) continue;
                const tile = grid[r][c];
                if (tile._solution === undefined) continue;
                if (tile._crossLanes) {
                    for (const [a, b] of Maze.getConnections(tile)) {
                        const lo = Math.min(a, b), hi = Math.max(a, b);
                        let p = 0;
                        for (const [la, lb, lp] of tile._crossLanes) {
                            const llo = Math.min(la, lb), lhi = Math.max(la, lb);
                            if (llo === lo && lhi === hi) { p = lp; break; }
                        }
                        setLit(litKeys, r + ',' + c + ',' + lo + ',' + hi, p);
                    }
                } else {
                    const tilePath = tile._path | 0;
                    for (const [a, b] of Maze.getConnections(tile)) {
                        const lo = Math.min(a, b), hi = Math.max(a, b);
                        setLit(litKeys, r + ',' + c + ',' + lo + ',' + hi, tilePath);
                    }
                }
            }
        }
        return litKeys;
    }

    // Per-tile rendering for one of the three passes. All write to whichever
    // canvas `ctx` currently points at (so Pass B can swap to offCtx).
    function renderTileDim(r, c, litKeys, w, rim) {
        const grid = Maze.grid;
        const tile = grid[r][c];
        const px = originX + c * cellSize;
        const py = originY + r * cellSize;
        withTileRotation(r, c, () => {
            const conns = Maze.getConnections(tile);
            for (const [a, b] of conns) {
                // Skip rim under any lit lane — including joined lanes (-2).
                if (litPathFor(litKeys, r, c, a, b) !== -1) continue;
                if (laneIsOpposite(a, b)) drawStraightRim(px, py, laneIsVertical(a, b), w, rim);
                else                       drawChannelRim(px, py, a, b, w, rim);
            }
        });
    }
    function renderTileLit(r, c, litKeys, w, rim) {
        const grid = Maze.grid;
        const tile = grid[r][c];
        const px = originX + c * cellSize;
        const py = originY + r * cellSize;
        withTileRotation(r, c, () => {
            const conns = Maze.getConnections(tile);
            for (const [a, b] of conns) {
                const pathIdx = litPathFor(litKeys, r, c, a, b);
                // Draw if lit by a path (0..3) or joined (-2); skip only the truly un-lit (-1).
                if (pathIdx === -1) continue;
                if (laneIsOpposite(a, b)) drawStraightLit(px, py, laneIsVertical(a, b), w, rim, pathIdx);
                else                       drawChannelLit(px, py, a, b, w, rim, pathIdx);
            }
        });
    }
    function renderTileWalls(r, c) {
        const grid = Maze.grid;
        const tile = grid[r][c];
        const px = originX + c * cellSize;
        const py = originY + r * cellSize;
        withTileRotation(r, c, () => {
            drawWalls(px, py, tile, effectivePalette(tile, r, c), r, c);
        });
    }

    // Trace every lit lane belonging to path `idx` (or ALL lit lanes when
    // idx is null) into ONE combined path. A single stroke of a multi-
    // subpath path paints the union region uniformly — no double-bright
    // spots where segments meet or overlap, which separate per-lane glow
    // strokes would produce under 'lighter' compositing.
    function traceLitGroup(litKeys, idx) {
        ctx.beginPath();
        const grid = Maze.grid;
        for (let r = 0; r < Maze.ROWS; r++) {
            for (let c = 0; c < Maze.COLS; c++) {
                const tile = grid[r][c];
                const px = originX + c * cellSize;
                const py = originY + r * cellSize;
                withTileRotation(r, c, () => {
                    for (const [a, b] of Maze.getConnections(tile)) {
                        const p = litPathFor(litKeys, r, c, a, b);
                        if (idx === null ? p === -1 : p !== idx) continue;
                        laneGeom(px, py, a, b);
                    }
                });
            }
        }
    }

    // Pass E: neon glow for the lit lanes AND (in terminal-pad mode) the
    // entry/exit stubs + rings. Runs AFTER the walls pass — the whole point
    // is tinting the bevels next to each lit lane. Rendered to the offscreen
    // first, for two reasons:
    //  - each path color's lanes + stub + ring trace as ONE union path, so
    //    a single stroke per glow layer can't stack additively where the
    //    shapes meet (separate strokes made the terminals glow 2-3× as
    //    bright as the paths, with a visible jump at the grid edge);
    //  - the crisp bands and the rings' interiors (band + dark hole) are
    //    erased (destination-out) before compositing, so the spill lands on
    //    the walls but never re-brightens the path's own lo→hi gradient
    //    (painted back in Pass C) or floods the terminal hole. Terminal
    //    stripes repaint AFTER this pass, so their square erase is safe.
    // The offscreen's Pass-B content is long since composited by this
    // point, so reusing it is safe (both drawCore and drawAnimatedFrame
    // repaint it from scratch each frame). In wrap mode the perimeter
    // polyline still glows inline in drawCircuitOutlinePair (one stroke per
    // pair — nothing to stack against).
    function drawGlowPass(litKeys, w, rim) {
        if (snippetMode) return;
        const outerW = w + rim * 2;
        const terms  = COMPLETE_CIRCUITS ? null : collectPairs();
        const present = new Set(litKeys.values());
        if (terms) for (const p of terms) present.add(p.pathIdx);
        if (present.size === 0) return;

        const mainCtx = ctx;
        ctx = offCtx;
        ctx.clearRect(0, 0, offCanvas.width, offCanvas.height);
        for (const idx of present) {
            traceLitGroup(litKeys, idx);   // beginPath + all lanes of idx
            if (terms) for (const p of terms) {
                if (p.pathIdx !== idx) continue;
                traceTerminalGeom(p.entry, w, rim, true);
                traceTerminalGeom(p.exit,  w, rim, true);
            }
            strokeGlowLayer(w, rim, idx);
        }
        // Erase where the crisp rendering lives, at EXACTLY the band width —
        // the erase's AA edge lands on the same pixels as the stripes' AA
        // edge, blending band into glow. (An earlier 2px-narrower "tuck"
        // left a 1px sliver of glow ON the band's dark outer stripe, which
        // read as a bright rim once the glow alphas went up.)
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        // Butt caps, matching the glow strokes: both the glow and its erase
        // stop flush at a dead-end lane's endpoint — the side glow ends in
        // a clean square cut, with no cap bulb and no erased void beyond
        // the open end.
        ctx.lineCap  = 'butt';
        ctx.lineJoin = 'round';
        ctx.lineWidth = outerW;
        traceLitGroup(litKeys, null);
        if (terms) for (const p of terms) {
            traceTerminalGeom(p.entry, w, rim, false);
            traceTerminalGeom(p.exit,  w, rim, false);
        }
        ctx.stroke();
        if (terms) for (const p of terms) {
            for (const ep of [p.entry, p.exit]) {
                const g = terminalGeom(ep, w, rim);
                // Erase in the ring's own silhouette — fill the centerline
                // rect (hole + inner half of the band) plus a round-joined
                // stroke of it at the band's exact width (outer half, with
                // corners rounded exactly like the crisp stripes'). A plain
                // sharp-cornered fillRect erased PAST the band's rounded
                // corners, gouging dark notches in the glow there.
                ctx.beginPath();
                ctx.rect(g.cx - g.ringHalf, g.cy - g.ringHalf, g.ringHalf * 2, g.ringHalf * 2);
                ctx.fill();
                ctx.lineWidth = g.ringHalfStroke * 2;
                ctx.stroke();
            }
        }
        ctx.restore();
        ctx = mainCtx;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(offCanvas, 0, 0);
        ctx.restore();
    }

    // Full-grid render. Used for any frame that isn't a pure rotation
    // animation (initial load, click landing, hint pulse, dramatic flash,
    // resize, etc.) and for the first frame after a rotation kicks off
    // (so subsequent partial-redraw frames have a correct neighborhood).
    function drawCore() {
        if (!ctx) return;

        // Canvas stays transparent — body bg-image shows through the padding
        // around the grid and (at DIM_ALPHA) through the un-lit grooves.
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const grid = Maze.grid;
        if (!grid) return;
        // Maze.setDimensions updates ROWS/COLS immediately, but the new grid
        // doesn't materialize until newPuzzle's await completes. If a draw
        // fires in that window — e.g. another debug-panel toggle calls
        // Render.refit while a build is awaiting the worker — iterating to
        // Maze.ROWS would walk off the end of the still-old grid. Skip the
        // frame; the next draw after loadSnapshot will paint the new grid.
        if (grid.length !== Maze.ROWS || grid[0].length !== Maze.COLS) return;

        const litKeys = buildLitKeys();

        // Draw each tile in three channel-passes so cross intersections are clean.
        // Snippet mode lets the title-O override path width/alpha without
        // affecting in-game tiles.
        const widthFrac = (snippetMode && snippetWidthFrac != null) ? snippetWidthFrac : GROOVE_FRAC;
        const w   = Math.max(4, Math.floor(cellSize * widthFrac));
        const rim = Math.max(1, Math.floor(cellSize * GROOVE_RIM_FRAC));
        const dimAlpha = (snippetMode && snippetAlpha != null) ? snippetAlpha : DIM_ALPHA;

        ctx.save();
        ctx.lineCap  = 'butt';
        ctx.lineJoin = 'miter'; // unused by elbow arcs and straight fills; drawCircuitOutline overrides to 'round' for the perimeter polyline

        // Pass B: un-lit channel band, rendered to the offscreen canvas at
        // full opacity, then composited onto main at dimAlpha.
        ensureOffscreen();
        offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
        offCtx.lineCap  = 'butt';
        offCtx.lineJoin = 'miter';

        const mainCtx = ctx;
        ctx = offCtx;
        for (let r = 0; r < Maze.ROWS; r++) {
            for (let c = 0; c < Maze.COLS; c++) renderTileDim(r, c, litKeys, w, rim);
        }
        ctx = mainCtx;

        ctx.globalAlpha = dimAlpha;
        ctx.drawImage(offCanvas, 0, 0);
        ctx.globalAlpha = 1;

        // Pass C: lit channels at full opacity.
        for (let r = 0; r < Maze.ROWS; r++) {
            for (let c = 0; c < Maze.COLS; c++) renderTileLit(r, c, litKeys, w, rim);
        }

        // Pass D: broken-chain fade. Drawn after Pass C so the fading lanes
        // overlay the now-dim renderings of those cells. Two phases per
        // entry: a brief FLASH (full alpha + decaying additive overlay,
        // makes the lane pop bright at the moment the SFX hits), then the
        // standard alpha ramp from 1 to 0.
        if (fadingLanes.length > 0) {
            const now  = Date.now();
            const keep = [];
            for (const e of fadingLanes) {
                const elapsed = now - e.startTime;
                if (elapsed >= FADE_LIFE_MS) continue;
                const px = originX + e.c * cellSize;
                const py = originY + e.r * cellSize;
                const drawLane = () => {
                    withTileRotation(e.r, e.c, () => {
                        if (laneIsOpposite(e.a, e.b)) {
                            drawStraightLit(px, py, laneIsVertical(e.a, e.b), w, rim, e.pathIdx);
                        } else {
                            drawChannelLit(px, py, e.a, e.b, w, rim, e.pathIdx);
                        }
                    });
                };
                // Base lit lane at the phase-appropriate alpha.
                let baseAlpha;
                if (elapsed < FLASH_BEFORE_FADE_MS) {
                    baseAlpha = 1;
                } else {
                    baseAlpha = 1 - (elapsed - FLASH_BEFORE_FADE_MS) / BROKEN_FADE_MS;
                }
                ctx.globalAlpha = baseAlpha;
                drawLane();
                // Flash overlay during the early window — additive composite
                // on top of the base draw amplifies the lit colors toward
                // white. Strength decays linearly across the flash window
                // so the brightening tapers into the standard fade.
                if (elapsed < FLASH_BEFORE_FADE_MS) {
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.globalAlpha = (1 - elapsed / FLASH_BEFORE_FADE_MS) * 0.7;
                    drawLane();
                    ctx.restore();
                }
                ctx.globalAlpha = 1;
                keep.push(e);
            }
            fadingLanes.length = 0;
            for (const e of keep) fadingLanes.push(e);
        }

        // Pass A: tile walls at full opacity. Drawn AFTER both channel passes
        // so the wall fills cover any AA overshoot from the curved arc strokes.
        for (let r = 0; r < Maze.ROWS; r++) {
            for (let c = 0; c < Maze.COLS; c++) renderTileWalls(r, c);
        }

        // Pass E: lit lanes cast their glow onto the freshly-drawn walls.
        drawGlowPass(litKeys, w, rim);

        // Full external loop (entry notch + perimeter connector + exit notch)
        // drawn as one polyline so every corner is a smooth round bend.
        // Skipped in snippet mode (the title's maze-O has no entry/exit
        // semantics; the synthetic snapshot's dummy entry/exit would render
        // weird stub lines around the snippet).
        if (!snippetMode) drawCircuitOutline(w, rim);

        // Gates sit on top of everything — they're physical objects laid
        // over the tile grid, not part of any tile's own rendering.
        if (!snippetMode) drawGates();

        ctx.restore();
    }

    // Draw all gates from the Gates module's current state. Each gate is a
    // single merged silhouette polygon (square base + shaft + tip) so the
    // bevel runs continuously around the entire shape — no visible seam
    // where the prong meets the base, which earlier separate-polygon
    // rendering produced. withGateRotation wraps each gate's draw so an
    // in-flight rotation animation smoothly interpolates from the old
    // orientation to the new.
    //
    // Opaque face-color underlay before the beveled rendering: without it,
    // the canvas anti-aliasing at the bevel's OUTER edge blends bevel-color
    // with whatever sits on the canvas just outside the gate (a dark tile
    // or channel), producing a translucent-looking halo along the gate
    // silhouette. Pre-filling the outline at face color means the bevel-edge
    // AA blends bevel-with-face — a smooth red-on-red transition that reads
    // as fully opaque.
    function drawGates() {
        if (typeof Gates === 'undefined') return;
        const list = Gates.list;
        if (!list || list.length === 0) return;
        const cs = cellSize;
        const gateBevel = Math.max(1, Math.round(cs * 0.04));
        function fillOuter(pts) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.closePath();
            ctx.fill();
        }
        for (const gate of list) {
            const cx = originX + gate.vc * cs;
            const cy = originY + gate.vr * cs;
            const polys = Gates.polygonsFor(gate, cs, cx, cy);
            withGateRotation(gate, function () {
                ctx.globalAlpha = 1;
                ctx.fillStyle = polys.palette.face;
                fillOuter(polys.outline);
                drawBeveledPolygon(polys.outline, polys.palette, null, null, gateBevel);
            });
        }
    }

    // Snippet mode: render the current Maze state into a separate target
    // canvas at a fixed displayed size. Used by the menu's maze-O title.
    // Caller swaps Maze state via Maze.snapshotState/loadSnapshot before
    // calling — this just paints whatever Maze currently holds into the
    // given target without touching the main game canvas.
    //
    // Optional opts (absolute overrides — use the in-game default when not set):
    //   { widthFrac, alpha, color } — path width as fraction of cellSize,
    //   un-lit channel composite alpha, and channel rim color.
    let snippetMode = false;
    let snippetWidthFrac = null;
    let snippetAlpha     = null;
    let snippetColor     = null;
    let snippetLitColor  = null;
    let snippetLitHi     = null;
    let snippetLitLo     = null;
    let snippetLitPulse  = false;
    // Ramp-shape overrides (see litStripes) — null = use the LIT_* constants.
    let snippetCoreStart = null;
    let snippetCoreFull  = null;
    let snippetCoreHot   = null;
    let snippetEdgeLift  = null;
    function effectiveGrooveRim() {
        return (snippetMode && snippetColor) ? snippetColor : GROOVE_RIM;
    }
    function renderSnippet(targetCanvas, sizeCss, opts) {
        const sCanvas    = canvas;
        const sCtx       = ctx;
        const sCellSize  = cellSize;
        const sOriginX   = originX;
        const sOriginY   = originY;
        const sOffCanvas = offCanvas;
        const sOffCtx    = offCtx;
        const sDpr       = dpr;

        const dprLocal = window.devicePixelRatio || 1;
        targetCanvas.width  = Math.round(sizeCss * dprLocal);
        targetCanvas.height = Math.round(sizeCss * dprLocal);
        // Deliberately NOT setting targetCanvas.style.width / .height here.
        // The title-O canvas has CSS `width:100%; height:100%` so its display
        // size tracks its parent (.titleMazeO at 1.14em). Setting an inline
        // px width would override that and pin the canvas at whatever size
        // was measured on the first paint — if the title was briefly small
        // (font still loading, viewport mid-resize), the canvas would stay
        // small forever. Drawing buffer alone is enough; CSS handles display.

        canvas = targetCanvas;
        ctx    = canvas.getContext('2d');
        ctx.setTransform(dprLocal, 0, 0, dprLocal, 0, 0);
        dpr    = dprLocal;

        // Lay out the grid centered in the canvas, sized to fit. Use the
        // larger dim so non-square grids still fit without overflowing.
        const dim = Math.max(Maze.ROWS, Maze.COLS);
        cellSize = sizeCss / dim;
        originX  = (sizeCss - cellSize * Maze.COLS) / 2;
        originY  = (sizeCss - cellSize * Maze.ROWS) / 2;

        // Reset offscreen so ensureOffscreen() resizes for the new canvas.
        offCanvas = null;
        offCtx    = null;

        snippetMode      = true;
        snippetWidthFrac = (opts && opts.widthFrac) || null;
        snippetAlpha     = (opts && opts.alpha != null) ? opts.alpha : null;
        snippetColor     = (opts && opts.color) || null;
        snippetLitColor  = (opts && opts.litColor) || null;
        snippetLitHi     = (opts && opts.litHi) || null;
        snippetLitLo     = (opts && opts.litLo) || null;
        snippetLitPulse  = !!(opts && opts.litPulse);
        snippetCoreStart = (opts && opts.coreStart != null) ? opts.coreStart : null;
        snippetCoreFull  = (opts && opts.coreFull  != null) ? opts.coreFull  : null;
        snippetCoreHot   = (opts && opts.coreHot   != null) ? opts.coreHot   : null;
        snippetEdgeLift  = (opts && opts.edgeLift  != null) ? opts.edgeLift  : null;
        try {
            drawCore();
        } finally {
            snippetMode      = false;
            snippetWidthFrac = null;
            snippetAlpha     = null;
            snippetColor     = null;
            snippetLitColor  = null;
            snippetLitHi     = null;
            snippetLitLo     = null;
            snippetLitPulse  = false;
            snippetCoreStart = null;
            snippetCoreFull  = null;
            snippetCoreHot   = null;
            snippetEdgeLift  = null;
        }

        canvas    = sCanvas;
        ctx       = sCtx;
        cellSize  = sCellSize;
        originX   = sOriginX;
        originY   = sOriginY;
        offCanvas = sOffCanvas;
        offCtx    = sOffCtx;
        dpr       = sDpr;
    }

    // ---- How-to-Solve tutorial render mode --------------------------------
    // A PERSISTENT variant of renderSnippet: retarget the module's canvas +
    // sizing to a small tutorial canvas and render NORMALLY (lit green path,
    // gold completion, twin colors, gates, player locks). Unlike renderSnippet
    // (one-shot, snippetMode visual overrides for the title-O), this stays in
    // effect until endTutorial() restores the real game canvas — so the live
    // animation loop, animateRotationAt() and animateGateRotation() all paint
    // into the tutorial canvas with the exact same visuals as real play.
    let tutorialMode = false;
    let tutPadFrac   = 0.55;
    const tutSaved   = {};
    function beginTutorial(targetCanvas, padFrac) {
        if (tutorialMode || !targetCanvas) return;
        tutSaved.canvas    = canvas;
        tutSaved.ctx       = ctx;
        tutSaved.cellSize  = cellSize;
        tutSaved.originX   = originX;
        tutSaved.originY   = originY;
        tutSaved.offCanvas = offCanvas;
        tutSaved.offCtx    = offCtx;
        tutSaved.dpr       = dpr;

        canvas    = targetCanvas;
        ctx       = canvas.getContext('2d');
        // Force a fresh offscreen sized to the tutorial canvas.
        offCanvas = null;
        offCtx    = null;
        // Terminal-pad mode needs the full pad for the stub + square rings
        // (drawTerminal clamps to the available pad, so a tighter value
        // would compress the pads rather than clip — but give them room).
        tutPadFrac   = (padFrac != null) ? padFrac
                     : (COMPLETE_CIRCUITS ? 0.55 : TERMINAL_PAD_FRAC);
        tutorialMode = true;
        layoutTutorial();
    }
    function layoutTutorial() {
        // Fit Maze.ROWS×COLS into the tutorial canvas's CSS display box, all
        // in device pixels with an identity transform — mirrors resize() so
        // cellAt()/animateRotationAt()/drawCore() math is identical.
        dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const cssW = rect.width  || canvas.clientWidth  || 320;
        const cssH = rect.height || canvas.clientHeight || 320;
        const availW = cssW * dpr;
        const availH = cssH * dpr;
        const PAD = tutPadFrac;
        const cellByW = availW / (Maze.COLS + 2 * PAD);
        const cellByH = availH / (Maze.ROWS + 2 * PAD);
        cellSize = Math.floor(Math.min(cellByW, cellByH));
        if (cellSize % 2 !== 0) cellSize -= 1;
        if (cellSize < 2) cellSize = 2;
        canvas.width  = Math.round(availW);
        canvas.height = Math.round(availH);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const gridW = cellSize * Maze.COLS;
        const gridH = cellSize * Maze.ROWS;
        originX = Math.round((canvas.width  - gridW) / 2);
        originY = Math.round((canvas.height - gridH) / 2);
        draw();
    }
    function endTutorial() {
        if (!tutorialMode) return;
        tutorialMode = false;
        canvas    = tutSaved.canvas;
        ctx       = tutSaved.ctx;
        cellSize  = tutSaved.cellSize;
        originX   = tutSaved.originX;
        originY   = tutSaved.originY;
        offCanvas = tutSaved.offCanvas;
        offCtx    = tutSaved.offCtx;
        dpr       = tutSaved.dpr;
        resize();   // repaint the real game canvas at viewport size
    }
    // Grid metrics for the tutorial overlay's DOM cursor — lets tutorial.js
    // map a cell (r,c) or vertex (vr,vc) to a CSS-pixel point inside the
    // canvas's display box. All values are device pixels except the implied
    // /dpr the caller applies. Only meaningful while tutorialMode.
    function tutorialMetrics() {
        return { originX, originY, cellSize, dpr };
    }

    // After renderSnippet, paint a SINGLE continuous lit-stripe circle on
    // top of the target canvas. The per-tile snippet render produces
    // visible boundary seams between adjacent elbow tiles' arc-strokes at
    // each shared port (sub-pixel AA on butt caps lets the dim pass bleed
    // through as a thin dark line where two arcs meet). The title-O case
    // is special — all 4 elbows share the same arc center (the 2×2 group
    // center) and radius, so the channel is geometrically a perfect
    // circle. Drawing that circle as ONE stroke per stripe overlays the
    // per-tile rendering with a seamless version and masks the seams.
    // Uses litStripes' actual widths + colors (temporarily entering
    // snippet mode so the litColor/Hi/Lo/Pulse overrides are picked up by
    // litPalette) so the overlay matches the per-tile render exactly.
    // Hardcoded 2×2 geometry — only the title-O calls this; if more
    // snippet shapes need masking later, generalize the geometry.
    function paintSnippetRingMask(targetCanvas, sizeCss, opts) {
        if (!targetCanvas || sizeCss <= 0) return;
        const dprLocal = window.devicePixelRatio || 1;
        const tctx     = targetCanvas.getContext('2d');
        const cs       = sizeCss / 2;
        const widthFrac = (opts && opts.widthFrac != null) ? opts.widthFrac : GROOVE_FRAC;
        const w        = Math.max(4, Math.floor(cs * widthFrac));
        const rim      = Math.max(1, Math.floor(cs * GROOVE_RIM_FRAC));
        const cx       = sizeCss / 2;
        const cy       = sizeCss / 2;
        const radius   = cs / 2;
        // Temporarily enter snippet mode so litPalette (called by
        // litStripes) picks up the lit overrides + pulse exactly as
        // renderSnippet did, keeping the overlay's gradient in lockstep
        // with the underlying per-tile render.
        const prev = {
            sm:  snippetMode,
            lc:  snippetLitColor,
            lh:  snippetLitHi,
            ll:  snippetLitLo,
            lp:  snippetLitPulse,
            cs:  snippetCoreStart,
            cf:  snippetCoreFull,
            ch:  snippetCoreHot,
            el:  snippetEdgeLift,
        };
        snippetMode      = true;
        snippetLitColor  = (opts && opts.litColor) || null;
        snippetLitHi     = (opts && opts.litHi)    || null;
        snippetLitLo     = (opts && opts.litLo)    || null;
        snippetLitPulse  = !!(opts && opts.litPulse);
        snippetCoreStart = (opts && opts.coreStart != null) ? opts.coreStart : null;
        snippetCoreFull  = (opts && opts.coreFull  != null) ? opts.coreFull  : null;
        snippetCoreHot   = (opts && opts.coreHot   != null) ? opts.coreHot   : null;
        snippetEdgeLift  = (opts && opts.edgeLift  != null) ? opts.edgeLift  : null;
        let stripes;
        try {
            stripes = litStripes(w, rim, 0);
        } finally {
            snippetMode      = prev.sm;
            snippetLitColor  = prev.lc;
            snippetLitHi     = prev.lh;
            snippetLitLo     = prev.ll;
            snippetLitPulse  = prev.lp;
            snippetCoreStart = prev.cs;
            snippetCoreFull  = prev.cf;
            snippetCoreHot   = prev.ch;
            snippetEdgeLift  = prev.el;
        }
        tctx.save();
        tctx.setTransform(dprLocal, 0, 0, dprLocal, 0, 0);
        tctx.lineCap = 'butt';
        for (const s of stripes) {
            tctx.strokeStyle = s.color;
            tctx.lineWidth   = s.width;
            tctx.beginPath();
            tctx.arc(cx, cy, radius, 0, 2 * Math.PI);
            tctx.stroke();
        }
        tctx.restore();
    }

    // Partial-redraw used during a pure rotation animation: only the
    // animating tiles + their 8 neighbors are re-rendered. On a 15×15 grid
    // with one tile spinning, that's 9 tiles instead of 225.
    //
    // Clip is the UNION of dirty CELL rects (not their bounding box) — for
    // twin-pair rotations where the two tiles are far apart, a bbox-clip
    // would clear the entire gap between them, leaving the body bg visible
    // through the canvas. Per-cell clipping keeps non-dirty cells intact.
    //
    // Outside the dirty region we rely on the canvas content from the
    // previous full draw (drawCore) being correct. That's why the FIRST
    // frame after a rotation kick-off must be a drawCore — see needsFullDraw
    // logic in draw().
    function drawAnimatedFrame() {
        if (!ctx) return;
        const grid = Maze.grid;
        if (!grid) return;
        if (grid.length !== Maze.ROWS || grid[0].length !== Maze.COLS) return;

        // Dirty cells: animating tiles + 8 neighbors. A 45°-rotated tile's
        // corners poke ~0.207*cellSize into neighbor cells; redrawing the
        // neighbors covers that overshoot.
        //
        // Build neighbor and rotating sets separately so iteration order
        // can put rotating tiles LAST — without that ordering, neighbors
        // are drawn after the rotating tile and visually overwrite its
        // poke-corners, making the rotating tile look like it's BEHIND
        // its neighbors during the spin.
        const rotatingKeys = new Set();
        const neighborKeys = new Set();
        for (const anim of rotationAnims) {
            for (const key of anim.keys) rotatingKeys.add(key);
        }
        for (const anim of rotationAnims) {
            for (const key of anim.keys) {
                const [r, c] = key.split(',').map(Number);
                for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                    const nr = r + dr, nc = c + dc;
                    if (nr >= 0 && nr < Maze.ROWS && nc >= 0 && nc < Maze.COLS) {
                        const k = nr + ',' + nc;
                        if (!rotatingKeys.has(k)) neighborKeys.add(k);
                    }
                }
            }
        }
        const dirty = new Set([...neighborKeys, ...rotatingKeys]); // neighbors first → rotating last
        if (dirty.size === 0) return;

        const litKeys = buildLitKeys();
        const w   = Math.max(4, Math.floor(cellSize * GROOVE_FRAC));
        const rim = Math.max(1, Math.floor(cellSize * GROOVE_RIM_FRAC));

        // Clip path = union of dirty cell rects PLUS a margin around each
        // rotating tile. A 45° rotation extends the cell's corners
        // ~0.207*cellSize past every cell edge; for INTERIOR tiles the 8
        // neighbors absorb that overshoot, but for tiles on the GRID EDGE
        // the overshoot lands in the canvas padding — and without the
        // margin in the clip, it gets cropped at the grid boundary.
        // Perimeter pixels inside the margin briefly disappear during
        // the animation; the post-animation drawCore restores them.
        const rotationMargin = Math.ceil(cellSize * 0.22);
        ctx.save();
        ctx.beginPath();
        for (const key of dirty) {
            const [r, c] = key.split(',').map(Number);
            const px = originX + c * cellSize, py = originY + r * cellSize;
            ctx.rect(px, py, cellSize, cellSize);
        }
        for (const key of rotatingKeys) {
            const [r, c] = key.split(',').map(Number);
            const px = originX + c * cellSize, py = originY + r * cellSize;
            ctx.rect(px - rotationMargin, py - rotationMargin,
                     cellSize + 2 * rotationMargin, cellSize + 2 * rotationMargin);
        }
        ctx.clip();
        ctx.clearRect(0, 0, canvas.width, canvas.height); // clipped to dirty + margin
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';

        // Pass B: dim channels for dirty tiles only → offscreen → composite.
        ensureOffscreen();
        // Clear matching regions on offscreen (dirty cells + rotation
        // margin) so stale dim pixels don't ghost through the drawImage
        // composite below.
        for (const key of rotatingKeys) {
            const [r, c] = key.split(',').map(Number);
            const px = originX + c * cellSize, py = originY + r * cellSize;
            offCtx.clearRect(px - rotationMargin, py - rotationMargin,
                             cellSize + 2 * rotationMargin, cellSize + 2 * rotationMargin);
        }
        for (const key of dirty) {
            const [r, c] = key.split(',').map(Number);
            const px = originX + c * cellSize, py = originY + r * cellSize;
            offCtx.clearRect(px, py, cellSize, cellSize);
        }
        offCtx.lineCap = 'butt';
        offCtx.lineJoin = 'miter';
        const mainCtx = ctx;
        ctx = offCtx;
        for (const key of dirty) {
            const [r, c] = key.split(',').map(Number);
            renderTileDim(r, c, litKeys, w, rim);
        }
        ctx = mainCtx;

        ctx.globalAlpha = DIM_ALPHA;
        ctx.drawImage(offCanvas, 0, 0); // clip restricts which pixels actually write
        ctx.globalAlpha = 1;

        // Pass C: lit channels for dirty tiles.
        for (const key of dirty) {
            const [r, c] = key.split(',').map(Number);
            renderTileLit(r, c, litKeys, w, rim);
        }

        // Pass A: walls for dirty tiles.
        for (const key of dirty) {
            const [r, c] = key.split(',').map(Number);
            renderTileWalls(r, c);
        }

        // Pass E: glow. Traced grid-wide (cheap — geometry only), so glow
        // spilling into the dirty region from lanes OUTSIDE it is repainted
        // too; the clip restricts the actual pixel writes. NOTE: this
        // clears the offscreen wholesale, which is safe — Pass B above only
        // relies on offscreen pixels inside regions it just redrew.
        drawGlowPass(litKeys, w, rim);

        // The rotation margin (added so edge-tile rotations aren't cropped
        // at the grid boundary) extends a few px into the canvas padding.
        // The portion of any entry/exit notch that lives within that
        // margin gets wiped by the clearRect above. Redraw the perimeter
        // so those pixels come back. The clip restricts the strokes to
        // the dirty+margin region — most of the perimeter is a no-op pass.
        if (!snippetMode) drawCircuitOutline(w, rim);

        // Gates overlap the 4 tiles around their vertex, so any dirty tile
        // adjacent to a gate gets the gate's pixels cleared by the clip's
        // clearRect. Repaint gates within the same clip so they survive.
        drawGates();

        ctx.restore();
    }

    // First frame after a rotation kick-off must be a full drawCore (so the
    // canvas reflects the post-rotate Maze state outside the dirty region).
    // Set in animateRotationAt, cleared after the first drawCore consumes it.
    let needsFullDraw = false;

    function draw() {
        if (!ctx) return;

        // Pulse and hint animations vary palettes globally each frame, so
        // they need a full re-render. Pure rotation animations don't.
        const dramaticActive = !!(dramaticPulseStart
            && (Date.now() - dramaticPulseStart) < DRAMATIC_PULSE_MS);
        let hintActive = false;
        const grid = Maze.grid;
        if (grid) {
            for (let r = 0; r < Maze.ROWS && !hintActive; r++) {
                for (let c = 0; c < Maze.COLS && !hintActive; c++) {
                    if (grid[r][c]._hinted) hintActive = true;
                }
            }
        }

        const joinedActive = hasJoinedLanes();
        const fadingActive = fadingLanes.length > 0;
        // Gold-glow pulse modulates the glow brightness globally each frame
        // — a partial redraw would leave stale-brightness glow outside the
        // dirty clip, so it forces full draws like the other pulses.
        const goldActive = anyPathWon();
        // Gates aren't tile-keyed so the partial-redraw clip doesn't include
        // them — force a full draw whenever a gate is mid-rotation so the
        // animation actually paints.
        const canPartial = rotationAnims.length > 0
            && gateAnims.length === 0
            && !dramaticActive && !hintActive && !joinedActive && !goldActive
            && !fadingActive && !needsFullDraw;

        if (canPartial) {
            drawAnimatedFrame();
        } else {
            drawCore();
            needsFullDraw = false;
        }

        // Drop finished rotation animations so shouldKeepAnimating reports
        // accurately and tileRotationTransform stops paying their cost.
        pruneFinishedRotations();
        pruneFinishedGateAnims();
        if (shouldKeepAnimating()) ensureAnimating();
    }

    // Returns the path index (0 or 1) of the lit lane at (r, c, p1, p2),
    // or -1 if the lane isn't lit. Used by both passes B (un-lit, skip
    // lit lanes) and C (lit, dispatch to per-path palette).
    function litPathFor(map, r, c, p1, p2) {
        const a = Math.min(p1, p2), b = Math.max(p1, p2);
        const v = map.get(r + ',' + c + ',' + a + ',' + b);
        return v === undefined ? -1 : v;
    }

    return { init, draw, cellAt, gateAt, animateGateRotation,
             setTileColor, setPathColor, setPathOpacity,
             setPathWidth, setBevelThickness, setTileFaceAlpha, setFaceTexture,
             setLitGreenBase, setLitGreenLo, setLitGreenHi,
             setLitBlueBase, setLitBlueLo, setLitBlueHi,
             setLitPinkBase, setLitPinkLo, setLitPinkHi,
             setLitOrangeBase, setLitOrangeLo, setLitOrangeHi,
             setLitGoldBase, setLitGoldLo, setLitGoldHi,
             setLockFaceColor, setCompleteCircuits, setGridSize,
             flashTwinPair, renderSnippet, paintSnippetRingMask,
             beginTutorial, endTutorial, tutorialMetrics,
             setAnimateRotations, animateRotationAt,
             hasJoinedLanes,    // game.js polls this for the overlap-SFX state machine
             fadeLanes, clearFadingLanes,  // broken-chain fade triggered alongside the twin-break SFX
             shuffleBackground,  // marathon.js calls on each new puzzle to draw a fresh body bg from the 54-image bag
             setBackgroundEnabled,  // settings.js calls to toggle bg images off (body goes pure black)
             refit: resize };  // public hook to recompute canvas dims after Maze.ROWS/COLS change
})();
