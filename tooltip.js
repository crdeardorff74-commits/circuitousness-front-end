/**
 * tooltip.js — once-each first-play educational tooltips.
 *
 * Public API:
 *   Tooltip.showOnce(key, message, action?, onAcknowledge?)
 *     action — optional { label, onClick }: renders a second button beside
 *     Got It (e.g. the first-run PotD nudge's "jump into today's puzzle").
 *     Clicking it marks the tip seen, dismisses, THEN runs onClick — that
 *     order lets onClick tear game state down without racing the card.
 *     onAcknowledge — optional callback fired once when the player
 *     acknowledges the tip — via EITHER button (Got It or the action), or
 *     by solving the puzzle under it — right after the seen-flag persists
 *     and before the action's onClick. NOT fired when the player navigates
 *     away unread (dismissActive(false)); the tip re-queues and the
 *     callback gets its chance on the real acknowledgment. (e.g. the
 *     firstPlay tip revealing the in-HUD How-to-Solve button.)
 *   Tooltip.dismissSolved()      — the puzzle under the tip was SOLVED.
 *     Marks the on-screen tip seen (it never comes back) and drops the
 *     rest of the queue unread.
 *   Tooltip.cancelPending(key)   — remove a queued (but not-yet-shown) tip
 *   Tooltip.showBoardMechanicTips() — fire the twin-tile / gate
 *     explainers if the CURRENT board contains either. Board-driven
 *     rather than level-driven; see the function's own comment.
 *
 * Each `key` corresponds to a localStorage flag (`<slug>_tooltipSeen_<key>`)
 * that flips to '1' when the player dismisses the tooltip via "Got it!".
 * Subsequent showOnce calls with the same key are no-ops.
 *
 * Tooltips queue: if one is already on-screen when another fires, the
 * second waits. After the player dismisses #1, #2 appears. This matters
 * for the lock-tip + mode-hint-tip interaction — both might queue in the
 * first 30s of a player's first puzzle, and we don't want them stacking.
 *
 * The DOM markup lives in index.html under #tooltipOverlay; this module
 * only swaps the textContent of #tooltipText and toggles `hidden` on the
 * overlay. Click handlers are added/removed per-show so we don't leak
 * listeners across cards. Reuses the .combo-modal styling system for
 * visual consistency with the PotD disclaimer + mode-picker modals.
 */
