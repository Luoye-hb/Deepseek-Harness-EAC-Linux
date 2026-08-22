import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { PluginBusinessService } from '../shared/business/plugin-business.ts';

const root = path.join(import.meta.dirname, '..');

test('shell-neutral plugin business service lists and toggles profile plugins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-business-'));
  const profile = path.join(dir, 'dsh-home', 'profiles', 'web-desktop');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web-desktop',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }),
  );
  fs.writeFileSync(
    path.join(profile, 'cordis.patch.yml'),
    [
      '- insert:',
      '    - id: easy-setup',
      "      name: 'dsh-easy-setup'",
      '',
    ].join('\n'),
  );
  try {
    const service = new PluginBusinessService({
      runtime: {
        userDataDir: path.join(dir, 'user-data'),
        dshHome: path.join(dir, 'dsh-home'),
        assetsDir: path.join(root, 'assets', 'plugins'),
      },
    });
    const before = service.list().find((row) => row.id === 'easy-setup');
    assert.ok(before);
    assert.equal(before.enabled, true);
    assert.equal(before.toggleable, true);

    assert.deepEqual(service.setEnabled('easy-setup', false), {
      ok: true,
      restartRequired: true,
    });
    assert.equal(
      service.list().find((row) => row.id === 'easy-setup')?.enabled,
      false,
    );

    assert.deepEqual(service.setEnabled('easy-setup', true), {
      ok: true,
      restartRequired: true,
    });
    assert.equal(
      service.list().find((row) => row.id === 'easy-setup')?.enabled,
      true,
    );

    const core = service.setRemoved('plugin-manager', true);
    assert.equal(core.ok, false);
    assert.match(String(core.error), /核心插件不可移除/);

    const guardStatus = service.guardAction('status', undefined, false) as {
      ok: boolean;
      profile: string;
      snapshots: unknown[];
    };
    assert.equal(guardStatus.ok, true);
    assert.equal(guardStatus.profile, 'web-desktop');
    assert.deepEqual(guardStatus.snapshots, []);

    const pasted = service.imagePasteSave(
      'data:image/png;base64,AA==',
      '../unsafe:name',
    );
    assert.equal(pasted.ok, true);
    assert.equal(typeof pasted.path, 'string');
    assert.equal(pasted.size, 1);
    assert.ok(fs.existsSync(String(pasted.path)));
    fs.rmSync(String(pasted.path), { force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
