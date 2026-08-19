'use strict';

const fs = require('node:fs');

function parseOsRelease(text) {
  const values = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\([\\"$`])/g, '$1');
    }
    values[match[1]] = value;
  }
  return values;
}

function distroTokens(info) {
  return new Set(
    [info.ID, ...(info.ID_LIKE || '').split(/\s+/)]
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

function hasAny(tokens, candidates) {
  return candidates.some((candidate) => tokens.has(candidate));
}

function linuxUpdateGuidance(options = {}) {
  const env = options.env || process.env;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const osReleasePath = options.osReleasePath || '/etc/os-release';

  if (env.APPIMAGE) {
    return {
      message: 'AppImage 版本需要手动替换。',
      detail: '请下载新的 AppImage 文件，然后运行：\n\nchmod +x ./Deepseek-Harness-EAC-*.AppImage\n./Deepseek-Harness-EAC-*.AppImage',
    };
  }

  let info = {};
  try {
    info = parseOsRelease(readFileSync(osReleasePath, 'utf8'));
  } catch {}
  const tokens = distroTokens(info);
  const distroName = info.PRETTY_NAME || info.NAME || info.ID || '当前 Linux 发行版';

  if (hasAny(tokens, ['ubuntu', 'debian', 'linuxmint', 'pop'])) {
    return {
      message: 'Linux 版本由 APT 软件包管理器更新。',
      detail: `${distroName}\n\n请下载新的 .deb 包后运行：\n\nsudo apt install ./Deepseek-Harness-EAC-*.deb`,
    };
  }
  if (hasAny(tokens, ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'])) {
    return {
      message: 'Linux 版本由 DNF 软件包管理器更新。',
      detail: `${distroName}\n\n请下载新的 .rpm 包后运行：\n\nsudo dnf install ./Deepseek-Harness-EAC-*.rpm`,
    };
  }
  if (hasAny(tokens, ['opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'suse', 'sles'])) {
    return {
      message: 'Linux 版本由 Zypper 软件包管理器更新。',
      detail: `${distroName}\n\n请下载新的 .rpm 包后运行：\n\nsudo zypper install ./Deepseek-Harness-EAC-*.rpm`,
    };
  }
  if (hasAny(tokens, ['arch', 'manjaro', 'endeavouros', 'cachyos'])) {
    return {
      message: 'Linux 版本由 Pacman 软件包管理器更新。',
      detail: `${distroName}\n\n请下载新的 .pacman 包后运行：\n\nsudo pacman -U ./Deepseek-Harness-EAC-*.pacman`,
    };
  }

  return {
    message: 'Linux 客户端需要通过安装包手动更新。',
    detail: `${distroName}\n\n请选择发行版支持的 .deb、.rpm 或 .pacman 包；也可以下载 AppImage，赋予执行权限后直接运行。`,
  };
}

module.exports = { parseOsRelease, linuxUpdateGuidance };
