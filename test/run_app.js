'use strict';
/**
 * run_app.js - runs the BUILT app (dist/<id>, from kit/tools/build.py --preview-only) in the kit's stub head unit
 * (kit/tools/hu-stub.js, live mode: real Settings, the app's mgu.run, signals fed by hand). No BMW SDK, no SOME/IP.
 * Forked by run_tests.js:  node test/run_app.js <dist/<id>> <data dir>
 *
 * IPC from the test: { t: 'feed', iface, field, value } (a SOME/IP notification), { t: 'set', key, value } (a
 * setting changed in the HMI). To the test: { t: 'cells', name, cells } (an HMI row written), { t: 'log', s }.
 */
const fs = require('fs');
const path = require('path');
const { headUnit } = require(path.join(__dirname, '..', 'kit', 'tools', 'hu-stub.js'));

const stage = process.argv[2];
const dataDir = process.argv[3];
if (!stage || !dataDir) throw new Error('usage: run_app.js <dist/<id>> <data dir>');

const send = (m) => { if (process.connected) process.send(m); };
const line = (level) => (...a) => send({ t: 'log', s: level + ' ' + a.map((x) => (x && x.stack) || (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') });
const log = { info: line('INFO'), warn: line('WARN'), error: line('ERROR'), debug: () => {} };
// as on the car (kit/mgu.js), an uncaught exception ends the app
process.on('uncaughtException', (e) => { log.error('uncaught: ' + (e && e.stack || e)); process.exit(1); });

fs.mkdirSync(dataDir);
const hu = headUnit(stage, { live: true, dataDir, log, image: () => Promise.resolve() });
const cells = hu.ui.cells;
hu.ui.cells = (name, row, obj) => { send({ t: 'cells', name, cells: obj }); return cells(name, row, obj); };

process.on('message', (m) => {
    if (m.t === 'feed') hu.feed(m.iface, m.field, m.value);
    else if (m.t === 'set') hu.settings.set(m.key, m.value);
    else throw new Error('run_app: unknown message ' + JSON.stringify(m));
});
hu.start();
