const cloudbase = require('@cloudbase/node-sdk');

// 是否运行在 CloudBase 云托管环境中
// 云托管会注入 TCB_ENV_ID 等环境变量，SDK 可自动获取临时凭据
function isCloudbase() {
  return !!(process.env.TENCENTCLOUD_ENVIRONMENT || process.env.TCB_ENV_ID || process.env.TENCENTCLOUD_RUNENV);
}

let app = null;
function getApp() {
  if (app) return app;
  const initOptions = {};
  // 云托管容器会注入临时凭据；本地调试可显式配置 TCB_SECRET_ID/TCB_SECRET_KEY
  const envId = process.env.TENCENTCLOUD_ENVIRONMENT || process.env.TCB_ENV_ID;
  if (envId) initOptions.env = envId;

  const tempId = process.env.TENCENTCLOUD_SECRETID;
  const tempKey = process.env.TENCENTCLOUD_SECRETKEY;
  const tempToken = process.env.TENCENTCLOUD_SESSIONTOKEN;
  if (tempId && tempKey) {
    initOptions.secretId = tempId;
    initOptions.secretKey = tempKey;
    if (tempToken) initOptions.sessionToken = tempToken;
  } else if (process.env.TCB_SECRET_ID && process.env.TCB_SECRET_KEY) {
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
  const envId = process.env.TENCENTCLOUD_ENVIRONMENT || process.env.TCB_ENV_ID;
  if (!envId) throw new Error('缺少 TENCENTCLOUD_ENVIRONMENT/TCB_ENV_ID 环境变量');
  const bucketId = await getBucketId();
  const p = String(cloudPath).replace(/^\//, '');
  return `cloud://${envId}.${bucketId}/${p}`;
}

module.exports = { isCloudbase, getApp, uploadFile, getTempFileURL, downloadFile, getBucketId, getFileID };
