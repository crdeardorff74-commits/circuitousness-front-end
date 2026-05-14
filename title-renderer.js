/**
 * Circuitousness — Title-O renderer
 *
 * Paints a 2×2 group of elbow tiles (whose four channels join into a circle)
 * into the menu title's "O" canvas, using the EXACT same rendering pipeline as
 * the in-game tile draw. Rather than duplicating the beveled-polygon code,
 * this swaps the global Maze state to a synthetic 2×2 elbow snapshot, calls
 * Render.renderSnippet (which redirects render.js's drawCore at the target
 * canvas + small cellSize), then restores the Maze state if there was one.
 *
 * Side effect: when called from the menu (no game in progress), the global
 * Maze ends up holding the synthetic snippet — that's harmless because the
 * next startPuzzle replaces it via newPuzzle. When called mid-quit (a game
 * was in progress), the saved snapshot is restored after rendering.
 */
const TitleRenderer = (() => {
    function buildSnippetSnapshot() {
        // Four elbows, each rotated so its arc center lands at the 2×2
        // group's geometric center — when the four channels join, they
        // form a complete circle.
        // Canonical elbow ports: N + E (rotation 0).
        // TL needs E + S (rotation 1, arc centered at BR corner = group center)
        // TR needs S + W (rotation 2, BL corner = group center)
        // BR needs W + N (rotation 3, TL corner = group center)
        // BL needs N + E (rotation 0, TR corner = group center)
        const T_ELBOW = Maze.T_ELBOW;
        return {
            rows: 2, cols: 2,
            grid: [[
                { type: T_ELBOW, rotation: 1 },
                { type: T_ELBOW, rotation: 2 }
            ], [
                { type: T_ELBOW, rotation: 0 },
                { type: T_ELBOW, rotation: 3 }
            ]],
            // Dummy entry/exit — required by Maze.loadSnapshot's walkFrom but
            // doesn't affect the snippet render (drawCircuitOutline is skipped
            // in snippetMode and the entry tile has no N port so the walk
            // returns immediately, leaving Maze.highlighted empty).
            entry: { row: 0, col: 0, port: Maze.N },
            exit:  { row: 1, col: 1, port: Maze.S },
            entry2: null, exit2: null,
            entry3: null, exit3: null,
            entry4: null, exit4: null,
            quadScramble: null
        };
    }

    function draw(canvas, sizeCss) {
        if (!canvas || typeof Maze === 'undefined' || typeof Render === 'undefined') return;
        if (sizeCss <= 0) return;

        // Snapshot only if Maze actually has a grid loaded — saves a crash
        // on first paint (menu shown before any puzzle has built).
        const saved = (Maze.grid && Maze.ROWS > 0) ? Maze.snapshotState() : null;

        Maze.loadSnapshot(buildSnippetSnapshot());
        // Punchier path than the in-game default — small inline element needs
        // more contrast to read. Values dialed in via the debug-mode sliders.
        Render.renderSnippet(canvas, sizeCss, {
            widthFrac: 0.28,
            alpha:     0.66,
            color:     '#ff2424'
        });

        if (saved) {
            Maze.loadSnapshot(saved);
        } else {
            // First-paint case: there was no real puzzle to restore. Wipe
            // the synthetic 2×2 so a Render.draw triggered before the next
            // newPuzzle finishes building doesn't paint the snippet onto the
            // main canvas (e.g. game.js's Render.refit fires before await).
            Maze.clear();
        }
    }

    return { draw };
})();
