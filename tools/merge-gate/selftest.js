#!/usr/bin/env node
// Merge-gate self-test. Exit 1 on any regression. Sections:
//   claude  — 26 cases written by an independent adversary agent that read only the checkers (2026-09-07)
//   pod     — 64 fixtures authored blind by the pod's Qwen3-Coder model, truth table human-judged
//   shapes  — the author's own regression shapes (development aid, not independent evidence)
//   gate    — the #866 acceptance replay and the fail-closed check on the orchestrator
const { spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const here = __dirname;
let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL  ' + msg); };
const run = (file, args = [], opts = {}) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', ...opts });

// ---- claude corpus: truth table from the adversary's report ----------------------------------------------------
const CLAUDE = {
  d4: { '01': 1, '02': 1, '03': 1, '04': 1, '05': 1, '06': 1, '07': 1, '08': 1, '09': 0, '10': 0, '11': 0, '12': 0, '13': 0, '14': 0, '15': 0, '16': 0, '17': 0, '24': 1, '25': 0, '26': 0 },
  d3flag: { '01': true, '02': true, '03': true, '04': true, '05': true, '06': false, '07': true, '08': true, '09': false, '10': false, '11': false, '12': false, '13': false, '14': false, '15': false, '16': false, '17': false, '24': true, '25': false, '26': true },
  d1: { '18': 0, '19': 0, '20': 0, '21': 1, '22': 1, '23': 1 },
};
{
  const r = run(path.join(here, 'adversary', 'claude-corpus.js'));
  if (r.status !== 0) fail('claude-corpus.js crashed: ' + (r.stderr || '').slice(0, 300));
  const blocks = (r.stdout || '').split(/^===== case-/m).slice(1);
  const seen = {};
  for (const b of blocks) {
    const id = b.slice(0, 2);
    seen[id] = { d1: /^D1 exit=(\d)/m.exec(b)?.[1], d3flag: /\[UNTESTED\]/.test(b), d4: /^D4 exit=(\d)/m.exec(b)?.[1] };
  }
  for (const [id, exp] of Object.entries(CLAUDE.d4)) if (Number(seen[id]?.d4) !== exp) fail(`claude case-${id}: D4 exit ${seen[id]?.d4}, expected ${exp}`);
  for (const [id, exp] of Object.entries(CLAUDE.d3flag)) if (!!seen[id]?.d3flag !== exp) fail(`claude case-${id}: D3 flagged=${seen[id]?.d3flag}, expected ${exp}`);
  for (const [id, exp] of Object.entries(CLAUDE.d1)) if (Number(seen[id]?.d1) !== exp) fail(`claude case-${id}: D1 exit ${seen[id]?.d1}, expected ${exp}`);
  console.log(`claude corpus: ${Object.keys(seen).length} cases run`);
}

// ---- pod corpus -----------------------------------------------------------------------------------------------
{
  const expected = JSON.parse(fs.readFileSync(path.join(here, 'adversary', 'pod-corpus', 'expected.json'), 'utf8'));
  const r = run(path.join(here, 'adversary', 'pod-corpus.js'));
  if (r.status !== 0) fail('pod-corpus.js crashed: ' + (r.stderr || '').slice(0, 300));
  let n = 0;
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^(case-\d+) D3flag=(true|false) D4cov=(true|false)/.exec(line);
    if (!m) continue;
    n++;
    const e = expected[m[1]];
    if (!e) continue;
    if ((m[3] === 'true') !== e.exercised) fail(`pod ${m[1]} (${e.name}): D4 covered=${m[3]}, expected ${e.exercised}${e.judged ? ' [human-judged]' : ''}`);
    if ((m[2] === 'true') !== e.double) fail(`pod ${m[1]} (${e.name}): D3 flagged=${m[2]}, expected ${e.double}${e.judged ? ' [human-judged]' : ''}`);
  }
  console.log(`pod corpus: ${n} cases run`);
}

// ---- author shapes -------------------------------------------------------------------------------------------
{
  const r = run(path.join(here, 'adversary', 'shapes.js'));
  const m = /(\d+)\/(\d+) shapes correct/.exec(r.stdout || '');
  if (!m || m[1] !== m[2] || r.status !== 0) fail('shapes: ' + ((r.stdout || '').split('\n').filter(l => /^FAIL/.test(l)).join('; ') || 'did not run'));
  else console.log(`shapes: ${m[1]}/${m[2]}`);
}

// ---- gate acceptance: #866 replay must FAIL naming all three phantom methods; missing checkers must be ERROR --
{
  const gate = path.join(here, '..', '..', 'merge-gate.js');
  const tmp = path.join(os.tmpdir(), 'merge-gate-selftest-866');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "entrypoints": ["src/index.mjs"] }');
  fs.writeFileSync(path.join(tmp, 'src', 'db.mjs'), 'export async function query(sql, p) { return []; }\nexport default { query };\n');
  fs.writeFileSync(path.join(tmp, 'src', 'admin.mjs'), "import db from './db.mjs';\ndb.all('x');\ndb.get('y', [1]);\ndb.run('z', []);\n");
  fs.writeFileSync(path.join(tmp, 'src', 'index.mjs'), "import admin from './admin.mjs';\nexport { admin };\n");
  const r = run(gate, ['--project-dir', tmp.split(path.sep).join('/'), '--files', 'src/admin.mjs,src/db.mjs']);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 1) fail(`#866 replay: exit ${r.status}, expected 1`);
  for (const m of ['all', 'get', 'run']) if (!new RegExp(`db\\.${m} not found`).test(out)) fail(`#866 replay: db.${m} not named`);
  if (r.status === 1 && /Missing methods: all, get, run/.test(out)) console.log('gate: #866 replay rejected with all, get, run');

  const bare = path.join(os.tmpdir(), 'merge-gate-selftest-nocheckers');
  fs.rmSync(bare, { recursive: true, force: true });
  fs.mkdirSync(bare, { recursive: true });
  fs.copyFileSync(gate, path.join(bare, 'merge-gate.js'));
  const r2 = run(path.join(bare, 'merge-gate.js'), ['--project-dir', tmp.split(path.sep).join('/'), '--files', 'src/db.mjs']);
  if (r2.status !== 2) fail(`missing checkers: exit ${r2.status}, expected 2 (fail-closed)`);
  else console.log('gate: missing checkers -> ERROR exit 2');

  const r3 = run(gate, ['--project-dir', tmp.split(path.sep).join('/'), '--files', 'README.md,notes.py']);
  if (r3.status !== 0) fail(`non-JS-only change: exit ${r3.status}, expected 0`);
  else console.log('gate: non-JS-only change -> PASS (out of scope)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nselftest OK');
process.exit(failures ? 1 : 0);
