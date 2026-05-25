/**
 * tooltip.js — once-each first-play educational tooltips.
 *
 * Public API:
 *   Tooltip.showOnce(key, message)
 *   Tooltip.cancelPending(key)   — remove a queued (but not-yet-shown) tip
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

    let card     = null;
    let textEl   = null;
    let gotItBtn = null;
    // Queue of { key, message } pending display. The head is whatever's
    // currently on-screen; the tail waits its turn.
    const queue = [];
    let showing = false;
    // Click handler for the currently-displayed tip's Got It button.
    // Tracked at module scope so dismissActive() can detach it whether
    // the dismissal comes from the click itself or from an external
    // caller (puzzle-end transitions).
    let currentGotItHandler = null;

    function isSeen(key) {
        try { return localStorage.getItem(SEEN_PREFIX + key) === '1'; }
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
    function showOnce(key, message) {
        if (isSeen(key)) return;
        for (const entry of queue) {
            if (entry.key === key) return;
        }
        queue.push({ key: key, message: message });
        processQueue();
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
        const entry = queue[0];   // peek; shift on Got-It dismiss
        textEl.textContent = entry.message;
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
    //   false → an external transition (puzzle end, navigation to menu
    //           or credits) is pulling the tip away. DON'T persist seen
    //           — the player never had a chance to actually acknowledge
    //           it, so we want the same tip to fire again on the NEXT
    //           puzzle. Also clear the entire queue so a pending second
    //           tip doesn't pop up on a menu screen where it has no
    //           context. Future showOnce calls re-queue from scratch.
    function dismissActive(markAsSeen) {
        if (!card) return;
        const activeEntry = showing && queue.length > 0 ? queue[0] : null;
        if (currentGotItHandler && gotItBtn) {
            gotItBtn.removeEventListener('click', currentGotItHandler);
            currentGotItHandler = null;
        }
        card.hidden = true;
        showing = false;
        if (markAsSeen) {
            if (activeEntry) markSeen(activeEntry.key);
            queue.shift();
            // Drain anything that queued behind the dismissed tip.
            processQueue();
        } else {
            // Forget everything pending. The next puzzle's showOnce
            // calls will re-queue any unseen tips fresh.
            queue.length = 0;
        }
    }

    function init() {
        card     = document.getElementById('tooltipCard');
        textEl   = document.getElementById('tooltipText');
        gotItBtn = document.getElementById('tooltipGotItBtn');
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
        cancelPending: cancelPending,
        // Called by puzzle-exit transitions (menu return, end credits,
        // PotD solve). Pass false so the tip isn't marked seen — the
        // player never clicked Got It, so the same tip should still
        // fire on their next puzzle.
        dismissActive: dismissActive,
        // Exposed for callers that want to know whether to bother
        // scheduling a delayed timer — e.g., marathon.js skipping the
        // 30s lock-tip timer entirely if the tip's already been seen.
        isSeen:        isSeen,
    };
})();
