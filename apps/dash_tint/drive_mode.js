'use strict';
/**
 * drive_mode.js - the car's driving mode, and whether the tint shows in it.
 *
 * FES statusFESVehicleDynamicSwitchHMI.actualValueModeDrivingExperience arrives as its enum name or its wire
 * number (tables from cauliflowermossgrape/idrive7-apps live_data and ambient_config):
 *   1 Sport, 2 Sport Plus, 3 Sport Individual, 15 / 16 / 23 plug-in hybrid Sport, 28 XtraBoost (BOOST),
 *   4-6 Comfort, 7-9 Eco Pro, 10 Adaptive, 17-22 plug-in hybrid Hybrid / Electric / battery control.
 * Anything else (0 and 61-63 while the car starts up, a name from another software level) is unknown.
 *
 * Node 8.16.2 (the car's): no optional chaining, no ??.
 */

const DRIVE_MODE = { SPORT: 'sport', BOOST: 'boost', OTHER: 'other' };

/** app.json setting "tintIn": its option values. */
const TINT_IN = { SPORT_AND_BOOST: 'sport', BOOST_ONLY: 'boost' };

const BOOST_WIRE = 28;
const SPORT_WIRE = [1, 2, 3, 15, 16, 23];
const OTHER_WIRE = [4, 5, 6, 7, 8, 9, 10, 17, 18, 19, 20, 21, 22];
const WIRE_NUMBER = /^\d+$/;
const BOOST_NAME = /BOOST/;
const SPORT_NAME = /SPORT/;
const OTHER_NAME = /COMFORT|ECO|ADAPTIV|HYBRID|ELECTRIC|BATTERY|TRAFFIC/;

/** A raw actualValueModeDrivingExperience -> one of DRIVE_MODE, or null when unknown. */
function driveModeOf(raw) {
    if (raw === undefined || raw === null) return null;
    const text = String(raw).trim().toUpperCase();
    if (WIRE_NUMBER.test(text)) {
        const wire = Number(text);
        if (wire === BOOST_WIRE) return DRIVE_MODE.BOOST;
        if (SPORT_WIRE.indexOf(wire) >= 0) return DRIVE_MODE.SPORT;
        if (OTHER_WIRE.indexOf(wire) >= 0) return DRIVE_MODE.OTHER;
        return null;
    }
    if (BOOST_NAME.test(text)) return DRIVE_MODE.BOOST;
    if (SPORT_NAME.test(text)) return DRIVE_MODE.SPORT;
    if (OTHER_NAME.test(text)) return DRIVE_MODE.OTHER;
    return null;
}

/** Whether the tint shows in mode (one of DRIVE_MODE, or null) with the "tintIn" setting tintIn (one of TINT_IN). */
function tintsIn(mode, tintIn) {
    if (tintIn === TINT_IN.BOOST_ONLY) return mode === DRIVE_MODE.BOOST;
    return mode === DRIVE_MODE.SPORT || mode === DRIVE_MODE.BOOST;
}

module.exports = { DRIVE_MODE, TINT_IN, driveModeOf, tintsIn };
