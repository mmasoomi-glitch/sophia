# CHECKER INTERFACE SPECIFICATION

## Overview

Each checker (D1, D2, D3, D4) implements a standardized contract:

- **Input:** JSON via stdin
- **Output:** JSON via stdout  
- **Exit code:** 0 (pass), 1 (fail), 2 (error), 42 (untested)
- **Timeout:** Configured per checker (30s default)
- **Parallelism:** All four run concurrently

This spec ensures the orchestrator can compose them without knowledge of their internals.

---

## Input Contract

### **Stdin: JSON object**

```json
{
  "files": ["src/api.ts", "src/index.ts", "tests/api.test.ts"],
  "working_dir": "/home/user/repo",
  "base_branch": "main",
  "config": {
    "track_reexports": true,
    "ignore_patterns": ["**/*.d.ts", "**/*.mock.ts"]
  }
}
```

### **Fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `files` | `string[]` | yes | Relative paths from repo root |
| `working_dir` | `string` | yes | Absolute path to repository root |
| `base_branch` | `string` | no | Branch to compare against (e.g., "main") |
| `config` | `object` | no | Checker-specific config from config.yaml |

### **File paths**

- Already normalized (no `a/` `b/` prefixes, deduplicated)
- Relative to `working_dir`
- All files exist in the working tree
- May include test files, config files, src files

Example normalization:
```
Input files:  ["src/api.ts", "./src/api.ts", "src/api.ts"]
Normalized:   ["src/api.ts"]

Input files:  ["a/src/index.ts", "b/src/index.ts"]
Normalized:   ["src/index.ts"]
```

---

## Output Contract

### **Stdout: JSON object**

```json
{
  "status": "PASS",
  "message": "All imports resolve; no broken module references",
  "severity": "OK",
  "duration_ms": 145,
  "details": {
    "files_checked": 2,
    "imports_found": 12,
    "broken_imports": 0
  }
}
```

### **Fields**

| Field | Type | Required | Enum | Description |
|-------|------|----------|------|-------------|
| `status` | `string` | yes | PASS \| FAIL \| UNTESTED \| ERROR | Verdict |
| `message` | `string` | yes | — | Human-readable summary |
| `severity` | `string` | no | OK \| WARNING \| DEFECT \| ERROR | For display in report |
| `duration_ms` | `number` | yes | — | Actual runtime (ms) |
| `details` | `object` | no | — | Checker-specific findings |

### **Exit codes**

| Code | Meaning | Output Status | When to use |
|------|---------|----------------|------------|
| 0 | Success | PASS | All checks passed |
| 1 | Check failed | FAIL | Defect found (interface mismatch, broken import, etc.) |
| 2 | Internal error | ERROR | Crash, timeout, invalid config, missing dependency |
| 42 | Not applicable | UNTESTED | This checker doesn't apply to this changeset |

### **Status transitions**

```
Exit code 0 (success)
├─ All checks passed
└─ status = "PASS"

Exit code 1 (failed check)
├─ Defect found by checker logic
└─ status = "FAIL"

Exit code 2 (internal error)
├─ Checker crashed, timeout, config error
├─ Orchestrator will retry on stderr
└─ status = "ERROR"

Exit code 42 (not applicable)
├─ Checker is advisory and didn't run
├─ Used by D3/D4 when detection criteria not met
└─ status = "UNTESTED"
```

---

## Specific Checker Contracts

### **D1: Reachability**

**Purpose:** Verify all module imports resolve to actual files.

**Input:**
```json
{
  "files": ["src/api.ts", "src/index.ts", "tests/api.test.ts"],
  "working_dir": "/home/user/repo",
  "config": {
    "extensions": [".ts", ".tsx", ".js", ".json"]
  }
}
```

**Logic:**
1. Parse each file for import statements
2. For each import, resolve it:
   - Absolute imports: check against tsconfig paths
   - Relative imports: resolve from file's directory
   - Node modules: check node_modules/
3. If all resolve, exit 0
4. If any missing, exit 1

**Output on PASS (exit 0):**
```json
{
  "status": "PASS",
  "message": "All imports resolve; no broken module references",
  "severity": "OK",
  "duration_ms": 145,
  "details": {
    "files_checked": 2,
    "total_imports": 12,
    "resolved": 12,
    "broken": 0
  }
}
```

