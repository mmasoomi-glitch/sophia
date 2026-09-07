const fs = require('fs'), path = require('path');
const ROOT = path.join(require('os').tmpdir(), 'merge-gate-adv-claude');
const G = path.join(__dirname, '..') + path.sep;
const { checkReachability } = require(G + 'd1-checker.js');
const { checkSelfMocking } = require(G + 'd3-checker.js');
const { checkRealDependencyCoverage } = require(G + 'd4-checker.js');

const DB_MJS = "export function query(sql){return 'real:'+sql}\nexport function connect(){return 'conn'}\n";
const DB_JS  = "function query(sql){return 'real:'+sql}\nfunction connect(){return 'conn'}\nmodule.exports={query,connect};\n";
const PKG = JSON.stringify({ name: 'x', type: 'module', main: 'src/index.mjs' });
const PKG_CJS = JSON.stringify({ name: 'x', main: 'src/index.js' });

const cases = {
 '01': { changed: ['src/db.js'], run: 'd3d4', files: {
   'package.json': PKG_CJS, 'src/index.js': "require('./db.js');", 'src/db.js': DB_JS,
   'test/db.test.js': "const db = require('../src/db.js');\ndb.query = () => 'fake';\ndb.connect = () => 'fake';\nconsole.assert(db.query('x') === 'fake');\n" }},
 '02': { changed: ['src/db.js'], run: 'd3d4', files: {
   'package.json': PKG_CJS, 'src/index.js': "require('./db.js');", 'src/db.js': DB_JS,
   'test/db.test.js': "require.cache[require.resolve('../src/db.js')] = { id: 'x', loaded: true, exports: { query: () => 'fake', connect: () => 'fake' } };\nconst db = require('../src/db.js');\nconsole.assert(db.query('x') === 'fake');\n" }},
 '03': { changed: ['src/db.js'], run: 'd3d4', files: {
   'package.json': JSON.stringify({name:'x',main:'src/index.js',jest:{setupFiles:['<rootDir>/jest.setup.js']}}),
   'jest.setup.js': "jest.mock('./src/db.js', () => ({ query: () => 'fake', connect: () => 'fake' }));\n",
   'src/index.js': "require('./db.js');", 'src/db.js': DB_JS,
   'test/db.test.js': "const db = require('../src/db.js');\ntest('q', () => { expect(db.query('x')).toBe('fake'); });\n" }},
 '04': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import { vi, test, expect } from 'vitest';\nimport * as db from '../src/db.mjs';\nvi.mock(import('../src/db.mjs'), () => ({ query: () => 'fake', connect: () => 'fake' }));\ntest('q', () => { expect(db.query('x')).toBe('fake'); });\n" }},
 '05': { changed: ['src/db.js'], run: 'd3d4', files: {
   'package.json': PKG_CJS, 'src/index.js': "require('./db.js');", 'src/db.js': DB_JS,
   'test/a.test.js': "const { mock, test } = require('node:test');\nconst db = require('../src/db.js');\nmock.method(db, 'query', () => 'fake');\ntest('q', () => { console.assert(db.query('x') === 'fake'); });\n",
   'test/b.test.js': "const sinon = require('sinon');\nconst db = require('../src/db.js');\nsinon.stub(db);\ndb.query.returns('fake');\nconsole.assert(db.query('x') === 'fake');\n" }},
 '06': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import db from '../src/db.mjs';\n// db.query('x') is covered by the integration suite\nconst note = \"db.connect() is slow\";\nconsole.assert(typeof db === 'object');\n" }},
 '07': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "let db = await import('../src/db.mjs');\ndb = { query: () => 'fake', connect: () => 'fake' };\nconsole.assert(db.query('x') === 'fake');\n" }},
 '08': { changed: ['src/db.mjs','src/service.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './service.mjs';", 'src/db.mjs': DB_MJS,
   'src/service.mjs': "import { query } from './db.mjs';\nexport function getUser(id){ return query('select '+id) }\n",
   'test/service.test.mjs': "import esmock from 'esmock';\nconst svc = await esmock('../src/service.mjs', { '../src/db.mjs': { query: () => 'fake', connect: () => 'fake' } });\nconsole.assert(svc.getUser(1) === 'fake');\n" }},
 '09': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "export * from './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import { query, connect } from '../src/index.mjs';\nconsole.assert(query('x') === 'real:x');\nconsole.assert(connect() === 'conn');\n" }},
 '10': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/helpers/run-db.mjs': "import * as db from '../../src/db.mjs';\nexport function runAll(){ return { query: db.query('x'), connect: db.connect() } }\n",
   'test/repo.test.mjs': "import { runAll } from './helpers/run-db.mjs';\nconst expected = { query: 'real:x', connect: 'conn' };\nconsole.assert(JSON.stringify(runAll()) === JSON.stringify(expected));\n" }},
 '11': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "export function run(){ return import('../src/db.mjs').then(m => { console.assert(m.query('x') === 'real:x'); }); }\nawait run();\n" }},
 '12': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': "export default { query(sql){return 'real:'+sql}, connect(){return 'conn'} };\n",
   'test/db.test.mjs': "import db from '../src/db.mjs';\nconst { query, connect } = db;\nconsole.assert(query('x') === 'real:x');\nconsole.assert(connect() === 'conn');\n" }},
 '13': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': "export default { query(sql){return 'real:'+sql}, connect(){return 'conn'} };\n",
   'test/db.test.mjs': "import db from '../src/db.mjs';\nconsole.assert(db.query.call(db, 'x') === 'real:x');\nconsole.assert(db.connect.apply(db, []) === 'conn');\nconsole.assert(db?.query('y') === 'real:y');\nconsole.assert(db['query']('z') === 'real:z');\n" }},
 '14': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': "export default class Db { query(sql){return 'real:'+sql} connect(){return 'conn'} }\n",
   'test/db.test.mjs': "import Db from '../src/db.mjs';\nclass TestDb extends Db { connect(){ return 'test-'+super.connect() } }\nconst d = new TestDb();\nconsole.assert(d.query('x') === 'real:x');\n" }},
 '15': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'src/db_spec.mjs': "import * as db from './db.mjs';\nconsole.assert(db.query('x') === 'real:x');\n",
   'e2e/db.e2e.mjs': "import * as db from '../src/db.mjs';\nconsole.assert(db.connect() === 'conn');\n",
   'dbTest.mjs': "import { query } from './src/db.mjs';\nconsole.assert(query('x') === 'real:x');\n" }},
 '16': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import { query } from '../src/db.mjs';\nconst out = ['a','b'].map(query);\nconsole.assert(out[0] === 'real:a');\nconst results = await Promise.all(['c'].map(query));\nconsole.assert(results[0] === 'real:c');\n" }},
 '17': { changed: ['src/db.cjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.cjs';", 'src/db.cjs': DB_JS,
   'test/db.test.mjs': "import * as ns from '../src/db.cjs';\nconsole.assert(ns.default.query('x') === 'real:x');\nconsole.assert(ns.default.connect() === 'conn');\n" }},
 '18': { changed: ['src/deep/a/b/db.mjs','src/api.mjs'], run: 'd1', files: {
   'package.json': PKG, 'src/index.mjs': "export * from './api.mjs';\nexport { query as q } from './deep/a/b/db.mjs';\n",
   'src/api.mjs': "export { connect } from './deep/a/b/db.mjs';\n", 'src/deep/a/b/db.mjs': DB_MJS }},
 '19': { changed: ['src/lib/index.cjs','src/db.cjs'], run: 'd1', files: {
   'package.json': PKG_CJS, 'src/index.js': "const lib = require('./lib');\nconst db = require('./db');\n",
   'src/lib/index.cjs': "module.exports = {};\n", 'src/db.cjs': DB_JS }},
 '20': { changed: ['src/index.mjs','src/db.mjs','src/util.mjs'], run: 'd1', files: {
   'merge-gate.config.json': JSON.stringify({ entrypoints: ['./src/index.mjs'] }),
   'src/index.mjs': "import{query}from'./db.mjs';\nimport * as u from './util.mjs';\n", 'src/db.mjs': DB_MJS, 'src/util.mjs': "export const x = 1;\n" }},
 '21': { changed: ['src/legacy.js'], run: 'd1', files: {
   'package.json': PKG_CJS, 'src/index.js': "// TODO: bring back require('./legacy.js') once ported\nconst s = \"import x from './legacy.js'\";\nmodule.exports = {};\n",
   'src/legacy.js': "module.exports = 1;\n" }},
 '22': { changed: ['src\\db.mjs','src\\worker.mjs','manifest.json','src/plugin.mjs'], run: 'd1', files: {
   'merge-gate.config.json': JSON.stringify({ entrypoints: ['src/index.mjs'] }),
   'package.json': JSON.stringify({ name:'x', type:'module', main:'src/other.mjs', entrypoints:['src/other.mjs'] }),
   'src/index.mjs': "import './db.mjs';\n", 'src/other.mjs': "import './worker.mjs';\n",
   'src/db.mjs': DB_MJS, 'src/worker.mjs': "export const w = 1;\n",
   'manifest.json': JSON.stringify({ plugin: './src/plugin.mjs' }), 'src/plugin.mjs': "export const p = 1;\n" }},
 '23': { changed: ['src/db.js','src/plugins/p1.mjs','src/html-only.mjs'], run: 'd1', files: {
   'merge-gate.config.json': JSON.stringify({ entrypoints: ['src/index.mjs','index.html'] }),
   'src/index.mjs': "const p = require.resolve('./db.js');\nconst name = 'p1';\nexport const load = () => import(`./plugins/${name}.mjs`);\n",
   'src/db.js': DB_JS, 'src/plugins/p1.mjs': "export const p = 1;\n",
   'index.html': "<script type=\"module\">import './src/html-only.mjs';</script>\n", 'src/html-only.mjs': "export const h = 1;\n" }},
 '24': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import * as real from '../src/db.mjs';\nconst db = new Proxy(real, { get: () => () => 'fake' });\nconsole.assert(db.query('x') === 'fake');\nconsole.assert(typeof real.query === 'function');\n" }},
 '25': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import { query as runQuery, connect as open } from '../src/db.mjs';\nconst r = runQuery('x');\nconsole.assert(r === 'real:x');\nconsole.assert(open() === 'conn');\n" }},
 '26': { changed: ['src/db.mjs'], run: 'd3d4', files: {
   'package.json': PKG, 'src/index.mjs': "import './db.mjs';", 'src/db.mjs': DB_MJS,
   'test/db.test.mjs': "import * as db from '../src/db.mjs';\nimport { jest } from '@jest/globals';\nconst SPEC = '../src/db.mjs';\njest.unstable_mockModule(SPEC, () => ({ query: () => 'fake', connect: () => 'fake' }));\nconsole.assert(db.query('x') === 'fake');\n" }},
};

for (const [id, c] of Object.entries(cases)) {
  const dir = path.join(ROOT, 'case-' + id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(c.files)) {
    const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content);
  }
  const pd = dir.split(path.sep).join('/');
  console.log('===== case-' + id + ' changed=' + JSON.stringify(c.changed));
  if (c.run === 'd1') { const r = checkReachability(pd, c.changed); console.log('D1 exit=' + r.exitCode + '\n' + r.stdout.trimEnd()); }
  else {
    const r3 = checkSelfMocking(pd, c.changed); console.log('D3 exit=' + r3.exitCode + '\n' + r3.stdout.trimEnd());
    const r4 = checkRealDependencyCoverage(pd, c.changed); console.log('D4 exit=' + r4.exitCode + '\n' + r4.stdout.trimEnd());
  }
}
