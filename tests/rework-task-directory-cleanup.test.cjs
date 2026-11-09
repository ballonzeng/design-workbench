'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {zipSync, strToU8} = require('fflate');
const {Store} = require('../core/store.cjs');
const {Nas, guarded, fileHash, isInside} = require('../core/nas.cjs');
const {Assets} = require('../core/assets.cjs');
const {archiveIdentity} = require('../core/archive-state.cjs');
const {unpack, mergedValue} = require('../core/workbook.cjs');
const {snapshot} = require('../scripts/backfill-packaging-2026-11.cjs');

const TASK = '13ad2d49-1ff4-4402-8d57-33ee23931cf9';
const CURRENT_MAIN = '643617e8-b163-49c2-a452-109b0655724b';
const HISTORY_MAIN = '9113013e-4719-4421-8a66-2050a7de1c1a';
const CURRENT_SKU = 'b6db073d-a390-4747-92df-73bafa2793e2';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestHash = upload => sha(JSON.stringify({files: upload.files, delivery: upload.delivery}));

function workbook(addresses) {
  const esc = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const files = {
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="【状态】" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="1"><xf numFmtId="0"><protection locked="0"/></xf></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="4"><c r="L4" t="inlineStr"><is><t>' + esc(addresses) + '</t></is></c></row></sheetData></worksheet>'
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)]))));
}

