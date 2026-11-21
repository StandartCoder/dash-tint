'use strict';
/**
 * tint.js - the tint on the instrument cluster: one cluster-render effect layer (robertnisipeanu/idrive-apps) over
 * the whole panel, in the "ambient" class so any other app's content stays above it. The client reconnects by
 * itself and sends the layer again with its last uniforms and visibility.
 *
 *   const tint = new TintLayer({ app: 'dash_tint', log, socketPath });   // socketPath: undefined = the service's
 *   tint.on('change', () => ...);    // connected, layerState, targetState or refused changed
 *   tint.start();
 *   tint.show({ visible: true, color: 'violet', strength: 0.7, outline: false });
 *
 * Node 8.16.2 (the car's): no optional chaining, no ??.
 */
const EventEmitter = require('events');
const { ClusterRender } = require('./cluster_render_client');
const { PANEL_TARGET, UNIFORM, fragmentShader } = require('./shader');

const LAYER_CLASS = 'ambient';
const CHANNEL_MAX = 255;
const NO_LAYER = 'none';
const IDLE = 'idle';

/** app.json setting "color": its option values -> sRGB 0..255. */
const COLORS = {
    violet: [143, 0, 255],
    purple: [160, 32, 240],
    pink: [255, 64, 200],
    magenta: [255, 0, 255],
};

class TintLayer extends EventEmitter {
    constructor(o) {
        super();
        this.log = o.log;
        this.cr = new ClusterRender(o.app, o.socketPath);
        this.ref = 0;
        this.visible = false;
        this.connected = false;
        this.layerState = NO_LAYER;
        this.targetState = IDLE;
        this.refused = null;
    }

    start() {
        this.ref = this.cr.effect({ target: PANEL_TARGET, klass: LAYER_CLASS, visible: false, fs: fragmentShader() });
        this.cr.on('ready', () => this._update({ connected: true }, 'cluster-render connected (' + this.cr.backend + ')'));
        this.cr.on('disconnected', () => this._update({ connected: false, layerState: NO_LAYER, targetState: IDLE }, 'cluster-render gone'));
        this.cr.on('layer', (ref, state, reason) => {
            if (ref === this.ref) this._update({ layerState: state }, 'layer ' + state + (reason ? ': ' + reason : ''));
        });
        this.cr.on('target', (name, state, holder, reason) => {
            if (name === PANEL_TARGET) this._update({ targetState: state }, 'cluster ' + state + (holder ? ' (' + holder + ')' : '') + (reason ? ': ' + reason : ''));
        });
        this.cr.on('refused', (op, ref, reason) => {
            this.log.warn('cluster-render refused ' + op + ' (ref ' + ref + '): ' + reason);
            this._update({ refused: op + ': ' + reason }, null);
        });
        this.cr.connect();
    }

    /** look: { visible, color (a COLORS key), strength (0..1), outline }. Uniforms go before the visibility. */
    show(look) {
        const rgb = COLORS[look.color];
        if (!rgb) throw new Error('tint: no colour "' + look.color + '" (app.json "color" options and COLORS differ)');
        this.cr.uniform(this.ref, UNIFORM.COLOR, rgb.map((c) => c / CHANNEL_MAX));
        this.cr.uniform(this.ref, UNIFORM.STRENGTH, [look.strength]);
        this.cr.uniform(this.ref, UNIFORM.OUTLINE, [look.outline ? 1 : 0]);
        this.cr.set(this.ref, { visible: look.visible });
        this.visible = look.visible;
    }

    stop() { this.cr.close(); }

    _update(changes, what) {
        Object.assign(this, changes);
        if (what) this.log.info(what);
        this.emit('change');
    }
}

module.exports = { TintLayer, COLORS };
