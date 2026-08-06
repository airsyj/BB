const { isCloudbase } = require('./cloudbase');
const fileStore = require('./store-file');
const cloudstorageStore = require('./store-cloudstorage');

// 统一导出 store 接口：云托管用 CloudBase 云存储持久化 JSON + 图片；本地用文件系统
// 所有接口均为 Promise，调用方统一 await

const s = isCloudbase() ? cloudstorageStore : fileStore;

module.exports = {
  add: (r) => s.add(r),
  all: () => s.all(),
  findById: (id) => s.findById(id),
  lookup: (q) => s.lookup(q),
  mergeFields: (list, keys) => s.mergeFields(list, keys),
  load: () => s.load(),
  ownerOf: (r) => s.ownerOf(r),
  mine: (q) => s.mine(q),
  update: (id, fields) => s.update(id, fields),
  conflicts: (q) => s.conflicts(q),
  listNotices: () => s.listNotices(),
  addNotice: (text, by) => s.addNotice(text, by),
  deleteNotice: (id) => s.deleteNotice(id),
  replaceAll: (arr) => s.replaceAll(arr),
};