async function allFiles(root) {
  const result = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, {withFileTypes: true})) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else result.push({relative: path.relative(root, full), size: (await fsp.stat(full)).size, sha256: await fileHash(full)});
    }
  }
  await visit(root);
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rework-cleanup-fixture-'));
  const assetRoot = path.join(root, 'assets');
  const taskRoot = path.join(root, 'tasks');
  const dbPath = path.join(root, 'db', 'workbench.sqlite');
  const productName = '北京同仁堂-足道二十四味泡脚粉碎型 900克(30克／包×30包／袋)-6976575152038';
  const productRoot = path.join(assetRoot, '同仁堂', productName);
  const mainCategory = path.join(productRoot, '02.主图');
  const skuCategory = path.join(productRoot, '03.SKU');
  const oldMainRoot = path.join(mainCategory, '任务-' + TASK);
  const oldSkuRoot = path.join(skuCategory, '任务-' + TASK);
  const categories = {main: mainCategory, sku: skuCategory};
  await fsp.mkdir(path.join(taskRoot, '5.已完结'), {recursive: true});
  await fsp.mkdir(path.join(taskRoot, '_workbench-system'), {recursive: true});
  const records = [];
  const dataById = new Map();
  const uploads = new Map();
  const assets = new Map();

  async function archive(id, category, round, outputCount, at, present) {
    const type = category === 'main' ? '主图' : 'SKU';
    const base = '1030-常慧杰-' + type;
    const uuidRoot = category === 'main' ? oldMainRoot : oldSkuRoot;
    const categoryRoot = round ? path.join(uuidRoot, '返工-' + round) : uuidRoot;
    const files = [];
    const bytes = new Map();
    const source = Buffer.concat([Buffer.from('8BPS'), Buffer.alloc(30, present ? (category === 'main' ? 51 : 71) : 11)]);
    bytes.set('0', source);
    files.push({id: '0', name: base + '.psd', folder: base, relativePath: base + '.psd', kind: 'source', size: source.length, sha256: sha(source), relative: base + '.psd'});
    for (let i = 1; i <= outputCount; i++) {
      const name = (category === 'main' ? '800主图' : 'SKU') + String(i).padStart(2, '0') + '.jpg';
      const content = Buffer.from([255, 216, 255, present ? 1 : 2, category === 'main' ? 3 : 4, i]);
      const fileId = String(i);
      bytes.set(fileId, content);
      files.push({id: fileId, name, folder: base, relativePath: name, kind: 'output', size: content.length, sha256: sha(content), relative: path.join(base, name)});
    }
    const delivery = {version: 1, namingVersion: 4, folder: base, directories: [{kind: 'output', relative: base}]};
    const published = Object.fromEntries(files.map(file => [file.id, path.join(categoryRoot, file.kind === 'source' ? '01.源文件' : '02.导出图片', file.relative)]));
    const upload = {id, taskId: TASK, actor: 'chang', status: 'done', storageLayout: 2, archiveRound: round, files, delivery, spec: {base, category, categoryName: type, folderUploadVersion: 2, namingVersion: 4}, product: {path: productRoot, name: productName, brand: '同仁堂'}, category: {path: categoryRoot, source: path.join(categoryRoot, '01.源文件'), output: path.join(categoryRoot, '02.导出图片')}, published, createdAt: at - 1000, completedAt: at, received: Object.fromEntries(files.map(file => [file.id, at])), maintenanceError: null};
    upload.manifestHash = manifestHash(upload);
    const asset = {id, taskId: TASK, itemId: null, itemIds: [], code: '6976575152038', product: productName, brand: '同仁堂', author: 'chang', path: categoryRoot, at, category, delivery: structuredClone(delivery), files: files.map(file => ({...file, path: published[file.id]}))};
    if (present) {
      for (const file of files) {
        await fsp.mkdir(path.dirname(published[file.id]), {recursive: true});
        await fsp.writeFile(published[file.id], bytes.get(file.id));
      }
    }
    uploads.set(id, upload);
    assets.set(id, asset);
    dataById.set(id, bytes);
    records.push(['upload', id, upload], ['asset', id, asset]);
    return {id, path: categoryRoot, category, categoryName: type, folder: base, productPath: productRoot, at};
  }

  const historicalDelivery = await archive(HISTORY_MAIN, 'main', 0, 1, 1793350344860, false);
  const currentMain = await archive(CURRENT_MAIN, 'main', 1, 2, 1793350506785, true);
  const currentSku = await archive(CURRENT_SKU, 'sku', 1, 5, 1793350530911, true);
  const cachePaths = [path.join(oldMainRoot, '01.源文件', 'Thumbs.db'), path.join(oldMainRoot, '02.导出图片', '1030-常慧杰-主图', 'Thumbs.db')];
  for (let i = 0; i < cachePaths.length; i++) {
    await fsp.mkdir(path.dirname(cachePaths[i]), {recursive: true});
    await fsp.writeFile(cachePaths[i], 'fixture-system-cache-' + i);
  }
  const bytes = workbook('主图：' + currentMain.path + '\nSKU：' + currentSku.path);
  const filename = '26103009-同仁堂-泡脚包-李航-常慧杰.xlsx';
  const workbookPath = path.join(taskRoot, '5.已完结', filename);
  await fsp.writeFile(workbookPath, bytes);
  const task = {id: TASK, filename, title: '泡脚包', brand: '同仁堂', product: productName, code: '6976575152038', owner: 'chang', operator: '李航', state: 4, sealed: false, version: 14, archiveRound: 1, requestedAt: 1793322000000, completedAt: 1793350463357, elapsedMs: 12345, runningSince: null, workbookHash: sha(bytes), deliveries: [currentMain, currentSku], items: [{id: 'row-6', row: 6, type: 'main-full', qty: 2, category: 'main', product: productName, code: '6976575152038', brand: '同仁堂', sealed: false}], deliveryHistory: [{at: 1793350400000, completedAt: historicalDelivery.at - 1000, sealedAt: historicalDelivery.at + 1, deliveries: [historicalDelivery], items: []}]};
  for (const [id, upload] of uploads) upload.taskIdentity = archiveIdentity(id === HISTORY_MAIN ? {...task, archiveRound: 0, completedAt: historicalDelivery.at - 1000} : task);
  records.push(['task', TASK, task]);
  for (let i = 0; i < 9; i++) records.push(['job', 'terminal-job-' + i, {id: 'terminal-job-' + i, kind: 'workbook', status: 'done', phase: 'published', next: structuredClone(task), source: workbookPath, dest: workbookPath, backup: workbookPath + '.fixture-backup-' + i, originalHash: task.workbookHash, nextHash: task.workbookHash}]);
  for (let i = 0; i < 12; i++) records.push(['request', 'cached-result-' + i, {result: structuredClone(task), at: 1793350600000 + i}]);
  const store = new Store(path.dirname(dbPath));
  store.put('setting', 'nas', {assetRoot, taskRoot});
  for (const [kind, id, body] of records) store.put(kind, id, body);
  store.event('archive-reopened', 'zeng', TASK, {retainedDeliveries: [CURRENT_MAIN, CURRENT_SKU]});
  store.close();
  const state = () => {
    const db = new DatabaseSync(dbPath, {readOnly: true});
    try { return snapshot(db); } finally { db.close(); }
  };
  const context = () => ({dbPath, snapshot: state(), assetRoot, taskRoot, guarded, fileHash});
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('rework-cleanup-fixture-'));
    await fsp.rm(resolved, {recursive: true, force: true});
  });
  return {root, assetRoot, taskRoot, dbPath, productRoot, categories, oldMainRoot, oldSkuRoot, workbookPath, task, uploads, assets, cachePaths, state, context};
}

