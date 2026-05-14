/**
 * maze-worker.js — pre-generates the next puzzle on a worker thread.
 *
 * The main thread posts {type: 'generate', rows, cols} when it wants the
 * next puzzle pre-built. The worker imports maze.js (which gives it its
 * OWN private Maze instance, separate from the main thread's), runs
 * Maze.init(), and posts back {type: 'ready', state: snapshot} where
 * `state` is a structured-cloneable snapshot the main thread can hand to
 * Maze.loadSnapshot(). Several requests can arrive while one is in
 * flight — we always honor the most recent one, dropping any older
 * pending generation. The main thread is responsible for discarding
 * stale results (e.g. if the user changed grid size mid-build).
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

let pending = null;     // queued request, replaces older pending requests
let inFlight = false;

async function processNext() {
    if (inFlight) return;
    inFlight = true;
    while (pending) {
        const req = pending;
        pending = null;
        Maze.setQuadMode(!!req.quadMode);
        Maze.setPathCount(req.pathCount);
        Maze.setDimensions(req.rows, req.cols);
        await Maze.init();
        postMessage({
            type: 'ready', state: Maze.snapshotState(),
            pathCount: req.pathCount, quadMode: !!req.quadMode
        });
    }
    inFlight = false;
}

self.onmessage = function (e) {
    if (!e.data) return;
    if (e.data.type === 'generate') {
        pending = {
            rows: e.data.rows, cols: e.data.cols,
            pathCount: e.data.pathCount | 0 || 1,
            quadMode: !!e.data.quadMode
        };
        processNext();
    } else if (e.data.type === 'hurry') {
        Maze.setHurry();
    }
};
