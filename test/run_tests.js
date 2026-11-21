'use strict';
/**
 * run_tests.js - Dash Tint's tests:  node test/run_tests.js
 *
 *   drive_mode.js   every wire number and enum name the car sends, and when the tint shows
 *   shader.js       the generated GLSL ES 1.00 (declared uniforms, float literals, reserved words, mediump range,
 *                   size against what crashed the cluster's GPU) and the geometry it is made from
 *   tint.js         TintLayer against a fake cluster-render socket: the layer, the uniforms, events, a service restart
 *   app.json        agrees with the code and mgu-repo.json
 *   Node 8          the app's sources use nothing newer than the car's Node 8.16.2 parses
 *   end to end      the BUILT app in the kit's stub head unit (test/run_app.js): drive modes and settings in, the
 *                   cluster-render messages and the status row out
 *
 * Verbose on purpose: every step says what went in and what came out. The shader's pixels are checked in a
 * browser by test/shader.html (WebGL 1 compiles GLSL ES 1.00, as the cluster's GPU does).
 */
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_ID = 'dash_tint';
const APP_DIR = path.join(ROOT, 'apps', APP_ID);
const STAGE = path.join(ROOT, 'dist', APP_ID);
const { DRIVE_MODE, TINT_IN, driveModeOf, tintsIn } = require(path.join(APP_DIR, 'drive_mode'));
const shader = require(path.join(APP_DIR, 'shader'));
const { TintLayer, COLORS } = require(path.join(APP_DIR, 'tint'));
const { startFake } = require('./fake_cluster_render');

const SPEC = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8'));
const REPO = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8'));
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const FES_FIELD = 'statusFESVehicleDynamicSwitchHMI';
const SOCKET_ENV = 'DASH_TINT_CLUSTER_SOCKET';
const CHANNEL_MAX = 255;
const COLOR_TOLERANCE = 1e-6;
const MEDIUMP_MAX = 16384;          // 2^14: the least range GLSL ES 1.00 grants a mediump float
const SHADER_TOKENS_HELD = 7835;    // the biggest whole-panel shader known to hold on an iDrive 7 cluster (bimmer-lab)
const QUIET_MS = 300;
const POLL_MS = 10;
const WAIT_MS = 5000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const say = (s) => console.log(s);

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dash-tint-')); }

/** Resolves once cond() holds, polling; rejects after WAIT_MS with what. */
function until(cond, what) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        (function poll() {
            if (cond()) return resolve();
            if (Date.now() - start > WAIT_MS) return reject(new Error('timed out waiting for ' + what));
            setTimeout(poll, POLL_MS);
        })();
    });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

/** GLSL source without its comments. */
function code(glsl) { return glsl.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); }

/** JS source without its comments (block, and line comments that start a line or follow whitespace). */
function jsCode(js) { return js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1'); }

function assertColor(v, color, what) {
    const got = String(v).split(' ').map(Number);
    const want = COLORS[color].map((c) => c / CHANNEL_MAX);
    say('    ' + what + ': u_color ' + v + ' (want ' + color + ' ' + want.map((x) => x.toFixed(4)).join(' ') + ')');
    assert.strictEqual(got.length, 3, what + ': u_color has 3 numbers');
    got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < COLOR_TOLERANCE, what + ': u_color channel ' + i + ' ' + g + ' != ' + want[i]));
}

/* ---------------- drive_mode.js ---------------- */

