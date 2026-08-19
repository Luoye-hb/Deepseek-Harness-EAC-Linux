import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseOsRelease, linuxUpdateGuidance } = require('../linux-update-guidance.js');

function guidance(osRelease, env = {}) {
  return linuxUpdateGuidance({ env, readFileSync: () => osRelease });
}

test('解析 os-release 的引号和 ID_LIKE', () => {
  assert.deepEqual(parseOsRelease('ID=ubuntu\nPRETTY_NAME="Ubuntu 26.04 LTS"\nID_LIKE="debian"\n'), {
    ID: 'ubuntu', PRETTY_NAME: 'Ubuntu 26.04 LTS', ID_LIKE: 'debian',
  });
});

test('Ubuntu 和 Debian 系显示 apt + deb，不再显示 pacman', () => {
  const result = guidance('ID=ubuntu\nPRETTY_NAME="Ubuntu 26.04 LTS"\nID_LIKE=debian\n');
  assert.match(result.detail, /Ubuntu 26\.04 LTS/);
  assert.match(result.detail, /sudo apt install .*\.deb/);
  assert.doesNotMatch(result.detail, /pacman/);
});

test('Fedora/RHEL 系显示 dnf + rpm', () => {
  const result = guidance('ID=rocky\nPRETTY_NAME="Rocky Linux 10"\nID_LIKE="rhel centos fedora"\n');
  assert.match(result.detail, /sudo dnf install .*\.rpm/);
});

test('openSUSE 显示 zypper + rpm', () => {
  assert.match(guidance('ID="opensuse-tumbleweed"\n').detail, /sudo zypper install .*\.rpm/);
});

test('Arch 系显示 pacman 包命令', () => {
  assert.match(guidance('ID=manjaro\nID_LIKE=arch\n').detail, /sudo pacman -U .*\.pacman/);
});

test('AppImage 环境优先显示替换和执行说明', () => {
  const result = guidance('ID=ubuntu\n', { APPIMAGE: '/opt/Deepseek.AppImage' });
  assert.match(result.message, /AppImage/);
  assert.match(result.detail, /chmod \+x/);
});

test('未知发行版和缺失 os-release 时提供通用安装包说明', () => {
  assert.match(guidance('ID=gentoo\nPRETTY_NAME=Gentoo\n').detail, /\.deb、\.rpm 或 \.pacman/);
  const missing = linuxUpdateGuidance({ env: {}, readFileSync: () => { throw new Error('missing'); } });
  assert.match(missing.detail, /AppImage/);
});
