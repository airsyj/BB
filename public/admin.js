const TYPE_LABEL = { personnel: '人员', vehicle: '车辆/司机', material_in: '物资进场', material_out: '物资出场', all: '全部' };

function getToken() { return localStorage.getItem('adminToken') || ''; }
function setToken(t) { if (t) localStorage.setItem('adminToken', t); }
function showGate(msg) {
  document.getElementById('loginGate').style.display = 'flex';
  document.getElementById('appMain').style.display = 'none';
  if (msg) document.getElementById('loginErr').textContent = msg;
}

// ---- 登录遮罩：用管理密码（即后台 token）校验，通过后才展示后台 ----
async function login() {
  const pwd = (document.getElementById('loginPwd').value || '').trim();
  const errEl = document.getElementById('loginErr');
  if (!pwd) { errEl.textContent = '请输入管理密码'; return; }
  try {
    const r = await fetch('/api/reports?token=' + encodeURIComponent(pwd));
    const j = await r.json();
    if (j.ok) {
      setToken(pwd);
      errEl.textContent = '';
      document.getElementById('loginGate').style.display = 'none';
      document.getElementById('appMain').style.display = 'block';
      loadList(); loadNoticesAdmin(); loadDateHints();
    } else {
      errEl.textContent = '密码错误，无法进入';
    }
  } catch (e) {
    errEl.textContent = '网络错误，请重试';
  }
}

// ---- 日历状态 ----
let selDates = new Set();
let viewY = new Date().getFullYear();
let viewM = new Date().getMonth();
let hasDataDates = new Set();
let currentList = [];

function fmtLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 加载列表并渲染表格（默认全部，可按 selDates 筛选）
async function loadList() {
  const token = getToken();
  if (!token) { showGate('请先输入管理密码'); return; }
  try {
    let q = '/api/reports?token=' + encodeURIComponent(token);
    if (selDates.size) q += '&dates=' + encodeURIComponent(Array.from(selDates).join(','));
    const r = await fetch(q);
    const j = await r.json();
    if (!j.ok) { showGate('密码已失效，请重新输入'); return; }
    currentList = j.list || [];
    renderTable(applySearch(currentList));
    const dateLabel = selDates.size
      ? `已选 ${Array.from(selDates).sort().join('、')} 共 ${selDates.size} 天`
      : '全部日期（含历史记录）';
    document.getElementById('stat').textContent = `${dateLabel}：共 ${currentList.length} 条记录`;
  } catch (e) {
    alert('加载失败');
  }
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function applySearch(list) {
  const t = (document.getElementById('searchBox').value || '').trim().toLowerCase();
  if (!t) return list;
  return list.filter((x) => [x.id, x.name, x.idNumber, x.phone, x.plate].some((v) => String(v || '').toLowerCase().includes(t)));
}
function doSearch() { renderTable(applySearch(currentList)); document.getElementById('recHint').textContent = `搜索结果：${applySearch(currentList).length} 条`; }
function clearSearch() { document.getElementById('searchBox').value = ''; renderTable(applySearch(currentList)); document.getElementById('recHint').textContent = ''; }

function renderTable(list) {
  const body = document.getElementById('recBody');
  if (!list.length) { body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">无记录</td></tr>'; return; }
  const TYPE = { personnel: '人员', vehicle: '车辆/司机', material_in: '物资进场', material_out: '物资出场' };
  body.innerHTML = list.map((x) => `<tr>
    <td>${esc(x.id || '')}</td>
    <td>${TYPE[x.type] || x.type || ''}</td>
    <td>${esc(x.name || '')}</td>
    <td>${esc(x.idNumber || '')}</td>
    <td>${esc(x.phone || '')}</td>
    <td>${esc(x.plate || '')}</td>
    <td>${esc(x.date || x.createdAtStr || '')}</td>
    <td>${x.isRenewal ? '<span class="badge ren">续期</span>' : '<span class="badge new">新办</span>'}</td>
  </tr>`).join('');
}

// 下载按钮
document.querySelectorAll('.dl-btns a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    downloadType(a.dataset.type);
  });
});

function typeLabel(type) {
  return ({ personnel: '人员信息', vehicle: '司机信息', material_in: '物资进场', material_out: '物资出场', all: '全部' })[type] || type;
}

function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function canvasToBlob(canvas, type) {
  return new Promise((res) => canvas.toBlob((b) => res(b), type || 'image/png'));
}

async function makeZip(files) {
  const zip = new JSZip();
  files.forEach((f) => zip.file(f.name, f.blob));
  return await zip.generateAsync({ type: 'blob' });
}