function plannedBodies(job) {
  return new Map(job.records.map(record => [record.kind + '\0' + record.id, JSON.parse(record.nextBody)]));
}

async function build(f) {
  const {buildPlans} = require('../scripts/plan-rework-task-directory-cleanup-2026-11.cjs');
  return buildPlans(f.context());
}

test('the round-preserving plan accounts for all local files and retains historical evidence without writing inputs', async t => {
  const f = await fixture(t);
  const before = f.state();
  const physicalBefore = await allFiles(f.root);
  const result = await build(f);
  assert.equal(f.state().hash, before.hash);
  assert.deepEqual(await allFiles(f.root), physicalBefore);
  assert.equal(result.jobs.length, 1);
  const job = result.jobs[0];
  assert.equal(job.roots.length, 2);
  assert.equal(job.roots.flatMap(root => root.files).filter(file => file.disposition === 'copy').length, 9);
  assert.equal(job.roots.flatMap(root => root.files).filter(file => file.disposition === 'cache').length, 2);
  assert.equal(job.transfers.length, 9);
  assert.equal(job.missing.length, 2);
  assert.equal(job.records.length, 7);
  assert.deepEqual(job.sidecars, []);
  assert.equal(job.workbooks.length, 1);
  assert.equal(job.workbooks[0].path, f.workbookPath);
  assert.equal(job.workbooks[0].sha256, f.task.workbookHash);
  assert.deepEqual(new Set(job.records.map(r => r.kind)), new Set(['task', 'asset', 'upload']));
  for (const record of job.records) assert.equal(record.originalBody, before.records.find(old => old.kind === record.kind && old.id === record.id).body);
  const next = plannedBodies(job);
  const task = next.get('task\0' + TASK);
  const sourceWorkbook = await fsp.readFile(f.workbookPath);
  const oldAddress = String(mergedValue(unpack(sourceWorkbook).status, 'L4'));
  const newAddress = job.workbooks[0].replacements.reduce((text, replacement) => text.split(replacement.from).join(replacement.to), oldAddress);
  const {deterministicWorkbookPatch} = require('../scripts/plan-rework-task-directory-cleanup-2026-11.cjs');
  const patchedWorkbook = deterministicWorkbookPatch(sourceWorkbook, {L4: newAddress});
  assert.equal(sha(patchedWorkbook), task.workbookHash);
  assert.equal(String(mergedValue(unpack(patchedWorkbook).status, 'L4')), newAddress);
  assert(newAddress.includes(path.join(f.categories.main, '返工-1')));
  assert(newAddress.includes(path.join(f.categories.sku, '返工-1')));
  assert.equal(newAddress.includes('任务-' + TASK), false);
  for (const key of ['id', 'state', 'sealed', 'version', 'archiveRound', 'owner', 'requestedAt', 'completedAt', 'elapsedMs', 'runningSince', 'items']) assert.deepEqual(task[key], f.task[key], 'task business field changed: ' + key);
  assert.deepEqual(task.deliveries.map(d => d.id), [CURRENT_MAIN, CURRENT_SKU]);
  assert.equal(task.deliveries[0].path, path.join(f.categories.main, '返工-1'));
  assert.equal(task.deliveries[1].path, path.join(f.categories.sku, '返工-1'));
  assert.equal(task.deliveryHistory[0].deliveries[0].path, f.categories.main);
  for (const id of [CURRENT_MAIN, CURRENT_SKU, HISTORY_MAIN]) {
    const original = f.uploads.get(id), upload = next.get('upload\0' + id), asset = next.get('asset\0' + id);
    assert.equal(upload.storageLayout, 3);
    assert.equal(upload.archiveRound, original.archiveRound);
    assert.equal(upload.status, 'done');
    assert.equal(upload.taskIdentity, original.taskIdentity);
    assert.equal(upload.manifestHash, manifestHash(upload));
    assert.equal(asset.missingAt, undefined);
    assert.equal(upload.missingAt, undefined);
    assert.deepEqual(asset.delivery, upload.delivery);
    assert.deepEqual(asset.files.map(file => file.relative), upload.files.map(file => file.relative));
    assert.deepEqual(asset.files.map(file => file.path), upload.files.map(file => upload.published[file.id]));
    for (const file of upload.files) {
      const previous = original.files.find(old => old.id === file.id);
      for (const key of ['id', 'name', 'kind', 'size', 'sha256']) assert.equal(file[key], previous[key]);
      if (id !== HISTORY_MAIN) assert.equal(file.relative, previous.relative);
    }
  }
  const old = next.get('upload\0' + HISTORY_MAIN);
  const batch = old.spec.base + '-165224-历史';
  assert.equal(old.files[0].relative, path.join(batch, old.files[0].name));
  assert.equal(old.files[1].relative, path.join(batch, old.files[1].name));
  assert(old.delivery.directories.some(d => d.kind === 'source' && d.relative === batch));
  assert(old.delivery.directories.some(d => d.kind === 'output' && d.relative === batch));
  assert.equal(old.category.path, f.categories.main);
  for (const missing of job.missing) {
    const original = f.uploads.get(HISTORY_MAIN).files.find(file => file.sha256 === missing.sha256);
    assert(original, 'missing item lost its original expected hash');
    assert.equal(missing.expectedSize, original.size);
    assert.equal(missing.preExisting, true);
    assert.equal(missing.archiveRound, 0);
    assert.equal(missing.assetId, HISTORY_MAIN);
    assert.equal(fs.existsSync(missing.oldPath), false);
    assert.equal(fs.existsSync(missing.target), false);
  }
});

