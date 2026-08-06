// 报备记录所属「日期」的统一口径：
// 以每个人报备时系统生成的「报备编号」中编码的精确提交时间（北京时间）为准。
// 编号格式（server.js fmtId）：YYYYMMDDHHMMSS，前 8 位即日期 YYYY-MM-DD。
// 旧格式编号（如 ARC...，非 14 位数字）无法解析日期，回退到 createdAtStr / createdAt。
function reportDate(r) {
  const rec = r || {};
  const id = rec.id != null ? String(rec.id) : '';
  const m = /^(\d{4})(\d{2})(\d{2})\d{6}$/.exec(id); // 新格式编号 YYYYMMDDHHMMSS
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (rec.createdAtStr) return rec.createdAtStr;
  if (rec.createdAt) {
    // 北京时间（UTC+8），与 server.js cst() 一致
    const d = new Date(rec.createdAt + 8 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  return '';
}

module.exports = { reportDate };
