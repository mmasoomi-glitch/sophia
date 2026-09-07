// Shared helpers for the merge-gate checkers. Node stdlib only, regex-based (no parser).
const fs = require('fs');
const path = require('path');

const GATE_EXT = /\.(m?js|cjs)$/i;
const TEST_FILE = /(?:[._-](?:test|spec|e2e|integration)|(?:Test|Spec|Tests|Specs))\.(m?js|cjs)$/;
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'integration']);
const SETUP_FILE = /(?:^|\/)(?:jest|vitest|mocha|test|tests)?[._-]?setup(?:Tests|-tests)?\.(m?js|cjs)$/i;

function toPosix(p) { return p.split(path.sep).join('/'); }
function toNative(p) { return p.split('/').join(path.sep); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalizeRel(p) { return path.posix.normalize(toPosix(String(p)).replace(/\\/g, '/')).replace(/^\.\//, ''); }

function isGateFile(rel) { return GATE_EXT.test(rel); }
function isTestFile(rel) {
  if (!GATE_EXT.test(rel)) return false;
  if (TEST_FILE.test(path.posix.basename(rel))) return true;
  return rel.split('/').slice(0, -1).some(seg => TEST_DIRS.has(seg));
}
function isSetupFile(rel) { return GATE_EXT.test(rel) && SETUP_FILE.test(rel); }

function stem(rel) {
  return path.posix.basename(rel).replace(/[._-](test|spec|e2e|integration)(?=\.)|(Test|Spec|Tests|Specs)(?=\.)/, '').replace(/\.[^.]+$/, '');
}

// Minimal lexer: splits source into code / comment / string / template / regex segments so the checkers never
// mistake text inside a comment, string or regex literal for code. Single-quoted strings end at a newline
// (a stray quote inside a regex can then cost at most one line). Regex literals are recognised by the
// standard "what precedes the slash" heuristic.
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
function lex(src) {
  const segs = [];
  const n = src.length;
  let i = 0, codeStart = 0;
  const push = (type, s, e) => {
    if (s > codeStart) segs.push({ type: 'code', start: codeStart, end: s });
    segs.push({ type, start: s, end: e });
    codeStart = e;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      push('comment', i, end); i = end; continue;
    }
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      push('comment', i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      const end = Math.min(n, j + (src[j] === c ? 1 : 0));
      push('string', i, end); i = end; continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++; }
      const end = Math.min(n, j + 1);
      push('template', i, end); i = end; continue;
    }
    if (c === '/') {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      const prev = k < 0 ? '' : src[k];
      let w = k;
      while (w >= 0 && /[\w$]/.test(src[w])) w--;
      const word = src.slice(w + 1, k + 1);
      const allowed = prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_PREV_WORDS.has(word);
      if (allowed) {
        let j = i + 1, inClass = false, closed = false;
        while (j < n && src[j] !== '\n') {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (inClass) { if (ch === ']') inClass = false; }
          else if (ch === '[') inClass = true;
          else if (ch === '/') { closed = true; break; }
          j++;
        }
        if (closed) {
          j++;
          while (j < n && /[a-z]/i.test(src[j])) j++;
          push('regex', i, j); i = j; continue;
        }
      }
    }
    i++;
  }
  if (codeStart < n) segs.push({ type: 'code', start: codeStart, end: n });
  return segs;
}

function blankKeepingNewlines(s) { return s.replace(/[^\n]/g, ' '); }

// Rebuild the source, replacing selected segments. `decide(seg, text, outSoFar)` returns replacement text or null.
function rewrite(src, decide) {
  let out = '';
  for (const seg of lex(src)) {
    const text = src.slice(seg.start, seg.end);
    const r = decide(seg, text, out);
    out += r === null || r === undefined ? text : r;
  }
  return out;
}

function blankLiteral(text) {
  const open = text[0];
  const close = text.length > 1 && text[text.length - 1] === open ? open : '';
  return open + blankKeepingNewlines(text.slice(1, text.length - close.length)) + close;
}

// Remove comments (string, template and regex contents untouched).
function stripComments(src) {
  return rewrite(src, seg => seg.type === 'comment' ? blankKeepingNewlines(src.slice(seg.start, seg.end)) : null);
}

// Blank the inside of string, template and regex literals so `"db.query() is slow"` is not mistaken for a call.
function blankStrings(src) {
  return rewrite(src, (seg, text) => (seg.type === 'string' || seg.type === 'template') ? blankLiteral(text)
    : seg.type === 'regex' ? '/' + blankKeepingNewlines(text.slice(1, -1)) + '/' : null);
}

// Blank string contents except where the string is a module specifier (after from / import / require( / import( /
// esmock( / proxyquire( / mock(), so `"see require('./x')"` cannot register as an import.
const SPECIFIER_CONTEXT = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|\besmock(?:\.\w+)*\s*\(|\bproxyquire(?:\.\w+)*\s*\(|\bmock(?:Module)?\s*\()\s*$/;
function blankNonSpecifierStrings(src) {
  return rewrite(src, (seg, text, out) => {
    if (seg.type === 'regex') return '/' + blankKeepingNewlines(text.slice(1, -1)) + '/';
    if (seg.type !== 'string' && seg.type !== 'template') return null;
    return SPECIFIER_CONTEXT.test(out.slice(-40)) ? null : blankLiteral(text);
  });
}

// Does a module run code on load (calls or IIFEs at column 0)? Used to decide whether merely importing it
// for its side effects exercises anything.
function hasTopLevelSideEffects(content) {
  const src = blankStrings(stripComments(content));
  // Split into statements at brace/bracket/paren depth 0 (on ';' or newline), then look for a call or IIFE
  // at the start of a statement.
  const statements = [];
  let depth = 0, cur = '';
  for (const ch of src) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === ';' || ch === '\n')) { statements.push(cur); cur = ''; continue; }
    cur += ch;
  }
  statements.push(cur);
  const call = /^\s*(?:await\s+)?(?!(?:if|for|while|switch|catch|with|function|class|return|import|export|const|let|var|throw|new|typeof|delete|void)\b)[A-Za-z_$][\w$.]*\s*\(/;
  const iife = /^\s*\(\s*(?:async\s*)?(?:function\b|\()/;
  return statements.some(s => call.test(s) || iife.test(s));
}

function readRel(projectDir, rel) {
  return stripComments(fs.readFileSync(path.join(projectDir, toNative(rel)), 'utf8'));
}

function walkFiles(projectDir, pred) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = toPosix(path.relative(projectDir, full));
        if (pred(rel)) out.push(rel);
      }
    }
  };
  walk(projectDir);
  return out;
}

