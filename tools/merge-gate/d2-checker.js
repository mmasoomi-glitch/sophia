// D2 Interface Conformance Checker - Supports both CommonJS and ESM
const fs = require('fs');
const path = require('path');
const lib = require('./gate-lib.js');
const { stripComments } = lib;

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

  let match;
  // CommonJS: exports.foo = … / module.exports.foo = …
  const cjsNamed = /(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((match = cjsNamed.exec(content)) !== null) exports[match[1]] = true;

  // CommonJS: module.exports = { foo: ..., bar: ... }
  const cjsObj = /module\.exports\s*=\s*{([^}]*)}/.exec(content);
  if (cjsObj) {
    for (const prop of cjsObj[1].split(',')) {
      const name = prop.trim().split(':')[0].split('(')[0].replace(/^(?:async\s+|\.\.\.)/, '').trim();
      if (name) exports[name] = true;
    }
    return exports;
  }
  // CommonJS: module.exports = new Foo() / class Foo {} / anything else (opaque)
  const cjsOther = /module\.exports\s*=\s*(?:new\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(\S))/.exec(content);
  if (cjsOther) {
    if (cjsOther[1] || cjsOther[2]) { Object.assign(exports, extractClassMethods(content, cjsOther[1] || cjsOther[2])); return exports; }
    exports.__opaque__ = true;
    return exports;
  }
  if (/Object\.assign\s*\(\s*(?:module\.)?exports\b/.test(content)) exports.__opaque__ = true;

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
        const sourceContent = stripComments(fs.readFileSync(sourcePath, 'utf8'));
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
        const sourceContent = stripComments(fs.readFileSync(sourcePath, 'utf8'));
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

  // ESM: export default <identifier | function | expression> — shape unknown; do not judge member calls on it.
  if (/export\s+default\s+(?!\{|new\s|class\b)/.test(content)) exports.__opaque__ = true;

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
    const seen = new Set();

    for (const file of changedFiles) {
      const filePath = path.join(projectDir, file.split('/').join(path.sep));
      if (!fs.existsSync(filePath)) continue;

      try {
        const content = stripComments(fs.readFileSync(filePath, 'utf8'));

        // Only whole-module bindings (default import, `import * as`, `const x = require()`) have a shape D2 can
        // know. A named import is a value (function, array, constant) whose members are not this module's exports.
        const bindings = new Map();
        for (const b of lib.extractImports(content, file, projectDir)) {
          if (b.name && b.resolved && (b.kind === 'default' || b.kind === 'namespace' || b.kind === 'cjs')) bindings.set(b.name, b);
        }
        if (!bindings.size) continue;

        const methodCalls = extractMethodCalls(lib.blankStrings(content));

        for (const call of methodCalls) {
          const b = bindings.get(call.variable);
          if (!b) continue;
          const modulePath = path.join(projectDir, b.resolved.split('/').join(path.sep));
          if (!fs.existsSync(modulePath)) continue;

          const moduleContent = stripComments(fs.readFileSync(modulePath, 'utf8'));
          const exports = extractExports(moduleContent, b.resolved, projectDir);
          // An export whose shape cannot be read statically (export default someIdentifier, module.exports = fn)
          // is not evidence of a phantom method.
          if (exports.__opaque__ && b.kind !== 'namespace') continue;
          if (b.kind === 'namespace' && call.method === 'default') continue;

          if (!(call.method in exports)) {
            const key = `${file}|${call.variable}.${call.method}`;
            if (seen.has(key)) continue;
            seen.add(key);
            errors.push({ file, variable: call.variable, method: call.method, module: b.spec });
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

module.exports = { checkConformance, extractExports };
