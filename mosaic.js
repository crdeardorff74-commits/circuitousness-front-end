/**
 * mosaic.js — rotation-invariant piece shapes + board packing for MOSAIC mode.
 *
 * Mosaic is the general case of Quad. Where quad mode groups every 2×2 block
 * of sub-tiles into one rotating unit, mosaic mode tiles the board with pieces
 * of MANY different shapes — plus signs, rings, solid squares, pinwheels —
 * each of which still occupies exactly the same cells after a 90° turn.
 *
 * THE INVARIANCE RULE (why the shape library looks the way it does)
 * ─────────────────────────────────────────────────────────────────
 * A piece may only be used if rotating it 90° about its own centre maps its
 * footprint onto itself. That is a hard geometric constraint, not a style
 * choice: the board is a fixed grid, so a piece whose outline changed under
 * rotation would either overlap its neighbours or leave a hole.
 *
 * The consequence is that legal piece SIZES are not arbitrary. Every cell
 * other than a dead-centre cell belongs to an orbit of exactly 4 under the
 * quarter turn, and the centre cell only exists when the bounding box is odd.
 * So a piece has 4k cells (even box) or 4k+1 cells (odd box) — i.e. sizes
 *
 *     1, 4, 5, 8, 9, 12, 13, 16, …
 *
 * and NEVER 2, 3, 6, 7, 10, 11, … . SIZES below is that sequence truncated at
 * 16; size 1 is excluded here because single cells are the singular-fill
 * remainder (see pack()), not library pieces.
 *
 * Shapes are ENUMERATED, not hand-listed. For each square frame n×n we walk
 * the orbits of the quarter-turn map and take every subset of them; each
 * subset is invariant by construction. The subsets are then filtered to those
 * that are a legal size, edge-connected (a piece is one solid thing — the
 * diagonal X of 5 cells is out), and whose bounding box fills the frame
 * exactly (otherwise it is a duplicate of a shape a smaller frame already
 * produced). MAX_FRAME caps how big a piece can get.
 *
 * Holes are deliberately KEPT. A 3×3 ring's empty middle is not a defect —
 * the packer leaves it free, so another piece or a singular fill tile lands
 * inside it. That nesting is what produces the concentric look of the
 * original design sketches.
 *
 * This module is pure geometry: it knows about cells and shapes, and nothing
 * about mazes, tiles, ports or rendering. maze.js owns everything that turns
 * a packing into a puzzle. Kept separate so the packing can be unit-tested
 * headlessly (see ../tests/) and so the worker can import it standalone.
 */

const Mosaic = (function () {

    // Legal piece sizes (see the header — 4k and 4k+1 only). Size 1 is
    // intentionally absent: the leftovers after packing become singular
    // one-cell groups, which pack() adds itself.
    const SIZES = [4, 5, 8, 9, 12, 13, 16];

    // Largest bounding box a piece may occupy. 5 gives the full set the
    // design sketches show — 2×2 solid, 3×3 plus/ring/solid, 4×4 ring and
    // pinwheels, 5×5 ring and crosses — while keeping pieces small enough
    // to fit on the smallest boards the generator rolls (4 sub-tiles/axis).
    // Raising it costs 2^(n²/4) subsets to enumerate, so it is not free.
    const MAX_FRAME = 5;

    const N_ = 0, E_ = 1, S_ = 2, W_ = 3;   // unused here; kept for symmetry

    // ── Shape enumeration ────────────────────────────────────────────────

    // Quarter turn CW inside an n×n frame: (r, c) → (c, n-1-r).
    function cw(r, c, n) { return [c, n - 1 - r]; }

    // Partition an n×n frame into orbits of the quarter turn. Orbits have 4
    // members, except the centre of an odd frame, which is a fixed point and
    // forms an orbit of 1. Any union of orbits is rotation-invariant, which
    // is what makes the subset enumeration below correct by construction.
    function orbitsOf(n) {
        const owner = new Array(n * n).fill(-1);
        const orbits = [];
        for (let r = 0; r < n; r++) {
            for (let c = 0; c < n; c++) {
                if (owner[r * n + c] !== -1) continue;
                const orbit = [];
                let rr = r, cc = c;
                do {
                    orbit.push([rr, cc]);
                    owner[rr * n + cc] = orbits.length;
                    const nxt = cw(rr, cc, n);
                    rr = nxt[0]; cc = nxt[1];
                } while (!(rr === r && cc === c));
                orbits.push(orbit);
            }
        }
        return orbits;
    }

    // Edge-connectivity (4-neighbour). Diagonal touching does NOT count — a
    // piece has to be one physically joined object, so the 5-cell diagonal X
    // and the 4-corner set are rejected here even though both are perfectly
    // rotation-invariant.
    function isConnected(cells) {
        if (cells.length === 0) return false;
        const inSet = new Set(cells.map(([r, c]) => r + ',' + c));
        const seen = new Set([cells[0][0] + ',' + cells[0][1]]);
        const stack = [cells[0]];
        while (stack.length) {
            const [r, c] = stack.pop();
            const nbrs = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
            for (const [nr, nc] of nbrs) {
                const k = nr + ',' + nc;
                if (!inSet.has(k) || seen.has(k)) continue;
                seen.add(k);
                stack.push([nr, nc]);
            }
        }
        return seen.size === cells.length;
    }

    // Hand-vetoed shapes. The enumeration is value-blind — any legal-size,
    // connected, frame-filling orbit union gets in — and one of them is a
    // hollow hooked cross whose clockwise form reads as a swastika
    // (removed 2026-08-15, user call): a symbol the game must never put
    // on a board or in the editor palette. Vetoed by canonical key so a
    // change to enumeration or sort order can never resurrect it.
    // Everything downstream refuses it for free: findShape is built from
    // SHAPES so the mask no longer resolves, validate() therefore rejects
    // stored layouts that used it, and packFromLayout skips the piece so
    // its cells degrade to singular fill (../tests/mosaic-library-test.js
    // pins the refusal alongside the other negatives).
    const VETOED_KEYS = new Set([
        '5:011112131421233031323343',   // 5×5 hollow hooked cross, clockwise (size 12)
    ]);

    // Build the full library once at module load. Cost is trivial (the
    // largest frame is 5×5 → 7 orbits → 127 subsets) so there is no reason
    // to precompute it into a literal, and an enumerated library can never
    // drift out of sync with the invariance rule the way a hand-typed one
    // would.
    function buildLibrary() {
        const out = [];
        for (let n = 2; n <= MAX_FRAME; n++) {
            const orbits = orbitsOf(n);
            const k = orbits.length;
            for (let mask = 1; mask < (1 << k); mask++) {
                const cells = [];
                for (let i = 0; i < k; i++) {
                    if (mask & (1 << i)) for (const cell of orbits[i]) cells.push(cell);
                }
                if (SIZES.indexOf(cells.length) === -1) continue;
                // Bounding box must fill the frame, or a smaller frame
                // already enumerated this exact shape.
                let minR = n, maxR = -1, minC = n, maxC = -1;
                for (const [r, c] of cells) {
                    if (r < minR) minR = r;
                    if (r > maxR) maxR = r;
                    if (c < minC) minC = c;
                    if (c > maxC) maxC = c;
                }
                if (minR !== 0 || minC !== 0 || maxR !== n - 1 || maxC !== n - 1) continue;
                if (!isConnected(cells)) continue;
                cells.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
                const key = n + ':' + cells.map(([r, c]) => r + '' + c).join('');
                if (VETOED_KEYS.has(key)) continue;
                out.push({
                    n: n,
                    size: cells.length,
                    cells: cells,
                    key: key
                });
            }
        }
        // Biggest first. The packer walks this order in its exhaustive pass,
        // so large pieces get first refusal on the space that is left —
        // without it a board fills up with 2×2s and the interesting shapes
        // never appear.
        out.sort((a, b) => (b.size - a.size) || (b.n - a.n));
        return out;
    }

    const SHAPES = buildLibrary();

    // ── Packing ──────────────────────────────────────────────────────────

    function shuffled(arr, rand) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    // How many random (shape, position) darts to throw before falling back
    // to an exhaustive scan. Darts are cheap and hit constantly on an empty
    // board; the scan is what proves the board is actually full.
    const DART_THROWS = 60;

    /**
     * Tile a rows×cols board with mosaic pieces, then fill the remainder
     * with one-cell singular groups.
     *
     * Strategy, matching the brief: throw random darts (random shape at a
     * random position) and place whatever lands; when the darts stop hitting,
     * scan exhaustively for ANY remaining legal placement. A shape that the
     * scan proves cannot fit anywhere is retired for good — the board only
     * ever gets fuller, so it can never fit again, and retiring it makes the
     * endgame scans collapse quickly instead of re-proving the same negative.
     * When the scan finds nothing at all, the board is packed.
     *
     * Returns { groups, idx }:
     *   groups[i] = { cells: [[r,c],…], r0, c0, n, size, single }
     *               `n` is the piece's square frame, `r0`/`c0` its top-left.
     *               `single` marks the one-cell singular-fill groups, which
     *               have n === 1 and rotate exactly like a plain tile.
     *   idx[r][c] = index into groups. EVERY cell belongs to a group — that
     *               total coverage is what lets maze.js treat singular fill
     *               as a degenerate group rather than a separate code path.
     *
     * opts.rand — injectable RNG (defaults to Math.random) so tests and any
     * future seeded generation can reproduce a packing exactly.
     * opts.maxFrame — cap piece size below MAX_FRAME.
     */
    function pack(rows, cols, opts) {
        const o = opts || {};
        const rand = o.rand || Math.random;
        const maxFrame = o.maxFrame || MAX_FRAME;

        const idx = [];
        for (let r = 0; r < rows; r++) idx.push(new Array(cols).fill(-1));
        const groups = [];

        // Only shapes that could ever fit on this board at all.
        let usable = SHAPES.filter((s) => s.n <= maxFrame && s.n <= rows && s.n <= cols);

        function fits(shape, r0, c0) {
            for (const [dr, dc] of shape.cells) {
                if (idx[r0 + dr][c0 + dc] !== -1) return false;
            }
            return true;
        }
        function place(shape, r0, c0) {
            const g = {
                cells: shape.cells.map(([dr, dc]) => [r0 + dr, c0 + dc]),
                r0: r0, c0: c0, n: shape.n, size: shape.size, single: false
            };
            const gi = groups.length;
            groups.push(g);
            for (const [r, c] of g.cells) idx[r][c] = gi;
        }

        while (usable.length > 0) {
            // Random darts.
            let landed = false;
            for (let t = 0; t < DART_THROWS; t++) {
                const shape = usable[Math.floor(rand() * usable.length)];
                const r0 = Math.floor(rand() * (rows - shape.n + 1));
                const c0 = Math.floor(rand() * (cols - shape.n + 1));
                if (fits(shape, r0, c0)) { place(shape, r0, c0); landed = true; break; }
            }
            if (landed) continue;

            // Exhaustive pass. Shapes are already largest-first; positions
            // are shuffled so a scan-driven placement doesn't bias toward
            // the top-left corner the way a raw row-major scan would.
            let placed = false;
            const stillUsable = [];
            for (const shape of usable) {
                if (placed) { stillUsable.push(shape); continue; }
                const spots = [];
                for (let r0 = 0; r0 + shape.n <= rows; r0++) {
                    for (let c0 = 0; c0 + shape.n <= cols; c0++) {
                        if (fits(shape, r0, c0)) spots.push([r0, c0]);
                    }
                }
                if (spots.length === 0) continue;   // retired — drop it
                const pick = spots[Math.floor(rand() * spots.length)];
                place(shape, pick[0], pick[1]);
                placed = true;
                stillUsable.push(shape);
            }
            usable = stillUsable;
            if (!placed) break;
        }

        // Singular fill: every cell no piece claimed becomes its own
        // one-cell group. These behave exactly like singular-mode tiles.
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (idx[r][c] !== -1) continue;
                idx[r][c] = groups.length;
                groups.push({ cells: [[r, c]], r0: r, c0: c, n: 1, size: 1, single: true });
            }
        }

        return { groups: groups, idx: idx };
    }

    // ── Authored layouts ─────────────────────────────────────────────────
    //
    // pack() above is the RANDOM packer, and it stays exactly as it was.
    // What follows is the other way a board can get its pieces: a layout
    // somebody DESIGNED, stored as a list of (shape, position) and replayed
    // here. mosaic-library.js owns the file format, the difficulty ranking
    // and the storage; this function owns only the geometry, so maze.js and
    // the worker can consume an authored layout without importing anything
    // new.
    //
    // A shape is identified by its frame `n` plus a row-major BITMASK over
    // that n×n frame (bit dr*n+dc set = that cell is part of the piece).
    // The mask is used rather than the enumeration index or the `key` string
    // for two reasons: it survives a change to MAX_FRAME or to the sort
    // order — neither of which a stored layout should ever notice — and it
    // is 25 bits at most, so it stays an ordinary integer for n ≤ 5.

    function cellsFromMask(n, mask) {
        const cells = [];
        for (let dr = 0; dr < n; dr++) {
            for (let dc = 0; dc < n; dc++) {
                if (mask & (1 << (dr * n + dc))) cells.push([dr, dc]);
            }
        }
        return cells;
    }

    function maskFromCells(n, cells) {
        let mask = 0;
        for (const [dr, dc] of cells) mask |= (1 << (dr * n + dc));
        return mask;
    }

    // n:mask → the library entry, or undefined. Built once from SHAPES, so
    // "is this a legal piece?" is answered by the SAME enumeration that
    // guarantees rotation-invariance — an authored layout can never smuggle
    // in a shape the packer would have refused to place.
    const SHAPE_BY_MASK = (function () {
        const m = Object.create(null);
        for (const s of SHAPES) m[s.n + ':' + maskFromCells(s.n, s.cells)] = s;
        return m;
    })();

    function findShape(n, mask) {
        return SHAPE_BY_MASK[n + ':' + mask] || null;
    }

    /**
     * Build the same { groups, idx } packing pack() returns, but from an
     * authored piece list instead of a random search.
     *
     * `pieces` is [{ n, mask, r, c }, …] — r/c are the piece's top-left
     * frame corner. Anything unplaceable (unknown shape, off the board,
     * overlapping a piece already placed) is SKIPPED rather than thrown on,
     * and reported in the returned `skipped` array. A layout that has drifted
     * out of sync with the board it is being replayed onto should degrade to
     * a sparser board, never to an exception in the middle of a build.
     *
     * As in pack(), every cell no piece claimed becomes its own one-cell
     * singular group, so the total-coverage contract maze.js relies on holds
     * identically for authored and random layouts.
     */
    function packFromLayout(rows, cols, pieces) {
        const idx = [];
        for (let r = 0; r < rows; r++) idx.push(new Array(cols).fill(-1));
        const groups = [];
        const skipped = [];

        const list = pieces || [];
        for (let i = 0; i < list.length; i++) {
            const p = list[i];
            const shape = p ? findShape(p.n, p.mask) : null;
            if (!shape) { skipped.push({ i: i, why: 'unknown-shape' }); continue; }
            if (p.r < 0 || p.c < 0 || p.r + shape.n > rows || p.c + shape.n > cols) {
                skipped.push({ i: i, why: 'out-of-bounds' });
                continue;
            }
            let clash = false;
            for (const [dr, dc] of shape.cells) {
                if (idx[p.r + dr][p.c + dc] !== -1) { clash = true; break; }
            }
            if (clash) { skipped.push({ i: i, why: 'overlap' }); continue; }

            const g = {
                cells: shape.cells.map(([dr, dc]) => [p.r + dr, p.c + dc]),
                r0: p.r, c0: p.c, n: shape.n, size: shape.size, single: false
            };
            const gi = groups.length;
            groups.push(g);
            for (const [r, c] of g.cells) idx[r][c] = gi;
        }

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (idx[r][c] !== -1) continue;
                idx[r][c] = groups.length;
                groups.push({ cells: [[r, c]], r0: r, c0: c, n: 1, size: 1, single: true });
            }
        }

        return { groups: groups, idx: idx, skipped: skipped };
    }

    // The inverse: turn a packing back into an authored piece list, so the
    // editor's "auto-fill" button can hand the random packer's output to the
    // designer as a starting point. Singular fill is dropped — it is the
    // remainder, reconstructed by packFromLayout, never stored.
    function layoutFromPacking(groups) {
        const pieces = [];
        for (const g of groups) {
            if (g.single || g.n <= 1) continue;
            pieces.push({
                n: g.n,
                mask: maskFromCells(g.n, g.cells.map(([r, c]) => [r - g.r0, c - g.c0])),
                r: g.r0, c: g.c0
            });
        }
        return pieces;
    }

    // Where cell (r, c) of group `g` lands after one quarter turn. CW maps
    // local (dr, dc) → (dc, n-1-dr); CCW is the inverse. Because every shape
    // is rotation-invariant the image is guaranteed to be another cell of the
    // SAME group — that guarantee is the whole point of the library filter,
    // and maze.js's group rotation relies on it without re-checking.
    function rotatedCell(g, r, c, ccw) {
        const dr = r - g.r0, dc = c - g.c0, n = g.n;
        return ccw
            ? [g.r0 + (n - 1 - dc), g.c0 + dr]
            : [g.r0 + dc,           g.c0 + (n - 1 - dr)];
    }

    // Summary of a packing, for the debug panel readout.
    function describe(groups) {
        let pieces = 0, singles = 0, covered = 0;
        const bySize = {};
        for (const g of groups) {
            if (g.single) { singles++; covered++; continue; }
            pieces++;
            covered += g.size;
            bySize[g.size] = (bySize[g.size] || 0) + 1;
        }
        return { pieces: pieces, singles: singles, covered: covered, bySize: bySize };
    }

    return {
        SIZES: SIZES,
        MAX_FRAME: MAX_FRAME,
        SHAPES: SHAPES,
        pack: pack,
        rotatedCell: rotatedCell,
        describe: describe,
        // Authored-layout geometry (see the section above). The editor and
        // the puzzle library speak (n, mask, r, c); these convert between
        // that and the { groups, idx } packing the rest of the game uses.
        cellsFromMask: cellsFromMask,
        maskFromCells: maskFromCells,
        findShape: findShape,
        packFromLayout: packFromLayout,
        layoutFromPacking: layoutFromPacking,
        // Exposed for the test harness — verifying the library's invariance
        // rule from outside is worth more than trusting the construction.
        _orbitsOf: orbitsOf,
        _isConnected: isConnected
    };
})();

// Worker + Node compatibility. maze-worker.js importScripts this file before
// maze.js; the test harness requires it into a vm sandbox.
if (typeof module !== 'undefined' && module.exports) module.exports = Mosaic;
