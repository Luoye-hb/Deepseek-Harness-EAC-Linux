import * as fs from 'node:fs';

export interface LinuxUpdateGuidance {
  message: string;
  detail: string;
}

export interface LinuxUpdateContext {
  osReleasePath?: string;
  appImagePath?: string;
}

export function parseOsRelease(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value.replace(/\\([\\"'$`])/g, '$1');
  }
  return out;
}

function osRelease(file: string): Record<string, string> {
  try {
    return parseOsRelease(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Linux package ownership stays with the installer format, never the app. */
export function linuxUpdateGuidance(ctx: LinuxUpdateContext = {}): LinuxUpdateGuidance {
  const appImagePath = ctx.appImagePath ?? process.env.APPIMAGE ?? '';
  if (appImagePath) {
    return {
      message: 'AppImage 更新由用户管理。',
      detail: `请下载新版 AppImage，赋予执行权限后替换当前文件。\n当前 AppImage：${appImagePath}`,
    };
  }
  const info = osRelease(ctx.osReleasePath ?? '/etc/os-release');
  const distro = `${info.ID ?? ''} ${info.ID_LIKE ?? ''}`.toLowerCase();
  if (/\b(arch|manjaro|endeavouros)\b/.test(distro)) {
    return {
      message: '请通过 pacman 更新 Deepseek Harness EAC。',
      detail: '运行：sudo pacman -Syu deepseek-harness-eac',
    };
  }
  if (/\b(debian|ubuntu|linuxmint|pop)\b/.test(distro)) {
    return {
      message: '请通过 APT 更新 Deepseek Harness EAC。',
      detail: '运行：sudo apt update && sudo apt install deepseek-harness-eac',
    };
  }
  if (/\b(fedora|rhel|centos|rocky|almalinux)\b/.test(distro)) {
    return {
      message: '请通过 DNF 更新 Deepseek Harness EAC。',
      detail: '运行：sudo dnf upgrade deepseek-harness-eac',
    };
  }
  if (/\b(opensuse|suse|sles)\b/.test(distro)) {
    return {
      message: '请通过 Zypper 更新 Deepseek Harness EAC。',
      detail: '运行：sudo zypper update deepseek-harness-eac',
    };
  }
  return {
    message: 'Linux 客户端更新由系统包管理器负责。',
    detail: '请使用安装本应用时采用的软件源更新 pacman、deb 或 rpm 包；本应用不会自行替换系统文件。',
  };
}
