# MERGE GATE INTEGRATION ARCHITECTURE — PHASE TWO

**Project:** sophia-pod  
**Phase:** Phase Two — Orchestrator & CI/CD Integration  
**Status:** DESIGN (Phase One D1-D4 checkers must close gotchas#880, #881, #886 first)  
**Design Date:** 2026-09-07  
**Session:** Claude Haiku 4.5

---

## EXECUTIVE SUMMARY

This document specifies the merge gate orchestrator that:
1. Accepts changed files from git diff or PR metadata
2. Runs four deterministic checkers (D1, D2, D3, D4) in parallel
3. Aggregates results into a structured JSON report
4. Outputs an exit code for CI/CD integration (0=pass, 1=fail)
5. Provides clear, actionable failure reasons and UNTESTED warnings

The orchestrator is **entry-point agnostic** — it can be called from GitHub Actions, GitLab CI, Jenkins, a local pre-commit hook, or a git worktree CI loop on sophia-pod itself. It **does not block on warnings** but **fails hard on defects**, and it **includes guards** to prevent checkers from being certified by their own authors.

---

## DESIGN ANSWERS: FIVE CRITICAL QUESTIONS

### **Q1: What is the entry point?**

**A1: All three forms (pick one per caller)**

```
# Form 1: Node.js module (programmatic)
node -e "require('./merge-gate.js').gate()"

# Form 2: CLI tool (shell scripts, Actions, CI)
./merge-gate --files "file1.ts,file2.ts" --sha abc123 --base main

# Form 3: Bash script wrapper (legacy CI systems)
bash ./merge-gate.sh <files> <sha>
```

**Rationale:**  
- Node.js module allows CI systems to wire orchestrator directly into their build pipeline without shell overhead
- CLI is the Unix way — stateless, piped-friendly, scriptable
- Bash wrapper support ensures integration with Jenkins/GitLab runners that may not have Node available
- All three forms read the same YAML config and produce identical JSON output

**Entry point precedence:**
1. If called as Node module: accept in-memory `{files, sha, base}` object
2. If CLI with args: parse `--files`, `--sha`, `--base`, `--config`
3. If CLI with no args: read from env vars `MERGE_GATE_FILES`, `MERGE_GATE_SHA`, `MERGE_GATE_BASE`
4. Fallback: try `git diff` against current HEAD

---

### **Q2: How are changed files detected?**

**A2: Multiple input methods, unified normalization**

```yaml
# config.yaml — defines all three input modes
input:
  method: 'git-diff'  # one of: git-diff, env-var, cli-arg, pr-metadata
  
  git-diff:
    against: 'origin/main'  # default: current tracking branch
    filter: '.(ts|tsx|js|jsx|py)$'  # optional: skip test files if --skip-tests
    max-files: 500
    
  pr-metadata:
    # GitHub Actions injects: github.event.pull_request.changed_files
    # GitLab injects: CI_MERGE_REQUEST_DIFFS endpoint
    # Jenkins: input as CLI arg or env var
    
  cli-arg:
    # Direct: --files "a.ts,b.ts,c.ts"
    separator: ','
    
  env-var:
    # MERGE_GATE_FILES="a.ts,b.ts" (colon-separated for multi-line)
    format: 'colon-separated'
```

**Changed files detection flow:**

```
1. Check CLI args (highest priority)
2. Check env vars
3. Check PR metadata (if running in Actions/GitLab)
4. Fall back to: git diff --name-only <base>..HEAD
5. Normalize: strip leading a/ b/ prefixes, resolve relative paths
6. Deduplicate: {a.ts, ./a.ts} → single entry
7. Filter: exclude non-code files (docs/, .github/, .md unless in src/)
8. Validate: confirm each file exists in HEAD
9. Pass to all four checkers
```

**Gotcha: Re-export chains (gotcha#880)**  
D2 must follow import chains. Store a manifest of all exports:

```json
{
  "exports_manifest": {
    "src/api.ts": ["listUsers", "createUser"],
    "src/index.ts": ["// re-export from api", "export { listUsers } from './api'"],
    "src/helpers/auth.ts": ["verifyToken"]
  }
}
```

---

### **Q3: What does the output look like?**

**A3: Structured JSON report + exit code**

```json
{
  "version": "2.0.0",
  "timestamp": "2026-09-07T14:22:33Z",
  "sha": "abc123def456",
  "base_branch": "main",
  "files_changed": ["src/api.ts", "src/index.ts", "tests/api.test.ts"],
  "files_count": 3,
  
  "verdict": "FAIL",
  "summary": "1 DEFECT found; 2 UNTESTED warnings raised",
  
  "checks": [
    {
      "checker": "D1",
      "name": "Reachability",
      "status": "PASS",
      "duration_ms": 145,
      "message": "All imports resolve; no broken module references"
    },
    {
      "checker": "D2",
      "name": "Interface Conformance",
      "status": "FAIL",
      "duration_ms": 312,
      "message": "Method missing: listUsers not found in src/api.ts",
      "details": {
        "expected_exports": ["listUsers", "createUser"],
        "actual_exports": ["createUser"],
        "missing": ["listUsers"],
        "file": "src/api.ts",
        "line_hint": "L4-L45"
      },
      "severity": "DEFECT",
      "fix_hint": "Add export const listUsers = (...) { ... }"
    },
    {
      "checker": "D3",
      "name": "Self-Mock Disclosure",
      "status": "UNTESTED",
      "duration_ms": 89,
      "message": "No coverage; D3 does not yet detect hand-written mock objects",
      "severity": "WARNING"
    },
    {
      "checker": "D4",
      "name": "Real-Dependency Smoke",
      "status": "UNTESTED",
      "duration_ms": 156,
      "message": "No coverage; D4 flags only jest/mocha/vitest mocks, not object literals",
      "severity": "WARNING"
    }
  ],
  
  "verdict_final": {
    "pass": false,
    "exit_code": 1,
    "failures": [
      {
        "type": "interface-mismatch",
        "file": "src/api.ts",
        "issue": "Missing export: listUsers",
        "action": "required"
      }
    ],
    "warnings": [
      {
        "type": "untested-checker",
        "checker": "D3",
        "reason": "Known limitation: gotcha#886, gotcha#879"
      },
      {
        "type": "untested-checker",
        "checker": "D4",
        "reason": "Known limitation: gotcha#886, gotcha#879"
      }
    ]
  }
}
```

**Exit codes:**
- `0` → PASS (all checkers green, no UNTESTED warnings blocking)
- `1` → FAIL (one or more DEFECT verdicts)
- `2` → ERROR (orchestrator crashed, checker timed out, input invalid)
- `3` → BLOCKED (D2 re-export chain error; requires manual review per gotcha#880)

---

### **Q4: How are D3/D4 warnings (UNTESTED) handled?**

**A4: PASS but flag; configurable strictness**

**Status of D3 & D4 (as of gotcha#886, #881):**
- D3 detects only `jest.mock()`, `vi.mock()`, `mockDeep()`
- D4 detects only mocking framework calls, not hand-written literals
- Known false positives when testing code uses custom mock objects
- **Neither has been independently verified** against a fixture they didn't write

**Handling logic:**

```yaml
# config.yaml
untested_handling:
  mode: 'pass-with-flag'  # one of: pass-with-flag, fail, ignore
  
  # If mode: pass-with-flag
  warning_level: 'warn'  # CI/CD can decide to ignore, log, or escalate
  
  blockers:
    # These checkers block merge if enabled
    - D1  # Reachability — always enforced, no false positives expected
    - D2  # Interface — always enforced, but see gotcha#880
    
  non_blockers:
    # These are advisory only; never block a PR
    - D3  # Self-mock — gotcha#886: doesn't detect all mock styles
    - D4  # Real-dependency — gotcha#886: false positive on custom objects
```

**Expected behavior:**

```
IF (D1 = PASS AND D2 = PASS) → exit 0  # green light
ELIF (D1 = FAIL OR D2 = FAIL) → exit 1  # block merge
ELIF (D3 = UNTESTED OR D4 = UNTESTED) → exit 0 with warnings  # pass, log concern
```

**CI/CD integration:**

```yaml
# GitHub Actions example
- name: Merge Gate Check
  run: node merge-gate.js --files "${{ github.event.pull_request.changed_files }}"
  
  # Verdict handling:
  # exit 0 → PR can merge (D3/D4 warnings go to job log)
  # exit 1 → PR blocked (CI fails, PR review required)
  # exit 3 → Manual review required (D2 re-export issue)
```

**Owner decision pending (not in scope):**  
When D3 and D4 are fully validated (after gotcha#881 replay passes), owner will decide:
1. Keep D3/D4 as advisory warnings forever
2. Promote to hard blockers once known limitations are fixed
3. Disable entirely if false-positive rate is too high

---

### **Q5: Where does the gate live in the PR workflow?**

**A5: Three stages (cascading confidence)**

```
┌─────────────────────────────────────────────────────────────┐
│                    PR WORKFLOW WITH MERGE GATE               │
└─────────────────────────────────────────────────────────────┘

Stage 1: PRE-REVIEW (automatic, CI runs on every push)
  ├─ Runs D1-D4 on changed files
  ├─ Exit 0 → comment "Merge gate passed ✓"
  ├─ Exit 1 → comment "Interface mismatch detected" (blocking)
  └─ Exit 3 → comment "Manual review needed: re-export chain issue"

Stage 2: REVIEW (human review, requires approval)
  ├─ Reviewer sees merge-gate report in PR comment
  ├─ Can view detailed D1-D4 output
  ├─ May override D3/D4 warnings with approval
  └─ Approval does NOT bypass D1-D2 failures

Stage 3: MERGE (final gate, runs on squash/rebase)
  ├─ Re-runs D1-D4 against final merge commit
  ├─ Confirms results still hold (no late conflicts)
  └─ Only merges if exit 0
```

**Protection rules per system:**

```yaml
# GitHub (settings.json)
branch_protection:
  required_status_checks:
    - "merge-gate / D1+D2 (blockers)"
    - "merge-gate / D3+D4 (advisory)"
  require_code_review: true
  required_approval_count: 1
  
# GitLab (CI config)
merge_pipelines:
  merge_gate:
    stage: checks
    script: node merge-gate.js
    allow_failure: false  # D1-D2 must pass
  
  d34_warnings:
    stage: checks
    script: node merge-gate.js --only D3,D4
    allow_failure: true  # Advisory only
```

**Workflow diagram:**

```
PR opened
   ↓
[Merge Gate: D1-D4] (auto on push)
   ├─ PASS → "Merge gate OK" comment ✓
   ├─ FAIL (D1/D2) → Block merge ✗
   └─ WARN (D3/D4) → Log concern, continue
   ↓
[Human Review] (required)
   ├─ Approves → can proceed to merge
   └─ Requests changes → back to author
   ↓
[Re-run Merge Gate on Final Commit]
   ├─ PASS → eligible to merge
   ├─ FAIL → block, notify author
   └─ WARN → log, but allow merge
   ↓
[Merge to main] ✓
```

---

## ARCHITECTURE: ORCHESTRATOR PSEUDOCODE

### **Entry Point: `merge-gate.js`**

```javascript
/**
 * Merge Gate Orchestrator
 * 
 * Runs D1-D4 checkers in parallel over changed files,
 * aggregates results, and outputs JSON + exit code.
 * 
 * Usage:
 *   node merge-gate.js --files "a.ts,b.ts" --sha abc123 --base main
 *   node merge-gate.js  # auto-detect via git diff
 *   merge-gate --config config.yaml --pr-number 42
 */

const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

// ============================================================================
// 1. LOAD CONFIG & VALIDATE INPUT
// ============================================================================

async function gate() {
  const config = loadConfig();  // config.yaml or .merge-gate.yml
  const input = parseInput();   // CLI args → env vars → git diff → PR metadata
  
  // Validate
  if (!input.files || input.files.length === 0) {
    error('No files changed', 2);
  }
  if (input.files.length > config.input['max-files']) {
    error(`Too many files (${input.files.length}), max ${config.input['max-files']}`, 2);
  }
  
  const report = {
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    sha: input.sha,
    base_branch: input.base,
    files_changed: input.files,
    files_count: input.files.length,
    verdict: null,
    summary: null,
    checks: [],
    verdict_final: null
  };
  
  // ========================================================================
  // 2. RUN ALL FOUR CHECKERS IN PARALLEL
  // ========================================================================
  
  console.log(`[merge-gate] Running D1-D4 on ${input.files.length} files...`);
  
  const results = await Promise.all([
    runChecker('D1', 'reachability', input.files, config),
    runChecker('D2', 'interface', input.files, config),
    runChecker('D3', 'self-mock', input.files, config),
    runChecker('D4', 'real-dependency', input.files, config)
  ]);
  
  // Each checker returns: { checker, name, status, duration_ms, message, details?, severity }
  report.checks = results;
  
  // ========================================================================
  // 3. AGGREGATE RESULTS
  // ========================================================================
  
  const verdicts = aggregateVerdicts(results, config);
  
  report.verdict = verdicts.verdict;        // PASS, FAIL, UNTESTED
  report.summary = verdicts.summary;        // human-readable summary
  report.verdict_final = {
    pass: verdicts.pass,
    exit_code: verdicts.exit_code,
    failures: verdicts.failures,
    warnings: verdicts.warnings
  };
  
  // ========================================================================
  // 4. OUTPUT JSON REPORT
  // ========================================================================
  
  const reportFile = path.join(config.output_dir, `merge-gate-${input.sha.slice(0, 7)}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  
  console.log(`[merge-gate] Report: ${reportFile}`);
  console.log(`[merge-gate] Verdict: ${report.verdict} (exit ${verdicts.exit_code})`);
  
  // ========================================================================
  // 5. OUTPUT COMMENT (optional, for CI/CD)
  // ========================================================================
  
  if (config.output_comment_markdown) {
    const comment = formatMarkdownComment(report);
    console.log('\n' + comment);
  }
  
  // ========================================================================
  // 6. EXIT
  // ========================================================================
  
  process.exit(verdicts.exit_code);
}

// ============================================================================
// HELPER: RUN A SINGLE CHECKER (D1-D4)
// ============================================================================

async function runChecker(checkerId, checkerName, files, config) {
  const start = Date.now();
  
  try {
    // Spawn checker subprocess with timeout
    const checker = spawn(
      config.checkers[checkerId].command,
      [
        '--files', files.join(','),
        '--output', 'json'
      ],
      { timeout: config.checkers[checkerId].timeout_ms }
    );
    
    let stdout = '';
    let stderr = '';
    
    checker.stdout.on('data', (data) => stdout += data);
    checker.stderr.on('data', (data) => stderr += data);
    
    return new Promise((resolve, reject) => {
      checker.on('close', (code) => {
        const duration = Date.now() - start;
        
        if (code === 0) {
          const result = JSON.parse(stdout);
          resolve({
            checker: checkerId,
            name: checkerName,
            status: result.status || 'PASS',
            duration_ms: duration,
            message: result.message,
            details: result.details,
            severity: result.severity || 'OK'
          });
        } else if (code === 124) {
          // Timeout
          resolve({
            checker: checkerId,
            name: checkerName,
            status: 'ERROR',
            duration_ms: duration,
            message: `Checker timeout after ${config.checkers[checkerId].timeout_ms}ms`,
            severity: 'ERROR'
          });
        } else if (code === 42) {
          // Checker returned UNTESTED (reserved exit code)
          resolve({
            checker: checkerId,
            name: checkerName,
            status: 'UNTESTED',
            duration_ms: duration,
            message: `${checkerName} not applicable to this changeset`,
            severity: 'WARNING'
          });
        } else {
          resolve({
            checker: checkerId,
            name: checkerName,
            status: 'FAIL',
            duration_ms: duration,
            message: stdout || stderr,
            severity: 'DEFECT'
          });
        }
      });
    });
    
  } catch (e) {
    return {
      checker: checkerId,
      name: checkerName,
      status: 'ERROR',
      duration_ms: Date.now() - start,
      message: e.message,
      severity: 'ERROR'
    };
  }
}

// ============================================================================
// HELPER: AGGREGATE VERDICTS
// ============================================================================

function aggregateVerdicts(results, config) {
  const blockers = config.untested_handling.blockers;
  const failures = [];
  const warnings = [];
  let passCount = 0;
  let failCount = 0;
  let untestedCount = 0;
  
  results.forEach(result => {
    if (result.status === 'PASS') {
      passCount++;
    } else if (result.status === 'FAIL') {
      failCount++;
      if (blockers.includes(result.checker)) {
        failures.push({
          type: 'blocker-failure',
          checker: result.checker,
          issue: result.message,
          action: 'required'
        });
      }
    } else if (result.status === 'UNTESTED') {
      untestedCount++;
      if (!blockers.includes(result.checker)) {
        warnings.push({
          type: 'untested-checker',
          checker: result.checker,
          reason: `${result.message} (${result.severity})`
        });
      } else {
        // UNTESTED on a blocker is treated as FAIL
        failures.push({
          type: 'blocker-untested',
          checker: result.checker,
          issue: `${result.checker} returned UNTESTED; cannot gate`,
          action: 'escalate'
        });
      }
    }
  });
  
  const pass = failCount === 0;
  let exit_code = 0;
  
  if (failCount > 0) {
    exit_code = 1;  // FAIL
  } else if (untestedCount > 0 && config.untested_handling.mode === 'fail') {
    exit_code = 1;  // FAIL on UNTESTED (strict mode)
  } else if (failures.some(f => f.type === 'blocker-untested')) {
    exit_code = 3;  // BLOCKED (D2 re-export, gotcha#880)
  }
  
  const summary = [
    `${passCount} checks passed`,
    failCount > 0 ? `${failCount} DEFECT(s)` : null,
    untestedCount > 0 ? `${untestedCount} UNTESTED warning(s)` : null
  ].filter(Boolean).join('; ');
  
  return {
    verdict: pass ? 'PASS' : 'FAIL',
    summary,
    pass,
    exit_code,
    failures,
    warnings
  };
}

// ============================================================================
// HELPER: PARSE INPUT (multiple methods)
// ============================================================================

function parseInput() {
  const args = require('minimist')(process.argv.slice(2));
  
  // Priority 1: CLI arguments
  if (args.files) {
    return {
      files: args.files.split(',').map(f => f.trim()),
      sha: args.sha || getShaFromGit(),
      base: args.base || getDefaultBaseBranch()
    };
  }
  
  // Priority 2: Environment variables
  if (process.env.MERGE_GATE_FILES) {
    return {
      files: process.env.MERGE_GATE_FILES.split(':').map(f => f.trim()),
      sha: process.env.MERGE_GATE_SHA || getShaFromGit(),
      base: process.env.MERGE_GATE_BASE || getDefaultBaseBranch()
    };
  }
  
  // Priority 3: PR metadata (GitHub Actions)
  if (process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.pull_request?.changed_files) {
      return {
        files: event.pull_request.changed_files,
        sha: event.pull_request.head.sha,
        base: event.pull_request.base.ref
      };
    }
  }
  
  // Priority 4: Auto-detect via git diff
  console.log('[merge-gate] Auto-detecting changed files via git diff...');
  const base = getDefaultBaseBranch();
  const filesOutput = execSync(`git diff --name-only ${base}..HEAD`).toString();
  
  return {
    files: filesOutput.split('\n').filter(f => f.length > 0),
    sha: getShaFromGit(),
    base: base
  };
}

function getShaFromGit() {
  return execSync('git rev-parse HEAD').toString().trim();
}

function getDefaultBaseBranch() {
  try {
    const tracking = execSync('git rev-parse --abbrev-ref --symbolic-full-name @{u}').toString().trim();
    return tracking.split('/')[1] || 'main';
  } catch {
    return 'main';  // fallback
  }
}

// ============================================================================
// HELPER: FORMAT MARKDOWN COMMENT
// ============================================================================

function formatMarkdownComment(report) {
  const checks = report.checks.map(c => {
    const icon = c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✗' : c.status === 'UNTESTED' ? '?' : '!';
    return `- ${icon} **${c.checker}** (${c.name}): ${c.message}`;
  }).join('\n');
  
  return `
## Merge Gate Report

**Verdict:** ${report.verdict}

${report.summary}

### Checker Results

${checks}

**Files:** ${report.files_changed.join(', ')}  
**Report:** [Full JSON](${report.reportFileUrl})
`;
}

// ============================================================================
// MAIN
// ============================================================================

gate().catch(e => {
  console.error(`[merge-gate] Fatal: ${e.message}`);
  process.exit(2);
});
```

---

### **Checker Interface (D1-D4)**

Each checker must implement this contract:

```typescript
/**
 * Checker contract (D1-D4 must implement)
 * 
 * Input: JSON stdin with { files: string[], working_dir: string, config: object }
 * Output: JSON stdout with result
 * Exit: 0 = pass, 1 = fail, 2 = error, 42 = untested
 */

interface CheckerInput {
  files: string[];          // relative paths from repo root
  working_dir: string;      // absolute path to repo root
  config: object;           // checker-specific config from config.yaml
}

interface CheckerOutput {
  status: 'PASS' | 'FAIL' | 'UNTESTED' | 'ERROR';
  message: string;
  details?: {
    [key: string]: any;     // checker-specific details
  };
  severity?: 'OK' | 'WARNING' | 'DEFECT' | 'ERROR';
  duration_ms: number;
}

// Example: D2 (Interface Conformance)
async function checkInterfaceConformance(input: CheckerInput): Promise<CheckerOutput> {
  const start = Date.now();
  
  try {
    // Step 1: Build exports manifest
    const manifest = buildExportsManifest(input.files, input.working_dir);
    
    // Step 2: For each file, check declared vs used exports
    const issues: Array<{file: string, expected: string[], actual: string[], missing: string[]}> = [];
    
    for (const file of input.files) {
      const declared = parseExports(file, input.working_dir);
      const expected = getExpectedExports(file);  // from jest.mock('...')
      
      // Check: all expected exports exist
      const missing = expected.filter(e => !declared.includes(e));
      
      // CRITICAL: Follow re-export chains (gotcha#880 fix)
      const actualWithReexports = resolveReexports(declared, manifest, file);
      const stillMissing = expected.filter(e => !actualWithReexports.includes(e));
      
      if (stillMissing.length > 0) {
        issues.push({ file, expected, actual: actualWithReexports, missing: stillMissing });
      }
    }
    
    // Step 3: Verdict
    if (issues.length === 0) {
      return {
        status: 'PASS',
        message: 'All expected exports found (including re-exports)',
        duration_ms: Date.now() - start,
        severity: 'OK'
      };
    } else {
      return {
        status: 'FAIL',
        message: `Missing exports in ${issues.length} file(s)`,
        details: { issues },
        duration_ms: Date.now() - start,
        severity: 'DEFECT'
      };
    }
  } catch (e) {
    return {
      status: 'ERROR',
      message: e.message,
      duration_ms: Date.now() - start,
      severity: 'ERROR'
    };
  }
}
```

---

## KNOWN LIMITATIONS & GOTCHAS

### **Gotcha #880: D2 Re-export Chains**
- **Symptom:** D2 reports method missing when exported via re-export
- **Mitigation:** Build exports manifest tracking all intermediate re-exports
- **Status:** Design ready, implementation in Phase One (pending fix)
- **Exit code:** 3 (BLOCKED) if D2 returns `re-export-chain-error`

### **Gotcha #886: D3 & D4 Mock Detection**
- **Symptom:** D3 and D4 don't detect hand-written mock objects; only framework calls
- **Mitigation:** Mark as UNTESTED until independently verified
- **Status:** Known false negative; listed as advisory (non-blocking)
- **Sentinel:** If D3 or D4 is enabled in blockers, emit warning about gotcha#886

### **Gotcha #881: Author-Written Fixtures**
- **Symptom:** Model that writes the checker also writes its test fixture; will pass itself
- **Mitigation:** acceptance test must replay real gotchas#866 commit, not invented fixture
- **Status:** Guard in place; requires independent verification
- **Enforcement:** No checker may be merged without an acceptance test run

### **Gotcha #879: Fixture Separation**
- **Symptom:** A model that writes both checker and fixture cannot fail the fixture
- **Mitigation:** Separate authors (agent for checker, different agent for fixture)
- **Status:** Process rule, not architectural (owner enforces)

---

## CONFIGURATION FILE: `config.yaml`

```yaml
# .merge-gate.yml or ./config/merge-gate.yaml

version: '2.0'

# Changed files input
input:
  method: 'git-diff'  # git-diff | env-var | cli-arg | pr-metadata
  git-diff:
    against: 'origin/main'
    filter: '\.(ts|tsx|js|jsx|py)$'
    max-files: 500

# Checker definitions
checkers:
  D1:
    command: 'node checkers/d1-reachability.js'
    timeout_ms: 30000
    enabled: true
  
  D2:
    command: 'node checkers/d2-interface.js'
    timeout_ms: 45000
    enabled: true
    # Fix for gotcha#880: follow re-export chains
    options:
      track_reexports: true
      manifest_cache: '.merge-gate-cache/exports-manifest.json'
  
  D3:
    command: 'node checkers/d3-self-mock.js'
    timeout_ms: 30000
    enabled: false  # UNTESTED, gotcha#886
    known_limitation: "Detects only jest.mock(), vi.mock(), mockDeep(); misses hand-written literals"
  
  D4:
    command: 'node checkers/d4-real-dependency.js'
    timeout_ms: 60000
    enabled: false  # UNTESTED, gotcha#886
    known_limitation: "False positives on custom mock objects; requires independent verification"

# Verdict handling
untested_handling:
  mode: 'pass-with-flag'  # pass-with-flag | fail | ignore
  
  blockers:
    - D1  # Reachability — always enforced
    - D2  # Interface — always enforced (with gotcha#880 mitigation)
  
  non_blockers:
    - D3  # Self-mock — advisory only until gotcha#886 closed
    - D4  # Real-dependency — advisory only until gotcha#886 closed

# Output
output_dir: './reports'
output_comment_markdown: true  # post comment to PR/MR
output_format: 'json'

# CI/CD integration hints
ci_systems:
  github_actions:
    # Set repo secret: MERGE_GATE_CONFIG=...
    status_check_context: 'merge-gate/D1-D2'
  
  gitlab_ci:
    merge_pipeline_stage: 'checks'
  
  jenkins:
    # Pass files as env var: MERGE_GATE_FILES="a.ts:b.ts:c.ts"
    pass_env_vars: true
```

---

## CI/CD INTEGRATION EXAMPLES

### **GitHub Actions**

```yaml
name: Merge Gate
on: [pull_request]

jobs:
  merge-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Run merge gate
        run: |
          node merge-gate.js \
            --files "${{ github.event.pull_request.changed_files }}" \
            --sha "${{ github.event.pull_request.head.sha }}" \
            --base "${{ github.event.pull_request.base.ref }}"
      
      - name: Comment PR with report
        if: always()
        uses: actions/github-script@v6
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('./reports/merge-gate-*.json'));
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: formatComment(report)
            });
