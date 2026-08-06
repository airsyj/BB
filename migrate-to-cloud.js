// 将本地 data/reports.json + data/notices.json 迁移到 CloudBase 云存储
// 运行前请设置环境变量：TCB_ENV_ID, TCB_SECRET_ID, TCB_SECRET_KEY

const fs = require('fs');
const path = require('path');
const { uploadFile: cbUpload, getFileID } = require('./lib/cloudbase');

const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');
const NOTICES_FILE = path.join(DATA_DIR, 'notices.json');

async function uploadJson(cloudPath, filePath) {
  const buf = fs.readFileSync(filePath);
  await cbUpload({ cloudPath, fileContent: buf });
  const fileID = await getFileID(cloudPath);
  console.log(`上传成功: ${cloudPath} -> ${fileID}`);
}

(async () => {
  try {
    if (!process.env.TCB_ENV_ID || !process.env.TCB_SECRET_ID || !process.env.TCB_SECRET_KEY) {
      console.error('请先设置环境变量 TCB_ENV_ID, TCB_SECRET_ID, TCB_SECRET_KEY');
      process.exit(1);
    }
    if (fs.existsSync(REPORTS_FILE)) {
      const reports = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
      console.log(`准备迁移 ${reports.length} 条报备记录`);
      await uploadJson('data/reports.json', REPORTS_FILE);
    } else {
      console.log('本地 reports.json 不存在，跳过');
    }
    if (fs.existsSync(NOTICES_FILE)) {
      await uploadJson('data/notices.json', NOTICES_FILE);
    } else {
      // 创建空 notices 文件并上传
      const empty = [];
      const tmp = path.join(DATA_DIR, '_notices_empty.json');
      fs.writeFileSync(tmp, JSON.stringify(empty));
      await uploadJson('data/notices.json', tmp);
      fs.unlinkSync(tmp);
    }
    console.log('迁移完成');
  } catch (e) {
    console.error('迁移失败:', e.message || e);
    process.exit(1);
  }
})();
