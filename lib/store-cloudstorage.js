const crypto = require('crypto');
const { uploadFile: cbUpload, downloadFile: cbDownload, getFileID } = require('./cloudbase');

const REPORTS_PATH = 'data/reports.json';
const NOTICES_PATH = 'data/notices.json';

// 通过 SDK downloadFile 下载云存储中的 JSON 文件
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

async function loadReports() {
  const arr = await readJson(REPORTS_PATH);
  return Array.isArray(arr) ? arr : [];
}

async function saveReports(arr) {
  await writeJson(REPORTS_PATH, arr);
}

async function add(report) {
  const arr = await loadReports();
  arr.push(report);
  await saveReports(arr);
  return report;
}

async function all() {
  return loadReports();
}

async function findById(id) {
  const arr = await loadReports();
  return arr.find((r) => r.id === id);
}

async function lookup({ idNumber, phone, plate, prefer }) {
  const arr = await loadReports();
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
  const arr = await loadReports();
  return arr.filter((r) => {
    const o = ownerOf(r);
    const idMatch = idNumber && o.ids.includes(idNumber);
    const phMatch = phone && o.phones.includes(phone);
    return idMatch && phMatch;
  });
}

async function update(id, fields) {
  const arr = await loadReports();
  const r = arr.find((x) => x.id === id);
  if (!r) return null;
  r.fields = Object.assign({}, r.fields, fields);
  r.updatedAt = Date.now();
  await saveReports(arr);
  return r;
}

async function conflicts({ idNumber, phone, name }) {
  const arr = await loadReports();
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

async function loadNotices() {
  const arr = await readJson(NOTICES_PATH);
  return Array.isArray(arr) ? arr : [];
}

async function saveNotices(a) {
  await writeJson(NOTICES_PATH, a);
}

async function listNotices() {
  const a = await loadNotices();
  return a.filter((n) => n.active !== false);
}

async function addNotice(text, by) {
  const a = await loadNotices();
  const n = {
    id: crypto.randomBytes(6).toString('hex'),
    text: String(text || '').slice(0, 500),
    createdAt: Date.now(),
    by: by || 'admin',
    active: true,
  };
  a.unshift(n);
  await saveNotices(a);
  return n;
}

async function deleteNotice(id) {
  const a = await loadNotices();
  const next = a.filter((n) => n.id !== id);
  await saveNotices(next);
  return next.filter((n) => n.active !== false);
}

module.exports = {
  add, all, findById, lookup, mergeFields, load: all,
  ownerOf, mine, update, conflicts,
  listNotices, addNotice, deleteNotice,
};
