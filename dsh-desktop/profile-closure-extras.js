'use strict';

const fs = require('node:fs');
const path = require('node:path');

function packageDir(root, name) {
  return path.join(root, ...String(name).split('/'));
}

function healthyPackage(dir) {
  try {
    return fs.statSync(path.join(dir, 'package.json')).isFile();
  } catch {
    return false;
  }
}

// dsh-app-boot builds <DSH_HOME>/profiles/node_modules from the dependency
// closure rooted at @deepseek-ai/dsh. App-level companion dependencies are
// outside that closure during source runs, so expose the small explicit set
// required by copied profile plugins before dsh starts.
function ensureProfileClosureExtras(home, appModulesDir, names, log = () => {}) {
  const fallbackRoot = path.join(home, 'profiles', 'node_modules');
  const linked = [];
  const unavailable = [];

  for (const name of names || []) {
    const source = packageDir(appModulesDir, name);
    if (!healthyPackage(source)) {
      unavailable.push(name);
      log(`profile closure extra unavailable: ${name}`);
      continue;
    }

    const destination = packageDir(fallbackRoot, name);
    if (healthyPackage(destination)) continue;

    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      try {
        const stat = fs.lstatSync(destination);
        if (stat.isSymbolicLink()) fs.unlinkSync(destination);
        else fs.rmSync(destination, { recursive: true, force: true });
      } catch {}
      fs.symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(name);
      log(`profile closure extra linked: ${name}`);
    } catch (err) {
      unavailable.push(name);
      log(`profile closure extra failed (${name}): ${err.message}`);
    }
  }

  return { linked, unavailable };
}

module.exports = { ensureProfileClosureExtras };