**Output on FAIL (exit 1):**
```json
{
  "status": "FAIL",
  "message": "Import resolution failed in 1 file",
  "severity": "DEFECT",
  "duration_ms": 245,
  "details": {
    "files_checked": 2,
    "total_imports": 12,
    "resolved": 11,
    "broken": 1,
    "issues": [
      {
        "file": "src/api.ts",
        "line": 4,
        "import": "import { helper } from './helpers/missing'",
        "error": "Cannot resolve './helpers/missing' (file not found)"
      }
    ]
  }
}
```

---

### **D2: Interface Conformance**

**Purpose:** Verify exported methods are used correctly (match caller expectations).

**Input:**
```json
{
  "files": ["src/api.ts", "src/index.ts"],
  "working_dir": "/home/user/repo",
  "config": {
    "track_reexports": true,
    "manifest_cache": ".merge-gate-cache/exports-manifest.json"
  }
}
```

**Logic:**
1. Build exports manifest: which file exports what
   ```json
   {
     "src/api.ts": ["listUsers", "createUser"],
     "src/index.ts": ["// re-export from api", "export { listUsers }"],
     "src/helpers/auth.ts": ["verifyToken"]
   }
   ```

2. Parse each file for import statements that name specific imports
   ```typescript
   // src/main.ts
   import { listUsers } from './api';  // expects api to export listUsers
   import { verifyToken } from './helpers/auth';
   ```