// Resolve a relative specifier from `fromRel` (posix, relative to projectDir) the way Node does:
// exact file, then .mjs/.js/.cjs/.json, then directory index. Bare specifiers return null.
// An unresolvable relative specifier returns its normalized guess so callers can still compare.
function resolveSpecifier(spec, fromRel, projectDir) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const isFile = (rel) => { try { return fs.statSync(path.join(projectDir, toNative(rel))).isFile(); } catch { return false; } };
  if (isFile(base)) return base;
  for (const ext of ['.mjs', '.js', '.cjs', '.json']) if (isFile(base + ext)) return base + ext;
  for (const idx of ['index.mjs', 'index.js', 'index.cjs']) {
    const c = path.posix.join(base, idx);
    if (isFile(c)) return c;
  }
  return base;
}

function namedList(s) {
  return s.split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const [imp, loc] = x.split(/\s+as\s+/).map(y => y.trim());
    return [imp, loc || imp];
  });
}

function destructList(s) {
  return s.split(',').map(x => x.trim()).filter(Boolean).filter(x => !x.startsWith('...')).map(x => {
    const [imp, loc] = x.split(':').map(y => y.trim());
    return [imp.split('=')[0].trim(), (loc || imp).split('=')[0].trim()];
  });
}

// Every import/require/re-export in a file:
//   { name, spec, resolved, kind, importedName }
//   kind: default | named | namespace | side-effect | cjs | cjs-named | dynamic | re-export | injector
//   name is null for side-effect, re-export and unassigned dynamic imports.
function extractImports(content, fromRel, projectDir) {
  content = blankNonSpecifierStrings(content);
  const out = [];
  const add = (name, spec, kind, importedName) =>
    out.push({ name, spec, resolved: resolveSpecifier(spec, fromRel, projectDir), kind, importedName: importedName || name });
  let m;
  const reDefault = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reDefault.exec(content))) {
    add(m[1], m[3], 'default');
    if (m[2]) namedList(m[2]).forEach(([imp, loc]) => add(loc, m[3], 'named', imp));
  }
  const reNamed = /import\s*\{([^}]*)\}\s*from\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reNamed.exec(content))) namedList(m[1]).forEach(([imp, loc]) => add(loc, m[2], 'named', imp));
  const reNs = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reNs.exec(content))) add(m[1], m[2], 'namespace');
  const reSide = /import\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reSide.exec(content))) add(null, m[1], 'side-effect');
  const reCjs = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = reCjs.exec(content))) add(m[1], m[2], 'cjs');
  const reCjsNamed = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = reCjsNamed.exec(content))) destructList(m[1]).forEach(([imp, loc]) => add(loc, m[2], 'cjs-named', imp));
  const reDyn = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = reDyn.exec(content))) add(m[1], m[2], 'namespace');
  const reDynNamed = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = reDynNamed.exec(content))) destructList(m[1]).forEach(([imp, loc]) => add(loc, m[2], 'named', imp));
  // import('./x').then(m => …) / (await import('./x')).y use the result; a bare import('./x') only loads it.
  const reDynInline = /import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  while ((m = reDynInline.exec(content))) {
    const after = content.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const before = content.slice(Math.max(0, m.index - 12), m.index);
    const used = /^\s*\.\s*then\s*\(/.test(after) || (/await\s*$/.test(before) && /^\s*\)?\s*[.[]/.test(after));
    add(null, m[1], used ? 'dynamic-then' : 'dynamic');
  }
  // const svc = await esmock('./subject', {...}) / proxyquire('./subject', {...}) — the subject is loaded for real
  const reInjector = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:proxyquire|esmock)(?:\.\w+)*\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reInjector.exec(content))) add(m[1], m[2], 'injector');
  const reReexport = /export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reReexport.exec(content))) add(null, m[1], 're-export');
  return out;
}