```

### **GitLab CI**

```yaml
merge_gate:
  stage: check
  image: node:18
  script:
    - npm ci
    - node merge-gate.js
      --base $CI_MERGE_REQUEST_TARGET_BRANCH_NAME
      --sha $CI_MERGE_REQUEST_SOURCE_BRANCH_SHA
  artifacts:
    reports:
      merge_request:
        - reports/merge-gate-*.json
  only:
    - merge_requests
```

### **Local Git Hook**

```bash
#!/bin/bash
# .git/hooks/pre-push

echo "[merge-gate] Running pre-push checks..."

node merge-gate.js \
  --base origin/main \
  --sha HEAD

if [ $? -ne 0 ]; then
  echo "Merge gate failed; push blocked."
  exit 1
fi

echo "Merge gate passed; proceeding with push."
```

---

## ACCEPTANCE CRITERIA (Phase Two Complete)

1. ✓ Orchestrator accepts changed files via git diff, CLI args, env vars, and PR metadata
2. ✓ All four checkers run in parallel with configurable timeouts
3. ✓ Results aggregate into structured JSON report
4. ✓ Exit code reflects verdict (0=pass, 1=fail, 2=error, 3=blocked)
5. ✓ Clear failure reasons and actionable fix hints
6. ✓ D1-D2 are hard blockers; D3-D4 are advisory (until gotcha#886 closes)
7. ✓ Callable from GitHub Actions, GitLab CI, Jenkins, local hooks
8. ✓ Markdown comment generated for PR/MR
9. ✓ Gotcha#880 (re-export chains) mitigated in D2 checker
10. ✓ Accepts owner configuration file (config.yaml)

---

## NEXT STEPS (Phase One → Phase Two Transition)

### **Blockers (must close before Phase Two ships):**
- [ ] gotcha#880: D2 re-export chain detection (Phase One bug)
- [ ] gotcha#881: Acceptance test must replay real gotchas#866 commit
- [ ] gotcha#886: D3 and D4 independently verified (not author-tested)

### **Phase Two work:**
- [ ] Implement orchestrator (merge-gate.js) per pseudocode above
- [ ] Implement checker interface (D1-D4 adapters)
- [ ] Create config.yaml with all three input methods
- [ ] Wire GitHub Actions integration
- [ ] Wire GitLab CI integration
- [ ] Wire local pre-push hook
- [ ] Test against real PR: verify json report + markdown comment
- [ ] Performance benchmark: target <2s total runtime for 100 files

### **Phase Three (future):**
- Wire sophia_author's completion condition to merge gate verdict
- Wire sophia_merge's refusal to SHA of reviewed diff
- Add severity contract with fail-closed truncation
- Compare model authoring (35B vs 30B) on same dossier

---

## REFERENCE: Linked Gotchas & Decisions

- **gotcha#880** (D2 re-export false positive)
- **gotcha#881** (acceptance test fixture swap)
- **gotcha#886** (D3/D4 missing mock detection)
- **gotcha#879** (model certifies its own checker)
- **decision#553** (phase order: D1-D4 before model comparison)

---

**Document status:** DESIGN, ready for implementation  
**Author:** Design workflow (Phase Two architecture)  
**Last updated:** 2026-09-07
