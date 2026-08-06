// 生成与用户提供的 Excel 模板结构一致的报表（含样式：列宽24、行高15、有内容处有框线）
const ExcelJS = require('exceljs');
const store = require('./store');
const { reportDate } = require('./record-date');

const PERSONNEL_HEADER = [
  '证件类型(*)', '证件号码(*)', '人员姓名(*)', '手机号码(*)', '临时出入证编码',
  '是否新办', '是否携带笔记本电脑(*)', '品牌/型号', '数量', '证件分级分类',
  '访客照片', '车辆类型', '车牌号', '车辆品牌', '车辆型号',
  '通行证到期日',
];

const MATERIAL_HEADER = [
  '图号', '物品名称(*)', '计量单位(*)', '物品数量(*)', '材质', '材质规格',
  '尺寸', '重量', '材料牌号', '备注', '关联车辆',
  '驾驶员姓名', '驾驶员身份证号', '驾驶员电话',
  '进场/出场时间', '报备类型',
];

function personnelRow(f, isRenewal, passExpiry) {
  // 数量：仅当“携带笔记本 = 是”才填写，否则留空；未填写是否携带时默认“否”
  const qty = f.carryLaptop === '是' ? (f.laptopQty || '1') : '';
  return [
    '身份证', f.idNumber || '', f.name || '', f.phone || '', f.passNo || '',
    isRenewal ? '否' : (f.isNew || '是'),
    f.carryLaptop || '否', f.laptopModel || '', qty,
    f.certClass || '', f.visitorPhoto || '', f.vehicleType || '', f.plate || '',
    f.vehicleBrand || '', f.vehicleModel || '',
    passExpiry || '',
  ];
}

function driverRow(f, isRenewal, passExpiry) {
  const qty = f.carryLaptop === '是' ? (f.laptopQty || '1') : '';
  return [
    '身份证', f.driverIdNumber || '', f.driverName || '', f.phone || '', f.passNo || '',
    isRenewal ? '否' : (f.isNew || '是'),
    f.carryLaptop || '否', '', '', f.certClass || '', '', f.vehicleType || '',
    f.plate || '', f.vehicleBrand || '', f.vehicleModel || '',
    passExpiry || '',
  ];
}

function materialRow(f, type) {
  const time = type === 'material_in' ? f.entryTime : f.exitTime;
  return [
    f.drawingNo || '', f.itemName || '', f.unit || '', f.qty || '', f.material || '',
    f.spec || '', f.size || '', f.weight || '', f.grade || '', f.remark || '',
    f.plate || '',  // 关联车辆：仅车牌号（品牌/型号见驾驶员信息，不在本表重复）
    f.driverName || '', f.driverIdNumber || '', f.driverPhone || '',
    time || '', type === 'material_in' ? '进场' : '出场',
  ];
}

const thin = () => ({
  top: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
});

function buildSheet(workbook, name, header, rows) {
  const ws = workbook.addWorksheet(name);
  ws.getCell(1, 1).value = '公开';           // 首行匹配模板
  header.forEach((h, i) => { ws.getCell(2, i + 1).value = h; });
  rows.forEach((rowArr, ri) => {
    rowArr.forEach((v, i) => {
      ws.getCell(3 + ri, i + 1).value = (v === '' || v == null) ? null : v;
    });
  });
  // 列宽 24 字符
  for (let c = 1; c <= header.length; c++) ws.getColumn(c).width = 24;
  // 行高 15 磅（含“公开”行与表头）
  for (let r = 1; r <= ws.rowCount; r++) ws.getRow(r).height = 15;
  // 有内容的行与列：整块数据区（含空单元格）加实线框，形成完整网格
  let lastRow = 1;
  for (let r = 1; r <= ws.rowCount; r++) {
    let has = false;
    for (let c = 1; c <= header.length; c++) {
      const v = ws.getCell(r, c).value;
      if (v !== null && v !== undefined && v !== '') { has = true; break; }
    }
    if (has) lastRow = r;
  }
  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= header.length; c++) {
      ws.getCell(r, c).border = thin();
    }
  }
  return ws;
}

async function exportType(type, opts) {
  opts = opts || {};
  const { date, dateFrom, dateTo, dates } = opts;
  const dateOf = (r) => (opts.reportDate ? opts.reportDate(r) : reportDate(r));
  const dateSet = (dates && dates.length) ? new Set(dates) : null;
  let all = await store.all();
  // 按“多个具体日期集合” / 单日 / 日期区间筛选（YYYY-MM-DD 字符串可直接字典序比较）
  // 日期口径统一以报备编号为精确依据（reportDate）
  if (dateSet) {
    all = all.filter((r) => dateSet.has(dateOf(r)));
  } else if (date) {
    all = all.filter((r) => dateOf(r) === date);
  } else if (dateFrom || dateTo) {
    all = all.filter((r) => {
      const d = dateOf(r);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });
  }
  const wb = new ExcelJS.Workbook();
  if (type === 'all' || type === 'personnel') {
    const data = all.filter((r) => r.type === 'personnel')
      .map((r) => personnelRow(r.fields, r.isRenewal, r.passExpiry));
    buildSheet(wb, '人员信息', PERSONNEL_HEADER, data);
  }
  if (type === 'all' || type === 'vehicle') {
    const data = all.filter((r) => r.type === 'vehicle')
      .map((r) => driverRow(r.fields, r.isRenewal, r.passExpiry));
    buildSheet(wb, '司机信息', PERSONNEL_HEADER, data);
  }
  if (type === 'all' || type === 'material_in') {
    const data = all.filter((r) => r.type === 'material_in')
      .map((r) => materialRow(r.fields, 'material_in'));
    buildSheet(wb, '物资进场明细', MATERIAL_HEADER, data);
  }
  if (type === 'all' || type === 'material_out') {
    const data = all.filter((r) => r.type === 'material_out')
      .map((r) => materialRow(r.fields, 'material_out'));
    buildSheet(wb, '物资出场明细', MATERIAL_HEADER, data);
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { exportType };
