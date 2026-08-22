import { once } from 'node:events';
import { Writable } from 'node:stream';
import { createStreamWriteGuard } from '../stream-write-guard.js';

function sink(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

async function reproduceUnsafeWrite(): Promise<Error> {
  const stream = sink();
  stream.end();
  const errorPromise = once(stream, 'error');
  stream.write('late child output');
  const [error] = await errorPromise;
  return error as Error;
}

async function verifyGuardedWrite(): Promise<{ accepted: boolean; errors: Error[] }> {
  const stream = sink();
  const errors: Error[] = [];
  const guard = createStreamWriteGuard(stream, { onError: (error) => errors.push(error) });
  guard.end();
  const accepted = guard.write('late child output');
  await once(stream, 'finish');
  return { accepted, errors };
}

(async () => {
  const unsafeError = await reproduceUnsafeWrite();
  const code = (unsafeError as Error & { code?: string }).code ?? 'unknown';
  console.log(`[repro] unprotected: ${code} (${unsafeError.message})`);

  const guarded = await verifyGuardedWrite();
  if (guarded.accepted || guarded.errors.length > 0) {
    throw new Error('guarded stream accepted a late write or emitted an error');
  }
  console.log('[repro] guarded: late write rejected without stream error');
})().catch((error: unknown) => {
  console.error('[repro] FAIL', error);
  process.exitCode = 1;
});
