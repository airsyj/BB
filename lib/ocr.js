// 证件 OCR 客户端（默认接入百度智能云 OCR，可替换为其他厂商）
// 支持：身份证正面/背面、驾驶证、行驶证
// 未配置密钥时返回 DISABLED，前端自动降级为手动填写。

const CFG = require('./config').ocr;

let tokenCache = { token: null, exp: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const { apiKey, secretKey } = CFG.baidu || {};
  if (!apiKey || !secretKey) throw new Error('NO_KEY');
  const url =
    'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials' +
    `&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.access_token) throw new Error('TOKEN_FAIL:' + JSON.stringify(j));
  tokenCache.token = j.access_token;
  tokenCache.exp = Date.now() + (Number(j.expires_in) - 60) * 1000;
  return j.access_token;
}

const EP = {
  idcard_front: 'idcard',
  idcard_back: 'idcard',
  driving_license: 'driving_license',
  vehicle_license: 'vehicle_license',
};

async function baidu(kind, b64) {
  const token = await getToken();
  const ep = EP[kind];
  const url = `https://aip.baidubce.com/rest/2.0/ocr/v1/${ep}?access_token=${token}`;
  const params = new URLSearchParams();
  params.set('image', b64);
  if (kind === 'idcard_front' || kind === 'idcard_back') {
    params.set('id_card_side', kind === 'idcard_front' ? 'front' : 'back');
  }
  params.set('detect_risk', 'false');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const j = await r.json();
  if (j.error_code) throw new Error(j.error_msg || 'OCR_ERR');
  return parse(kind, j);
}

function parse(kind, j) {
  const w = j.words_result || {};
  const get = (k) => {
    const v = w[k];
    if (v == null) return '';
    return typeof v === 'string' ? v : (v.words != null ? v.words : '');
  };
  if (kind === 'idcard_front') {
    return { name: get('姓名'), idNumber: get('公民身份号码') };
  }
  if (kind === 'idcard_back') {
    return { idValidStart: get('签发日期'), idValidEnd: get('失效日期') };
  }
  if (kind === 'driving_license') {
    return {
      licenseName: get('姓名'),
      licenseNo: get('证号'),
      licenseValid: get('有效期限'),
    };
  }
  if (kind === 'vehicle_license') {
    const brandModel = get('品牌型号');
    return {
      plate: get('车牌号码'),
      vehicleType: get('车辆类型'),
      vehicleBrand: brandModel,
      vehicleModel: brandModel,
      annualInspection: get('检验记录'),
    };
  }
  return {};
}

async function ocr(kind, b64) {
  if (CFG.provider !== 'baidu' || !CFG.baidu || !CFG.baidu.apiKey) {
    const e = new Error('DISABLED');
    e.code = 'DISABLED';
    throw e;
  }
  return baidu(kind, b64);
}

module.exports = { ocr };
