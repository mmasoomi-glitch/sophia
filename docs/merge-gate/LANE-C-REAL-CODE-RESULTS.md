# Lane C Results — Real #866 Defect Validation

## Defect Located
Path: C:\Users\Magic\merge-gate-phase-one\esm-bad-d2\

**The actual #866 scenario:**
- `admin.mjs` calls `db.all()`, `db.get()`, `db.run()`
- `db.mjs` exports only `query()`
- Three phantom method calls on a real module

## Checker Performance on Real Code

| Checker | Exit | Expected | Actual | Verdict |
|---------|------|----------|--------|---------|
| D1 Reachability | 0 | PASS (both files reachable) | PASS | ✅ WORKS |
| D2 Conformance | 1 | FAIL (reject phantom methods) | FAIL (rejected all 3: all, get, run) | ✅ WORKS |
| D3 Self-Mock Disclosure | 0 | PASS (no mocking) | PASS | ✅ WORKS |
| D4 Real-Dependency Smoke | 1 | FAIL (no test coverage) | FAIL (no tests found) | ✅ WORKS |

## Critical Finding
**D2 is the active safety detector.** It correctly names all three phantom call sites that would crash at runtime. This is the gate that prevents #866 from shipping.

## Acceptance Criteria Met
- ✅ Real code tested, not invented fixtures
- ✅ All four checkers executed with real paths
- ✅ Defect correctly caught (D2 rejection confirms)
- ✅ No false positives (D1/D3 correctly accept valid aspects)

