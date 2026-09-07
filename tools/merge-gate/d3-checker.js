// D3 Self-Mock Disclosure — advisory (always exit 0; findings are tagged [UNTESTED]).
//
// Flags tests (and test setup files) that replace a CHANGED module with a double instead of exercising it:
//   1. framework module mocks whose target resolves to a changed file
//      (jest.mock / vi.mock / vi.mock(import()) / jest.unstable_mockModule / mock.module / td.replace / rewire /
//       proxyquire and esmock stub maps); a mock registered in a setup file applies to every test
//   2. member stubs on an imported changed module (sinon.stub(db[,'query']), jest.spyOn, vi.spyOn, mock.method)
//   3. reassignment or monkey-patching of an imported changed binding (db = fake, db.query = fake,
//      Object.assign(db, …)) and require.cache tampering
//   4. hand-written doubles: an object literal whose keys cover the changed module's exports, in a test that
//      does not reach that module through any import chain (the #866 shape)
//   5. a test named for a changed module that does not reach it through any import chain
//   6. framework mocks with a computed specifier (jest.mock(SPEC)) — reported because they cannot be verified
//
// CANNOT detect: doubles built inside helper modules the test imports, moduleNameMapper/alias config mocks,
// fakes passed in via dependency-injection parameters, Proxy wrappers, or duck-typed fakes whose keys do not
// match the export names.
const lib = require('./gate-lib.js');
const d2 = require('./d2-checker.js');

function checkSelfMocking(projectDir, changedFiles = null) {
  try {
    const changed = (changedFiles ? changedFiles.map(lib.normalizeRel) : lib.walkFiles(projectDir, lib.isGateFile))
      .filter(r => lib.isGateFile(r) && !lib.isTestFile(r) && !lib.isSetupFile(r));
    if (changed.length === 0) return { exitCode: 0, stdout: 'no gate-relevant changed modules\n' };
    const changedSet = new Set(changed);

    const exportsOf = {};
    for (const rel of changed) {
      try { exportsOf[rel] = Object.keys(d2.extractExports(lib.readRel(projectDir, rel), rel, projectDir)).filter(k => !k.startsWith('__')); }
      catch { exportsOf[rel] = []; }
    }

    const findings = [];
    const tests = lib.walkFiles(projectDir, lib.isTestFile);
    const setups = lib.walkFiles(projectDir, r => lib.isSetupFile(r) && !lib.isTestFile(r));

    for (const s of setups) {
      let content;
      try { content = lib.readRel(projectDir, s); } catch { continue; }
      for (const mk of lib.extractFrameworkMocks(content, s, projectDir)) {
        if (mk.resolved && changedSet.has(mk.resolved)) findings.push(`${s}: setup file ${mk.via}('${mk.spec}') replaces changed module ${mk.resolved} for every test`);
        else if (mk.computed) findings.push(`${s}: setup file ${mk.via}(${mk.spec}) uses a computed specifier; cannot verify it is not a changed module`);
      }
    }

    for (const t of tests) {
      let content;
      try { content = lib.readRel(projectDir, t); } catch { continue; }
      const imports = lib.extractImports(content, t, projectDir);
      const { reach } = lib.reachableFrom(t, projectDir);
      const bindingToRel = new Map(imports.filter(b => b.name && b.resolved && changedSet.has(b.resolved)).map(b => [b.name, b.resolved]));
      const flagged = new Set();
      const flag = (rel, msg) => { flagged.add(rel); findings.push(`${t}: ${msg}`); };

      for (const mk of lib.extractFrameworkMocks(content, t, projectDir)) {
        if (mk.resolved && changedSet.has(mk.resolved)) flag(mk.resolved, `${mk.via}('${mk.spec}') replaces changed module ${mk.resolved}`);
        else if (mk.computed) findings.push(`${t}: ${mk.via}(${mk.spec}) uses a computed specifier; cannot verify it is not a changed module`);
      }
      for (const st of lib.extractMemberStubs(content)) {
        const rel = bindingToRel.get(st.binding);
        if (rel) flag(rel, `${st.via}(${st.binding}${st.member === '*' ? '' : `, '${st.member}'`}) stubs ${st.member === '*' ? 'every member' : st.member} of changed module ${rel}`);
      }
      for (const [name, rel] of bindingToRel) {
        const re = lib.extractReassignments(content, name);
        if (re.length) flag(rel, `reassigns ${name}${re[0] === '(binding)' ? '' : re[0]} after importing changed module ${rel} (monkey-patch)`);
      }
      if (bindingToRel.size && lib.tampersModuleCache(content)) {
        for (const rel of new Set(bindingToRel.values())) flag(rel, `tampers with require.cache while importing changed module ${rel}`);
      }

      const literals = lib.extractObjectLiterals(content);
      for (const rel of changed) {
        if (reach.has(rel) || flagged.has(rel)) continue;
        const ex = exportsOf[rel];
        if (ex.length) {
          const need = Math.min(2, ex.length);
          const lit = literals.find(l => ex.filter(k => l.keys.has(k)).length >= need);
          if (lit) {
            const hit = ex.filter(k => lit.keys.has(k));
            flag(rel, `local '${lit.name}' is a hand-written double of ${rel} (keys: ${hit.join(', ')}); the test never reaches ${rel}`);
            continue;
          }
        }
        if (lib.stem(t) === lib.stem(rel)) flag(rel, `named for ${rel} but never reaches it through any import`);
      }
    }

    if (findings.length) return { exitCode: 0, stdout: findings.map(f => `${f} [UNTESTED]`).join('\n') + '\n' };
    return { exitCode: 0, stdout: `no self-mocking detected across ${tests.length} test file(s)${setups.length ? ` and ${setups.length} setup file(s)` : ''}\n` };
  } catch (e) {
    return { exitCode: 2, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkSelfMocking };
