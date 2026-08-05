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
    const q = '/api/reports?token=' + encodeURIComponent(token) + (date ? '&date=' + encodeURIComponent(date) : '');
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
      tr.innerHTML = `<td>${it.id}</td><td>${TYPE_LABEL[it.type] || it.type}</td><td>${name}</td>` +
        `<td>${it.idNumber || '-'}</td><td>${it.phone || '-'}</td><td>${it.createdAtStr}</td>` +
        `<td>${it.passExpiry || '-'}</td><td>${badge}</td>`;
      tb.appendChild(tr);
    });
    const dateLabel = date ? `${date} 当天` : '全部日期';
    document.getElementById('stat').textContent = `${dateLabel}：共 ${j.list.length} 条记录`;
  } catch (e) {
    alert('加载失败');
  }
}

function setToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  document.getElementById('date').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

document.querySelectorAll('.dl-btns a').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    const token = getToken();
    if (!token) return alert('请先填写 token 并连接');
    const type = a.dataset.type;
    const date = document.getElementById('date').value;
    const q = `/api/export?type=${type}&token=${encodeURIComponent(token)}` + (date ? `&date=${encodeURIComponent(date)}` : '');
    window.location.href = q;
  });
});

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

// 初始尝试用已保存的 token 连接，默认当天日期
window.addEventListener('DOMContentLoaded', () => {
  setToday();
  const saved = localStorage.getItem('adminToken');
  if (saved) { document.getElementById('token').value = saved; loadList(); loadNoticesAdmin(); }
  document.getElementById('date').addEventListener('change', loadList);
});
