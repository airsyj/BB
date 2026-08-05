const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'reports.json');

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

module.exports = { add, all, findById, lookup, mergeFields, load };
