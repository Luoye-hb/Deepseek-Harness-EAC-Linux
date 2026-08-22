import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  buildWebViewMigration,
  migrationChecksum,
  persistWebViewMigration,
  WEBVIEW_MIGRATION_FILE,
} from '../lib/webview-migration.ts';

test('webview migration is checksummed, bounded, and idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webview-migration-'));
  try {
    const value = buildWebViewMigration(
      'http://127.0.0.1:43123/',
      {
        localStorage: { 'dsh.sessions.current': '{"sessionId":"s-1"}' },
        indexedDb: [{
          name: 'dsh',
          version: 1,
          stores: [{
            name: 'settings',
            keyPath: 'id',
            autoIncrement: false,
            records: [{ key: 'main', value: { id: 'main', enabled: true } }],
          }],
        }],
      },
      [{
        url: 'http://127.0.0.1:43123/',
        name: 'session',
        value: 'value',
        domain: '127.0.0.1',
        path: '/',
        secure: false,
        httpOnly: false,
      }],
      new Date('2026-08-22T00:00:00.000Z'),
    );
    const { checksum, ...base } = value;
    assert.equal(checksum, migrationChecksum(base));
    const file = persistWebViewMigration(dir, value.origin, {
      localStorage: value.localStorage,
      indexedDb: value.indexedDb,
    }, value.cookies, new Date('2026-08-22T00:00:00.000Z'));
    assert.equal(file, path.join(dir, WEBVIEW_MIGRATION_FILE));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).checksum, value.checksum);
    if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777), 0o600);

    const replacement = buildWebViewMigration(value.origin, { localStorage: { changed: 'no' } }, []);
    persistWebViewMigration(dir, value.origin, { localStorage: { changed: 'no' } }, []);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).checksum, value.checksum);
    assert.notEqual(replacement.checksum, value.checksum);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
