// D3 Self-Mock Disclosure Checker - Supports both CommonJS and ESM
const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return p.split(path.sep).join('/');
}

function extractMockedModules(content) {
  const mocked = [];
  
  // jest.mock('...')
  const jestPattern = /jest\.mock\s*\(\s*['"`]([^'"` ]+)['"`]/g;
  let match;
  while ((match = jestPattern.exec(content)) !== null) {
    mocked.push(match[1]);
  }
  
  // proxyquire('.', { '...': mock })
  const proxyquirePattern = /proxyquire\s*\([^,]+,\s*{([^}]+)}/;
  match = proxyquirePattern.exec(content);
  if (match) {
    const items = match[1].split(',');
    for (const item of items) {
      const pathMatch = item.match(/['"`]([^'"` ]+)['"`]/);
      if (pathMatch) mocked.push(pathMatch[1]);
    }
  }
  
  // sinon.stub, sinon.mock
  const sinonPattern = /sinon\.(stub|mock)\s*\([^,]*,\s*['"`]([^'"` ]+)['"`]/g;
  while ((match = sinonPattern.exec(content)) !== null) {
    mocked.push(match[2]);
  }
  
  return mocked;
}

function resolveModulePath(importPath, currentDir) {
  let resolved = path.normalize(
    path.join(currentDir, importPath).split(path.sep).join('/')
  ).split(path.sep).join('/');
  
  // Add extension if needed
  if (!resolved.endsWith('.js') && !resolved.endsWith('.mjs') && !resolved.endsWith('.json')) {
    if (fs.existsSync(resolved.split('/').join(path.sep) + '.mjs')) {
      return resolved + '.mjs';
    } else if (fs.existsSync(resolved.split('/').join(path.sep) + '.js')) {
      return resolved + '.js';
    }
  }
  
  return resolved;
}

function checkSelfMocking(projectDir, changedFiles = null) {
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
          } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
            changedFiles.push(rel);
          }
        }
      };
      walk(projectDir);
    } else {
      changedFiles = changedFiles.map(normalizePath);
    }
    
    const changedSet = new Set(changedFiles);
    const untested = [];
    
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
    
    // Check test files for self-mocking
    for (const testFile of testFiles) {
      const filePath = path.join(projectDir, testFile.split('/').join(path.sep));
      if (!fs.existsSync(filePath)) continue;
      
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const mockedModules = extractMockedModules(content);
        
        for (const mockedPath of mockedModules) {
          const currentDir = testFile.substring(0, testFile.lastIndexOf('/'));
          const resolved = resolveModulePath(mockedPath, currentDir || '.');
          
          if (changedSet.has(resolved)) {
            untested.push(`${testFile}: mocking changed module ${mockedPath}`);
            break;
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    if (untested.length > 0) {
      return { exitCode: 0, stdout: untested.map(u => `${u} [UNTESTED]`).join('\n') + '\n' };
    }
    
    return { exitCode: 0, stdout: 'no self-mocking detected\n' };
  } catch (e) {
    return { exitCode: 1, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkSelfMocking };
