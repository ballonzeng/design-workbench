'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { STAGES } = require('../core/rules.cjs');
const { OperatorStore } = require('../operator/store.cjs');
const { workbook } = require('../operator/test-fixture.cjs');
const { patchBarcode } = require('../core/workbook.cjs');

const name = '王燕', filename = '26090311-九芝堂-西红花-王燕-洪华.xlsx';
const historyName = filename.replace('西红花', '另一份');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'operator-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'nas'), profile = path.join(dir, 'profile');
  for (const stage of STAGES) await fs.mkdir(path.join(root, stage), { recursive: true });
  const active = path.join(root, STAGES[3], filename), history = path.join(root, STAGES[4], historyName);
  await fs.writeFile(active, workbook());
  await fs.writeFile(history, workbook());
  const store = await new OperatorStore(profile).init();
  return { root, profile, active, history, store };
}

test('first binding returns active cards before history; ordinary polling never opens completed directories', async t => {
  const { store, root, history } = await fixture(t);
  const readdir = fs.readdir, dirs = [];
  t.mock.method(fs, 'readdir', (dir,...args) => { dirs.push(dir); return readdir(dir,...args); });
  const first = await store.configure({ root, name });
  assert.deepEqual(first.tasks.map(t => t.state), [3]);
  assert.equal(first.historyAt, 0);
  await store.scan();
  assert.ok(!dirs.includes(path.dirname(history)));
  const all = await store.scan('history');
  assert.deepEqual(all.tasks.map(t => t.state), [3,4]);
  assert.ok(all.historyAt);
});

test('restart and same binding restore local cards offline, then unchanged workbooks require zero content reads', async t => {
  const { store, root, profile } = await fixture(t);
  await store.configure({ root, name });
  const before = await store.scan('history');
  await fs.rename(root, root + '-offline');
  const restored = await new OperatorStore(profile).init();
  const cached = await restored.bind({ root, name });
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.tasks, before.tasks);
  await assert.rejects(restored.scan());
  assert.deepEqual(restored.snapshot().tasks, before.tasks);
  await fs.rename(root + '-offline', root);
  const read = fs.readFile, reads = [];
  t.mock.method(fs, 'readFile', (file,...args) => { if (file.endsWith('.xlsx')) reads.push(file); return read(file,...args); });
  assert.equal((await restored.scan()).cached, false);
  await restored.scan('history');
  assert.deepEqual(reads, []);
});

test('manual history rereads original, reflects corrections and removes deleted or rolled-back entries', async t => {
  const { store, root, history, active } = await fixture(t);
  await store.configure({ root, name });
  await store.scan('history');
  const corrected = '6970855224164';
  await fs.writeFile(history, patchBarcode(await fs.readFile(history), corrected));
  const seen = [], read = fs.readFile;
  t.mock.method(fs, 'readFile', (file,...args) => { if(file.endsWith('.xlsx')) seen.push(file);return read(file,...args); });
  assert.equal((await store.scan('history', true)).tasks.find(t => t.state === 4).code, corrected);
  await store.scan('history', true);
  assert.deepEqual(seen, [history,history]);
  const rolledBack = path.join(path.dirname(active), historyName);
  await fs.rename(history, rolledBack);
  assert.deepEqual((await store.scan()).tasks.map(t => t.state), [3,3]);
  await fs.unlink(rolledBack);
  await store.scan('history');
  assert.deepEqual((await store.scan()).tasks.map(t => t.state), [3]);
});

test('blocked history allows active refresh and cannot publish data into another binding', async t => {
  const { store, root, history, profile } = await fixture(t);
  await store.configure({ root, name });
  const read = fs.readFile;
  let started, release;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs, 'readFile', async (file,...args) => {
    if (file === history) { started(); await gate; }
    return read(file,...args);
  });
  const pending = store.scan('history');
  try {
    await waiting;
    assert.equal((await store.scan()).tasks[0].operator, name);
    const next = await store.configure({ name:'其他运营',root });
    assert.deepEqual(next.tasks, []);
  } finally { release(); }
  assert.deepEqual((await pending).tasks, []);
  const restarted = await new OperatorStore(profile).init();
  assert.deepEqual(restarted.snapshot().tasks, []);
  const secondRoot = path.join(root, 'other');
  for (const stage of STAGES) await fs.mkdir(path.join(secondRoot, stage), { recursive:true });
  assert.deepEqual((await store.bind({name,root:secondRoot})).tasks, []);
  assert.equal((await store.bind({name,root})).tasks.length, 1);
});

test('history folder error keeps last completed snapshot; retry and corrupt local index recover', async t => {
  const { store, root, profile, history } = await fixture(t);
  await store.configure({ name,root });
  const before = await store.scan('history');
  const dir = path.dirname(history);
  await fs.rename(dir,dir + '-offline');
  await assert.rejects(store.scan('history', true));
  assert.deepEqual(store.snapshot().tasks, before.tasks);
  await fs.rename(dir + '-offline',dir);
  await fs.writeFile(store.index.prefix + '-history.json', '{');
  const restored = await new OperatorStore(profile).init();
  assert.deepEqual(restored.snapshot().tasks.map(t => t.state), [3]);
  assert.deepEqual((await restored.scan('history')).tasks.map(t => t.state), [3,4]);
});

test('approval during history scan immediately shows completed task and keeps it after older scan ends', async t => {
  const { store, root, history } = await fixture(t);
  const { tasks:[task] } = await store.configure({ name,root });
  const read = fs.readFile;
  let started, release;
  const waiting = new Promise(resolve => {started=resolve;});
  const gate = new Promise(resolve => {release=resolve;});
  t.mock.method(fs,'readFile', async (file,...args) => {
    if(file===history){started();await gate;}
    return read(file,...args);
  });
  const pending = store.scan('history');
  try{
    await waiting;
    const approved = await store.approve(task.id,'2026-09-04','12:00',{quality:[{row:6,value:100}],timeliness:'满意'});
    assert.deepEqual(approved.tasks.map(t=>[t.filename,t.state]),[[filename,4]]);
  }finally{release();}
  assert.deepEqual((await pending).tasks.map(t=>t.state),[4,4]);
});
