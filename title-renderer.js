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
        // quadMode is a separate global flag (not part of snapshotState)
        // so we save it explicitly and force false during the render.
        // Without this: after the player finishes a Quad puzzle, quadMode
        // is true; rendering the 2×2 synthetic snapshot under quadMode
        // makes the render pipeline treat the four tiles as ONE quad
        // group (no inter-tile bevels, no segmentation), so the title-O
        // visibly becomes a single big tile instead of 4 elbows joined.
        const savedQuadMode = Maze.quadMode;
        if (Maze.setQuadMode) Maze.setQuadMode(false);

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
        const litOpts = {
            widthFrac: 0.28,
            alpha:     0.66,
            color:     '#ff2424',
            litColor:  '#a02020',
            litHi:     '#cc4040',
            litLo:     '#4a0000',
            litPulse:  true
        };
        Render.renderSnippet(canvas, sizeCss, litOpts);

        // The underlying render IS four separate T_ELBOW tiles drawn
        // through the normal per-tile pipeline (build a snapshot of 4
        // elbows → renderSnippet → drawCore → renderTileLit per tile).
        // Walls, bevels, every per-tile pass runs exactly as it does in
        // gameplay; we're not faking the 2×2 as one big tile.
        //
        // The only thing this overlay does is plug a sub-pixel
        // antialiasing artifact: at the title-O's tiny cellSize (~20px)
        // the butt-cap junctions where adjacent elbows' lit arcs meet at
        // a shared port leave hairline transparent slivers that the dark
        // body background bleeds through as visible dark seams cutting
        // the red ring. In gameplay the same AA gap exists but is
        // sub-visual at the larger cellSize (~50px+). Things that don't
        // fix it: extending each arc by a sub-pixel angle (still leaks
        // — the AA at fractional pixel coords misses); switching to
        // round line caps (each stripe gets its own cap radius, so the
        // port ends up as a stacked-disk blob that distorts the ring).
        //
        // The fix here is purely cosmetic AA-cleanup: re-stroke the same
        // 4-elbow channel as a single continuous-circle path (since all
        // 4 elbow arcs share the same center + radius by construction)
        // using the EXACT same per-stripe colors and pulse, so the
        // overlay is visually indistinguishable from a perfect per-tile
        // render — it just fills the AA slivers. Wall bevels (drawn in a
        // later pass) sit on top so the 4 tiles' borders remain visible.
        if (Render.paintSnippetRingMask) {
            Render.paintSnippetRingMask(canvas, sizeCss, litOpts);
        }

        if (saved) {
            Maze.loadSnapshot(saved);
        } else {
            // First-paint case: there was no real puzzle to restore. Wipe
            // the synthetic 2×2 so a Render.draw triggered before the next
            // newPuzzle finishes building doesn't paint the snippet onto the
            // main canvas (e.g. game.js's Render.refit fires before await).
            Maze.clear();
        }
        // Restore quadMode to whatever it was before our render — we
        // forced it false above so the snippet rendered as 4 separate
        // elbows. The next gameplay frame needs the true setting so
        // actual quad puzzles render correctly.
        if (Maze.setQuadMode) Maze.setQuadMode(savedQuadMode);

        // Register this canvas with the animation loop. activeCanvases
        // is a Map so multiple title canvases (e.g. main menu's #titleOCanvas
        // AND the opening intro's #introTitleOCanvas) animate independently
        // — each gets its own pulse driven by the shared rAF loop, and
        // calling draw() again on the same canvas just updates its size.
        // Previously this used a single `lastCanvas` slot, so a second
        // caller's draw would overwrite the first and the original
        // canvas would freeze on whatever frame it last rendered.
        activeCanvases.set(canvas, sizeCss);
        ensureAnimating();
    }

    // Continuous redraw loop drives the litPulse animation. Idempotent —
    // multiple draw() calls don't multiply the loop. Ticks paint EVERY
    // registered canvas each frame, skipping (but keeping registered)
    // ones that are momentarily hidden, and unregistering ones that are
    // no longer in the DOM. Stops itself when nothing is registered.
    const activeCanvases = new Map();   // canvas → lastSizeCss
    let rafId            = null;
    function ensureAnimating() {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(animTick);
    }
    function animTick() {
        // CRITICAL: schedule the next tick BEFORE iterating, so the
        // draw() calls inside the loop see rafId != null and the
        // ensureAnimating() they invoke no-ops. Otherwise each draw
        // schedules its own rAF AND we'd schedule another at the
        // bottom of this function, doubling rAFs per frame —
        // exponential growth that locks up the main thread within
        // ~20 frames (page freezes, devtools won't open).
        if (activeCanvases.size === 0) {
            rafId = null;
            return;
        }
        rafId = requestAnimationFrame(animTick);
        // Snapshot keys since the body of the loop may mutate the
        // map (we delete detached canvases).
        const canvases = Array.from(activeCanvases.keys());
        for (const canvas of canvases) {
            // Drop canvases that left the DOM (e.g. the intro overlay
            // is removed on dismiss). Without this the loop runs
            // forever painting a detached node.
            if (!canvas.isConnected) {
                activeCanvases.delete(canvas);
                continue;
            }
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                // Re-measure each frame so the loop stays in sync if
                // the title font reflows or the viewport resizes.
                const size = Math.max(24, Math.min(rect.width, rect.height));
                draw(canvas, size);
            }
            // If width/height are 0 the canvas is momentarily hidden
            // (e.g. menu while intro is up); skip the paint but leave
            // it registered so the pulse resumes when it's shown again.
        }
        // If iteration emptied the map (every canvas had detached),
        // cancel the tick we just scheduled — no point burning another
        // frame on an empty loop.
        if (activeCanvases.size === 0 && rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    return { draw };
})();
