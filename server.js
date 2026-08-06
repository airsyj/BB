const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const store = require('./lib/store');
const ocr = require('./lib/ocr');
const { recognize, PROMPTS } = require('./lib/llm-ocr');
const exporter = require('./lib/export');
const storage = require('./lib/storage');
const ExcelJS = require('exceljs');

// ---- 进程级稳定性保护 ----
// 任何未捕获的同步异常 / 未处理的 Promise 拒绝，只记录、不让整个进程退出。
// 这样偶发的第三方接口抖动、客户端中途断开等都不会把服务搞崩，云端也能持续响应。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && (reason.stack || reason.message)) || reason);
});

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 40 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

// 统一使用北京时间（UTC+8），避免云托管容器默认 UTC 时区导致日期错位（影响按日期导出/我的报备）
function cst(ts) { return new Date(ts + 8 * 3600 * 1000); }
function fmtDate(ts) {
  const d = cst(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// 报备编号：按生成时的北京时间 年月日时分秒 生成（如 20260805210654）
function fmtId(ts) {
  const d = cst(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function adminOk(url) {
  const t = url.searchParams.get('token');
  return t && t === config.adminToken;
}

// ---- 批量导入：解析 xlsx 中 人员信息 / 司机信息 / 物资进场明细 / 物资出场明细 四张表 ----
// 列序映射与 export.js 表头顺序一致（0-based 列号 → 字段名）
const IMPORT_MAP = {
  personnel: [null, 'idNumber', 'name', 'phone', 'passNo', 'isNew', 'carryLaptop', 'laptopModel', 'laptopQty', 'certClass', 'visitorPhoto', 'vehicleType', 'plate', 'vehicleBrand', 'vehicleModel', 'passExpiry'],
  vehicle:   [null, 'driverIdNumber', 'driverName', 'phone', 'passNo', 'isNew', 'carryLaptop', null, 'laptopQty', 'certClass', null, 'vehicleType', 'plate', 'vehicleBrand', 'vehicleModel', 'passExpiry'],
  material:  ['drawingNo', 'itemName', 'unit', 'qty', 'material', 'spec', 'size', 'weight', 'grade', 'remark', 'plate', 'driverName', 'driverIdNumber', 'driverPhone', null, null],
};
const SHEET_TYPES = {
  '人员信息': 'personnel',
  '司机信息': 'vehicle',
  '物资进场明细': 'material_in',
  '物资出场明细': 'material_out',
};

async function importReports(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.read(buf);
  let count = 0;
  let skipped = 0;
  // 已存在记录指纹，避免重复导入同一份汇总
  const existing = await store.all();
  const finger = (type, f) => {
    if (type === 'personnel') return 'p:' + (f.idNumber || '') + '|' + (f.name || '');
    if (type === 'vehicle') return 'v:' + (f.driverIdNumber || '') + '|' + (f.plate || '');
    return 'm:' + (f.drawingNo || '') + '|' + (f.itemName || '') + '|' + (f.plate || '') + '|' + (f.entryTime || f.exitTime || '');
  };
  const seen = new Set(existing.map((r) => finger(r.type, r.fields || {})));
  for (const ws of wb.worksheets) {
    const type = SHEET_TYPES[ws.name];
    if (!type) continue;
    // 自动定位表头行：前 6 行内查找已知表头标记（兼容有无“公开”首行）
    let headerRow = 0;
    const marker = (type === 'personnel' || type === 'vehicle') ? '证件类型' : '图号';
    ws.eachRow((row, rn) => {
      if (headerRow) return;
      const txt = (row.values || []).map((v) => String(v || '')).join('|');
      if (txt.includes(marker)) headerRow = rn;
    });
    if (!headerRow) continue;
    const map = (type === 'material_in' || type === 'material_out') ? IMPORT_MAP.material : IMPORT_MAP[type];
    const dataRows = [];
    ws.eachRow((row, rn) => { if (rn > headerRow) dataRows.push(row); });
    for (const row of dataRows) {
      const vals = row.values; // 1-based
      const fields = {};
      let hasAny = false;
      map.forEach((target, colIdx) => {
        if (!target) return;
        const v = vals[colIdx + 1];
        const s = v == null ? '' : String(v).trim();
        if (s) { fields[target] = s; hasAny = true; }
      });
      if (type === 'material_in' || type === 'material_out') {
        const t = vals[15] == null ? '' : String(vals[15]).trim();
        if (t) { fields[type === 'material_in' ? 'entryTime' : 'exitTime'] = t; hasAny = true; }
      }
      if (!hasAny) { skipped++; continue; }
      if (seen.has(finger(type, fields))) { skipped++; continue; }
      const createdAt = Date.now();
      const record = {
        id: fmtId(createdAt),
        type,
        isRenewal: false,
        createdAt,
        createdAtStr: fmtDate(createdAt),
        passExpiry: fields.passExpiry || '',
        passNo: fields.passNo || '',
        fields,
      };
      await store.add(record);
      seen.add(finger(type, fields));
      count++;
    }
  }
  return { count, skipped };
}

// ---- 服务端合法性校验（与前端一致，作为兜底） ----
// 身份证号（GB 11643）：18 位，出生日期合法，校验位正确
function checkIdNumber(v) {
  const s = String(v || '').replace(/\s/g, '').toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const y = Number(s.slice(6, 10)), m = Number(s.slice(10, 12)), d = Number(s.slice(12, 14));
  if (y < 1900 || y > new Date().getFullYear()) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i];
  return codes[sum % 11] === s[17];
}
function phoneOk(v) { return /^1[3-9]\d{9}$/.test(String(v || '')); }

function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/') p = '/index.html';
  if (p === '/admin') p = '/admin.html';
  const filePath = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  // ---- 健康检查 / 探活接口：立即返回 200，不依赖任何存储或外部服务 ----
  // 云端健康检查探针打这个地址即可，容器一启动就能通过检查，避免“启动慢被判定不健康→不分配流量”。
  if (pathname === '/healthz' || pathname === '/_health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  try {
    // ---- 提交报备 ----
    if (req.method === 'POST' && pathname === '/api/report') {
      const body = JSON.parse(await readBody(req));
      const type = body.type;
      if (!['personnel', 'vehicle', 'material_in', 'material_out'].includes(type)) {
        return sendJson(res, 400, { ok: false, error: '未知报备类型' });
      }
      // 服务端合法性校验（兜底，前端已拦一遍）
      const fb = body.fields || {};
      const errs = [];
      for (const k of ['idNumber', 'driverIdNumber']) {
        if (fb[k] && String(fb[k]).length === 18 && !checkIdNumber(fb[k])) errs.push('身份证号格式/校验位不正确');
      }
      for (const k of ['phone', 'driverPhone']) {
        if (fb[k] && !phoneOk(fb[k])) errs.push('手机号格式不正确');
      }
      if (errs.length) return sendJson(res, 400, { ok: false, error: errs.join('；') });
      const createdAt = Date.now();
      const fields = await storage.persistPhotos(body.fields || {});
      // 不自动生成“报备到期日”：具体到期日以向甲方报备为准，当前未知
      const passExpiry = body.passExpiry || '';
      const record = {
        id: fmtId(createdAt),
        type,
        isRenewal: !!body.isRenewal,
        createdAt,
        createdAtStr: fmtDate(createdAt),
        passExpiry,
        passNo: fields.passNo || '',
        fields,
      };
      await store.add(record);
      return sendJson(res, 200, {
        ok: true,
        id: record.id,
        passExpiry: record.passExpiry,
        isRenewal: record.isRenewal,
      });
    }

    // ---- 客户端 OCR 配置（供手机端浏览器直连大模型，绕开云托管请求超时） ----
    if (req.method === 'GET' && pathname === '/api/ocr-config') {
      const llm = (config.ocr && config.ocr.llm) || {};
      const chain = (llm.chain && llm.chain.length) ? llm.chain : [llm.primary, llm.secondary].filter(Boolean);
      // 优先把第一个 openai(SiliconFlow) 配置交给前端直连
      const vis = chain.find((c) => c && c.provider === 'openai') || chain[0] || {};
      const kind = url.searchParams.get('kind') || '';
      const prompt = (PROMPTS && PROMPTS[kind]) || '';
      return sendJson(res, 200, {
        ok: true,
        provider: vis.provider || '',
        baseURL: vis.baseURL || '',
        apiKey: vis.apiKey || '',
        model: vis.model || '',
        prompt,
      });
    }

    // ---- 证件 OCR ----
    if (req.method === 'POST' && pathname === '/api/ocr') {
      const body = JSON.parse(await readBody(req));
      const kind = body.kind;
      const dataUrl = body.image || '';
      const m = dataUrl.match(/^data:image\/\w+;base64,(.*)$/);
      if (!m) return sendJson(res, 400, { ok: false, error: '图片格式错误' });
      try {
        const data = await ocr.ocr(kind, m[1]);
        return sendJson(res, 200, { ok: true, data });
      } catch (e) {
        if (e.code === 'DISABLED') {
          return sendJson(res, 200, { ok: false, needManual: true, error: 'OCR 未配置' });
        }
        return sendJson(res, 200, { ok: false, needManual: true, error: String(e.message || e) });
      }
    }

    // ---- 大模型视觉识别（证件 OCR） ----
    if (req.method === 'POST' && pathname === '/api/ocr-llm') {
      const body = JSON.parse(await readBody(req));
      const kind = body.kind;
      const dataUrl = body.image || '';
      if (!/^data:image\/\w+;base64,/.test(dataUrl)) {
        return sendJson(res, 400, { ok: false, error: '图片格式错误' });
      }
      const llm = (config.ocr && config.ocr.llm) || {};
      const cfgList = llm.chain && llm.chain.length
        ? llm.chain
        : [llm.primary, llm.secondary].filter(Boolean);
      // 整体超时保护：云托管单次请求有上限，避免无限等待
      const hardTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('OCR 超时，请手动填写')), 45000));
      try {
        const { data, meta } = await Promise.race([recognize(dataUrl, kind, cfgList), hardTimeout]);
        if (data && Object.keys(data).length) {
          return sendJson(res, 200, { ok: true, data, meta });
        }
        return sendJson(res, 200, { ok: false, needManual: true, error: '模型返回为空' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, needManual: true, error: String(e.message || e) });
      }
    }

    // ---- 历史报备查询（续期带入 / 手机号自动填充） ----
    if (req.method === 'GET' && pathname === '/api/lookup') {
      const idNumber = url.searchParams.get('idNumber') || '';
      const phone = url.searchParams.get('phone') || '';
      const plate = url.searchParams.get('plate') || '';
      const prefer = url.searchParams.get('prefer') || '';
      const list = await store.lookup({ idNumber, phone, plate, prefer });
      if (!list.length) return sendJson(res, 200, { ok: false, found: false });
      const last = list[0];
      // 车辆/驾驶员相关字段在多条历史记录间逐字段回填，尽量补全
      const merged = store.mergeFields(list, [
        'name', 'idNumber', 'phone',
        'driverName', 'driverIdName', 'driverIdNumber', 'driverPhone',
        'plate', 'vehicleBrand', 'vehicleModel', 'vehicleType',
        'licenseName', 'licenseValid', 'annualInspection',
        'idValidStart', 'idValidEnd', 'driverIdValidStart', 'driverIdValidEnd',
        'carryLaptop', 'laptopModel', 'laptopQty',
      ]);
      return sendJson(res, 200, {
        ok: true,
        found: true,
        matchedTypes: Array.from(new Set(list.map((r) => r.type))),
        record: Object.assign({}, merged, {
          id: last.id,
          type: last.type,
          name: merged.name || merged.driverName || merged.driverIdName || '',
          idNumber: merged.idNumber || merged.driverIdNumber || '',
          driverName: merged.driverName || merged.driverIdName || merged.name || '',
          driverIdNumber: merged.driverIdNumber || merged.idNumber || '',
          driverPhone: merged.driverPhone || merged.phone || '',
          phone: merged.phone || merged.driverPhone || '',
          passNo: last.passNo || '',
          passExpiry: last.passExpiry || '',
        }),
      });
    }

    // ---- 后台：列表（支持单日 / 日期区间） ----
    if (req.method === 'GET' && pathname === '/api/reports') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const date = url.searchParams.get('date') || '';
      const dateFrom = url.searchParams.get('dateFrom') || '';
      const dateTo = url.searchParams.get('dateTo') || '';
      const all = await store.all();
      const list = all
        .filter((r) => {
          if (date) return r.createdAtStr === date;
          if (dateFrom || dateTo) {
            if (dateFrom && r.createdAtStr < dateFrom) return false;
            if (dateTo && r.createdAtStr > dateTo) return false;
          }
          return true;
        })
        .map((r) => ({
        id: r.id,
        type: r.type,
        isRenewal: r.isRenewal,
        createdAtStr: r.createdAtStr,
        passExpiry: r.passExpiry || '',
        name: r.fields.name || r.fields.driverName || '',
        idNumber: r.fields.idNumber || r.fields.driverIdNumber || '',
        phone: r.fields.phone || '',
        plate: r.fields.plate || '',
      }));
      return sendJson(res, 200, { ok: true, list });
    }

    // ---- 后台：取单条完整记录（含证件图片路径，供拼图用） ----
    if (req.method === 'GET' && pathname.startsWith('/api/report/')) {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const id = pathname.split('/').pop();
      const rec = await store.findById(id);
      if (!rec) return sendJson(res, 404, { ok: false, error: '记录不存在' });
      return sendJson(res, 200, { ok: true, record: rec });
    }

    // ---- 同源返回图片字节（供后台 canvas 拼图，避免跨域污染） ----
    if (req.method === 'GET' && pathname === '/api/photobytes') {
      const p = url.searchParams.get('path') || '';
      const buf = await storage.readPhotoBuffer(p);
      if (!buf) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(p).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }

    // ---- 后台：批量导入 xlsx（人员/司机/物资，自动填充数据源） ----
    if (req.method === 'POST' && pathname === '/api/import') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const body = JSON.parse(await readBody(req));
      const dataUrl = body.file || '';
      const m = dataUrl.match(/^data:[\w/.+-]+;base64,(.*)$/);
      if (!m) return sendJson(res, 400, { ok: false, error: '文件格式错误' });
      const buf = Buffer.from(m[1], 'base64');
      try {
        const result = await importReports(buf);
        return sendJson(res, 200, { ok: true, count: result.count, skipped: result.skipped });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: '导入失败：' + String(e.message || e) });
      }
    }

    // ---- 后台：导出 Excel（可按单日 / 日期区间筛选） ----
    if (req.method === 'GET' && pathname === '/api/export') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const type = url.searchParams.get('type') || 'all';
      const date = url.searchParams.get('date') || '';
      const dateFrom = url.searchParams.get('dateFrom') || '';
      const dateTo = url.searchParams.get('dateTo') || '';
      const buf = await exporter.exportType(type, { date, dateFrom, dateTo });
      const range = date ? '_' + date : (dateFrom || dateTo ? `_${dateFrom || '起'}-${dateTo || '今'}` : '');
      const fname = `报备明细_${type}${range}_${fmtDate(Date.now())}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}"`,
      });
      return res.end(buf);
    }

    // ---- 通知：公开读取（首页横幅） ----
    if (req.method === 'GET' && pathname === '/api/notices') {
      return sendJson(res, 200, { ok: true, list: await store.listNotices() });
    }

    // ---- 通知：超级管理员发布 ----
    if (req.method === 'POST' && pathname === '/api/notices') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const body = JSON.parse(await readBody(req));
      const text = (body.text || '').trim();
      if (!text) return sendJson(res, 400, { ok: false, error: '通知内容不能为空' });
      const n = await store.addNotice(text, 'admin');
      return sendJson(res, 200, { ok: true, notice: n });
    }

    // ---- 通知：超级管理员删除 ----
    if (req.method === 'DELETE' && pathname === '/api/notices') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const id = url.searchParams.get('id') || '';
      await store.deleteNotice(id);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 重名/重号冲突检测（校验信息合法性、防止冒用他人证件） ----
    if (req.method === 'GET' && pathname === '/api/check-conflict') {
      const idNumber = url.searchParams.get('idNumber') || '';
      const phone = url.searchParams.get('phone') || '';
      const name = url.searchParams.get('name') || '';
      const c = await store.conflicts({ idNumber, phone, name });
      return sendJson(res, 200, { ok: true, conflicts: c });
    }

    // ---- 我的报备：凭身份证号+手机号查看本人记录 ----
    if (req.method === 'GET' && pathname === '/api/my') {
      const idNumber = url.searchParams.get('idNumber') || '';
      const phone = url.searchParams.get('phone') || '';
      if (!idNumber || !phone) return sendJson(res, 400, { ok: false, error: '请填写身份证号与手机号' });
      const list = (await store.mine({ idNumber, phone })).map((r) => ({
        id: r.id,
        type: r.type,
        isRenewal: r.isRenewal,
        createdAtStr: r.createdAtStr,
        passExpiry: r.passExpiry || '',
        fields: r.fields,
      }));
      return sendJson(res, 200, { ok: true, list });
    }

    // ---- 修改本人报备：仅允许修改归属自己的记录 ----
    if (req.method === 'PUT' && pathname.startsWith('/api/report/')) {
      const id = pathname.split('/').pop();
      const body = JSON.parse(await readBody(req));
      const idNumber = body.idNumber || '';
      const phone = body.phone || '';
      const rec = await store.findById(id);
      if (!rec) return sendJson(res, 404, { ok: false, error: '记录不存在' });
      const o = store.ownerOf(rec);
      const idMatch = idNumber && o.ids.includes(idNumber);
      const phMatch = phone && o.phones.includes(phone);
      if (!idMatch || !phMatch) return sendJson(res, 403, { ok: false, error: '只能修改本人报备的内容' });
      const fields = await storage.persistPhotos(body.fields || {});
      const ue = [];
      for (const k of ['idNumber', 'driverIdNumber']) {
        if (fields[k] && String(fields[k]).length === 18 && !checkIdNumber(fields[k])) ue.push('身份证号校验未通过');
      }
      for (const k of ['phone', 'driverPhone']) {
        if (fields[k] && !phoneOk(fields[k])) ue.push('手机号格式不正确');
      }
      if (ue.length) return sendJson(res, 400, { ok: false, error: ue.join('；') });
      await store.update(id, fields);
      return sendJson(res, 200, { ok: true, id });
    }

    // ---- 读取已上传图片（本地文件 / 云存储临时 URL） ----
    if (req.method === 'GET' && pathname === '/api/photo') {
      const p = url.searchParams.get('path') || '';
      const result = await storage.readPhoto(p);
      if (!result) {
        res.writeHead(404);
        return res.end('Not found');
      }
      if (result.type === 'redirect' && result.url) {
        res.writeHead(302, { Location: result.url });
        return res.end();
      }
      const ext = path.extname(p).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(result.buffer);
    }

    // ---- 静态资源 ----
    if (req.method === 'GET') {
      return serveStatic(req, res, url);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

// 防止长连接被代理（云端 LB）提前掐断导致写入已关闭的 socket 而抛错
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// 监听级错误（如端口被占）记录但不退出
server.on('error', (err) => {
  console.error('[server.error]', err && (err.stack || err.message || err));
});

const PORT = process.env.PORT || config.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`报备系统已启动: http://localhost:${PORT}  (healthz: /healthz)`);
  console.log(`后台管理: http://localhost:${PORT}/admin  (token: ${config.adminToken})`);
});
