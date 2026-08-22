import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { FileBusinessService } from '../shared/business/file-business.ts';

test('shell-neutral file business service performs exact reverts and path fencing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-business-'));
  const workspace = path.join(dir, 'workspace');
  const file = path.join(workspace, 'notes.txt');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(file, 'new text', 'utf8');
  try {
    const service = new FileBusinessService({
      runtime: {
        userDataDir: path.join(dir, 'user-data'),
        dshHome: path.join(dir, 'dsh-home'),
      },
      fileRoots: () => [workspace],
    });
    assert.deepEqual(
      service.revert([{ path: file, oldText: 'old text', newText: 'new text' }]),
      { results: [{ path: file, status: 'reverted' }] },
    );
    assert.equal(fs.readFileSync(file, 'utf8'), 'old text');

    assert.deepEqual(service.validateOpen(file), { ok: true, path: file });
    assert.equal(
      service.validateOpen(path.join(workspace, 'run.exe')).error,
      'executable files are not openable from the file view',
    );
    assert.equal(
      service.validateOpen(path.join(dir, 'outside.txt')).error,
      'path outside session workspace',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