3. For each named import, verify it's exported:
   - Check direct declaration in source file
   - **Follow re-export chains** (fix for gotcha#880):
     - If `src/index.ts` says `export { listUsers } from './api'`
     - Then `listUsers` is exported by index.ts too

4. If all match, exit 0
5. If any missing or mismatched, exit 1

**Output on PASS (exit 0):**
```json
{
  "status": "PASS",
  "message": "All expected exports found (including re-exports)",
  "severity": "OK",
  "duration_ms": 312,
  "details": {
    "files_checked": 2,
    "expected_exports": {
      "src/api.ts": ["listUsers", "createUser"],
      "src/index.ts": ["listUsers", "createUser"]
    },
    "all_found": true,
    "manifest": {
      "src/api.ts": ["listUsers", "createUser"],
      "src/index.ts": ["export { listUsers, createUser } from './api'"]
    }
  }
}
```

**Output on FAIL (exit 1):**
```json
{
  "status": "FAIL",
  "message": "Missing exports in 1 file",
  "severity": "DEFECT",
  "duration_ms": 312,
  "details": {
    "files_checked": 2,
    "expected_exports": {
      "src/api.ts": ["listUsers", "createUser"]
    },
    "issues": [
      {
        "file": "src/api.ts",
        "expected": ["listUsers", "createUser"],
        "actual": ["createUser"],
        "missing": ["listUsers"],
        "line_hint": "Line 4-45 (export const createUser ...)",
        "fix_hint": "Add export const listUsers = (...) { ... }"
      }
    ]
  }
}
```

**Output on re-export error (exit 3, triggers orchestrator code 3):**
```json
{
  "status": "FAIL",
  "message": "Cannot trace re-export chain",
  "severity": "ERROR",
  "duration_ms": 312,
  "details": {
    "issue": "re-export-chain-error",
    "file": "src/index.ts",
    "line": 1,
    "chain": "export { listUsers } from './api'",
    "error": "Circular re-export detected; cannot resolve",
    "action": "manual-review"
  }
}
```

**Gotcha#880 handling:**

D2 MUST build and cache the exports manifest to detect re-export chains:

```typescript
// Pseudocode: follow re-exports
function resolveExport(name: string, file: string, manifest): boolean {
  const declared = manifest[file];
  if (declared.includes(name)) return true;  // direct export
  
  // Follow re-exports
  const reexports = parseReexports(file);
  for (const { source } of reexports) {
    const resolved = resolveModulePath(source, file);
    if (resolveExport(name, resolved, manifest)) {
      return true;  // found via re-export
    }
  }
  return false;
}
```

---

### **D3: Self-Mock Disclosure**

**Purpose:** Verify test files declare when they mock implementation files (don't pass tests as proof of real behavior).

**Input:**
```json
{
  "files": ["src/api.ts", "tests/api.test.ts"],
  "working_dir": "/home/user/repo",
  "config": {
    "frameworks": ["jest", "vitest", "mocha"],
    "known_limitation": "Does not detect hand-written mock objects (gotcha#886)"
  }
}
```

**Logic:**
1. For each test file, scan for mock declarations:
   - `jest.mock('./api')`
   - `vi.mock('./api')`
   - `mockDeep(SomeType)`
   - etc.

2. If test mocks a module, it must NOT claim "real" behavior
   - Flag if test calls real-dependency checker AND mocks something

3. If no mocking detected:
   - Can assume tests use real implementations
   - Or the test uses a mock style D3 doesn't yet detect (hand-written objects)

4. Exit 0 if no mocking or mocking is properly disclosed
5. Exit 42 if cannot determine (UNTESTED)

**Output on PASS (exit 0):**
```json
{
  "status": "PASS",
  "message": "No undisclosed mocking; tests appear to use real dependencies",
  "severity": "OK",
  "duration_ms": 89,
  "details": {
    "files_checked": 1,
    "mocking_found": false,
    "frameworks_scanned": ["jest", "vitest"]
  }
}
```

**Output on FAIL (exit 1):**
```json
{
  "status": "FAIL",
  "message": "Test mocks a module but doesn't disclose it",
  "severity": "DEFECT",
  "duration_ms": 89,
  "details": {
    "files_checked": 1,
    "issues": [
      {
        "file": "tests/api.test.ts",
        "line": 3,
        "mock": "jest.mock('./api')",
        "problem": "Test mocks ./api but claims to test real behavior"
      }
    ]
  }
}
```

**Output on UNTESTED (exit 42):**
```json
{
  "status": "UNTESTED",
  "message": "D3 does not yet detect hand-written mock objects",
  "severity": "WARNING",
  "duration_ms": 89,
  "details": {
    "reason": "gotcha#886: hand-written mocks are not framework calls",
    "example": "const mockApi = { listUsers: () => [] }; api = mockApi;",
    "status": "Known limitation, marked advisory"
  }
}
```

---

### **D4: Real-Dependency Smoke**

**Purpose:** Verify test files actually test real dependencies, not just fixtures or mocks.

**Input:**
```json
{
  "files": ["src/api.ts", "tests/api.test.ts"],
  "working_dir": "/home/user/repo",
  "config": {
    "known_limitation": "False positives on custom mock objects (gotcha#886)"
  }
}
```

**Logic:**
1. For each test file, scan for mocking framework calls
   - `jest.mock()`, `vi.mock()`, `mockDeep()`, etc.

2. If test calls a mocking function:
   - It is mocking something, not testing real code
   - Flag as "does not test real dependencies"

3. If no mocking calls detected:
   - Assume test uses real dependencies
   - Or test uses a mock style D4 doesn't detect (hand-written objects)

4. Exit 0 if tests appear to use real dependencies
5. Exit 1 if tests mock everything
6. Exit 42 if uncertain (UNTESTED)

**Output on PASS (exit 0):**
```json
{
  "status": "PASS",
  "message": "Tests appear to use real dependencies",
  "severity": "OK",
  "duration_ms": 156,
  "details": {
    "files_checked": 1,
    "mocking_calls": 0,
    "frameworks": ["jest", "vitest"]
  }
}
```

**Output on FAIL (exit 1):**
```json
{
  "status": "FAIL",
  "message": "Test file heavily mocked; no real-dependency coverage",
  "severity": "DEFECT",
  "duration_ms": 156,
  "details": {
    "files_checked": 1,
    "issues": [
      {
        "file": "tests/api.test.ts",
        "line": 3,
        "mock": "jest.mock('./api')",
        "problem": "Mocks the module being tested"
      }
    ],
    "recommendation": "Use real implementation or at least some real I/O"
  }
}
```

**Output on UNTESTED (exit 42):**
```json
{
  "status": "UNTESTED",
  "message": "D4 cannot detect hand-written mock objects",
  "severity": "WARNING",
  "duration_ms": 156,
  "details": {
    "reason": "gotcha#886: hand-written mocks bypass framework detection",
    "example": "const mockApi = { listUsers: () => [] }",
    "status": "Known false positive, marked advisory"
  }
}
```

---

## Error Handling

### **Checker crashes (exit 2)**

If checker encounters an unhandled exception:

```json
{
  "status": "ERROR",
  "message": "Checker crashed: Cannot find module './config.json'",
  "severity": "ERROR",
  "duration_ms": 50
}
```

Orchestrator will:
1. Log the crash
2. Mark check as ERROR
3. Continue with other checks
4. Exit code 2 (requires manual review)

### **Checker timeout**

If checker exceeds configured timeout (default 30s):

```bash
$ timeout 30 node checkers/d1.js < input.json
# (timeout triggers after 30s)
# Signal: SIGTERM
```

Orchestrator will:
1. Kill checker subprocess
2. Return ERROR status
3. Message: "Checker timeout after 30000ms"
4. Exit code 2

### **Invalid input**

If orchestrator passes invalid JSON:

```json
{
  "status": "ERROR",
  "message": "Invalid input: missing 'files' field",
  "severity": "ERROR",
  "duration_ms": 10
}
```

Checker should:
1. Validate input on startup
2. Print error to stderr
3. Exit with code 2

---

## Implementation Template (Node.js)

```javascript
#!/usr/bin/env node

/**
 * Checker template (copy for D1-D4)
 * Reads JSON from stdin, validates, runs check, outputs JSON.
 */

const fs = require('fs');

async function main() {
  // Read input
  let input = '';
  process.stdin.setEncoding('utf8');
  
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  
  process.stdin.on('end', async () => {
    try {
      const data = JSON.parse(input);
      
      // Validate input
      if (!Array.isArray(data.files)) {
        throw new Error("Invalid input: 'files' must be an array");
      }
      if (!data.working_dir) {
        throw new Error("Invalid input: missing 'working_dir'");
      }
      
      // Run check (implement your logic here)
      const result = await runCheck(data);
      
      // Output result
      console.log(JSON.stringify(result));
      
      // Exit with appropriate code
      if (result.status === 'PASS') {
        process.exit(0);
      } else if (result.status === 'UNTESTED') {
        process.exit(42);
      } else if (result.status === 'FAIL') {
        process.exit(1);
      } else {
        process.exit(2);
      }
      
    } catch (error) {
      // Output error
      console.log(JSON.stringify({
        status: 'ERROR',
        message: error.message,
        severity: 'ERROR',
        duration_ms: 0
      }));
      process.exit(2);
    }
  });
}

async function runCheck(input) {
  const start = Date.now();
  
  try {
    // TODO: Implement your checker logic here
    // 1. Parse files
    // 2. Run checks
    // 3. Collect findings
    // 4. Return verdict
    
    return {
      status: 'PASS',
      message: 'All checks passed',
      severity: 'OK',
      duration_ms: Date.now() - start,
      details: {}
    };
    
  } catch (error) {
    return {
      status: 'ERROR',
      message: error.message,
      severity: 'ERROR',
      duration_ms: Date.now() - start
    };
  }
}

main();
```

---

## Testing Checkers

### **Unit test (test your checker independently)**

```javascript
const { spawnSync } = require('child_process');

function testChecker(inputData) {
  const result = spawnSync('node', ['checkers/d1.js'], {
    input: JSON.stringify(inputData),
    encoding: 'utf8'
  });
  
  const output = JSON.parse(result.stdout);
  return { output, exitCode: result.status };
}

// Test case: should pass
const result1 = testChecker({
  files: ['src/api.ts'],
  working_dir: '/repo',
  config: {}
});

console.assert(result1.output.status === 'PASS');
console.assert(result1.exitCode === 0);
```

### **Acceptance test (your checker against real commit)**

```bash
# Replay gotchas#866 commit through all four checkers
git checkout <commit-with-gotcha-866>

for checker in d1 d2 d3 d4; do
  node checkers/$checker.js < test-input.json > output.json
  if [ $? -eq 1 ]; then
    echo "✓ $checker correctly rejected gotchas#866"
  else
    echo "✗ $checker FAILED to detect gotchas#866"
  fi
done
```

---

**Document status:** SPECIFICATION, ready for implementation  
**Target:** Phase One (D1-D4 checker implementation)
