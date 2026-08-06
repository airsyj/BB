const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { isCloudbase, uploadFile: cbUpload, getTempFileURL: cbTempUrl, getFileID, downloadFile: cbDownload } = require('./cloudbase');

// 本地上传目录：支持绝对路径（云挂载）和相对路径
const LOCAL_UPLOADS_DIR = path.isAbsolute(config.uploadsDir)
  ? config.uploadsDir
  : path.join(process.cwd(), config.uploadsDir);

// 判断字符串是否是 base64 图片
function isDataUrl(val) {
  return typeof val === 'string' && val.startsWith('data:image/');
}

// 保存 base64 图片，云端上传到云存储，本地落盘
async function savePhoto(val) {
  if (!isDataUrl(val)) return val;
  const m = val.match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return '';
  const ext = m[1].split('/')[1] === 'jpeg' ? 'jpg' : m[1].split('/')[1];
  const buf = Buffer.from(m[2], 'base64');
  const name = crypto.randomBytes(10).toString('hex') + '.' + ext;

  if (isCloudbase()) {
    const cloudPath = 'uploads/' + name;
    await cbUpload({ cloudPath, fileContent: buf });
    return cloudPath;
  }

  fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_UPLOADS_DIR, name), buf);
  return name;
}

// 递归处理对象中所有 base64 图片字段
async function persistPhotos(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) {
    out[k] = await savePhoto(fields[k]);
  }
  return out;
}

// 读取图片：本地返回 Buffer；云端返回临时 URL（302 重定向）或下载后返回 Buffer
async function readPhoto(pathOrName) {
  const p = String(pathOrName || '').trim();
  if (!p) return null;

  if (isCloudbase()) {
    const cloudPath = p.startsWith('uploads/') ? p : 'uploads/' + p;
    const fileID = await getFileID(cloudPath);
    const res = await cbTempUrl({ fileList: [fileID] });
    const url = res && res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
    if (url) return { type: 'redirect', url };
    return null;
  }

  const filePath = path.join(LOCAL_UPLOADS_DIR, path.basename(p));
  if (!fs.existsSync(filePath)) return null;
  return { type: 'buffer', buffer: fs.readFileSync(filePath) };
}

// 读取图片字节（始终返回 Buffer，云端经 cbDownload 下载，本地读文件）。
// 用于后台生成拼图等需要同源字节、避免 canvas 被跨域污染的场景。
async function readPhotoBuffer(pathOrName) {
  const p = String(pathOrName || '').trim();
  if (!p) return null;
  if (isCloudbase()) {
    const cloudPath = p.startsWith('uploads/') ? p : 'uploads/' + p;
    const fileID = await getFileID(cloudPath);
    const res = await cbDownload({ fileID });
    const buf = res && res.fileContent;
    return buf || null;
  }
  const filePath = path.join(LOCAL_UPLOADS_DIR, path.basename(p));
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

module.exports = { isDataUrl, savePhoto, persistPhotos, readPhoto, readPhotoBuffer, LOCAL_UPLOADS_DIR };
