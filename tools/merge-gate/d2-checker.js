// D2 Interface Conformance Checker - Supports both CommonJS and ESM
const fs = require('fs');
const path = require('path');

function normalizePath(p) {
  return p.split(path.sep).join('/');
}

function extractRequireMap(content, filePath) {
  const map = {};
  // const db = require('./db')
  const requirePattern = /const\s+(\w+)\s*=\s*require\s*\(\s*['"`]([^'"` ]+)['"`]\s*\)/g;
  let match;
  while ((match = requirePattern.exec(content)) !== null) {
    map[match[1]] = match[2];
  }
  return map;
}

function extractImportMap(content, filePath) {
  const map = {};
  // import db from './db.mjs'
  const defaultImportPattern = /import\s+(\w+)\s+from\s+['"`]([^'"` ]+)['"`]/g;
  let match;
  while ((match = defaultImportPattern.exec(content)) !== null) {
    map[match[1]] = match[2];
  }
  
  // import { a, b } from './x.mjs'
  const namedImportPattern = /import\s+{([^}]+)}\s+from\s+['"`]([^'"` ]+)['"`]/g;
  while ((match = namedImportPattern.exec(content)) !== null) {
    const names = match[1].split(',').map(s => s.trim().split(' as ')[0].trim());
    for (const name of names) {
      map[name] = match[2];
    }
  }
  
  // import * as ns from './x.mjs'
  const namespaceImportPattern = /import\s+\*\s+as\s+(\w+)\s+from\s+['"`]([^'"` ]+)['"`]/g;
  while ((match = namespaceImportPattern.exec(content)) !== null) {
    map[match[1]] = match[2];
  }
  
  return map;
}

function extractMethodCalls(content) {
  const calls = [];
  // x.method(...) - match any variable.methodName pattern
  const methodPattern = /(\w+)\.(\w+)\s*\(/g;
  let match;
  while ((match = methodPattern.exec(content)) !== null) {
    calls.push({ variable: match[1], method: match[2] });
  }
  return calls;
}

function extractClassMethods(content, className) {
  const methods = {};

  // Find the class definition: class ClassName { ... }
  // Use a simpler approach: find class keyword, then extract methods from braces
  const classPattern = new RegExp(`class\\s+${className}\\s*\\{`, 'g');
  const classMatch = classPattern.exec(content);

  if (!classMatch) return methods;

  // Extract the class body by finding matching braces
  let braceCount = 0;
  let startIndex = classMatch.index + classMatch[0].length;
  let endIndex = startIndex;
  let foundOpen = false;

  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === '{') {
      braceCount++;
      foundOpen = true;
    } else if (content[i] === '}') {
      braceCount--;
      if (foundOpen && braceCount < 0) {
        endIndex = i;
        break;
      }
    }
  }

  if (endIndex === startIndex) endIndex = content.length;
  const classBody = content.substring(startIndex - 1, endIndex + 1);

  // Extract method definitions: methodName() or async methodName()
  // Captures method names, including getters/setters and async methods
  const methodPattern = /(?:async\s+)?(?:get|set)?\s*(\w+)\s*\([^)]*\)\s*{/g;
  let match;
  while ((match = methodPattern.exec(classBody)) !== null) {
    const methodName = match[1];
    // Skip constructor
    if (methodName !== 'constructor') {
      methods[methodName] = true;
    }
  }

  return methods;
}

function extractExports(content, filePath, projectDir, visited = new Set()) {
  const exports = {};

  // Prevent cycles
  if (visited.has(filePath)) return exports;
  visited.add(filePath);

  // CommonJS: module.exports = { foo: ..., bar: ... }
  const cjsPattern = /module\.exports\s*=\s*{([^}]+)}/;
  let match = cjsPattern.exec(content);
  if (match) {
    const props = match[1].split(',');
    for (const prop of props) {
      const name = prop.trim().split(':')[0].split('(')[0].trim();
      if (name && name !== '') {
        exports[name] = true;
      }
    }
    return exports;
  }

  // ESM: export function foo() {}
  const exportFunctionPattern = /export\s+(?:async\s+)?function\s+(\w+)\s*\(/g;
  while ((match = exportFunctionPattern.exec(content)) !== null) {
    exports[match[1]] = true;
  }

  // ESM: export const foo = ...
  const exportConstPattern = /export\s+const\s+(\w+)\s*=/g;
  while ((match = exportConstPattern.exec(content)) !== null) {
    exports[match[1]] = true;
  }

  // ESM: export { a, b }
  const exportNamedPattern = /export\s+{([^}]+)}/g;
  while ((match = exportNamedPattern.exec(content)) !== null) {
    const items = match[1].split(',');
    for (const item of items) {
      const name = item.trim().split(' as ')[0].trim();
      if (name && name !== '') {
        exports[name] = true;
      }
    }
  }

  // ESM: export { x } from './y' — re-export chain
  const reexportPattern = /export\s+{([^}]+)}\s+from\s+['"`]([^'"` ]+)['"`]/g;
  while ((match = reexportPattern.exec(content)) !== null) {
    const names = match[1].split(',').map(s => s.trim().split(' as ')[0].trim());
    const sourceImport = match[2];

    const currentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    const resolved = resolveModulePath(sourceImport, currentDir || '.', projectDir);
    const sourcePath = path.join(projectDir, resolved.split('/').join(path.sep));

    if (fs.existsSync(sourcePath)) {
      try {
        const sourceContent = fs.readFileSync(sourcePath, 'utf8');
        const sourceExports = extractExports(sourceContent, resolved, projectDir, visited);

        for (const name of names) {
          if (name in sourceExports) {
            exports[name] = true;
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }
  }

  // ESM: export * from './y' — star re-export
  const starReexportPattern = /export\s+\*\s+from\s+['"`]([^'"` ]+)['"`]/g;
  while ((match = starReexportPattern.exec(content)) !== null) {
    const sourceImport = match[1];

    const currentDir = filePath.substring(0, filePath.lastIndexOf('/'));
    const resolved = resolveModulePath(sourceImport, currentDir || '.', projectDir);
    const sourcePath = path.join(projectDir, resolved.split('/').join(path.sep));

    if (fs.existsSync(sourcePath)) {
      try {
        const sourceContent = fs.readFileSync(sourcePath, 'utf8');
        const sourceExports = extractExports(sourceContent, resolved, projectDir, visited);
        Object.assign(exports, sourceExports);
      } catch (e) {
        // Ignore read errors
      }
    }
  }

  // ESM: export default { foo, bar }
  const exportDefaultPattern = /export\s+default\s+{([^}]+)}/;
  match = exportDefaultPattern.exec(content);
  if (match) {
    const props = match[1].split(',');
    for (const prop of props) {
      const name = prop.trim().split(':')[0].split('(')[0].trim();
      if (name && name !== '') {
        exports[name] = true;
      }
    }
  }

  // NEW: ESM: export default new ClassName() — class instance export
  const exportDefaultNewPattern = /export\s+default\s+new\s+(\w+)\s*\(/;
  match = exportDefaultNewPattern.exec(content);
  if (match) {
    const className = match[1];
    const classMethods = extractClassMethods(content, className);
    Object.assign(exports, classMethods);
  }

  // NEW: ESM: export default class ClassName { ... } — direct class export
  const exportDefaultClassPattern = /export\s+default\s+class\s+(\w+)\s*{/;
  match = exportDefaultClassPattern.exec(content);
  if (match) {
    const className = match[1];
    const classMethods = extractClassMethods(content, className);
    Object.assign(exports, classMethods);
  }

  return exports;
}

function resolveModulePath(importPath, currentDir, projectDir) {
  let resolved = path.normalize(
    path.join(currentDir, importPath).split(path.sep).join('/')
  ).split(path.sep).join('/');

  // Add extension if needed
  if (!resolved.endsWith('.js') && !resolved.endsWith('.mjs') && !resolved.endsWith('.json')) {
    const withMjs = resolved + '.mjs';
    const withJs = resolved + '.js';
    const fullWithMjs = path.join(projectDir, withMjs.split('/').join(path.sep));
    const fullWithJs = path.join(projectDir, withJs.split('/').join(path.sep));
    if (fs.existsSync(fullWithMjs)) {
      return resolved + '.mjs';
    } else if (fs.existsSync(fullWithJs)) {
      return resolved + '.js';
    }
  }

  return resolved;
}

function checkConformance(projectDir, changedFiles = null) {
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
    
    const errors = [];
    
    for (const file of changedFiles) {
      const filePath = path.join(projectDir, file.split('/').join(path.sep));
      if (!fs.existsSync(filePath)) continue;
      
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Extract both require and import maps
        const requireMap = extractRequireMap(content, file);
        const importMap = extractImportMap(content, file);
        const allImports = { ...requireMap, ...importMap };
        
        // Extract method calls
        const methodCalls = extractMethodCalls(content);
        
        // Check each method call
        for (const call of methodCalls) {
          if (!(call.variable in allImports)) continue; // Skip if variable not imported

          const importPath = allImports[call.variable];
          const currentDir = file.substring(0, file.lastIndexOf('/'));
          const resolved = resolveModulePath(importPath, currentDir || '.', projectDir);

          const modulePath = path.join(projectDir, resolved.split('/').join(path.sep));
          if (!fs.existsSync(modulePath)) continue;
          
          const moduleContent = fs.readFileSync(modulePath, 'utf8');
          const exports = extractExports(moduleContent, resolved, projectDir);

          if (!(call.method in exports)) {
            errors.push({
              file: file,
              variable: call.variable,
              method: call.method,
              module: importPath,
              lineContent: content.split('\n').find(line => line.includes(call.variable + '.' + call.method))
            });
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    if (errors.length > 0) {
      return { 
        exitCode: 1, 
        stdout: errors.map(e => `${e.file}: ${e.variable}.${e.method} not found on ${e.module}`).join('\n') + '\n'
      };
    }
    
    return { exitCode: 0, stdout: 'all methods conform\n' };
  } catch (e) {
    return { exitCode: 1, stdout: `error: ${e.message}\n` };
  }
}

module.exports = { checkConformance };
