const cloudbase = require('@cloudbase/node-sdk');

// CloudBase 环境 ID 兜底：云托管容器有时会只注入 TENCENTCLOUD_RUNENV 而不注入
// TENCENTCLOUD_ENVIRONMENT，导致 getFileID 解析不到环境而读不到数据。这里加一个
// 已知固定环境 ID 作为最后兜底，保证线上容器一定能读到云存储。
const FALLBACK_ENV_ID = 'bb-report-d2gr91hv62acb5c37';

function resolveEnvId() {
  return process.env.TENCENTCLOUD_ENVIRONMENT || process.env.TCB_ENV_ID || FALLBACK_ENV_ID;
}

// 是否运行在 CloudBase 云托管环境中
// 云托管会注入 TCB_ENV_ID / TENCENTCLOUD_ENVIRONMENT / TENCENTCLOUD_RUNENV 等环境变量，
// 同时会注入临时凭据 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY。
function isCloudbase() {
  const hasEnv = !!(process.env.TENCENTCLOUD_ENVIRONMENT || process.env.TCB_ENV_ID || process.env.TENCENTCLOUD_RUNENV);
  const hasTempCreds = !!(process.env.TENCENTCLOUD_SECRETID && process.env.TENCENTCLOUD_SECRETKEY);
  return hasEnv || hasTempCreds;
}

let app = null;
function getApp() {
  if (app) return app;
  const initOptions = {};
  // 云托管容器会注入临时凭据；本地调试可显式配置 TCB_SECRET_ID/TCB_SECRET_KEY
  const envId = resolveEnvId();
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

// 体验版/云托管环境的 COS bucket ID 是固定的。为避免因元数据服务偶发不可达
// 导致整条读取链路失败（进而缓存被卡成空），这里把已知稳定的 bucket ID 作为兜底。
const FALLBACK_BUCKET_ID = '6262-bb-report-d2gr91hv62acb5c37-1463806387';

let cachedBucketId = null;
async function getBucketId() {
  if (cachedBucketId) return cachedBucketId;
  try {
    const meta = await getApp().getUploadMetadata({ cloudPath: 'data/bucket-id.txt' });
    const url = meta && meta.data && meta.data.url;
    const m = String(url).match(/https:\/\/([^/]+)\.cos\./);
    cachedBucketId = m ? m[1] : null;
  } catch (e) {
    cachedBucketId = null;
  }
  // 元数据服务失败时用兜底，保证读取不中断
  if (!cachedBucketId) cachedBucketId = FALLBACK_BUCKET_ID;
  return cachedBucketId;
}

async function getFileID(cloudPath) {
  const envId = resolveEnvId();
  if (!envId) throw new Error('缺少 TENCENTCLOUD_ENVIRONMENT/TCB_ENV_ID 环境变量');
  const bucketId = await getBucketId();
  const p = String(cloudPath).replace(/^\//, '');
  return `cloud://${envId}.${bucketId}/${p}`;
}

module.exports = { isCloudbase, getApp, uploadFile, getTempFileURL, downloadFile, getBucketId, getFileID };
