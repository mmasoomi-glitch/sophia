#!/usr/bin/env node

/**
 * Merge Gate Orchestrator v2.0
 *
 * Orchestrates D1-D4 checkers to validate code changes before merge.
 *
 * Usage:
 *   node merge-gate.js --changed-files FILES --project-dir DIR --output-json OUT
 *   merge-gate --files "a.ts,b.ts" --project-dir /path/to/project
 */

const fs = require('fs');
const path = require('path');

const GATE_EXT = /\.(m?js|cjs)$/i;

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

function parseArgs() {
  const args = {};
  process.argv.slice(2).forEach((arg, idx, array) => {
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = array[idx + 1];
      if (!nextArg || nextArg.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = nextArg;
      }
    }
  });
  return args;
}

// ============================================================================
// CHANGED FILES DETECTION
// ============================================================================

function loadChangedFiles(args, projectDir) {
  // Priority 1: --changed-files (file path)
  if (args['changed-files']) {
    const filePath = args['changed-files'];
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);
    }
  }

  // Priority 2: --files (comma-separated or colon-separated)
  if (args['files']) {
    return args['files']
      .split(/[,:;]/)
      .map(f => f.trim())
      .filter(f => f.length > 0);
  }

  // Priority 3: Environment variables
  if (process.env.MERGE_GATE_FILES) {
    return process.env.MERGE_GATE_FILES
      .split(/[,:;]/)
      .map(f => f.trim())
      .filter(f => f.length > 0);
  }

  // Priority 4: Git diff
  try {
    const base = args.base || process.env.MERGE_GATE_BASE || 'origin/main';
    const { execSync } = require('child_process');
    // Three-dot diff = changes since merge-base; ACMR excludes deletions (a deleted file is not "unreachable").
    const output = execSync(`git diff --diff-filter=ACMR --name-only ${base}...HEAD`, {
      cwd: projectDir,
      encoding: 'utf8'
    });
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch (e) {
    // Ignore git errors
  }

  return [];
}

// ============================================================================
// CHECKER EXECUTION
// ============================================================================

const CHECKER_FN = { D1: 'checkReachability', D2: 'checkConformance', D3: 'checkSelfMocking', D4: 'checkRealDependencyCoverage' };

// A checker that cannot be loaded is a gate ERROR (exit 2), never a pass. PR #1 of this repo was merged
// on a "PASS" produced while all four checkers reported "not found".
function loadChecker(name, projectDir) {
  // Checkers ship beside this orchestrator; a project-local copy under projectDir/tools/merge-gate wins if present.
  const local = path.join(projectDir, 'tools', 'merge-gate', `${name.toLowerCase()}-checker.js`);
  const bundled = path.join(__dirname, 'tools', 'merge-gate', `${name.toLowerCase()}-checker.js`);
  const checkerPath = fs.existsSync(local) ? local : bundled;
  try {
    const checkerModule = require(checkerPath);
    const fn = checkerModule[CHECKER_FN[name]];
    if (typeof fn !== 'function') return { fn: null, error: `${checkerPath} does not export ${CHECKER_FN[name]}` };
    return { fn, error: null };
  } catch (e) {
    return { fn: null, error: `${checkerPath}: ${e.message}` };
  }
}

