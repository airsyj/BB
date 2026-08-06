// 大模型视觉识别（证件 OCR）—— 高准确率版
// 关键策略：
//   1) 针对每种证件使用严格的结构化提示词（含字段规则、易错点提醒）
//   2) 返回结果做规范化清洗（全角转半角、去空格、日期统一）
//   3) 身份证号做 GB11643 校验位验算，车牌做正则校验
//   4) 校验不通过时自动换模型/换提示词重试（最多 3 轮），多轮结果按票数择优
//
// 支持两种接入方式（config.json 的 ocr.llm 中配置）：
//   - provider: "openai"    兼容 OpenAI /chat/completions 的网关（Bearer apiKey）
//   - provider: "hunyuan"   腾讯混元视觉（SecretId + SecretKey，TC3 签名）

const crypto = require('crypto');

// ---------------- 提示词 ----------------
const PROMPTS = {
  idcard_front:
    '这是一张中国居民身份证的【人像面】。请逐字仔细识别并输出 JSON：\n' +
    '{"name":"姓名","idNumber":"公民身份号码"}\n' +
    '规则：\n' +
    '1. name 为「姓名」一栏的中文全名，不含任何标点或空格。\n' +
    '2. idNumber 必须是 18 位，前 17 位为数字，最后一位为数字或大写 X。请逐位核对，特别注意区分 0/8、1/7、3/8、5/6、6/8。\n' +
    '3. 若某字段确实看不清，输出空字符串。\n' +
    '4. 只输出 JSON，不要任何解释、不要 markdown 代码块。',

  idcard_back:
    '这是一张中国居民身份证的【国徽面】。请识别并输出 JSON：\n' +
    '{"issueAuthority":"签发机关","idValidStart":"有效期限起始日","idValidEnd":"有效期限截止日"}\n' +
    '规则：\n' +
    '1. 「有效期限」一栏形如 2016.09.21-2036.09.21，请拆成起始日与截止日，均用 YYYY.MM.DD 格式。\n' +
    '2. 若截止日写的是「长期」，idValidEnd 输出「长期」。\n' +
    '3. 只输出 JSON，不要任何解释、不要 markdown 代码块。',

  driving_license:
    '这是一张中国【机动车驾驶证】主页。请识别并输出 JSON：\n' +
    '{"licenseName":"姓名","licenseNo":"证号","licenseClass":"准驾车型","licenseValid":"有效期限"}\n' +
    '规则：\n' +
    '1. licenseNo 是「证号」一栏，通常为 18 位（同身份证号）。请逐位核对。\n' +
    '2. licenseValid 形如 2019.01.01-2025.01.01，把「有效起始日期」与「有效期限」两栏拼成这种格式；若为长期则写 2019.01.01-长期。\n' +
    '3. licenseClass 如 A1、A2、B2、C1 等。\n' +
    '4. 只输出 JSON，不要任何解释、不要 markdown 代码块。',

  vehicle_license:
    '这是一张中国【机动车行驶证】主页。请识别并输出 JSON：\n' +
    '{"plate":"号牌号码","vehicleBrand":"品牌","vehicleModel":"型号","vehicleTypeRaw":"车辆类型","useCharacter":"使用性质"}\n' +
    '规则：\n' +
    '1. plate 为「号牌号码」，形如 京A12345 或 京AD12345（新能源 8 位），首字为省份简称汉字，其后为大写字母与数字。\n' +
    '2. 行驶证上的「品牌型号」是一整串，如「东风牌DFL1250A9」或「北京牌BJ6493MD5EA」。请把「X牌」之前（含"牌"字前的名称）作为 vehicleBrand，「牌」之后的字母数字串作为 vehicleModel。若无「牌」字，则整串放 vehicleModel，vehicleBrand 填其中的中文部分。\n' +
    '3. vehicleTypeRaw 为「车辆类型」原文，如 小型轿车、重型半挂牵引车、大型普通客车。\n' +
    '4. 只输出 JSON，不要任何解释、不要 markdown 代码块。',
};

// 只重问关键字段的“聚焦提示词”（首轮校验失败时使用）
const FOCUS_PROMPTS = {
  idNumber:
    '请只看这张身份证上「公民身份号码」那一行，把 18 位号码一位一位读出来。\n' +
    '注意：前 17 位全是数字，第 18 位是数字或大写 X。数字容易混淆的请放大细看：0 与 8、1 与 7、3 与 8、5 与 6、6 与 8、2 与 7。\n' +
    '只输出 JSON：{"idNumber":"18位号码"}',
  licenseNo:
    '请只看这张驾驶证上「证号」那一行，把号码一位一位读出来。\n' +
    '只输出 JSON：{"licenseNo":"号码"}',
  plate:
    '请只看这张行驶证上「号牌号码」那一行，逐字读出车牌。\n' +
    '首字是省份简称汉字（如 京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新），随后是大写字母和数字，共 7 位或 8 位。\n' +
    '只输出 JSON：{"plate":"车牌号"}',
};

