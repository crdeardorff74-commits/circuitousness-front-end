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

    // True when the live Maze state is internally consistent — grid array
    // length matches ROWS, every row length matches COLS. Maze.setDimensions
    // updates ROWS/COLS WITHOUT touching grid, so there's a sync window
    // mid-newPuzzle where the title-renderer's rAF loop can otherwise
    // snapshot+restore corrupt state and crash updateHighlighted.
    function mazeStateConsistent() {
        if (!Maze.grid) return false;
        if (Maze.ROWS <= 0 || Maze.COLS <= 0) return false;
        if (Maze.grid.length !== Maze.ROWS) return false;
        for (let r = 0; r < Maze.grid.length; r++) {
            const row = Maze.grid[r];
            if (!row || row.length !== Maze.COLS) return false;
        }
        return true;
    }

    function draw(canvas, sizeCss) {
        if (!canvas || typeof Maze === 'undefined' || typeof Render === 'undefined') return;
        if (sizeCss <= 0) return;

        // Skip the whole render this frame if Maze is mid-mutation (e.g.
        // mid-newPuzzle, between setDimensions and the new grid population).
        // Snapshotting an inconsistent state would persist it through the
        // synthetic 2×2 load and corrupt the live grid on restore.
        if (Maze.grid !== null && !mazeStateConsistent()) {
            lastCanvas  = canvas;
            lastSizeCss = sizeCss;
            ensureAnimating();
            return;
        }

        // Snapshot only if Maze actually has a grid loaded — saves a crash
        // on first paint (menu shown before any puzzle has built).
        const saved = mazeStateConsistent() ? Maze.snapshotState() : null;

        Maze.loadSnapshot(buildSnippetSnapshot());

        // The 4 elbows form a closed loop, so walkFrom (which seeds
        // Maze.highlighted) can't reach them from the dummy entry — only
        // the dim pass would draw, and the channel interior would stay
        // dark. Manually populate highlighted with the 4 lanes so the LIT
        // pass paints them; combined with the renderSnippet `litColor`
        // option below, the result is a fully red-filled circle.
        if (Maze.highlighted && Array.isArray(Maze.highlighted)) {
            Maze.highlighted.length = 0;
            Maze.highlighted.push(
                { row: 0, col: 0, inPort: Maze.E, outPort: Maze.S, path: 0 }, // TL: E↔S
                { row: 0, col: 1, inPort: Maze.S, outPort: Maze.W, path: 0 }, // TR: S↔W
                { row: 1, col: 1, inPort: Maze.W, outPort: Maze.N, path: 0 }, // BR: W↔N
                { row: 1, col: 0, inPort: Maze.N, outPort: Maze.E, path: 0 }  // BL: N↔E
            );
        }

        // Punchier path than the in-game default — small inline element needs
        // more contrast to read. litColor/litHi/litLo + litPulse override
        // litPalette inside the snippet so the lit lanes paint with the
        // JOINED-style red gradient AND pulse with the same sine-driven
        // brightness modulation that the player sees when paths overlap
        // in multi-path puzzles. The continuous redraw is driven by the
        // rAF loop set up below in `ensureAnimating`.
        Render.renderSnippet(canvas, sizeCss, {
            widthFrac: 0.28,
            alpha:     0.66,
            color:     '#ff2424',
            litColor:  '#a02020',
            litHi:     '#cc4040',
            litLo:     '#4a0000',
            litPulse:  true
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

        // Capture the latest canvas/size for the animation loop, then
        // ensure the loop is running so the pulse animates.
        lastCanvas  = canvas;
        lastSizeCss = sizeCss;
        ensureAnimating();
    }

    // Continuous redraw loop drives the litPulse animation. Idempotent —
    // multiple draw() calls don't multiply the loop. Ticks skip rendering
    // when the canvas is hidden (zero size), but stay scheduled so the
    // pulse resumes immediately the next time the menu becomes visible.
    let lastCanvas  = null;
    let lastSizeCss = 0;
    let rafId       = null;
    function ensureAnimating() {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(animTick);
    }
    function animTick() {
        rafId = null;
        if (!lastCanvas) return;
        const rect = lastCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            // Re-measure: when the title font reflows or the viewport
            // resizes, the canvas's CSS size changes. Use the same min/max
            // floor as marathon.js's paintTitleO so the loop stays in sync.
            const size = Math.max(24, Math.min(rect.width, rect.height));
            draw(lastCanvas, size);
        } else {
            // Canvas hidden — keep the loop alive so the pulse resumes
            // when the menu re-shows. Cheap (one rAF callback per frame).
            rafId = requestAnimationFrame(animTick);
        }
    }

    return { draw };
})();
