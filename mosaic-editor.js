/**
 * mosaic-editor.js — drag-and-drop designer for hand-authored mosaic layouts.
 *
 * Reached from Developer mode (the "Mosaic Editor" button in the debug
 * panel, or Ctrl+M while the panel is open). Designs go into the library
 * mosaic-library.js owns; that module holds the format, the difficulty
 * ranking and the store, and this file holds every pixel of UI.
 *
 * WHAT YOU ARE DESIGNING
 * ──────────────────────
 * The PIECE PACKING, not the maze. You choose the board size and drag mosaic
 * shapes onto it; every cell you leave bare becomes singular fill
 * automatically, exactly as it does under the random packer. maze.js still
 * generates the wiring — paths, ports, twins, gates, scramble — fresh on top
 * of your layout each time it is played, so one design is a family of
 * puzzles that share a shape, not a single fixed board.
 *
 * TWO THINGS THAT LOOK LIKE MISSING FEATURES AND ARE NOT
 * ──────────────────────────────────────────────────────
 *   • There is no rotate control. Every shape in the library is rotation
 *     invariant — that is the defining property of the piece set (see
 *     mosaic.js's header) — so rotating one would change nothing.
 *   • There is no mirror control. Chiral shapes (the pinwheels) already
 *     appear in the palette as separate entries alongside their mirrors,
 *     because the enumeration produces both.
 *
 * Pieces may NEST. A ring's hole is not part of the ring, so a smaller piece
 * (or singular fill) drops straight into it — that concentric look is the
 * whole point of keeping holes in the shape library, and the editor's
 * overlap check is per-CELL precisely so it stays possible.
 *
 * NO i18n, DELIBERATELY. This is developer tooling behind the same gate as
 * the PotD tuning panel, whose chrome is likewise plain English. Universal
 * rule 5 governs player-facing text; when layout authoring is opened up to
 * players it needs a player-facing UI of its own, and that one gets
 * translated. Adding 15 locales of "Auto-fill" now would be waste.
 *
 * Pointer events throughout, so mouse, trackpad, touch and pen all take the
 * same path — dragging works on a tablet without a second code path.
 */

