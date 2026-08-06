const TYPE_LABEL = { personnel: '人员', vehicle: '车辆/司机', material_in: '物资进场', material_out: '物资出场' };

function getToken() {
  const t = document.getElementById('token').value.trim();
  if (t) { localStorage.setItem('adminToken', t); return t; }
  return localStorage.getItem('adminToken') || '';
}

async function loadList() {
  const token = getToken();
  if (!token) return alert('请输入管理 token');
  try {
    const date = document.getElementById('date').value;
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    let q = '/api/reports?token=' + encodeURIComponent(token);
    if (date) q += '&date=' + encodeURIComponent(date);
    if (dateFrom) q += '&dateFrom=' + encodeURIComponent(dateFrom);
    if (dateTo) q += '&dateTo=' + encodeURIComponent(dateTo);
    const r = await fetch(q);
    const j = await r.json();
    if (!j.ok) return alert('token 错误或无数据');
    const tb = document.querySelector('#tbl tbody');
    tb.innerHTML = '';
    j.list.forEach((it) => {
      const tr = document.createElement('tr');
      const badge = it.isRenewal
        ? '<span class="badge ren">续期</span>'
        : '<span class="badge new">新办</span>';
      const name = it.name || it.plate || '-';
      const action = it.type === 'vehicle'
        ? `<button class="btn secondary" style="width:auto;padding:5px 10px" onclick="composeCollage('${it.id}')">证件拼图</button>`
        : '';
      tr.innerHTML = `<td>${it.id}</td><td>${TYPE_LABEL[it.type] || it.type}</td><td>${name}</td>` +
        `<td>${it.idNumber || '-'}</td><td>${it.phone || '-'}</td><td>${it.createdAtStr}</td>` +
        `<td>${it.passExpiry || '-'}</td><td>${badge}</td><td>${action}</td>`;
      tb.appendChild(tr);
    });
    const dateLabel = date ? `${date} 当天` : (dateFrom || dateTo ? `${dateFrom || '起'} ~ ${dateTo || '今'}` : '全部日期');
    document.getElementById('stat').textContent = `${dateLabel}：共 ${j.list.length} 条记录`;
  } catch (e) {
    alert('加载失败');
  }
}

document.querySelectorAll('.dl-btns a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const token = getToken();
    if (!token) return alert('请先填写 token 并连接');
    const type = a.dataset.type;
    const date = document.getElementById('date').value;
    const dateFrom = document.getElementById('dateFrom').value;
    const dateTo = document.getElementById('dateTo').value;
    let q = `/api/export?type=${type}&token=${encodeURIComponent(token)}`;
    if (date) q += `&date=${encodeURIComponent(date)}`;
    if (dateFrom) q += `&dateFrom=${encodeURIComponent(dateFrom)}`;
    if (dateTo) q += `&dateTo=${encodeURIComponent(dateTo)}`;
    window.location.href = q;
  });
});

// ---- 车辆证件四合一拼图（行驶证正副 + 驾驶证正副），原图像素合成，可直接打印/下载 ----
async function composeCollage(id) {
  const token = getToken();
  if (!token) return alert('请先填写 token 并连接');
  try {
    const r = await fetch('/api/report/' + encodeURIComponent(id) + '?token=' + encodeURIComponent(token));
    const j = await r.json();
    if (!j.ok) return alert('获取记录失败：' + (j.error || ''));
    const tiles = await loadTiles(j.record);
    if (!tiles.some((t) => t.img)) return alert('该记录暂无证件图片');
    downloadCollage(tiles, j.record);
  } catch (e) {
    alert('拼图失败：' + (e.message || e));
  }
}

function loadImage(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

// 生成本条记录的四合一拼图画布（驾驶证正/副 + 行驶证正/副），供单条下载与批量打印复用
function buildCollageCanvas(tiles, record) {
  const W = 1500;
  const CAP = 110;
  const GAP = 40;
  const MARGIN = 60;
  const cols = 2;
  const sized = tiles.map((t) => {
    if (!t.img) return { ...t, img: null, tileH: CAP + 420 };
    const h = Math.round(t.img.height * (W / t.img.width));
    return { ...t, tileH: CAP + h };
  });
  const rows = Math.ceil(sized.length / cols);
  const rowHeights = [];
  for (let r = 0; r < rows; r++) {
    let max = 0;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < sized.length) max = Math.max(max, sized[i].tileH);
    }
    rowHeights.push(max);
  }
  const canvasW = MARGIN * 2 + cols * W + (cols - 1) * GAP;
  const canvasH = MARGIN * 2 + rowHeights.reduce((a, b) => a + b, 0) + (rows - 1) * GAP;
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);
  for (let i = 0; i < sized.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = MARGIN + col * (W + GAP);
    let y = MARGIN;
    for (let rr = 0; rr < row; rr++) y += rowHeights[rr] + GAP;
    const t = sized[i];
    ctx.fillStyle = '#1a3c5e';
    ctx.fillRect(x, y, W, CAP);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 60px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(t.label, 24, y + CAP / 2);
    if (t.img) {
      ctx.drawImage(t.img, x, y + CAP, W, t.tileH - CAP);
    } else {
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(x, y + CAP, W, t.tileH - CAP);
      ctx.fillStyle = '#999';
      ctx.font = '48px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('未上传', x + W / 2, y + CAP + (t.tileH - CAP) / 2);
    }
  }
  return canvas;
}