// [wire number, enum name, mode]: cauliflowermossgrape/idrive7-apps live_data (1-10) and ambient_config (15-28)
const MODES_SENT = [
    [1, 'SPORT_DYNAMIC', DRIVE_MODE.SPORT], [2, 'SPORT_EXPERT', DRIVE_MODE.SPORT], [3, 'SPORT_INDIVIDUAL', DRIVE_MODE.SPORT],
    [4, 'COMFORT', DRIVE_MODE.OTHER], [5, 'COMFORT_PLUS', DRIVE_MODE.OTHER], [6, 'COMFORT_INDIVIDUAL', DRIVE_MODE.OTHER],
    [7, 'ECO_PRO_EFFICIENT', DRIVE_MODE.OTHER], [8, 'ECO_PRO_PLUS', DRIVE_MODE.OTHER], [9, 'ECO_PRO_INDIVIDUAL', DRIVE_MODE.OTHER],
    [10, 'ADAPTIVE', DRIVE_MODE.OTHER],
    [15, 'PHEV_SPORT_STANDARD', DRIVE_MODE.SPORT], [16, 'PHEV_SPORT_INDIVIDUAL', DRIVE_MODE.SPORT],
    [17, 'PHEV_HYBRID_STANDARD', DRIVE_MODE.OTHER], [18, 'PHEV_HYBRID_ECO', DRIVE_MODE.OTHER], [19, 'PHEV_HYBRID_COMFORT', DRIVE_MODE.OTHER],
    [20, 'PHEV_ELECTRIC_STANDARD', DRIVE_MODE.OTHER], [21, 'PHEV_ELECTRIC_INDIVIDUAL', DRIVE_MODE.OTHER],
    [23, 'PHEV_SPORT_PLUS', DRIVE_MODE.SPORT], [28, 'BOOST', DRIVE_MODE.BOOST],
];
const BATTERY_CONTROL_WIRE = 22;    // plug-in hybrid battery control: a number only in the tables

test('driveModeOf: each mode the car sends, as wire number, numeric string and enum name', () => {
    MODES_SENT.forEach((m) => {
        const wire = m[0], name = m[1], want = m[2];
        const got = [driveModeOf(wire), driveModeOf(String(wire)), driveModeOf(' ' + wire + ' '), driveModeOf(name), driveModeOf(name.toLowerCase())];
        say('    ' + wire + ' / ' + name + ' -> ' + got.join(', ') + ' (want ' + want + ')');
        got.forEach((g) => assert.strictEqual(g, want, wire + ' / ' + name));
    });
    assert.strictEqual(driveModeOf(BATTERY_CONTROL_WIRE), DRIVE_MODE.OTHER, 'wire 22');
});

test('driveModeOf: start-up values, numbers outside the tables and unknown names are unknown (null)', () => {
    const known = MODES_SENT.map((m) => m[0]).concat([BATTERY_CONTROL_WIRE]);
    const unknownWires = [];
    for (let n = 0; n <= 63; n++) if (known.indexOf(n) < 0) unknownWires.push(n);
    unknownWires.forEach((n) => assert.strictEqual(driveModeOf(n), null, 'wire ' + n));
    say('    unknown wires: ' + unknownWires.join(' '));
    [undefined, null, '', '  ', 'SIGNAL_UNGUELTIG', 'INITIALISIERUNG', 'NOT_DEFINED', -1, 1.5].forEach((raw) => {
        say('    ' + JSON.stringify(raw) + ' -> ' + driveModeOf(raw));
        assert.strictEqual(driveModeOf(raw), null, JSON.stringify(raw));
    });
});

test('tintsIn: Sport and XtraBoost, or XtraBoost only', () => {
    const table = [
        [DRIVE_MODE.SPORT, TINT_IN.SPORT_AND_BOOST, true], [DRIVE_MODE.BOOST, TINT_IN.SPORT_AND_BOOST, true],
        [DRIVE_MODE.OTHER, TINT_IN.SPORT_AND_BOOST, false], [null, TINT_IN.SPORT_AND_BOOST, false],
        [DRIVE_MODE.SPORT, TINT_IN.BOOST_ONLY, false], [DRIVE_MODE.BOOST, TINT_IN.BOOST_ONLY, true],
        [DRIVE_MODE.OTHER, TINT_IN.BOOST_ONLY, false], [null, TINT_IN.BOOST_ONLY, false],
    ];
    table.forEach((t) => {
        say('    mode ' + t[0] + ', tintIn ' + t[1] + ' -> ' + tintsIn(t[0], t[1]));
        assert.strictEqual(tintsIn(t[0], t[1]), t[2]);
    });
});

/* ---------------- shader.js ---------------- */