async function downloadType(type) {
  const token = getToken();
  if (!token) return showGate('请先登录');
  let lq = '/api/reports?token=' + encodeURIComponent(token) + '&type=' + type;
  if (selDates.size) lq += '&dates=' + encodeURIComponent(Array.from(selDates).join(','));
  const lr = await fetch(lq);
  const lj = await lr.json();
  if (!lj.ok) return showGate('密码已失效，请重新输入');
  const list = (lj.list || []).filter((x) => type === 'all' || x.type === type);
  if (!list.length) {
    return alert('当前筛选下没有「' + typeLabel(type) + '」记录。\n可点“全选”导出全部，或选择带蓝点的日期。');
  }
  const stat = document.getElementById('stat');
  stat.textContent = '正在生成报表…';
  try {
    let eq = '/api/export?type=' + type + '&token=' + encodeURIComponent(token);
    if (selDates.size) eq += '&dates=' + encodeURIComponent(Array.from(selDates).join(','));
    const xlsxBlob = await (await fetch(eq)).blob();
    const needCollage = (type === 'vehicle' || type === 'all');
    const stamp = fmtLocal(new Date());
    if (!needCollage) {
      triggerDownload(xlsxBlob, `报备明细_${typeLabel(type)}_${stamp}.xlsx`);
      stat.textContent = '';
      return;
    }
    const files = [{ name: `报备明细_${typeLabel(type)}_${stamp}.xlsx`, blob: xlsxBlob }];
    const veh = list.filter((x) => x.type === 'vehicle');
    for (let i = 0; i < veh.length; i++) {
      stat.textContent = `正在生成证件拼图 ${i + 1}/${veh.length}…`;
      const rec = await (await fetch('/api/report/' + encodeURIComponent(veh[i].id) + '?token=' + encodeURIComponent(token))).json();
      if (!rec.ok) continue;
      const tiles = await loadTiles(rec.record);
      if (!tiles.some((t) => t.img)) continue;
      const canvas = buildCollageCanvas(tiles, rec.record);
      const png = await canvasToBlob(canvas, 'image/png');
      const f = (rec.record.fields) || {};
      const tag = (f.plate || f.driverName || rec.record.id);
      files.push({ name: `证件拼图_${tag}_${rec.record.id}.png`, blob: png });
    }
    stat.textContent = '正在打包…';
    const zipBlob = await makeZip(files);
    triggerDownload(zipBlob, `报备明细_${typeLabel(type)}_含证件拼图_${stamp}.zip`);
    stat.textContent = '';
  } catch (e) {
    stat.textContent = '';
    alert('导出失败：' + (e.message || e));
  }
}

// ---- 全选：选中“所有”有报备的日期（跨月份），不再局限于当前月份 ----
async function selectAllDates() {
  const token = getToken();
  if (!token) return showGate('请先登录');
  const stat = document.getElementById('stat');
  stat.textContent = '正在读取全部数据…';
  try {
    if (!hasDataDates.size) {
      const r = await fetch('/api/reports?token=' + encodeURIComponent(token));
      const j = await r.json();
      if (!j.ok) { stat.textContent = ''; return showGate('密码错误'); }
      hasDataDates = new Set((j.list || []).map((x) => x.createdAtStr).filter(Boolean));
    }
    if (!hasDataDates.size) {
      selDates = new Set(); renderCal(); stat.textContent = '暂无任何报备记录'; return;
    }
    selDates = new Set(hasDataDates);
    renderCal();
    loadList();
    stat.textContent = `已全选所有有报备的日期（共 ${selDates.size} 天），点上方按钮即可下载。`;
  } catch (e) {
    stat.textContent = '';
    alert('读取失败');
  }
}

async function loadDateHints() {
  const token = getToken();
  if (!token) return;
  try {
    const r = await fetch('/api/reports?token=' + encodeURIComponent(token));
    const j = await r.json();
    if (!j.ok) return;
    hasDataDates = new Set((j.list || []).map((x) => x.createdAtStr).filter(Boolean));
    renderCal();
  } catch (e) { /* 忽略 */ }
}

// ---- 车辆证件四合一拼图 ----
function loadImage(url) {
  return new Promise((resolve) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
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

// ---- 批量导入 xlsx ----
async function doImport() {
  const token = getToken();
  if (!token) return showGate('请先登录');
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
      loadDateHints();
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

// ---- 通知管理 ----
async function publishNotice() {
  const token = getToken();
  if (!token) return showGate('请先登录');
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

// ---- 日历渲染与交互 ----
function renderCal() {
  const cal = document.getElementById('cal');
  if (!cal) return;
  const dow = ['日', '一', '二', '三', '四', '五', '六'];
  let html = dow.map((d) => `<div class="dow">${d}</div>`).join('');
  const startDow = new Date(viewY, viewM, 1).getDay();
  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const prevDays = new Date(viewY, viewM, 0).getDate();
  for (let i = 0; i < startDow; i++) {
    html += `<div class="day muted">${prevDays - startDow + 1 + i}</div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${viewY}-${String(viewM + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cls = ['day'];
    if (selDates.has(ds)) cls.push('sel');
    if (hasDataDates.has(ds)) cls.push('has');
    html += `<div class="${cls.join(' ')}" data-d="${ds}">${d}</div>`;
  }
  cal.innerHTML = html;
  document.getElementById('calTitle').textContent = `${viewY} 年 ${viewM + 1} 月`;
  cal.querySelectorAll('.day[data-d]').forEach((el) => {
    el.addEventListener('click', () => onDayClick(el.dataset.d));
  });
  renderChips();
}

function onDayClick(ds) {
  if (selDates.has(ds)) selDates.delete(ds);
  else selDates.add(ds);
  renderCal();
  loadList();
}

function renderChips() {
  const box = document.getElementById('selChips');
  if (!box) return;
  const arr = Array.from(selDates).sort();
  box.innerHTML = arr.map((d) => `<span class="chip">${d} <b onclick="removeDate('${d}')">×</b></span>`).join('');
}

function removeDate(d) {
  selDates.delete(d);
  renderCal();
  loadList();
}

// ---- 初始化 ----
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginBtn').addEventListener('click', login);
  document.getElementById('loginPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  document.getElementById('calPrev').addEventListener('click', () => { viewM--; if (viewM < 0) { viewM = 11; viewY--; } renderCal(); });
  document.getElementById('calNext').addEventListener('click', () => { viewM++; if (viewM > 11) { viewM = 0; viewY++; } renderCal(); });
  renderCal();
  // 若已保存密码，自动尝试进入；失败则停留在登录遮罩
  const saved = getToken();
  if (saved) { document.getElementById('loginPwd').value = saved; login(); }
  else showGate();
});
