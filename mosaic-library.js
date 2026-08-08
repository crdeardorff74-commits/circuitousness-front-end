/**
 * mosaic-library.js — the format, the difficulty ranking, and the store for
 * HAND-AUTHORED mosaic layouts.
 *
 * WHY THIS EXISTS
 * ───────────────
 * mosaic.js's pack() throws random darts at the board. That mechanism is
 * staying — it is what makes an arbitrary board size fill instantly — but it
 * is not how mosaic puzzles are meant to be SHIPPED. Shipped puzzles are
 * designed: laid out by hand in the editor (mosaic-editor.js), ranked by
 * difficulty, and stored in a library that a run draws from in increasing
 * order of difficulty.
 *
 * WHAT A LAYOUT IS, AND WHAT IT ISN'T
 * ───────────────────────────────────
 * A layout is the PIECE PACKING ONLY — which mosaic shapes sit where on a
 * rows×cols board. It is NOT a maze. The wiring (paths, ports, twins, gates,
 * the scramble) is still generated fresh by maze.js every time the layout is
 * played, so one authored layout yields an endless supply of distinct
 * puzzles that all share its designed shape. That split is also what makes
 * the difficulty ranking below well-defined: both of its inputs are
 * properties of the layout, and neither depends on the maze rolled on top.
 *
 * DIFFICULTY
 * ──────────
 * Per the design call: difficulty is board SIZE combined with the PERCENTAGE
 * of the board covered by mosaic (non-singular) pieces. Nothing else. Both
 * halves are motivated:
 *   • Size — more sub-tiles is more to read and more to turn.
 *   • Coverage — a singular cell rotates alone, so it can be solved locally.
 *     A cell inside a piece cannot: turning it moves every other cell of that
 *     piece too. Coverage is therefore the fraction of the board that has to
 *     be reasoned about non-locally, which is the thing that actually makes
 *     mosaic hard. At 0% coverage a "mosaic" board is a singular board.
 *
 * Deliberately NOT in the score, so this doesn't quietly become a different
 * metric than the one that was specified: piece size distribution, hole
 * nesting, path count, twin coverage, gate count. Piece size is the most
 * defensible future addition (a 5×5 ring is harder than four 2×2 blocks at
 * identical coverage) — the editor SHOWS mean piece size next to the score
 * for exactly that reason, without folding it in.
 *
 * STORAGE
 * ───────
 * localStorage today, a `mosaic_layouts` table on the Render back-end later.
 * The entry shape below is already the row shape — id / name / author /
 * layout / difficulty / tier / createdAt — so promoting it is a transport
 * change rather than a format change, and the compact encode() string is
 * what would travel in the payload (a layout is a few hundred bytes; it
 * wants a text column, not a file host).
 *
 * Pure logic, no DOM: mosaic-editor.js owns every pixel. That keeps this
 * file testable headlessly (../tests/mosaic-library-test.js) and lets the
 * back end eventually re-implement difficulty() against the same constants.
 */

