# LANE A — D2 Re-Export Resolution Defect

## Measured Defect
Given a file db.mjs:
```javascript
export { query } from './driver.mjs'
export default { query }
```

D2 currently reports:
- ✅ db.all — CORRECT (not exported, correctly rejected)
- ❌ db.query — WRONG (IS exported via re-export, should not be flagged)

## Requirement
Follow re-export chains to their origin:
- `export { x } from './y'` → resolve x from y's exports
- `export * from './y'` → include all of y's exports
- Multi-hop chains (a→b→c)
- Cycle detection

## Test Case
When a module re-exports `query` from another file, calling db.query() should NOT be flagged as missing.
