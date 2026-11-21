'use strict';
/**
 * shader.js - the tint: one GLSL ES 1.00 fragment shader for a cluster-render effect layer over the whole
 * instrument cluster (the 1920x720 "panel" target), generated from the geometry below.
 *
 * The cluster ECU draws BMW's gauges itself; this layer lies over them and is blended with normal alpha, so a
 * violet tint over BMW's Sport red comes out magenta-violet. It cannot read the pixels under it.
 *
 *   GAUGES    the bands where BMW draws its Sport red: a ring round each gauge's centre, over an arc
 *   KEEP_OUT  BMW's warning lights and readouts, left untouched (alpha 0, soft edge)
 *
 * Gauge geometry is a first estimate from the speedometer's needle sweep and speed digits; KEEP_OUT is the
 * keep-out list measured on a G30 530e iDrive 7 cluster (chyiz/idrive7-cluster-metrics shared/visible.js).
 * The "outline" setting draws every edge in white so a photo of the cluster shows where they lie.
 *
 * Units: the shader works in hundreds of px, so mediump squares (length()) stay far below its 2^14 range.
 * Angles: degrees in px space, 0 = right, 90 = down (y grows downwards, as v_uv does).
 * Node 8.16.2 (the car's): no optional chaining, no ??.
 */

const PANEL_TARGET = 'panel';
const PANEL_W = 1920;
const PANEL_H = 720;
const UNIT_PX = 100;
const FEATHER_PX = 28;
const KEEP_FEATHER_PX = 8;
const LINE_PX = 2;
const NONE_UNITS = 1000;
const DEG_TO_RAD = Math.PI / 180;

const UNIFORM = { COLOR: 'u_color', STRENGTH: 'u_strength', OUTLINE: 'u_outline' };

/** cx, cy: the gauge's centre; r0..r1: the band's radii; from..to: its arc (all px / degrees). */
const GAUGES = [
    { id: 'speedometer', cx: 520, cy: 384, r0: 250, r1: 370, from: 100, to: 260 },
    { id: 'power meter', cx: 1400, cy: 384, r0: 250, r1: 370, from: -80, to: 80 },
];

/** [x0, y0, x1, y1] px. */
const KEEP_OUT = [
    { id: 'lane centering light', box: [108, 120, 190, 220] },
    { id: 'brake, ABS and DSC lights', box: [10, 220, 195, 405] },
    { id: 'fuel gauge', box: [6, 418, 210, 642] },
    { id: 'speed digits', box: [420, 340, 620, 428] },
    { id: 'speed limit sign', box: [495, 536, 580, 672] },
    { id: 'range and clock', box: [126, 650, 480, 716] },
    { id: 'seat belt and airbag lights', box: [505, 648, 760, 716] },
    { id: 'master warning triangle', box: [1228, 586, 1274, 634] },
    { id: 'drive mode and gear', box: [1230, 652, 1426, 720] },
    { id: 'gear box', box: [1406, 342, 1597, 419] },
    { id: 'outside temperature', box: [1540, 652, 1668, 712] },
    { id: 'electric range', box: [1680, 650, 1814, 714] },
    { id: 'auto hold and park lights', box: [1748, 144, 1916, 265] },
    { id: 'steering fault light', box: [1810, 260, 1910, 340] },
    { id: 'right edge lights', box: [1805, 340, 1920, 425] },
    { id: 'battery gauge', box: [1782, 415, 1916, 642] },
];

/** n as a GLSL float literal (GLSL ES 1.00 needs the decimal point). */
function glslFloat(n) {
    const text = String(Number(n.toFixed(4)));
    return text.indexOf('.') >= 0 ? text : text + '.0';
}

function units(px) { return glslFloat(px / UNIT_PX); }

function bandCall(g) {
    const mid = (g.from + g.to) / 2 * DEG_TO_RAD;
    const halfArc = (g.to - g.from) / 2 * DEG_TO_RAD;
    const featherArc = FEATHER_PX / ((g.r0 + g.r1) / 2);
    return '    tint = max(tint, band(p, vec2(' + units(g.cx) + ', ' + units(g.cy) + '), ' + units(g.r0) + ', ' +
        units(g.r1) + ', ' + glslFloat(mid) + ', ' + glslFloat(halfArc) + ', ' + glslFloat(featherArc) +
        ', edge));  // ' + g.id + '\n    line = min(line, edge);';
}

function keepOutCall(k) {
    return '    o = outside(p, vec4(' + k.box.map(units).join(', ') + '));  // ' + k.id +
        '\n    keep *= smoothstep(0.0, KEEP_FEATHER, o);\n    line = min(line, abs(o));';
}

/** The fragment shader's source. */
function fragmentShader() {
    return [
        'precision mediump float;',
        'varying vec2 v_uv;',
        'uniform vec3 ' + UNIFORM.COLOR + ';',
        'uniform float ' + UNIFORM.STRENGTH + ';',
        'uniform float ' + UNIFORM.OUTLINE + ';',
        'const float PI = 3.14159265;',
        'const float NONE = ' + glslFloat(NONE_UNITS) + ';',
        'const float FEATHER = ' + units(FEATHER_PX) + ';',
        'const float KEEP_FEATHER = ' + units(KEEP_FEATHER_PX) + ';',
        'const float LINE = ' + units(LINE_PX) + ';',
        '',
        '// how much of the band at p is tinted (0..1); edge: distance from p to the band\'s outline',
        'float band(vec2 p, vec2 c, float r0, float r1, float mid, float halfArc, float featherArc, out float edge) {',
        '    vec2 d = p - c;',
        '    float r = length(d);',
        '    float off = abs(mod(atan(d.y, d.x) - mid + PI, 2.0 * PI) - PI);',
        '    float ring = off <= halfArc ? min(abs(r - r0), abs(r - r1)) : NONE;',
        '    float side = r >= r0 && r <= r1 ? abs(off - halfArc) * r : NONE;',
        '    edge = min(ring, side);',
        '    float radial = smoothstep(r0 - FEATHER, r0, r) * (1.0 - smoothstep(r1, r1 + FEATHER, r));',
        '    return radial * (1.0 - smoothstep(halfArc - featherArc, halfArc, off));',
        '}',
        '',
        '// how far p is outside the box (x0, y0, x1, y1); below 0 inside',
        'float outside(vec2 p, vec4 box) {',
        '    return max(max(box.x - p.x, p.x - box.z), max(box.y - p.y, p.y - box.w));',
        '}',
        '',
        'void main() {',
        '    vec2 p = v_uv * vec2(' + units(PANEL_W) + ', ' + units(PANEL_H) + ');',
        '    float tint = 0.0;',
        '    float keep = 1.0;',
        '    float line = NONE;',
        '    float edge;',
        '    float o;',
        GAUGES.map(bandCall).join('\n'),
        KEEP_OUT.map(keepOutCall).join('\n'),
        '    if (' + UNIFORM.OUTLINE + ' > 0.5 && line < LINE) { gl_FragColor = vec4(1.0); return; }',
        '    gl_FragColor = vec4(' + UNIFORM.COLOR + ', ' + UNIFORM.STRENGTH + ' * tint * keep);',
        '}',
        '',
    ].join('\n');
}

module.exports = { PANEL_TARGET, PANEL_W, PANEL_H, UNIT_PX, UNIFORM, GAUGES, KEEP_OUT, glslFloat, fragmentShader };