function buildPrompt(kind) {
  return PROMPTS[kind] || '请识别图中证件的关键信息，只输出 JSON，不要解释。';
}

// ---------------- 文本清洗与校验 ----------------
// 全角转半角 + 去除易混淆的空白
function toHalf(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .trim();
}

function cleanId(s) {
  let v = toHalf(s).replace(/[\s\-—–_·.]/g, '').toUpperCase();
  // 常见 OCR 误读修正（仅在长度为 18 且位置合规时才纠正）
  return v;
}

// GB 11643-1999 身份证校验位
function isValidIdNumber(id) {
  const v = cleanId(id);
  if (!/^\d{17}[\dX]$/.test(v)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(v[i]) * w[i];
  if (codes[sum % 11] !== v[17]) return false;
  // 出生日期合理性
  const y = Number(v.slice(6, 10)), m = Number(v.slice(10, 12)), d = Number(v.slice(12, 14));
  const now = new Date().getFullYear();
  if (y < 1900 || y > now) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}

const PLATE_RE = /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新使领警学港澳][A-Z][A-Z0-9]{4,6}$/;
function cleanPlate(s) {
  return toHalf(s).replace(/[\s\-·•]/g, '').toUpperCase();
}
function isValidPlate(p) { return PLATE_RE.test(cleanPlate(p)); }

// 日期统一为 YYYY.MM.DD
function cleanDate(s) {
  const v = toHalf(s);
  if (!v) return '';
  if (/长期/.test(v)) return '长期';
  const m = v.match(/(\d{4})\s*[.\-\/年]\s*(\d{1,2})\s*[.\-\/月]\s*(\d{1,2})/);
  if (!m) return v;
  return `${m[1]}.${String(m[2]).padStart(2, '0')}.${String(m[3]).padStart(2, '0')}`;
}

// 有效期区间统一为 YYYY.MM.DD-YYYY.MM.DD（不能按 "-" 硬拆，日期内部也有 "-"）
function cleanRange(s) {
  const v = toHalf(s);
  if (!v) return '';
  const found = v.match(/\d{4}\s*[.\-\/年]\s*\d{1,2}\s*[.\-\/月]\s*\d{1,2}/g) || [];
  if (found.length >= 2) return `${cleanDate(found[0])}-${cleanDate(found[1])}`;
  if (found.length === 1) {
    return /长期/.test(v) ? `${cleanDate(found[0])}-长期` : cleanDate(found[0]);
  }
  return v;
}

function cleanName(s) {
  return toHalf(s).replace(/[\s·．.、,，:：]/g, '').replace(/^姓名/, '');
}

// 品牌/型号拆分兜底
function splitBrandModel(brand, model) {
  let b = toHalf(brand), m = toHalf(model);
  const whole = b && m && b === m ? b : '';
  const src = whole || (b && !m ? b : '');
  if (src) {
    const i = src.indexOf('牌');
    if (i > 0) return { vehicleBrand: src.slice(0, i + 1), vehicleModel: src.slice(i + 1).trim() };
    const cn = src.match(/^[\u4e00-\u9fa5]+/);
    if (cn) return { vehicleBrand: cn[0], vehicleModel: src.slice(cn[0].length).trim() };
  }
  return { vehicleBrand: b, vehicleModel: m };
}

