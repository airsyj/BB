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
    window.location.href = `/api/export?type=${type}&token=${encodeURIComponent(token)}`;
  });
});

// 初始尝试用已保存的 token 连接，默认当天日期
window.addEventListener('DOMContentLoaded', () => {
  setToday();
  const saved = localStorage.getItem('adminToken');
  if (saved) { document.getElementById('token').value = saved; loadList(); }
  document.getElementById('date').addEventListener('change', loadList);
});