async function runChecker(name, checker, projectDir, changedFiles, timeoutMs = 30000) {
  const startTime = Date.now();

  try {
    if (!checker || !checker.fn) {
      return {
        checker: name,
        name: getCheckerName(name),
        status: 'ERROR',
        duration_ms: 0,
        message: `Checker failed to load: ${checker ? checker.error : 'not provided'}`,
        severity: 'ERROR',
        exitCode: 2,
        fullOutput: ''
      };
    }
    const checkerFn = checker.fn;

    // Run checker with timeout
    const result = await Promise.race([
      new Promise(resolve => {
        try {
          const output = checkerFn(projectDir, changedFiles);
          resolve(output);
        } catch (e) {
          resolve({ exitCode: 2, stdout: `error: ${e.message}\n` });
        }
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs)
      )
    ]);

    const durationMs = Date.now() - startTime;
    const exitCode = result.exitCode || 0;
    const output = result.stdout || '';

    // Determine status and severity. Exit 2 from any checker is a gate error, not a verdict on the code.
    let status, severity;
    if (exitCode === 2) {
      status = 'ERROR';
      severity = 'ERROR';
    } else if (name === 'D3' || name === 'D4') {
      // Advisory checkers: findings warn, they never block.
      if (exitCode === 0 && !/\[UNTESTED\]/.test(output)) {
        status = 'PASS';
        severity = 'OK';
      } else {
        status = 'UNTESTED';
        severity = 'WARNING';
      }
    } else {
      // D1 and D2 are hard blockers
      if (exitCode === 0) {
        status = 'PASS';
        severity = 'OK';
      } else if (exitCode === 3) {
        status = 'BLOCKED';
        severity = 'DEFECT';
      } else {
        status = 'FAIL';
        severity = 'DEFECT';
      }
    }

    // Parse output for details
    const details = parseCheckerOutput(name, output);

    return {
      checker: name,
      name: getCheckerName(name),
      status,
      duration_ms: durationMs,
      message: output.split('\n')[0] || 'Check completed',
      details,
      severity,
      exitCode,
      fullOutput: output
    };
  } catch (e) {
    const durationMs = Date.now() - startTime;
    return {
      checker: name,
      name: getCheckerName(name),
      status: 'ERROR',
      duration_ms: durationMs,
      message: `Error: ${e.message}`,
      severity: 'ERROR',
      exitCode: 2,
      fullOutput: `error: ${e.message}\n`
    };
  }
}

function getCheckerName(name) {
  const names = {
    D1: 'Reachability',
    D2: 'Interface Conformance',
    D3: 'Self-Mock Disclosure',
    D4: 'Real-Dependency Smoke'
  };
  return names[name] || name;
}

function parseCheckerOutput(name, output) {
  const lines = output.split('\n').filter(l => l.trim());

  if (name === 'D2') {
    // Parse D2 output for phantom methods
    // Format: "file: variable.method not found on module"
    const methods = new Set();
    const missing = [];

    lines.forEach(line => {
      const match = line.match(/(\w+)\.(\w+)\s+not found/);
      if (match) {
        methods.add(match[2]);
        missing.push(match[2]);
      }
    });

    if (missing.length > 0) {
      return {
        missing_methods: Array.from(new Set(missing)),
        error_lines: lines.slice(0, 5)
      };
    }
  }

  return { error_lines: lines.slice(0, 50) };
}

// ============================================================================
// RESULT AGGREGATION
// ============================================================================

function aggregateResults(checkResults, mode = 'pass-with-flag') {
  const blockers = ['D1', 'D2'];
  const nonBlockers = ['D3', 'D4'];

  let hasWarning = false;
  let hasError = false;
  let blockersFailed = false;

  for (const result of checkResults) {
    if (result.severity === 'DEFECT' && blockers.includes(result.checker)) blockersFailed = true;
    if (result.severity === 'WARNING') hasWarning = true;
    if (result.severity === 'ERROR') hasError = true;
  }

  // Fail closed: a checker that errored or failed to load can never contribute to a PASS.
  let verdict, exitCode;
  if (blockersFailed) {
    verdict = 'FAIL';
    exitCode = 1;
  } else if (hasError) {
    verdict = 'ERROR';
    exitCode = 2;
  } else if (mode === 'strict' && hasWarning) {
    verdict = 'WARN';
    exitCode = 2;
  } else {
    verdict = 'PASS';
    exitCode = 0;
  }

  const defectCount = checkResults.filter(r => r.severity === 'DEFECT').length;
  const warningCount = checkResults.filter(r => r.severity === 'WARNING').length;
  const errorCount = checkResults.filter(r => r.severity === 'ERROR').length;

  const parts = [];
  if (defectCount) parts.push(`${defectCount} DEFECT${defectCount > 1 ? 's' : ''} found`);
  if (errorCount) parts.push(`${errorCount} checker error${errorCount > 1 ? 's' : ''} (gate incomplete)`);
  if (warningCount) parts.push(`${warningCount} warning${warningCount > 1 ? 's' : ''} raised`);
  const summary = parts.length ? parts.join('; ') : 'All checks passed';

  return {
    verdict,
    summary,
    exitCode,
    defectCount,
    warningCount,
    errorCount,
    blockersFailed
  };
}

