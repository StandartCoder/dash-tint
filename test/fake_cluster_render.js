'use strict';
/**
 * fake_cluster_render.js - a stand-in for the cluster-render service on a Unix socket, speaking its wire format
 * (robertnisipeanu/idrive-apps native/cluster-render/PROTOCOL.md): u32 length (little-endian, the bytes after it),
 * u8 type, body; JSON messages are type 'J'. It answers the client's hello like an iDrive 7 service, keeps every
 * JSON message it got, and sends events on request.
 *
 *   const fake = await startFake(socketPath);
 *   const layer = await fake.waitFor((m) => m.op === 'layer', 'the layer');
 *   fake.send({ ev: 'layer', ref: layer.ref, state: 'shown' });
 *   await fake.close();
 */
const fs = require('fs');
const net = require('net');

const JSON_TYPE = 0x4a;
const HEADER_BYTES = 5;
const LENGTH_BYTES = 4;
const WAIT_MS = 5000;
const ID7_HELLO = { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' };

function encode(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const m = Buffer.alloc(HEADER_BYTES + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[LENGTH_BYTES] = JSON_TYPE;
    body.copy(m, HEADER_BYTES);
    return m;
}

function startFake(socketPath, log) {
    try { fs.unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const fake = { messages: [], cursor: 0, sockets: new Set(), waiters: [], closes: 0 };
    const say = log || (() => {});

    function received(msg) {
        fake.messages.push(msg);
        say('  fake cluster-render <- ' + JSON.stringify(msg).slice(0, 160));
        if (msg.op === 'hello') fake.send(ID7_HELLO);
        fake.waiters.slice().forEach((w) => w.check());
    }

    const server = net.createServer((sock) => {
        fake.sockets.add(sock);
        let buf = Buffer.alloc(0);
        sock.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= HEADER_BYTES) {
                const len = buf.readUInt32LE(0);
                if (buf.length < LENGTH_BYTES + len) break;
                const type = buf[LENGTH_BYTES];
                const body = buf.subarray(HEADER_BYTES, LENGTH_BYTES + len);
                buf = buf.subarray(LENGTH_BYTES + len);
                if (type !== JSON_TYPE) throw new Error('fake cluster-render: unexpected message type 0x' + type.toString(16));
                received(JSON.parse(body.toString('utf8')));
            }
        });
        sock.on('close', () => { fake.sockets.delete(sock); fake.closes++; fake.waiters.slice().forEach((w) => w.check()); });
    });

    /** Every connected client gets the event. */
    fake.send = (ev) => fake.sockets.forEach((s) => s.write(encode(ev)));

    /** The first message from the cursor on that matches; the cursor moves past it (messages arrive in order). */
    fake.waitFor = (match, what, ms) => new Promise((resolve, reject) => {
        const waiter = {
            check() {
                for (let i = fake.cursor; i < fake.messages.length; i++) {
                    if (!match(fake.messages[i])) continue;
                    fake.cursor = i + 1;
                    done();
                    resolve(fake.messages[i]);
                    return;
                }
            },
        };
        const timer = setTimeout(() => {
            done();
            reject(new Error('fake cluster-render: no ' + what + ' within ' + (ms || WAIT_MS) + ' ms; got since the last match:\n    ' +
                fake.messages.slice(fake.cursor).map((m) => JSON.stringify(m).slice(0, 200)).join('\n    ')));
        }, ms || WAIT_MS);
        function done() { clearTimeout(timer); fake.waiters = fake.waiters.filter((w) => w !== waiter); }
        fake.waiters.push(waiter);
        waiter.check();
    });

    /** Resolves once a client has disconnected (count closes so far + 1). */
    fake.waitForClose = (what) => {
        const want = fake.closes + 1;
        return new Promise((resolve, reject) => {
            const waiter = { check() { if (fake.closes >= want) { finish(); resolve(); } } };
            const timer = setTimeout(() => { finish(); reject(new Error('fake cluster-render: ' + what + ' did not disconnect')); }, WAIT_MS);
            function finish() { clearTimeout(timer); fake.waiters = fake.waiters.filter((w) => w !== waiter); }
            fake.waiters.push(waiter);
        });
    };

    fake.close = () => new Promise((resolve) => {
        fake.sockets.forEach((s) => s.destroy());
        server.close(() => resolve());
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve(fake));
    });
}

module.exports = { startFake, ID7_HELLO };