const Tooltip = (function () {
    const SEEN_PREFIX = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'app')
                        + '_tooltipSeen_';
    const TUTORIAL_WATCHED_KEY = (typeof PROJECT_SLUG === 'string' ? PROJECT_SLUG : 'app')
                        + '_tutorialWatched';
    // Tips whose lesson the How-to-Solve tutorial already teaches in richer
    // form. Once the player has watched the tutorial, these never fire during
    // gameplay. (Hint tips like potdHint/marathonHint are about SCORING, not
    // how to solve, so they stay.)
    const SUPPRESSED_AFTER_TUTORIAL = {
        lockTile: 1, twinStraightLock: 1,
        // The tutorial's step 3 and step 7 teach exactly these two.
        twinTiles: 1, gates: 1,
    };

    let card      = null;
    let textEl    = null;
    let gotItBtn  = null;
    let actionBtn = null;
    // Queue of { key, message, action } pending display. The head is
    // whatever's currently on-screen; the tail waits its turn.
    const queue = [];
    let showing = false;
    // Click handlers for the currently-displayed tip's buttons.
    // Tracked at module scope so dismissActive() can detach them whether
    // the dismissal comes from the click itself or from an external
    // caller (puzzle-end transitions).
    let currentGotItHandler  = null;
    let currentActionHandler = null;

    function isSeen(key) {
        try {
            if (SUPPRESSED_AFTER_TUTORIAL[key]
                && localStorage.getItem(TUTORIAL_WATCHED_KEY) === '1') {
                return true;   // the tutorial already taught this
            }
            return localStorage.getItem(SEEN_PREFIX + key) === '1';
        }
        // Private mode / quota errors → pretend seen so we don't repeatedly
        // throw on every visit + give up gracefully on showing the tip.
        catch (e) { return true; }
    }
    function markSeen(key) {
        try { localStorage.setItem(SEEN_PREFIX + key, '1'); }
        catch (e) { /* fall through */ }
    }

    // Public — schedule a tooltip if it hasn't been seen and isn't
    // already in the queue (dedupe by key so repeated calls during a
    // single play don't stack duplicates).
    function showOnce(key, message, action, onAcknowledge) {
        if (isSeen(key)) return;
        for (const entry of queue) {
            if (entry.key === key) return;
        }
        queue.push({
            key:           key,
            message:       message,
            action:        action || null,
            onAcknowledge: onAcknowledge || null,
        });
        processQueue();
    }

    // Public — fire the once-each explainers for the two board MECHANICS
    // a player meets partway into their first run: colored (twin) tiles
    // and red gates.
    //
    // Triggered by what the LIVE BOARD actually contains, not by a level
    // number, because every mode introduces them on a different schedule
    // — Zen's twin ramp starts at puzzle 3 and its gate-free opening ends
    // there, PotD ships a fixed gate count on every board, and a resumed
    // or menu-started run can begin already past both. "The first board
    // that has one" is the only trigger that is correct everywhere.
    //
    // Callers fire this at puzzle-ready, AFTER gates are placed. Repeat
    // calls are free — showOnce's seen-flag and queue dedupe absorb them.
    function showBoardMechanicTips() {
        const hasTwins = (typeof Maze !== 'undefined') && Maze.hasTwins && Maze.hasTwins();
        const hasGates = (typeof Gates !== 'undefined') && Gates.list && Gates.list.length > 0;
        const tr = function (key, fallback) {
            return (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key) : fallback;
        };
        if (hasTwins) {
            showOnce('twinTiles', tr('tooltip.twinTiles',
                'Colored tiles rotate in unison with other tiles of the same color.'));
        }
        if (hasGates) {
            showOnce('gates', tr('tooltip.gates',
                'Red gates are circuit breakers that disrupt the flow of a path.  Click on them to rotate them out of the way.'));
        }
    }

    // Public — cancel a queued (but not-yet-shown) tip. If the tip is
    // already on-screen, this is a no-op (the player should be able to
    // dismiss what's in front of them, even if game state changed).
    function cancelPending(key) {
        // Skip index 0 if shown — that's the on-screen one.
        const startIdx = showing ? 1 : 0;
        for (let i = queue.length - 1; i >= startIdx; i--) {
            if (queue[i].key === key) queue.splice(i, 1);
        }
    }

    function processQueue() {
        if (showing || queue.length === 0) return;
        if (!card || !textEl || !gotItBtn) return;  // DOM not ready
        // Seen-state can change between queueing and display — watching
        // the How-to-Solve tutorial flips the watched flag that
        // suppresses lockTile/twinStraightLock, so a tip queued before
        // (or while) the tutorial was open may be moot by its turn.
        // Re-check here and drop stale entries instead of showing them.
        while (queue.length > 0 && isSeen(queue[0].key)) queue.shift();
        if (queue.length === 0) return;
        const entry = queue[0];   // peek; shift on Got-It dismiss
        textEl.textContent = entry.message;
        // Optional action button — only tips that carry an action show it
        // (actionBtn may be null on stale cached index.html; typeof-guard
        // style keeps the plain-tip path working regardless).
        if (actionBtn) {
            if (entry.action && entry.action.label) {
                actionBtn.textContent = entry.action.label;
                actionBtn.hidden = false;
                currentActionHandler = function (e) {
                    if (e) e.stopPropagation();
                    const onClick = entry.action.onClick;
                    // Mark seen + dismiss FIRST so onClick can navigate /
                    // tear down game state without the card lingering.
                    dismissActive(true);
                    if (typeof onClick === 'function') {
                        try { onClick(); } catch (err) { /* action failure shouldn't break the queue */ }
                    }
                };
                actionBtn.addEventListener('click', currentActionHandler);
            } else {
                actionBtn.hidden = true;
            }
        }
        // styles.css uses #tooltipCard[hidden] { display: none } so
        // toggling .hidden cleanly shows/hides without inline-style
        // overrides.
        card.hidden = false;
        showing = true;
        // Click on Got It dismisses AND marks the tip as seen — the
        // player has acknowledged it, so we should never show it again.
        currentGotItHandler = function (e) {
            if (e) e.stopPropagation();
            dismissActive(true);
        };
        gotItBtn.addEventListener('click', currentGotItHandler);
    }

    // Public — hide whatever tip is currently on-screen AND clear the
    // queue. Behavior depends on `markAsSeen`:
    //   true  → user clicked Got It. Persist the seen-flag so this tip
    //           never shows again, then drain the queue normally (next
    //           tip slides in).
    //   false → the player NAVIGATED AWAY (quit to menu, time ran out,
    //           credits) with the tip unread. DON'T persist seen — they
    //           never had a chance to acknowledge it, so the same tip
    //           fires again on their next puzzle. Also clear the entire
    //           queue so a pending second tip doesn't pop up on a menu
    //           screen where it has no context. Future showOnce calls
    //           re-queue from scratch.
    // A SOLVE is neither of these — see dismissSolved below.
    function dismissActive(markAsSeen) {
        if (!card) return;
        const activeEntry = takeDownCard();
        if (markAsSeen) {
            acknowledge(activeEntry);
            queue.shift();
            // Drain anything that queued behind the dismissed tip.
            processQueue();
        } else {
            // Forget everything pending. The next puzzle's showOnce
            // calls will re-queue any unseen tips fresh.
            queue.length = 0;
        }
    }

    // Public — the player SOLVED the puzzle a tip was sitting on. The
    // on-screen tip is treated exactly as if Got It had been clicked:
    // seen-flag persisted, onAcknowledge fired, gone for good. Solving
    // the board underneath a tip is acknowledgment enough, and the old
    // behavior (re-queue it, unseen) meant a player who simply kept
    // playing got the same card again on every single puzzle until they
    // happened to click the button.
    //
    // Tips still QUEUED behind it are dropped UNSEEN rather than drained:
    // the player never laid eyes on those, and popping one up over the
    // solve card would be the same nagging in a different place. They
    // re-queue on the next puzzle and get their own turn there.
    function dismissSolved() {
        if (!card) return;
        acknowledge(takeDownCard());
        queue.length = 0;
    }

    // Hide the card + detach this tip's button handlers. Returns the
    // entry that was on-screen (null if nothing was), WITHOUT touching
    // the queue — each caller decides what happens to it.
    function takeDownCard() {
        const activeEntry = showing && queue.length > 0 ? queue[0] : null;
        if (currentGotItHandler && gotItBtn) {
            gotItBtn.removeEventListener('click', currentGotItHandler);
            currentGotItHandler = null;
        }
        if (currentActionHandler && actionBtn) {
            actionBtn.removeEventListener('click', currentActionHandler);
            currentActionHandler = null;
        }
        if (actionBtn) actionBtn.hidden = true;
        card.hidden = true;
        showing = false;
        return activeEntry;
    }

    // Persist the seen-flag and fire the acknowledgment hook. Ordering
    // matters: the flag lands FIRST, so a callback that repaints UI (or,
    // on the action path, an onClick that tears down game state) already
    // sees the tip as spent. Guarded so a callback failure can't break
    // the queue.
    function acknowledge(entry) {
        if (!entry) return;
        markSeen(entry.key);
        if (typeof entry.onAcknowledge === 'function') {
            try { entry.onAcknowledge(); } catch (err) { /* keep draining */ }
        }
    }

    function init() {
        card      = document.getElementById('tooltipCard');
        textEl    = document.getElementById('tooltipText');
        gotItBtn  = document.getElementById('tooltipGotItBtn');
        actionBtn = document.getElementById('tooltipActionBtn');
        // Anything that called showOnce before DOMContentLoaded queued
        // but couldn't paint; drain now that we have DOM refs.
        processQueue();
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    return {
        showOnce:      showOnce,
        // Board-driven mechanic explainers (twins / gates) — see above.
        // Called from every mode's puzzle-ready hook.
        showBoardMechanicTips: showBoardMechanicTips,
        cancelPending: cancelPending,
        // Called by NAVIGATION-away transitions (menu return, game over,
        // end credits). Pass false so the tip isn't marked seen — the
        // player never clicked Got It, so the same tip should still
        // fire on their next puzzle. Solves use dismissSolved instead.
        dismissActive: dismissActive,
        // Called from every mode's onSolve — see the function comment.
        dismissSolved: dismissSolved,
        // Exposed for callers that want to know whether to bother
        // scheduling a delayed timer — e.g., marathon.js skipping the
        // 30s lock-tip timer entirely if the tip's already been seen.
        isSeen:        isSeen,
    };
})();
