const cloudbase = require('@cloudbase/node-sdk');

// 是否运行在 CloudBase 云托管环境中
// 云托管会注入 TCB_ENV_ID 等环境变量，SDK 可自动获取临时凭据
function isCloudbase() {
  return !!(process.env.TCB_ENV_ID || process.env.TENCENTCLOUD_RUNENV);
}

let app = null;
function getApp() {
  if (app) return app;
  const initOptions = {};
  if (process.env.TCB_ENV_ID) initOptions.env = process.env.TCB_ENV_ID;
  // 本地调试时若配置了密钥，则使用长期密钥；云托管内自动走临时密钥
  if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
    initOptions.secretId = process.env.TCB_SECRET_ID;
    initOptions.secretKey = process.env.TCB_SECRET_KEY;
  } else if (process.env.SECRET_ID && process.env.SECRET_KEY) {
    initOptions.secretId = process.env.SECRET_ID;
    initOptions.secretKey = process.env.SECRET_KEY;
  }
  app = cloudbase.init(initOptions);
  return app;
}

// CloudBase SDK 的存储能力直接挂在 app 实例上
function uploadFile(params, opts) { return getApp().uploadFile(params, opts); }
function getTempFileURL(params, opts) { return getApp().getTempFileURL(params, opts); }
function downloadFile(params, opts) { return getApp().downloadFile(params, opts); }

// 体验版/云托管环境的 COS bucket ID 是固定的，通过上传元数据 URL 提取一次后缓存
let cachedBucketId = null;
async function getBucketId() {
  if (cachedBucketId) return cachedBucketId;
  const meta = await getApp().getUploadMetadata({ cloudPath: 'data/bucket-id.txt' });
  const url = meta && meta.data && meta.data.url;
  const m = String(url).match(/https:\/\/([^/]+)\.cos\./);
  cachedBucketId = m ? m[1] : null;
  if (!cachedBucketId) throw new Error('无法从 CloudBase 获取存储 bucket ID');
  return cachedBucketId;
}

async function getFileID(cloudPath) {
  const envId = process.env.TCB_ENV_ID;
  if (!envId) throw new Error('缺少 TCB_ENV_ID 环境变量');
  const bucketId = await getBucketId();
  const p = String(cloudPath).replace(/^\//, '');
  return `cloud://${envId}.${bucketId}/${p}`;
}

module.exports = { isCloudbase, getApp, uploadFile, getTempFileURL, downloadFile, getBucketId, getFileID };
