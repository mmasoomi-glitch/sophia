// 64 fixtures authored blind by the pod's Qwen3-Coder model (2026-09-07) against D3/D4. Prints one line per case.
const fs = require('fs'), path = require('path'), os = require('os');
const { checkSelfMocking } = require('../d3-checker.js');
const { checkRealDependencyCoverage } = require('../d4-checker.js');
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'pod-corpus', 'fixtures.json'), 'utf8'));
const ROOT = path.join(os.tmpdir(), 'merge-gate-adv-pod');
fs.rmSync(ROOT, { recursive: true, force: true });
fx.forEach((f, i) => {
  const id = 'case-' + String(i + 1).padStart(2, '0');
  const dir = path.join(ROOT, id);
  for (const [rel, content] of Object.entries(f.files || {})) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const pd = dir.split(path.sep).join('/');
  const d3 = checkSelfMocking(pd, f.changed);
  const d4 = checkRealDependencyCoverage(pd, f.changed);
  console.log(`${id} D3flag=${/\[UNTESTED\]/.test(d3.stdout)} D4cov=${d4.exitCode === 0} | ${f.name} | ${d4.stdout.trim().split('\n')[0].slice(0, 100)}`);
});
