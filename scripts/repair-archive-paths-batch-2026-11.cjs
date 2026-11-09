'use strict';
// Batch migration. Preview is the default; apply requires a closed manager and
// revalidates records, files, workbooks and leases under an exclusive lease.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_PLAN = path.resolve(__dirname, '../outputs/archive-id-audit-2026-11-04/plan.json');
const key = p => path.resolve(p).toLowerCase();
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep)); };
const fail = message => { throw new Error(message); };
const validHash = h => /^[a-f0-9]{64}$/i.test(h || '');
function inspect(plan) {
  if (plan.schemaVersion !== 1 || plan.mode !== 'read-only-audit' || !plan.affectedReferencesStableAtCompletion) fail('Audit is incomplete or affected records changed');
  const root = plan.settings?.assetRoot;
  if (!root || !path.isAbsolute(root) || !Array.isArray(plan.directories)) fail('Missing asset root or directories');
  const candidates = plan.directories.filter(d => d.scope === 'ordinary-current-archive' && d.exists && d.eligibleForMigration);
  const owners = new Map(), tasks = new Map(); let files = 0, bytes = 0, identicalTargets = 0, caches = 0, unsealed = 0;
  for (const d of candidates) {
    if ((d.blockers || []).length || d.assetIds?.length !== 1 || d.uploadIds?.length !== 1 || !d.task || d.task.state !== 4) fail('Candidate has unsupported state or blockers');
    if (!inside(root, d.sourceRoot) || !inside(root, d.newCategoryPath) || key(path.dirname(d.sourceRoot)) !== key(d.newCategoryPath) || !/^任务-[a-f0-9-]{36}$/i.test(path.basename(d.sourceRoot))) fail('Candidate root is invalid');
    if (!d.task.sealed) unsealed++;
    tasks.set(d.taskId, (tasks.get(d.taskId) || 0) + 1);
    for (const f of d.files || []) {
      if (!inside(d.sourceRoot, f.source) || key(path.join(d.newCategoryPath, path.relative(d.sourceRoot, f.source))) !== key(f.target) || !Number.isSafeInteger(f.size) || f.size < 0 || !validHash(f.sha256) || !f.sourceMatchesAssetManifest) fail('File manifest or target is invalid');
      if (!['absent', 'identical'].includes(f.collision?.status)) fail('Unsafe target collision');
      if (f.collision.status === 'identical') { if (f.collision.sha256 !== f.sha256 || f.collision.size !== f.size) fail('Identical target has different content'); identicalTargets++; }
      const k = key(f.target); if (owners.has(k)) fail('Multiple candidates share a target'); owners.set(k, f.sha256); files++; bytes += f.size;
    }
    for (const f of d.systemCachesToRetain || []) {
      if (path.basename(f.source || f.path || '').toLowerCase() !== 'thumbs.db' || !inside(d.sourceRoot, f.source || f.path) || !validHash(f.sha256) || !Number.isSafeInteger(f.size) || f.copyToNewDirectory !== false) fail('Unapproved or incomplete cache entry');
      caches++;
    }
    for (const change of d.changes || []) for (const ref of change.paths || []) {
      if (!['task','asset','upload'].includes(change.kind) || !validHash(change.recordHash) || !inside(d.sourceRoot, ref.value) || key(path.join(d.newCategoryPath, path.relative(d.sourceRoot, ref.value))) !== key(ref.target)) fail('Invalid live reference');
      if (change.kind==='task' && (change.id!==d.taskId || !/^\/deliveries\/\d+\/path$/.test(ref.pointer))) fail('Unsupported task reference');
      if (change.kind==='asset' && (change.id!==d.assetIds[0] || !/^(?:\/path|\/files\/\d+\/path)$/.test(ref.pointer))) fail('Unsupported asset reference');
      if (change.kind==='upload' && (change.id!==d.uploadIds[0] || !/^(?:\/category\/(?:path|source|output)|\/published\/[^/]+)$/.test(ref.pointer))) fail('Unsupported upload reference');
    }
  }
  if (plan.summary?.eligibleOrdinaryDirectories !== candidates.length) fail('Candidate count differs from summary');
  return {mode:'offline-plan-review', candidates:candidates.length, files, bytes, identicalTargets, caches, unsealed, tasks:tasks.size, sharedTasks:[...tasks.values()].filter(n=>n>1).length, blockedOrdinary:plan.summary.manualReviewOrdinaryDirectories, rework:plan.summary.reworkHistoryDirectories, discoveryErrors:plan.discoveryErrors?.length || 0, productionWritten:false};
}
async function main(argv) {
  const options={apply:false,plan:DEFAULT_PLAN};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--apply') options.apply=true;
    else if(argv[i]==='--dry-run') options.apply=false;
    else if(argv[i]==='--plan' && argv[i+1] && path.isAbsolute(argv[i+1])) options.plan=argv[++i];
    else if(argv[i]==='--resume' && argv[i+1] && path.isAbsolute(argv[i+1])) options.resume=argv[++i];
    else fail('Usage: node scripts/repair-archive-paths-batch-2026-11.cjs [--dry-run|--apply] [--plan ABSOLUTE_PATH] [--resume ABSOLUTE_RECEIPT]');
  }
  const bytes=fs.readFileSync(options.plan),plan=JSON.parse(bytes);inspect(plan);
  const {runBatch}=require('./repair-archive-paths-batch-executor-2026-11.cjs');
  return runBatch(plan,{apply:options.apply,planPath:options.plan,planHash:crypto.createHash('sha256').update(bytes).digest('hex'),resume:options.resume});
}
module.exports = {inspect, main};
if (require.main === module) main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.stack);process.exitCode=1});
