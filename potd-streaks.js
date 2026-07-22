/**
 * potd-streaks.js — Puzzle of the Day streak tracking + menu streak strip.
 *
 * Retention hooks around the daily puzzle (2026-07-22, post-CrazyGames
 * Basic Launch — D1 retention was the weakest metric, and visible
 * incomplete state is the lever):
 *
 *   🔥 daily streak    — consecutive UTC days with ≥1 PotD slot solved.
 *   ⭐ perfect streak  — consecutive UTC days with ≥1 HINT-FREE solve.
 *
 * Data lives in one localStorage record (see STREAK_KEY below):
 *   { days: { 'YYYY-MM-DD': { s: <slots solved>, p: 0|1 } },
 *     best: n, pBest: n, bf: 1 }
 * `days` doubles as the calendar's data source (potd-calendar.js reads it
 * via getHistory). `best`/`pBest` are maintained incrementally so pruning
 * old days can never lose a historical record. `bf` marks the one-time
 * backfill from the legacy per-slot state keys (<slug>_potd_<date>_<slot>
 * = 'solved') that potd.js has been writing since launch — players keep
 * credit for days they solved before this feature existed (hint data
 * wasn't recorded back then, so backfilled days are never 'perfect').
 *
 * "Current streak" counts consecutive qualifying days ending TODAY or
 * YESTERDAY — a streak isn't broken until a full UTC day passes unsolved,
 * matching the convention players know from other daily puzzles.
 *
 * Also owns the menu streak strip (#potdStreakStrip): the 🔥/⭐ chips, the
 * 📅 calendar button, and the next-puzzles countdown, ticked once per
 * second. Strip visibility is CSS-gated on body.mode-potd.
 *
 * Update entry point: Potd.onSolve calls recordSolve(date, hintFree).
 */
