const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据目录：本地默认 data/；云托管(CFS 挂载)时通过环境变量 DATA_DIR 指向挂载点，保证持久化
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'reports.json');
const NOTICES_FILE = path.join(DATA_DIR, 'notices.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
}

function load() {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}

function save(arr) {
  ensure();
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
}

function add(report) {
  const arr = load();
  arr.push(report);
  save(arr);
  return report;
}

function all() {
  return load();
}

function findById(id) {
  return load().find((r) => r.id === id);
}

// 查询：按身份证号或手机号查找历史记录（手机号覆盖报备手机号与驾驶员电话）
// prefer 可传 'vehicle' 等类型，命中该类型的记录会排在前面
function lookup({ idNumber, phone, plate, prefer }) {
  const arr = load();
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

// 从一组历史记录中「逐字段」取最近一次的非空值，尽可能补全信息
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

// 记录归属信息（用于“我的报备”与重名冲突检测）
function ownerOf(r) {
  const f = r.fields || {};
  return {
    ids: [f.idNumber, f.driverIdNumber].filter(Boolean),
    phones: [f.phone, f.driverPhone].filter(Boolean),
    name: (f.name || f.driverName || (f.driverIdNumber ? (f.name || f.driverName || '') : '')).trim(),
  };
}

// 查询“我的报备”：需同时匹配身份证号与手机号，确保只看得到自己的
function mine({ idNumber, phone }) {
  const arr = load();
  return arr.filter((r) => {
    const o = ownerOf(r);
    const idMatch = idNumber && o.ids.includes(idNumber);
    const phMatch = phone && o.phones.includes(phone);
    return idMatch && phMatch;
  });
}

// 仅更新字段，保留 id/type/createdAt；调用方需先校验归属
function update(id, fields) {
  const arr = load();
  const r = arr.find((x) => x.id === id);
  if (!r) return null;
  r.fields = Object.assign({}, r.fields, fields);
  r.updatedAt = Date.now();
  save(arr);
  return r;
}

// 重名/重号冲突检测：返回与「当前填写姓名」不同的、却使用相同身份证号/手机号的其他人
// 仅当 name 与对方姓名都非空且不同才判定为冲突，避免误报（如本人尚未填写姓名）
function conflicts({ idNumber, phone, name }) {
  const arr = load();
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

// ---- 通知（超级管理员发布，首页醒目展示） ----
function loadNotices() {
  try { return JSON.parse(fs.readFileSync(NOTICES_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveNotices(a) { fs.writeFileSync(NOTICES_FILE, JSON.stringify(a, null, 2)); }
function listNotices() { return loadNotices().filter((n) => n.active !== false); }
function addNotice(text, by) {
  const a = loadNotices();
  const n = {
    id: crypto.randomBytes(6).toString('hex'),
    text: String(text || '').toString().slice(0, 500),
    createdAt: Date.now(),
    by: by || 'admin',
    active: true,
  };
  a.unshift(n);
  saveNotices(a);
  return n;
}
function deleteNotice(id) {
  const a = loadNotices();
  const next = a.filter((n) => n.id !== id);
  saveNotices(next);
  return next;
}

module.exports = {
  add, all, findById, lookup, mergeFields, load,
  ownerOf, mine, update, conflicts,
  listNotices, addNotice, deleteNotice,
};
