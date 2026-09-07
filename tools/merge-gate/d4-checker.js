// D4 Real-Dependency Smoke Checker - Supports both CommonJS and ESM
const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return p.split(path.sep).join('/');
}

function isMockedTest(content) {
  // Check for jest.mock
  if (/jest\.mock\s*\(/.test(content)) return true;
  
  // Check for proxyquire
  if (/proxyquire\s*\(/.test(content)) return true;
  
  // Check for sinon.stub or sinon.mock
  if (/sinon\.(stub|mock)\s*\(/.test(content)) return true;
  
  return false;
}

function findTestFileFor(sourceFile, testFiles) {
  // Convert src/db.js to test/db.test.js or db.test.js or db.spec.js
  const baseName = sourceFile.split('/').pop().replace(/\.[^.]+$/, '');
  
  for (const testFile of testFiles) {
    const testBaseName = testFile.split('/').pop().replace(/\.[^.]+$/, '');
    if (testBaseName.includes(baseName)) {
      return testFile;
    }
  }
  
  return null;
}

function checkRealDependencyCoverage(projectDir, changedFiles = null) {
  try {
    if (!changedFiles) {
      changedFiles = [];
      const walk = (dir) => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file === 'node_modules' || file.startsWith('.')) continue;
          const fullPath = path.join(dir, file);
          const rel = normalizePath(path.relative(projectDir, fullPath));
          if (fs.lstatSync(fullPath).isDirectory()) {
            walk(fullPath);
          } else if ((file.endsWith('.js') || file.endsWith('.mjs')) && !file.includes('test') && !file.includes('spec')) {
            changedFiles.push(rel);
          }
        }
      };
      walk(projectDir);
    } else {
      changedFiles = changedFiles.map(normalizePath);
    }
    
    // Find all test files
    const testFiles = [];
    const walk = (dir) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file === 'node_modules' || file.startsWith('.')) continue;
        const fullPath = path.join(dir, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
          walk(fullPath);
        } else if ((file.endsWith('.js') || file.endsWith('.mjs')) && (file.includes('test') || file.includes('spec'))) {
          testFiles.push(normalizePath(path.relative(projectDir, fullPath)));
        }
      }
    };
    walk(projectDir);
    
    const untested = [];
    
    // Check each changed source file
    for (const sourceFile of changedFiles) {
      const testFile = findTestFileFor(sourceFile, testFiles);
      
      if (!testFile) {
        untested.push(`${sourceFile}: no test file found`);
        continue;
      }
      
      const filePath = path.join(projectDir, testFile.split('/').join(path.sep));
      if (!fs.existsSync(filePath)) continue;
      
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (isMockedTest(content)) {
          untested.push(`${sourceFile}: test is mocked, no real-dependency coverage`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    if (untested.length > 0) {
      return { exitCode: 1, stdout: untested.join('\n') + '\n' };
    }
    
    return { exitCode: 0, stdout: 'all changed files have real-dependency tests\n' };
  } catch (e) {
    return { exitCode: 1, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkRealDependencyCoverage };
