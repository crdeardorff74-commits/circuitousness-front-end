/**
 * gamepad.js - Gamepad Controller skeleton for Circuitousness
 *
 * Declares the public API surface (init, update, vibrate, menu navigation)
 * so other modules can call into it. Bodies are no-ops until gameplay
 * actions are defined. Must be loaded before the main JS so the
 * GamepadController object exists when referenced.
 *
 * Exports: GamepadController
 */

const GamepadController = (function() {

const controller = {
    enabled: false,
    connected: false,
    deadzone: 0.25,
    repeatDelay: 120,
    lastMoveTime: 0,
    buttonStates: {},
    vibrationSupported: false,
    vibrationEnabled: true,
    pollingIntervalId: null,

    // Standard Gamepad button indices (Xbox / PS layout)
    buttons: {
        A: 0, B: 1, X: 2, Y: 3,
        LB: 4, RB: 5, LT: 6, RT: 7,
        BACK: 8, START: 9,
        L_STICK: 10, R_STICK: 11,
        D_UP: 12, D_DOWN: 13, D_LEFT: 14, D_RIGHT: 15
    },

    init() {
        window.addEventListener('gamepadconnected', (e) => {
            this.connected = true;
            this.enabled = true;
            const pad = e.gamepad;
            this.vibrationSupported = !!(pad && pad.vibrationActuator);
        });
        window.addEventListener('gamepaddisconnected', () => {
            this.connected = false;
        });
    },

    startPolling() {
        if (this.pollingIntervalId) return;
        this.pollingIntervalId = setInterval(() => this.update(), 16);
    },

    stopPolling() {
        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
            this.pollingIntervalId = null;
        }
    },

    update() { /* TODO: read navigator.getGamepads(), dispatch actions */ },

    updateMenuNavigation(_gp) { /* TODO */ return false; },

    updateControlsDisplay() { /* TODO */ },

    vibrate(duration = 200, weak = 0.5, strong = 1.0) {
        if (!this.vibrationEnabled || !this.vibrationSupported) return;
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const pad of pads) {
            if (pad && pad.vibrationActuator && pad.vibrationActuator.playEffect) {
                pad.vibrationActuator.playEffect('dual-rumble', {
                    duration,
                    weakMagnitude: weak,
                    strongMagnitude: strong
                });
            }
        }
    }
};

return controller;

})();