// Files reachable from `startRel` through static/dynamic imports and re-exports (relative specifiers only).
// Returns { reach: Set<rel>, parent: Map<rel, rel> } for explaining the path.
function reachableFrom(startRel, projectDir, maxDepth = 6, maxNodes = 500) {
  const reach = new Set();
  const parent = new Map();
  const queue = [[startRel, 0]];
  while (queue.length && reach.size < maxNodes) {
    const [cur, depth] = queue.shift();
    if (depth >= maxDepth) continue;
    let content;
    try { content = readRel(projectDir, cur); } catch { continue; }
    for (const b of extractImports(content, cur, projectDir)) {
      if (!b.resolved || reach.has(b.resolved) || b.resolved === startRel) continue;
      reach.add(b.resolved);
      parent.set(b.resolved, cur);
      queue.push([b.resolved, depth + 1]);
    }
  }
  return { reach, parent };
}

function pathTo(rel, parent, startRel) {
  const chain = [rel];
  let cur = rel;
  while (parent.has(cur) && parent.get(cur) !== startRel && chain.length < 12) { cur = parent.get(cur); chain.unshift(cur); }
  return chain;
}

// Framework-level module replacement: [{ spec, resolved, via, computed }]
function extractFrameworkMocks(content, fromRel, projectDir) {
  const out = [];
  let m;
  const re = /\b(jest\.mock|jest\.doMock|jest\.unstable_mockModule|jest\.requireMock|vi\.mock|vi\.doMock|mock\.module|td\.replace|rewire)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = re.exec(content))) out.push({ spec: m[2], resolved: resolveSpecifier(m[2], fromRel, projectDir), via: m[1] });
  const reViImport = /\bvi\.mock\s*\(\s*import\s*\(\s*['"`]([^'"`]+)['"`]/g;
  while ((m = reViImport.exec(content))) out.push({ spec: m[1], resolved: resolveSpecifier(m[1], fromRel, projectDir), via: 'vi.mock(import())' });
  const reComputed = /\b(jest\.mock|jest\.doMock|jest\.unstable_mockModule|vi\.mock|vi\.doMock|mock\.module|td\.replace|rewire)\s*\(\s*(?!['"`]|import\s*\()([A-Za-z_$][\w$.]*)/g;
  while ((m = reComputed.exec(content))) out.push({ spec: m[2], resolved: null, via: m[1], computed: true });
  // proxyquire('./subject', { './dep': stub }) / esmock('./subject', { './dep': stub }[, { global }]) — stub keys resolve
  // relative to the subject module.
  const reInjector = /\b(proxyquire(?:\.noCallThru\(\))?|esmock(?:\.\w+)?)\s*\(\s*['"`]([^'"`]+)['"`]\s*,/g;
  while ((m = reInjector.exec(content))) {
    const subject = resolveSpecifier(m[2], fromRel, projectDir) || fromRel;
    const tail = content.slice(m.index + m[0].length, m.index + m[0].length + 2000);
    let depth = 0, end = 0;
    for (; end < tail.length; end++) {
      if (tail[end] === '(') depth++;
      else if (tail[end] === ')') { if (depth === 0) break; depth--; }
    }
    for (const k of tail.slice(0, end).matchAll(/['"`]([^'"`]+)['"`]\s*:/g)) {
      out.push({ spec: k[1], resolved: resolveSpecifier(k[1], subject, projectDir), via: m[1].split('.')[0] });
    }
  }
  return out;
}

// sinon.stub(obj[, 'member']) / jest.spyOn / vi.spyOn / mock.method / td.replace(obj, 'm') → [{ binding, member, via }]
function extractMemberStubs(content) {
  const out = [];
  let m;
  const re = /\b(sinon\.(?:stub|replace|mock)|jest\.spyOn|vi\.spyOn|mock\.method|td\.replace)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*['"`]([^'"`]+)['"`]|\))/g;
  while ((m = re.exec(content))) out.push({ binding: m[2], member: m[3] || '*', via: m[1] });
  // new Proxy(real, handler) can intercept every access; treat it as a whole-object double.
  const reProxy = /\bnew\s+Proxy\s*\(\s*([A-Za-z_$][\w$]*)\s*,/g;
  while ((m = reProxy.exec(content))) out.push({ binding: m[1], member: '*', via: 'new Proxy' });
  return out;
}

// Assignments that replace an imported binding or one of its members after import:
//   db = fake; db.query = fake; db['query'] = fake; Object.assign(db, …); Object.defineProperty(db, …)
function extractReassignments(content, name) {
  const src = blankStrings(content);
  const b = escapeRe(name);
  const out = [];
  let m;
  // The whitespace must live inside the lookahead: `\s*(?!require` would backtrack to zero spaces and pass.
  const re = new RegExp(`(?<![\\w$.])${b}(\\.[\\w$]+|\\[[^\\]]*\\])?\\s*=(?![=>])(?!\\s*(?:require\\s*\\(|await\\s+import\\s*\\(|await\\s+(?:esmock|proxyquire)|(?:esmock|proxyquire)\\b))`, 'g');
  while ((m = re.exec(src))) out.push(m[1] || '(binding)');
  if (new RegExp(`Object\\.(?:assign|defineProperty|defineProperties)\\s*\\(\\s*${b}\\s*,`).test(src)) out.push('Object.assign/defineProperty');
  return out;
}

function tampersModuleCache(content) {
  return /require\.cache\s*\[|delete\s+require\.cache|Module\._load\s*=|Module\.prototype\.require\s*=/.test(blankStrings(content));
}

// Remove import/require statements so references to a binding can be counted outside its own declaration.
function withoutImportStatements(src) {
  return src
    .replace(/import\s+[\w$]+\s*(?:,\s*\{[^}]*\})?\s*from\s*['"`][^'"`]*['"`]/g, ' ')
    .replace(/import\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+)\s*from\s*['"`][^'"`]*['"`]/g, ' ')
    .replace(/(?:const|let|var)\s+(?:[\w$]+|\{[^}]*\})\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*['"`][^'"`]*['"`]\s*\)/g, ' ');
}

function referenceCount(content, name) {
  const src = withoutImportStatements(blankStrings(content));
  const b = escapeRe(name);
  const all = (src.match(new RegExp(`(?<![\\w$.])${b}(?![\\w$])`, 'g')) || []).length;
  const trivial = (src.match(new RegExp(`(?:typeof\\s+|console\\.\\w+\\(\\s*)${b}(?![\\w$])`, 'g')) || []).length;
  return Math.max(0, all - trivial);
}

// How a test uses an imported binding. Returns labels; empty means "never used beyond the import".
//   member calls (db.query(), db?.query(), db['query'](), db.query.call(), db.default.query()),
//   direct call, new, extends, destructuring, member extraction, passing as an argument, or a bare reference.
function usesOf(content, binding) {
  const src = blankStrings(content);
  const b = escapeRe(binding.name);
  const uses = new Set();
  let m;
  const member = new RegExp(`(?<![\\w$.])${b}\\s*\\??\\.\\s*(?:default\\s*\\??\\.\\s*)?([A-Za-z_$][\\w$]*)\\s*(?:\\.\\s*(?:call|apply|bind)\\s*)?\\(`, 'g');
  while ((m = member.exec(src))) uses.add(m[1]);
  const computed = new RegExp(`(?<![\\w$.])${b}\\s*\\[\\s*['"\`]([^'"\`]+)['"\`]\\s*\\]\\s*\\(`, 'g');
  while ((m = computed.exec(content))) uses.add(m[1]);
  if (new RegExp(`(?<![\\w$.])${b}\\s*\\(`).test(src)) uses.add(binding.kind === 'named' || binding.kind === 'cjs-named' ? binding.importedName : '(call)');
  if (new RegExp(`\\bnew\\s+${b}\\s*(?:\\.\\s*[\\w$]+\\s*)?\\(`).test(src)) uses.add('new');
  if (new RegExp(`\\bextends\\s+${b}(?![\\w$])`).test(src)) uses.add('extends');
  if (new RegExp(`\\}\\s*=\\s*${b}(?![\\w$])`).test(src)) uses.add('destructured');
  const extract = new RegExp(`=\\s*${b}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)(?![\\w$(])`, 'g');
  while ((m = extract.exec(src))) uses.add(`.${m[1]} extracted`);
  const passedMember = new RegExp(`[(,]\\s*${b}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*[,)]`, 'g');
  while ((m = passedMember.exec(src))) uses.add(`.${m[1]} passed`);
  // Passing the binding into a stubbing/patching call is not a use of the module.
  const srcNoStubCalls = src.replace(/\b(?:sinon\.\w+|jest\.spyOn|vi\.spyOn|mock\.method|td\.replace|new\s+Proxy|Object\.assign|Object\.defineProperty|Object\.defineProperties)\s*\(\s*[A-Za-z_$][\w$]*\s*[,)]/g, '(');
  if (new RegExp(`[(,]\\s*${b}\\s*[,)]`).test(srcNoStubCalls)) uses.add('passed');
  if (uses.size === 0 && referenceCount(content, binding.name) > 0) uses.add('referenced');
  return [...uses];
}

// Object literals assigned to a local, with their top-level keys: [{ name, keys:Set }]
function extractObjectLiterals(content) {
  const out = [];
  let m;
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g;
  while ((m = re.exec(content))) {
    const start = re.lastIndex;
    let depth = 1, i = start;
    for (; i < content.length && depth > 0; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') depth--;
    }
    let body = content.slice(start, i - 1);
    let prev;
    do { prev = body; body = body.replace(/\([^()]*\)/g, '').replace(/\{[^{}]*\}/g, '').replace(/\[[^\[\]]*\]/g, ''); } while (body !== prev);
    const keys = new Set();
    for (const part of body.split(',')) {
      const k = /^\s*(?:async\s+)?(?:get\s+|set\s+)?\*?\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|=>|$|=)/.exec(part);
      if (k) keys.add(k[1]);
    }
    if (keys.size) out.push({ name: m[1], keys });
  }
  return out;
}

module.exports = {
  GATE_EXT, toPosix, toNative, escapeRe, normalizeRel, isGateFile, isTestFile, isSetupFile, stem,
  lex, stripComments, blankStrings, blankNonSpecifierStrings, hasTopLevelSideEffects, readRel, walkFiles, resolveSpecifier, extractImports, reachableFrom, pathTo,
  extractFrameworkMocks, extractMemberStubs, extractReassignments, tampersModuleCache, referenceCount, usesOf,
  extractObjectLiterals,
};