const MosaicEditor = (function () {

    // ── Presentation constants ───────────────────────────────────────────

    // One hue per frame size, so the eye sorts a dense board by piece scale
    // without counting cells. Drawn from the game's own lit-path palette
    // rather than invented, per universal rule a.
    const FRAME_FILL = {
        2: 'rgba(58, 123, 213, 0.55)',
        3: 'rgba(42, 236, 24, 0.42)',
        4: 'rgba(254, 113, 247, 0.42)',
        5: 'rgba(255, 130, 71, 0.48)'
    };
    const FRAME_EDGE = {
        2: '#8fc0ff', 3: '#b8ffb3', 4: '#ffdbff', 5: '#ffdccc'
    };
    const BOARD_BG    = '#151a2c';
    const CELL_EMPTY  = 'rgba(255, 255, 255, 0.05)';
    const GRID_LINE   = 'rgba(255, 255, 255, 0.10)';
    const SELECT_EDGE = '#FFD700';
    const OK_FILL     = 'rgba(42, 236, 24, 0.35)';
    const BAD_FILL    = 'rgba(255, 70, 70, 0.35)';

    // Board cell size in CSS pixels, clamped. The board is a canvas, so
    // these are drawing units rather than layout units — universal rule 2
    // governs the CSS around it, which is all relative.
    const CELL_MIN = 14;
    const CELL_MAX = 44;

    // Palette thumbnail size, in CSS pixels. Big enough that a 5×5 pinwheel
    // is distinguishable from its mirror at a glance — there are chiral
    // pairs in the library and picking the wrong one is a silent mistake.
    const THUMB_PX = 46;

    // A pointer that moved less than this between down and up is a CLICK,
    // not a drag — which is how a palette tap places a piece at the first
    // spot that fits without anyone having to drag anything.
    const CLICK_SLOP_PX = 6;

    // ── State ────────────────────────────────────────────────────────────

    let open = false;
    let initialized = false;

    let rows = 10, cols = 10;
    let pieces = [];          // [{ n, mask, r, c }, …] — the design
    let occ = null;           // rows*cols of piece index, -1 = bare
    let selected = -1;
    let editingId = null;     // library entry being edited, null = unsaved
    let drag = null;
    let building = false;

    let els = {};
    let cell = 28;

    // ── Occupancy ────────────────────────────────────────────────────────

    function shapeOf(p) { return Mosaic.findShape(p.n, p.mask); }

    function rebuildOcc() {
        occ = new Int32Array(rows * cols).fill(-1);
        for (let i = 0; i < pieces.length; i++) {
            const s = shapeOf(pieces[i]);
            if (!s) continue;
            for (const [dr, dc] of s.cells) {
                const r = pieces[i].r + dr, c = pieces[i].c + dc;
                if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
                occ[r * cols + c] = i;
            }
        }
    }

    // Would this shape sit legally at (r, c)? `exclude` is the index of a
    // piece to ignore, which is what lets a piece be dragged one cell
    // sideways without colliding with the copy of itself still in the list.
    function fits(n, mask, r, c, exclude) {
        const s = Mosaic.findShape(n, mask);
        if (!s) return false;
        if (r < 0 || c < 0 || r + s.n > rows || c + s.n > cols) return false;
        for (const [dr, dc] of s.cells) {
            const at = occ[(r + dr) * cols + (c + dc)];
            if (at !== -1 && at !== exclude) return false;
        }
        return true;
    }

    // First position (row-major) where this shape fits, or null.
    function firstFit(n, mask) {
        for (let r = 0; r + n <= rows; r++) {
            for (let c = 0; c + n <= cols; c++) {
                if (fits(n, mask, r, c, -1)) return { r: r, c: c };
            }
        }
        return null;
    }

    // ── The design as a layout ───────────────────────────────────────────

    // The Ganged % input as a 0..1 fraction, or undefined when the input
    // is absent/blank — makeLayout then applies the baseline default.
    // It is part of the LAYOUT (2026-08-15): it feeds the difficulty
    // score, so it saves, exports and loads with the design.
    function gangedInput() {
        if (!els.twins) return undefined;
        const pct = parseInt(els.twins.value, 10);
        return isFinite(pct) ? pct / 100 : undefined;
    }

    function currentLayout() {
        return MosaicLibrary.makeLayout(rows, cols, pieces, gangedInput());
    }

    function loadLayout(layout, entryId) {
        const l = MosaicLibrary.normalize(layout);
        if (!l) return false;
        rows = l.rows; cols = l.cols;
        pieces = l.pieces;
        selected = -1;
        editingId = entryId || null;
        rebuildOcc();
        if (els.rows) els.rows.value = rows;
        if (els.cols) els.cols.value = cols;
        if (els.twins) els.twins.value = Math.round(l.ganged * 100);
        refit();
        renderAll();
        return true;
    }

    // ── Drawing ──────────────────────────────────────────────────────────

    // Exterior outline of a cell set: draw only the sides that don't face
    // another cell of the SAME set, so a piece reads as one object rather
    // than a cluster of tiles. Same notion the real renderer uses to decide
    // which bevels to skip (maze.js's mosaicInnerMask).
    function strokeOutline(ctx, cells, x0, y0, size) {
        const inSet = new Set(cells.map(([r, c]) => r + ',' + c));
        ctx.beginPath();
        for (const [r, c] of cells) {
            const x = x0 + c * size, y = y0 + r * size;
            if (!inSet.has((r - 1) + ',' + c)) { ctx.moveTo(x, y);               ctx.lineTo(x + size, y); }
            if (!inSet.has((r + 1) + ',' + c)) { ctx.moveTo(x, y + size);        ctx.lineTo(x + size, y + size); }
            if (!inSet.has(r + ',' + (c - 1))) { ctx.moveTo(x, y);               ctx.lineTo(x, y + size); }
            if (!inSet.has(r + ',' + (c + 1))) { ctx.moveTo(x + size, y);        ctx.lineTo(x + size, y + size); }
        }
        ctx.stroke();
    }

    // Canvas sizing helper — sets the backing store to device pixels and
    // scales the context, so lines stay crisp on a HiDPI screen.
    function sizeCanvas(canvas, w, h) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width  = w + 'px';
        canvas.style.height = h + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return ctx;
    }

    // Pick a cell size that fits the board into the space the layout gives
    // it. Called on open and on every resize — the panel is a flex child, so
    // its box is only known once it is on screen.
    function refit() {
        if (!els.board || !els.boardWrap) return;
        // getBoundingClientRect INCLUDES the wrap's padding, so budget it
        // out (0.8rem per side in styles.css, measured live so a style
        // tweak can't silently reopen the gap) — the old flat −8 left the
        // canvas overrunning the content box at some dims, which is where
        // the sliver of scrollbar came from (user report 2026-08-15; the
        // wrap is overflow:hidden now as well).
        const box = els.boardWrap.getBoundingClientRect();
        let padW = 8, padH = 8;
        if (typeof getComputedStyle === 'function') {
            const cs = getComputedStyle(els.boardWrap);
            padW = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight)  || 0);
            padH = (parseFloat(cs.paddingTop)  || 0) + (parseFloat(cs.paddingBottom) || 0);
        }
        const availW = Math.max(80, box.width  - padW);
        const availH = Math.max(80, box.height - padH);
        cell = Math.floor(Math.min(availW / cols, availH / rows));
        cell = Math.max(CELL_MIN, Math.min(CELL_MAX, cell));
    }

    function drawBoard() {
        if (!els.board) return;
        const w = cols * cell, h = rows * cell;
        const ctx = sizeCanvas(els.board, w, h);

        ctx.fillStyle = BOARD_BG;
        ctx.fillRect(0, 0, w, h);

        // Bare cells — these become singular fill at build time.
        ctx.fillStyle = CELL_EMPTY;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (occ[r * cols + c] === -1) ctx.fillRect(c * cell + 1, r * cell + 1, cell - 2, cell - 2);
            }
        }

        // Grid.
        ctx.strokeStyle = GRID_LINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let r = 0; r <= rows; r++) { ctx.moveTo(0, r * cell + 0.5); ctx.lineTo(w, r * cell + 0.5); }
        for (let c = 0; c <= cols; c++) { ctx.moveTo(c * cell + 0.5, 0); ctx.lineTo(c * cell + 0.5, h); }
        ctx.stroke();

        // Pieces. The one being dragged is skipped — its ghost is following
        // the pointer instead, and leaving it painted in place would read as
        // a duplicate.
        for (let i = 0; i < pieces.length; i++) {
            if (drag && drag.from === i) continue;
            const p = pieces[i], s = shapeOf(p);
            if (!s) continue;
            const abs = s.cells.map(([dr, dc]) => [p.r + dr, p.c + dc]);
            ctx.fillStyle = FRAME_FILL[p.n] || 'rgba(255,255,255,0.3)';
            for (const [r, c] of abs) ctx.fillRect(c * cell, r * cell, cell, cell);
            ctx.strokeStyle = (i === selected) ? SELECT_EDGE : (FRAME_EDGE[p.n] || '#fff');
            ctx.lineWidth = (i === selected) ? 3 : 1.5;
            strokeOutline(ctx, abs, 0, 0, cell);
        }

        // Drop preview.
        if (drag && drag.target) {
            const s = Mosaic.findShape(drag.n, drag.mask);
            if (s) {
                const abs = s.cells.map(([dr, dc]) => [drag.target.r + dr, drag.target.c + dc]);
                ctx.fillStyle = drag.valid ? OK_FILL : BAD_FILL;
                for (const [r, c] of abs) {
                    if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
                    ctx.fillRect(c * cell, r * cell, cell, cell);
                }
                ctx.strokeStyle = drag.valid ? '#2aec18' : '#ff4646';
                ctx.lineWidth = 2;
                strokeOutline(ctx, abs, 0, 0, cell);
            }
        }
    }

    // ── Palette ──────────────────────────────────────────────────────────

    function drawThumb(canvas, n, mask, px) {
        const s = Mosaic.findShape(n, mask);
        const size = px / n;
        const ctx = sizeCanvas(canvas, px, px);
        ctx.clearRect(0, 0, px, px);
        if (!s) return;
        ctx.fillStyle = FRAME_FILL[n] || 'rgba(255,255,255,0.3)';
        for (const [dr, dc] of s.cells) ctx.fillRect(dc * size, dr * size, size, size);
        ctx.strokeStyle = FRAME_EDGE[n] || '#fff';
        ctx.lineWidth = 1.5;
        strokeOutline(ctx, s.cells, 0, 0, size);
    }

    // The palette is the shape library itself — enumerated by mosaic.js, not
    // listed here — grouped by frame and ordered small to large. That means
    // a change to MAX_FRAME or to the invariance filter shows up in the
    // editor with no edit to this file, which is the point.
    function buildPalette() {
        if (!els.palette) return;
        els.palette.innerHTML = '';
        const byFrame = {};
        for (const s of Mosaic.SHAPES) (byFrame[s.n] = byFrame[s.n] || []).push(s);

        const frames = Object.keys(byFrame).map(Number).sort((a, b) => a - b);
        for (const n of frames) {
            const head = document.createElement('div');
            head.className = 'meGroupHead';
            head.textContent = n + '×' + n;
            els.palette.appendChild(head);

            const row = document.createElement('div');
            row.className = 'meGroup';
            // Biggest piece first inside a frame, matching how the packer
            // walks its own library.
            const list = byFrame[n].slice().sort((a, b) => b.size - a.size);
            for (const s of list) {
                const mask = Mosaic.maskFromCells(s.n, s.cells);
                const item = document.createElement('div');
                item.className = 'meShape';
                item.title = n + '×' + n + ' · ' + s.size + ' cells — drag onto the board, or tap to drop it in the first free spot';
                const cv = document.createElement('canvas');
                item.appendChild(cv);
                row.appendChild(item);
                drawThumb(cv, s.n, mask, THUMB_PX);
                // The CANVAS, not its padded wrapper, is the drag source —
                // startDrag works out which cell of the shape was grabbed
                // from the element's box, and the wrapper's padding would
                // skew that by a fraction of a cell.
                item.addEventListener('pointerdown', (ev) => startDrag(ev, s.n, mask, -1, cv, THUMB_PX));
            }
            els.palette.appendChild(row);
        }
    }

    // ── Dragging ─────────────────────────────────────────────────────────

    function ensureGhost() {
        if (els.ghost) return els.ghost;
        const g = document.createElement('div');
        g.id = 'meGhost';
        document.body.appendChild(g);
        els.ghost = g;
        return g;
    }

    function paintGhost() {
        const g = ensureGhost();
        g.innerHTML = '';
        const cv = document.createElement('canvas');
        g.appendChild(cv);
        drawThumb(cv, drag.n, drag.mask, drag.n * cell);
        g.style.display = 'block';
    }

    function moveGhost(x, y) {
        const g = ensureGhost();
        // Anchor the ghost so the grabbed cell stays under the pointer —
        // what you dropped is then exactly what you were looking at.
        g.style.left = (x - (drag.grabDc + 0.5) * cell) + 'px';
        g.style.top  = (y - (drag.grabDr + 0.5) * cell) + 'px';
        g.classList.toggle('bad', !!drag.target && !drag.valid);
        g.classList.toggle('trash', drag.from >= 0 && !drag.target);
    }

    function hideGhost() {
        if (els.ghost) els.ghost.style.display = 'none';
    }

    /**
     * Begin a drag. `sourceEl`/`sourcePx` describe the element grabbed, and
     * are used to work out WHICH cell of the shape the pointer took hold of
     * — dropping then lands where the eye expects rather than always by the
     * top-left corner.
     */
    function startDrag(ev, n, mask, fromIndex, sourceEl, sourcePx) {
        if (ev.button != null && ev.button !== 0 && ev.pointerType === 'mouse') return;
        ev.preventDefault();
        const box = sourceEl.getBoundingClientRect();
        const unit = sourcePx / n;
        const grabDr = Math.max(0, Math.min(n - 1, Math.floor((ev.clientY - box.top)  / unit)));
        const grabDc = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - box.left) / unit)));

        drag = {
            n: n, mask: mask, from: fromIndex,
            grabDr: grabDr, grabDc: grabDc,
            startX: ev.clientX, startY: ev.clientY,
            moved: false, target: null, valid: false,
            pointerId: ev.pointerId
        };
        if (fromIndex >= 0) { selected = fromIndex; }
        paintGhost();
        moveGhost(ev.clientX, ev.clientY);
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragEnd);
        window.addEventListener('pointercancel', onDragEnd);
        renderAll();
    }

    function onDragMove(ev) {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        if (Math.abs(ev.clientX - drag.startX) > CLICK_SLOP_PX ||
            Math.abs(ev.clientY - drag.startY) > CLICK_SLOP_PX) drag.moved = true;

        const box = els.board.getBoundingClientRect();
        const inside = ev.clientX >= box.left && ev.clientX <= box.right &&
                       ev.clientY >= box.top  && ev.clientY <= box.bottom;
        if (inside) {
            const r = Math.floor((ev.clientY - box.top)  / cell) - drag.grabDr;
            const c = Math.floor((ev.clientX - box.left) / cell) - drag.grabDc;
            drag.target = { r: r, c: c };
            drag.valid = fits(drag.n, drag.mask, r, c, drag.from);
        } else {
            drag.target = null;
            drag.valid = false;
        }
        moveGhost(ev.clientX, ev.clientY);
        drawBoard();
    }

    function onDragEnd(ev) {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        window.removeEventListener('pointermove', onDragMove);
        window.removeEventListener('pointerup', onDragEnd);
        window.removeEventListener('pointercancel', onDragEnd);
        const d = drag;
        drag = null;
        hideGhost();

        if (d.target && d.valid) {
            if (d.from >= 0) {
                pieces[d.from].r = d.target.r;
                pieces[d.from].c = d.target.c;
                selected = d.from;
            } else {
                pieces.push({ n: d.n, mask: d.mask, r: d.target.r, c: d.target.c });
                selected = pieces.length - 1;
            }
        } else if (!d.target && d.from >= 0 && d.moved) {
            // Dragged clean off the board — that's a delete. Only when the
            // pointer actually travelled, so a stray tap on a piece can
            // never destroy it.
            pieces.splice(d.from, 1);
            selected = -1;
        } else if (!d.moved && d.from < 0) {
            // A tap on the palette, not a drag: drop it wherever it fits.
            const spot = firstFit(d.n, d.mask);
            if (spot) {
                pieces.push({ n: d.n, mask: d.mask, r: spot.r, c: spot.c });
                selected = pieces.length - 1;
                say('Placed at ' + spot.r + ',' + spot.c + '.');
            } else {
                say('No room for that piece on this board.', true);
            }
        }
        rebuildOcc();
        renderAll();
    }

    // ── Board input ──────────────────────────────────────────────────────

    function cellAt(ev) {
        const box = els.board.getBoundingClientRect();
        const r = Math.floor((ev.clientY - box.top)  / cell);
        const c = Math.floor((ev.clientX - box.left) / cell);
        if (r < 0 || c < 0 || r >= rows || c >= cols) return null;
        return { r: r, c: c };
    }

    function onBoardPointerDown(ev) {
        // Left button only. Without this a right-click would start a drag
        // AND fire the contextmenu handler that deletes the piece — the drag
        // would then be left holding an index into a list it no longer
        // belongs to, with its window listeners still installed.
        if (ev.pointerType === 'mouse' && ev.button !== 0) return;
        const at = cellAt(ev);
        if (!at) return;
        const i = occ[at.r * cols + at.c];
        if (i === -1) {
            selected = -1;
            renderAll();
            return;
        }
        // Grab the piece by the cell actually under the pointer, so it
        // travels with the pointer instead of jumping.
        const p = pieces[i];
        startDragExisting(ev, i, at.r - p.r, at.c - p.c);
    }

    function startDragExisting(ev, index, grabDr, grabDc) {
        ev.preventDefault();
        const p = pieces[index];
        drag = {
            n: p.n, mask: p.mask, from: index,
            grabDr: grabDr, grabDc: grabDc,
            startX: ev.clientX, startY: ev.clientY,
            moved: false,
            target: { r: p.r, c: p.c }, valid: true,
            pointerId: ev.pointerId
        };
        selected = index;
        paintGhost();
        moveGhost(ev.clientX, ev.clientY);
        window.addEventListener('pointermove', onDragMove);
        window.addEventListener('pointerup', onDragEnd);
        window.addEventListener('pointercancel', onDragEnd);
        renderAll();
    }

    // Right-click / long-press equivalent: remove the piece under the
    // pointer outright.
    function onBoardContextMenu(ev) {
        const at = cellAt(ev);
        if (!at) return;
        ev.preventDefault();
        const i = occ[at.r * cols + at.c];
        if (i === -1) return;
        pieces.splice(i, 1);
        selected = -1;
        rebuildOcc();
        renderAll();
    }

    // ── Board size ───────────────────────────────────────────────────────

    function setDims(nextRows, nextCols) {
        const r = Math.max(MosaicLibrary.MIN_DIM, Math.min(MosaicLibrary.MAX_DIM, nextRows | 0));
        const c = Math.max(MosaicLibrary.MIN_DIM, Math.min(MosaicLibrary.MAX_DIM, nextCols | 0));
        if (r === rows && c === cols) return;
        rows = r; cols = c;
        // Shrinking drops whatever no longer fits. Reported rather than
        // silent — losing a piece you spent time placing should not be
        // something you have to notice for yourself.
        const before = pieces.length;
        pieces = pieces.filter((p) => p.r >= 0 && p.c >= 0 && p.r + p.n <= rows && p.c + p.n <= cols);
        if (pieces.length !== before) {
            say('Board resized — ' + (before - pieces.length) + ' piece(s) no longer fit and were removed.', true);
        }
        selected = -1;
        if (els.rows) els.rows.value = rows;
        if (els.cols) els.cols.value = cols;
        rebuildOcc();
        refit();
        renderAll();
    }

    // ── Actions ──────────────────────────────────────────────────────────

    function clearBoard() {
        pieces = [];
        selected = -1;
        editingId = null;
        rebuildOcc();
        renderAll();
        say('Cleared.');
    }

    // Seed the board from the RANDOM packer. The random mechanism isn't
    // going anywhere — this is where it earns its second job: a plausible
    // full packing to start editing from beats staring at an empty grid.
    function autoFill() {
        const packed = Mosaic.pack(rows, cols, {});
        pieces = Mosaic.layoutFromPacking(packed.groups);
        selected = -1;
        rebuildOcc();
        renderAll();
        say('Auto-filled with a random packing — edit from here.');
    }

    function deleteSelected() {
        if (selected < 0) return;
        pieces.splice(selected, 1);
        selected = -1;
        rebuildOcc();
        renderAll();
    }

    function nudgeSelected(dr, dc) {
        if (selected < 0) return;
        const p = pieces[selected];
        if (!fits(p.n, p.mask, p.r + dr, p.c + dc, selected)) return;
        p.r += dr; p.c += dc;
        rebuildOcc();
        renderAll();
    }

    // ── Library panel ────────────────────────────────────────────────────

    function saveCurrent() {
        const layout = currentLayout();
        const check = MosaicLibrary.validate(layout);
        if (!check.ok) { say('Cannot save: ' + check.errors.join('; '), true); return; }
        const name = (els.name && els.name.value.trim()) || 'Untitled';
        const stored = MosaicLibrary.save({
            id: editingId,          // null → a new entry; set → overwrite
            name: name,
            author: (els.author && els.author.value.trim()) || '',
            layout: layout
        });
        if (!stored) { say('Save failed — localStorage refused the write.', true); return; }
        editingId = stored.id;
        renderLibrary();
        say('Saved "' + stored.name + '" — tier ' + stored.tier + ' (' + stored.difficulty + ').');
    }

    function renderLibrary() {
        if (!els.list) return;
        const entries = MosaicLibrary.list();
        els.list.innerHTML = '';
        if (!entries.length) {
            const p = document.createElement('div');
            p.className = 'meEmpty';
            p.textContent = 'No saved layouts yet.';
            els.list.appendChild(p);
            return;
        }
        for (const e of entries) {
            const row = document.createElement('div');
            row.className = 'meEntry' + (e.id === editingId ? ' editing' : '');

            const meta = document.createElement('div');
            meta.className = 'meEntryMeta';
            meta.innerHTML = '<span class="meEntryName"></span>' +
                             '<span class="meEntryDims"></span>';
            meta.querySelector('.meEntryName').textContent = e.name;
            meta.querySelector('.meEntryDims').textContent =
                e.layout.rows + '×' + e.layout.cols + ' · T' + e.tier + ' (' + e.difficulty + ')';
            row.appendChild(meta);

            const load = document.createElement('button');
            load.type = 'button'; load.textContent = 'Load';
            load.addEventListener('click', () => {
                if (loadLayout(e.layout, e.id)) {
                    if (els.name)   els.name.value = e.name;
                    if (els.author) els.author.value = e.author || '';
                    renderLibrary();
                    say('Loaded "' + e.name + '".');
                }
            });
            row.appendChild(load);

            const del = document.createElement('button');
            del.type = 'button'; del.textContent = '✕'; del.className = 'meDel';
            del.title = 'Delete "' + e.name + '"';
            del.addEventListener('click', () => {
                if (!window.confirm('Delete "' + e.name + '"?')) return;
                MosaicLibrary.remove(e.id);
                if (editingId === e.id) editingId = null;
                renderLibrary();
                say('Deleted "' + e.name + '".');
            });
            row.appendChild(del);

            els.list.appendChild(row);
        }
    }

    // ── Stats readout ────────────────────────────────────────────────────

    function renderStats() {
        if (!els.stats) return;
        const layout = currentLayout();
        const d = MosaicLibrary.difficulty(layout);
        const check = MosaicLibrary.validate(layout);
        const pct = (x) => Math.round(x * 100) + '%';

        const sizes = Object.keys(d.bySize).map(Number).sort((a, b) => a - b)
            .map((s) => d.bySize[s] + '×' + s).join(', ') || '—';

        const lines = [
            ['Board',    rows + ' × ' + cols + '  (' + d.area + ' sub-tiles)'],
            ['Pieces',   d.pieces + '   [' + sizes + ']'],
            ['Coverage', d.covered + ' / ' + d.area + '  =  ' + pct(d.coverage)],
            ['Singular', d.singles + ' cells'],
            ['Mean piece', d.pieces ? d.meanPieceSize.toFixed(1) + ' cells' : '—'],
        ];

        const table = document.createElement('table');
        table.className = 'meStatTable';
        for (const [k, v] of lines) {
            const tr = document.createElement('tr');
            const th = document.createElement('th'); th.textContent = k;
            const td = document.createElement('td'); td.textContent = v;
            tr.appendChild(th); tr.appendChild(td);
            table.appendChild(tr);
        }
        els.stats.innerHTML = '';
        els.stats.appendChild(table);

        // The score, and the arithmetic behind it — a designer aiming at a
        // tier needs to see which half of the formula is short.
        if (els.score) {
            els.score.innerHTML = '';
            const big = document.createElement('div');
            big.className = 'meScoreBig';
            big.textContent = 'Tier ' + d.tier + ' · ' + d.tierName;
            const num = document.createElement('div');
            num.className = 'meScoreNum';
            num.textContent = 'difficulty ' + d.score + ' / 100';
            const work = document.createElement('div');
            work.className = 'meScoreWork';
            // Coverage is shown raw → effective so the complexity
            // amplification is visible (big interlocking pieces lift it;
            // a board of 2×2s shows the same number twice), and ganged
            // as the points it shaves — more gangs, easier board. The
            // EFFECTIVE ganged is shown: every piece is a mandatory gang
            // member, so the input's floor (set below) is what actually
            // scores.
            const reliefPts = Math.round(100 * d.gangedRelief);
            work.textContent = 'size ' + pct(d.sizeScore) + ' × ' + MosaicLibrary.W_SIZE +
                               '  +  coverage ' + pct(d.coverScore) + '→' + pct(d.coverEffect) +
                               ' (complexity ' + pct(d.complexity) + ') × ' + MosaicLibrary.W_COVER +
                               '  −  ganged ' + pct(d.gangedEffective) + ' → ' + reliefPts + ' pts';
            els.score.appendChild(big);
            els.score.appendChild(num);
            els.score.appendChild(work);
            els.score.style.setProperty('--meTier', d.tier);
        }

        if (els.warn) {
            const msgs = check.errors.concat(check.warnings);
            els.warn.textContent = msgs.join(' · ');
            els.warn.hidden = msgs.length === 0;
            els.warn.classList.toggle('bad', check.errors.length > 0);
        }

        // Ganged % FLOOR (the every-piece mandate): the build gangs every
        // multi-cell piece regardless, so values below the pieces' unit
        // share aren't selectable — the slider's min tracks the layout
        // live and the value is bumped up onto the floor when a new
        // piece drops it below. Percent is ceil'd so the min is never
        // fractionally under the true floor.
        if (els.twins) {
            const minPct = Math.min(80, Math.ceil(100 * d.gangedFloor));
            els.twins.min = minPct;
            const cur = parseInt(els.twins.value, 10);
            if (!isFinite(cur) || cur < minPct) els.twins.value = minPct;
        }
        syncSliderReadouts();
    }

    // The sliders' value readouts (rows / cols / ganged % / test paths).
    // Called from every path that can move a slider — live 'input' ticks,
    // loadLayout and setDims writing values back, and renderStats' floor
    // bump.
    function syncSliderReadouts() {
        if (els.rowsVal  && els.rows)  els.rowsVal.textContent  = els.rows.value;
        if (els.colsVal  && els.cols)  els.colsVal.textContent  = els.cols.value;
        if (els.twinsVal && els.twins) els.twinsVal.textContent = els.twins.value;
        if (els.pathsVal && els.paths) els.pathsVal.textContent = els.paths.value;
    }

    function say(msg, bad) {
        if (!els.msg) return;
        els.msg.textContent = msg || '';
        els.msg.classList.toggle('bad', !!bad);
    }

    function renderAll() {
        drawBoard();
        renderStats();
    }

    // ── Test play ────────────────────────────────────────────────────────

    // A healthy build needs at least this many twists per path
    // (minSolveMoves prices lockstep rings as one motion, so this is
    // deliberately conservative — the twin-free test fixtures floor at
    // 9-47 while the degenerate boards this guards against floor at 1-3).
    const MIN_HEALTHY_MOVES_PER_PATH = 4;

    // Build a real puzzle on the current layout and hand it to the game —
    // via PotdGen2.playDesign (2026-08-15), which owns the whole designed-
    // mosaic pipeline: worker build when one is available (main-thread
    // fallback otherwise), twin rings at the requested piece coverage,
    // gate placement, and the ACTIVE-DESIGN loop — solving the board and
    // clicking for a new puzzle regenerates this same layout instead of
    // reverting to a panel roll. The button disables itself so a second
    // press can't queue a competing build.
    async function testPlay() {
        if (building) return;
        const layout = currentLayout();
        const check = MosaicLibrary.validate(layout);
        if (!check.ok) { say('Cannot build: ' + check.errors.join('; '), true); return; }
        if (typeof PotdGen2 === 'undefined' || !PotdGen2.playDesign) {
            say('PotdGen2.playDesign unavailable', true);
            return;
        }

        building = true;
        if (els.test) els.test.disabled = true;
        say('Building…');
        const paths = els.paths ? (parseInt(els.paths.value, 10) || 1) : 1;

        try {
            // Ganged % rides inside the layout (currentLayout reads the
            // input); the gate count is NOT ours to pass — playDesign
            // derives it from the grid size, the same curve live play
            // uses (user call 2026-08-15).
            const res = await PotdGen2.playDesign({
                layout: layout,
                pathCount: paths,
            });
            // NEAR-SOLVED GUARDRAIL (user call 2026-08-15): minSolveMoves
            // is the "was this board born solved-ish" number — grouping
            // plus size can leave a build needing only a twist or two
            // (field report: a big-piece design presented as good as
            // won). Below ~MIN_HEALTHY_MOVES_PER_PATH twists per path,
            // hold the editor open with the warning instead of closing
            // silently over a degenerate board; the board IS loaded and
            // playable behind the panel, so Close still inspects it.
            // One build is one sample — the same layout can build fine
            // on the next press — which is why this warns rather than
            // refuses, and it's the same check a submission gate would
            // run server-side before admitting a player design.
            const floorWarn = res && res.minMoves != null &&
                              res.minMoves < MIN_HEALTHY_MOVES_PER_PATH * paths;
            if (floorWarn) {
                say('⚠ This build needs only ' + res.minMoves + ' move(s) to solve — ' +
                    'near-solved for ' + paths + ' path(s) (healthy ≈ ' +
                    (MIN_HEALTHY_MOVES_PER_PATH * paths) + '+). Rework the layout or ' +
                    'Test again (each build varies); Close inspects this board.', true);
            } else {
                close();
            }
            if (res && typeof Logger !== 'undefined') {
                const stats = Maze.mosaicStats ? Maze.mosaicStats() : null;
                Logger.info('[mosaic-editor] built in ' + Math.round(res.mazeMs) + 'ms' +
                            (stats ? ' — ' + stats.pieces + ' pieces, ' + stats.dissolved + ' dissolved' : '') +
                            (res.twins ? ' — ganged ' + res.twins.groups + ' rings' : '') +
                            ' — gates ' + res.gatesPlaced +
                            (res.minMoves != null ? ' — ' + res.minMoves + ' moves' : ''));
            }
        } catch (err) {
            say('Build failed: ' + ((err && err.message) ? err.message : err), true);
            if (typeof Logger !== 'undefined') Logger.warn('[mosaic-editor] build failed', err);
        } finally {
            building = false;
            if (els.test) els.test.disabled = false;
        }
    }

    // ── Open / close ─────────────────────────────────────────────────────

    function openEditor() {
        if (!els.panel) return;
        open = true;
        els.panel.classList.add('visible');
        renderLibrary();
        // The panel's box only exists once it is displayed, so sizing has to
        // happen after the class lands — a frame later, not synchronously.
        requestAnimationFrame(() => { refit(); renderAll(); });
    }

    function close() {
        if (!els.panel) return;
        open = false;
        els.panel.classList.remove('visible');
        hideGhost();
    }

    function toggle() { open ? close() : openEditor(); }

    // ── Wiring ───────────────────────────────────────────────────────────

    function init() {
        if (initialized) return;
        initialized = true;

        const $ = (id) => document.getElementById(id);
        els = {
            panel: $('mosaicEditor'), board: $('meBoard'), boardWrap: $('meBoardWrap'),
            palette: $('mePalette'), stats: $('meStats'), score: $('meScore'),
            warn: $('meWarn'), msg: $('meMsg'), list: $('meList'),
            rows: $('meRows'), cols: $('meCols'), paths: $('mePaths'),
            twins: $('meTwins'),
            rowsVal: $('meRowsVal'), colsVal: $('meColsVal'),
            twinsVal: $('meTwinsVal'), pathsVal: $('mePathsVal'),
            name: $('meName'), author: $('meAuthor'),
            io: $('meIO'), test: $('meTestBtn'), ghost: null
        };
        if (!els.panel || !els.board) return;   // markup absent — nothing to wire

        rebuildOcc();
        buildPalette();

        els.board.addEventListener('pointerdown', onBoardPointerDown);
        els.board.addEventListener('contextmenu', onBoardContextMenu);

        // Dims COMMIT on 'change' (slider release), not per input tick —
        // setDims prunes pieces that no longer fit, and a live-committing
        // drag from 19 rows down to 10 would delete pieces at every size
        // it passed through. The readout still tracks the thumb live.
        const onDim = () => setDims(parseInt(els.rows.value, 10), parseInt(els.cols.value, 10));
        if (els.rows) {
            els.rows.addEventListener('change', onDim);
            els.rows.addEventListener('input', syncSliderReadouts);
        }
        if (els.cols) {
            els.cols.addEventListener('change', onDim);
            els.cols.addEventListener('input', syncSliderReadouts);
        }
        // Ganged % feeds the difficulty score (as relief — see
        // mosaic-library.js), so the readout re-ranks live as the
        // designer drags the slider. renderStats also re-syncs the value
        // readouts, covering its own floor-bump of the slider.
        if (els.twins) els.twins.addEventListener('input', renderStats);
        // Test paths only feeds the next build — nothing to re-rank,
        // just the readout to keep in step with the thumb.
        if (els.paths) els.paths.addEventListener('input', syncSliderReadouts);

        const bind = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
        bind('meOpenBtn',   openEditor);   // the debug panel's entry point
        bind('meCloseBtn',  close);
        bind('meClearBtn',  clearBoard);
        bind('meAutoBtn',   autoFill);
        bind('meSaveBtn',   saveCurrent);
        bind('meTestBtn',   testPlay);
        bind('meNewBtn', () => {
            clearBoard();
            if (els.name) els.name.value = '';
            renderLibrary();
        });
        bind('meExportBtn', () => {
            if (!els.io) return;
            els.io.value = MosaicLibrary.exportAll();
            say('Exported the whole library — copy it out of the box.');
        });
        bind('meImportBtn', () => {
            if (!els.io) return;
            const res = MosaicLibrary.importAll(els.io.value);
            if (!res.ok) { say('Import failed: ' + res.error, true); return; }
            renderLibrary();
            say('Imported — ' + res.added + ' added, ' + res.replaced + ' replaced, ' + res.skipped + ' skipped.');
        });
        bind('meCodeBtn', () => {
            if (!els.io) return;
            els.io.value = MosaicLibrary.encode(currentLayout()) || '';
            say('Compact code for the current layout.');
        });
        bind('meLoadCodeBtn', () => {
            if (!els.io) return;
            const l = MosaicLibrary.decode(els.io.value.trim());
            if (!l) { say('That is not a valid layout code.', true); return; }
            loadLayout(l, null);
            say('Loaded from code.');
        });

        // Keyboard. CAPTURE phase so Escape closes the editor rather than
        // reaching index.html's debug handler, which would toggle .dbgHidden
        // underneath the open panel.
        document.addEventListener('keydown', (ev) => {
            if (!open) {
                // Ctrl+M opens the editor from the debug panel. Same gate as
                // everything else here — mode-debug only.
                if (ev.ctrlKey && (ev.key === 'm' || ev.key === 'M') &&
                    document.documentElement.classList.contains('mode-debug')) {
                    ev.preventDefault();
                    openEditor();
                }
                return;
            }
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
                if (ev.key === 'Escape') t.blur();
                return;
            }
            if (ev.key === 'Escape') {
                ev.preventDefault(); ev.stopPropagation();
                if (selected >= 0) { selected = -1; renderAll(); } else { close(); }
            } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
                ev.preventDefault(); deleteSelected();
            } else if (ev.key === 'ArrowUp')    { ev.preventDefault(); ev.stopPropagation(); nudgeSelected(-1, 0); }
            else if (ev.key === 'ArrowDown')  { ev.preventDefault(); ev.stopPropagation(); nudgeSelected(1, 0); }
            else if (ev.key === 'ArrowLeft')  { ev.preventDefault(); ev.stopPropagation(); nudgeSelected(0, -1); }
            else if (ev.key === 'ArrowRight') { ev.preventDefault(); ev.stopPropagation(); nudgeSelected(0, 1); }
        }, true);

        window.addEventListener('resize', () => {
            if (!open) return;
            refit();
            renderAll();
        });

        renderStats();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        open: openEditor,
        close: close,
        toggle: toggle,
        isOpen: function () { return open; },
        // Exposed for the console: hand it a layout (or a code string) to
        // load one without going through the library list.
        load: function (layoutOrCode) {
            const l = (typeof layoutOrCode === 'string')
                ? MosaicLibrary.decode(layoutOrCode)
                : MosaicLibrary.normalize(layoutOrCode);
            return l ? loadLayout(l, null) : false;
        }
    };
})();