test('changed current bytes, target collisions, reappeared history and unfinished journals block the plan', async t => {
  for (const cause of ['changed-current', 'target-collision', 'history-reappeared', 'unfinished-job']) {
    const f = await fixture(t);
    if (cause === 'changed-current') await fsp.writeFile(f.uploads.get(CURRENT_MAIN).published['0'], 'changed source bytes');
    if (cause === 'target-collision') {
      const destination = path.join(f.categories.main, '返工-1', '01.源文件', f.uploads.get(CURRENT_MAIN).files[0].relative);
      await fsp.mkdir(path.dirname(destination), {recursive: true});
      await fsp.writeFile(destination, 'another delivery');
    }
    if (cause === 'history-reappeared') {
      const historical = f.uploads.get(HISTORY_MAIN).published['0'];
      await fsp.mkdir(path.dirname(historical), {recursive: true});
      await fsp.writeFile(historical, 'historical bytes require a fresh review');
    }
    if (cause === 'unfinished-job') {
      const db = new DatabaseSync(f.dbPath);
      try {
        const row = db.prepare("SELECT body FROM records WHERE kind='job' AND id='terminal-job-0'").get();
        const next = {...JSON.parse(row.body), status: 'prepared'};
        db.prepare("UPDATE records SET body=? WHERE kind='job' AND id='terminal-job-0'").run(JSON.stringify(next));
      } finally { db.close(); }
    }
    const before = f.state(), filesBefore = await allFiles(f.root);
    await assert.rejects(build(f), cause);
    assert.equal(f.state().hash, before.hash, cause + ' wrote database records');
    assert.deepEqual(await allFiles(f.root), filesBefore, cause + ' wrote source or target files');
  }
});

