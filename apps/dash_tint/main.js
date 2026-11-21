'use strict';
/**
 * main.js - Dash Tint: BMW's red Sport look on the iDrive 7 instrument cluster tinted in a colour of your own
 * (violet by default, to go with a violet ambient light), in Sport and XtraBoost or in XtraBoost only.
 * Starts with the head unit (app.json "autostart") and follows the driving mode the car sends on FES.
 *
 * Node 8.16.2 (the car's): no optional chaining, no ??.
 */
const mgu = require('./kit/mgu');
const { driveModeOf, tintsIn } = require('./drive_mode');
const { TintLayer } = require('./tint');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const FES_INSTANCE = '1';
/** Another cluster-render socket (the tests' stand-in); unset on the car: the service's own. */
const SOCKET_ENV = 'DASH_TINT_CLUSTER_SOCKET';
const PERCENT = 100;
const STATUS = 'STATUS';
const SETTING = { ENABLED: 'enabled', TINT_IN: 'tintIn', COLOR: 'color', STRENGTH: 'strength', OUTLINE: 'outline' };

mgu.run({
    async start(ctx) {
        const { settings, log, ui } = ctx;
        const tint = new TintLayer({ app: ctx.spec.id, log, socketPath: process.env[SOCKET_ENV] });
        let mode = null;

        function showStatus() {
            return ui.cells(STATUS, 0, {
                Text1stRow: 'Tint ' + (tint.visible ? 'on' : 'off') + ' | drive mode ' + (mode || 'unknown'),
                Text2ndRow: 'cluster-render ' + (tint.connected ? 'connected' : 'not connected') + ' | layer ' + tint.layerState +
                    ' | cluster ' + tint.targetState + (tint.refused ? ' | refused ' + tint.refused : ''),
            });
        }

        function apply() {
            const outline = settings.get(SETTING.OUTLINE) === true;
            tint.show({
                visible: settings.get(SETTING.ENABLED) === true && (outline || tintsIn(mode, settings.get(SETTING.TINT_IN))),
                color: settings.get(SETTING.COLOR),
                strength: settings.get(SETTING.STRENGTH) / PERCENT,
                outline,
            });
            return showStatus();
        }

        function onDriveMode(v) {
            const raw = v.actualValueModeDrivingExperience;
            const next = driveModeOf(raw);
            log.info('drive mode ' + raw + ': ' + (next === null ? 'unknown, kept ' + (mode || 'none') : next));
            if (next === null || next === mode) return;
            mode = next;
            apply();
        }

        settings.onChange(apply);
        tint.on('change', showStatus);
        tint.start();
        apply();
        const fes = await ctx.signals.watch(FES, FES_INSTANCE, { statusFESVehicleDynamicSwitchHMI: onDriveMode }, log);
        if (fes.error) log.warn('drive mode: ' + fes.error);
    },
});