const PotdStreaks = (() => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Days of history to retain. Well past a year so year-over-year
    // calendar browsing works; prevents unbounded localStorage growth.
    const KEEP_DAYS = 400;

    function slug() {
        return (typeof PROJECT_SLUG === 'string') ? PROJECT_SLUG : 'circuitousness';
    }
    function storageKey() { return slug() + '_potd_streak_v1'; }

    function fmtDate(d) {
        return d.getUTCFullYear() + '-'
            + String(d.getUTCMonth() + 1).padStart(2, '0') + '-'
            + String(d.getUTCDate()).padStart(2, '0');
    }
    function todayUTC() { return fmtDate(new Date()); }
    // 'YYYY-MM-DD' ± n days → 'YYYY-MM-DD'. All arithmetic in UTC ms so
    // DST on the player's local clock can never skip or double a day.
    function shiftDate(dateStr, deltaDays) {
        return fmtDate(new Date(Date.parse(dateStr + 'T00:00:00Z') + deltaDays * DAY_MS));
    }

    function load() {
        try {
            const raw = localStorage.getItem(storageKey());
            if (raw) {
                const rec = JSON.parse(raw);
                if (rec && typeof rec === 'object' && rec.days && typeof rec.days === 'object') {
                    rec.best  = rec.best  | 0;
                    rec.pBest = rec.pBest | 0;
                    return rec;
                }
            }
        } catch (e) { /* private mode / corrupt JSON — start fresh */ }
        return { days: {}, best: 0, pBest: 0 };
    }
    function save(rec) {
        try { localStorage.setItem(storageKey(), JSON.stringify(rec)); }
        catch (e) { /* private mode / quota — streaks just won't persist */ }
    }

    function qualifies(entry, field) {
        if (!entry) return false;
        return field === 'p' ? !!entry.p : (entry.s | 0) > 0;
    }

    // Consecutive qualifying days ending today (or yesterday, if today
    // hasn't qualified yet — the streak isn't broken until a full day
    // passes unsolved).
    function streakEndingNow(days, field) {
        const today = todayUTC();
        let cursor = qualifies(days[today], field) ? today : shiftDate(today, -1);
        let n = 0;
        while (qualifies(days[cursor], field)) {
            n++;
            cursor = shiftDate(cursor, -1);
        }
        return n;
    }

    // Longest run anywhere in the map — needed once at backfill time,
    // where historical runs don't end at today. Walks forward only from
    // run STARTS (previous day absent), so total work is O(days).
    function bestOverall(days, field) {
        let best = 0;
        for (const d in days) {
            if (!qualifies(days[d], field)) continue;
            if (qualifies(days[shiftDate(d, -1)], field)) continue;  // not a run start
            let n = 0, cursor = d;
            while (qualifies(days[cursor], field)) {
                n++;
                cursor = shiftDate(cursor, 1);
            }
            if (n > best) best = n;
        }
        return best;
    }

    function prune(rec) {
        const cutoff = shiftDate(todayUTC(), -KEEP_DAYS);
        for (const d in rec.days) {
            // ISO date strings compare correctly as plain strings.
            if (d < cutoff) delete rec.days[d];
        }
    }

    // One-time import of the legacy per-slot solved markers that potd.js
    // has always written (and never pruned): <slug>_potd_<date>_<slot> =
    // 'solved'. Gives pre-feature players their earned history. The exact
    // key regex keeps cousins like _potd_genAt_* / _potd_puzzles_* /
    // _potd_lb_* out of the scan.
    function backfill(rec) {
        if (rec.bf) return;
        rec.bf = 1;
        const re = new RegExp('^' + slug() + '_potd_(\\d{4}-\\d{2}-\\d{2})_([sq][1-4])$');
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k) continue;
                const m = re.exec(k);
                if (!m) continue;
                if (localStorage.getItem(k) !== 'solved') continue;
                const entry = rec.days[m[1]] || { s: 0, p: 0 };
                entry.s = (entry.s | 0) + 1;
                rec.days[m[1]] = entry;
            }
        } catch (e) { /* private mode — nothing to backfill */ }
        rec.best  = Math.max(rec.best,  bestOverall(rec.days, 's'));
        rec.pBest = Math.max(rec.pBest, bestOverall(rec.days, 'p'));
    }

    // The 8 slot ids — mirrors Potd.SLOTS (loaded later in script order,
    // so read it at call time with a literal fallback).
    function slotIds() {
        return (typeof Potd !== 'undefined' && Potd.SLOTS)
            ? Potd.SLOTS
            : ['s1', 's2', 's3', 's4', 'q1', 'q2', 'q3', 'q4'];
    }
    // Ground truth for a day's solve count: potd.js writes one
    // <slug>_potd_<date>_<slot> = 'solved' marker per solved slot (and
    // never prunes them). Counting these instead of incrementing keeps
    // `s` idempotent — the launch-day double-count happened because
    // onSolve writes the marker BEFORE recordSolve runs, so the lazy
    // backfill's first-ever run saw the just-written marker and counted
    // the same solve twice.
    function countSolvedSlots(dateStr) {
        let n = 0;
        try {
            for (const s of slotIds()) {
                if (localStorage.getItem(slug() + '_potd_' + dateStr + '_' + s) === 'solved') n++;
            }
        } catch (e) {}
        return n;
    }

    // Re-derive today's `s` from the slot markers and persist the record
    // (which also persists the backfill's bf flag EARLY — at init, before
    // any solve can race it). Heals drift both ways: the double-count
    // above (4 → 3) and re-seed wipes (markers removed server-side →
    // count drops). The perfect flag is kept — markers carry no hint
    // data, so `p` has no ground truth to recount from.
    function reconcileToday() {
        const rec = load();
        backfill(rec);
        const today = todayUTC();
        const count = countSolvedSlots(today);
        const entry = rec.days[today];
        const cur = entry ? (entry.s | 0) : 0;
        if (count !== cur) {
            if (count > 0) {
                rec.days[today] = { s: count, p: entry && entry.p ? 1 : 0 };
            } else {
                // All markers gone (re-seed wipe) — the day no longer
                // qualifies; a stale entry would fake a streak day.
                delete rec.days[today];
            }
        }
        save(rec);
    }

    // ── Public data API ──

    // Called by Potd.onSolve on every genuine PotD solve. Returns the
    // post-update streak numbers for the solve modal's streak line.
    function recordSolve(dateStr, hintFree) {
        const rec = load();
        backfill(rec);
        const entry = rec.days[dateStr] || { s: 0, p: 0 };
        // Recount from the markers (this solve's marker is already
        // written — see countSolvedSlots). The max(1, …) floor covers
        // marker writes failing (private mode/quota): we ARE inside a
        // solve, so the day counts at least once.
        entry.s = Math.max(1, countSolvedSlots(dateStr));
        if (hintFree) entry.p = 1;
        rec.days[dateStr] = entry;
        const current = streakEndingNow(rec.days, 's');
        const perfect = streakEndingNow(rec.days, 'p');
        if (current > rec.best)  rec.best  = current;
        if (perfect > rec.pBest) rec.pBest = perfect;
        prune(rec);
        save(rec);
        refreshStrip();
        return { current: current, best: rec.best, perfect: perfect, perfectBest: rec.pBest };
    }

    function getStreaks() {
        const rec = load();
        backfill(rec);
        return {
            current:     streakEndingNow(rec.days, 's'),
            best:        rec.best,
            perfect:     streakEndingNow(rec.days, 'p'),
            perfectBest: rec.pBest,
        };
    }

    // Calendar data source — a copy so callers can't mutate the record.
    function getHistory() {
        const rec = load();
        backfill(rec);
        const out = {};
        for (const d in rec.days) out[d] = { s: rec.days[d].s | 0, p: rec.days[d].p ? 1 : 0 };
        return out;
    }

    // ── Menu strip UI ──

    let fireValEl, fireBestEl, starValEl, starBestEl, todayValEl, countdownEl;
    let lastSeenDate = null;

    function refreshStrip() {
        if (!fireValEl) return;
        const s = getStreaks();
        const t = (key, vars, fallback) =>
            (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key, vars) : fallback;
        // Streak chips carry a day-unit suffix ("1d" not bare "1"):
        // the bare number read as a SOLVE count sitting next to the
        // today-chip (user hit this 2026-07-22 — three solves in, the
        // chips showed 1 and 1 because the streak was one day old).
        fireValEl.textContent = t('potd.streak.chipDays', { n: s.current }, s.current + 'd');
        starValEl.textContent = t('potd.streak.chipDays', { n: s.perfect }, s.perfect + 'd');
        // "· best" suffix only when it beats the current run — a best
        // equal to current adds no information. Bare number here (the
        // unit is established by the main value beside it).
        fireBestEl.textContent = s.best  > s.current ? '· ' + s.best  : '';
        starBestEl.textContent = s.perfectBest > s.perfect ? '· ' + s.perfectBest : '';
        // Today chip: slots solved today over the day's total — the
        // per-day progress the streak chips deliberately don't show,
        // and an all-8 completion hook in its own right.
        if (todayValEl) {
            const entry = getHistory()[todayUTC()];
            const total = (typeof Potd !== 'undefined' && Potd.SLOTS) ? Potd.SLOTS.length : 8;
            todayValEl.textContent = ((entry && entry.s) || 0) + '/' + total;
        }
    }

    function fmtCountdown(ms) {
        const totalSec = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const sec = totalSec % 60;
        return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }

    function tick() {
        const now = new Date();
        const today = fmtDate(now);
        // UTC day rolled over while the menu sat open — the streak chips
        // may flip (today's solve becomes yesterday's) and the countdown
        // resets. potd.js has its own rollover watcher for slot badges.
        if (today !== lastSeenDate) {
            lastSeenDate = today;
            reconcileToday();
            refreshStrip();
        }
        if (countdownEl) {
            const nextMidnight = Date.parse(today + 'T00:00:00Z') + DAY_MS;
            const t = fmtCountdown(nextMidnight - now.getTime());
            countdownEl.textContent = (typeof I18n !== 'undefined' && I18n.t)
                ? I18n.t('potd.countdown', { t: t })
                : 'New puzzles in ' + t;
        }
    }

    // ── Chip explainer bubble ──
    //
    // One shared popover under the strip explaining the tapped/hovered
    // chip — the i18n strings are resolved at show time so language
    // switches are picked up. Two wiring modes (chosen at init by
    // hover-capability):
    //   • hover devices (desktop): mouseenter/focus shows, mouseleave/
    //     blur hides — REPLACES the native title tooltip (the title
    //     attributes are gone from the markup so the two can't double
    //     up). No auto-timeout; leaving hides it.
    //   • touch devices: tap toggles, tap-elsewhere or a timeout hides.
    //     Tap-mode wiring must NOT coexist with hover wiring — touch
    //     taps synthesize mouseenter first, which would show the bubble
    //     and turn the click's toggle into an immediate hide.
    const CHIP_TIP_TIMEOUT_MS = 6000;
    let tipEl = null, tipFor = null, tipTimer = null;

    function hideChipTip() {
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (tipEl) tipEl.hidden = true;
        tipFor = null;
    }
    // autoHide=true is tap mode: same-chip re-tap toggles off and a
    // timeout backstops dismissal. Hover mode passes false — visibility
    // is owned entirely by enter/leave, so no toggle and no timer.
    function showChipTip(chipId, key, autoHide) {
        const strip = document.getElementById('potdStreakStrip');
        if (!strip) return;
        if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.id = 'potdStreakTip';
            tipEl.hidden = true;
            strip.appendChild(tipEl);
        }
        if (autoHide && tipFor === chipId && !tipEl.hidden) { hideChipTip(); return; }
        tipEl.textContent = (typeof I18n !== 'undefined' && I18n.t) ? I18n.t(key) : key;
        tipEl.hidden = false;
        tipFor = chipId;
        if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
        if (autoHide) tipTimer = setTimeout(hideChipTip, CHIP_TIP_TIMEOUT_MS);
    }

    function init() {
        fireValEl   = document.getElementById('potdStreakFireVal');
        fireBestEl  = document.getElementById('potdStreakFireBest');
        starValEl   = document.getElementById('potdStreakStarVal');
        starBestEl  = document.getElementById('potdStreakStarBest');
        todayValEl  = document.getElementById('potdStreakTodayVal');
        countdownEl = document.getElementById('potdCountdown');

        const calBtn = document.getElementById('potdCalendarBtn');
        if (calBtn) {
            calBtn.addEventListener('click', () => {
                if (typeof PotdCalendar !== 'undefined' && PotdCalendar.open) PotdCalendar.open();
            });
        }

        // Explainer wiring — hover/focus on hover-capable devices,
        // tap-toggle on touch (see the mode rationale on the bubble's
        // block comment above; the two wirings must not coexist). The
        // 📅 chip participates too — its native title is gone like the
        // others', and its click still opens the calendar in both modes.
        const chipTips = [
            ['potdStreakFire',  'potd.streak.currentTitle'],
            ['potdStreakStar',  'potd.streak.perfectTitle'],
            ['potdStreakToday', 'potd.streak.todayTitle'],
            ['potdCalendarBtn', 'potd.cal.button'],
        ];
        const hoverCapable = !!(window.matchMedia
            && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
        for (const pair of chipTips) {
            const el = document.getElementById(pair[0]);
            if (!el) continue;
            if (hoverCapable) {
                el.addEventListener('mouseenter', () => showChipTip(pair[0], pair[1], false));
                el.addEventListener('mouseleave', hideChipTip);
                // Keyboard parity: focus shows, blur hides.
                el.addEventListener('focus', () => showChipTip(pair[0], pair[1], false));
                el.addEventListener('blur',  hideChipTip);
            } else {
                // Tap mode: the 📅 chip is excluded — its tap PERFORMS
                // an action (opens the calendar), so an explainer bubble
                // would pop up behind the overlay it just opened.
                if (pair[0] === 'potdCalendarBtn') continue;
                // stopPropagation keeps the chip tap from reaching the
                // document-level dismiss listener below (which handles
                // every OTHER tap).
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showChipTip(pair[0], pair[1], true);
                });
            }
        }
        // Tap-elsewhere dismiss (touch mode); harmless on desktop where
        // mouseleave has usually hidden the bubble already.
        document.addEventListener('click', hideChipTip);

        lastSeenDate = todayUTC();
        // Recount today from the slot markers + persist the backfill
        // flag before any solve can race it (see reconcileToday).
        reconcileToday();
        refreshStrip();
        tick();
        // 1s cadence for the countdown. The strip is hidden outside PotD
        // mode (CSS), but updating hidden text is far cheaper than
        // wiring start/stop to mode changes.
        setInterval(tick, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { recordSolve, getStreaks, getHistory, refreshStrip };
})();
