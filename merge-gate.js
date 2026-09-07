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
const { spawn } = require('child_process');

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
    const output = execSync(`git diff ${base}..HEAD --name-only`, {
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

function loadChecker(name, projectDir) {
  try {
    const checkerPath = path.join(projectDir, 'tools', 'merge-gate', `${name.toLowerCase()}-checker.js`);
    const checkerModule = require(checkerPath);

    if (name === 'D1') return checkerModule.checkReachability;
    if (name === 'D2') return checkerModule.checkConformance;
    if (name === 'D3') return checkerModule.checkSelfMocking;
    if (name === 'D4') return checkerModule.checkRealDependencyCoverage;
  } catch (e) {
    // Checker not found or error loading
  }
  return null;
}

async function runChecker(name, checkerFn, projectDir, changedFiles, timeoutMs = 30000) {
  const startTime = Date.now();

  try {
    if (!checkerFn) {
      return {
        checker: name,
        name: getCheckerName(name),
        status: 'SKIPPED',
        duration_ms: 0,
        message: 'Checker not found',
        severity: 'WARNING'
      };
    }

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

    // Determine status and severity
    let status, severity;
    if (name === 'D3' || name === 'D4') {
      // D3 and D4 are always UNTESTED for now
      status = 'UNTESTED';
      severity = 'WARNING';
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
      severity: 'DEFECT',
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

  return { error_lines: lines.slice(0, 5) };
}

// ============================================================================
// RESULT AGGREGATION
// ============================================================================

function aggregateResults(checkResults, mode = 'pass-with-flag') {
  const blockers = ['D1', 'D2'];
  const nonBlockers = ['D3', 'D4'];

  let hasDefect = false;
  let hasWarning = false;
  let blockersFailed = false;

  for (const result of checkResults) {
    if (result.severity === 'DEFECT') {
      if (blockers.includes(result.checker)) {
        blockersFailed = true;
      }
      hasDefect = true;
    }
    if (result.severity === 'WARNING') {
      hasWarning = true;
    }
  }

  let verdict, exitCode;

  if (blockersFailed) {
    verdict = 'FAIL';
    exitCode = 1;
  } else if (mode === 'strict' && hasWarning) {
    verdict = 'WARN';
    exitCode = 2;
  } else {
    verdict = 'PASS';
    exitCode = 0;
  }

  // Count defects and warnings
  const defectCount = checkResults.filter(r => r.severity === 'DEFECT').length;
  const warningCount = checkResults.filter(r => r.severity === 'WARNING').length;

  let summary = '';
  if (defectCount === 0 && warningCount === 0) {
    summary = 'All checks passed';
  } else if (defectCount > 0 && warningCount === 0) {
    summary = `${defectCount} DEFECT${defectCount > 1 ? 's' : ''} found`;
  } else if (defectCount === 0 && warningCount > 0) {
    summary = `${warningCount} warning${warningCount > 1 ? 's' : ''} raised`;
  } else {
    summary = `${defectCount} DEFECT${defectCount > 1 ? 's' : ''} found; ${warningCount} warning${warningCount > 1 ? 's' : ''} raised`;
  }

  return {
    verdict,
    summary,
    exitCode,
    defectCount,
    warningCount,
    blockersFailed
  };
}

// ============================================================================
// OUTPUT GENERATION
// ============================================================================

function generateReport(checkResults, aggregation, changedFiles, projectDir, sha, base) {
  const totalDuration = checkResults.reduce((sum, r) => sum + r.duration_ms, 0);

  const report = {
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    sha: sha || 'unknown',
    base_branch: base || 'main',
    files_changed: changedFiles,
    files_count: changedFiles.length,

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
        }))
    }
  };

  return report;
}

function generateMarkdownComment(report) {
  const checks = report.checks
    .map(c => {
      const icon = c.severity === 'OK' ? '✓' : c.severity === 'WARNING' ? '?' : '✗';
      return `${icon} ${c.checker} (${c.name}): ${c.message}`;
    })
    .join('\n');

  const markdown = `## Merge Gate Report

**Verdict:** ${report.verdict_final.pass ? '✅ PASS' : '❌ FAIL'}

${checks}

**Files:** ${report.files_changed.join(', ') || '(none)'}
**Time:** ${report.checks.reduce((s, c) => s + c.duration_ms, 0)}ms
**Base:** ${report.base_branch}
`;

  return markdown;
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
    const icon = check.severity === 'OK' ? '✓' : check.severity === 'WARNING' ? '?' : '✗';
    console.log(`${icon} ${check.checker} (${check.name}): ${check.message} (${check.duration_ms}ms)`);

    if (check.details && check.details.missing_methods) {
      console.log(`  Missing methods: ${check.details.missing_methods.join(', ')}`);
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

    // Load changed files
    const changedFiles = loadChangedFiles(args, projectDir);

    if (changedFiles.length === 0) {
      console.warn('Warning: no changed files detected');
    }

    // Load checkers
    const d1Fn = loadChecker('D1', projectDir);
    const d2Fn = loadChecker('D2', projectDir);
    const d3Fn = loadChecker('D3', projectDir);
    const d4Fn = loadChecker('D4', projectDir);

    // Run all checkers in parallel
    const results = await Promise.all([
      runChecker('D1', d1Fn, projectDir, changedFiles, 30000),
      runChecker('D2', d2Fn, projectDir, changedFiles, 45000),
      runChecker('D3', d3Fn, projectDir, changedFiles, 30000),
      runChecker('D4', d4Fn, projectDir, changedFiles, 30000)
    ]);

    // Aggregate results
    const mode = args.mode || 'pass-with-flag';
    const aggregation = aggregateResults(results, mode);

    // Generate report
    const report = generateReport(
      results,
      aggregation,
      changedFiles,
      projectDir,
      args.sha || process.env.MERGE_GATE_SHA,
      args.base || process.env.MERGE_GATE_BASE
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
    // Load checkers
    const d1Fn = loadChecker('D1', projectDir);
    const d2Fn = loadChecker('D2', projectDir);
    const d3Fn = loadChecker('D3', projectDir);
    const d4Fn = loadChecker('D4', projectDir);

    // Run all checkers in parallel
    const results = await Promise.all([
      runChecker('D1', d1Fn, projectDir, files, 30000),
      runChecker('D2', d2Fn, projectDir, files, 45000),
      runChecker('D3', d3Fn, projectDir, files, 30000),
      runChecker('D4', d4Fn, projectDir, files, 30000)
    ]);

    // Aggregate results
    const aggregation = aggregateResults(results, mode);

    // Generate report
    const report = generateReport(results, aggregation, files || [], projectDir, sha, base);

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