// ============================================================================
// OUTPUT GENERATION
// ============================================================================

function generateReport(checkResults, aggregation, changedFiles, projectDir, sha, base, skippedFiles = []) {
  const report = {
    version: '2.1.0',
    timestamp: new Date().toISOString(),
    sha: sha || 'unknown',
    base_branch: base || 'main',
    files_changed: changedFiles,
    files_count: changedFiles.length,
    files_skipped: skippedFiles,

    verdict: aggregation.verdict,
    summary: aggregation.summary,

    checks: checkResults.map(r => ({
      checker: r.checker,
      name: r.name,
      status: r.status,
      duration_ms: r.duration_ms,
      message: r.message,
      details: r.details,
      severity: r.severity
    })),

    verdict_final: {
      pass: aggregation.exitCode === 0,
      exit_code: aggregation.exitCode,
      failures: checkResults
        .filter(r => r.severity === 'DEFECT')
        .map(r => ({
          checker: r.checker,
          type: 'defect',
          message: r.message,
          action: 'required'
        })),
      warnings: checkResults
        .filter(r => r.severity === 'WARNING')
        .map(r => ({
          checker: r.checker,
          type: 'untested-checker',
          message: r.message
        })),
      errors: checkResults
        .filter(r => r.severity === 'ERROR')
        .map(r => ({
          checker: r.checker,
          type: 'checker-error',
          message: r.message
        }))
    }
  };

  return report;
}

function severityIcon(severity) {
  return severity === 'OK' ? '✓' : severity === 'WARNING' ? '?' : severity === 'ERROR' ? '!' : '✗';
}

function generateMarkdownComment(report) {
  const checks = report.checks
    .map(c => {
      let block = `${severityIcon(c.severity)} **${c.checker}** (${c.name}): ${c.message}`;
      const lines = (c.details && c.details.error_lines) || [];
      if (c.severity !== 'OK' && lines.length > 1) {
        block += '\n' + lines.slice(0, 10).map(l => `    ${l}`).join('\n');
      }
      return block;
    })
    .join('\n');

  const verdictLabel = { PASS: '✅ PASS', FAIL: '❌ FAIL', ERROR: '⚠️ ERROR (gate incomplete)', WARN: '⚠️ WARN' }[report.verdict] || report.verdict;
  const skipped = report.files_skipped && report.files_skipped.length
    ? `\n**Out of scope (non-JS):** ${report.files_skipped.length} file(s)` : '';

  return `## Merge Gate Report

**Verdict:** ${verdictLabel} — ${report.summary}

${checks}

**Gated files:** ${report.files_changed.join(', ') || '(none)'}${skipped}
**Base:** ${report.base_branch}
`;
}

