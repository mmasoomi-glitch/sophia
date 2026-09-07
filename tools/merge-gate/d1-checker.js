// D1 Reachability — blocking. Every changed application module (.js/.mjs/.cjs, excluding test and setup files)
// must be reachable from the configured entrypoints through static imports, require(), dynamic import('...')
// with a literal specifier, or re-exports (export * from / export { x } from).
//
// Entrypoints: merge-gate.config.json {"entrypoints": [...]}, else package.json "entrypoints", else "main".
// Exit 2 (gate error, not a code defect) when none are configured.
//
// CANNOT follow: computed specifiers (require(path.join(...)), import(`./${name}`)), require.resolve, bare
// package names, anything loaded by a non-JS file (HTML, config), or workers/plugins started by string path.
// List such modules as extra entrypoints.
const fs = require('fs');
const path = require('path');
const lib = require('./gate-lib.js');

function loadEntrypoints(projectDir) {
  const cfgPath = path.join(projectDir, 'merge-gate.config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (Array.isArray(cfg.entrypoints) && cfg.entrypoints.length) return { entrypoints: cfg.entrypoints, source: 'merge-gate.config.json' };
  }
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (Array.isArray(pkg.entrypoints) && pkg.entrypoints.length) return { entrypoints: pkg.entrypoints, source: 'package.json entrypoints' };
    if (pkg.main) return { entrypoints: [pkg.main], source: 'package.json main' };
  }
  return { entrypoints: [], source: null };
}

function checkReachability(projectDir, changedFiles = null, opts = {}) {
  try {
    const { entrypoints, source } = Array.isArray(opts.entrypoints) && opts.entrypoints.length
      ? { entrypoints: opts.entrypoints, source: 'argument' }
      : loadEntrypoints(projectDir);
    if (entrypoints.length === 0) {
      return { exitCode: 2, stdout: 'no entrypoints configured (merge-gate.config.json "entrypoints", or package.json "entrypoints"/"main")\n' };
    }
    const roots = entrypoints.map(lib.normalizeRel);

    const all = changedFiles ? changedFiles.map(lib.normalizeRel) : lib.walkFiles(projectDir, lib.isGateFile);
    const files = all.filter(f => lib.isGateFile(f) && !lib.isTestFile(f) && !lib.isSetupFile(f));
    const tests = all.filter(f => lib.isGateFile(f) && (lib.isTestFile(f) || lib.isSetupFile(f)));
    if (files.length === 0) {
      return { exitCode: 0, stdout: `no gate-relevant application modules among ${all.length} changed file(s)${tests.length ? ` (${tests.length} test/setup file(s) are out of D1 scope)` : ''}\n` };
    }

    const reachable = new Set(roots);
    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.shift();
      let content;
      try { content = lib.readRel(projectDir, current); } catch { continue; }
      for (const b of lib.extractImports(content, current, projectDir)) {
        if (!b.resolved || reachable.has(b.resolved)) continue;
        reachable.add(b.resolved);
        queue.push(b.resolved);
      }
    }

    const unreachable = files.filter(f => !reachable.has(f));
    const rootsLabel = `[${roots.join(', ')}] (${source})`;
    if (unreachable.length > 0) {
      return { exitCode: 1, stdout: unreachable.map(f => `${f}: unreachable from entrypoints ${rootsLabel}`).join('\n') + '\n' };
    }
    return { exitCode: 0, stdout: `all ${files.length} changed module(s) reachable from ${rootsLabel}${tests.length ? `; ${tests.length} test/setup file(s) out of D1 scope` : ''}\n` };
  } catch (e) {
    return { exitCode: 2, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkReachability, loadEntrypoints };
