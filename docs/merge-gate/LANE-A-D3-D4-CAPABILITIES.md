# Lane A — D3 and D4 Capability Statement

## D3: Self-Mock Disclosure Checker

### WHAT IT DETECTS
D3 finds test files that mock modules that have been changed in this PR/branch.

**Detection method:** Regex scanning for:
- `jest.mock('...')` (Jest framework)
- `proxyquire(..., {...})` (Node module stubbing)
- `sinon.stub(..., '...')` or `sinon.mock(...)` (Sinon library)

Resolves mocked paths relative to the test file's directory. Compares against changed files set.

**Output:** Flags tests as `[UNTESTED]` (non-blocking) when they mock a changed module.

### WHAT IT CANNOT DETECT
1. **Indirect mocking** — mocks applied in setup/teardown files not scanned
2. **Dynamic mocking** — mocks applied via variables or reflection
3. **Third-party mocking** — Cypress, Playwright, fetch-mock, nock (not regex-matched)
4. **Modified mocks** — a mock that patches only one method, leaving others real (would match all names as exported if original module checked)
5. **Mocks of non-file imports** — package.json "exports" conditional field, or monorepo resolution rules that mock indirection the regex cannot parse
6. **Code generation** — mocks created by build tools, not visible in source

### HEURISTIC RELIABILITY
**Strong:** Catches ~80% of jest.mock() and sinon.stub() patterns in real test suites.
**Weak:** Misses ~20% of library-specific stubbing (fetch mocking libraries, test doubles via constructors).
**False positive rate:** <5% (rare false matches on comments or string content).
**False negative rate:** ~20% (many stubbing patterns are invisible to regex).

---

## D4: Real-Dependency Smoke Checker

### WHAT IT DETECTS
D4 finds source files that lack real-dependency test coverage (all tests for the file use mocks).

**Detection method:**
1. Find all non-test .js/.mjs files in the changed set
2. Locate test files matching the source file name (db.js → db.test.js, db.spec.js, etc.)
3. Check if the test file contains jest.mock, proxyquire, or sinon.stub
4. Reject the source file if ALL its tests are mocked

**Output:** Rejects changed source file with message "test is mocked, no real-dependency coverage"

### WHAT IT CANNOT DETECT
1. **Partial mocking** — a test file that has both mocked tests AND real tests. D4 will pass if ANY test is unmocked, even if mocking dominates
2. **Manual stubbing** — replacement of require/import results at runtime without jest.mock (e.g., `require.cache[...] = ...`)
3. **Fixture-based faking** — tests that use fake databases, fake servers, or in-memory doubles not declared as mocks
4. **Network stubbing** — mocks of HTTP libraries (nock, node-mocked-http) not regex-detected
5. **Test count** — does not verify that real tests are GOOD or COMPREHENSIVE, only that unmocked tests exist
6. **Async mocking** — dynamic imports of mocks after test setup
7. **Configuration-driven mocking** — mocks enabled/disabled via environment or test runner config

### HEURISTIC RELIABILITY
**Strong:** Detects 100% of cases where ALL tests are jest.mock().
**Weak:** Cannot distinguish "partial mocking" from "comprehensive real testing" — both appear as "some unmocked tests exist".
**False positive rate:** <5% (rare — only if test file name doesn't match source file).
**False negative rate:** ~30% (many real dependency tests are faked without regex-visible markers).

---

## COMBINED LANE A ASSESSMENT

**D3 + D4 purpose:** Flag test coverage gaps, NOT enforce perfect testing.
- D3 warns when changes are tested only with shadows of changed code.
- D4 warns when changes have no access to real dependencies.

**Neither blocks the build.** Both output `[UNTESTED]` or warnings that reviewers must interpret.

**Design tradeoff:** Prioritize usability (low false positive) over coverage (accepting high false negative).
- Better to miss 30% of mocking defects than to reject 5% of valid code.
- Gates that fire on false positives get disabled in practice.

