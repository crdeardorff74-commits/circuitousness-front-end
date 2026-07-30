/**
 * gates.js — Circuitousness "gates" feature.
 *
 * A gate sits at an interior grid vertex with a directional prong. The prong
 * blocks the edge it points along — paths can't traverse a blocked edge. All
 * gates on a board rotate IN UNISON (one shared `delta`), but each gate has
 * its OWN solution-direction picked at placement time, so their visual
 * orientations are random.
 *
 * Public state:
 *   Gates.list         — [{ vr, vc, solutionDir }, ...]
 *   Gates.delta        — shared CW offset (0..3); player rotation increments
 *   Gates.currentDir(gate) — (gate.solutionDir + delta) & 3
 *
 * Placement:
 *   Gates.assignGates(rows, cols, solutionEdges, target)
 *     solutionEdges = Set of canonical "r1,c1|r2,c2" keys traversed by the
 *     solved path. For each interior vertex, the set of directions whose
 *     edge isn't in solutionEdges = the gate's safe set. Each placed gate
 *     gets a random safeDir as its solutionDir. No two gates land on
 *     adjacent vertices, orthogonal or diagonal (see the spacing skip in
 *     the placement loop). delta is randomized so the player doesn't
 *     start at the solved gate state.
 *
 * Walk integration:
 *   Gates.edgeBlocked(r1, c1, r2, c2) — true if a gate currently blocks the
 *   edge between adjacent cells (r1, c1) and (r2, c2). maze.js's walkFrom
 *   checks this before stepping into a neighbor.
 *
 * Rendering helpers:
 *   Gates.polygonsFor(gate, cellSize, cx, cy) → { outline, palette }
 *     outline = single CW vertex loop tracing the gate's full silhouette
 *     (square base + shaft + tip merged into one polygon). Rendering it as
 *     one polygon gives a continuous bevel around the entire shape rather
 *     than two visible bevel seams where the prong meets the base.
 *   Gates.hitTest(gate, cellSize, cx, cy, x, y) → boolean
 *
 * Worker-safe: the maze-worker context doesn't load this module; maze.js
 * guards calls with `typeof Gates !== 'undefined'` so the worker just runs
 * its walks without gate blocking. Gates are placed on the main thread
 * after loadSnapshot so the marathon solve count is current.
 */

const Gates = (() => {
    // Sizing as fractions of cellSize. Total reach from vertex center to tip
    // (= BASE_FRAC/2 + SHAFT_LENGTH_FRAC + TIP_LENGTH_FRAC) equals 1.0 so
    // the tip lands exactly on the adjacent vertex — gate spans one full edge.
    // TIP_LENGTH_FRAC must equal SHAFT_WIDTH_FRAC/2: the tip edges then run
    // at exactly 45°, matching the tile bevels' miter angle.
    const BASE_FRAC         = 0.22;
    const SHAFT_LENGTH_FRAC = 0.83;
    const SHAFT_WIDTH_FRAC  = 0.12;
    const TIP_LENGTH_FRAC   = 0.06;

    // Buffer zone past the gate's bounding box for hit-testing — clicks
    // within this margin still count as gate clicks. 0.07 = ~7% of
    // cellSize (e.g. ~4px on a 60px cell) — enough fat-finger forgiveness
    // for touch without stealing taps from adjacent tiles. Was 0.20
    // originally, which was generous enough that clicks meaningfully
    // far from a gate's drawn silhouette still rotated the gate
    // instead of the tile under the cursor.
    const HIT_BUFFER_FRAC = 0.07;

    // Bright red palette. faceAlpha = 1 forces opacity since the default
    // TILE_FACE_ALPHA would render the gate translucent over the tile under.
    const PALETTE = {
        face:  '#FF2020',
        top:   '#FF7070',
        right: '#E01818',
        bot:   '#B00808',
        left:  '#FF4040',
        faceAlpha: 1
    };

    let delta = 0;
    let list  = [];               // [{ vr, vc, solutionDir }, ...]
    let blockedEdgesCache = null; // Set of canonical edge keys; lazy-built

    function currentDir(gate) {
        return (gate.solutionDir + delta) & 3;
    }

    // The edge a gate at vertex (vr, vc) blocks when its prong points `dir`.
    // Canonical "r1,c1|r2,c2" key with the lexicographically-smaller cell
    // first — matches what canonicalEdgeKey produces, so set lookups match.
    function edgeKeyForGateDir(vr, vc, dir) {
        if (dir === 0) return (vr - 1) + ',' + (vc - 1) + '|' + (vr - 1) + ',' + vc;
        if (dir === 1) return (vr - 1) + ',' + vc + '|' + vr + ',' + vc;
        if (dir === 2) return vr + ',' + (vc - 1) + '|' + vr + ',' + vc;
        return (vr - 1) + ',' + (vc - 1) + '|' + vr + ',' + (vc - 1);
    }

    function canonicalEdgeKey(r1, c1, r2, c2) {
        if (r1 < r2 || (r1 === r2 && c1 < c2)) {
            return r1 + ',' + c1 + '|' + r2 + ',' + c2;
        }
        return r2 + ',' + c2 + '|' + r1 + ',' + c1;
    }

    function rebuildBlockedEdges() {
        blockedEdgesCache = new Set();
        for (const gate of list) {
            blockedEdgesCache.add(edgeKeyForGateDir(gate.vr, gate.vc, currentDir(gate)));
        }
    }

    function clear() {
        list = [];
        delta = 0;
        blockedEdgesCache = null;
    }

    function assignGates(rows, cols, solutionEdges, target, vertexStride, preferredEdges) {
        list = [];
        blockedEdgesCache = null;
        delta = 0;
        const stride = vertexStride || 1;
        if (rows < stride + 1 || cols < stride + 1 || target <= 0) return;

        // Per-vertex safe-direction set. A direction is "safe" iff its edge
        // isn't traversed by any solution path — the gate can land there
        // without breaking the puzzle. Stride controls which vertices are
        // candidates: stride 1 = every sub-tile vertex (non-quad mode),
        // stride 2 = only quad-corner vertices (every other sub-tile vertex),
        // so gates in quad mode anchor at the visible-tile corners only.
        //
        // preferredEdges (optional, Maze.alternateRouteEdges): canonical
        // edge keys of detected leftover alternate routes. A safe dir whose
        // edge is on an alternate is a PREFERRED dir — at the solved delta
        // the gate sits at solutionDir and blocks exactly that edge, so
        // gates the player must open anyway double as alternate-blockers
        // (2026-07-29; the main pressure valve for 3/4-path boards, which
        // skip the canonical equal-alternate suppression entirely).
        const candidates = [];
        for (let vr = stride; vr < rows; vr += stride) {
            for (let vc = stride; vc < cols; vc += stride) {
                const safeDirs = [];
                const preferredDirs = [];
                for (let d = 0; d < 4; d++) {
                    if (!solutionEdges.has(edgeKeyForGateDir(vr, vc, d))) {
                        safeDirs.push(d);
                        if (preferredEdges && preferredEdges.has(edgeKeyForGateDir(vr, vc, d))) {
                            preferredDirs.push(d);
                        }
                    }
                }
                if (safeDirs.length > 0) candidates.push({ vr, vc, safeDirs, preferredDirs });
            }
        }
        // Fisher-Yates shuffle.
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
        }
        // Stable partition after the shuffle: alternate-severing candidates
        // first (random among themselves, random among the rest — only the
        // PRIORITY is deterministic). No-op when preferredEdges is absent.
        if (preferredEdges) {
            const pref = candidates.filter((c) => c.preferredDirs.length > 0);
            const rest = candidates.filter((c) => c.preferredDirs.length === 0);
            candidates.length = 0;
            Array.prototype.push.apply(candidates, pref);
            Array.prototype.push.apply(candidates, rest);
        }
        // Greedy pick from the shuffled order, skipping any candidate
        // adjacent to an already-placed gate — orthogonally OR diagonally
        // (Chebyshev distance 1, i.e. the 8 surrounding vertices). A
        // gate's prong spans exactly one edge, so an orthogonal pair can
        // have one's tip touching the other's base, and a diagonal pair's
        // perpendicular prongs can form a near-touching L around the
        // shared cell (seen in the wild 2026-07-26) — both read as one
        // mushed shape. Quad mode's stride-2 candidates are ≥2 apart and
        // never trigger the skip. Dense targets on small boards may place
        // fewer than `target` — same graceful degradation as the
        // candidate cap above.
        const count = Math.min(target, candidates.length);
        for (let i = 0; i < candidates.length && list.length < count; i++) {
            const c = candidates[i];
            let tooClose = false;
            for (const g of list) {
                if (Math.abs(g.vr - c.vr) <= 1 && Math.abs(g.vc - c.vc) <= 1) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) continue;
            // Preferred (alternate-severing) dirs win when present; the
            // pick within either pool stays random.
            const pool = (c.preferredDirs && c.preferredDirs.length > 0) ? c.preferredDirs : c.safeDirs;
            const solutionDir = pool[Math.floor(Math.random() * pool.length)];
            list.push({ vr: c.vr, vc: c.vc, solutionDir });
        }
        // Randomize the global delta so the player doesn't start at the
        // gates-solved state. Per-gate solutionDirs are already random, so
        // initial orientations vary across the board regardless of delta.
        delta = Math.floor(Math.random() * 4);
    }

    function rotate(ccw) {
        delta = (delta + (ccw ? 3 : 1)) & 3;
        blockedEdgesCache = null;
    }

    // Minimum number of gate rotations (in whichever direction is shorter)
    // that puts EVERY gate on an edge no solution path uses. delta 0 is
    // safe by construction (each gate's solutionDir was picked from its
    // safe set), so a finite answer always exists; 0 when there are no
    // gates. `solutionEdges` = the same canonical-edge-key Set assignGates
    // receives (Maze.solutionEdges()). Feeds Maze.minSolveMoves.
    function minMovesToClear(solutionEdges) {
        if (list.length === 0) return 0;
        let best = Infinity;
        for (let d = 0; d < 4; d++) {
            let safe = true;
            for (const gate of list) {
                if (solutionEdges.has(edgeKeyForGateDir(gate.vr, gate.vc, (gate.solutionDir + d) & 3))) {
                    safe = false;
                    break;
                }
            }
            if (!safe) continue;
            const t = (d - delta + 4) & 3;
            best = Math.min(best, Math.min(t, 4 - t));
        }
        return best === Infinity ? 0 : best;
    }

    function edgeBlocked(r1, c1, r2, c2) {
        if (list.length === 0) return false;
        if (!blockedEdgesCache) rebuildBlockedEdges();
        return blockedEdgesCache.has(canonicalEdgeKey(r1, c1, r2, c2));
    }

    function hitTest(gate, cellSize, cx, cy, x, y) {
        const dx = x - cx;
        const dy = y - cy;
        const dir = currentDir(gate);
        let lx, ly;
        if (dir === 0)      { lx = dx;  ly = dy;  }
        else if (dir === 1) { lx = dy;  ly = -dx; }
        else if (dir === 2) { lx = -dx; ly = -dy; }
        else                { lx = -dy; ly = dx;  }
        const B = cellSize * BASE_FRAC / 2;
        const L = cellSize * SHAFT_LENGTH_FRAC;
        const T = cellSize * TIP_LENGTH_FRAC;
        const buffer = cellSize * HIT_BUFFER_FRAC;
        return lx >= -B - buffer && lx <= B + buffer
            && ly >= -B - L - T - buffer && ly <= B + buffer;
    }

    // Rotate a point around (cx, cy) by r 90° CW steps. Canvas Y-down.
    function rotateCW(p, cx, cy, r) {
        const dx = p.x - cx, dy = p.y - cy;
        if (r === 0) return { x: cx + dx, y: cy + dy };
        if (r === 1) return { x: cx - dy, y: cy + dx };
        if (r === 2) return { x: cx - dx, y: cy - dy };
        return         { x: cx + dy, y: cy - dx };
    }

    // Build the merged silhouette polygon for a gate in canvas coords,
    // oriented by currentDir(). Baseline points N (prong toward -Y); a CW
    // rotation by `dir` 90° steps maps N→E→S→W.
    //
    // The outline is a single CW loop in screen y-down coords, traced from
    // the top-left of the square base, up around the prong+tip, back to
    // the top-right of the base, then around the base's right/bottom/left
    // sides. Two concave corners — where the narrow prong meets the wider
    // base on each side — are within insetPolygon's tolerance for the
    // small bevel widths gates use, so a single drawBeveledPolygon call
    // produces a continuous, seamless bevel around the full silhouette.
    function polygonsFor(gate, cellSize, cx, cy) {
        const B = cellSize * BASE_FRAC / 2;
        const S = cellSize * SHAFT_WIDTH_FRAC / 2;
        const L = cellSize * SHAFT_LENGTH_FRAC;
        const T = cellSize * TIP_LENGTH_FRAC;

        const outlineN = [
            { x: cx - B, y: cy - B         },   // 1. base top-left
            { x: cx - S, y: cy - B         },   // 2. base top → prong left  (concave)
            { x: cx - S, y: cy - B - L     },   // 3. shaft top-left
            { x: cx,     y: cy - B - L - T },   // 4. tip point
            { x: cx + S, y: cy - B - L     },   // 5. shaft top-right
            { x: cx + S, y: cy - B         },   // 6. prong right → base top (concave)
            { x: cx + B, y: cy - B         },   // 7. base top-right
            { x: cx + B, y: cy + B         },   // 8. base bottom-right
            { x: cx - B, y: cy + B         }    // 9. base bottom-left
        ];

        const r = currentDir(gate);
        return {
            outline: outlineN.map((p) => rotateCW(p, cx, cy, r)),
            palette: PALETTE
        };
    }

    // Whole-board 90° rotation companion to Maze.rotateBoard (the
    // joined-paths penalty; game.js applyBoardRotation orchestrates the
    // pair). Vertices are grid POINTS, so the map differs from the cell
    // map: CW (vr,vc) → (vc, oldRows − vr); CCW → (oldCols − vc, vr) —
    // interior vertices stay interior. Each gate's SOLUTION direction
    // rotates with the board while the unison `delta` stays put: the
    // current prong direction (solutionDir + delta) then comes out
    // rotated exactly one quarter turn, and minMovesToClear (delta-based)
    // is invariant — the penalty rotates the puzzle, it doesn't change
    // how far the gates are from open. Derivation check lives in the
    // session notes: a dir-N gate's blocked edge maps to precisely the
    // edge its rotated dir-E/W self blocks.
    function rotateBoard(ccw, oldRows, oldCols) {
        const d = ccw ? 3 : 1;
        for (const g of list) {
            const vr = g.vr, vc = g.vc;
            if (ccw) { g.vr = oldCols - vc; g.vc = vr; }
            else     { g.vr = vc;           g.vc = oldRows - vr; }
            g.solutionDir = (g.solutionDir + d) & 3;
        }
        blockedEdgesCache = null;
    }

    // Mirror-flip companion to Maze.flipBoard (penalty variant 2).
    // `vertical` = top-bottom flip. Vertex points mirror on one axis;
    // each gate's solution direction mirrors (N↔S for vertical, E↔W for
    // horizontal); and the unison `delta` NEGATES — reflections
    // conjugate rotations (M∘R^d = R^-d∘M), so keeping currentDir =
    // solutionDir + delta consistent with the mirrored prongs requires
    // delta' = -delta. minMovesToClear is distance-to-0 in either
    // direction, which negation preserves.
    function flipBoard(vertical, oldRows, oldCols) {
        const mDir = vertical
            ? (p) => (2 - p) & 3
            : (p) => (4 - p) & 3;
        for (const g of list) {
            if (vertical) g.vr = oldRows - g.vr;
            else          g.vc = oldCols - g.vc;
            g.solutionDir = mDir(g.solutionDir);
        }
        delta = (4 - delta) & 3;
        blockedEdgesCache = null;
    }

    // Capture/restore for recording & replay. Snapshot is structured-clone
    // safe (plain primitives in arrays/objects). Restore validates against
    // the current grid dims is the caller's job — we don't know them here.
    function snapshot() {
        return {
            list:  list.map((g) => Object.assign({}, g)),
            delta: delta
        };
    }

    function restore(s) {
        if (!s) { clear(); return; }
        list = (s.list || []).map((g) => Object.assign({}, g));
        delta = s.delta | 0;
        blockedEdgesCache = null;
    }

    return {
        get list()  { return list; },
        get delta() { return delta; },
        currentDir,
        clear,
        assignGates,
        rotate,
        rotateBoard,
        flipBoard,
        edgeBlocked,
        minMovesToClear,
        hitTest,
        polygonsFor,
        snapshot,
        restore
    };
})();