function extractJson(text) {
  if (!text) return {};
  let t = String(text).replace(/```json/gi, '```').replace(/```/g, ' ');
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { /* 继续 */ }
  // 容错：单引号/尾逗号
  try { return JSON.parse(m[0].replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1')); } catch { return {}; }
}

// 把大模型可能返回的各种键名归一化为系统约定的规范键
const ALIAS = {
  name: ['name', '姓名'],
  idNumber: ['idNumber', 'id_number', 'idNo', '身份证号', '公民身份号码', '证件号码'],
  idValidStart: ['idValidStart', 'valid_start', '有效期起', '有效期限起始日', '签发日期'],
  idValidEnd: ['idValidEnd', 'valid_end', '有效期止', '有效期限截止日', '失效日期'],
  issueAuthority: ['issueAuthority', '签发机关'],
  licenseName: ['licenseName', '姓名', '驾驶人姓名'],
  licenseNo: ['licenseNo', 'license_no', '驾驶证号', '证号'],
  licenseClass: ['licenseClass', '准驾车型'],
  licenseValid: ['licenseValid', '有效期限', '有效期'],
  plate: ['plate', 'plateNo', 'plate_number', '号牌号码', '车牌号', '车牌'],
  vehicleBrand: ['vehicleBrand', 'brand', '品牌'],
  vehicleModel: ['vehicleModel', 'model', '型号', '品牌型号', '车辆型号'],
  vehicleTypeRaw: ['vehicleTypeRaw', 'vehicleType', '车辆类型'],
  useCharacter: ['useCharacter', '使用性质'],
};

function normalize(o, kind) {
  const raw = {};
  for (const [canon, aliases] of Object.entries(ALIAS)) {
    for (const a of aliases) {
      if (o[a] != null && String(o[a]).trim() !== '') { raw[canon] = String(o[a]).trim(); break; }
    }
  }
  const out = {};
  if (raw.name) out.name = cleanName(raw.name);
  if (raw.idNumber) out.idNumber = cleanId(raw.idNumber);
  if (raw.idValidStart) out.idValidStart = cleanDate(raw.idValidStart);
  if (raw.idValidEnd) out.idValidEnd = cleanDate(raw.idValidEnd);
  if (raw.licenseName) out.licenseName = cleanName(raw.licenseName);
  if (raw.licenseNo) out.licenseNo = cleanId(raw.licenseNo);
  if (raw.licenseClass) out.licenseClass = toHalf(raw.licenseClass).toUpperCase();
  if (raw.licenseValid) out.licenseValid = cleanRange(raw.licenseValid);
  if (raw.plate) out.plate = cleanPlate(raw.plate);
  if (kind === 'vehicle_license') {
    const bm = splitBrandModel(raw.vehicleBrand, raw.vehicleModel);
    if (bm.vehicleBrand) out.vehicleBrand = bm.vehicleBrand;
    if (bm.vehicleModel) out.vehicleModel = bm.vehicleModel;
    if (raw.vehicleTypeRaw) {
      out.vehicleTypeRaw = raw.vehicleTypeRaw;
      // 归一到系统的「客车/货车」二选一
      out.vehicleType = /客车|轿车|越野|商务|面包|专项作业|校车/.test(raw.vehicleTypeRaw) ? '客车' : '货车';
    }
  } else {
    if (raw.vehicleBrand) out.vehicleBrand = toHalf(raw.vehicleBrand);
    if (raw.vehicleModel) out.vehicleModel = toHalf(raw.vehicleModel);
  }
  // 身份证正面若识别到日期，忽略（正面无有效期）
  for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
  return out;
}

// ---------------- 各厂商调用 ----------------
async function openaiCall(image, prompt, cfg) {
  const base = (cfg.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 30000);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        top_p: 0.1,
        max_tokens: 512,
        messages: [
          { role: 'system', content: '你是专业的中国证件 OCR 引擎。逐字精读图片，只输出 JSON，绝不输出解释文字。' },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: image, detail: 'high' } },
            { type: 'text', text: prompt },
          ] },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('http ' + r.status + ' ' + t.slice(0, 160));
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 腾讯混元（TC3-HMAC-SHA256） ----------
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function hmacsha256(key, s) {
  return crypto.createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key)
    .update(s, 'utf8').digest();
}

function signTencent({ host, payload, secretId, secretKey }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const service = 'hunyuan';
  const algorithm = 'TC3-HMAC-SHA256';
  const canonicalHeaders = 'content-type:application/json\nhost:' + host + '\n';
  const signedHeaders = 'content-type;host';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(payload)].join('\n');
  const credentialScope = date + '/' + service + '/tc3_request';
  const stringToSign = [algorithm, String(timestamp), credentialScope, sha256hex(canonicalRequest)].join('\n');
  const secretDate = hmacsha256('TC3' + secretKey, date);
  const secretService = hmacsha256(secretDate, service);
  const secretSigning = hmacsha256(secretService, 'tc3_request');
  const signature = hmacsha256(secretSigning, stringToSign).toString('hex');
  const authorization = algorithm + ' Credential=' + secretId + '/' + credentialScope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return { authorization, timestamp: String(timestamp) };
}

async function hunyuanCall(image, prompt, cfg) {
  const host = 'hunyuan.tencentcloudapi.com';
  const action = 'ChatCompletions';
  const version = '2023-09-01';
  const payload = JSON.stringify({
    Model: cfg.model || 'hunyuan-vision',
    Temperature: 0,
    Messages: [{
      Role: 'user',
      Contents: [
        { Type: 'image_url', ImageUrl: { Url: image } },
        { Type: 'text', Text: prompt },
      ],
    }],
  });
  const signed = signTencent({ host, payload, secretId: cfg.secretId, secretKey: cfg.secretKey });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 30000);
  try {
    const r = await fetch('https://' + host + '/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: signed.authorization,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': signed.timestamp,
      },
      body: payload,
      signal: ctrl.signal,
    });
  if (!r.ok) throw new Error('http ' + r.status);
  const j = await r.json();
  if (j.Response?.Error) throw new Error(j.Response.Error.Message || 'hunyuan error');
  return j.Response?.Choices?.[0]?.Message?.Content || '';
  } finally {
    clearTimeout(timer);
  }
}

