// D1 Reachability Checker - Supports both CommonJS and ESM
const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return p.split(path.sep).join('/');
}

function extractImportsFromFile(content, filePath) {
  const imports = [];

  // CommonJS: require()
  const requirePattern = /require\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/g;
  let match;
  while ((match = requirePattern.exec(content)) !== null) {
    if (match[1].startsWith('.')) imports.push(match[1]);
  }

  // ESM: import ... from '...'
  const importPattern = /import\s+(?:(?:{[^}]*}|\*\s+as\s+\w+|\w+)(?:\s*,)?\s*)*(?:from\s+)?['"`]([^'"` ]+)['"`]/g;
  while ((match = importPattern.exec(content)) !== null) {
    if (match[1].startsWith('.')) imports.push(match[1]);
  }

  // Dynamic imports: import(path) - handles await import("./db.mjs") syntax
  const dynamicImportPattern = /import\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/g;
  while ((match = dynamicImportPattern.exec(content)) !== null) {
    if (match[1].startsWith('.')) imports.push(match[1]);
  }

  return imports;
}

function resolveModulePath(importPath, currentDir) {
  let resolved = path.normalize(
    path.join(currentDir, importPath).split(path.sep).join('/')
  ).split(path.sep).join('/');

  // Add extension if needed
  if (!resolved.endsWith('.js') && !resolved.endsWith('.mjs') && !resolved.endsWith('.json')) {
    const resolvedPath = resolved.split('/').join(path.sep);

    // Try .mjs extension
    if (fs.existsSync(resolvedPath + '.mjs')) {
      return resolved + '.mjs';
    }

    // Try .js extension
    if (fs.existsSync(resolvedPath + '.js')) {
      return resolved + '.js';
    }

    // Check if it's a directory with index file
    if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isDirectory()) {
      // Try index.mjs
      const indexMjsPath = path.join(resolvedPath, 'index.mjs');
      if (fs.existsSync(indexMjsPath)) {
        return resolved + '/index.mjs';
      }

      // Try index.js
      const indexJsPath = path.join(resolvedPath, 'index.js');
      if (fs.existsSync(indexJsPath)) {
        return resolved + '/index.js';
      }
    }
  }

  return resolved;
}

function checkReachability(projectDir, changedFiles = null) {
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return { exitCode: 1, stdout: 'package.json not found\n' };
    }
    
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const entrypoints = Array.isArray(pkg.entrypoints) 
      ? pkg.entrypoints 
      : (pkg.main ? [pkg.main] : []);
    
    if (entrypoints.length === 0) {
      return { exitCode: 1, stdout: 'No entrypoints found in package.json\n' };
    }
    
    // If no changed files, find all .js/.mjs files
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
    
    // Build reachability graph
    const reachable = new Set();
    const queue = [];
    
    for (const ep of entrypoints) {
      queue.push(ep);
      reachable.add(normalizePath(ep));
    }
    
    // BFS to find all reachable files
    while (queue.length > 0) {
      const current = queue.shift();
      const currentPath = path.join(projectDir, current.split('/').join(path.sep));
      
      if (!fs.existsSync(currentPath)) continue;
      
      try {
        const content = fs.readFileSync(currentPath, 'utf8');
        const imports = extractImportsFromFile(content, current);
        
        for (const imp of imports) {
          const currentDir = current.substring(0, current.lastIndexOf('/'));
          const resolved = resolveModulePath(imp, currentDir || '.');
          
          if (!reachable.has(resolved)) {
            reachable.add(resolved);
            queue.push(resolved);
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Check if all changed files are reachable
    const unreachable = [];
    for (const file of changedFiles) {
      if (!reachable.has(file)) {
        unreachable.push(file);
      }
    }
    
    if (unreachable.length > 0) {
      return { exitCode: 1, stdout: unreachable.map(f => `${f}: unreachable from entrypoints`).join('\n') + '\n' };
    }
    
    return { exitCode: 0, stdout: 'all files reachable\n' };
  } catch (e) {
    return { exitCode: 1, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkReachability };
