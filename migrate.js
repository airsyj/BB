// 一次性迁移脚本：把本地 data/ 下的历史报备与通知推送到云端实例
// 用法：node migrate.js <云端基地址> [管理员token]
//   例：node migrate.js https://xxx.ap-shanghai.run.tcloudbase.com myAdminToken
// 说明：云端会按“导入时刻”重新生成编号与时间，仅用于把历史信息带上去，
//       自动续期检索按身份证/手机号/车牌匹配，不受时间影响。

const httpMod = require('http');
const httpsMod = require('https');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/$/, '');
const TOKEN = process.argv[3] || process.env.ADMIN_TOKEN || '';
if (!BASE) {
  console.error('用法: node migrate.js <云端基地址> [管理员token]');
  process.exit(1);
}

const DATA = path.join(__dirname, 'data');
const reports = JSON.parse(fs.readFileSync(path.join(DATA, 'reports.json'), 'utf8'));
const notices = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'notices.json'), 'utf8')); }
  catch (e) { return []; }
})();

function post(pathname, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(BASE + pathname);
    const mod = u.protocol === 'https:' ? httpsMod : httpMod;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (token ? `?token=${encodeURIComponent(token)}` : ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ code: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let ok = 0, fail = 0;
  for (const r of reports) {
    try {
      const res = await post('/api/report', {
        type: r.type,
        isRenewal: !!r.isRenewal,
        fields: r.fields,
        passExpiry: r.passExpiry || '',
      });
      if (res.code === 200) ok++;
      else { fail++; console.error('报备失败', r.id, res.body); }
    } catch (e) { fail++; console.error('报备异常', r.id, e.message); }
  }
  for (const n of notices) {
    if (n.active === false) continue;
    try { await post('/api/notices', { text: n.text }, TOKEN); }
    catch (e) { console.error('通知失败', e.message); }
  }
  console.log(`迁移完成：报备成功 ${ok}，失败 ${fail}；通知 ${notices.filter((x) => x.active !== false).length} 条已尝试推送`);
})();
