# MERGE GATE DESIGN — QUICK REFERENCE

## Five Core Questions & Answers

---

### **Q1: What is the entry point?**

**Three forms, one contract:**

```bash
# Form 1: Node.js module (programmatic)
const { gate } = require('./merge-gate.js');
await gate({ files, sha, base });

# Form 2: CLI tool (shell scripts, CI)
./merge-gate --files "a.ts,b.ts" --sha abc123 --base main

# Form 3: Bash wrapper (legacy systems)
bash ./merge-gate.sh <files> <sha>
```

**All three call the same orchestrator; no difference in logic or output.**

**Priority (if multiple present):**
1. CLI args (`--files`, `--sha`, `--base`)
2. Environment variables (`MERGE_GATE_FILES`, `MERGE_GATE_SHA`, `MERGE_GATE_BASE`)
3. PR metadata (GitHub Actions `github.event.pull_request`)
4. Git auto-detect (`git diff --name-only <base>..HEAD`)

---

### **Q2: How are changed files detected?**

**Five methods, unified input:**

| Method | Source | Example |
|--------|--------|---------|
| `git-diff` | Repository history | `git diff origin/main..HEAD --name-only` |
| `cli-arg` | Command-line | `--files "a.ts,b.ts,c.ts"` |
| `env-var` | Environment | `MERGE_GATE_FILES="a.ts:b.ts:c.ts"` |
| `pr-metadata` | GitHub Actions | `github.event.pull_request.changed_files` |
| `pr-metadata` | GitLab CI | `CI_MERGE_REQUEST_DIFFS` API endpoint |

**Input normalization pipeline:**
1. Parse input from chosen method
2. Strip leading `a/` `b/` prefixes (git diff format)
3. Resolve relative paths to absolute (repo root)
4. Deduplicate (merge `./a.ts` and `a.ts`)
5. Filter non-code files (docs, markdown, JSON)
6. Validate file existence in HEAD
7. Pass to all four checkers

