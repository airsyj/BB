const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./lib/config');
const store = require('./lib/store');
const ocr = require('./lib/ocr');
const { recognize } = require('./lib/llm-ocr');
const exporter = require('./lib/export');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(ROOT, config.uploadsDir);
fs.mkdirSync(UPLOADS, { recursive: true });

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

// 保存 base64 图片，返回文件名；非图片原样返回
function savePhoto(val) {
  if (typeof val !== 'string' || !val.startsWith('data:image/')) return val;
  const m = val.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return '';
  const ext = m[1].split('/')[1] === 'jpeg' ? 'jpg' : m[1].split('/')[1];
  const buf = Buffer.from(m[2], 'base64');
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return name;
}

// 递归处理 fields：把其中所有 base64 图片落盘为文件
function persistPhotos(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) {
    out[k] = savePhoto(fields[k]);
  }
  return out;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 报备编号：按生成时的 年月日时分秒 生成（如 20260805210654）
function fmtId(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function adminOk(url) {
  const t = url.searchParams.get('token');
  return t && t === config.adminToken;
}

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

  try {
    // ---- 提交报备 ----
    if (req.method === 'POST' && pathname === '/api/report') {
      const body = JSON.parse(await readBody(req));
      const type = body.type;
      if (!['personnel', 'vehicle', 'material_in', 'material_out'].includes(type)) {
        return sendJson(res, 400, { ok: false, error: '未知报备类型' });
      }
      const createdAt = Date.now();
      const fields = persistPhotos(body.fields || {});
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
      store.add(record);
      return sendJson(res, 200, {
        ok: true,
        id: record.id,
        passExpiry: record.passExpiry,
        isRenewal: record.isRenewal,
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
      try {
        const { data, meta } = await recognize(dataUrl, kind, cfgList);
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
      const list = store.lookup({ idNumber, phone, plate, prefer });
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

    // ---- 后台：列表 ----
    if (req.method === 'GET' && pathname === '/api/reports') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const date = url.searchParams.get('date') || '';
      const all = store.all();
      const list = (date ? all.filter((r) => r.createdAtStr === date) : all).map((r) => ({
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

    // ---- 后台：导出 Excel ----
    if (req.method === 'GET' && pathname === '/api/export') {
      if (!adminOk(url)) return sendJson(res, 401, { ok: false, error: 'token 错误' });
      const type = url.searchParams.get('type') || 'all';
      const buf = await exporter.exportType(type);
      const fname = `报备明细_${type}_${fmtDate(Date.now())}.xlsx`;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fname)}"`,
      });
      return res.end(buf);
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

const PORT = process.env.PORT || config.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`报备系统已启动: http://localhost:${PORT}`);
  console.log(`后台管理: http://localhost:${PORT}/admin  (token: ${config.adminToken})`);
});
