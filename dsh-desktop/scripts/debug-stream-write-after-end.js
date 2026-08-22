"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_events_1 = require("node:events");
const node_stream_1 = require("node:stream");
const stream_write_guard_js_1 = require("../stream-write-guard.js");
function sink() {
    return new node_stream_1.Writable({ write(_chunk, _encoding, callback) { callback(); } });
}
async function reproduceUnsafeWrite() {
    const stream = sink();
    stream.end();
    const errorPromise = (0, node_events_1.once)(stream, 'error');
    stream.write('late child output');
    const [error] = await errorPromise;
    return error;
}
async function verifyGuardedWrite() {
    const stream = sink();
    const errors = [];
    const guard = (0, stream_write_guard_js_1.createStreamWriteGuard)(stream, { onError: (error) => errors.push(error) });
    guard.end();
    const accepted = guard.write('late child output');
    await (0, node_events_1.once)(stream, 'finish');
    return { accepted, errors };
}
(async () => {
    const unsafeError = await reproduceUnsafeWrite();
    const code = unsafeError.code ?? 'unknown';
    console.log(`[repro] unprotected: ${code} (${unsafeError.message})`);
    const guarded = await verifyGuardedWrite();
    if (guarded.accepted || guarded.errors.length > 0) {
        throw new Error('guarded stream accepted a late write or emitted an error');
    }
    console.log('[repro] guarded: late write rejected without stream error');
})().catch((error) => {
    console.error('[repro] FAIL', error);
    process.exitCode = 1;
});
