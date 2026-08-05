// 配置加载：优先读取 config.json（本地真实配置，含密钥），
// 部署环境若没有 config.json 则回退到 config.example.json（已脱敏、可入库），
// 最后允许用环境变量覆盖密钥，避免把密钥写进仓库。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function loadConfig() {
  const candidates = ['config.json', 'config.example.json'];
  for (const f of candidates) {
    try {
      const p = path.join(ROOT, f);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      // 尝试下一个候选
    }
  }
  // 兜底默认值（极端情况下缺少任何配置文件时使用）
  return {
    port: 3000,
    adminToken: 'change-me-admin-token',
    passValidDays: 30,
    renewNoticeDays: 7,
    uploadsDir: 'uploads',
    dataDir: 'data',
    ocr: { provider: 'baidu', baidu: { apiKey: '', secretKey: '' }, llm: { chain: [] } },
  };
}

const config = loadConfig();

// 用环境变量覆盖密钥（适合免费托管平台：密钥不放进仓库）
if (process.env.SILICONFLOW_KEY) {
  const k = process.env.SILICONFLOW_KEY;
  ((config.ocr && config.ocr.llm && config.ocr.llm.chain) || [])
    .forEach((c) => { if (c && c.apiKey !== undefined) c.apiKey = k; });
}
if (process.env.HUNYUAN_SECRET_ID) {
  ((config.ocr && config.ocr.llm && config.ocr.llm.chain) || [])
    .filter((c) => c && c.provider === 'hunyuan')
    .forEach((c) => { c.secretId = process.env.HUNYUAN_SECRET_ID; c.secretKey = process.env.HUNYUAN_SECRET_KEY; });
}
if (process.env.ADMIN_TOKEN) config.adminToken = process.env.ADMIN_TOKEN;
// 云托管(CFS 挂载)时把上传目录也指向挂载点，照片才能持久化
if (process.env.UPLOADS_DIR) config.uploadsDir = process.env.UPLOADS_DIR;

// 安全提醒：公开部署必须设置 ADMIN_TOKEN，否则后台可被他人访问
const DEFAULT_ADMIN_TOKENS = ['admin123', 'change-me-admin-token', ''];
if (DEFAULT_ADMIN_TOKENS.includes(config.adminToken)) {
  console.warn('[安全提醒] 当前后台管理 token 为默认值，公开部署前请在托管平台设置环境变量 ADMIN_TOKEN 为强随机字符串！');
}

module.exports = config;
