/**
 * potd-calendar.js — Puzzle of the Day month-calendar popup.
 *
 * Shows which UTC days the player solved a daily puzzle (accent fill) and
 * which were hint-free "perfect" days (⭐ badge). The visible gaps are the
 * point — an unfinished month is a return hook (2026-07-22 retention
 * pass, alongside potd-streaks.js).
 *
 * Data comes from PotdStreaks.getHistory() (one { 'YYYY-MM-DD': {s,p} }
 * map — includes the backfilled pre-feature days). All date math is UTC
 * to match the PotD day boundary.
 *
 * Month + weekday names come from Intl.DateTimeFormat in the player's
 * current i18n language, so no per-language translation tables are
 * needed here. Weeks render Monday-first (fixed — per-locale first-day
 * data isn't reliably available across the browsers we support).
 *
 * Markup lives in index.html (#potdCalendarOverlay) reusing the shared
 * .combo-modal-overlay / .combo-modal shell, same show/hide pattern as
 * potd.js's confirm modals (style.display flex/none).
 */
const PotdCalendar = (() => {
    let overlayEl, monthLabelEl, weekdaysEl, gridEl, prevBtn, nextBtn, closeBtn;
    // Viewed month, UTC. Set on every open() so the popup always opens
    // on the current month.
    let viewYear = 0, viewMonth = 0;   // month 0-based

    function lang() {
        return (typeof I18n !== 'undefined' && I18n.getLanguage) ? I18n.getLanguage() : 'en';
    }
    function fmtDate(y, m, d) {
        return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    }
    function todayParts() {
        const now = new Date();
        return { y: now.getUTCFullYear(), m: now.getUTCMonth(), d: now.getUTCDate() };
    }

    function renderWeekdays() {
        if (!weekdaysEl) return;
        weekdaysEl.innerHTML = '';
        let names;
        try {
            const fmt = new Intl.DateTimeFormat(lang(), { weekday: 'narrow', timeZone: 'UTC' });
            // 2024-01-01 was a Monday; +i days walks Mon..Sun.
            names = Array.from({ length: 7 }, (_, i) =>
                fmt.format(new Date(Date.UTC(2024, 0, 1 + i))));
        } catch (e) {
            names = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
        }
        for (const n of names) {
            const el = document.createElement('span');
            el.className = 'potd-cal-wd';
            el.textContent = n;
            weekdaysEl.appendChild(el);
        }
    }

    function render() {
        if (!gridEl) return;
        const today = todayParts();

        // Month title, localized ("July 2026" / "julio de 2026" / …).
        let title;
        try {
            title = new Intl.DateTimeFormat(lang(), { month: 'long', year: 'numeric', timeZone: 'UTC' })
                .format(new Date(Date.UTC(viewYear, viewMonth, 1)));
        } catch (e) {
            title = (viewMonth + 1) + '/' + viewYear;
        }
        if (monthLabelEl) monthLabelEl.textContent = title;

        // Forward nav stops at the current month — future months are all
        // empty by construction and browsing them just reads as broken.
        const atCurrentMonth = viewYear === today.y && viewMonth === today.m;
        if (nextBtn) nextBtn.disabled = atCurrentMonth;

        const history = (typeof PotdStreaks !== 'undefined' && PotdStreaks.getHistory)
            ? PotdStreaks.getHistory() : {};

        gridEl.innerHTML = '';
        // getUTCDay(): 0=Sun..6=Sat → Monday-first column index 0..6.
        const firstDow    = (new Date(Date.UTC(viewYear, viewMonth, 1)).getUTCDay() + 6) % 7;
        const daysInMonth = new Date(Date.UTC(viewYear, viewMonth + 1, 0)).getUTCDate();

        for (let i = 0; i < firstDow; i++) {
            const pad = document.createElement('span');
            pad.className = 'potd-cal-day out';
            gridEl.appendChild(pad);
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const cell = document.createElement('span');
            cell.className = 'potd-cal-day';
            cell.textContent = String(d);
            const isFuture = viewYear === today.y && viewMonth === today.m && d > today.d;
            if (isFuture) {
                cell.classList.add('future');
            } else {
                const entry = history[fmtDate(viewYear, viewMonth, d)];
                if (entry && entry.s > 0) {
                    cell.classList.add('solved');
                    if (entry.p) {
                        cell.classList.add('perfect');
                        const star = document.createElement('span');
                        star.className = 'potd-cal-star';
                        star.textContent = '⭐';
                        cell.appendChild(star);
                    }
                }
            }
            if (viewYear === today.y && viewMonth === today.m && d === today.d) {
                cell.classList.add('today');
            }
            gridEl.appendChild(cell);
        }
    }

    function shiftMonth(delta) {
        viewMonth += delta;
        if (viewMonth < 0)  { viewMonth = 11; viewYear--; }
        if (viewMonth > 11) { viewMonth = 0;  viewYear++; }
        render();
    }

    function open() {
        if (!overlayEl) return;
        const today = todayParts();
        viewYear  = today.y;
        viewMonth = today.m;
        renderWeekdays();
        render();
        overlayEl.style.display = 'flex';
    }
    function close() {
        if (overlayEl) overlayEl.style.display = 'none';
    }

    function init() {
        overlayEl    = document.getElementById('potdCalendarOverlay');
        monthLabelEl = document.getElementById('potdCalMonthLabel');
        weekdaysEl   = document.getElementById('potdCalWeekdays');
        gridEl       = document.getElementById('potdCalGrid');
        prevBtn      = document.getElementById('potdCalPrevBtn');
        nextBtn      = document.getElementById('potdCalNextBtn');
        closeBtn     = document.getElementById('potdCalCloseBtn');
        if (prevBtn)  prevBtn.addEventListener('click', () => shiftMonth(-1));
        if (nextBtn)  nextBtn.addEventListener('click', () => shiftMonth(1));
        if (closeBtn) closeBtn.addEventListener('click', close);
        if (overlayEl) {
            overlayEl.addEventListener('click', (e) => {
                if (e.target === overlayEl) close();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { open, close };
})();