test('the projected current rounds resolve, publish and finalize through the real Assets implementation', async t => {
  const f = await fixture(t);
  const result = await build(f), job = result.jobs[0], before = f.state();
  for (const transfer of job.transfers) {
    assert(isInside(f.root, transfer.source) && isInside(f.root, transfer.target));
    await fsp.mkdir(path.dirname(transfer.target), {recursive: true});
    await fsp.copyFile(transfer.source, transfer.target, fs.constants.COPYFILE_EXCL);
  }
  const db = new DatabaseSync(f.dbPath);
  try {
    const update = db.prepare('UPDATE records SET body=? WHERE kind=? AND id=? AND body=?');
    for (const record of job.records) assert.equal(update.run(record.nextBody, record.kind, record.id, record.originalBody).changes, 1);
  } finally { db.close(); }
  const projected = f.state();
  assert.deepEqual(projected.events, before.events);
  assert.deepEqual(projected.versions, before.versions);
  assert.deepEqual(projected.records.filter(r => ['job', 'request'].includes(r.kind)), before.records.filter(r => ['job', 'request'].includes(r.kind)));
  const store = new Store(path.dirname(f.dbPath)), nas = new Nas(store);
  nas.config = {assetRoot: f.assetRoot, taskRoot: f.taskRoot};
  const assets = new Assets(store, nas);
  try {
    const task = store.get('task', TASK);
    for (const id of [CURRENT_MAIN, CURRENT_SKU]) {
      const upload = store.get('upload', id);
      const item = {...task.items[0], category: upload.spec.category};
      const category = await assets.resolveUploadCategory(upload, task, upload.product, item, true, {create: false});
      assert.equal(category.path, path.join(f.categories[upload.spec.category], '返工-1'));
      const publication = await assets.publicationPlan(upload, category);
      assert.deepEqual(publication.map(p => p.dest), upload.files.map(file => upload.published[file.id]));
      await assets.finalizeDelivery(upload, task, task.deliveries.find(delivery => delivery.id === id));
      const finalized = store.get('asset', id);
      assert.deepEqual(finalized.files.map(file => file.path), upload.files.map(file => upload.published[file.id]));
      assert.deepEqual(finalized.files.map(file => file.relative), upload.files.map(file => file.relative));
      assert.deepEqual(finalized.delivery, upload.delivery);
    }
    const historical = store.get('upload', HISTORY_MAIN);
    const shadow = {...task, archiveRound: 0, deliveries: task.deliveryHistory[0].deliveries};
    const oldCategory = await assets.resolveUploadCategory(historical, shadow, historical.product, {...task.items[0], category: 'main'}, true, {create: false});
    assert.equal(oldCategory.path, f.categories.main);
    for (const file of historical.files) {
      const expected = path.join(file.kind === 'source' ? oldCategory.source : oldCategory.output, file.relative);
      assert.equal(historical.published[file.id], expected);
      assert.equal(fs.existsSync(expected), false, 'historical bytes must not be fabricated');
    }
    await assert.rejects(assets.publicationPlan(historical, oldCategory), /暂存文件缺失|校验失败/);
    const historicalBeforeRecovery = JSON.stringify(store.get('asset', HISTORY_MAIN));
    const current = store.get('upload', CURRENT_MAIN);
    store.put('upload', current.id, {...current, maintenanceError: 'fixture forces current-round finalization'});
    await assets.recover();
    assert.equal(JSON.stringify(store.get('asset', HISTORY_MAIN)), historicalBeforeRecovery);
    assert.equal(store.get('upload', CURRENT_MAIN).maintenanceError, null);
    assert.equal(store.get('task', TASK).sealed, false);
    assert.equal(store.get('task', TASK).archiveRound, 1);
  } finally { store.close(); }
});
