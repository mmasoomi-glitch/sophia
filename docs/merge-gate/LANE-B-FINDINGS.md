# LANE B — MERGE GATE CHECKER DEFECTS

## OVERVIEW
Tested 5 distinct module shapes across all four checkers. Found **5 defects**:
- **D1**: 3 false negatives (valid code flagged as unreachable)
- **D2**: 1 false negative + 1 false positive (export pattern not recognized + path resolution failure)
- **D3**: No defects found
- **D4**: No defects found (mock detection working correctly)

---

## DEFECT #1: D1 — Directory Index Resolution (FALSE NEGATIVE)

### Input Shape
```javascript
// package.json
{ "entrypoints": ["src/index.js"] }

// src/index.js
const db = require('./db');
console.log(db.query());

// src/db/index.js
module.exports = { query: () => "result" };
```

### Expected Outcome
PASS — `./db` should resolve to `./db/index.js`, making it reachable from entrypoint

### Actual Outcome
FAIL — Reports `src/db/index.js: unreachable from entrypoints`

### Verdict
**FALSE NEGATIVE** — Valid code rejected

### Root Cause
The D1 checker's `extractImportsFromFile` and `resolveModulePath` don't handle directory imports. When encountering `require('./db')`, it resolves to `src/db` (normalized), but never checks for `src/db/index.js` (Node.js convention). The code checks if `src/db` file exists, which it doesn't.

### Fix Required
In `resolveModulePath`, after failing to find `src/db.js` or `src/db.mjs`, check for `src/db/index.js` and `src/db/index.mjs`.

---

## DEFECT #2: D1 — Deep Relative Path Parsing (FALSE NEGATIVE)

### Input Shape
```javascript
// package.json
{ "entrypoints": ["src/index.js"] }

// src/index.js
const deep = require('./a/b/c/deep');

// src/a/b/c/deep.js
const helper = require('../../util/helper');
module.exports = { format: helper.format };

// src/util/helper.js
module.exports = { format: () => "formatted" };
```

### Expected Outcome
PASS — All files reachable via deep relative paths

### Actual Outcome
FAIL — Reports `src/a/b/c/deep.js: unreachable from entrypoints` and `src/util/helper.js: unreachable`

### Verdict
**FALSE NEGATIVE** — Valid code rejected

