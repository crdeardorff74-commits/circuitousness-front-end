/**
 * touch-controls.js - Device detection, swipe gestures, and touch
 *                     controls skeleton for Circuitousness.
 *
 * Declares the public API surface used elsewhere. Bodies are minimal
 * until gameplay-specific gestures are designed.
 *
 * Exports: DeviceDetection, detectOS, SwipeControls, TabletMode,
 *          touchRepeat, initTouchControls
 */

const { DeviceDetection, detectOS, SwipeControls, TabletMode, touchRepeat, initTouchControls } = (function() {

const DeviceDetection = {
    isMobile: false,
    isTablet: false,
    isTouch: false,

    detect() {
        const ua = navigator.userAgent.toLowerCase();
        this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        if (/(ipad|tablet|playbook|silk)|(android(?!.*mobile))/i.test(ua)) {
            this.isTablet = true;  this.isMobile = false; return 'tablet';
        }
        if (/android|webos|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua)) {
            this.isTablet = false; this.isMobile = true;  return 'phone';
        }
        // iPad with iPadOS 13+ reports as desktop Mac
        if (navigator.userAgent.match(/Mac/) && navigator.maxTouchPoints && navigator.maxTouchPoints > 2) {
            this.isTablet = true;  this.isMobile = false; return 'tablet';
        }
        return 'desktop';
    }
};

function detectOS() {
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
    if (/Android/.test(ua))          return 'Android';
    if (/Windows/.test(ua))          return 'Windows';
    if (/Mac/.test(ua))              return 'macOS';
    if (/Linux/.test(ua))            return 'Linux';
    return 'Other';
}

const SwipeControls = {
    enabled: false,
    init() { /* TODO: attach touchstart/move/end listeners and emit gesture events */ },
    destroy() { /* TODO */ }
};

const TabletMode = {
    active: false,
    apply() { /* TODO: switch UI layout for touch devices */ },
    remove() { /* TODO */ }
};

const touchRepeat = {
    start(_action, _intervalMs) { /* TODO: emulate key-repeat for held on-screen buttons */ },
    stop(_action) { /* TODO */ }
};

function initTouchControls() {
    DeviceDetection.detect();
    // TODO: bind on-screen button events once UI exists
}

return { DeviceDetection, detectOS, SwipeControls, TabletMode, touchRepeat, initTouchControls };

})();