async function loadTiles(record) {
  const f = (record && record.fields) || {};
  const slots = [
    { key: 'v_licenseFront', label: '驾驶证 · 正页' },
    { key: 'v_licenseBack', label: '驾驶证 · 副页' },
    { key: 'v_regFront', label: '行驶证 · 正页' },
    { key: 'v_regBack1', label: '行驶证 · 副页' },
  ];
  const tiles = [];
  for (const s of slots) {
    const p = f[s.key];
    let img = null;
    if (p) img = await loadImage('/api/photobytes?path=' + encodeURIComponent(p) + '&t=' + Date.now());
    tiles.push({ ...s, img });
  }
  return tiles;
}

function recordInfo(record) {
  const f = (record && record.fields) || {};
  return [
    '车牌 ' + (f.plate || '-'),
    '驾驶证姓名 ' + (f.licenseName || f.driverName || '-'),
    '身份证 ' + (f.driverIdNumber || '-'),
    '手机 ' + (f.phone || '-'),
    '提交 ' + (record.createdAtStr || ''),
  ].join(' ｜ ');
}

function downloadCollage(tiles, record) {
  const rec = record || {};
  const f = rec.fields || {};
  const title = (f.plate || f.driverName || f.name || '') + ' 证件拼图';
  const canvas = buildCollageCanvas(tiles, rec);
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '证件拼图_' + (rec.id || Date.now()) + (title ? '_' + title : '') + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
}

// ---- 批量：把当前筛选下的所有车辆报备，按"表格信息 + 四合一拼图"生成为可打印页面 ----
async function exportVehicleCollage() {
  const token = getToken();
  if (!token) return alert('请先填写 token 并连接');
  const date = document.getElementById('date').value;
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;
  let q = '/api/reports?token=' + encodeURIComponent(token) + '&type=vehicle';
  if (date) q += '&date=' + encodeURIComponent(date);
  if (dateFrom) q += '&dateFrom=' + encodeURIComponent(dateFrom);
  if (dateTo) q += '&dateTo=' + encodeURIComponent(dateTo);
  const stat = document.getElementById('dateStat');
  stat.textContent = '正在读取车辆记录…';
  try {
    const r = await fetch(q);
    const j = await r.json();
    if (!j.ok) { stat.textContent = ''; return alert('加载失败：' + (j.error || '')); }
    const list = j.list || [];
    if (!list.length) { stat.textContent = ''; return alert('当前筛选下没有车辆报备记录'); }
    const cards = [];
    for (let i = 0; i < list.length; i++) {
      stat.textContent = `正在生成拼图 ${i + 1}/${list.length}…`;
      const rec = await (await fetch('/api/report/' + encodeURIComponent(list[i].id) + '?token=' + encodeURIComponent(token))).json();
      if (!rec.ok) continue;
      const tiles = await loadTiles(rec.record);
      const canvas = buildCollageCanvas(tiles, rec.record);
      cards.push({ id: list[i].id, info: recordInfo(rec.record), dataUrl: canvas.toDataURL('image/jpeg', 0.9) });
    }
    if (!cards.length) { stat.textContent = ''; return alert('没有可导出的证件图片'); }
    openPrintWindow(cards);
    stat.textContent = '';
  } catch (e) {
    stat.textContent = '';
    alert('批量拼图失败：' + (e.message || e));
  }
}

