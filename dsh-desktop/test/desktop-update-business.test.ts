import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { UpdateBusinessService } from '../shared/business/update-business.ts';

test('update business exposes explicit Linux client updater boundary', async () => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-update-business-'));
  try {
    const service = new UpdateBusinessService({
      runtime: {
        userDataDir: path.join(dir, 'user-data'),
        dshHome: path.join(dir, 'dsh-home'),
        appVersion: '4.6.0',
      },
    });
    const result = await service.check('client');
    assert.equal(result.kind, 'client');
    assert.equal(result.state, 'unsupported');
    assert.match(result.message ?? '', /系统包管理器|AppImage/);
    const apply = service.startApply('client');
    assert.equal(apply.ok, false);
    assert.match(apply.error ?? '', /系统包管理器|AppImage/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update business rejects unknown kinds and invalid agent jobs', () => {
  const service = new UpdateBusinessService({
    runtime: {
      userDataDir: '/tmp/dsh-update-test-user-data',
      dshHome: '/tmp/dsh-update-test-home',
      appVersion: '4.6.0',
    },
  });
  assert.throws(() => service.state('other'), /unknown update kind/);
  const invalid = service.startApply('agent', 'not-a-version');
  assert.deepEqual(invalid, { ok: false, error: '没有可安装的有效 agent 版本' });
});