test('glslFloat: always a GLSL float literal, rounded to 4 places', () => {
    const table = [[1, '1.0'], [0, '0.0'], [-2, '-2.0'], [19.2, '19.2'], [0.08, '0.08'], [Math.PI, '3.1416'], [-1.3962634, '-1.3963'], [370, '370.0']];
    table.forEach((t) => {
        say('    ' + t[0] + ' -> ' + shader.glslFloat(t[0]));
        assert.strictEqual(shader.glslFloat(t[0]), t[1]);
    });
});

test('fragmentShader: declares exactly the uniforms tint.js sends, and v_uv', () => {
    const src = code(shader.fragmentShader());
    const declared = [];
    src.replace(/uniform\s+\w+\s+(\w+)\s*;/g, (all, name) => { declared.push(name); return all; });
    say('    declared: ' + declared.join(', '));
    assert.deepStrictEqual(declared.slice().sort(), Object.keys(shader.UNIFORM).map((k) => shader.UNIFORM[k]).sort());
    assert.ok(/varying\s+vec2\s+v_uv\s*;/.test(src), 'v_uv declared');
    assert.ok(/^precision mediump float;/.test(src), 'precision first');
});

test('fragmentShader: GLSL ES 1.00 rules: float literals only, no reserved words, balanced brackets', () => {
    const src = code(shader.fragmentShader());
    const ints = [];
    src.replace(/(?:^|[^\w.])(\d+)(?![\w.])/g, (all, n) => { ints.push(n); return all; });
    say('    integer literals: ' + (ints.length ? ints.join(' ') : 'none'));
    assert.deepStrictEqual(ints, [], 'GLSL ES 1.00 has no int to float conversion');
    ['half', 'input', 'output', 'sample', 'filter', 'fixed', 'cast', 'sizeof', 'namespace', 'using', 'common', 'partition', 'active']
        .forEach((w) => assert.ok(!new RegExp('\\b' + w + '\\b').test(src), 'reserved word "' + w + '" used'));
    [['(', ')'], ['{', '}']].forEach((p) => {
        const open = src.split(p[0]).length, close = src.split(p[1]).length;
        assert.strictEqual(open, close, p[0] + ' ' + (open - 1) + ' vs ' + p[1] + ' ' + (close - 1));
    });
});

test('fragmentShader: every gauge band and keep-out box is drawn, at its place in hundreds of px', () => {
    const src = shader.fragmentShader();
    shader.GAUGES.forEach((g) => {
        const call = src.split('\n').find((l) => l.indexOf('// ' + g.id) >= 0);
        say('    ' + call.trim());
        assert.ok(call.indexOf('vec2(' + shader.glslFloat(g.cx / shader.UNIT_PX) + ', ' + shader.glslFloat(g.cy / shader.UNIT_PX) + ')') >= 0, g.id + ' centre');
        assert.ok(call.indexOf(shader.glslFloat(g.r0 / shader.UNIT_PX) + ', ' + shader.glslFloat(g.r1 / shader.UNIT_PX)) >= 0, g.id + ' radii');
    });
    shader.KEEP_OUT.forEach((k) => {
        const call = src.split('\n').find((l) => l.indexOf('// ' + k.id) >= 0);
        assert.ok(call, k.id + ' drawn');
        assert.ok(call.indexOf('vec4(' + k.box.map((v) => shader.glslFloat(v / shader.UNIT_PX)).join(', ') + ')') >= 0, k.id + ' box');
    });
    say('    ' + shader.GAUGES.length + ' bands, ' + shader.KEEP_OUT.length + ' keep-out boxes');
});

