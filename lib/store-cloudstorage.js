const crypto = require('crypto');
const { uploadFile: cbUpload, downloadFile: cbDownload, getFileID } = require('./cloudbase');

const REPORTS_PATH = 'data/reports.json';
const NOTICES_PATH = 'data/notices.json';

// ---- 进程内写锁：串行化所有对共享 JSON 文件的「读-改-写」，杜绝多人同时用手机提交时互相覆盖、丢记录 ----
let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  // 某次写入异常不能卡死后续写入，catch 后让链继续
  writeChain = run.catch(() => {});
  return run;
}

// ---- 内存缓存：进程启动后从云存储加载一次，之后以内存数组为准 ----
// 这样读取不再反复读整文件，写入也只在锁内改内存再落盘，彻底消除并发覆盖与一致性问题。
let cacheReports = null;
let cacheNotices = null;
let cacheLoaded = false;
let loadPromise = null;

async function readJson(cloudPath) {
  try {
    const fileID = await getFileID(cloudPath);
    const res = await cbDownload({ fileID });
    const buf = res && res.fileContent;
    if (!buf) return null;
    const text = buf.toString('utf8');
    if (!text) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function writeJson(cloudPath, obj) {
  const buf = Buffer.from(JSON.stringify(obj, null, 2));
  await cbUpload({ cloudPath, fileContent: buf });
}

async function loadReportsRaw() {
  const arr = await readJson(REPORTS_PATH);
  return Array.isArray(arr) ? arr : [];
}
async function loadNoticesRaw() {
  const arr = await readJson(NOTICES_PATH);
  return Array.isArray(arr) ? arr : [];
}

async function ensureLoaded() {
  if (cacheLoaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      cacheReports = await loadReportsRaw();
      cacheNotices = await loadNoticesRaw();
      cacheLoaded = true;
    })();
  }
  return loadPromise;
}

// 落盘（在锁内调用，保证内存与云存储一致）
async function persistReports() {
  await writeJson(REPORTS_PATH, cacheReports || []);
}
async function persistNotices() {
  await writeJson(NOTICES_PATH, cacheNotices || []);
}

async function add(report) {
  await ensureLoaded();
  return withLock(async () => {
    cacheReports.push(report);
    await persistReports();
    return report;
  });
}

async function all() {
  await ensureLoaded();
  return cacheReports;
}

async function findById(id) {
  await ensureLoaded();
  return cacheReports.find((r) => r.id === id);
}

async function lookup({ idNumber, phone, plate, prefer }) {
  await ensureLoaded();
  const arr = cacheReports;
  const matched = arr.filter((r) => {
    const f = r.fields || {};
    const ids = [f.idNumber, f.driverIdNumber].filter(Boolean);
    const phones = [f.phone, f.driverPhone].filter(Boolean);
    const plates = [f.plate].filter(Boolean);
    return (
      (idNumber && ids.includes(idNumber)) ||
      (phone && phones.includes(phone)) ||
      (plate && plates.includes(plate))
    );
  });
  matched.sort((a, b) => b.createdAt - a.createdAt);
  if (prefer) {
    const hit = matched.filter((r) => r.type === prefer);
    const rest = matched.filter((r) => r.type !== prefer);
    return hit.concat(rest);
  }
  return matched;
}

function mergeFields(list, keys) {
  const out = {};
  for (const r of list) {
    const f = r.fields || {};
    for (const k of keys) {
      if (out[k]) continue;
      const v = f[k];
      if (v != null && String(v).trim() !== '' && !/^[0-9a-f]{20}\.(jpg|png|webp|jpeg)$/i.test(String(v))) {
        out[k] = String(v).trim();
      }
    }
  }
  return out;
}

function ownerOf(r) {
  const f = r.fields || {};
  return {
    ids: [f.idNumber, f.driverIdNumber].filter(Boolean),
    phones: [f.phone, f.driverPhone].filter(Boolean),
    name: (f.name || f.driverName || (f.driverIdNumber ? (f.name || f.driverName || '') : '')).trim(),
  };
}

async function mine({ idNumber, phone }) {
  await ensureLoaded();
  const arr = cacheReports;
  return arr.filter((r) => {
    const o = ownerOf(r);
    const idMatch = idNumber && o.ids.includes(idNumber);
    const phMatch = phone && o.phones.includes(phone);
    return idMatch && phMatch;
  });
}

async function update(id, fields) {
  await ensureLoaded();
  return withLock(async () => {
    const r = cacheReports.find((x) => x.id === id);
    if (!r) return null;
    r.fields = Object.assign({}, r.fields, fields);
    r.updatedAt = Date.now();
    await persistReports();
    return r;
  });
}

async function conflicts({ idNumber, phone, name }) {
  await ensureLoaded();
  const arr = cacheReports;
  const out = { id: [], phone: [] };
  for (const r of arr) {
    const o = ownerOf(r);
    const recName = o.name;
    if (!recName) continue;
    if (!name) continue;
    if (idNumber && o.ids.includes(idNumber) && recName !== name) out.id.push(recName);
    if (phone && o.phones.includes(phone) && recName !== name) out.phone.push(recName);
  }
  out.id = [...new Set(out.id)];
  out.phone = [...new Set(out.phone)];
  return out;
}

async function listNotices() {
  await ensureLoaded();
  return cacheNotices.filter((n) => n.active !== false);
}

async function addNotice(text, by) {
  await ensureLoaded();
  return withLock(async () => {
    const n = {
      id: crypto.randomBytes(6).toString('hex'),
      text: String(text || '').slice(0, 500),
      createdAt: Date.now(),
      by: by || 'admin',
      active: true,
    };
    cacheNotices.unshift(n);
    await persistNotices();
    return n;
  });
}

async function deleteNotice(id) {
  await ensureLoaded();
  return withLock(async () => {
    cacheNotices = cacheNotices.filter((n) => n.id !== id);
    await persistNotices();
    return cacheNotices.filter((n) => n.active !== false);
  });
}

module.exports = {
  add, all, findById, lookup, mergeFields, load: all,
  ownerOf, mine, update, conflicts,
  listNotices, addNotice, deleteNotice,
};
