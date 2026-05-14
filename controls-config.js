/**
 * Controls Configuration Module for Circuitousness
 * Skeleton — declares the public API surface used across the project.
 * Fill in DEFAULT_KEYBOARD / DEFAULT_GAMEPAD as gameplay actions are designed.
 */

const ControlsConfig = (() => {
    // TODO: define gameplay actions for this project
    const DEFAULT_KEYBOARD = {};
    const DEFAULT_GAMEPAD = {};

    let keyboardBindings = JSON.parse(JSON.stringify(DEFAULT_KEYBOARD));
    let gamepadBindings  = JSON.parse(JSON.stringify(DEFAULT_GAMEPAD));
    let vibrationEnabled = true;

    function init() { /* TODO: load saved bindings from localStorage */ }
    function getBindings() { return { keyboard: keyboardBindings, gamepad: gamepadBindings }; }
    function applyBindings(_b) { /* TODO */ }
    function getKeyboardAction(_key) { return null; }
    function getGamepadAction(_buttonIndex) { return null; }
    function updateUI() { /* TODO */ }
    function isGamepadConnected() {
        if (!navigator.getGamepads) return false;
        return Array.from(navigator.getGamepads()).some((g) => g);
    }
    function formatKeyName(key) { return key; }
    function formatGamepadButton(idx) { return 'Button ' + idx; }

    return {
        init, getBindings, applyBindings,
        getKeyboardAction, getGamepadAction,
        updateUI, isGamepadConnected,
        formatKeyName, formatGamepadButton,
        get keyboard() { return keyboardBindings; },
        get gamepad()  { return gamepadBindings; },
        get vibrationEnabled() { return vibrationEnabled; },
        set vibrationEnabled(v) { vibrationEnabled = v; }
    };
})();

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ControlsConfig.init());
} else {
    ControlsConfig.init();
}
