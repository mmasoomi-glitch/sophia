# MERGE GATE ORCHESTRATOR — DESIGN SUMMARY

**Project:** sophia-pod  
**Phase:** Phase Two — Orchestrator & CI/CD Integration Architecture  
**Status:** DESIGN (ready for Phase One to close gotchas#880, #881, #886)  
**Date:** 2026-09-07

---

## WHAT IS THIS?

This folder contains the complete Phase Two design for the merge gate orchestrator — the software that sits between the four deterministic checkers (D1, D2, D3, D4) and your CI/CD system (GitHub Actions, GitLab CI, Jenkins, etc.).

The orchestrator:
- Detects changed files (from git diff, CLI args, env vars, or PR metadata)
- Runs all four checkers in parallel
- Aggregates results into a structured JSON report
- Outputs an exit code for CI/CD (0=pass, 1=fail, 2=error, 3=blocked)
- Posts a markdown comment to the PR/MR
- Integrates into your workflow at three stages: pre-review, review, and merge

---

## FIVE KEY DESIGN DECISIONS

### **1. Entry Point: Three Forms, One Contract**

The orchestrator can be called as:
- **Node.js module:** `await gate({ files, sha, base })`
- **CLI tool:** `merge-gate --files "a.ts,b.ts" --sha abc123 --base main`
- **Bash script:** `bash ./merge-gate.sh <files> <sha>`

All three call the same orchestrator; no difference in logic or output. This enables CI/CD systems with different capabilities (some have Node, some don't) to use the same tool.

### **2. Changed Files: Five Input Methods**

1. CLI args (`--files "a.ts,b.ts"`)
2. Environment variables (`MERGE_GATE_FILES="a.ts:b.ts"`)
3. PR metadata (GitHub Actions, GitLab CI)
4. Git diff (`git diff origin/main..HEAD --name-only`)
5. Fallback: auto-detect from current branch

The orchestrator attempts them in priority order and picks the first available. Files are normalized (deduplicated, relative paths resolved, non-code files filtered).

### **3. Output: JSON Report + Exit Code**

**JSON report** contains:
- Verdict (PASS/FAIL)
- Summary (human-readable)
- Array of checker results (status, message, details)
- Failures and warnings

**Exit codes:**
- `0` → PASS (all checks pass, can merge)
- `1` → FAIL (defect found, merge blocked)
- `2` → ERROR (orchestrator/checker crash, manual review needed)
- `3` → BLOCKED (D2 re-export chain issue, see gotcha#880)

**Markdown comment** posted to PR/MR for human review.

### **4. UNTESTED Warnings: Pass But Flag**

D3 and D4 have known limitations (gotcha#886):
- D3 detects only framework mocking calls, not hand-written mock objects
- D4 false-positives on custom mocks; hasn't been independently verified

**Handling:** They are marked UNTESTED and non-blocking. D1-D2 are hard blockers.

**Status:** Once gotcha#881 (acceptance test on real commit) passes, owner will decide whether to promote them to blockers or disable them.

### **5. Workflow: Three Cascading Stages**

1. **Pre-review (auto):** Merge gate runs on every push; generates report
2. **Review (human):** Reviewer sees gate output, can override D3/D4 warnings, cannot override D1-D2 failures
3. **Merge (final):** Gate re-runs on final merge commit to confirm results still hold

This gives maximum confidence: automated checks + human judgment + final verification.

---

## DESIGN DOCUMENTS

### **1. `DESIGN-PHASE-TWO-ORCHESTRATOR.md`** (primary)

Full architectural specification with:
- Detailed answers to all five questions
- Complete JavaScript pseudocode for the orchestrator
- Checker interface contract
- Configuration file format (config.yaml)
- CI/CD integration examples (GitHub Actions, GitLab CI, Jenkins, git hooks)
- Known limitations and gotcha mitigations
- Acceptance criteria
- Next steps

**Read this first.** It's the source of truth for what the orchestrator does.

### **2. `DESIGN-ANSWERS-QUICK-REFERENCE.md`** (cheat sheet)

One-page summary of the five core design questions and answers:
- Entry point (three forms)
- Changed file detection (five methods)
- Output format (JSON + exit codes)
- UNTESTED handling (pass-with-flag)
- Workflow stages (pre-review, review, merge)

Includes configuration reference and implementation checklist.

**Read this to quickly understand the big picture.**

### **3. `CHECKER-INTERFACE-SPEC.md`** (for checker authors)

Detailed specification for anyone implementing a checker (D1-D4):
- Input contract (JSON stdin)
- Output contract (JSON stdout)
- Exit codes (0, 1, 2, 42)
- Specific contracts for D1, D2, D3, D4
- Error handling
- Implementation template
- Testing strategies

**Read this if you're building the checkers.**

---

## KEY ARCHITECTURAL DECISIONS

### **Parallel execution**

All four checkers run at the same time. No sequential dependencies. This keeps gate latency low (<2s target) even with four separate processes.

### **Hard blockers vs advisory**

- **Hard blockers (D1, D2):** Must pass to merge. If either fails, PR is blocked.
- **Advisory (D3, D4):** Log concerns but don't block. Marked UNTESTED until independently verified.

This allows the gate to be useful even if D3/D4 have false positives.

### **Exit code 3 for re-export issues**

D2 can hit a re-export chain it can't resolve (gotcha#880). When this happens, D2 returns exit code 3. The orchestrator elevates this to a distinct exit code so CI/CD can treat it differently (e.g., "requires manual review" vs "blocked on defect").

### **No vendor lock-in**

The orchestrator is tool-agnostic. It can be called from:
- GitHub Actions (via `run:` step)
- GitLab CI (via `script:` section)
- Jenkins (via shell step + env vars)
- Local git hooks (pre-push)
- Any CI/CD system that can run Node.js

---

## KNOWN LIMITATIONS (Gotchas)

### **Gotcha #880: D2 Re-export Chains**
- **Issue:** D2 doesn't follow re-export chains. If `index.ts` re-exports from `api.ts`, D2 misses that.
- **Mitigation:** Build exports manifest that tracks intermediate re-exports.
- **Status:** Design ready, implementation in Phase One.

### **Gotcha #881: Acceptance Test**
- **Issue:** An agent tasked with replaying the real gotchas#866 commit ran against an invented fixture instead.
- **Status:** Must replay real commit before Phase Two ships. Blocker.

### **Gotcha #886: D3 & D4 Mock Detection**
- **Issue:** D3 and D4 detect only mocking framework calls, not hand-written mock objects.
- **Status:** Marked UNTESTED; non-blocking. Owner decides later whether to fix or disable.

---

## PHASE ONE → PHASE TWO HANDOFF

### **Phase One Status (current)**

The four checkers (D1-D4) are built and passing basic tests. However:
- D2 has a re-export chain false positive (gotcha#880)
- Acceptance test was run on an invented fixture, not the real gotchas#866 commit (gotcha#881)
- D3 and D4 haven't been independently verified (gotcha#886)

### **Phase Two Prerequisites**

Before implementing the orchestrator, Phase One must:
1. [ ] Close gotcha#880: D2 re-export chain detection
2. [ ] Re-run acceptance test against real gotchas#866 commit
3. [ ] Independently verify D3 and D4 with fixtures they didn't write

### **Phase Two Scope**

Implement the orchestrator per this design:
- [ ] Node.js module + CLI + Bash wrapper
- [ ] Five input methods (git-diff, CLI, env-vars, PR metadata, fallback)
- [ ] Parallel checker execution
- [ ] JSON report aggregation
- [ ] Markdown comment generation
- [ ] GitHub Actions integration
- [ ] GitLab CI integration
- [ ] Local git hook support
- [ ] Performance: <2s for 100 files

---

## USING THE DESIGN

### **For architects/PMs:**
Read **DESIGN-ANSWERS-QUICK-REFERENCE.md**. It answers the five core questions.

### **For orchestrator authors:**
Read **DESIGN-PHASE-TWO-ORCHESTRATOR.md** in full. It has pseudocode and the complete spec.

### **For checker authors:**
Read **CHECKER-INTERFACE-SPEC.md**. It defines the input/output contract each checker must implement.

### **For CI/CD integration:**
Jump to the "CI/CD Integration Examples" section of **DESIGN-PHASE-TWO-ORCHESTRATOR.md**. Copy-paste examples for your system (GitHub Actions, GitLab CI, Jenkins).

---

## FILE STRUCTURE

```
C:\Users\Magic\merge-gate-phase-one\
├── README-DESIGN-SUMMARY.md                    (this file)
├── DESIGN-PHASE-TWO-ORCHESTRATOR.md            (primary spec)
├── DESIGN-ANSWERS-QUICK-REFERENCE.md           (cheat sheet)
├── CHECKER-INTERFACE-SPEC.md                   (for checker authors)
│
├── checkers/
│   ├── d1-reachability.js                      (Phase One)
│   ├── d2-interface.js                         (Phase One)
│   ├── d3-self-mock.js                         (Phase One, UNTESTED)
│   └── d4-real-dependency.js                   (Phase One, UNTESTED)
│
├── merge-gate.js                               (Phase Two, to be implemented)
├── merge-gate.sh                               (Phase Two, to be implemented)
├── config.yaml                                 (Phase Two, to be implemented)
│
└── tests/
    ├── fixtures/
    │   ├── gotchas-866-real.ts                 (acceptance test input)
    │   ├── valid-api.ts                        (unit test fixture)
    │   └── ...
    └── orchestrator.test.js                    (to be implemented)
```

---

## NEXT STEPS

### **Immediate (Owner/Jury):**
1. Review this design and approve direction
2. Confirm gotchas#880, #881, #886 are acceptable blockers for Phase Two

### **Phase One completion:**
1. Fix D2 re-export chain detection (gotcha#880)
2. Re-run acceptance test against real gotchas#866 commit (gotcha#881)
3. Independently verify D3 and D4 (gotcha#886)

### **Phase Two implementation:**
1. Implement orchestrator per pseudocode in DESIGN-PHASE-TWO-ORCHESTRATOR.md
2. Implement checker adapters per CHECKER-INTERFACE-SPEC.md
3. Create config.yaml with example CI/CD configs
4. Test against real PR (verify JSON report + markdown comment)
5. Performance tune: target <2s for 100 files

### **Phase Three (future):**
1. Wire sophia_author's completion condition to merge gate verdict
2. Wire sophia_merge's refusal to SHA of reviewed diff
3. Add severity contract with fail-closed truncation
4. Compare model authoring (Qwen 35B vs 30B) on same dossier

---

## RELATED CONTEXT

**Ledger entries:**
- **decision#553:** Phase order is fixed (D1-D4 before model comparison)
- **gotcha#880:** D2 re-export false positive
- **gotcha#881:** Acceptance test ran on wrong fixture
- **gotcha#886:** D3/D4 miss hand-written mocks

**Project:**
- sophia-pod (RunPod L40S inference pod)
- Orchestrator will merge-gate PRs to the main inference branch

---

**Design status:** COMPLETE  
**Implementation status:** READY TO START (Phase One must close gotchas first)  
**Approval:** Pending
