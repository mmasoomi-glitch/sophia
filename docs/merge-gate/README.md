# Merge gate — current state (supersedes every other file in this directory)

**Read this first.** The other documents in `docs/merge-gate/` were written by orchestration agents on
2026-09-07 and contain claims that were measured to be false the same day ("16/16 passing", "100% accuracy",
"deploy immediately", "PR #1: all checkers passed"). They should be deleted; this file is the only description
of what the gate does.

## What is here

| File | Role | Blocking? |
|---|---|---|
| `merge-gate.js` | Orchestrator. Runs D1–D4 on the changed `.js/.mjs/.cjs` files; exit 0 / 1 / 2. | — |
| `tools/merge-gate/d1-checker.js` | Reachability: every changed application module must be import-reachable from the entrypoints in `merge-gate.config.json` (test/setup files are out of scope). | yes |
| `tools/merge-gate/d2-checker.js` | Interface conformance: `x.method()` on a whole-module import must exist on that module's exports (follows re-exports, class instances; opaque defaults are not judged). Catches #866. | yes |
| `tools/merge-gate/d3-checker.js` | Self-mock disclosure: framework mocks (incl. setup files, `vi.mock(import())`, `esmock`, `proxyquire`), member stubs, monkey-patching, `require.cache` tampering, hand-written literal doubles, tests named for a module they never reach. | no — advisory |
| `tools/merge-gate/d4-checker.js` | Real-dependency smoke: a changed module is covered only if a test loads the real file (directly, via barrel/helper chain, or `import()` whose result is used) and uses it through the binding without stubbing what it calls. | no — advisory |
| `tools/merge-gate/gate-lib.js` | Shared lexer (comments / strings / templates / regex literals), specifier resolution, import/export/mock extraction. | — |
| `tools/merge-gate/selftest.js` | Runs the two independent adversarial corpora and the author's shapes; exit 1 on any regression. | — |

## Exit codes

- `0` PASS — D1 and D2 passed (D3/D4 findings appear as warnings).
- `1` FAIL — D1 or D2 found a defect.
- `2` ERROR — a checker failed to load or crashed. **The gate never passes on a checker that did not run.**

## What was measured (2026-09-07)

- The originally deployed orchestrator was fail-open: PR #1 of this repo was merged on a `PASS` produced while all
  four checkers reported "Checker not found" (Actions run 34079482405). Fixed: missing/erroring checker → exit 2.
- D1 originally treated `README.md` and `podresolve.py` as unreachable modules, resolved paths relative to the
  process cwd, and ignored re-exports. Fixed.
- D3/D4 originally passed the exact #866 shape (a hand-written `{ query, all, get, run }` fake in a test that never
  imports the module) and D4 passed tests that never import the module at all. Rewritten.
- Regex checkers were fooled by comments, strings and regex literals. Fixed with a small lexer.
- Independent evidence: a fresh adversary agent's 26-case corpus (`selftest.js`, section "claude") and 64 fixtures
  authored blind by the pod's Qwen model (section "pod") — all consistent with a human-judged truth table.
  On real code: D2 over 56 Ballerina engine `.mjs` files → 0 findings (3 false positives before the fix);
  D1 over the same files with the real service roots → 6 unreachable, all imported only by tests (true findings).

## Known limits (honest)

- Regex/lexer based, no parser. Template literals with nested backticks and unusual regex placements can still
  confuse the lexer for one line.
- D1 cannot follow computed specifiers (`require(path.join(...))`, `` import(`./${name}`) ``), `require.resolve`,
  or modules started by string path (workers, plugins); list them as entrypoints.
- D2 does not judge member calls on named-import values, opaque defaults (`export default someIdentifier`,
  `module.exports = fn`) or `Object.assign(module.exports, …)`.
- D3/D4 cannot see doubles built by dependency-injection parameters, moduleNameMapper/alias config, or a
  binding shadowed inside a nested scope. A side-effect-only import counts as exercised only if the module runs
  code at top level. A helper-chain load counts as coverage and is labelled "via …" so a reviewer can weigh it.
- This repository's product code is Python; the only JS here is the gate, so on this repo D1–D4 gate the gate.
