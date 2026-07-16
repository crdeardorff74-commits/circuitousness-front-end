/**
 * maze.js — Circuitousness grid model, tile logic, and connectivity check.
 *
 * Tile model:
 *   A tile = { type, rotation }
 *     type:     0 = straight, 1 = elbow, 2 = cross
 *     rotation: 0..3 (90° clockwise steps)
 *
 *   Ports are N=0, E=1, S=2, W=3 (clockwise from top).
 *   Base connections (rotation 0):
 *     straight: [N–S]
 *     elbow:    [N–E]
 *     cross:    [N–S, E–W]   (two non-touching lanes)
 *
 *   Rotating a tile rotates each port by `rotation` steps clockwise.
 *
 * Generation:
 *   1. Pick entry + exit on different perimeter sides.
 *   2. Port-walking randomized DFS from the entry. Each step picks an exit
 *      port for the current cell and moves through it to a neighbor. A cell
 *      can be revisited iff the second visit forms a valid cross — i.e. the
 *      first visit used opposite ports (e.g. N–S), and the second visit
 *      uses the perpendicular pair (E–W). Cells with two lanes become
 *      cross tiles in the solution; cells with one lane become straight or
 *      elbow; unvisited cells are random filler (any of the three types).
 *
 * Connectivity:
 *   Walk from the entry port, hop tile-to-tile via matching ports.
 *   Return the ordered list of (cell, inPort, outPort) the path visits.
 *   Win when the walk exits the grid at the exit port.
 */

const Maze = (() => {
    let ROWS = 4;
    let COLS = 4;
    const N = 0, E = 1, S = 2, W = 3;

    const T_STRAIGHT = 0;
    const T_ELBOW    = 1;
    const T_CROSS    = 2;

    // Difficulty floors — every value here scales with the grid's average
    // dimension so changing dimensions keeps the puzzle character intact.
    // Tune the multipliers, not the absolute results.
    //   minPathLength()     — intended (DFS-generated) path floor.   [18 at 8×8]
    //                         Doubles as the floor for the shortest
    //                         *possible* path: any alternate solution
    //                         must be at least as long as the intended.
    //   minShortcutTwists() — rotation-cost floor across all paths.  [10 at 8×8]
    //   twinPairCount()     — # of locked-rotation tile pairs.       [3 at 8×8]
    //   maxDfsSteps()       — bail-out cap on the lane-DFS, scales with
    //                         the cell × port state space.       [8000 at 8×8]
    // Retry/sample counts (below) don't depend on grid size — they bound the
    // search algorithms, not the puzzle difficulty.
    function gridScale()        { return (ROWS + COLS) / 2; }
    function minPathLength()    { return Math.round(gridScale() * 2.25); }
    function minShortcutTwists(){ return Math.round(gridScale() * 1.25); }
    // Twin density scales off DOUBLED gridScale so 8×8 now produces ~11
    // pairs (was 3). Kept as a separate multiplier here rather than baked
    // into gridScale() itself so it doesn't cascade into the path-length /
    // shortcut floors above, which need to stay where they are for the
    // puzzle's overall character. Halve back to 1× if it feels too dense.
    function twinPairCount()    { return Math.max(1, Math.round(gridScale() * 2) - 5); }
    function maxDfsSteps()      { return ROWS * COLS * 125; }
    const MAX_PATH_GEN_TRIES    = 12;  // re-runs of generateLanes per buildPuzzle
    const MAX_REROLL_ATTEMPTS   = 15;  // rotation rerolls per entry/exit pair
    const MAX_INIT_ATTEMPTS     = 10;  // fresh entry/exit picks before giving up
    const ENDPOINT_SAMPLES      = 5;   // pick farthest of N random endpoint configs

    // Twin locking: pair up N tiles where each pair is one path tile + one
    // filler tile. Rotating either twin rotates its partner by the same
    // delta. Visually distinguished by per-pair pastel color (the bevel uses
    // the color as a base and shades it for top/left/bot/right). Red is
    // reserved for hint-locked tiles. Pair count scales linearly with grid
    // size so larger grids get more constraints; min 1 keeps small grids playable.
    // Cycled by `i % TWIN_COLORS.length` in assignTwins — once pair count
    // exceeds the palette length, colors start repeating. With the density
    // doubled (gridScale * 2 in twinPairCount), an 8×8 needs 11 pairs and
    // bigger grids more, so the palette holds 16 colors — covers up to 21
    // pairs without repeats.
    //
    // The 16 are chosen for PERCEPTUAL separation, not just hue variety: the
    // previous hand-picked pastels had near-duplicates (two tans, several
    // muted purples) only ~6 ΔE apart (CIE76 Lab) — confusable at a glance.
    // These were selected by farthest-point dispersion in Lab within a soft
    // pastel band, giving a minimum pairwise distance of ~24 ΔE (every pair
    // clearly distinct). Where a hue is crowded the separation is carried by
    // LIGHTNESS — e.g. amber #C98554 vs pale peach #D7B8A2 share a hue but
    // sit far apart in L. Red is intentionally absent (hue kept to 25–330°),
    // reserved for hint-locked tiles.
    //
    // Order matters for low-pair puzzles: colors are consumed in index order,
    // so the list is sequenced by greedy max-min spread — the first few
    // entries are as far apart as possible (a 2-pair puzzle gets green vs
    // magenta, ~147 ΔE), with later entries filling in.
    const TWIN_COLORS = [
        '#54C954', // green
        '#BF54C9', // magenta
        '#C98554', // amber
        '#5BA0C2', // sky blue
        '#D4DF9A', // pale chartreuse
        '#D7A2BD', // pale pink
        '#54C9AC', // teal
        '#5454C9', // indigo
        '#C9548F', // rose
        '#547BC9', // blue
        '#D7B8A2', // pale peach
        '#A2D7D7', // pale cyan
        '#ACC954', // olive lime
        '#C9AC54', // gold
        '#88D388', // light green
        '#BD9ADF'  // lavender
    ];

    const BASE_CONNECTIONS = {
        [T_STRAIGHT]: [[N, S]],
        [T_ELBOW]:    [[N, E]],
        [T_CROSS]:    [[N, S], [E, W]]
    };

    // Cell offset for moving in a direction
    const DELTA = {
        [N]: { dr: -1, dc: 0 },
        [E]: { dr:  0, dc: 1 },
        [S]: { dr:  1, dc: 0 },
        [W]: { dr:  0, dc: -1 }
    };

    let grid = null;       // grid[r][c] = { type, rotation }
    let entry  = null;     // primary entry, always set
    let exit   = null;
    let entry2 = null;     // additional entries — null when pathCount < 2
    let exit2  = null;
    let entry3 = null;     // null when pathCount < 3
    let exit3  = null;
    let entry4 = null;     // null when pathCount < 4
    let exit4  = null;
    let pathCount = 1;     // 1, 2, 3, or 4
    function setPathCount(n) {
        const v = parseInt(n, 10);
        pathCount = (v === 2 || v === 3 || v === 4) ? v : 1;
    }
    // Back-compat: existing callers used setTwoPathMode(bool).
    function setTwoPathMode(on) { setPathCount(on ? 2 : 1); }

    // Quad mode: each visible "tile" is actually a 2×2 group of underlying
    // sub-tiles that rotate together as one unit. The maze is generated at
    // 2× the requested dimensions; rotate() applies a quad rotation (4-cycle
    // sub-tile positions around the quad center + each sub-tile's own rotation
    // increments). Twins/canonical-uniqueness are skipped because they
    // assume independent per-tile rotation, which doesn't hold inside a quad.
    //
    // quadScramble[qr][qc] = current CW rotation offset from solved (0..3).
    // Player CW rotation adds 1; CCW adds 3. When all entries are 0 the maze
    // is in its canonical (solved) state. Used by hint() to pick non-solved
    // quads and snap them to 0.
    let quadMode = false;
    let quadScramble = null;
    function setQuadMode(on) { quadMode = !!on; }
    let highlighted = [];  // [{ row, col, inPort, outPort }, ...]
    let locked = new Set();// "r,c" of hint-locked tiles — cannot be rotated
    let won = false;

    function rot(p, r) { return (p + r) & 3; }

    function getConnections(tile) {
        return BASE_CONNECTIONS[tile.type].map(([a, b]) => [rot(a, tile.rotation), rot(b, tile.rotation)]);
    }

    // Given a port you're entering by, what port do you exit by? null if no connection.
    function getExitPort(tile, enteringPort) {
        for (const [a, b] of getConnections(tile)) {
            if (a === enteringPort) return b;
            if (b === enteringPort) return a;
        }
        return null;
    }

    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function inBounds(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

    function neighborInDirection(cell, port) {
        const d = DELTA[port];
        const r = cell.row + d.dr, c = cell.col + d.dc;
        return inBounds(r, c) ? { row: r, col: c } : null;
    }

    // Find a rotation r such that base connections rotated by r contain {a, b}
    function findRotation(type, a, b) {
        for (let r = 0; r < 4; r++) {
            for (const [pa, pb] of BASE_CONNECTIONS[type]) {
                const ra = rot(pa, r), rb = rot(pb, r);
                if ((ra === a && rb === b) || (ra === b && rb === a)) return r;
            }
        }
        return 0;
    }

    function randomCellOnEdge(side) {
        // N/S edges sample a column; W/E edges sample a row.
        if (side === N) return { row: 0,        col: Math.floor(Math.random() * COLS) };
        if (side === S) return { row: ROWS - 1, col: Math.floor(Math.random() * COLS) };
        if (side === W) return { row: Math.floor(Math.random() * ROWS), col: 0 };
        return                 { row: Math.floor(Math.random() * ROWS), col: COLS - 1 }; // E
    }

    // Port-walking DFS that records committed lanes per cell.
    // A cell can hold 0, 1, or 2 lanes. With 2 lanes, they must form a cross:
    // the existing lane must be opposite-pair (N–S or E–W), and the new lane
    // must be the perpendicular opposite-pair. Elbow lanes (perpendicular)
    // never permit a second lane.
    // `seedLanes` (optional): existing cellLanes Map to ADD to. The DFS will
    // accept revisits to those cells iff they form a valid cross — used by
    // two-path mode where the second path can intersect the first via cross
    // tiles. `pathIdx` (default 0) tags each lane with which path generated
    // it, so the renderer can later color path 0 green/gold and path 1
    // blue/gold independently. Returns the (possibly mutated) map on
    // success, null on failure. Lanes are stored as [enterPort, exitPort, pathIdx].
    function generateLanes(seedLanes, pathIdx) {
        const myPath = pathIdx || 0;
        const cellLanes = seedLanes || new Map();
        const seedKeys = seedLanes ? new Set(seedLanes.keys()) : null;
        const k = (r, c) => r + ',' + c;
        let dfsSteps = 0;
        const dfsCap = maxDfsSteps();

        function isOppositePair(a, b) { return ((a + 2) & 3) === b; }
        function getLanes(r, c)       { return cellLanes.get(k(r, c)) || []; }

        // Can a new lane (a, b) be added to (r, c) without violating the cross constraint?
        function canAddLane(r, c, a, b) {
            const ls = getLanes(r, c);
            if (ls.length === 0) return true;
            if (ls.length >= 2)  return false;
            const [pa, pb] = ls[0];
            if (!isOppositePair(pa, pb)) return false;     // existing is elbow → no cross possible
            if (a === pa || a === pb || b === pa || b === pb) return false; // overlap
            return isOppositePair(a, b);                    // new must also be opposite pair
        }

        // Can we ENTER (r, c) via `port` (i.e. is there room for a lane that uses this port)?
        function canEnter(r, c, port) {
            const ls = getLanes(r, c);
            if (ls.length === 0) return true;
            if (ls.length >= 2)  return false;
            const [pa, pb] = ls[0];
            if (port === pa || port === pb) return false;
            return isOppositePair(pa, pb); // existing must be a straight to allow a perpendicular lane
        }

        function addLane(r, c, a, b) {
            const key = k(r, c);
            const ls  = cellLanes.get(key) || [];
            ls.push([a, b, myPath]);
            cellLanes.set(key, ls);
        }
        function popLane(r, c) {
            const key = k(r, c);
            const ls  = cellLanes.get(key);
            ls.pop();
            if (ls.length === 0) cellLanes.delete(key);
        }

        function dfs(r, c, enterPort) {
            if (++dfsSteps > dfsCap) return false; // bail; caller will retry

            // Bias: try exits that lead into virgin cells (no lanes yet)
            // before exits that lead into already-visited cells or off-grid.
            // Without this bias the DFS happily heads straight for the exit,
            // producing short, uninteresting paths.
            const candidates = [N, E, S, W].filter((p) => p !== enterPort);
            const virgin = [], rest = [];
            for (const ep of candidates) {
                const nr = r + DELTA[ep].dr;
                const nc = c + DELTA[ep].dc;
                if (inBounds(nr, nc) && getLanes(nr, nc).length === 0) virgin.push(ep);
                else rest.push(ep);
            }
            const exits = shuffle(virgin).concat(shuffle(rest));
            for (const ep of exits) {
                if (!canAddLane(r, c, enterPort, ep)) continue;
                const nr = r + DELTA[ep].dr;
                const nc = c + DELTA[ep].dc;

                if (!inBounds(nr, nc)) {
                    // Off-grid via this exit: only valid if it matches the puzzle's exit port
                    if (r === exit.row && c === exit.col && ep === exit.port) {
                        addLane(r, c, enterPort, ep);
                        return true;
                    }
                    continue;
                }
                const nextEnter = (ep + 2) & 3;
                if (!canEnter(nr, nc, nextEnter)) continue;

                addLane(r, c, enterPort, ep);
                if (dfs(nr, nc, nextEnter)) return true;
                popLane(r, c);
            }
            return false;
        }

        return dfs(entry.row, entry.col, entry.port) ? cellLanes : null;
    }

    // Min rotations to make `tile` carry a lane from port a to port b.
    // Returns Infinity if no rotation of this tile type supports the lane.
    function minRotCost(tile, a, b) {
        let best = Infinity;
        for (let r = 0; r < 4; r++) {
            for (const [pa, pb] of BASE_CONNECTIONS[tile.type]) {
                const ra = rot(pa, r), rb = rot(pb, r);
                if ((ra === a && rb === b) || (ra === b && rb === a)) {
                    const cost = (r - tile.rotation + 4) & 3;
                    if (cost < best) best = cost;
                }
            }
        }
        return best;
    }

    // Bounded threshold search: returns true iff some entry→exit path exists
    // with total rotation cost < threshold. We only care whether such a
    // shortcut exists, not its exact cost — so we prune aggressively and
    // exit on the first hit. State space is bounded (<=256 cells × 4 ports
    // × `threshold` cost levels), and the threshold cap keeps the search
    // small even when the grid has many low-cost paths.
    //
    // Doesn't model self-crossing through cross tiles — using a cross's
    // second lane only adds traversal length, never reduces total rotation
    // cost (crosses are 4-symmetric, first visit is already free).
    function hasShortcutWithin(threshold, blockedSet) {
        if (threshold <= 0) return false;
        const best  = new Map(); // state-key → cheapest cost reached
        const stack = [];

        function visit(cost, r, c, p) {
            if (cost >= threshold) return;
            if (blockedSet && blockedSet.has(r + ',' + c)) return;
            const k = r + ',' + c + ',' + p;
            const prev = best.get(k);
            if (prev !== undefined && prev <= cost) return;
            best.set(k, cost);
            stack.push([cost, r, c, p]);
        }

        visit(0, entry.row, entry.col, entry.port);

        while (stack.length > 0) {
            const [cost, r, c, p] = stack.pop();
            // Skip if a cheaper path to this state has since been found.
            if (best.get(r + ',' + c + ',' + p) < cost) continue;

            const tile = grid[r][c];
            for (const exitP of [N, E, S, W]) {
                if (exitP === p) continue;
                const rc = minRotCost(tile, p, exitP);
                if (rc === Infinity) continue;
                const nextCost = cost + rc;
                if (nextCost >= threshold) continue;

                const nr = r + DELTA[exitP].dr;
                const nc = c + DELTA[exitP].dc;
                if (!inBounds(nr, nc)) {
                    if (r === exit.row && c === exit.col && exitP === exit.port) return true;
                    continue;
                }
                visit(nextCost, nr, nc, (exitP + 2) & 3);
            }
        }
        return false;
    }

    // BFS for the shortest *possible* entry→exit path, treating rotation as
    // free (the player can rotate any tile), so an edge exists between two
    // cells iff the source tile's TYPE can carry a lane between the relevant
    // ports at any rotation. Returns the cell count of the shortest such
    // path, or Infinity if none exists. This catches "long intended path
    // but short shortcut" puzzles that the rotation-cost detector misses:
    // a 5-cell shortcut might cost 12 rotations to align (above threshold)
    // but the player still only traverses 5 cells.
    function shortestPossiblePathLength(blockedSet) {
        const path = shortestPossiblePath(blockedSet);
        return path ? path.length : Infinity;
    }

    // BFS the shortest possible path, returning the actual cells traversed
    // as an array of {r, c, in, out} steps (in/out are the entry/exit ports
    // at that cell). Used by smartReroll to identify and break shortcut
    // tiles. Returns null if no path exists.
    function shortestPossiblePath(blockedSet) {
        // Map each visited (cell, entryPort) state to {parent: parent_state_key,
        // childExit: the exit port at THIS cell that led to the parent's child}.
        // We can reconstruct the full path by walking parents back to start.
        // blockedSet (optional): "r,c" keys of cells excluded from traversal.
        // Used by 2-path canonical to forbid the BFS from threading through
        // tiles that belong exclusively to the OTHER path's solution.
        const parent = new Map();
        const startKey = entry.row + ',' + entry.col + ',' + entry.port;
        parent.set(startKey, null);
        const queue = [[entry.row, entry.col, entry.port]];
        let head = 0;
        let exitFromR = -1, exitFromC = -1, exitFromPort = -1, exitOutPort = -1;
        outer: while (head < queue.length) {
            const [r, c, p] = queue[head++];
            const tile = grid[r][c];
            for (const exitP of [N, E, S, W]) {
                if (exitP === p) continue;
                if (minRotCost(tile, p, exitP) === Infinity) continue;
                const nr = r + DELTA[exitP].dr;
                const nc = c + DELTA[exitP].dc;
                if (!inBounds(nr, nc)) {
                    if (r === exit.row && c === exit.col && exitP === exit.port) {
                        exitFromR = r; exitFromC = c; exitFromPort = p; exitOutPort = exitP;
                        break outer;
                    }
                    continue;
                }
                if (blockedSet && blockedSet.has(nr + ',' + nc)) continue;
                const nextP = (exitP + 2) & 3;
                const k = nr + ',' + nc + ',' + nextP;
                if (parent.has(k)) continue;
                parent.set(k, r + ',' + c + ',' + p);
                queue.push([nr, nc, nextP]);
            }
        }
        if (exitFromR < 0) return null;

        // Backtrack: at each cell, entry port is `p` from the state key.
        // Exit port is the OPPOSITE of the next cell's entry port (or, for
        // the last cell, exitOutPort itself).
        const path = [];
        let curKey = exitFromR + ',' + exitFromC + ',' + exitFromPort;
        let outAtCur = exitOutPort;
        while (curKey) {
            const [r, c, p] = curKey.split(',').map(Number);
            path.unshift({ r, c, in: p, out: outAtCur });
            const pKey = parent.get(curKey);
            if (!pKey) break;
            outAtCur = (p + 2) & 3; // parent's exit = opposite of this cell's entry
            curKey = pKey;
        }
        return path;
    }

    // Break the BFS shortcut by changing filler tile types on the shortest
    // path. Each iteration: find the current BFS shortest path, find a
    // filler tile (no _solution) on it, change its type to one that can't
    // carry the (in, out) connection used at that cell. Repeat until BFS
    // shortest is >= intendedLen, or no more filler tiles can be broken.
    // Returns true on success, false if we ran out of breakable tiles.
    function smartReroll(intendedLen, blockedSet) {
        const cap = ROWS * COLS;  // upper bound — every filler can be touched once
        for (let iter = 0; iter < cap; iter++) {
            const path = shortestPossiblePath(blockedSet);
            if (!path || path.length >= intendedLen) return true;

            let broke = false;
            for (const step of path) {
                const tile = grid[step.r][step.c];
                if (tile._solution !== undefined) continue;             // path tile, can't change
                if (step.r === entry.row && step.c === entry.col) continue; // entry tile, fixed by notch
                if (step.r === exit.row  && step.c === exit.col)  continue; // exit tile, fixed by notch
                const isOpposite = ((step.in + 2) & 3) === step.out;
                // Straight & cross both carry opposite-port pairs; elbow
                // carries adjacent. Switch to whichever can't carry the
                // current shortcut connection.
                const newType = isOpposite ? T_ELBOW : T_STRAIGHT;
                if (tile.type === newType) continue; // already this type — would be a no-op, skip
                tile.type = newType;
                tile.rotation = Math.floor(Math.random() * 4);
                broke = true;
                break;
            }
            if (!broke) return false; // every shortcut tile is fixed (path/entry/exit)
        }
        return false;
    }

    // Re-roll just rotations (preserving tile types). Used after smartReroll
    // changes types — we want to randomize rotations to avoid rotation-cost
    // shortcuts without undoing the type changes.
    function rerollRotationsOnly() {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (r === entry.row && c === entry.col) continue;
                if (r === exit.row  && c === exit.col)  continue;
                grid[r][c].rotation = Math.floor(Math.random() * 4);
            }
        }
    }

    // True iff cell (r, c) is on path `pathIdx`'s solution. Single-lane
    // tiles carry `_path`; cross tiles carry `_crossLanes` (each lane is
    // [a, b, p]).
    function cellIsOnPath(r, c, pathIdx) {
        const t = grid[r][c];
        if (t._solution === undefined) return false;
        if (t._crossLanes) {
            for (const [a, b, p] of t._crossLanes) {
                if (p === pathIdx) return true;
            }
            return false;
        }
        return t._path === pathIdx;
    }

    // Number of cells on path `pathIdx`'s solution. Used as the floor that
    // an alternate path must beat to count as a "shortcut" — anything
    // shorter is a problem.
    function pathCellCount(pathIdx) {
        let n = 0;
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (cellIsOnPath(r, c, pathIdx)) n++;
            }
        }
        return n;
    }

    // "r,c" keys of cells on some other path's solution but NOT on the
    // target path. The 2-path canonical check forbids the target path's
    // BFS from threading through these cells, so a "shortcut" is defined
    // strictly as a shorter alternate that doesn't poach from the other
    // path's territory. (Shared cross tiles where both paths use lanes
    // are NOT blocked — the target path is entitled to its share of them.)
    function blockedCellsExceptPath(targetPath) {
        const blocked = new Set();
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const t = grid[r][c];
                if (t._solution === undefined) continue;
                if (cellIsOnPath(r, c, targetPath)) continue;
                blocked.add(r + ',' + c);
            }
        }
        return blocked;
    }

    // Filler tile bias: heavily prefer elbows over straights/crosses. Elbows
    // can only carry adjacent-port lanes (NE/ES/SW/WN), which is the most
    // restrictive type — straights add opposite-port shortcuts, crosses add
    // both. Heavy elbow bias makes random configurations unlikely to admit
    // straight-through alternates around a long winding intended path,
    // which lets BFS shortest = intended length much more often.
    //
    // Boundary cells (singular mode) never roll a cross. A cross is
    // rotation-invariant, so a filler cross on the outer edge always has a
    // lane pointing off-grid — no rotation can make it part of any solution,
    // which hands the player a free "this tile is filler" tell. Solution
    // crosses can't land on the boundary either (both lanes need in-grid
    // continuations; only entry/exit cells connect off-grid, through the
    // visible notch), so with this ban the edge carries no information.
    // Quad mode is deliberately EXEMPT: quads scramble sub-tile POSITIONS,
    // so any sub-tile — solution crosses included — can legitimately sit on
    // a boundary cell mid-solve and rotate away with the quad. Banning
    // filler crosses there would invert the leak: an edge cross would then
    // prove "solution cross in a mis-rotated quad".
    function pickFillerType(r, c) {
        const noCross = !quadMode &&
            (r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1);
        const roll = Math.random();
        if (noCross) {
            // Same 65:20 elbow:straight ratio with the cross share removed.
            return roll < 0.65 / 0.85 ? T_ELBOW : T_STRAIGHT;
        }
        if (roll < 0.65) return T_ELBOW;
        if (roll < 0.85) return T_STRAIGHT;
        return T_CROSS;
    }

    // Re-roll every cell's rotation (and filler tile types) except entry/exit
    // cells, which were already rotated to expose the notch. Path tiles keep
    // their type & _solution; their rotation is randomized again so a "lucky"
    // intended-solution alignment doesn't trap us below the shortcut threshold.
    function rerollAllRotations() {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (r === entry.row && c === entry.col) continue;
                if (r === exit.row  && c === exit.col)  continue;
                const t = grid[r][c];
                if (t._solution === undefined) t.type = pickFillerType(r, c);
                t.rotation = Math.floor(Math.random() * 4);
            }
        }
    }

    // Snap a tile to a rotation where all required ports are exposed. Used
    // for entry/exit cells so the gold notch extends inward on first render.
    // No-op if the tile's type can't expose all the required ports at any
    // rotation (shouldn't happen for path tiles, but it's a safe fallback).
    function rotateToExpose(tile, requiredPorts) {
        const candidates = [];
        for (let r = 0; r < 4; r++) {
            const allPorts = new Set();
            for (const [a, b] of BASE_CONNECTIONS[tile.type]) {
                allPorts.add(rot(a, r));
                allPorts.add(rot(b, r));
            }
            if (requiredPorts.every((p) => allPorts.has(p))) candidates.push(r);
        }
        if (candidates.length > 0) {
            tile.rotation = candidates[Math.floor(Math.random() * candidates.length)];
        }
    }

    // Build a fresh puzzle into the module-level `grid`/`entry`/`exit`. Picks
    // entry/exit, runs the solution-path DFS, fills in tiles, exposes the
    // entry/exit notches. Returns false if generateLanes failed (caller
    // should try again with a different entry/exit pair).
    function pickFarPair(avoidCells) {
        // Sample several endpoint configs and return the farthest valid pair.
        // `avoidCells` (optional Set of "r,c") excludes cells that already
        // have endpoints from a previous path.
        let entrySide, exitSide, entryCell, exitCell, bestDist = -1;
        for (let i = 0; i < ENDPOINT_SAMPLES; i++) {
            const sides = shuffle([N, E, S, W]);
            const ec = randomCellOnEdge(sides[0]);
            const xc = randomCellOnEdge(sides[1]);
            if (ec.row === xc.row && ec.col === xc.col) continue;
            if (avoidCells) {
                if (avoidCells.has(ec.row + ',' + ec.col)) continue;
                if (avoidCells.has(xc.row + ',' + xc.col)) continue;
            }
            const dist = Math.abs(ec.row - xc.row) + Math.abs(ec.col - xc.col);
            if (dist > bestDist) {
                bestDist = dist;
                entrySide = sides[0];
                exitSide  = sides[1];
                entryCell = ec;
                exitCell  = xc;
            }
        }
        if (bestDist < 0) return null;
        return {
            entry: { row: entryCell.row, col: entryCell.col, port: entrySide },
            exit:  { row: exitCell.row,  col: exitCell.col,  port: exitSide }
        };
    }

    // Reject paths shorter than this. Tiny stub paths (entry → 1–2 cells →
    // exit) look degenerate and trivialize that color's puzzle.
    const MIN_PATH_CELLS = 4;

    // Count cells in `lanes` that hold at least one lane tagged with `pathIdx`.
    // For path 1 (no seed), all lane entries belong to path 1, so this equals
    // lanes.size. For paths 2+, the seed map is mixed; only count cells whose
    // lane list contains the matching pathIdx.
    function pathCellCountIn(lanes, pathIdx) {
        let n = 0;
        for (const ls of lanes.values()) {
            for (const [, , p] of ls) {
                if (p === pathIdx) { n++; break; }
            }
        }
        return n;
    }

    // True iff the cells tagged with `pathIdx` span >= 2 distinct rows AND
    // >= 2 distinct cols. Rejects degenerate single-row / single-column
    // paths that look like a straight line down one edge of the grid.
    function pathSpansRowsAndCols(lanes, pathIdx) {
        const rows = new Set();
        const cols = new Set();
        for (const [k, ls] of lanes) {
            let belongs = false;
            for (const [, , p] of ls) {
                if (p === pathIdx) { belongs = true; break; }
            }
            if (!belongs) continue;
            const comma = k.indexOf(',');
            rows.add(k.slice(0, comma));
            cols.add(k.slice(comma + 1));
            if (rows.size > 1 && cols.size > 1) return true; // early-out
        }
        return rows.size > 1 && cols.size > 1;
    }

    function buildPuzzle(pathCap) {
        const pair1 = pickFarPair();
        if (!pair1) return false;
        entry = pair1.entry;
        exit  = pair1.exit;

        // Pick the longest DFS sample that fits under the soft cap. Fully
        // long paths (e.g. 80% of grid cells) leave too few filler cells
        // for the constraint (BFS shortest >= intended) to be satisfiable —
        // even smart rerolls can't fix shortcuts that route THROUGH path
        // tiles using rotations the player chooses freely.
        // In multi-path mode, scale path 1's cap down so additional paths
        // have free cells to navigate through. With pathCount=3 on a 12×12,
        // path 1 takes ~30 cells instead of ~70, leaving room for two more.
        const path1Cap = pathCount > 1
            ? Math.max(minPathLength(), Math.floor(pathCap / pathCount))
            : pathCap;
        let cellLanes = null;
        for (let i = 0; i < MAX_PATH_GEN_TRIES; i++) {
            const lanes = generateLanes();
            if (!lanes) continue;
            if (lanes.size < MIN_PATH_CELLS) continue;
            if (!pathSpansRowsAndCols(lanes, 0)) continue;
            if (!cellLanes) { cellLanes = lanes; continue; }
            const curOver = cellLanes.size > path1Cap;
            const newOver = lanes.size > path1Cap;
            if (curOver && newOver) {
                if (lanes.size < cellLanes.size) cellLanes = lanes; // both over: prefer closer to cap
            } else if (curOver && !newOver) {
                cellLanes = lanes;                                   // new fits, current overshoots
            } else if (!curOver && !newOver) {
                if (lanes.size > cellLanes.size) cellLanes = lanes; // both fit: prefer longer
            }
            // else: !curOver && newOver — keep the one that fits
        }
        if (!cellLanes) return false;

        // Multi-path mode: generate additional paths that share the grid
        // with path 1 via cross tiles. Each new path's DFS is seeded with
        // the running lane map; canAddLane only allows revisits when an
        // existing lane is straight and the new one is perpendicular,
        // naturally producing crosses at intersections (max 2 lanes per
        // cell, so a 3rd path can't pass through cells already crossed).
        entry2 = null; exit2 = null;
        entry3 = null; exit3 = null;
        entry4 = null; exit4 = null;

        function tryAddPath(pair, pathIdx) {
            const savedEntry = entry, savedExit = exit;
            entry = pair.entry;
            exit  = pair.exit;
            let result = null;
            for (let i = 0; i < MAX_PATH_GEN_TRIES; i++) {
                const seedCopy = new Map();
                for (const [k, v] of cellLanes) seedCopy.set(k, v.map((l) => l.slice()));
                const r = generateLanes(seedCopy, pathIdx);
                if (r && pathCellCountIn(r, pathIdx) >= MIN_PATH_CELLS && pathSpansRowsAndCols(r, pathIdx)) {
                    result = r; break;
                }
            }
            entry = savedEntry;
            exit  = savedExit;
            return result;
        }

        // Path 2 and 3 are dropped silently if they can't fit (small or
        // densely-pathed grids). We still produce a valid puzzle with as
        // many paths as we managed to place; init's outer loop will retry
        // to try to get the full pathCount, but accepts the best it found.
        //
        // 4-path mode uses backtracking instead of the linear placement
        // below — greedy DFS for paths 2/3 often picks routes that box
        // path 4 out of the grid. Backtracking undoes a path and tries a
        // different (pair, route) when a deeper level fails.
        if (pathCount === 4) {
            const initialUsed = new Set();
            initialUsed.add(pair1.entry.row + ',' + pair1.entry.col);
            initialUsed.add(pair1.exit.row  + ',' + pair1.exit.col);

            const MAX_BT_PAIRS  = 4;     // endpoint configs to try per level
            const MAX_BT_ROUTES = 6;     // DFS routes to try per pair
            const budget = { steps: 200 }; // total generateLanes calls cap
            const best = {
                depth: 1, lanes: cellLanes,
                e2: null, x2: null, e3: null, x3: null, e4: null, x4: null
            };
            function snap(depth, lanes) {
                if (depth > best.depth) {
                    best.depth = depth; best.lanes = lanes;
                    best.e2 = entry2; best.x2 = exit2;
                    best.e3 = entry3; best.x3 = exit3;
                    best.e4 = entry4; best.x4 = exit4;
                }
            }
            // pathIdx is the lane-tag index for the path being placed:
            // entry2 ↔ pathIdx 1, entry3 ↔ pathIdx 2, entry4 ↔ pathIdx 3.
            // On entry, paths 0..pathIdx-1 are already in currentLanes.
            function place(currentLanes, pathIdx, used) {
                snap(pathIdx, currentLanes);
                if (pathIdx >= pathCount) return currentLanes;
                for (let pa = 0; pa < MAX_BT_PAIRS; pa++) {
                    if (budget.steps <= 0) return null;
                    const pair = pickFarPair(used);
                    if (!pair) continue;
                    for (let ra = 0; ra < MAX_BT_ROUTES; ra++) {
                        if (budget.steps <= 0) return null;
                        budget.steps--;
                        const seed = new Map();
                        for (const [k, v] of currentLanes) seed.set(k, v.map((l) => l.slice()));
                        const sE = entry, sX = exit;
                        entry = pair.entry; exit = pair.exit;
                        const r = generateLanes(seed, pathIdx);
                        entry = sE; exit = sX;
                        if (!r) continue;
                        if (pathCellCountIn(r, pathIdx) < MIN_PATH_CELLS) continue;
                        if (!pathSpansRowsAndCols(r, pathIdx)) continue;
                        const oldE2 = entry2, oldX2 = exit2;
                        const oldE3 = entry3, oldX3 = exit3;
                        const oldE4 = entry4, oldX4 = exit4;
                        if (pathIdx === 1) { entry2 = pair.entry; exit2 = pair.exit; }
                        else if (pathIdx === 2) { entry3 = pair.entry; exit3 = pair.exit; }
                        else { entry4 = pair.entry; exit4 = pair.exit; }
                        const nu = new Set(used);
                        nu.add(pair.entry.row + ',' + pair.entry.col);
                        nu.add(pair.exit.row  + ',' + pair.exit.col);
                        const final = place(r, pathIdx + 1, nu);
                        if (final) return final;
                        entry2 = oldE2; exit2 = oldX2;
                        entry3 = oldE3; exit3 = oldX3;
                        entry4 = oldE4; exit4 = oldX4;
                    }
                }
                return null;
            }
            const result = place(cellLanes, 1, initialUsed);
            if (result) {
                cellLanes = result;
            } else {
                // Recursion exhausted budget without placing all 4 — fall back
                // to the deepest partial configuration the search saw.
                cellLanes = best.lanes;
                entry2 = best.e2; exit2 = best.x2;
                entry3 = best.e3; exit3 = best.x3;
                entry4 = best.e4; exit4 = best.x4;
            }
        } else {
            if (pathCount >= 2) {
                const used = new Set();
                used.add(pair1.entry.row + ',' + pair1.entry.col);
                used.add(pair1.exit.row  + ',' + pair1.exit.col);
                const pair2 = pickFarPair(used);
                if (pair2) {
                    const r2 = tryAddPath(pair2, 1);
                    if (r2) {
                        cellLanes = r2;
                        entry2 = pair2.entry;
                        exit2  = pair2.exit;
                    }
                }
            }
            if (pathCount >= 3 && entry2) {
                const used = new Set();
                used.add(pair1.entry.row + ',' + pair1.entry.col);
                used.add(pair1.exit.row  + ',' + pair1.exit.col);
                used.add(entry2.row + ',' + entry2.col);
                used.add(exit2.row  + ',' + exit2.col);
                const pair3 = pickFarPair(used);
                if (pair3) {
                    const r3 = tryAddPath(pair3, 2);
                    if (r3) {
                        cellLanes = r3;
                        entry3 = pair3.entry;
                        exit3  = pair3.exit;
                    }
                }
            }
        }

        grid = Array.from({ length: ROWS }, () =>
            Array.from({ length: COLS }, () => null));
        const isOpp = (a, b) => ((a + 2) & 3) === b;

        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const ls = cellLanes.get(r + ',' + c);
                if (!ls || ls.length === 0) {
                    grid[r][c] = {
                        type: pickFillerType(r, c),
                        rotation: Math.floor(Math.random() * 4)
                    };
                } else if (ls.length === 1) {
                    const [a, b, p] = ls[0];
                    const type = isOpp(a, b) ? T_STRAIGHT : T_ELBOW;
                    grid[r][c] = {
                        type,
                        rotation: Math.floor(Math.random() * 4),
                        _solution: findRotation(type, a, b),
                        _path: p
                    };
                } else {
                    // Cross — both lanes from (potentially different) paths.
                    // _crossLanes preserves [enter, exit, path] so the
                    // renderer can color each lane independently when the
                    // tile is hint-locked.
                    grid[r][c] = {
                        type: T_CROSS,
                        rotation: Math.floor(Math.random() * 4),
                        _solution: 0,
                        _crossLanes: ls.map((l) => l.slice())
                    };
                }
            }
        }

        if (entry.row === exit.row && entry.col === exit.col) {
            rotateToExpose(grid[entry.row][entry.col], [entry.port, exit.port]);
        } else {
            rotateToExpose(grid[entry.row][entry.col], [entry.port]);
            rotateToExpose(grid[exit.row][exit.col],   [exit.port]);
        }
        if (entry2 && exit2) {
            rotateToExpose(grid[entry2.row][entry2.col], [entry2.port]);
            rotateToExpose(grid[exit2.row][exit2.col],   [exit2.port]);
        }
        if (entry3 && exit3) {
            rotateToExpose(grid[entry3.row][entry3.col], [entry3.port]);
            rotateToExpose(grid[exit3.row][exit3.col],   [exit3.port]);
        }
        if (entry4 && exit4) {
            rotateToExpose(grid[entry4.row][entry4.col], [entry4.port]);
            rotateToExpose(grid[exit4.row][exit4.col],   [exit4.port]);
        }
        return true;
    }

    // Snapshot the puzzle state (rows/cols + grid + entry/exit) so we can
    // restore it later. Tile objects are shallow-copied — that's enough
    // because tiles only hold primitive fields (type, rotation, _solution,
    // _twin). The structure is structured-clone-safe so it can be passed
    // between worker and main thread via postMessage.
    function snapshotState() {
        return {
            rows:   ROWS,
            cols:   COLS,
            grid:   grid.map((row) => row.map((t) => Object.assign({}, t))),
            entry:  Object.assign({}, entry),
            exit:   Object.assign({}, exit),
            entry2: entry2 ? Object.assign({}, entry2) : null,
            exit2:  exit2  ? Object.assign({}, exit2)  : null,
            entry3: entry3 ? Object.assign({}, entry3) : null,
            exit3:  exit3  ? Object.assign({}, exit3)  : null,
            entry4: entry4 ? Object.assign({}, entry4) : null,
            exit4:  exit4  ? Object.assign({}, exit4)  : null,
            // quadScramble carries the per-quad rotation offsets used by
            // hint() to find non-solved quads. Null when not in quad mode.
            quadScramble: quadScramble ? quadScramble.map((row) => row.slice()) : null,
            // Set of "r,c" keys for hint-locked tiles, serialized as an
            // array (Sets don't survive JSON / structured-clone of plain
            // objects). PotD's background-gen save/restore relies on this
            // to preserve the player's hint state across the dance.
            locked: Array.from(locked)
        };
    }
    function restoreState(s) {
        grid   = s.grid;
        entry  = s.entry;
        exit   = s.exit;
        entry2 = s.entry2 || null;
        exit2  = s.exit2  || null;
        entry3 = s.entry3 || null;
        exit3  = s.exit3  || null;
        entry4 = s.entry4 || null;
        exit4  = s.exit4  || null;
    }

    // Public version of restoreState: also resets locked + recomputes
    // highlighted/won from the loaded grid. Used to import a snapshot
    // produced by the pre-generation worker (separate Maze instance) into
    // the main-thread Maze. ROWS/COLS are updated so cellAt/iteration
    // functions stay consistent with the loaded grid's dimensions.
    function loadSnapshot(s) {
        ROWS = s.rows;
        COLS = s.cols;
        grid = s.grid;
        entry  = s.entry;
        exit   = s.exit;
        entry2 = s.entry2 || null;
        exit2  = s.exit2  || null;
        entry3 = s.entry3 || null;
        exit3  = s.exit3  || null;
        entry4 = s.entry4 || null;
        exit4  = s.exit4  || null;
        quadScramble = s.quadScramble ? s.quadScramble.map((row) => row.slice()) : null;
        // Restore the hint-lock set if the snapshot carried one (PotD's
        // mid-play save/restore needs this). Older snapshots without the
        // `locked` field — e.g. recordings predating this addition, or
        // fresh worker output — fall back to an empty set, matching the
        // previous behavior.
        locked = new Set(s.locked || []);
        updateHighlighted();
    }

    // Reset to a "no puzzle loaded" state. Used by the title-O renderer to
    // wipe the synthetic 2×2 snapshot it loaded for inline rendering — so
    // a subsequent Render.draw before the next real puzzle finishes building
    // doesn't paint the snippet onto the main canvas.
    function clear() {
        grid   = null;
        entry  = null; exit  = null;
        entry2 = null; exit2 = null;
        entry3 = null; exit3 = null;
        entry4 = null; exit4 = null;
        highlighted = [];
        locked = new Set();
        won = false;
        pathsWon = [false, false, false, false];
        quadScramble = null;
        // Keep ROWS, COLS, pathCount, quadMode at their current values — those
        // are configuration, not puzzle state.
    }

    // Yields back to the browser event loop so heavy generation doesn't
    // freeze the UI. Inserted between attempts in init() — large grids
    // can take several seconds to satisfy the no-shortcut constraint, and
    // without these yields Chromium pops a "page unresponsive" dialog.
    function yieldToBrowser() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Hurry flag: set externally (typically by the worker via a 'hurry'
    // postMessage when the player has finished the current puzzle and is
    // waiting on this build). init() checks this flag at attempt
    // boundaries and bails with the best canonical snapshot it has so
    // far — or the current attempt's grid if none was canonical yet —
    // trading a strictly shortcut-free puzzle for instant playback.
    let hurryFlag = false;
    function setHurry() { hurryFlag = true; }

    // Abort flag: set externally when an in-flight build is no longer
    // needed (the worker received an urgent request for a different
    // puzzle, so the current one should be discarded). init() checks
    // this flag at the same attempt boundaries as hurry; when set, it
    // returns false to signal "this result is garbage, do not snapshot".
    // The state is left in whatever partial form the abort caught — the
    // next init() call resets it before building.
    let abortFlag = false;
    function setAbort() { abortFlag = true; }

    async function init() {
        // Strategy:
        // 1. Outer pathCap loop — start with paths up to 50% of grid cells
        //    (long and winding), shrink toward minPathLength() if smart
        //    rerolls can't make the intended path canonical at the current
        //    cap. Each cap level gets MAX_INIT_ATTEMPTS entry/exit pairs.
        // 2. Per attempt — random rerolls (types + rotations), then smart
        //    rerolls (target shortcut tiles, change filler types to break).
        // 3. Track the LONGEST canonical state seen across all attempts &
        //    caps; restore at the end so we ship the longest shortcut-free
        //    puzzle the search found.
        // 4. Honor hurryFlag at attempt boundaries — if the player is
        //    waiting, ship best canonical (or current attempt's grid if
        //    none yet) immediately rather than continuing the search.
        //
        // The pathCap shrink is the safety net: if even smart rerolls can't
        // make a 30-cell path canonical (because BFS routes through path
        // tiles using free rotation), we accept a shorter path. The user
        // wants long; we get as long as the constraint allows.
        hurryFlag = false;
        abortFlag = false;
        let bestState  = null;
        let bestLength = 0;

        const baseFloor = minPathLength();
        const startCap  = Math.max(baseFloor, Math.round(ROWS * COLS * 0.5));

        // Quad mode: sub-tile rotations are coupled (4 sub-tiles per quad
        // rotate together), so the canonical-uniqueness check — which
        // assumes independent per-tile rotation — is over-conservative
        // and would reject puzzles that are actually unique under quad
        // rotation. Skip canonical and twins; retry to find the requested
        // path count, keeping the best (most-paths) snapshot. Mirrors the
        // multi-path branch so a 2- or 3-path quad puzzle isn't silently
        // dropped to 1 path on the first lucky-but-incomplete build.
        if (quadMode) {
            let bestSnapshot = null;
            let bestCount = 0;
            const target = pathCount;
            // STRICT MODE: the player's selected path count is a hard
            // contract — selecting q4 must produce a 4-path puzzle, never
            // q3 silently. Loop indefinitely at the current dims until
            // target is met (or abortFlag fires on quit). Without this,
            // the worker used to ship bestSnapshot regardless and the
            // game accepted it because the worker's response reports the
            // REQUESTED pathCount, not the actual one. q4 starts at 4×4
            // logical (8×8 physical, same floor as every quad count since
            // 2026-07-16) — the backtracking place() converges fine there;
            // the strict loop is the safety net.
            // hurryFlag is intentionally NOT a bail trigger here — letting
            // a hurried player accept fewer paths violates the contract.
            const ATTEMPTS_PER_PASS = pathCount === 4 ? 10000 : (pathCount === 3 ? 400 : (pathCount === 2 ? 20 : 8));
            while (bestCount < target) {
                for (let attempt = 0; attempt < ATTEMPTS_PER_PASS; attempt++) {
                    await yieldToBrowser();
                    if (abortFlag) return false;
                    if (!buildPuzzle(startCap)) continue;
                    const got = entry4 ? 4 : (entry3 ? 3 : (entry2 ? 2 : 1));
                    if (got > bestCount) {
                        bestCount = got;
                        bestSnapshot = snapshotState();
                    }
                    if (got >= target) break;
                }
            }
            if (bestSnapshot) restoreState(bestSnapshot);
            locked = new Set();
            assignQuadTwins();   // assign before scramble so the scramble can keep twins in lockstep
            scrambleQuads();
            updateHighlighted();
            breakPreWonPaths();
            return true;
        }

        // 2-path mode: extra paths constrain the grid heavily, but with
        // sparse fillers a shorter alternate for one path is still possible
        // — and the player solving via that alternate might leave the other
        // path unsolvable, or find a strictly easier solve. Run the
        // canonical check per-path, blocking each path's check from
        // traversing cells that belong exclusively to the other path. If
        // smartReroll can break the BFS shortcut on one path, do it; pause
        // for canonical-uniqueness on both before accepting.
        // 3-path is left at "first valid build wins" — adding canonical on
        // top would compound an already-tight retry budget.
        if (pathCount === 2) {
            let bestCanonical = null;        // best canonical 2-path snapshot
            let bestFallback = null;         // best non-canonical 2-path fallback
            let bestFallbackCount = 0;
            // STRICT MODE: the player asked for 2 paths; never ship a
            // 1-path snapshot. Wrap the canonical-search loop in a
            // while-true that keeps retrying until we have AT LEAST a
            // non-canonical 2-path build (bestFallback). The inner
            // 24-attempt budget is enough for the canonical search to
            // succeed in the typical case; the outer loop is the safety
            // net for the rare "no 2-path build placed in 24 attempts"
            // case that previously fell through and shipped 1 path.
            // hurryFlag may bail with bestFallback (≥2 paths guaranteed
            // by the outer condition) — that's fine, it's still 2 paths.
            const ATTEMPTS_PER_PASS = 24;
          retry2path:
            while (true) {
            for (let attempt = 0; attempt < ATTEMPTS_PER_PASS; attempt++) {
                await yieldToBrowser();
                if (abortFlag) return false;
                if (hurryFlag && (bestCanonical || (bestFallback && bestFallbackCount >= 2))) break retry2path;
                if (!buildPuzzle(startCap)) continue;
                const got = entry2 ? 2 : 1;
                // Track best fallback regardless of canonical-ness.
                if (got > bestFallbackCount) {
                    bestFallbackCount = got;
                    bestFallback = snapshotState();
                }
                if (got < 2) continue; // need both paths to even check canonical

                // Per-path canonical: shortest alt path (when other path's
                // exclusive cells are blocked) must be at least as long as
                // the intended path. smartReroll modifies fillers to break
                // BFS shortcuts; rotation-only rerolls in between handle
                // rotation-cost shortcuts without undoing type changes.
                const len0 = pathCellCount(0);
                const len1 = pathCellCount(1);
                const blk0 = blockedCellsExceptPath(0);
                const blk1 = blockedCellsExceptPath(1);
                const savedEntry = entry, savedExit = exit;

                function isCanon(eRef, xRef, len, blk) {
                    entry = eRef; exit = xRef;
                    const ok = !hasShortcutWithin(minShortcutTwists(), blk) &&
                               shortestPossiblePathLength(blk) >= len;
                    entry = savedEntry; exit = savedExit;
                    return ok;
                }
                function bothCanon() {
                    return isCanon(savedEntry, savedExit, len0, blk0) &&
                           isCanon(entry2, exit2, len1, blk1);
                }
                function rerollFor(eRef, xRef, len, blk) {
                    entry = eRef; exit = xRef;
                    const ok = smartReroll(len, blk);
                    entry = savedEntry; exit = savedExit;
                    return ok;
                }

                let smart = 0;
                while (smart < 6 && !bothCanon()) {
                    let progress = false;
                    if (!isCanon(savedEntry, savedExit, len0, blk0)) {
                        progress = rerollFor(savedEntry, savedExit, len0, blk0) || progress;
                    }
                    if (!isCanon(entry2, exit2, len1, blk1)) {
                        progress = rerollFor(entry2, exit2, len1, blk1) || progress;
                    }
                    if (!progress) break;
                    let rotR = 0;
                    while (rotR < 8 && !bothCanon()) {
                        rerollRotationsOnly();
                        rotR++;
                    }
                    smart++;
                }

                if (bothCanon()) {
                    bestCanonical = snapshotState();
                    break retry2path;
                }
            }
            // Inner pass done. Exit the outer retry only when we have
            // either a canonical 2-path OR at minimum a non-canonical
            // 2-path. If bestFallback is still 1-path (no successful
            // 2-path build at all in this pass), do another pass.
            if (bestCanonical) break;
            if (bestFallback && bestFallbackCount >= 2) break;
            }   // end while(true) retry2path

            if (bestCanonical)      restoreState(bestCanonical);
            else if (bestFallback)  restoreState(bestFallback);
            locked = new Set();
            assignTwins();
            updateHighlighted();
            breakPreWonPaths();
            return true;
        }

        // 3+ paths: tight retry budget, no canonical check. buildPuzzle drops
        // failed extra paths silently; we retry many times to find a build
        // with the full pathCount.
        // 4-path is dramatically harder to fit (8 distinct edge endpoints +
        // 4 DFS paths competing for the same grid), so it gets a much bigger
        // retry budget per pass. buildPuzzle's backtracking placement makes
        // even small grids (5×5 starts, 4×4 in Debug) converge — typically
        // instantly, worst case a few seconds of failed attempts, never a
        // hang, since 8 endpoints only need 8 distinct perimeter cells and
        // each path just needs MIN_PATH_CELLS spanning 2 rows/cols.
        if (pathCount >= 3) {
            let bestSnapshot = null;
            let bestCount = 0;
            const target = pathCount;
            // STRICT MODE: never accept a snapshot with fewer paths than
            // the player selected. Loop indefinitely until target met
            // (or abortFlag fires on quit). Previously this branch
            // shipped bestSnapshot regardless of bestCount — a 4-path
            // request that exhausted maxAttempts at, say, 3 paths would
            // silently ship the 3-path build, and the worker response
            // reported pathCount=4 (the request) so the game couldn't
            // tell. hurryFlag is intentionally NOT a bail trigger here —
            // letting a hurried player accept fewer paths violates the
            // selected-count contract.
            const ATTEMPTS_PER_PASS = pathCount === 4 ? 10000 : 400;
            while (bestCount < target) {
                for (let attempt = 0; attempt < ATTEMPTS_PER_PASS; attempt++) {
                    await yieldToBrowser();
                    if (abortFlag) return false;
                    if (!buildPuzzle(startCap)) continue;
                    const got = entry4 ? 4 : (entry3 ? 3 : (entry2 ? 2 : 1));
                    if (got > bestCount) {
                        bestCount = got;
                        bestSnapshot = snapshotState();
                    }
                    if (got >= target) break;
                }
            }
            if (bestSnapshot) restoreState(bestSnapshot);
            locked = new Set();
            assignTwins();
            updateHighlighted();
            breakPreWonPaths();
            return true;
        }

        outer: for (let pathCap = startCap; pathCap >= baseFloor; pathCap = Math.max(baseFloor, pathCap - 4)) {
            for (let attempt = 0; attempt < MAX_INIT_ATTEMPTS; attempt++) {
                await yieldToBrowser();
                if (abortFlag) return false;
                // After at least one successful build, a hurry signal means
                // the player is waiting — bail with best-so-far.
                if (hurryFlag && grid !== null) break outer;
                if (!buildPuzzle(pathCap)) continue;

                let pathLength = 0;
                for (let r = 0; r < ROWS; r++) {
                    for (let c = 0; c < COLS; c++) {
                        if (grid[r][c]._solution !== undefined) pathLength++;
                    }
                }
                if (pathLength < baseFloor && attempt < MAX_INIT_ATTEMPTS - 1) continue;

                // A puzzle is acceptable when both:
                //   (a) no path exists with rotation cost < minShortcutTwists()
                //   (b) no shorter alternate path exists — the shortest possible
                //       entry→exit path is at least as long as the intended one.
                const isHardEnough = () =>
                    !hasShortcutWithin(minShortcutTwists()) &&
                    shortestPossiblePathLength() >= pathLength;

                // Phase 1: random rerolls (types + rotations).
                let rerolls = 0;
                while (rerolls < MAX_REROLL_ATTEMPTS && !isHardEnough()) {
                    rerollAllRotations();
                    rerolls++;
                }

                // Phase 2: smartReroll breaks BFS shortcuts by changing
                // filler tile types on the shortest path. Rotation-only
                // rerolls in between handle rotation-cost shortcuts without
                // undoing the type changes.
                for (let smart = 0; smart < 6 && !isHardEnough(); smart++) {
                    if (!smartReroll(pathLength)) break;
                    let rotRerolls = 0;
                    while (rotRerolls < 8 && !isHardEnough()) {
                        rerollRotationsOnly();
                        rotRerolls++;
                    }
                }

                if (isHardEnough() && pathLength > bestLength) {
                    bestLength = pathLength;
                    bestState  = snapshotState();
                }
            }
            if (bestState) break; // got something canonical at this cap level
            if (pathCap === baseFloor) break;
        }

        if (bestState) restoreState(bestState);
        // else: keep the last attempted (non-canonical) state. Very rare.

        locked = new Set();  // wipe locks from any previous puzzle
        assignTwins();
        updateHighlighted();
        breakPreWonPaths();
        return true;
    }

    // Walk port-to-port through tiles, collecting (cell, inPort, outPort) tuples.
    // Returns { result, exitedAt } — exitedAt is the {row, col, port} of the cell
    // and port through which the walk left the grid (or null if it dead-ended inside).
    function walkFrom(startRow, startCol, startPort) {
        const result = [];
        let cell = { row: startRow, col: startCol };
        let port = startPort; // the port we entered this cell through
        const seen = new Set();

        while (true) {
            const seenKey = cell.row + ',' + cell.col + ',' + port;
            if (seen.has(seenKey)) break; // safety against cycles through cross tiles
            seen.add(seenKey);

            const tile = grid[cell.row][cell.col];
            const exitPort = getExitPort(tile, port);
            if (exitPort === null) break; // dead end inside this tile

            result.push({ row: cell.row, col: cell.col, inPort: port, outPort: exitPort });

            const next = neighborInDirection(cell, exitPort);
            if (next === null) {
                return { result, exitedAt: { row: cell.row, col: cell.col, port: exitPort } };
            }

            // Gate-blocked edge: the path tried to exit `cell` via exitPort
            // but a gate's prong currently sits on the cell↔next boundary.
            // Treat as a dead-end. The Gates guard keeps the worker context
            // (which doesn't load gates.js) walking unblocked.
            if (typeof Gates !== 'undefined'
                && Gates.edgeBlocked
                && Gates.edgeBlocked(cell.row, cell.col, next.row, next.col)) {
                return { result, exitedAt: null };
            }

            cell = next;
            port = (exitPort + 2) & 3;
        }

        return { result, exitedAt: null };
    }

    // Canonical "r1,c1|r2,c2" with the lexicographically-smaller cell first
    // — matches Gates' internal key format so gate.edgeBlocked lookups match
    // what solutionEdges produces here.
    function canonicalEdgeKey(r1, c1, r2, c2) {
        if (r1 < r2 || (r1 === r2 && c1 < c2)) {
            return r1 + ',' + c1 + '|' + r2 + ',' + c2;
        }
        return r2 + ',' + c2 + '|' + r1 + ',' + c1;
    }

    // Walk every solution path and return the Set of canonical edge keys it
    // traverses. Used by Gates.assignGates to find safe gate placements.
    //
    // Non-quad: each tile is at a fixed position; `_solution` is its solved
    // rotation. Walk grid[r][c] using `_solution` and we get the solved path.
    //
    // Quad mode: BOTH positions AND rotations of sub-tiles are scrambled by
    // quad rotations. The sub-tile currently at (r, c) might be a different
    // sub-tile than the one that belongs at (r, c) when solved. So walking
    // with `_solution` at scrambled positions does NOT yield the solved path.
    // Temporarily un-scramble (apply inverse quad rotations) so each sub-tile
    // is back at its original position with rotation = _solution, walk, then
    // restore via snapshotState/restoreState. quadScramble is saved separately
    // because restoreState doesn't currently round-trip it.
    function solutionEdges() {
        if (!quadMode || !quadScramble) return walkSolutionEdges();
        const snap = snapshotState();
        const savedQuadScramble = quadScramble.map((row) => row.slice());
        try {
            for (let qr = 0; qr < quadScramble.length; qr++) {
                for (let qc = 0; qc < quadScramble[qr].length; qc++) {
                    const turns = quadScramble[qr][qc];
                    for (let i = 0; i < turns; i++) rotateQuad(qr * 2, qc * 2, true);
                    quadScramble[qr][qc] = 0;
                }
            }
            return walkSolutionEdges();
        } finally {
            restoreState(snap);
            quadScramble = savedQuadScramble;
        }
    }

    function walkSolutionEdges() {
        const edges = new Set();
        const pairs = [[entry, exit], [entry2, exit2], [entry3, exit3], [entry4, exit4]];
        const maxSteps = ROWS * COLS * 4;
        for (const [eStart, eEnd] of pairs) {
            if (!eStart || !eEnd) continue;
            let r = eStart.row, c = eStart.col;
            let inPort = eStart.port;
            for (let step = 0; step < maxSteps; step++) {
                if (!inBounds(r, c)) break;
                const tile = grid[r][c];
                if (!tile || tile._solution === undefined) break;
                let outPort = -1;
                for (const pair of BASE_CONNECTIONS[tile.type]) {
                    const ra = rot(pair[0], tile._solution);
                    const rb = rot(pair[1], tile._solution);
                    if (ra === inPort) { outPort = rb; break; }
                    if (rb === inPort) { outPort = ra; break; }
                }
                if (outPort < 0) break;
                const nr = r + DELTA[outPort].dr;
                const nc = c + DELTA[outPort].dc;
                if (!inBounds(nr, nc)) break;
                edges.add(canonicalEdgeKey(r, c, nr, nc));
                r = nr; c = nc;
                inPort = (outPort + 2) & 3;
            }
        }
        return edges;
    }

    // Like solutionEdges, but returns an array of ORDERED CELL LISTS — one
    // per active entry/exit pair — tracing the solved path from entry
    // inward. Used by hint() to walk a path and find the first cell whose
    // tile (or quad, in quad mode) isn't yet at a port-equivalent rotation
    // to the solution. Same quad-mode un-scramble dance as solutionEdges
    // so the walk follows the SOLVED grid even when the player has the
    // quads scrambled; state is restored before returning.
    function solutionPaths() {
        if (!quadMode || !quadScramble) return walkAllSolutionPaths();
        const snap = snapshotState();
        const savedQuadScramble = quadScramble.map((row) => row.slice());
        try {
            for (let qr = 0; qr < quadScramble.length; qr++) {
                for (let qc = 0; qc < quadScramble[qr].length; qc++) {
                    const turns = quadScramble[qr][qc];
                    for (let i = 0; i < turns; i++) rotateQuad(qr * 2, qc * 2, true);
                    quadScramble[qr][qc] = 0;
                }
            }
            return walkAllSolutionPaths();
        } finally {
            restoreState(snap);
            quadScramble = savedQuadScramble;
        }
    }

    function walkAllSolutionPaths() {
        const pairs = [[entry, exit], [entry2, exit2], [entry3, exit3], [entry4, exit4]];
        const paths = [];
        const maxSteps = ROWS * COLS * 4;
        for (const [eStart, eEnd] of pairs) {
            if (!eStart || !eEnd) continue;
            const cells = [];
            let r = eStart.row, c = eStart.col;
            let inPort = eStart.port;
            for (let step = 0; step < maxSteps; step++) {
                if (!inBounds(r, c)) break;
                const tile = grid[r][c];
                if (!tile || tile._solution === undefined) break;
                cells.push({ r, c });
                let outPort = -1;
                for (const pair of BASE_CONNECTIONS[tile.type]) {
                    const ra = rot(pair[0], tile._solution);
                    const rb = rot(pair[1], tile._solution);
                    if (ra === inPort) { outPort = rb; break; }
                    if (rb === inPort) { outPort = ra; break; }
                }
                if (outPort < 0) break;
                const nr = r + DELTA[outPort].dr;
                const nc = c + DELTA[outPort].dc;
                if (!inBounds(nr, nc)) break;
                r = nr; c = nc;
                inPort = (outPort + 2) & 3;
            }
            paths.push(cells);
        }
        return paths;
    }

    // Build a map of, for EACH quad, the set of COLORED external-port
    // connections that solution paths use to cross it.
    //   key   = "qr,qc"
    //   value = Set of encoded (pathIdx*64 + lo*8 + hi), lo<hi being two
    //           of the quad's 8 external port indices (CW from TL.N — see
    //           the external-port doc on quadConnectionsInvariantUnderRotation).
    //
    // This is the GROUND TRUTH for "how do the solution paths thread this
    // quad." Decoy filler pipes and unused cross-lanes never appear here
    // because we only follow the solved entry→exit chains — fixing the
    // long-standing wasted-hint bug where a quad rotated 90°/180° but the
    // lit path's entry/exit ports were unchanged (the rotation only moved
    // a non-path decoy pipe). Path color (pathIdx) is tracked so a rotation
    // that SWAPS two differently-colored paths through the same ports is
    // NOT treated as invariant — that still advances the solution and must
    // stay hintable.
    //
    // Walks the SOLVED grid: in quad mode the live grid is scrambled, so we
    // apply inverse quad rotations first (each sub-tile back to its solved
    // position + rotation), walk, then restore — the same dance solutionPaths
    // uses. quadScramble is saved/restored separately (restoreState doesn't
    // round-trip it).
    function quadSolutionConnections() {
        // (dr,dc,dir) of a sub-tile face that points OUT of its quad → ext index.
        const EXT_INDEX = {};
        EXT_INDEX['0,0,' + N] = 0; EXT_INDEX['0,1,' + N] = 1;
        EXT_INDEX['0,1,' + E] = 2; EXT_INDEX['1,1,' + E] = 3;
        EXT_INDEX['1,1,' + S] = 4; EXT_INDEX['1,0,' + S] = 5;
        EXT_INDEX['1,0,' + W] = 6; EXT_INDEX['0,0,' + W] = 7;

        const map = new Map();
        function record(qr, qc, pi, a, b) {
            const key = qr + ',' + qc;
            let set = map.get(key);
            if (!set) { set = new Set(); map.set(key, set); }
            const lo = Math.min(a, b), hi = Math.max(a, b);
            set.add(pi * 64 + lo * 8 + hi);
        }

        const dance = quadMode && quadScramble;
        let snap = null, savedQuadScramble = null;
        if (dance) {
            snap = snapshotState();
            savedQuadScramble = quadScramble.map((row) => row.slice());
            for (let qr = 0; qr < quadScramble.length; qr++) {
                for (let qc = 0; qc < quadScramble[qr].length; qc++) {
                    const turns = quadScramble[qr][qc];
                    for (let i = 0; i < turns; i++) rotateQuad(qr * 2, qc * 2, true);
                    quadScramble[qr][qc] = 0;
                }
            }
        }
        try {
            const pairs = [[entry, exit], [entry2, exit2], [entry3, exit3], [entry4, exit4]];
            const maxSteps = ROWS * COLS * 4;
            let pi = -1;
            for (const [eStart, eEnd] of pairs) {
                if (!eStart || !eEnd) continue;
                pi++;
                let r = eStart.row, c = eStart.col;
                let inPort = eStart.port;
                // Open "run" = the quad we're currently traversing and the
                // external port we entered it through. Closed (recorded) the
                // moment the path leaves the quad through another external port.
                let runQuad = null, runEntryExt = -1;
                for (let step = 0; step < maxSteps; step++) {
                    if (!inBounds(r, c)) break;
                    const tile = grid[r][c];
                    if (!tile || tile._solution === undefined) break;
                    let outPort = -1;
                    for (const pair of BASE_CONNECTIONS[tile.type]) {
                        const ra = rot(pair[0], tile._solution);
                        const rb = rot(pair[1], tile._solution);
                        if (ra === inPort) { outPort = rb; break; }
                        if (rb === inPort) { outPort = ra; break; }
                    }
                    if (outPort < 0) break;
                    const qr = r >> 1, qc = c >> 1, dr = r & 1, dc = c & 1;
                    const inExt  = EXT_INDEX[dr + ',' + dc + ',' + inPort];
                    const outExt = EXT_INDEX[dr + ',' + dc + ',' + outPort];
                    // Entered the quad from outside (or the grid edge at the
                    // path's start): start a run at this external port.
                    if (inExt !== undefined) { runQuad = qr + ',' + qc; runEntryExt = inExt; }
                    // Leaving the quad through an external port: close the run.
                    if (outExt !== undefined && runQuad === (qr + ',' + qc) && runEntryExt >= 0) {
                        record(qr, qc, pi, runEntryExt, outExt);
                        runQuad = null; runEntryExt = -1;
                    }
                    const nr = r + DELTA[outPort].dr;
                    const nc = c + DELTA[outPort].dc;
                    if (!inBounds(nr, nc)) break;
                    r = nr; c = nc;
                    inPort = (outPort + 2) & 3;
                }
            }
        } finally {
            if (dance) { restoreState(snap); quadScramble = savedQuadScramble; }
        }
        return map;
    }

    // Highlights = union of (forward-walk-from-entry) and (backward-walk-from-exit),
    // tagged with `path` (0 or 1) so the renderer can color each path independently.
    // Two-path mode: each path can turn gold (won) on its own. `won` is the AND;
    // `pathsWon[i]` carries each path's individual state.
    let pathsWon = [false, false, false, false];
    function updateHighlighted() {
        const reachedExit = (walk, ex) => !!(walk.exitedAt
            && walk.exitedAt.row === ex.row
            && walk.exitedAt.col === ex.col
            && walk.exitedAt.port === ex.port);
        const tag = (steps, pathIdx) =>
            steps.map((s) => Object.assign({}, s, { path: pathIdx }));

        const fwd1 = walkFrom(entry.row, entry.col, entry.port);
        const bwd1 = walkFrom(exit.row,  exit.col,  exit.port);
        const won1 = reachedExit(fwd1, exit);

        let won2 = true, extra2 = [];
        if (entry2 && exit2) {
            const fwd2 = walkFrom(entry2.row, entry2.col, entry2.port);
            const bwd2 = walkFrom(exit2.row,  exit2.col,  exit2.port);
            won2 = reachedExit(fwd2, exit2);
            extra2 = tag(fwd2.result, 1).concat(tag(bwd2.result, 1));
        }

        let won3 = true, extra3 = [];
        if (entry3 && exit3) {
            const fwd3 = walkFrom(entry3.row, entry3.col, entry3.port);
            const bwd3 = walkFrom(exit3.row,  exit3.col,  exit3.port);
            won3 = reachedExit(fwd3, exit3);
            extra3 = tag(fwd3.result, 2).concat(tag(bwd3.result, 2));
        }

        let won4 = true, extra4 = [];
        if (entry4 && exit4) {
            const fwd4 = walkFrom(entry4.row, entry4.col, entry4.port);
            const bwd4 = walkFrom(exit4.row,  exit4.col,  exit4.port);
            won4 = reachedExit(fwd4, exit4);
            extra4 = tag(fwd4.result, 3).concat(tag(bwd4.result, 3));
        }

        won = won1 && won2 && won3 && won4;
        pathsWon = [won1, won2, won3, won4];
        highlighted = tag(fwd1.result, 0).concat(tag(bwd1.result, 0), extra2, extra3, extra4);
    }

    // A freshly scrambled puzzle can land with a path ALREADY complete:
    // scrambleQuads gives every quad a 1-in-4 chance of 0 turns (and
    // rotation-symmetric quad contents survive non-zero turns), and the
    // non-quad rerolls randomize each tile independently — a short path
    // lines up by pure chance. Nothing re-checked pathsWon before shipping,
    // so players could start a puzzle with paths pre-won (field report:
    // a quad start with a path already gold). Called at the end of every
    // newPuzzle branch, after updateHighlighted: while any real path is
    // won, re-rotate one of its tiles (or its quad) and re-check.
    // Trade-off (deliberate): in non-quad mode the nudge happens AFTER the
    // canonical-difficulty checks, so the shipped puzzle can be marginally
    // off-canonical — acceptable for a case this rare vs. re-running the
    // whole search.
    function breakPreWonPaths() {
        const exists = [true, !!(entry2 && exit2), !!(entry3 && exit3), !!(entry4 && exit4)];
        for (let guard = 0; guard < 40; guard++) {
            let wonIdx = -1;
            for (let i = 0; i < 4; i++) {
                // pathsWon reports true for NON-existent paths (so the
                // overall-won AND works) — the exists[] filter is required.
                if (exists[i] && pathsWon[i]) { wonIdx = i; break; }
            }
            if (wonIdx === -1) return;
            // Candidate cells = the won path's lit lanes. Non-quad mode
            // excludes entry/exit cells (their rotation exposes the terminal
            // notch) and crosses (4-fold symmetric — re-rotating one can't
            // break connectivity). Quad mode excludes nothing: endpoint
            // quads scramble like any other, and turning a quad permutes
            // sub-tile positions, which crosses don't survive either.
            const endpoints = new Set();
            for (const ep of [entry, exit, entry2, exit2, entry3, exit3, entry4, exit4]) {
                if (ep) endpoints.add(ep.row + ',' + ep.col);
            }
            const cells = [];
            const seen = new Set();
            for (const lane of highlighted) {
                if (lane.path !== wonIdx) continue;
                const key = lane.row + ',' + lane.col;
                if (seen.has(key)) continue;
                seen.add(key);
                if (!quadMode && endpoints.has(key)) continue;
                if (!quadMode && grid[lane.row][lane.col].type === T_CROSS) continue;
                cells.push({ row: lane.row, col: lane.col });
            }
            if (cells.length === 0) return; // nothing safe to touch — ship as-is
            const cell = cells[Math.floor(Math.random() * cells.length)];
            if (quadMode && quadScramble) {
                // 1-3 extra turns on the quad containing the cell, twin
                // partner in lockstep (mirrors scrambleQuads).
                const qr = Math.floor(cell.row / 2), qc = Math.floor(cell.col / 2);
                const turns = 1 + Math.floor(Math.random() * 3);
                quadScramble[qr][qc] = (quadScramble[qr][qc] + turns) & 3;
                for (let i = 0; i < turns; i++) rotateQuad(qr * 2, qc * 2, false);
                const tile = grid[qr * 2][qc * 2];
                if (tile && tile._twin) {
                    const [pr, pc] = tile._twin.partner.split(',').map(Number);
                    quadScramble[pr / 2][pc / 2] = (quadScramble[pr / 2][pc / 2] + turns) & 3;
                    for (let i = 0; i < turns; i++) rotateQuad(pr, pc, false);
                }
            } else {
                const t = grid[cell.row][cell.col];
                // Straights are 2-fold symmetric — +2 would be a no-op.
                const turns = (t.type === T_STRAIGHT) ? (Math.random() < 0.5 ? 1 : 3)
                                                      : 1 + Math.floor(Math.random() * 3);
                t.rotation = (t.rotation + turns) & 3;
                // Non-quad twins rotate in lockstep for the player; keep the
                // scrambled state consistent with that. The partner is always
                // a filler (assignTwins pairs path+filler), so its new
                // orientation is solve-irrelevant.
                if (t._twin) {
                    const [pr, pc] = t._twin.partner.split(',').map(Number);
                    grid[pr][pc].rotation = (grid[pr][pc].rotation + turns) & 3;
                }
            }
            updateHighlighted();
        }
    }

    // Rotate the 2×2 quad whose top-left sub-tile is at (qr0, qc0). CW (ccw=false):
    // TR←TL, BR←TR, BL←BR, TL←BL, plus +1 to each sub-tile's own rotation.
    // CCW: TL←TR, TR←BR, BR←BL, BL←TL, plus +3 (= -1) to each rotation.
    function rotateQuad(qr0, qc0, ccw) {
        const tl = grid[qr0    ][qc0    ];
        const tr = grid[qr0    ][qc0 + 1];
        const bl = grid[qr0 + 1][qc0    ];
        const br = grid[qr0 + 1][qc0 + 1];
        const delta = ccw ? 3 : 1;
        if (ccw) {
            grid[qr0    ][qc0    ] = tr;
            grid[qr0    ][qc0 + 1] = br;
            grid[qr0 + 1][qc0 + 1] = bl;
            grid[qr0 + 1][qc0    ] = tl;
        } else {
            grid[qr0    ][qc0 + 1] = tl;
            grid[qr0 + 1][qc0 + 1] = tr;
            grid[qr0 + 1][qc0    ] = br;
            grid[qr0    ][qc0    ] = bl;
        }
        grid[qr0    ][qc0    ].rotation = (grid[qr0    ][qc0    ].rotation + delta) & 3;
        grid[qr0    ][qc0 + 1].rotation = (grid[qr0    ][qc0 + 1].rotation + delta) & 3;
        grid[qr0 + 1][qc0    ].rotation = (grid[qr0 + 1][qc0    ].rotation + delta) & 3;
        grid[qr0 + 1][qc0 + 1].rotation = (grid[qr0 + 1][qc0 + 1].rotation + delta) & 3;
    }

    // The 4 sub-tile positions within a quad each have 2 outer-quad sides
    // (facing neighboring quads) and 2 inner-quad sides (facing siblings).
    // An "outward-facing elbow" is the elbow rotation whose 2 ports both
    // lie on the outer sides for that position — so the path it carries
    // stays inside the quad's outline rather than poking inward into a
    // dead-end. Used by fixDeadEnds.
    function outwardElbowRotation(r, c) {
        const top  = (r & 1) === 0;
        const left = (c & 1) === 0;
        if (top  && left)  return 3;   // TL → N-W
        if (top  && !left) return 0;   // TR → N-E
        if (!top && left)  return 2;   // BL → S-W
        return 1;                       // BR → E-S
    }

    function tileHasPort(t, p) {
        for (const [a, b] of getConnections(t)) {
            if (a === p || b === p) return true;
        }
        return false;
    }

    // Inner-quad ports of sub-tile (r, c) that have no matching port on the
    // sibling sub-tile. These are the visible dead-ends inside a quad face
    // (the path enters but the sibling has no port to continue through).
    // Path tiles can't have inner dead-ends — solution paths stay inside the
    // path-tile chain, so a path tile's inner port always meets a path-tile
    // sibling at the canonical rotation. Only filler tiles need checking.
    function findInnerDeadEnds(r, c) {
        const tile = grid[r][c];
        const top  = (r & 1) === 0;
        const left = (c & 1) === 0;
        const inners = [];
        if (top)   inners.push({ port: S, sR: r + 1, sC: c,     sP: N });
        else       inners.push({ port: N, sR: r - 1, sC: c,     sP: S });
        if (left)  inners.push({ port: E, sR: r,     sC: c + 1, sP: W });
        else       inners.push({ port: W, sR: r,     sC: c - 1, sP: E });
        const dead = [];
        for (const i of inners) {
            if (!tileHasPort(tile, i.port)) continue;
            if (!tileHasPort(grid[i.sR][i.sC], i.sP)) dead.push(i.port);
        }
        return dead;
    }

    // Walk every filler tile and replace any whose inner-quad ports don't
    // match siblings. Cross tiles with exactly 1 dead-end drop the offending
    // lane (becoming a straight on the still-connected lane); everything
    // else becomes an outward-facing elbow.
    //
    // Iterates until stable: replacing a tile removes inner ports the tile
    // had, which can leave a sibling's previously-matched port suddenly
    // dead-ended, so the sibling needs a second pass. Each conversion
    // strictly reduces total inner-port count, so the loop terminates.
    function fixDeadEnds() {
        let changed = true;
        while (changed) {
            changed = false;
            for (let r = 0; r < ROWS; r++) {
                for (let c = 0; c < COLS; c++) {
                    const tile = grid[r][c];
                    if (tile._solution !== undefined) continue;
                    const dead = findInnerDeadEnds(r, c);
                    if (dead.length === 0) continue;
                    if (tile.type === T_CROSS && dead.length === 1) {
                        // Cross has lanes N-S and E-W. Drop the lane that
                        // owns the dead-end port; keep the other.
                        const horizontalDead = (dead[0] === E || dead[0] === W);
                        tile.type = T_STRAIGHT;
                        tile.rotation = horizontalDead ? 0 : 1;
                    } else {
                        tile.type = T_ELBOW;
                        tile.rotation = outwardElbowRotation(r, c);
                    }
                    changed = true;
                }
            }
        }
    }

    // After buildPuzzle, snap path tiles to their canonical rotation (so the
    // underlying maze is in its solved state), fix inner-quad dead-ends, and
    // then scramble each quad by a random 0..3 CW rotations. The player
    // solves by undoing those quad rotations.
    // After fixDeadEnds runs, a quad whose sub-tiles are all elbows reads as
    // monotonous and — when they're outward-facing fillers — is 4-fold
    // symmetric (rotation produces no visual change). Inject variety while
    // PRESERVING the no-inner-dead-end invariant: if a sibling pair of
    // fillers is available, replace them with a coordinated STRAIGHT lane
    // (TL+BL vertical, TR+BR vertical, TL+TR horizontal, or BL+BR horizontal).
    // The lane's two endpoints are at the quad's outer boundary; the inner
    // port between the pair matches; the other two sub-tiles stay as outward
    // elbows (no inner ports). Result: variety, asymmetric rotation, no
    // dead-ends.
    //
    // Quads where no filler-sibling pair exists (e.g., 2 diagonally-placed
    // fillers + 2 path tiles, or ≤1 filler) are left as-is. Coordinating
    // around path-tile orientations is a future extension.
    function breakSymmetricFillerQuads() {
        const qROWS = ROWS / 2, qCOLS = COLS / 2;
        // Each pattern lists 2 sibling cell offsets + the STRAIGHT rotation
        // for the lane, AND `checks` — the unchanged sub-tiles' ports that
        // MUST be absent for the pattern to be safe. After the change, the
        // STRAIGHT lane has no port toward the unchanged-side cells; if
        // those cells had a port toward the changed pair, my change would
        // strand it as a dead-end. So we pre-check and skip the pattern
        // when it would introduce one.
        const patterns = [
            // TL+BL vertical → unchanged TR/BR must not have W (their W faces
            // the changed TL/BL, which now have no E to match).
            { cells: [{dr:0,dc:0},{dr:1,dc:0}], rot: 0,
              checks: [{dr:0, dc:1, port: W}, {dr:1, dc:1, port: W}] },
            // TR+BR vertical → unchanged TL/BL must not have E.
            { cells: [{dr:0,dc:1},{dr:1,dc:1}], rot: 0,
              checks: [{dr:0, dc:0, port: E}, {dr:1, dc:0, port: E}] },
            // TL+TR horizontal → unchanged BL/BR must not have N.
            { cells: [{dr:0,dc:0},{dr:0,dc:1}], rot: 1,
              checks: [{dr:1, dc:0, port: N}, {dr:1, dc:1, port: N}] },
            // BL+BR horizontal → unchanged TL/TR must not have S.
            { cells: [{dr:1,dc:0},{dr:1,dc:1}], rot: 1,
              checks: [{dr:0, dc:0, port: S}, {dr:0, dc:1, port: S}] },
        ];
        function isFiller(qr, qc, off) {
            return grid[qr*2 + off.dr][qc*2 + off.dc]._solution === undefined;
        }
        function tileHasPort(t, p) {
            for (const [a, b] of getConnections(t)) {
                if (a === p || b === p) return true;
            }
            return false;
        }
        // Each `check` says: tile at (qr*2+ch.dr, qc*2+ch.dc) must not have
        // `ch.port`. The port direction is from the CHECK tile's frame —
        // it's the direction TOWARD the changed pair. (E.g., for TL+BL
        // vertical, the unchanged TR's W faces the changed TL; we want
        // TR.W to be absent.)
        function patternSafe(qr, qc, pat) {
            for (const ch of pat.checks) {
                const tile = grid[qr*2 + ch.dr][qc*2 + ch.dc];
                // Map the check's described `port` to the actual one the
                // unchanged tile would use facing the changed pair.
                // Lookup table: for TL+BL change, TR's W faces TL; for
                // TR+BR, TL's E faces TR; for TL+TR, BL's N faces TL;
                // for BL+BR, TL's S faces BL. The `checks` literally
                // record those facing-port directions, so we just test.
                if (tileHasPort(tile, ch.port)) return false;
            }
            return true;
        }
        for (let qr = 0; qr < qROWS; qr++) {
            for (let qc = 0; qc < qCOLS; qc++) {
                let allElbows = true;
                for (let dr = 0; dr < 2 && allElbows; dr++) {
                    for (let dc = 0; dc < 2 && allElbows; dc++) {
                        if (grid[qr*2+dr][qc*2+dc].type !== T_ELBOW) allElbows = false;
                    }
                }
                if (!allElbows) continue;
                const validPatterns = patterns.filter((p) =>
                    isFiller(qr, qc, p.cells[0]) && isFiller(qr, qc, p.cells[1]) &&
                    patternSafe(qr, qc, p)
                );
                if (validPatterns.length === 0) {
                    // All-filler elbow quad where NO pattern is safe: the
                    // inward-facing closed ring (every elbow's both ports
                    // face siblings — a sealed loop with zero external
                    // ports). fixDeadEnds can't see it (all inner ports
                    // match), and every pattern above fails patternSafe
                    // (the unchanged cells always have a port facing the
                    // changed pair). The ring is 4-fold symmetric AND
                    // visibly disconnected from everything — a free
                    // "ignore this quad" marker for the player. Rewrite
                    // ALL 4 cells — straight lane on a random pair,
                    // outward elbows on the other two — which needs no
                    // safety check because no original cell survives.
                    // Quads containing path tiles can't form a sealed
                    // ring (solution paths always cross the quad border),
                    // so the all-filler guard only skips configs we never
                    // expect to see.
                    let allFiller = true;
                    for (let dr = 0; dr < 2 && allFiller; dr++) {
                        for (let dc = 0; dc < 2 && allFiller; dc++) {
                            if (grid[qr*2+dr][qc*2+dc]._solution !== undefined) allFiller = false;
                        }
                    }
                    if (!allFiller) continue;
                    const pat = patterns[Math.floor(Math.random() * patterns.length)];
                    for (let dr = 0; dr < 2; dr++) {
                        for (let dc = 0; dc < 2; dc++) {
                            const r = qr*2 + dr, c = qc*2 + dc;
                            if (pat.cells.some((o) => o.dr === dr && o.dc === dc)) {
                                grid[r][c].type = T_STRAIGHT;
                                grid[r][c].rotation = pat.rot;
                            } else {
                                grid[r][c].type = T_ELBOW;
                                grid[r][c].rotation = outwardElbowRotation(r, c);
                            }
                        }
                    }
                    continue;
                }
                const pat = validPatterns[Math.floor(Math.random() * validPatterns.length)];
                for (const off of pat.cells) {
                    const r = qr*2 + off.dr, c = qc*2 + off.dc;
                    grid[r][c].type = T_STRAIGHT;
                    grid[r][c].rotation = pat.rot;
                }
            }
        }
    }

    function scrambleQuads() {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                const t = grid[r][c];
                if (t._solution !== undefined) t.rotation = t._solution;
            }
        }
        fixDeadEnds();
        breakSymmetricFillerQuads();
        const qROWS = ROWS / 2, qCOLS = COLS / 2;
        quadScramble = Array.from({ length: qROWS }, () => new Array(qCOLS).fill(0));
        // Twin quad pairs scramble with the SAME turns so their relative
        // offset stays 0 — that's the only way both can reach scramble=0
        // simultaneously when the player rotates them in lockstep.
        const scrambled = new Set();
        for (let qr = 0; qr < qROWS; qr++) {
            for (let qc = 0; qc < qCOLS; qc++) {
                const key = qr + ',' + qc;
                if (scrambled.has(key)) continue;
                const turns = Math.floor(Math.random() * 4);
                quadScramble[qr][qc] = turns;
                for (let i = 0; i < turns; i++) rotateQuad(qr * 2, qc * 2, false);
                scrambled.add(key);
                const tile = grid[qr * 2][qc * 2];
                if (tile && tile._twin) {
                    const [pr, pc] = tile._twin.partner.split(',').map(Number);
                    const pqr = pr / 2, pqc = pc / 2;
                    const pkey = pqr + ',' + pqc;
                    if (!scrambled.has(pkey)) {
                        quadScramble[pqr][pqc] = turns;
                        for (let i = 0; i < turns; i++) rotateQuad(pr, pc, false);
                        scrambled.add(pkey);
                    }
                }
            }
        }
    }

    function rotate(row, col, ccw = false) {
        if (!inBounds(row, col)) return false;

        // Quad mode: rotate the 2×2 quad containing (row, col) as one unit.
        if (quadMode) {
            const qr0 = Math.floor(row / 2) * 2;
            const qc0 = Math.floor(col / 2) * 2;
            // Helper: any sub-tile in the quad locked (hint or player) → quad locked.
            function quadLocked(qr0, qc0) {
                if (locked.has(qr0     + ',' + qc0    )) return true;
                if (locked.has(qr0     + ',' + (qc0+1))) return true;
                if (locked.has((qr0+1) + ',' + qc0    )) return true;
                if (locked.has((qr0+1) + ',' + (qc0+1))) return true;
                if (grid[qr0    ][qc0    ]._playerLocked) return true;
                if (grid[qr0    ][qc0 + 1]._playerLocked) return true;
                if (grid[qr0 + 1][qc0    ]._playerLocked) return true;
                if (grid[qr0 + 1][qc0 + 1]._playerLocked) return true;
                return false;
            }
            if (quadLocked(qr0, qc0)) return false;
            // Twin partner quad must also be unlocked — if either is locked
            // the whole pair is frozen (otherwise lockstep would force the
            // locked quad to rotate too, defeating its lock).
            const twinTile = grid[qr0][qc0];
            let partnerCoords = null;
            if (twinTile && twinTile._twin) {
                const [pr0, pc0] = twinTile._twin.partner.split(',').map(Number);
                if (pr0 !== qr0 || pc0 !== qc0) {
                    if (quadLocked(pr0, pc0)) return false;
                    partnerCoords = [pr0, pc0];
                }
            }
            rotateQuad(qr0, qc0, ccw);
            const qr = qr0 / 2, qc = qc0 / 2;
            // CW rotation adds 1 to the scramble offset; CCW adds 3.
            quadScramble[qr][qc] = (quadScramble[qr][qc] + (ccw ? 3 : 1)) & 3;
            if (partnerCoords) {
                rotateQuad(partnerCoords[0], partnerCoords[1], ccw);
                const pqr = partnerCoords[0] / 2, pqc = partnerCoords[1] / 2;
                quadScramble[pqr][pqc] = (quadScramble[pqr][pqc] + (ccw ? 3 : 1)) & 3;
            }
            updateHighlighted();
            return true;
        }

        const k = row + ',' + col;
        if (locked.has(k)) return false; // hint-locked tiles are fixed in place
        const t = grid[row][col];
        if (t._playerLocked) return false; // player long-pressed to lock
        // If this tile has a twin and the twin is locked, the pair is frozen.
        if (t._twin && locked.has(t._twin.partner)) return false;
        if (t._twin) {
            const [tr, tc] = t._twin.partner.split(',').map(Number);
            if (grid[tr][tc]._playerLocked) return false;
        }

        const delta = ccw ? 3 : 1;
        t.rotation = (t.rotation + delta) & 3;
        if (t._twin) {
            const [tr, tc] = t._twin.partner.split(',').map(Number);
            grid[tr][tc].rotation = (grid[tr][tc].rotation + delta) & 3;
        }
        updateHighlighted();
        return true;
    }

    // Player-driven lock: long-press a tile (or quad in quad mode) to mark it
    // un-rotatable. Visualized with a fully-opaque face. Toggles on second
    // long-press. Skips hint-locked tiles — the hint already locked them and
    // its red palette would mask the player-lock indicator anyway.
    function togglePlayerLock(row, col) {
        if (!inBounds(row, col)) return;
        if (quadMode) {
            const qr0 = Math.floor(row / 2) * 2;
            const qc0 = Math.floor(col / 2) * 2;
            const cellsOf = (qr, qc) => [
                [qr,     qc    ],
                [qr,     qc + 1],
                [qr + 1, qc    ],
                [qr + 1, qc + 1]
            ];
            const cells = cellsOf(qr0, qc0);
            // Twin partner quad: same convention rotate() and applyHintAt
            // use — `_twin.partner` lives on the clicked quad's top-left
            // sub-tile and points at the partner quad's top-left coord.
            // Twin pairs rotate in lockstep, so they must lock in lockstep
            // too; otherwise long-pressing one would visually mark only
            // half the pair as locked even though rotating either still
            // moves both. (This was the bug — quad mode was lighting up
            // only the touched quad, while singular mode lit both halves
            // of the twin pair.)
            let partnerCells = null;
            const anchor = grid[qr0][qc0];
            if (anchor && anchor._twin) {
                const [pr0, pc0] = anchor._twin.partner.split(',').map(Number);
                if (pr0 !== qr0 || pc0 !== qc0) {
                    partnerCells = cellsOf(pr0, pc0);
                }
            }
            // Hint-lock check on the clicked quad only. Hint locks both
            // quads of a twin pair simultaneously (applyHintAt's `lockQuad`
            // runs on both), so if either quad is hint-locked the other is
            // too — checking the clicked side is sufficient.
            for (const [r, c] of cells) {
                if (locked.has(r + ',' + c)) return;
            }
            // Toggle from the clicked quad's state — if any sub-tile in
            // the clicked quad is player-locked, the long-press unlocks
            // the whole pair (both quads). Otherwise it locks the pair.
            const next = !cells.some(([r, c]) => grid[r][c]._playerLocked);
            for (const [r, c] of cells) grid[r][c]._playerLocked = next;
            if (partnerCells) {
                for (const [r, c] of partnerCells) grid[r][c]._playerLocked = next;
            }
            return;
        }
        const k = row + ',' + col;
        if (locked.has(k)) return; // hint-locked, can't player-lock on top
        const t = grid[row][col];
        const next = !t._playerLocked;
        t._playerLocked = next;
        // Twin partners share the lock so a single long-press doesn't leave
        // the partner free to rotate (rotating one rotates both anyway).
        if (t._twin) {
            const [tr, tc] = t._twin.partner.split(',').map(Number);
            grid[tr][tc]._playerLocked = next;
        }
    }

    // Hint: pick a random un-locked path tile, snap it to its solution
    // rotation (a no-op visual change if it's already correct), and lock it
    // red. Locking already-correct tiles is intentional — the player may
    // want to fix them so they can't be accidentally rotated later. If the
    // hinted tile has a twin, the twin gets the same rotation delta and is
    // also locked, so the pair stays in sync.
    // Returns true if a tile was hinted, false if every path tile is
    // already locked.
    // Apply the hint effect to a specific (sub-)tile coordinate. In quad
    // mode the coordinate is interpreted as "any sub-tile in the quad to
    // hint"; in normal mode it's the tile itself. Pure side-effects: snaps
    // the tile/quad to its canonical orientation, marks `_hinted`, locks,
    // and clears any player-lock that would otherwise mask the hint visual.
    // Used by both the random-pick `hint()` and the move-replay path.
    function applyHintAt(row, col) {
        if (quadMode) {
            const qr = Math.floor(row / 2);
            const qc = Math.floor(col / 2);
            // Twin partner quad: rotates in lockstep, also locks. With same-turn
            // scrambling at build time, both quads have the same scramble offset,
            // so applying the same `turns` brings both to 0.
            const tile = grid[qr * 2][qc * 2];
            let pqr = -1, pqc = -1;
            if (tile && tile._twin) {
                const [pr, pc] = tile._twin.partner.split(',').map(Number);
                if (pr !== qr * 2 || pc !== qc * 2) { pqr = pr / 2; pqc = pc / 2; }
            }
            const turns = (4 - quadScramble[qr][qc]) & 3;
            for (let i = 0; i < turns; i++) {
                rotateQuad(qr * 2, qc * 2, false);
                if (pqr >= 0) rotateQuad(pqr * 2, pqc * 2, false);
            }
            quadScramble[qr][qc] = 0;
            if (pqr >= 0) quadScramble[pqr][pqc] = 0;
            function lockQuad(qr, qc) {
                for (let dr = 0; dr < 2; dr++) {
                    for (let dc = 0; dc < 2; dc++) {
                        const r = qr * 2 + dr;
                        const c = qc * 2 + dc;
                        locked.add(r + ',' + c);
                        grid[r][c]._hinted = true;
                        grid[r][c]._playerLocked = false;
                    }
                }
            }
            lockQuad(qr, qc);
            if (pqr >= 0) lockQuad(pqr, pqc);
            updateHighlighted();
            return { turns };
        }
        const tile = grid[row][col];
        const target = tile._solution;
        // Port-equivalence check: if the tile's CURRENT rotation already
        // gives the same port pairs as the solution rotation, a visible
        // rotation would be wasted — the lit path through the tile would
        // enter and exit at the same ports before and after. User
        // observed this when a hint picked a CROSS (or other rotationally-
        // symmetric tile) lit with the wrong path index: the tile spun
        // 180° but the path didn't change, leaving them feeling cheated
        // out of a hint. Solution: skip the rotation entirely; the lock
        // still applies, which conveys the hint's actual intent ("this
        // tile is at the right orientation — work elsewhere").
        //
        // Twin coupling: also check if rotating the twin partner by the
        // same delta would be port-equivalent for it too. Twins typically
        // share tile type so their port-equivalence tracks A's, but the
        // explicit check guards against mismatched-type edge cases —
        // if rotating B would meaningfully change its port topology,
        // we apply the rotation normally to keep the puzzle consistent.
        let delta = (target - tile.rotation + 4) & 3;
        let canSkipRotation = (delta !== 0) && rotationsHaveSamePorts(tile.type, tile.rotation, target);
        if (canSkipRotation && tile._twin) {
            const [tr, tc] = tile._twin.partner.split(',').map(Number);
            const twinTile = grid[tr][tc];
            const twinTarget = (twinTile.rotation + delta) & 3;
            if (!rotationsHaveSamePorts(twinTile.type, twinTile.rotation, twinTarget)) {
                canSkipRotation = false;
            }
        }
        if (canSkipRotation) {
            delta = 0;
        } else {
            tile.rotation = target;
            if (tile._twin) {
                const [tr, tc] = tile._twin.partner.split(',').map(Number);
                grid[tr][tc].rotation = (grid[tr][tc].rotation + delta) & 3;
            }
        }
        tile._hinted = true;
        tile._playerLocked = false;
        locked.add(row + ',' + col);
        if (tile._twin) {
            const [tr, tc] = tile._twin.partner.split(',').map(Number);
            grid[tr][tc]._playerLocked = false;
            locked.add(tile._twin.partner);
        }
        updateHighlighted();
        return { turns: delta };
    }

    // Pick a tile/quad to hint, then apply. Returns { r, c } of the sub-tile
    // coord that was hinted (any sub-tile of the affected quad in quad mode),
    // or null if nothing to hint. Recorder uses the returned coord so replay
    // can call applyHintAt(r, c) deterministically.
    //
    // Tier rules (both modes):
    //   preferred  = unlocked OR player-locked-and-incorrect
    //   fallback   = player-locked-and-correct (last resort)
    // The user's spec: "hint should only pick a locked tile if it's
    // incorrect, or there are no non-locked tiles to pick from."
    // Quad mode also skips quads that contain no path tiles (pure-filler
    // quads — scrambling them is meaningless for solving).
    // True if hint() should skip this tile because the player has already
    // correctly twisted it. "Correctly twisted" means the current rotation
    // gives the same PORT SET as the solution rotation — for STRAIGHT
    // tiles, rotations differing by 2 are visually indistinguishable
    // (rotations 0 and 2 both expose {N, S}); for cross they always match
    // (4-symmetric). Player can't tell a "wrong" rotation 2 from solution 0
    // and would justifiably feel the tile is correct — so don't hint it.
    //
    // Exception (caller relies on this): a tile lit with the WRONG path
    // index returns false here — so it stays eligible. Hint locking it red
    // tells the player "this rotation is right; the issue is the routing".
    function rotationsHaveSamePorts(type, a, b) {
        if (type === T_CROSS) return true;          // 4-symmetric
        if (type === T_STRAIGHT) return ((a ^ b) & 1) === 0; // 2-symmetric: rotations differing by 2 are equivalent
        return a === b;                             // ELBOW: every rotation distinct
    }
    function tileShouldSkip(r, c) {
        const t = grid[r][c];
        if (t._solution === undefined) return false;
        if (t._crossLanes) {
            // Cross is always at "solution". Eligible iff any lit lane is
            // showing a wrong path index for that lane.
            for (const h of highlighted) {
                if (h.row !== r || h.col !== c) continue;
                const lo = Math.min(h.inPort, h.outPort);
                const hi = Math.max(h.inPort, h.outPort);
                const lane = t._crossLanes.find(([a, b]) =>
                    Math.min(a, b) === lo && Math.max(a, b) === hi);
                if (lane && lane[2] !== (h.path | 0)) return false;
            }
            return true;
        }
        if (!rotationsHaveSamePorts(t.type, t.rotation, t._solution)) return false; // ports differ → eligible
        // Ports match solution. Eligible iff lit with wrong path.
        return !highlighted.some((h) =>
            h.row === r && h.col === c && (h.path | 0) !== ((t._path | 0)));
    }

    function hint() {
        // ── Helpers shared by both the path-walk strategy and the
        //    random-pick fallback below. ──

        // Colored solution-path connections per quad (decoys excluded).
        // Computed once here; quadConnectionsInvariantUnderRotation reads it
        // to decide whether rotating a quad would actually move a path.
        const quadConnMap = (quadMode && quadScramble) ? quadSolutionConnections() : null;

        function quadHasPathTile(qr, qc) {
            for (let dr = 0; dr < 2; dr++) {
                for (let dc = 0; dc < 2; dc++) {
                    if (grid[qr*2 + dr][qc*2 + dc]._solution !== undefined) return true;
                }
            }
            return false;
        }
        // Skip a quad if ANY path tile inside it is already correctly
        // placed (right rotation + lit with the right color). Hinting in
        // quad mode locks all 4 sub-tiles red — including ones the player
        // already worked out — so a single correctly-placed tile inside
        // is enough to make the hint feel like a step backward.
        //
        // Exception: if the quad's scramble offset is non-zero, the quad
        // itself is wrongly oriented and the player needs the hint to
        // snap it; ignore the per-tile correctness in that case (it
        // can't really be true if scramble != 0 anyway).
        function quadAnyTileCorrect(qr, qc) {
            if (quadScramble[qr][qc] !== 0) return false;
            for (let dr = 0; dr < 2; dr++) {
                for (let dc = 0; dc < 2; dc++) {
                    const r = qr * 2 + dr;
                    const c = qc * 2 + dc;
                    if (grid[r][c]._solution === undefined) continue;
                    if (tileShouldSkip(r, c)) return true;
                }
            }
            return false;
        }
        // True iff applying the hint rotation to this quad would produce
        // a connection-equivalent state (every position's effective
        // connections unchanged) — i.e. the player has the quad in a
        // configuration that "works just as well" as the solution even
        // though quadScramble != 0. Without this check, the hint locks
        // a quad red after a 180°/90°/270° rotation that has no effect
        // on the lit chain, which feels worthless to the player.
        //
        // CW position cycle: TL → TR → BR → BL → TL. After `turns` CW
        // rotations, the tile at position i NEW came from position
        // (i - turns + 4) % 4 OLD, with its own rotation +turns.
        function quadAlreadyPortEquivalent(qr, qc) {
            const turns = (4 - quadScramble[qr][qc]) & 3;
            if (turns === 0) return true;
            const r0 = qr * 2, c0 = qc * 2;
            const positions = [
                [r0,     c0    ],  // 0: TL
                [r0,     c0 + 1],  // 1: TR
                [r0 + 1, c0 + 1],  // 2: BR
                [r0 + 1, c0    ],  // 3: BL
            ];
            for (let i = 0; i < 4; i++) {
                const srcIdx = (i - turns + 4) % 4;
                const src = grid[positions[srcIdx][0]][positions[srcIdx][1]];
                const dst = grid[positions[i      ][0]][positions[i      ][1]];
                if (src.type !== dst.type) return false;
                const srcEffectiveRot = (src.rotation + turns) & 3;
                if (!rotationsHaveSamePorts(src.type, srcEffectiveRot, dst.rotation)) return false;
            }
            return true;
        }
        // QUAD-LEVEL port equivalence check (user's exact spec): "If the
        // path is going to enter and exit through the same QUAD ports once
        // rotated, then it should be skipped — rotating it will only create
        // a visual difference, not a functional one."
        //
        // Returns true when rotating this quad to its solution does NOT
        // change how any solution path threads it — so the hint would only
        // spin decoy pipes and feels wasted. Driven by quadConnMap (the
        // colored solution-path connections from quadSolutionConnections),
        // which excludes filler/decoy pipes entirely.
        //
        // External port indexing — CW from TL.N (port 0):
        //   0: TL.N  1: TR.N  2: TR.E  3: BR.E  4: BR.S  5: BL.S  6: BL.W  7: TL.W
        // A 90° CW quad rotation shifts every external port by +2 (8 ports /
        // 4 quarter-turns). So connection (a,b) becomes (a+2*turns, b+2*turns)
        // mod 8. If the SET of colored connections is invariant under that
        // shift, the path entry/exit ports are unchanged → wasted rotation.
        // (Invariance under +2*turns ⟺ under +2*quadScramble, since the two
        // shifts are inverses on the 8-port cycle.)
        function quadConnectionsInvariantUnderRotation(qr, qc) {
            const turns = (4 - quadScramble[qr][qc]) & 3;
            if (turns === 0) return true;
            const shift = (2 * turns) & 7;
            const conns = quadConnMap && quadConnMap.get(qr + ',' + qc);
            // No solution path crosses this quad (it's pure decoy) → rotating
            // it can never advance the solution → never worth a hint.
            if (!conns || conns.size === 0) return true;
            for (const code of conns) {
                const pi  = Math.floor(code / 64);
                const rest = code % 64;
                const lo = Math.floor(rest / 8);
                const hi = rest % 8;
                const lo2 = (lo + shift) & 7;
                const hi2 = (hi + shift) & 7;
                const nLo = Math.min(lo2, hi2);
                const nHi = Math.max(lo2, hi2);
                // Same pathIdx required: a shift that maps one color's
                // connection onto a DIFFERENT color's is a visible swap,
                // not an invariance — keep it hintable.
                if (!conns.has(pi * 64 + nLo * 8 + nHi)) return false;
            }
            return true;
        }
        function quadEligible(qr, qc) {
            if (locked.has((qr*2) + ',' + (qc*2))) return false;
            if (!quadHasPathTile(qr, qc)) return false;
            if (quadAnyTileCorrect(qr, qc)) return false;
            if (quadAlreadyPortEquivalent(qr, qc)) return false;
            // QUAD-LEVEL port-equivalence: skip if rotating wouldn't change
            // how any SOLUTION PATH enters/exits this quad's outer ports.
            // Player's request — if the path threads the same quad ports
            // after rotation, the spin is only visual. Unlike
            // quadAlreadyPortEquivalent (per-position tile equivalence, which
            // also weighs decoy fillers), this uses the colored solution-path
            // connections only, so a quad whose REAL path is already port-
            // correct but whose decoy filler pipes aren't is caught here —
            // the case that kept slipping through and wasting hints.
            if (quadConnectionsInvariantUnderRotation(qr, qc)) return false;
            // Twin partner quad must also pass the "no correct tile"
            // check — hinting cascades to it, and locking a partner
            // that contains correctly-placed tiles wastes the hint.
            const tile = grid[qr*2][qc*2];
            if (tile && tile._twin) {
                const [pr, pc] = tile._twin.partner.split(',').map(Number);
                const pqr = pr / 2, pqc = pc / 2;
                if (pqr !== qr || pqc !== qc) {
                    if (locked.has(pr + ',' + pc)) return false;
                    if (quadAnyTileCorrect(pqr, pqc)) return false;
                }
            }
            return true;
        }
        function tileEligible(r, c) {
            const t = grid[r][c];
            if (!t || t._solution === undefined) return false;
            if (locked.has(r + ',' + c)) return false;
            if (tileShouldSkip(r, c)) return false;
            // Twin pairs rotate in lockstep — hinting one side rotates
            // the other by the same delta. If the partner is already at
            // its solution rotation, hinting THIS tile would knock the
            // partner off solution AND lock it (locked.add(partner)),
            // leaving the puzzle unwinnable. Skip the whole pair.
            if (t._twin) {
                const [tr, tc] = t._twin.partner.split(',').map(Number);
                if (tileShouldSkip(tr, tc)) return false;
            }
            return true;
        }

        // Shared "is this cell's tile/quad at wrong orientation AND
        // hintable" check — true iff a hint at (r, c) would correct an
        // actually-wrong tile. Used by both the lit-chain pass below
        // and the solution-path pass after it.
        function cellWrongOrientationHintable(r, c) {
            if (quadMode) {
                const qr = Math.floor(r / 2);
                const qc = Math.floor(c / 2);
                // quadEligible already excludes port-equivalent quads
                // (via quadAlreadyPortEquivalent), so no extra check
                // needed here in quad mode.
                return quadEligible(qr, qc);
            }
            if (!tileEligible(r, c)) return false;
            // tileEligible's broader check (via tileShouldSkip) accepts
            // tiles that are port-equivalent but lit with the wrong
            // path index — those are routing problems, not orientation
            // problems, and belong to the fallback tier. Filter them out
            // here so the walk targets only genuine wrong-rotation tiles.
            const t = grid[r][c];
            const result = !rotationsHaveSamePorts(t.type, t.rotation, t._solution);
            return result;
        }
        function hintCellOrQuad(r, c) {
            if (quadMode) {
                const r0 = Math.floor(r / 2) * 2;
                const c0 = Math.floor(c / 2) * 2;
                const result = applyHintAt(r0, c0);
                return { r: r0, c: c0, turns: (result && result.turns) | 0 };
            }
            const result = applyHintAt(r, c);
            return { r, c, turns: (result && result.turns) | 0 };
        }

        // ── Pass 1: lit-chain wrong-orientation pass (highest priority). ──
        //
        // Walk forward from each entry using the player's CURRENT tile
        // rotations (== the lit chain the player can see right now). If
        // any tile already IN the lit chain is at a wrong orientation,
        // hint it — that's more useful than extending the chain past
        // its end with a fresh tile, because the player is actively
        // working with the wrong-oriented tile (it's lighting up under
        // their fingers) and the chain often can't progress further
        // without that fix. Without this pass, the solution-path walk
        // happily skips over wrong-but-lit tiles whenever the lit
        // chain happens to thread through them via a non-solution
        // port pairing.
        //
        // Entry order is shuffled so consecutive hints distribute
        // across paths rather than always favoring entry 1's chain.
        const allEntries = [entry, entry2, entry3, entry4].filter(Boolean);
        const entryOrder = shuffle(allEntries.map((_, i) => i));
        for (const ei of entryOrder) {
            const ent = allEntries[ei];
            const walk = walkFrom(ent.row, ent.col, ent.port);
            for (const step of walk.result) {
                if (cellWrongOrientationHintable(step.row, step.col)) {
                    return hintCellOrQuad(step.row, step.col);
                }
            }
        }

        // ── Pass 2: solution-path walk (lit chain is clean). ──
        //
        // For each entry/exit pair, walk the SOLVED path inward from
        // the entry and hint the first cell whose tile/quad isn't yet
        // at a port-equivalent orientation. Reached when every tile in
        // every lit chain is already correctly oriented — the chain
        // can't extend further, so the player needs the NEXT tile (the
        // first wrong one beyond the current lit-chain endpoint) snapped
        // for them. Port-equivalence (not strict rotation equality) is
        // the "right orientation" test; in quad mode the equivalent is
        // quadAlreadyPortEquivalent, which knows about the position
        // permutation under quad rotation as well as per-tile symmetry.
        //
        // Path order is shuffled so consecutive hints distribute across
        // paths rather than always racing down the same one. The
        // random-pick fallback below covers the nearly-solved edge
        // cases where every solution-path cell is also port-equivalent
        // but some lower-tier candidate (e.g., a player-locked tile at
        // the solution rotation) is still hint-able.
        const paths    = solutionPaths();
        const pathOrder = shuffle(paths.map((_, i) => i));
        for (const pi of pathOrder) {
            const cells = paths[pi];
            for (let i = 0; i < cells.length; i++) {
                const { r, c } = cells[i];
                if (cellWrongOrientationHintable(r, c)) {
                    return hintCellOrQuad(r, c);
                }
            }
        }

        // ── Pass 3: random-pick fallback (legacy tier logic). ──
        //
        // Reaches this when BOTH the lit-chain pass and the solution-
        // path walk found no wrong-oriented cell. The remaining hintable
        // tiles are edge cases the walk's strict "wrong orientation"
        // filter skips: a tile/quad sitting at a port-equivalent
        // rotation but lit with the wrong path index, or a
        // player-locked tile that's already at the solution rotation.
        // The original tier-based random pick still handles those —
        // preserved verbatim.
        if (quadMode) {
            const qROWS = ROWS / 2, qCOLS = COLS / 2;
            const preferred = [], midPool = [], lastResort = [];
            for (let qr = 0; qr < qROWS; qr++) {
                for (let qc = 0; qc < qCOLS; qc++) {
                    if (!quadEligible(qr, qc)) continue;
                    const playerLocked = !!grid[qr*2][qc*2]._playerLocked;
                    const solved = quadScramble[qr][qc] === 0;
                    if (!solved)            preferred.push({ qr, qc });
                    else if (!playerLocked) midPool.push({ qr, qc });
                    else                    lastResort.push({ qr, qc });
                }
            }
            const candidates = preferred.length ? preferred
                            : midPool.length    ? midPool
                            : lastResort;
            if (candidates.length === 0) return null;
            const pick = candidates[Math.floor(Math.random() * candidates.length)];
            const r = pick.qr * 2, c = pick.qc * 2;
            const result = applyHintAt(r, c);
            return { r, c, turns: (result && result.turns) | 0 };
        }
        const preferred = [];
        const fallback = [];
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (!tileEligible(r, c)) continue;
                const t = grid[r][c];
                // User preference: never hint a port-equivalent tile.
                // tileShouldSkip (called inside tileEligible) considers
                // these eligible when their lit lane has a wrong path
                // index, on the theory that locking them red signals
                // "the rotation is right; the routing is wrong." But
                // because they're port-equivalent, the applyHintAt
                // rotation is a no-op for connectivity — the player
                // sees the tile spin but their path doesn't change,
                // which feels like a wasted hint. User chose to drop
                // these from the picker entirely so every hint
                // actually rotates something meaningful. Edge case:
                // in nearly-solved puzzles where every remaining
                // eligible tile is port-equivalent, hint() will
                // return null (no useful rotation to apply).
                if (rotationsHaveSamePorts(t.type, t.rotation, t._solution)) continue;
                const correct = t.rotation === t._solution;
                if (t._playerLocked && correct) fallback.push({ r, c });
                else                            preferred.push({ r, c });
            }
        }
        const candidates = preferred.length ? preferred : fallback;
        if (candidates.length === 0) return null;
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const result = applyHintAt(pick.r, pick.c);
        return { r: pick.r, c: pick.c, turns: (result && result.turns) | 0 };
    }

    // Pair up twinPairCount() tiles where each pair = one path tile + one
    // filler tile. Tiles store `_twin = { partner, color }`; rotate() and
    // hint() use those tags to keep partners in lockstep. Entry/exit cells
    // are excluded because their notch-aligned starting rotation shouldn't
    // be moved by a twin rotation. Cross tiles are excluded because they're
    // 4-rotation-symmetric — rotating them with their partner would be an
    // invisible side effect, defeating the visual coupling.
    function assignTwins() {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) delete grid[r][c]._twin;
        }
        const pathCells = [], fillerCells = [];
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
                if (r === entry.row && c === entry.col) continue;
                if (r === exit.row  && c === exit.col)  continue;
                const t = grid[r][c];
                if (t.type === T_CROSS) continue;
                if (t._solution !== undefined) pathCells.push({ r, c });
                else                           fillerCells.push({ r, c });
            }
        }
        const target = twinPairCount();
        const pathPicks   = shuffle(pathCells).slice(0, target);
        const fillerPicks = shuffle(fillerCells).slice(0, target);
        const pairs = Math.min(pathPicks.length, fillerPicks.length, target);
        for (let i = 0; i < pairs; i++) {
            const a = pathPicks[i], b = fillerPicks[i];
            const color = TWIN_COLORS[i % TWIN_COLORS.length];
            const aKey = a.r + ',' + a.c;
            const bKey = b.r + ',' + b.c;
            grid[a.r][a.c]._twin = { partner: bKey, color };
            grid[b.r][b.c]._twin = { partner: aKey, color };
        }
    }

    // Quad-mode twins: pair whole 2×2 quads. Every sub-tile in a paired
    // quad gets `_twin = { partner, color }` where `partner` is the TL
    // sub-tile coord ("qr*2,qc*2") of the partner quad. Rotating one quad
    // rotates the partner quad in lockstep — same delta, same instant. The
    // 4 sub-tiles in each quad share the same _twin reference, so any
    // sub-tile inspection finds the partner correctly even after the data
    // permutes inside the quad on subsequent rotations.
    function quadTwinPairCount() {
        // qScale doubled (was (ROWS + COLS) / 4) so 12×12 quad now produces
        // ~9 pairs (was 3). Halve back to /4 if it feels too dense.
        const qScale = (ROWS + COLS) / 2;  // average quads-per-side, doubled
        return Math.max(1, Math.round(qScale) - 3);
    }
    function assignQuadTwins() {
        for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) delete grid[r][c]._twin;
        }
        const qROWS = ROWS / 2, qCOLS = COLS / 2;
        const candidates = [];
        for (let qr = 0; qr < qROWS; qr++) {
            for (let qc = 0; qc < qCOLS; qc++) {
                candidates.push({ qr, qc });
            }
        }
        const target = quadTwinPairCount();
        const picks = shuffle(candidates).slice(0, target * 2);
        const pairs = Math.floor(picks.length / 2);
        for (let i = 0; i < pairs; i++) {
            const a = picks[i * 2];
            const b = picks[i * 2 + 1];
            const color = TWIN_COLORS[i % TWIN_COLORS.length];
            const aKey = (a.qr * 2) + ',' + (a.qc * 2);
            const bKey = (b.qr * 2) + ',' + (b.qc * 2);
            for (let dr = 0; dr < 2; dr++) {
                for (let dc = 0; dc < 2; dc++) {
                    grid[a.qr*2 + dr][a.qc*2 + dc]._twin = { partner: bKey, color };
                    grid[b.qr*2 + dr][b.qc*2 + dc]._twin = { partner: aKey, color };
                }
            }
        }
    }

    function setDimensions(rows, cols) {
        // Always physical sub-tile dimensions. Caller (game.js / worker)
        // is responsible for doubling when in quad mode — keeping the
        // doubling at one entry point prevents double-doubling when the
        // worker passes already-physical dims back through.
        ROWS = rows;
        COLS = cols;
    }

    return {
        N, E, S, W,
        T_STRAIGHT, T_ELBOW, T_CROSS,
        init, rotate, hint, applyHintAt, togglePlayerLock, setDimensions, setHurry, setAbort, setTwoPathMode, setPathCount, setQuadMode,
        snapshotState, loadSnapshot, clear,
        getConnections,
        hasShortcutWithin,
        solutionEdges,
        recompute: () => updateHighlighted(),
        isLocked(r, c)    { return locked.has(r + ',' + c); },
        get ROWS()        { return ROWS; },
        get COLS()        { return COLS; },
        get grid()        { return grid; },
        get entry()       { return entry; },
        get exit()        { return exit; },
        get entry2()      { return entry2; },
        get exit2()       { return exit2; },
        get entry3()      { return entry3; },
        get exit3()       { return exit3; },
        get entry4()      { return entry4; },
        get exit4()       { return exit4; },
        get highlighted() { return highlighted; },
        get won()         { return won; },
        get pathsWon()    { return pathsWon; },
        get pathCount()   { return pathCount; },
        get quadMode()    { return quadMode; }
    };
})();
