/**
 * maze-worker.js — pre-generates puzzles on a worker thread.
 *
 * The main thread posts {type: 'generate', rows, cols, ...} to queue a
 * build. The worker imports maze.js (which gives it its OWN private Maze
 * instance, separate from the main thread's), runs Maze.init(), and posts
 * back {type: 'ready', state: snapshot, ...} when each build completes.
 *
 * Two priority tiers:
 *   - normal: append to `pending` queue, processed FIFO. Used by both the
 *     8-starter prefill (s1..s4, q1..q4 at level-1 dims) at page load and
 *     by the lookahead pre-gen during gameplay (PREGEN_LOOKAHEAD ahead).
 *   - urgent: replaces the entire `pending` queue with just this job and
 *     calls Maze.setAbort() so the in-flight build bails at its next
 *     attempt boundary. Used when the player picks a Marathon type whose
 *     starter isn't cached yet AND isn't currently being built — we drop
 *     whatever the worker was doing so it can race to build the puzzle
 *     the player is waiting on.
 *
 * Aborted builds don't post a 'ready' message — the partial Maze state is
 * unsafe to ship as a snapshot. The main thread tracks its own in-flight
 * request, so a build that vanishes without a response just leaves that
 * request unresolved until the main thread re-queues it.
 *
 * `id` is echoed back so callers running multiple independent request
 * streams (marathon pre-gen + PotD bg gen) can match responses to requests.
 * Marathon's flow doesn't set an id; its handler ignores the field.
 */

// Match the page's cache-busting strategy — pull the cache-buster from
// our own URL so the worker's maze.js fetches in lockstep with the
// page's maze.js. Without this the worker can latch onto a stale copy
// even after a page reload.
(function () {
    var match = self.location.search && self.location.search.match(/[?&]t=([^&]+)/);
    var bust = match ? match[1] : Date.now();
    importScripts('maze.js?t=' + bust);
})();

// FIFO queue of jobs waiting to build. New normal-priority requests
// append; urgent requests replace the entire queue with just themselves
// (and set the abort flag so the in-flight build releases the worker
// thread immediately).
let pending  = [];
let inFlight = false;

async function processNext() {
    if (inFlight) return;
    inFlight = true;
    while (pending.length > 0) {
        const req = pending.shift();
        Maze.setQuadMode(!!req.quadMode);
        Maze.setPathCount(req.pathCount);
        Maze.setDimensions(req.rows, req.cols);
        const completed = await Maze.init();
        if (completed) {
            postMessage({
                type: 'ready', state: Maze.snapshotState(),
                pathCount: req.pathCount, quadMode: !!req.quadMode,
                id: req.id != null ? req.id : null
            });
        }
        // If !completed (abort flagged mid-build), drop silently. The
        // abort was triggered by an urgent enqueue, which has already
        // populated `pending` with the replacement job — the next loop
        // iteration picks it up.
    }
    inFlight = false;
}

self.onmessage = function (e) {
    if (!e.data) return;
    if (e.data.type === 'generate') {
        const job = {
            rows: e.data.rows, cols: e.data.cols,
            pathCount: e.data.pathCount | 0 || 1,
            quadMode: !!e.data.quadMode,
            id: (e.data.id != null) ? e.data.id : null
        };
        if (e.data.urgent) {
            // Drop everything else and prioritize THIS job. Abort flag
            // makes any in-flight Maze.init return false at its next
            // attempt boundary, so the worker loop picks the urgent
            // job up within ~1 buildPuzzle attempt instead of waiting
            // out the full search.
            pending = [job];
            if (inFlight && Maze.setAbort) Maze.setAbort();
        } else {
            pending.push(job);
        }
        processNext();
    } else if (e.data.type === 'hurry') {
        Maze.setHurry();
    }
};