const MosaicLibrary = (function () {

    // Bumped only on a BREAKING format change. decode()/normalize() refuse
    // anything they don't recognise rather than guessing, because a
    // misparsed layout is a silently wrong puzzle, not a crash.
    const FORMAT_VERSION = 1;

    // Board bounds, in sub-tiles. The floor is 4 — the smallest board the
    // generator rolls, and the smallest that can hold any piece at all
    // (a 5×5 shape needs 5, but a board that can't fit one is still a legal
    // if pointless design). The ceiling is 24, comfortably above the PotD
    // size slider's 20, because a hand-authored showpiece is allowed to be
    // bigger than anything the roller produces.
    const MIN_DIM = 4;
    const MAX_DIM = 24;

    // ── Difficulty ───────────────────────────────────────────────────────
    //
    // score = 100 × (W_SIZE × sizeScore + W_COVER × coverScore), 0..100.
    //
    // sizeScore normalises area against the range of boards the game
    // actually plays: 4×4 = 16 is the opening board of a run, 16×16 = 256 is
    // past anything the PotD roller can produce. Bigger than the ceiling
    // clamps to 1 rather than running away — a 24×24 board is not four times
    // harder than a 12×12.
    //
    // coverScore is the coverage fraction itself, unweighted. Linear is the
    // literal reading of the spec and there is no measurement yet that would
    // justify a curve; revisit it when there are real solve times per tier.
    const AREA_FLOOR = 16;
    const AREA_CEIL  = 256;
    const W_SIZE  = 0.5;
    const W_COVER = 0.5;

    // Tiers are the thing a run actually selects on — "give me the next
    // puzzle, a little harder than the last". Ten of them across 0..100, so
    // a tier is a 10-point band. Names are for the editor readout only.
    const TIER_COUNT = 10;
    const TIER_NAMES = [
        'Trivial', 'Very easy', 'Easy', 'Light', 'Moderate',
        'Firm', 'Hard', 'Very hard', 'Brutal', 'Punishing'
    ];

    function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

    /**
     * Rank a layout. Returns everything that went into the number, not just
     * the number — the editor shows the workings so a designer can see WHY a
     * board landed where it did, and the eventual DB row stores the inputs
     * alongside the score so a formula change can be recomputed offline
     * instead of re-derived from scratch.
     */
    function difficulty(layout) {
        const l = layout || {};
        const rows = l.rows | 0, cols = l.cols | 0;
        const area = Math.max(0, rows * cols);

        // Count coverage the same way the board will actually be built —
        // through packFromLayout — so a piece that is out of bounds or
        // overlapping contributes nothing here either. A score computed off
        // the raw piece list would over-report exactly the layouts that are
        // broken.
        let covered = 0, pieces = 0, largestFrame = 0;
        const bySize = {};
        if (area > 0 && typeof Mosaic !== 'undefined') {
            const packed = Mosaic.packFromLayout(rows, cols, l.pieces || []);
            for (const g of packed.groups) {
                if (g.single) continue;
                pieces++;
                covered += g.size;
                bySize[g.size] = (bySize[g.size] || 0) + 1;
                if (g.n > largestFrame) largestFrame = g.n;
            }
        }

        const coverage   = area > 0 ? covered / area : 0;
        const sizeScore  = clamp01((area - AREA_FLOOR) / (AREA_CEIL - AREA_FLOOR));
        const coverScore = clamp01(coverage);
        const score      = Math.round(100 * (W_SIZE * sizeScore + W_COVER * coverScore));
        // floor(score/10) is 0..10 — a perfect 100 would otherwise be an
        // eleventh tier of exactly one score.
        const tier = Math.min(TIER_COUNT, Math.floor(score / 10) + 1);

        return {
            area: area, rows: rows, cols: cols,
            pieces: pieces, covered: covered, singles: area - covered,
            coverage: coverage,
            meanPieceSize: pieces ? covered / pieces : 0,
            largestFrame: largestFrame,
            bySize: bySize,
            sizeScore: sizeScore, coverScore: coverScore,
            score: score, tier: tier, tierName: TIER_NAMES[tier - 1]
        };
    }

    // ── Layout construction + validation ─────────────────────────────────

    function makeLayout(rows, cols, pieces) {
        return {
            v: FORMAT_VERSION,
            rows: rows, cols: cols,
            pieces: (pieces || []).map((p) => ({ n: p.n, mask: p.mask, r: p.r, c: p.c }))
        };
    }

    /**
     * Is this layout structurally sound? Returns { ok, errors, warnings }.
     *
     * ERRORS are things that make the layout unusable as stored — bad dims,
     * a shape the library doesn't contain, a piece off the board or on top
     * of another. WARNINGS are things a designer probably didn't mean but
     * that build fine: an empty board (which is just a singular board), or
     * coverage so low the mode barely shows.
     *
     * Note what is NOT checked: whether maze.js can wire a solvable puzzle
     * onto this packing. It always can — every piece is rotation-invariant
     * by construction and any piece whose interior turns out unsatisfiable
     * is dissolved back into singular cells at scramble time (maze.js's
     * scrambleMosaic). A layout cannot be "unsolvable"; it can only be
     * denser or sparser than the designer intended.
     */
    function validate(layout) {
        const errors = [], warnings = [];
        const l = layout || {};

        if (l.v !== FORMAT_VERSION) errors.push('unknown format version: ' + l.v);
        const rows = l.rows | 0, cols = l.cols | 0;
        if (rows < MIN_DIM || rows > MAX_DIM) errors.push('rows out of range: ' + l.rows);
        if (cols < MIN_DIM || cols > MAX_DIM) errors.push('cols out of range: ' + l.cols);
        if (!Array.isArray(l.pieces)) errors.push('pieces is not an array');

        if (errors.length === 0) {
            const packed = Mosaic.packFromLayout(rows, cols, l.pieces);
            for (const s of packed.skipped) {
                errors.push('piece ' + s.i + ': ' + s.why);
            }
            const d = difficulty(l);
            if (d.pieces === 0) {
                warnings.push('no pieces — this builds as an ordinary singular board');
            } else if (d.coverage < 0.15) {
                warnings.push('only ' + Math.round(d.coverage * 100) + '% mosaic coverage');
            }
        }

        return { ok: errors.length === 0, errors: errors, warnings: warnings };
    }

    // Accept an untrusted object (parsed JSON, a server response, an older
    // export) and return a clean layout, or null. Coerces number-shaped
    // fields, drops anything unrecognised. Deliberately strict about the
    // version — see FORMAT_VERSION.
    function normalize(raw) {
        if (!raw || typeof raw !== 'object') return null;
        if ((raw.v | 0) !== FORMAT_VERSION) return null;
        const rows = raw.rows | 0, cols = raw.cols | 0;
        if (rows < MIN_DIM || rows > MAX_DIM || cols < MIN_DIM || cols > MAX_DIM) return null;
        if (!Array.isArray(raw.pieces)) return null;
        const pieces = [];
        for (const p of raw.pieces) {
            if (!p || typeof p !== 'object') return null;
            const n = p.n | 0, mask = p.mask | 0, r = p.r | 0, c = p.c | 0;
            if (!Mosaic.findShape(n, mask)) return null;
            pieces.push({ n: n, mask: mask, r: r, c: c });
        }
        return { v: FORMAT_VERSION, rows: rows, cols: cols, pieces: pieces };
    }

    // ── Compact string form ──────────────────────────────────────────────
    //
    // "M1:10x8:3,0,0,186:2,4,2,15" — version, dims, then one
    // `n,r,c,mask` group per piece. ~12 characters a piece, so a dense
    // 12×12 board is under 400 bytes: small enough for a share code, a URL,
    // or a text column, and readable enough to eyeball in a database row.
    // JSON round-trips too (toJSON/fromJSON below) and is what the local
    // store keeps; this is the wire form.

    function encode(layout) {
        const l = normalize(layout);
        if (!l) return null;
        const parts = ['M' + FORMAT_VERSION, l.rows + 'x' + l.cols];
        for (const p of l.pieces) parts.push([p.n, p.r, p.c, p.mask].join(','));
        return parts.join(':');
    }

    function decode(str) {
        if (typeof str !== 'string') return null;
        const parts = str.trim().split(':');
        if (parts.length < 2) return null;
        if (parts[0] !== 'M' + FORMAT_VERSION) return null;
        const dims = parts[1].split('x');
        if (dims.length !== 2) return null;
        const pieces = [];
        for (let i = 2; i < parts.length; i++) {
            if (!parts[i]) continue;
            const f = parts[i].split(',');
            if (f.length !== 4) return null;
            pieces.push({ n: +f[0], r: +f[1], c: +f[2], mask: +f[3] });
        }
        return normalize({ v: FORMAT_VERSION, rows: +dims[0], cols: +dims[1], pieces: pieces });
    }

    // ── Entries + the store ──────────────────────────────────────────────
    //
    // One entry is one library puzzle. `difficulty`/`tier` are DENORMALISED
    // onto it on purpose: selection wants to sort and filter by them without
    // re-packing every layout, and the back end will want them as indexed
    // columns for the same reason. rank() recomputes both, so a formula
    // change is a migration, not a rewrite.

    const STORE_KEY = (typeof PROJECT_SLUG !== 'undefined' ? PROJECT_SLUG : 'circuitousness')
        + '_mosaicLib_v1';

    let idCounter = 0;
    function newId() {
        idCounter++;
        return 'ml_' + Date.now().toString(36) + '_' + idCounter.toString(36);
    }

    // Attach/refresh the denormalised ranking on an entry.
    function rank(entry) {
        const d = difficulty(entry.layout);
        entry.difficulty = d.score;
        entry.tier = d.tier;
        return entry;
    }

    function makeEntry(name, layout, author) {
        return rank({
            id: newId(),
            name: (name || 'Untitled').toString().slice(0, 60),
            author: (author || '').toString().slice(0, 40),
            layout: normalize(layout),
            createdAt: new Date().toISOString()
        });
    }

    // localStorage throws in private mode and on quota — every access here
    // is wrapped, and a failure degrades to "the library is empty" rather
    // than taking the editor down with it.
    function readStore() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            const out = [];
            for (const e of arr) {
                const layout = normalize(e && e.layout);
                if (!layout) continue;             // drop, don't fail the load
                out.push(rank({
                    id: e.id || newId(),
                    name: e.name || 'Untitled',
                    author: e.author || '',
                    layout: layout,
                    createdAt: e.createdAt || new Date().toISOString()
                }));
            }
            return out;
        } catch (err) { return []; }
    }

    function writeStore(entries) {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(entries));
            return true;
        } catch (err) { return false; }
    }

    // Difficulty-ascending, which is the order a run consumes them in —
    // ties broken by name so the list doesn't reshuffle on every save.
    function sorted(entries) {
        return entries.slice().sort((a, b) =>
            (a.difficulty - b.difficulty) || a.name.localeCompare(b.name));
    }

    function list() { return sorted(readStore()); }

    function get(id) {
        for (const e of readStore()) if (e.id === id) return e;
        return null;
    }

    // Save an entry, replacing one with the same id. Returns the stored
    // entry, or null if the layout was rejected or the write failed.
    function save(entry) {
        if (!entry || !normalize(entry.layout)) return null;
        const entries = readStore();
        const clean = rank({
            id: entry.id || newId(),
            name: (entry.name || 'Untitled').toString().slice(0, 60),
            author: (entry.author || '').toString().slice(0, 40),
            layout: normalize(entry.layout),
            createdAt: entry.createdAt || new Date().toISOString()
        });
        const at = entries.findIndex((e) => e.id === clean.id);
        if (at >= 0) entries[at] = clean; else entries.push(clean);
        return writeStore(entries) ? clean : null;
    }

    function remove(id) {
        const entries = readStore();
        const kept = entries.filter((e) => e.id !== id);
        if (kept.length === entries.length) return false;
        return writeStore(kept);
    }

    // Export/import the whole library as one JSON blob — the hand-off to the
    // back end until there is a back end, and the only backup a localStorage
    // store has. Import MERGES by id (an entry already present is replaced,
    // a new one appended) rather than replacing the store wholesale, so
    // importing someone else's puzzles can't wipe your own.
    function exportAll() {
        return JSON.stringify({ v: FORMAT_VERSION, entries: readStore() }, null, 2);
    }

    function importAll(json) {
        let parsed;
        try { parsed = JSON.parse(json); } catch (err) { return { ok: false, error: 'not valid JSON' }; }
        const incoming = Array.isArray(parsed) ? parsed
            : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
        if (!incoming) return { ok: false, error: 'no entries array' };

        const entries = readStore();
        let added = 0, replaced = 0, skipped = 0;
        for (const raw of incoming) {
            const layout = normalize(raw && raw.layout);
            if (!layout) { skipped++; continue; }
            const clean = rank({
                id: raw.id || newId(),
                name: raw.name || 'Untitled',
                author: raw.author || '',
                layout: layout,
                createdAt: raw.createdAt || new Date().toISOString()
            });
            const at = entries.findIndex((e) => e.id === clean.id);
            if (at >= 0) { entries[at] = clean; replaced++; }
            else { entries.push(clean); added++; }
        }
        if (!writeStore(entries)) return { ok: false, error: 'could not write to localStorage' };
        return { ok: true, added: added, replaced: replaced, skipped: skipped };
    }

    return {
        FORMAT_VERSION: FORMAT_VERSION,
        MIN_DIM: MIN_DIM, MAX_DIM: MAX_DIM,
        AREA_FLOOR: AREA_FLOOR, AREA_CEIL: AREA_CEIL,
        W_SIZE: W_SIZE, W_COVER: W_COVER,
        TIER_COUNT: TIER_COUNT, TIER_NAMES: TIER_NAMES,
        STORE_KEY: STORE_KEY,

        difficulty: difficulty,
        makeLayout: makeLayout,
        validate: validate,
        normalize: normalize,
        encode: encode,
        decode: decode,

        makeEntry: makeEntry,
        rank: rank,
        list: list,
        get: get,
        save: save,
        remove: remove,
        exportAll: exportAll,
        importAll: importAll
    };
})();

// Node compatibility for the headless test harness (../tests/). The browser
// gets Mosaic from its own <script> tag; Node has to be handed it.
if (typeof module !== 'undefined' && module.exports) module.exports = MosaicLibrary;
