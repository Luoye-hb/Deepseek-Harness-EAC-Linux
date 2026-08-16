'use strict';

// Profile node_modules shadowing heal.
//
// dsh resolves a profile's plugins through the profile's own node_modules
// (pnpm-managed for out-of-tree plugins) first, then the installation
// fallback <home>/profiles/node_modules (one junction per package of the
// bundled app's dependency closure, maintained by dsh-app-boot). When pnpm
// hoists real copies of closure packages (@deepseek-ai/dsh-scope, cordis,
// ...) into a profile's node_modules — e.g. as peer/ transitive deps of a
// `dsh plugin add`-installed plugin — those copies shadow the junctions and
// load as second module instances. Symbol identity then breaks across the
// tree (scoped registration, prompt-section registries, ...), which surfaced
// as `prompt section "deployment:persona" is already registered` and broken
// model-list / mode switching.
//
// healProfileModuleShadowing removes real-directory copies in the web
// profile's node_modules that shadow a fallback link, so resolution falls
// back to the junctions — one instance, shared with the host app. Local
// packages with no fallback counterpart (out-of-tree plugins themselves) and
// link-typed entries are left untouched. Returns the removed package names.

const fs = require('node:fs');
const path = require('node:path');

function healProfileModuleShadowing(home, log = () => {}) {
  const fallbackDir = path.join(home, 'profiles', 'node_modules');
  const profileModulesDir = path.join(home, 'profiles', 'web', 'node_modules');

  // Collect every package name the fallback exposes (scoped + unscoped).
  const names = [];
  let entries;
  try { entries = fs.readdirSync(fallbackDir, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      names.push({ full: entry.name, rel: entry.name });
    } else if (entry.isDirectory()) {
      let children;
      try { children = fs.readdirSync(path.join(fallbackDir, entry.name), { withFileTypes: true }); } catch { continue; }
      for (const child of children) {
        names.push({ full: entry.name + '/' + child.name, rel: path.join(entry.name, child.name) });
      }
    }
  }

  const removed = [];
  for (const { full, rel } of names) {
    // Issue #7 guard: only delete the profile's real copy when the fallback
    // link it should fall back to is actually healthy (target dir has a
    // package.json). A damaged app node_modules (empty skeletons after a
    // botched upgrade) or a dangling junction means the shadow is the LAST
    // healthy copy — removing it would brick module resolution for good.
    const fallbackEntry = path.join(fallbackDir, rel);
    let fallbackHealthy = false;
    try {
      const st = fs.lstatSync(fallbackEntry);
      const target = st.isSymbolicLink() ? fs.realpathSync(fallbackEntry) : fallbackEntry;
      fallbackHealthy = fs.existsSync(path.join(target, 'package.json'));
    } catch { fallbackHealthy = false; }
    if (!fallbackHealthy) {
      log('fallback entry unhealthy, keeping shadow copy: ' + full);
      continue;
    }
    const shadow = path.join(profileModulesDir, rel);
    let stat;
    try { stat = fs.lstatSync(shadow); } catch { continue; }
    // Only real directories shadow the fallback; links resolve elsewhere by design.
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    fs.rmSync(shadow, { recursive: true, force: true });
    removed.push(full);
    log('removed shadowing copy: ' + full);
  }
  return removed;
}

module.exports = { healProfileModuleShadowing };
