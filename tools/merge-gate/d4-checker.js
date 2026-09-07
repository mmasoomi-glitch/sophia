// D4 Real-Dependency Smoke — exit 1 when a changed module has no real-dependency coverage.
//
// A changed module COUNTS AS COVERED when some test file
//   (a) loads the real module — directly (specifier resolves to the file), through a re-export barrel or helper
//       module that imports it (reported as "via …"), or by an inline dynamic import('./x') — and
//   (b) does not replace it with a framework mock (in the test or in a setup file), reassign/monkey-patch the
//       imported binding, or tamper with require.cache, and
//   (c) actually uses the binding: a member call, direct call, new, extends, destructuring, member extraction,
//       passing it as an argument, or any other reference beyond `typeof x` / `console.log(x)`.
// Name-matching between test and module is NOT evidence; it is only used to explain near-misses.
//
// CANNOT verify: that the module's own dependencies were real (see D3), that assertions are meaningful, that the
// test is run by the project's test command, aliases from moduleNameMapper/tsconfig paths, or a Proxy/wrapper
// around the real module (counts as real).
const lib = require('./gate-lib.js');

function checkRealDependencyCoverage(projectDir, changedFiles = null) {
  try {
    const changed = (changedFiles ? changedFiles.map(lib.normalizeRel) : lib.walkFiles(projectDir, lib.isGateFile))
      .filter(r => lib.isGateFile(r) && !lib.isTestFile(r) && !lib.isSetupFile(r));
    if (changed.length === 0) return { exitCode: 0, stdout: 'no gate-relevant changed modules\n' };
    const changedSet = new Set(changed);

    const globalMocks = new Map();
    for (const s of lib.walkFiles(projectDir, r => lib.isSetupFile(r) && !lib.isTestFile(r))) {
      let content;
      try { content = lib.readRel(projectDir, s); } catch { continue; }
      for (const mk of lib.extractFrameworkMocks(content, s, projectDir)) if (mk.resolved && changedSet.has(mk.resolved)) globalMocks.set(mk.resolved, `${s} (${mk.via})`);
    }

    const tests = lib.walkFiles(projectDir, lib.isTestFile);
    const covered = new Map();
    const nearMiss = new Map();
    const note = (rel, msg) => { if (!nearMiss.has(rel)) nearMiss.set(rel, []); nearMiss.get(rel).push(msg); };

    for (const t of tests) {
      let content;
      try { content = lib.readRel(projectDir, t); } catch { continue; }
      const imports = lib.extractImports(content, t, projectDir);
      const mocks = new Map();
      for (const mk of lib.extractFrameworkMocks(content, t, projectDir)) if (mk.resolved) mocks.set(mk.resolved, mk.via);
      const cacheTamper = lib.tampersModuleCache(content);
      const stubs = lib.extractMemberStubs(content);
      const { reach, parent } = lib.reachableFrom(t, projectDir);
      // Uses that go through a stubbed member (or a wholly stubbed/proxied binding) are not real.
      const realUses = (b) => {
        const mine = stubs.filter(s => s.binding === b.name);
        if (mine.some(s => s.member === '*')) return { uses: [], why: `${mine.find(s => s.member === '*').via}(${b.name}) replaces every member` };
        const stubbed = new Set(mine.map(s => s.member));
        const uses = lib.usesOf(content, b).filter(u => !stubbed.has(u));
        return { uses, why: stubbed.size && !uses.length ? `only calls stubbed member(s) ${[...stubbed].join(', ')}` : null };
      };

      for (const rel of changed) {
        if (covered.has(rel)) continue;
        if (globalMocks.has(rel)) continue;
        if (mocks.has(rel)) { note(rel, `${t} mocks it via ${mocks.get(rel)}`); continue; }
        if (cacheTamper) { note(rel, `${t} tampers with require.cache`); continue; }

        const direct = imports.filter(b => b.name && b.resolved === rel);
        if (direct.length) {
          const patched = direct.flatMap(b => lib.extractReassignments(content, b.name).map(r => `${b.name}${r === '(binding)' ? '' : r}`));
          if (patched.length) { note(rel, `${t} imports it but reassigns ${patched[0]}`); continue; }
          const judged = direct.map(realUses);
          const uses = [...new Set(judged.flatMap(j => j.uses))];
          if (uses.length) covered.set(rel, { test: t, uses });
          else note(rel, `${t} imports it but ${judged.find(j => j.why)?.why || 'never uses the binding'}`);
          continue;
        }
        if (imports.some(b => b.kind === 'dynamic-then' && b.resolved === rel)) { covered.set(rel, { test: t, uses: ['dynamic import() result used'] }); continue; }
        // A bare import('./x') or import './x' only loads the module; that exercises it only if it runs code on load.
        const loadedOnly = imports.some(b => (b.kind === 'dynamic' || b.kind === 'side-effect') && b.resolved === rel);
        if (loadedOnly) {
          let runsOnLoad = false;
          try { runsOnLoad = lib.hasTopLevelSideEffects(lib.readRel(projectDir, rel)); } catch {}
          if (runsOnLoad) { covered.set(rel, { test: t, uses: ['loaded; module runs code at top level'] }); continue; }
          note(rel, `${t} only loads it (side-effect import) and the module runs nothing at top level`);
          continue;
        }

        if (reach.has(rel)) {
          const chain = lib.pathTo(rel, parent, t);
          const hop = chain[0];
          const viaBindings = imports.filter(b => b.name && b.resolved === hop);
          const patched = viaBindings.flatMap(b => lib.extractReassignments(content, b.name));
          if (patched.length) { note(rel, `${t} reaches it via ${hop} but reassigns that binding`); continue; }
          const uses = [...new Set(viaBindings.flatMap(b => realUses(b).uses))];
          const hopLoadedOnly = imports.some(b => (b.kind === 'dynamic' || b.kind === 'side-effect' || b.kind === 'dynamic-then') && b.resolved === hop);
          if (uses.length) covered.set(rel, { test: t, uses, via: chain.join(' → ') });
          else if (hopLoadedOnly) {
            let runsOnLoad = false;
            try { runsOnLoad = lib.hasTopLevelSideEffects(lib.readRel(projectDir, rel)); } catch {}
            if (runsOnLoad) covered.set(rel, { test: t, uses: ['loaded; module runs code at top level'], via: chain.join(' → ') });
            else note(rel, `${t} only loads it via ${hop} and the module runs nothing at top level`);
          } else note(rel, `${t} reaches it via ${hop} but never uses that binding`);
          continue;
        }
        if (lib.stem(t) === lib.stem(rel)) note(rel, `${t} is named for it but never imports it`);
      }
    }

    const lines = [];
    let uncovered = 0;
    for (const rel of changed) {
      const c = covered.get(rel);
      if (c) lines.push(`${rel}: exercised by ${c.test}${c.via ? ` via ${c.via}` : ''} (${c.uses.join(', ')})`);
      else {
        uncovered++;
        const why = [];
        if (globalMocks.has(rel)) why.push(`mocked for every test in ${globalMocks.get(rel)}`);
        if (nearMiss.has(rel)) why.push(...nearMiss.get(rel));
        lines.push(`${rel}: no test loads and exercises the real module${why.length ? ' — ' + why.join('; ') : ''}`);
      }
    }
    return { exitCode: uncovered ? 1 : 0, stdout: lines.join('\n') + '\n' };
  } catch (e) {
    return { exitCode: 2, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkRealDependencyCoverage };
