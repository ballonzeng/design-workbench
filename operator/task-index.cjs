'use strict';

const fs = require('node:fs/promises');
const local = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { STAGES } = require('../core/rules.cjs');
const { guarded } = require('../core/nas.cjs');
const { isTemplateFile } = require('../core/template-files.cjs');
const { parseRequirement, unpack, mergedValue, cellText, workbookTaskId } = require('../core/workbook.cjs');
const { readRatings } = require('./ratings.cjs');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const historyInterval = 15 * 60 * 1000;

async function timedRead(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label + '超时，请检查 NAS 连接或登录权限后重试')), 20000);
    })]);
  } finally { clearTimeout(timer); }
}

function taskEntry(bytes, filename, file, state, signature) {
  const parsed = parseRequirement(bytes, filename);
  parsed.ratings = readRatings(bytes, parsed.items);
  const times = parsed.templateTimes;
  const task = { ...parsed, file, signature, state, id: parseInt(digest(file).slice(0, 12), 16),
    designer: parsed.requestedDesigner, count: parsed.items.map(i => i.typeName + ' ' + i.qty).join(' · '),
    time: times.completedAt || times.reviewAt || times.startedAt || times.assignedAt || parsed.requestedAt };
  return { signature, task, workbookTaskId: parsed.workbookTaskId };
}

class TaskIndex {
  constructor(dir, settings) {
    this.settings = { ...settings };
    this.prefix = path.join(dir, 'task-index-v1-' + digest(JSON.stringify([settings.name, path.resolve(settings.root).toLowerCase()])));
    for (const kind of ['active', 'history']) {
      this[kind] = { entries: new Map(), issues: [], checkedAt: 0, savedAt: 0, job: null };
    }
    this.live = false;
    this.nextHistoryAt = 0;
    this.historyError = '';
  }
  async restore() {
    if (!this.settings.name) return;
    await Promise.all(['active', 'history'].map(async kind => {
      try {
        const data = JSON.parse(await fs.readFile(this.prefix + '-' + kind + '.json', 'utf8'));
        if (!Array.isArray(data.entries) || !Array.isArray(data.issues) || !Number.isFinite(data.checkedAt)) return;
        const entries = new Map(data.entries);
        for (const entry of entries.values()) {
          if (!entry || (entry.task && (entry.task.operator !== this.settings.name || !Array.isArray(entry.task.items)))) return;
        }
        Object.assign(this[kind], { entries, checkedAt: data.checkedAt, savedAt: data.checkedAt, issues: data.issues || [] });
      } catch { /* A missing or damaged local index is rebuilt from the workbooks. */ }
    }));
  }
  persist(kind) {
    const part = this[kind], file = this.prefix + '-' + kind + '.json', temp = file + '.tmp';
    try {
      local.writeFileSync(temp, JSON.stringify({ checkedAt: part.checkedAt, issues: part.issues, entries: [...part.entries] }));
      local.renameSync(temp, file);
      part.savedAt = Date.now();
      part.saveError = '';
    } catch {
      part.saveError = '本机缓存保存失败，下次登录可能需要重新读取';
    }
  }
  snapshot() {
    const active = [...this.active.entries.values()].filter(e => e.task).map(e => e.task);
    const key = t => t.workbookTaskId || t.filename;
    const activeKeys = new Set(active.map(key));
    const history = [...this.history.entries.values()].filter(e => e.task && !activeKeys.has(key(e.task))).map(e => e.task);
    return { settings: this.settings, tasks: active.concat(history), issues: this.active.issues.concat(this.history.issues),
      checkedAt: this.active.checkedAt, cached: !this.live, historyAt: this.history.checkedAt,
      historyBusy: !!this.history.job, historyError: this.historyError, activeError: this.activeError, cacheError: this.active.saveError || this.history.saveError };
  }
  cachedEntry(file) {
    const kind = path.basename(path.dirname(file)) === STAGES[4] ? 'history' : 'active';
    return this[kind].entries.get(digest(file));
  }
  scan(kind, force = false) {
    const part = this[kind];
    if (part.job) return part.job;
    part.job = this.read(kind, force).finally(() => {
      part.job = null;
      if (kind === 'history') this.newlyCompleted = null;
    });
    return part.job;
  }
  async read(kind, force) {
    const { root, name } = this.settings;
    const part = this[kind], entries = new Map(), issues = [];
    const stages = kind === 'history' ? [4] : [0, 1, 2, 3];
    for (const state of stages) {
      const stage = STAGES[state], dir = await timedRead(guarded(root, stage), stage + '目录检查');
      for (const e of await timedRead(fs.readdir(dir, { withFileTypes: true }), stage + '目录读取')) {
        if (this.retired) return;
        if (!e.isFile() || isTemplateFile(e.name) || !e.name.endsWith('.xlsx') || /^[.~]/.test(e.name)) continue;
        const file = await timedRead(guarded(dir, e.name), '需求路径检查'), key = digest(file);
        const previous = part.entries.get(key);
        try {
          const stat = await timedRead(fs.stat(file), '需求信息读取');
          if (stat.size > 50 * 1024 ** 2) throw Error('超过50MB，未读取');
          const signature = stat.size + ':' + stat.mtimeMs;
          let entry = previous;
          if (force || !entry || entry.signature !== signature) {
            const bytes = await timedRead(fs.readFile(file), '需求表读取');
            const wb = unpack(bytes);
            entry = cellText(mergedValue(wb.status, 'D4')) === name
              ? taskEntry(bytes, e.name, file, state, signature)
              : { signature, workbookTaskId: workbookTaskId(wb) };
          }
          entries.set(key, entry);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          if (previous?.task || e.name.split('-').at(-2)?.trim() === name)
            issues.push({ file: e.name, stage, message: err.message });
          if (previous) entries.set(key, { ...previous, signature: null });
        }
      }
    }
    if (this.retired) return;
    // A local approval can finish while history is enumerating an older directory listing.
    if (kind === 'history') {
      for (const [key, entry] of this.newlyCompleted || []) entries.set(key, entry);
      this.newlyCompleted = null;
    }
    const changed = entries.size !== part.entries.size || [...entries].some(([k, v]) => part.entries.get(k) !== v)
      || JSON.stringify(issues) !== JSON.stringify(part.issues);
    Object.assign(part, { entries, issues, checkedAt: Date.now() });
    if (kind === 'active') this.live = true;
    else this.historyError = '';
    if (changed || part.checkedAt - part.savedAt > 300000) this.persist(kind);
  }
  completed(file, bytes) {
    const key = digest(file), entry = taskEntry(bytes, path.basename(file), file, 4, null);
    this.history.entries.set(key, entry);
    if (this.history.job) {
      this.newlyCompleted ||= new Map();
      this.newlyCompleted.set(key, entry);
    }
    this.persist('history');
  }
}
module.exports = { TaskIndex, timedRead, historyInterval, digest };