function printConsoleReport(report) {
  console.log('\n' + '='.repeat(70));
  console.log('MERGE GATE REPORT');
  console.log('='.repeat(70));
  console.log(`Verdict: ${report.verdict}`);
  console.log(`Summary: ${report.summary}`);
  console.log(`Files: ${report.files_count}`);
  console.log('');

  for (const check of report.checks) {
    console.log(`${severityIcon(check.severity)} ${check.checker} (${check.name}): ${check.message} (${check.duration_ms}ms)`);

    if (check.details && check.details.missing_methods) {
      console.log(`  Missing methods: ${check.details.missing_methods.join(', ')}`);
    }
    const lines = (check.details && check.details.error_lines) || [];
    if (check.severity !== 'OK' && lines.length > 1) {
      for (const l of lines.slice(1, 10)) console.log(`  ${l}`);
      if (lines.length > 10) console.log(`  … ${lines.length - 10} more`);
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log(`Exit Code: ${report.verdict_final.exit_code}`);
  console.log('='.repeat(70) + '\n');
}

// ============================================================================
// MAIN ORCHESTRATOR
// ============================================================================

async function orchestrate() {
  try {
    const args = parseArgs();

    // Validate required arguments
    const projectDir = args['project-dir'] || process.cwd();
    if (!fs.existsSync(projectDir)) {
      console.error(`Error: project directory not found: ${projectDir}`);
      process.exit(1);
    }

    // Only JS modules are in scope for an import-graph gate; everything else is reported, not judged.
    const allChanged = loadChangedFiles(args, projectDir);
    const changedFiles = allChanged.filter(f => GATE_EXT.test(f));
    const skippedFiles = allChanged.filter(f => !GATE_EXT.test(f));

    if (allChanged.length === 0) {
      console.warn('Warning: no changed files detected');
    } else if (skippedFiles.length) {
      console.log(`Out of gate scope (non-JS): ${skippedFiles.length} file(s): ${skippedFiles.slice(0, 10).join(', ')}${skippedFiles.length > 10 ? ', …' : ''}`);
    }

    const checkers = ['D1', 'D2', 'D3', 'D4'].map(n => loadChecker(n, projectDir));

    const results = await Promise.all([
      runChecker('D1', checkers[0], projectDir, changedFiles, 30000),
      runChecker('D2', checkers[1], projectDir, changedFiles, 45000),
      runChecker('D3', checkers[2], projectDir, changedFiles, 30000),
      runChecker('D4', checkers[3], projectDir, changedFiles, 30000)
    ]);

    const mode = args.mode || 'pass-with-flag';
    const aggregation = aggregateResults(results, mode);

    const report = generateReport(
      results,
      aggregation,
      changedFiles,
      projectDir,
      args.sha || process.env.MERGE_GATE_SHA,
      args.base || process.env.MERGE_GATE_BASE,
      skippedFiles
    );

    // Write JSON output
    const outputJsonFile = args['output-json'];
    if (outputJsonFile) {
      const outputDir = path.dirname(outputJsonFile);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(outputJsonFile, JSON.stringify(report, null, 2));
      console.log(`JSON report written to: ${outputJsonFile}`);
    }

    // Print console report
    printConsoleReport(report);

    // Write markdown comment if requested
    if (args['output-markdown']) {
      const markdown = generateMarkdownComment(report);
      fs.writeFileSync(args['output-markdown'], markdown);
      console.log(`Markdown comment written to: ${args['output-markdown']}`);
    }

    // Exit with appropriate code
    process.exit(report.verdict_final.exit_code);

  } catch (e) {
    console.error(`Orchestrator error: ${e.message}`);
    console.error(e.stack);
    process.exit(2);
  }
}

// ============================================================================
// MODULE EXPORT (for programmatic use)
// ============================================================================

async function gate(options = {}) {
  const { files, sha, base, projectDir = process.cwd(), mode = 'pass-with-flag' } = options;

  try {
    const allFiles = files || [];
    const gated = allFiles.filter(f => GATE_EXT.test(f));
    const skipped = allFiles.filter(f => !GATE_EXT.test(f));
    const checkers = ['D1', 'D2', 'D3', 'D4'].map(n => loadChecker(n, projectDir));

    const results = await Promise.all([
      runChecker('D1', checkers[0], projectDir, gated, 30000),
      runChecker('D2', checkers[1], projectDir, gated, 45000),
      runChecker('D3', checkers[2], projectDir, gated, 30000),
      runChecker('D4', checkers[3], projectDir, gated, 30000)
    ]);

    const aggregation = aggregateResults(results, mode);
    const report = generateReport(results, aggregation, gated, projectDir, sha, base, skipped);

    return {
      pass: aggregation.exitCode === 0,
      exitCode: aggregation.exitCode,
      report
    };
  } catch (e) {
    return {
      pass: false,
      exitCode: 2,
      error: e.message
    };
  }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

if (require.main === module) {
  orchestrate().catch(e => {
    console.error('Fatal error:', e);
    process.exit(2);
  });
}

module.exports = { gate, orchestrate, loadChecker, runChecker, aggregateResults, generateReport, generateMarkdownComment };
