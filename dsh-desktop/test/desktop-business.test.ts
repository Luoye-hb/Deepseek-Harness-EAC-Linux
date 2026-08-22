import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { DesktopBusinessService } from '../shared/business/desktop-business.ts';

test('shell-neutral balance business service persists and resets custom prices', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-business-'));
  const events: Array<{ event: string; payload: unknown }> = [];
  try {
    const service = new DesktopBusinessService({
      runtime: {
        userDataDir: path.join(dir, 'user-data'),
        dshHome: path.join(dir, 'dsh-home'),
      },
      notify: (event, payload) => events.push({ event, payload }),
    });

    const initial = service.getBalancePrices({ model: 'deepseek-v4-pro' });
    assert.equal(initial.ok, true);
    assert.equal(initial.current, null);

    const prices = {
      peak: { cacheMiss: 10, cacheHit: 1, output: 20 },
      offpeak: { cacheMiss: 5, cacheHit: 0.5, output: 10 },
    };
    assert.deepEqual(
      await service.setBalancePrices({ model: 'deepseek-v4-pro', prices }),
      { ok: true },
    );
    assert.deepEqual(
      service.getBalancePrices({ model: 'deepseek-v4-pro' }).current,
      prices,
    );
    assert.deepEqual(
      await service.resetBalancePrices({ model: 'deepseek-v4-pro' }),
      { ok: true },
    );
    assert.equal(
      service.getBalancePrices({ model: 'deepseek-v4-pro' }).current,
      null,
    );
    assert.ok(events.some((entry) => entry.event === 'balance.changed'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shell-neutral balance business service rejects unknown models and invalid prices', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-business-invalid-'));
  try {
    const service = new DesktopBusinessService({
      runtime: {
        userDataDir: path.join(dir, 'user-data'),
        dshHome: path.join(dir, 'dsh-home'),
      },
    });
    assert.deepEqual(
      await service.setBalancePrices({
        model: 'unknown-model',
        prices: {},
      }),
      { ok: false, error: '未知模型: unknown-model' },
    );
    const invalid = await service.setBalancePrices({
      model: 'deepseek-v4-pro',
      prices: {
        peak: { cacheMiss: -1, cacheHit: 1, output: 1 },
        offpeak: { cacheMiss: 1, cacheHit: 1, output: 1 },
      },
    });
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /高峰/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