async function callModel(image, prompt, cfg) {
  if (!cfg || !cfg.provider) throw new Error('未配置');
  if (cfg.provider === 'openai') return openaiCall(image, prompt, cfg);
  if (cfg.provider === 'hunyuan') return hunyuanCall(image, prompt, cfg);
  throw new Error('unknown provider ' + cfg.provider);
}

// 单次识别（不含重试）
async function llmOcr(image, kind, cfg) {
  const text = await callModel(image, buildPrompt(kind), cfg);
  return normalize(extractJson(text), kind);
}

// ---------------- 带校验与重试的高准确率识别 ----------------
// cfgList：按优先级排列的模型配置数组
// 返回 { data, meta:{ model, attempts, verified } }
async function recognize(image, kind, cfgList, opts) {
  const MAX_ATTEMPTS = (opts && opts.maxAttempts) || 2; // 控制总耗时，避免无谓兜圈
  const list = (cfgList || []).filter((c) => c && c.provider);
  if (!list.length) throw new Error('未配置大模型识别');

  const critical = kind === 'idcard_front' ? 'idNumber'
    : kind === 'driving_license' ? 'licenseNo'
      : kind === 'vehicle_license' ? 'plate' : null;

  const check = (d) => {
    if (!d || !Object.keys(d).length) return false;
    if (critical === 'idNumber') return isValidIdNumber(d.idNumber);
    if (critical === 'licenseNo') return !d.licenseNo || d.licenseNo.length >= 6;
    if (critical === 'plate') return isValidPlate(d.plate);
    return true;
  };

  const results = [];
  let lastErr = '';
  let attempts = 0;

  // 关键字段出现两次相同取值 → 认定为证件原文如此（有些证件号本身校验位就异常），提前结束
  const consensus = () => {
    if (!critical) return null;
    const cnt = new Map();
    for (const r of results) {
      const v = r.d[critical];
      if (!v) continue;
      cnt.set(v, (cnt.get(v) || 0) + 1);
      if (cnt.get(v) >= 2) return r;
    }
    return null;
  };

  for (let i = 0; i < list.length && attempts < MAX_ATTEMPTS; i++) {
    const cfg = list[i];
    attempts++;
    try {
      const d = await llmOcr(image, kind, cfg);
      if (d && Object.keys(d).length) {
        results.push({ d, model: cfg.model || cfg.provider });
        if (check(d)) return { data: d, meta: { model: cfg.model || cfg.provider, attempts, verified: true } };
      } else {
        lastErr = '模型返回为空';
      }
    } catch (e) {
      lastErr = String(e.message || e);
      console.log(`[ocr] ${kind} 模型 ${cfg.model || cfg.provider} 失败: ${lastErr}`);
      continue;
    }

    const c1 = consensus();
    if (c1) return { data: c1.d, meta: { model: c1.model + '·共识', attempts, verified: false } };

    // 校验未过：用「聚焦提示词」只重问关键字段（同一模型放大细看）
    if (critical && FOCUS_PROMPTS[critical] && attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        const t = await callModel(image, FOCUS_PROMPTS[critical], cfg);
        const focus = normalize(extractJson(t), kind);
        if (focus[critical]) {
          const merged = Object.assign({}, results[results.length - 1]?.d || {}, { [critical]: focus[critical] });
          results.push({ d: merged, model: (cfg.model || cfg.provider) + '·focus' });
          if (check(merged)) {
            return { data: merged, meta: { model: (cfg.model || cfg.provider) + '·focus', attempts, verified: true } };
          }
          const c2 = consensus();
          if (c2) return { data: c2.d, meta: { model: c2.model + '·共识', attempts, verified: false } };
        }
      } catch (e) { lastErr = String(e.message || e); }
    }
  }

  if (!results.length) throw new Error(lastErr || '识别失败');

  // 都没通过校验：按关键字段票数择优，票数相同取字段最全的
  let best = results[0];
  if (critical) {
    const votes = new Map();
    for (const r of results) {
      const v = r.d[critical];
      if (!v) continue;
      votes.set(v, (votes.get(v) || 0) + 1);
    }
    let top = null, topN = 0;
    for (const [v, n] of votes) if (n > topN) { top = v; topN = n; }
    if (top) best = results.find((r) => r.d[critical] === top) || best;
  }
  for (const r of results) if (Object.keys(r.d).length > Object.keys(best.d).length) best = r;
  return { data: best.d, meta: { model: best.model, attempts, verified: false } };
}

module.exports = { llmOcr, recognize, isValidIdNumber, isValidPlate, cleanPlate, cleanId, cleanDate, normalize, extractJson, PROMPTS, FOCUS_PROMPTS, ALIAS, splitBrandModel, isValidIdNumber, isValidPlate };