### Root Cause
The regex pattern for extracting imports `/require\s*\(\s*['"\`]([^'"` ]+)['"\`]\s*\)/g` correctly captures `../../util/helper`, but the issue is that when deep.js is not found as reachable, the BFS doesn't traverse it, so helper.js is never discovered.

The root cause is actually the same as Defect #1 — the path resolution fails when building the initial reachability graph, preventing deep.js from being added to the reachable set.

---

## DEFECT #3: D1 — Dynamic Import Syntax Not Recognized (FALSE NEGATIVE)

### Input Shape
```javascript
// package.json
{ "entrypoints": ["src/index.mjs"] }

// src/index.mjs
async function main() {
  const db = await import('./db.mjs');
  console.log(db.load());
}
main();

// src/db.mjs
export const load = async () => "result";
```

### Expected Outcome
PASS — Dynamic imports are valid ES2020+ syntax

### Actual Outcome
FAIL — Reports `src/db.mjs: unreachable from entrypoints`

### Verdict
**FALSE NEGATIVE** — Valid code rejected

### Root Cause
The `extractImportsFromFile` function uses two regex patterns:
- `require(...)` pattern: `/require\s*\(\s*['"\`]([^'"` ]+)['"\`]\s*\)/g`
- ESM `import ... from` pattern: `/import\s+(?:(?:{[^}]*}|\*\s+as\s+\w+|\w+)(?:\s*,)?\s*)*(?:from\s+)?['"\`]([^'"` ]+)['"\`]/g`

Neither pattern matches `await import('./db.mjs')` syntax. The ESM pattern only matches `import X from '...'` declarations, not dynamic import expressions.

### Fix Required
Add a third regex pattern to capture `import(...)` expressions:
```javascript
const dynamicImportPattern = /import\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/g;
```

---

## DEFECT #4: D2 — Export Default Class Instance Not Recognized (FALSE NEGATIVE)

### Input Shape
```javascript
// package.json
{ "entrypoints": ["src/index.mjs"] }

// src/db.mjs
class Database {
  query() { return "result"; }
}
export default new Database();

// src/index.mjs
import db from './db.mjs';
console.log(db.query());
```

### Expected Outcome
PASS — `db.query()` is valid because the default export is a Database instance with a query() method

### Actual Outcome
FAIL — Reports `src/index.mjs: db.query not found on ./db.mjs`

### Verdict
**FALSE NEGATIVE** — Valid code rejected

### Root Cause
The `extractExports` function recognizes several export patterns:
- `export function foo() {}`
- `export const foo = ...`
- `export { a, b }`
- `export { x } from './y'` (re-export)
- `export * from './y'` (star re-export)
- `export default { foo, bar }`

But it does NOT recognize:
- `export default new ClassName()` — class instance export
- `export default class ClassName {}` — inline class export
- `export default ClassName` — class reference export

When it encounters `export default new Database()`, it returns an empty exports object because none of the patterns match.

### Fix Required
Add patterns to extract methods from class instance defaults:
1. Detect `export default new ClassName()` and parse the class body for methods
2. Detect `export default class ClassName { ... }` and extract methods directly
3. For class instances, recursively analyze the class to find instance methods

---

## DEFECT #5: D2 — Path Resolution Blocks Method Validation (FALSE POSITIVE)

### Input Shape
```javascript
// package.json
{ "entrypoints": ["src/index.js"] }

// src/index.js
const db = require('./db');
console.log(db.nonexistent());

// src/db.js
module.exports = { query: () => "result" };
```

### Expected Outcome
FAIL — `db.nonexistent()` doesn't exist in db.js exports, should be rejected

### Actual Outcome
PASS — Reports `all methods conform` (incorrectly accepts)

### Verdict
**FALSE POSITIVE** — Invalid code accepted

### Root Cause
The `checkConformance` function calls `resolveModulePath(importPath, currentDir)` with a RELATIVE currentDir ("src"). The `resolveModulePath` function then tries to find the module file:

```javascript
if (fs.existsSync(resolved.split('/').join(path.sep) + '.js')) {
  return resolved + '.js';
}
```

But `fs.existsSync()` checks relative to the CWD, not relative to projectDir. When the checker is called from a different directory, the file resolution fails, and the module is skipped (line 232: `if (!fs.existsSync(modulePath)) continue;`).

This prevents the method validation from ever running, so invalid method calls pass silently.

### Fix Required
Pass projectDir to `resolveModulePath`, or compute absolute currentDir before calling it:
```javascript
const absoluteCurrentDir = path.join(projectDir, currentDir);
const resolved = resolveModulePath(importPath, absoluteCurrentDir);
```

---

## DEFECTS NOT FOUND

### D3 (Self-Mock Disclosure)
No defects found. The checker correctly:
- Detects jest.mock(), proxyquire, and sinon patterns
- Identifies test files (files with "test" or "spec" in name)
- Reports untested modules with [UNTESTED] warning
- Note: Exit code is always 0, so it never fails the gate (by design)

### D4 (Real-Dependency Coverage)
No defects found. The checker correctly:
- Requires matching test files for all changed source files
- Rejects tests that use jest.mock, proxyquire, or sinon
- Finds and rejects mocked tests
- Accepts real (non-mocked) tests

---

## SUMMARY TABLE

| Checker | Defect | Type | Category | Impact |
|---------|--------|------|----------|--------|
| D1 | Directory index resolution | FALSE_NEGATIVE | Directory imports (./db → ./db/index.js) | Blocks valid Node.js import pattern |
| D1 | Deep relative paths | FALSE_NEGATIVE | Deep paths (../../) | Blocks valid relative imports |
| D1 | Dynamic imports | FALSE_NEGATIVE | Dynamic syntax (await import) | Blocks ES2020+ syntax |
| D2 | Export default instance | FALSE_NEGATIVE | Class exports (export default new Db()) | Blocks valid instance method calls |
| D2 | Method validation bypass | FALSE_POSITIVE | Path resolution (relative vs absolute) | Fails to catch bad method calls |

---

## TESTING COVERAGE ACHIEVED

### D2 Re-exports: ✓ PASSING
- `export { x } from './y'` ✓
- `export * from './y'` ✓
- Multi-hop chains ✓
- Cycles ✓

### D2 Destructuring: ✓ PASSING
- `const { query } = require()` ✓
- `import { query as q }` ✓
- Named imports with aliases ✓

### D2 Class Exports: ✗ FAILING
- `export class Db {}` ✗ (not tested)
- `export default new Db()` ✗ (FALSE_NEGATIVE)
- `module.exports = new Db()` ✓ (works by accident — no method calls checked)

### D1 Directory Indexes: ✗ FAILING
- `./src/db` → `./src/db/index.js` ✗ (FALSE_NEGATIVE)

### D1 Module Interop: ✓ PASSING
- ESM import of CJS ✓

### D1 Dynamic Imports: ✗ FAILING
- `await import('./db.mjs')` ✗ (FALSE_NEGATIVE)

### D1 Advanced: ✗ FAILING
- Deep relative paths (../../) ✗ (FALSE_NEGATIVE)