test('geometry: boxes and bands lie on the panel, and mediump squares stay in range', () => {
    shader.KEEP_OUT.forEach((k) => {
        const b = k.box;
        assert.ok(b[0] >= 0 && b[1] >= 0 && b[2] <= shader.PANEL_W && b[3] <= shader.PANEL_H, k.id + ' on the panel: ' + b);
        assert.ok(b[0] < b[2] && b[1] < b[3], k.id + ' has an area: ' + b);
    });
    shader.GAUGES.forEach((g) => {
        assert.ok(g.cx >= 0 && g.cx <= shader.PANEL_W && g.cy >= 0 && g.cy <= shader.PANEL_H, g.id + ' centre on the panel');
        assert.ok(g.r0 > 0 && g.r0 < g.r1, g.id + ' radii ' + g.r0 + '..' + g.r1);
        assert.ok(g.from < g.to && g.to - g.from < 360, g.id + ' arc ' + g.from + '..' + g.to);
    });
    // length(p - c) squares a difference of two points on the panel, in hundreds of px
    const worst = Math.pow(shader.PANEL_W / shader.UNIT_PX, 2) + Math.pow(shader.PANEL_H / shader.UNIT_PX, 2);
    say('    largest square in length(): ' + worst.toFixed(1) + ' (mediump guarantees ' + MEDIUMP_MAX + ')');
    assert.ok(worst < MEDIUMP_MAX);
});

test('fragmentShader: its size, with band() inlined per call, is far under what holds on the cluster', () => {
    const src = code(shader.fragmentShader());
    const tokens = (s) => (s.match(/[A-Za-z_]\w*|\d+\.\d*|\d+|[^\s\w]/g) || []).length;
    const bandBody = src.slice(src.indexOf('float band('), src.indexOf('float outside('));
    const total = tokens(src) + tokens(bandBody) * (shader.GAUGES.length - 1);
    say('    about ' + total + ' tokens inlined (' + SHADER_TOKENS_HELD + ' held on a car)');
    assert.ok(total < SHADER_TOKENS_HELD / 2);
});

/* ---------------- tint.js against a fake cluster-render ---------------- */

function quietLog() {
    const lines = [];
    const put = (level) => (s) => { lines.push(level + ' ' + s); say('    tint log: ' + level + ' ' + s); };
    return { lines, info: put('INFO'), warn: put('WARN'), error: put('ERROR') };
}

async function connectedTint() {
    const sock = path.join(tmpDir(), 'cr.sock');
    const fake = await startFake(sock, say);
    const log = quietLog();
    const tint = new TintLayer({ app: 'test_tint', log, socketPath: sock });
    tint.start();
    const hello = await fake.waitFor((m) => m.op === 'hello', 'the hello');
    const layer = await fake.waitFor((m) => m.op === 'layer', 'the layer');
    await until(() => tint.connected, 'tint.connected');
    return { fake, tint, log, hello, layer };
}

test('TintLayer.start: one hidden effect layer on the panel, ambient class, with the generated shader', async () => {
    const t = await connectedTint();
    try {
        assert.deepStrictEqual(t.hello, { op: 'hello', app: 'test_tint', proto: 1 });
        assert.strictEqual(t.layer.target, 'panel');
        assert.strictEqual(t.layer.kind, 'effect');
        assert.strictEqual(t.layer.class, 'ambient');
        assert.strictEqual(t.layer.visible, 0);
        assert.strictEqual(t.layer.fs, shader.fragmentShader());
        assert.strictEqual(t.tint.ref, t.layer.ref);
        assert.ok(t.log.lines.some((l) => /cluster-render connected \(id7\)/.test(l)), 'connection logged');
    } finally { t.tint.stop(); await t.fake.close(); }
});

