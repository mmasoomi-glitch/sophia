// Regression shapes for D3/D4. Dev-only evidence (author == checker author); independent corpora live in adversary-*/.
const fs = require('fs');
const path = require('path');
const { checkSelfMocking } = require('../d3-checker.js');
const { checkRealDependencyCoverage } = require('../d4-checker.js');

const root = path.join(require('os').tmpdir(), 'merge-gate-adv-shapes');
const DB = "export async function query(sql, p) { return []; }\nexport default { query };\n";
const INDEX = "import db from './db.mjs';\nexport { db };\n";

const shapes = [
  ['866 hand-written fake, never imports', 'test/db.test.mjs',
    "const db = { query: async () => [{id:1}], all: async () => [] };\nconst rows = await db.query('SELECT 1');\n",
    { d3flag: true, d4covered: false }],
  ['real default import exercised', 'test/db.test.mjs',
    "import db from '../src/db.mjs';\nawait db.query('SELECT 1');\n", { d3flag: false, d4covered: true }],
  ['named import exercised', 'test/db.test.mjs',
    "import { query } from '../src/db.mjs';\nawait query('x');\n", { d3flag: false, d4covered: true }],
  ['imports but never calls', 'test/db.test.mjs',
    "import db from '../src/db.mjs';\nconsole.log(typeof db);\n", { d3flag: false, d4covered: false }],
  ['jest.mock without real import', 'test/db.test.mjs',
    "jest.mock('../src/db.mjs');\ntest('x', () => {});\n", { d3flag: true, d4covered: false }],
  // A call through a stubbed member is a double, not coverage (independent adversary case 05 established this).
  ['import + sinon member stub, only stubbed member called', 'test/db.test.mjs',
    "import db from '../src/db.mjs';\nimport sinon from 'sinon';\nsinon.stub(db, 'query').resolves([]);\nawait db.query('x');\n",
    { d3flag: true, d4covered: false }],
  ['import + sinon member stub, other real member called', 'test/db.test.mjs',
    "import db from '../src/db.mjs';\nimport sinon from 'sinon';\nsinon.stub(db, 'other').resolves([]);\nawait db.query('x');\n",
    { d3flag: true, d4covered: true }],
  ['unrelated literal with one overlapping key', 'test/db.test.mjs',
    "const cfg = { query: 'x', port: 1 };\nimport db from '../src/db.mjs';\nawait db.query(cfg.query);\n", { d3flag: false, d4covered: true }],
  ['cjs destructured require', 'test/db.test.cjs',
    "const { query } = require('../src/db.mjs');\nquery('x');\n", { d3flag: false, d4covered: true }],
  ['namespace import exercised', 'test/db.test.mjs',
    "import * as db from '../src/db.mjs';\nawait db.query('x');\n", { d3flag: false, d4covered: true }],
  ['dynamic import exercised', 'test/db.test.mjs',
    "const db = await import('../src/db.mjs');\nawait db.query('x');\n", { d3flag: false, d4covered: true }],
  ['test in __tests__ dir, no test suffix', '__tests__/database.mjs',
    "import db from '../src/db.mjs';\nawait db.query('x');\n", { d3flag: false, d4covered: true }],
];

let failed = 0;
for (const [name, testPath, testContent, want] of shapes) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, testPath)), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{ "entrypoints": ["src/index.mjs"] }');
  fs.writeFileSync(path.join(root, 'src', 'db.mjs'), DB);
  fs.writeFileSync(path.join(root, 'src', 'index.mjs'), INDEX);
  fs.writeFileSync(path.join(root, testPath), testContent);
  const d3 = checkSelfMocking(root, ['src/db.mjs']);
  const d4 = checkRealDependencyCoverage(root, ['src/db.mjs']);
  const got = { d3flag: /\[UNTESTED\]/.test(d3.stdout), d4covered: d4.exitCode === 0 };
  const ok = got.d3flag === want.d3flag && got.d4covered === want.d4covered;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      D3: ${d3.stdout.trim()}\n      D4 exit ${d4.exitCode}: ${d4.stdout.trim()}`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${shapes.length - failed}/${shapes.length} shapes correct`);
process.exit(failed ? 1 : 0);