**Gotcha fix (gotcha#880):**  
D2 builds an exports manifest tracking all intermediate re-exports:
```json
{
  "src/api.ts": ["listUsers", "createUser"],
  "src/index.ts": ["// re-export from api", "export { listUsers }"],
  "src/helpers/auth.ts": ["verifyToken"]
}
```

This allows D2 to follow chains: `index.ts` → `api.ts` → actual declaration.

---

### **Q3: What does the output look like?**

**JSON report + exit code + optional markdown comment**

```json
{
  "version": "2.0.0",
  "timestamp": "2026-09-07T14:22:33Z",
  "sha": "abc123def456",
  "base_branch": "main",
  "files_changed": ["src/api.ts", "tests/api.test.ts"],
  "files_count": 2,
  
  "verdict": "FAIL",
  "summary": "1 DEFECT found; 1 UNTESTED warning raised",
  
  "checks": [
    {
      "checker": "D1",
      "name": "Reachability",
      "status": "PASS",
      "duration_ms": 145,
      "message": "All imports resolve",
      "severity": "OK"
    },
    {
      "checker": "D2",
      "name": "Interface Conformance",
      "status": "FAIL",
      "duration_ms": 312,
      "message": "Method missing: listUsers not found in src/api.ts",
      "details": {
        "expected": ["listUsers", "createUser"],
        "actual": ["createUser"],
        "missing": ["listUsers"]
      },
      "severity": "DEFECT"
    },
    {
      "checker": "D3",
      "name": "Self-Mock Disclosure",
      "status": "UNTESTED",
      "duration_ms": 89,
      "message": "D3 not yet detecting hand-written mocks (gotcha#886)",
      "severity": "WARNING"
    },
    {
      "checker": "D4",
      "name": "Real-Dependency Smoke",
      "status": "UNTESTED",
      "duration_ms": 156,
      "message": "D4 has false positives on custom mocks (gotcha#886)",
      "severity": "WARNING"
    }
  ],
  
  "verdict_final": {
    "pass": false,
    "exit_code": 1,
    "failures": [
      {
        "type": "interface-mismatch",
        "checker": "D2",
        "issue": "Missing export: listUsers",
        "action": "required"
      }
    ],
    "warnings": [
      {
        "type": "untested-checker",
        "checker": "D3"
      }
    ]
  }
}
```

**Exit codes:**
- `0` → PASS (green light, can merge)
- `1` → FAIL (defect detected, merge blocked)
- `2` → ERROR (orchestrator/checker crash, manual review needed)
- `3` → BLOCKED (D2 re-export chain error, see gotcha#880)

**Markdown comment (posted to PR/MR):**

```markdown
## Merge Gate Report ✓

**Verdict:** PASS

✓ D1 (Reachability): All imports resolve  
✓ D2 (Interface Conformance): All exports found  
? D3 (Self-Mock): Not yet detecting custom mocks  
? D4 (Real-Dependency): Advisory; not blocking  

**Files:** src/api.ts, tests/api.test.ts  
**Time:** 702ms total  
**Base:** main  
```

---

### **Q4: How are D3/D4 warnings (UNTESTED) handled?**

**Configuration-driven handling:**

```yaml
untested_handling:
  mode: 'pass-with-flag'  # one of: pass-with-flag, fail, ignore
  
  blockers:
    - D1  # Reachability — always enforced
    - D2  # Interface — always enforced (with gotcha#880 fix)
  
  non_blockers:
    - D3  # Self-mock — advisory only
    - D4  # Real-dependency — advisory only
```

**Logic:**

| Scenario | Result | Exit | Action |
|----------|--------|------|--------|
| D1=PASS, D2=PASS, D3/D4=any | **PASS** | 0 | PR eligible to merge |
| D1=FAIL OR D2=FAIL | **FAIL** | 1 | Block merge, show defect |
| D1=PASS, D2=PASS, D3/D4=UNTESTED | **PASS** | 0 | Log advisory, allow merge |
| D1=PASS, D2=UNTESTED (re-export error) | **BLOCKED** | 3 | Manual review required |

**Known limitations (gotcha#886):**
- D3 detects only `jest.mock()`, `vi.mock()`, `mockDeep()`
- D4 detects only mocking framework calls, not hand-written mock objects
- **Neither has been independently verified** against a fixture they didn't write

**Status:** Marked UNTESTED and non-blocking until Phase One closes gotcha#881 (replay real commit).

**Owner decision (not in scope):**  
Once independently verified, owner will decide:
1. Keep as advisory forever, or
2. Promote to hard blockers, or
3. Disable if false-positive rate too high

---

### **Q5: Where does the gate live in the PR workflow?**

**Three workflow stages:**

```
Stage 1: PRE-REVIEW (automatic on every push)
  │
  ├─ Runs D1-D4 on changed files (parallel)
  ├─ Generates JSON report + markdown comment
  ├─ Exit 0 → comment "Merge gate passed ✓"
  ├─ Exit 1 → comment "DEFECT: interface mismatch" (blocking)
  └─ Exit 3 → comment "Manual review: re-export issue"
  
    ↓
    
Stage 2: HUMAN REVIEW (required by branch protection)
  │
  ├─ Reviewer reads merge gate report in PR comments
  ├─ Views detailed D1-D4 output
  ├─ Can override D3/D4 UNTESTED warnings with approval
  ├─ **Cannot override D1-D2 failures**
  └─ Once approved → eligible for merge
  
    ↓
    
Stage 3: MERGE GATE FINAL CHECK (re-run before merge)
  │
  ├─ Re-runs D1-D4 against final merge commit
  ├─ Confirms results still hold (no late conflicts)
  ├─ Exit 0 → proceed with merge
  └─ Exit 1 → block merge, notify author
```

**Branch protection rules:**

| System | Rule | Details |
|--------|------|---------|
| GitHub | Status check required | `merge-gate/D1-D2` must pass |
| GitHub | Code review required | 1 approval needed |
| GitLab | Merge pipeline | `merge_gate` stage must succeed |
| GitLab | Pipeline success | Can override with approval |

**Integration points:**

```yaml
# GitHub Actions
- Required status check: merge-gate/D1-D2
- Optional check: merge-gate/D3-D4-advisory

# GitLab CI
- Stage: checks (runs on push and merge request)
- allow_failure: false (D1-D2 must pass)
- Artifacts: reports/merge-gate-*.json

# Jenkins
- Poll trigger on PR webhook
- Pass files via env var: MERGE_GATE_FILES="a.ts:b.ts"
- Fail build if exit != 0 (unless D3/D4 only)

# Local Git Hook
- pre-push: run merge gate before push
- Block push if exit != 0
```

---

## Configuration Reference

**File:** `.merge-gate.yml` or `./config/merge-gate.yaml`

```yaml
version: '2.0'

# Input detection
input:
  method: 'git-diff'  # auto-detect changed files
  git-diff:
    against: 'origin/main'
    max-files: 500

# Checker definitions
checkers:
  D1:
    enabled: true
    timeout_ms: 30000
  D2:
    enabled: true
    timeout_ms: 45000
    options:
      track_reexports: true  # Fix for gotcha#880
  D3:
    enabled: false  # UNTESTED (gotcha#886)
  D4:
    enabled: false  # UNTESTED (gotcha#886)

# Verdict handling
untested_handling:
  mode: 'pass-with-flag'
  blockers: [D1, D2]
  non_blockers: [D3, D4]

# Output
output_dir: './reports'
output_comment_markdown: true
```

---

## Known Limitations (Gotchas)

| Gotcha | Issue | Mitigation | Status |
|--------|-------|-----------|--------|
| #880 | D2 doesn't follow re-export chains | Exports manifest + chain resolver | Designed, Phase One |
| #881 | Acceptance test run on wrong fixture | Must replay real gotchas#866 commit | Blocker |
| #886 | D3/D4 miss hand-written mocks | Mark UNTESTED, non-blocking | By design |
| #879 | Model certifies its own checker | Separate authors for checker/fixture | Process rule |

---

## Phase Two Implementation Checklist

- [ ] Implement orchestrator (merge-gate.js) with five input methods
- [ ] Implement checker interface contract (D1-D4 adapters)
- [ ] Build exports manifest for D2 re-export handling
- [ ] Create config.yaml with all options
- [ ] GitHub Actions integration (status check + comment)
- [ ] GitLab CI integration (merge pipeline)
- [ ] Local git hook (pre-push)
- [ ] Performance: <2s for 100 files
- [ ] Test against real PR
- [ ] Acceptance test: replay gotchas#866 commit, all four checkers reject

---

**For full details, see:** `DESIGN-PHASE-TWO-ORCHESTRATOR.md`