test('TintLayer.show: colour, strength and outline uniforms, then the visibility', async () => {
    const t = await connectedTint();
    try {
        t.tint.show({ visible: true, color: 'violet', strength: 0.7, outline: false });
        assertColor((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_color', 'u_color')).v, 'violet', 'show');
        assert.strictEqual((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_strength', 'u_strength')).v, '0.7');
        assert.strictEqual((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_outline', 'u_outline')).v, '0');
        assert.deepStrictEqual(await t.fake.waitFor((m) => m.op === 'set', 'set'), { op: 'set', ref: t.layer.ref, visible: 1 });
        assert.strictEqual(t.tint.visible, true);
        t.tint.show({ visible: false, color: 'magenta', strength: 1, outline: true });
        assertColor((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_color', 'u_color')).v, 'magenta', 'second show');
        assert.strictEqual((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_outline', 'u_outline')).v, '1');
        assert.deepStrictEqual(await t.fake.waitFor((m) => m.op === 'set', 'set'), { op: 'set', ref: t.layer.ref, visible: 0 });
        assert.strictEqual(t.tint.visible, false);
    } finally { t.tint.stop(); await t.fake.close(); }
});

test('TintLayer.show: a colour not in COLORS throws and sends nothing', async () => {
    const t = await connectedTint();
    try {
        const before = t.fake.messages.length;
        assert.throws(() => t.tint.show({ visible: true, color: 'orange', strength: 0.7, outline: false }), /no colour "orange"/);
        await sleep(QUIET_MS);
        assert.strictEqual(t.fake.messages.length, before, 'nothing sent');
    } finally { t.tint.stop(); await t.fake.close(); }
});

test('TintLayer: the service\'s layer, target and error events set its state (other targets ignored)', async () => {
    const t = await connectedTint();
    try {
        let changes = 0;
        t.tint.on('change', () => { changes++; });
        t.fake.send({ ev: 'layer', ref: t.layer.ref, state: 'shown' });
        await until(() => t.tint.layerState === 'shown', 'layerState shown');
        t.fake.send({ ev: 'layer', ref: t.layer.ref + 1, state: 'error', reason: 'someone else\'s' });
        t.fake.send({ ev: 'target', target: 'hud', state: 'shown' });
        t.fake.send({ ev: 'target', target: 'panel', state: 'parked', holder: 'stock', reason: 'parked behind stock' });
        await until(() => t.tint.targetState === 'parked', 'targetState parked');
        assert.strictEqual(t.tint.layerState, 'shown', 'another ref\'s layer event ignored');
        t.fake.send({ ev: 'error', op: 'uniform', ref: t.layer.ref, reason: 'too many uniforms' });
        await until(() => t.tint.refused === 'uniform: too many uniforms', 'refused');
        say('    state: layer ' + t.tint.layerState + ', target ' + t.tint.targetState + ', refused ' + t.tint.refused + ', ' + changes + ' changes');
        assert.strictEqual(changes, 3, 'one change per event of ours');
        assert.ok(t.log.lines.some((l) => l === 'INFO cluster parked (stock): parked behind stock'), 'target state logged');
        assert.ok(t.log.lines.some((l) => /^WARN cluster-render refused uniform \(ref \d+\): too many uniforms$/.test(l)), 'refusal logged');
    } finally { t.tint.stop(); await t.fake.close(); }
});

test('TintLayer: after the service restarts, the layer comes back with its last look', async () => {
    const t = await connectedTint();
    try {
        t.tint.show({ visible: true, color: 'pink', strength: 0.55, outline: false });
        await t.fake.waitFor((m) => m.op === 'set', 'set');
        t.fake.sockets.forEach((s) => s.destroy());
        await until(() => !t.tint.connected, 'the disconnect');
        assert.strictEqual(t.tint.layerState, 'none');
        await t.fake.waitFor((m) => m.op === 'hello', 'the hello again');
        const again = await t.fake.waitFor((m) => m.op === 'layer', 'the layer again');
        say('    layer again: ref ' + again.ref + ', visible ' + again.visible);
        assert.strictEqual(again.ref, t.layer.ref);
        assert.strictEqual(again.visible, 1);
        assert.strictEqual(again.fs, shader.fragmentShader());
        assertColor((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_color', 'u_color again')).v, 'pink', 'after restart');
        assert.strictEqual((await t.fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_strength', 'u_strength again')).v, '0.55');
        await until(() => t.tint.connected, 'connected again');
    } finally { t.tint.stop(); await t.fake.close(); }
});

test('TintLayer.stop: closes the connection and does not come back', async () => {
    const t = await connectedTint();
    const closed = t.fake.waitForClose('the tint');
    t.tint.stop();
    await closed;
    await sleep(QUIET_MS * 3);
    say('    connections after stop: ' + t.fake.sockets.size);
    assert.strictEqual(t.fake.sockets.size, 0, 'no reconnect');
    await t.fake.close();
});

/* ---------------- app.json, mgu-repo.json ---------------- */

test('app.json: settings agree with the code (colours, tintIn), defaults are offered values', () => {
    const setting = (key) => SPEC.settings.find((s) => s.key === key);
    const values = (s) => s.options.map((o) => o[0]).sort();
    assert.deepStrictEqual(values(setting('color')), Object.keys(COLORS).sort(), 'color options = COLORS');
    assert.deepStrictEqual(values(setting('tintIn')), Object.keys(TINT_IN).map((k) => TINT_IN[k]).sort(), 'tintIn options = TINT_IN');
    SPEC.settings.forEach((s) => {
        if (s.type === 'choice') assert.ok(s.options.some((o) => o[0] === s.default), s.key + ' default offered');
        if (s.type === 'number') assert.ok(s.steps.indexOf(s.default) >= 0 && s.steps.every((v) => v > 0 && v <= 100), s.key + ' steps 1-100 %');
        say('    ' + s.key + ' (' + s.type + ') default ' + JSON.stringify(s.default));
    });
});

test('app.json + mgu-repo.json: iDrive 7, autostart, cluster-render required, FES subscribed', () => {
    assert.strictEqual(SPEC.id, APP_ID);
    assert.strictEqual(SPEC.autostart, true);
    assert.deepStrictEqual(SPEC.mguHmi, ['ID7']);
    assert.deepStrictEqual(REPO.apps.mguHmi, ['ID7']);
    assert.deepStrictEqual(SPEC.requires, REPO.apps.requires, 'the same cluster-render version in both');
    assert.ok(/^OA[0-9A-Z]{2}$/.test(SPEC.loggingId), 'loggingId ' + SPEC.loggingId);
    assert.ok(SPEC.signals[FES][FES_FIELD].indexOf('s') >= 0, 'FES subscribed');
    REPO.apps.build.shared.filter((p) => p !== 'oap-sdk').forEach((p) => assert.ok(fs.existsSync(path.join(ROOT, p)), 'shared path ' + p + ' exists'));
});

/* ---------------- Node 8 ---------------- */

test('Node 8.16.2: the app\'s sources use no syntax or API newer than ES2017', () => {
    const NEWER = [
        [/\?\./, 'optional chaining'], [/\?\?/, 'nullish coalescing'], [/catch\s*\{/, 'optional catch binding'],
        [/\.flat(Map)?\(/, 'Array.prototype.flat'], [/Object\.fromEntries/, 'Object.fromEntries'],
        [/\.matchAll\(/, 'String.prototype.matchAll'], [/\.replaceAll\(/, 'String.prototype.replaceAll'],
        [/for\s+await/, 'async iteration'], [/\b\d+n\b/, 'BigInt literal'], [/#\w+\s*[=;(]/, 'private class field'],
    ];
    fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js')).forEach((f) => {
        const src = jsCode(fs.readFileSync(path.join(APP_DIR, f), 'utf8'));
        NEWER.forEach((n) => assert.ok(!n[0].test(src), f + ' uses ' + n[1]));
        say('    ' + f + ': ok');
    });
});

/* ---------------- end to end ---------------- */

test('end to end: the built app follows the drive mode and the settings', async () => {
    say('    building: python3 kit/tools/build.py --preview-only ' + APP_ID);
    childProcess.execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), '--preview-only', APP_ID], { cwd: ROOT, stdio: 'inherit' });
    const dir = tmpDir();
    const sock = path.join(dir, 'cr.sock');
    const fake = await startFake(sock, say);
    const rows = [];
    const appLog = [];
    const env = Object.assign({}, process.env);
    env[SOCKET_ENV] = sock;
    const app = childProcess.fork(path.join(__dirname, 'run_app.js'), [STAGE, path.join(dir, 'data')], { env });
    app.on('message', (m) => {
        if (m.t === 'log') { appLog.push(m.s); say('    app: ' + m.s); }
        if (m.t === 'cells' && m.name === 'STATUS') rows.push(m.cells);
    });
    const feed = (value) => { say('    -> drive mode ' + JSON.stringify(value)); app.send({ t: 'feed', iface: FES, field: FES_FIELD, value: { actualValueModeDrivingExperience: value } }); };
    const setting = (key, value) => { say('    -> setting ' + key + ' = ' + JSON.stringify(value)); app.send({ t: 'set', key, value }); };
    async function expectLook(what, look) {
        assertColor((await fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_color', what + ': u_color')).v, look.color, what);
        assert.strictEqual(Number((await fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_strength', what + ': u_strength')).v), look.strength, what + ': strength');
        assert.strictEqual(Number((await fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_outline', what + ': u_outline')).v), look.outline ? 1 : 0, what + ': outline');
        assert.strictEqual((await fake.waitFor((m) => m.op === 'set', what + ': set')).visible, look.visible ? 1 : 0, what + ': visible');
        say('    <- ' + what + ': ' + (look.visible ? 'shown' : 'hidden'));
    }
    async function expectQuiet(what) {
        const before = fake.messages.length;
        await sleep(QUIET_MS);
        assert.strictEqual(fake.messages.length, before, what + ': nothing sent');
        say('    <- ' + what + ': nothing sent');
    }
    try {
        const layer = await fake.waitFor((m) => m.op === 'layer', 'the tint layer');
        assert.strictEqual(layer.target, 'panel');
        assert.strictEqual(layer.visible, 0, 'hidden before any drive mode');
        assertColor((await fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_color', 'start: u_color')).v, 'violet', 'start');
        assert.strictEqual((await fake.waitFor((m) => m.op === 'uniform' && m.name === 'u_strength', 'start: u_strength')).v, '0.7');
        await until(() => rows.some((r) => /cluster-render connected/.test(r.Text2ndRow)), 'the status row saying connected');

        feed('COMFORT');
        await expectLook('Comfort', { color: 'violet', strength: 0.7, outline: false, visible: false });
        feed(15);
        await expectLook('plug-in hybrid Sport', { color: 'violet', strength: 0.7, outline: false, visible: true });
        feed(15);
        await expectQuiet('the same mode again');
        feed(28);
        await expectLook('XtraBoost', { color: 'violet', strength: 0.7, outline: false, visible: true });
        setting('tintIn', 'boost');
        await expectLook('XtraBoost only, in XtraBoost', { color: 'violet', strength: 0.7, outline: false, visible: true });
        feed('PHEV_SPORT_STANDARD');
        await expectLook('XtraBoost only, back in Sport', { color: 'violet', strength: 0.7, outline: false, visible: false });
        feed(61);
        await expectQuiet('a start-up value');
        setting('color', 'pink');
        await expectLook('pink', { color: 'pink', strength: 0.7, outline: false, visible: false });
        setting('outline', true);
        await expectLook('calibration outline', { color: 'pink', strength: 0.7, outline: true, visible: true });
        setting('strength', 40);
        await expectLook('strength 40 %', { color: 'pink', strength: 0.4, outline: true, visible: true });
        setting('enabled', false);
        await expectLook('switched off', { color: 'pink', strength: 0.4, outline: true, visible: false });

        fake.send({ ev: 'layer', ref: layer.ref, state: 'shown' });
        await until(() => rows.some((r) => /layer shown/.test(r.Text2ndRow)), 'the status row saying layer shown');
        const last = rows[rows.length - 1];
        say('    status row: "' + last.Text1stRow + '" / "' + last.Text2ndRow + '"');
        assert.strictEqual(last.Text1stRow, 'Tint off | drive mode sport');
        assert.ok(appLog.some((l) => l === 'INFO drive mode 61: unknown, kept sport'), 'the unknown value logged');
        assert.ok(!appLog.some((l) => /^(WARN|ERROR)/.test(l) && !/someip|SOME\/IP|preview/i.test(l)), 'no warnings or errors but the stub\'s:\n' + appLog.filter((l) => /^(WARN|ERROR)/.test(l)).join('\n'));
    } finally {
        app.kill();
        await fake.close();
    }
});

/* ---------------- run ---------------- */

(async () => {
    let failed = 0;
    for (const t of tests) {
        say('\n[TEST] ' + t.name);
        try {
            await t.fn();
            say('[PASS] ' + t.name);
        } catch (e) {
            failed++;
            say('[FAIL] ' + t.name + '\n' + (e && e.stack || e));
        }
    }
    say('\n' + (tests.length - failed) + ' of ' + tests.length + ' tests passed');
    process.exit(failed ? 1 : 0);
})();