function openPrintWindow(cards) {
  const w = window.open('', '_blank');
  if (!w) { alert('浏览器拦截了打印窗口，请允许弹出窗口后重试'); return; }
  const rows = cards.map((c) =>
    `<div class="card-print">
       <div class="cap">${escapeHtml(c.info)}</div>
       <img src="${c.dataUrl}" />
     </div>`).join('');
  w.document.write(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />
    <title>车辆证件四合一拼图</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: "Microsoft YaHei","PingFang SC",sans-serif; margin: 0; padding: 16px; color: #222; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      .card-print { border: 1px solid #ccc; border-radius: 8px; padding: 10px; margin-bottom: 16px; page-break-inside: avoid; }
      .cap { font-size: 13px; margin-bottom: 8px; color: #1a3c5e; font-weight: bold; }
      img { width: 100%; height: auto; display: block; }
      @media print { body { padding: 0; } .card-print { break-inside: avoid; } }
    </style></head><body>
    <h1>车辆报备 · 驾驶证/行驶证四合一拼图（共 ${cards.length} 条）</h1>
    ${rows}
    <script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };</script>
    </body></html>`);
  w.document.close();
}

// ---- 批量导入 xlsx ----
async function doImport() {
  const token = getToken();
  if (!token) return alert('请先填写 token 并连接');
  const fileEl = document.getElementById('importFile');
  const file = fileEl.files && fileEl.files[0];
  if (!file) return alert('请先选择 xlsx 文件');
  const stat = document.getElementById('importStat');
  stat.textContent = '正在导入…';
  stat.className = 'hint';
  try {
    const dataUrl = await fileToDataUrl(file);
    const r = await fetch('/api/import?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: dataUrl }),
    });
    const j = await r.json();
    if (j.ok) {
      stat.textContent = `导入成功：新增 ${j.count} 条，跳过空行 ${j.skipped || 0} 条。刷新列表可见，后续报备可自动填充。`;
      stat.className = 'hint ok';
      loadList();
    } else {
      stat.textContent = '导入失败：' + (j.error || '');
      stat.className = 'hint err';
    }
  } catch (e) {
    stat.textContent = '导入失败：' + (e.message || e);
    stat.className = 'hint err';
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

// ---- 通知管理（超级管理员） ----
async function publishNotice() {
  const token = getToken();
  if (!token) return alert('请先填写 token 并连接');
  const text = document.getElementById('noticeText').value.trim();
  if (!text) return alert('通知内容不能为空');
  try {
    const r = await fetch('/api/notices?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const j = await r.json();
    if (j.ok) {
      document.getElementById('noticeText').value = '';
      document.getElementById('noticeStat').textContent = '已发布 ✓';
      document.getElementById('noticeStat').className = 'hint ok';
      loadNoticesAdmin();
    } else {
      document.getElementById('noticeStat').textContent = '发布失败：' + (j.error || '');
      document.getElementById('noticeStat').className = 'hint err';
    }
  } catch (e) {
    alert('发布失败，请重试');
  }
}

async function loadNoticesAdmin() {
  const token = getToken();
  if (!token) return;
  try {
    const r = await fetch('/api/notices?token=' + encodeURIComponent(token));
    const j = await r.json();
    if (!j.ok) return;
    const box = document.getElementById('noticeList');
    if (!j.list.length) { box.innerHTML = '<div class="hint">暂无已发布通知</div>'; return; }
    box.innerHTML = j.list.map((n) =>
      `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
         <div style="flex:1">${escapeHtml(n.text)}</div>
         <button class="btn secondary" style="width:auto;padding:6px 12px" onclick="deleteNoticeAdmin('${n.id}')">撤回</button>
       </div>`).join('');
  } catch (e) { /* 忽略 */ }
}

async function deleteNoticeAdmin(id) {
  const token = getToken();
  if (!token) return;
  if (!confirm('确定撤回该通知？')) return;
  try {
    await fetch('/api/notices?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(token), { method: 'DELETE' });
    loadNoticesAdmin();
  } catch (e) { alert('撤回失败'); }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 清空所有日期筛选 → 查看/导出全部
function clearDates() {
  document.getElementById('date').value = '';
  document.getElementById('dateFrom').value = '';
  document.getElementById('dateTo').value = '';
  loadList();
}

// 初始尝试用已保存的 token 连接；默认不填日期 = 全部
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('adminToken');
  if (saved) document.getElementById('token').value = saved;
  const dateEl = document.getElementById('date');
  const fromEl = document.getElementById('dateFrom');
  const toEl = document.getElementById('dateTo');
  // 单日与区间二选一：填其一自动清空另一个
  dateEl.addEventListener('change', () => {
    if (dateEl.value) { fromEl.value = ''; toEl.value = ''; }
    loadList();
  });
  fromEl.addEventListener('change', () => {
    if (fromEl.value || toEl.value) dateEl.value = '';
    loadList();
  });
  toEl.addEventListener('change', () => {
    if (fromEl.value || toEl.value) dateEl.value = '';
    loadList();
  });
  if (saved) { loadList(); loadNoticesAdmin(); }
});
