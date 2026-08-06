// ============ 通用工具 ============
function val(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el && v != null) el.value = v; }
function hint(id, msg, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = 'hint' + (cls ? ' ' + cls : '');
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ============ Tab 切换 ============
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('sec-' + btn.dataset.tab).classList.add('active');
  window.scrollTo(0, 0);
});

// 携带笔记本时显示型号/数量
document.getElementById('p_carryLaptop').addEventListener('change', (e) => {
  document.getElementById('p_laptop_box').classList.toggle('hidden', e.target.value !== '是');
});

// 物资报备：进场/出场切换显隐时间字段
document.getElementById('m_type').addEventListener('change', (e) => {
  const isOut = e.target.value === 'material_out';
  document.getElementById('m_in_box').style.display = isOut ? 'none' : 'block';
  document.getElementById('m_out_box').style.display = isOut ? 'block' : 'none';
});

// ============ 图片压缩 ============
// 证件识别对分辨率敏感：保留较高长边与画质，识别准确率明显更高
function compress(file, maxDim = 2000, quality = 0.92) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const s = Math.max(width, height) / maxDim;
          width = Math.round(width / s);
          height = Math.round(height / s);
        }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => resolve(null);
      img.src = reader.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// ============ 照片上传 + 裁剪 + OCR ============
function setupPhotos() {
  const sheet = document.getElementById('photoSheet');
  let currentSlot = null;
  // 选图后统一走：压缩 → 手动裁剪 → 回填
  document.querySelectorAll('.photo-slot input[type=file]').forEach((input) => {
    input.addEventListener('change', async () => {
      const slot = input.closest('.photo-slot');
      const file = input.files && input.files[0];
      input.value = ''; // 允许重复选择同一张照片
      if (!file) return;
      const dataUrl = await compress(file);
      if (!dataUrl) return;
      // 先进入裁剪弹层，框选证件区域后再识别，提高准确度
      openCropper(dataUrl, (cropped) => {
        slot._dataUrl = cropped;
        const img = slot.querySelector('img');
        img.src = cropped;
        slot.classList.add('done');
        if (slot.dataset.ocr) {
          doOcr(slot, cropped);
        }
      });
    });
  });
  // 点击证件格 → 弹出「拍照 / 从相册选择」
  document.querySelectorAll('.photo-slot').forEach((slot) => {
    slot.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return; // 程序触发 input.click() 时跳过，避免重复处理/取消选择器
      e.preventDefault();
      e.stopPropagation();
      currentSlot = slot;
      sheet.classList.add('show');
    });
  });
  const pick = (useCamera) => {
    sheet.classList.remove('show');
    const slot = currentSlot;
    currentSlot = null;
    if (!slot) return;
    const input = slot.querySelector('input[type=file]');
    if (useCamera) input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    input.click();
  };
  document.getElementById('sheetCamera').addEventListener('click', () => pick(true));
  document.getElementById('sheetAlbum').addEventListener('click', () => pick(false));
  document.getElementById('sheetCancel').addEventListener('click', () => { sheet.classList.remove('show'); currentSlot = null; });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) { sheet.classList.remove('show'); currentSlot = null; } });
  // 电脑端无摄像头：把"拍照"按钮文案改为"选择文件"，避免误导（功能仍有效，走系统文件选择）
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || 'ontouchstart' in window;
  if (!isMobile) {
    const camBtn = document.getElementById('sheetCamera');
    if (camBtn) camBtn.textContent = '📁 选择文件';
  }
}

// ============ 裁剪弹层（四点透视矫正 + 自动检测 + 旋转） ============
const crop = { onConfirm: null, original: null, baseImage: null, srcCanvas: null, displayRect: null, pts: null, rotation: 0, dragIdx: -1, startPtr: null, startPts: null };
let cropEls = null;

function initCropper() {
  cropEls = {
    overlay: document.getElementById('cropOverlay'),
    stage: document.getElementById('cropStage'),
    dim: document.getElementById('cropDim'),
    corners: Array.from(document.querySelectorAll('#cropStage .corner')),
  };
  document.getElementById('cropRotate').addEventListener('click', rotateCrop);
  document.getElementById('cropSkip').addEventListener('click', skipCrop);
  document.getElementById('cropCancel').addEventListener('click', () => cropEls.overlay.classList.remove('show'));
  document.getElementById('cropOk').addEventListener('click', confirmCrop);
  cropEls.corners.forEach((c, i) => {
    c.addEventListener('pointerdown', (e) => { e.preventDefault(); startCorner(e, i); });
  });
  window.addEventListener('pointermove', onDrag);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('resize', () => { if (cropEls.overlay.classList.contains('show')) layoutCrop(); });
}

function openCropper(dataUrl, onConfirm) {
  const img = new Image();
  img.onload = () => {
    crop.baseImage = img;
    crop.original = dataUrl;
    crop.rotation = 0;
    crop.pts = null;
    crop.onConfirm = onConfirm;
    cropEls.overlay.classList.add('show');
    buildSrc();
  };
  img.onerror = () => onConfirm(dataUrl); // 异常时退回原图
  img.src = dataUrl;
}

// 跳过裁剪，直接使用原图
function skipCrop() {
  cropEls.overlay.classList.remove('show');
  const fallback = (crop.srcCanvas && crop.srcCanvas.toDataURL('image/jpeg', 0.94)) || crop.original;
  if (crop.onConfirm) crop.onConfirm(fallback);
}

function buildSrc() {
  const base = crop.baseImage;
  const rot = ((crop.rotation % 4) + 4) % 4;
  const w = base.naturalWidth, h = base.naturalHeight;
  const cw = (rot % 2 === 0) ? w : h;
  const ch = (rot % 2 === 0) ? h : w;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rot * Math.PI / 2);
  ctx.drawImage(base, -w / 2, -h / 2);
  ctx.restore();
  crop.srcCanvas = c;
  crop.pts = null;
  layoutCrop();
}

// 计算照片在舞台中的“包含式”显示矩形（contain），坐标相对 stage 左上角
function computeDisplayRect() {
  const s = cropEls.stage.getBoundingClientRect();
  const sw = s.width, sh = s.height;
  if (!sw || !sh || !crop.srcCanvas) return null;
  const cw = crop.srcCanvas.width, ch = crop.srcCanvas.height;
  const aspect = cw / ch;
  let dw, dh;
  if (sw / sh > aspect) { dh = sh * 0.96; dw = dh * aspect; }
  else { dw = sw * 0.96; dh = dw / aspect; }
  return { x: (sw - dw) / 2, y: (sh - dh) / 2, w: dw, h: dh, stageW: sw, stageH: sh };
}

function layoutCrop() {
  if (!crop.srcCanvas) return;
  const rect = computeDisplayRect();
  if (!rect) return;
  crop.displayRect = rect;
  if (!crop.pts) {
    crop.pts = [
      { x: rect.x + rect.w * 0.08, y: rect.y + rect.h * 0.08 }, // 左上
      { x: rect.x + rect.w * 0.92, y: rect.y + rect.h * 0.08 }, // 右上
      { x: rect.x + rect.w * 0.92, y: rect.y + rect.h * 0.92 }, // 右下
      { x: rect.x + rect.w * 0.08, y: rect.y + rect.h * 0.92 }, // 左下
    ];
  }
  drawCrop();
}

function drawCrop() {
  const d = crop.displayRect;
  if (!d) return;
  const cv = cropEls.dim;
  const dpr = window.devicePixelRatio || 1;
  const sw = d.stageW, sh = d.stageH;
  cv.style.left = '0px';
  cv.style.top = '0px';
  cv.style.width = sw + 'px';
  cv.style.height = sh + 'px';
  cv.width = Math.round(sw * dpr);
  cv.height = Math.round(sh * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sw, sh);
  // 1) 直接把照片画进画布（包含式居中）
  ctx.drawImage(crop.srcCanvas, d.x, d.y, d.w, d.h);
  // 2) 四边形孔洞之外铺暗（even-odd 填充：外矩形 - 内四边形）
  const p = crop.pts;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, sw, sh);
  ctx.moveTo(p[0].x, p[0].y);
  ctx.lineTo(p[1].x, p[1].y);
  ctx.lineTo(p[2].x, p[2].y);
  ctx.lineTo(p[3].x, p[3].y);
  ctx.closePath();
  ctx.fill('evenodd');
  // 3) 描边四边形
  ctx.strokeStyle = '#2e9bff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.closePath();
  ctx.stroke();
  cropEls.corners.forEach((c, i) => {
    c.style.left = crop.pts[i].x + 'px';
    c.style.top = crop.pts[i].y + 'px';
  });
}

function ptrPos(e) {
  const r = cropEls.stage.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function startCorner(e, i) {
  crop.dragIdx = i;
  crop.startPtr = ptrPos(e);
  crop.startPts = crop.pts.map((q) => ({ x: q.x, y: q.y }));
}
function onDrag(e) {
  if (crop.dragIdx < 0) return;
  const p = ptrPos(e);
  const dx = p.x - crop.startPtr.x, dy = p.y - crop.startPtr.y;
  const d = crop.displayRect;
  crop.pts[crop.dragIdx] = {
    x: clamp(crop.startPts[crop.dragIdx].x + dx, d.x, d.x + d.w),
    y: clamp(crop.startPts[crop.dragIdx].y + dy, d.y, d.y + d.h),
  };
  drawCrop();
}
function endDrag() { crop.dragIdx = -1; }

function rotateCrop() {
  crop.rotation = (crop.rotation + 1) % 4;
  crop.pts = null;
  buildSrc();
}

function confirmCrop() {
  const d = crop.displayRect;
  const sx = crop.srcCanvas.width / d.w;
  const sy = crop.srcCanvas.height / d.h;
  const srcPts = crop.pts.map((p) => [
    clamp((p.x - d.x) * sx, 0, crop.srcCanvas.width),
    clamp((p.y - d.y) * sy, 0, crop.srcCanvas.height),
  ]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.round((dist(srcPts[0], srcPts[1]) + dist(srcPts[3], srcPts[2])) / 2);
  let H = Math.round((dist(srcPts[0], srcPts[3]) + dist(srcPts[1], srcPts[2])) / 2);
  const maxDim = 2000;
  const m = Math.max(W, H);
  if (m > maxDim) { const s = maxDim / m; W = Math.round(W * s); H = Math.round(H * s); }

  // 透视变换：计算单应矩阵，奇异时回退为轴对齐裁剪
  const dst = [[0, 0], [W, 0], [W, H], [0, H]];
  const Hmat = computeHomography(srcPts, dst);
  const det = Hmat[0][0] * (Hmat[1][1] * Hmat[2][2] - Hmat[1][2] * Hmat[2][1])
            - Hmat[0][1] * (Hmat[1][0] * Hmat[2][2] - Hmat[1][2] * Hmat[2][0])
            + Hmat[0][2] * (Hmat[1][0] * Hmat[2][1] - Hmat[1][1] * Hmat[2][0]);
  let out;
  if (!isFinite(det) || Math.abs(det) < 1e-6) {
    const xs = srcPts.map((p) => p[0]), ys = srcPts.map((p) => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xs), maxY = Math.max(...ys);
    out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(maxX - minX)); out.height = Math.max(1, Math.round(maxY - minY));
    out.getContext('2d').drawImage(crop.srcCanvas, minX, minY, maxX - minX, maxY - minY, 0, 0, out.width, out.height);
  } else {
    out = warpPerspective(crop.srcCanvas, srcPts, W, H);
  }
  const outUrl = out.toDataURL('image/jpeg', 0.94);
  cropEls.overlay.classList.remove('show');
  if (crop.onConfirm) crop.onConfirm(outUrl);
}

// 透视变换（双线性采样）
function warpPerspective(src, srcPts, outW, outH) {
  const dst = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
  const H = computeHomography(srcPts, dst);
  const Hi = invert3(H);
  const out = document.createElement('canvas');
  out.width = Math.max(1, outW); out.height = Math.max(1, outH);
  const octx = out.getContext('2d');
  const od = octx.createImageData(out.width, out.height);
  const dst32 = new Uint32Array(od.data.buffer);       // 一次写 4 通道，快很多
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const sd = sctx.getImageData(0, 0, src.width, src.height).data;
  const sw = src.width, sh = src.height;
  const ow = out.width, oh = out.height;
  // 展开单应矩阵到局部变量，避免内层循环反复索引数组
  const a0 = Hi[0][0], a1 = Hi[0][1], a2 = Hi[0][2];
  const b0 = Hi[1][0], b1 = Hi[1][1], b2 = Hi[1][2];
  const c0 = Hi[2][0], c1 = Hi[2][1], c2 = Hi[2][2];
  const WHITE = 0xffffffff;
  let oi = 0;
  for (let y = 0; y < oh; y++) {
    // 沿 x 方向是线性递增，用增量代替每像素乘法
    let nx = a0 * 0 + a1 * y + a2;
    let ny = b0 * 0 + b1 * y + b2;
    let nd = c0 * 0 + c1 * y + c2;
    for (let x = 0; x < ow; x++, oi++, nx += a0, ny += b0, nd += c0) {
      const sx = nx / nd, sy = ny / nd;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) { dst32[oi] = WHITE; continue; }
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0;
      const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) << 2, i01 = (y0 * sw + x1) << 2;
      const i10 = (y1 * sw + x0) << 2, i11 = (y1 * sw + x1) << 2;
      const r = ((sd[i00] * (1 - fx) + sd[i01] * fx) * (1 - fy) + (sd[i10] * (1 - fx) + sd[i11] * fx) * fy) | 0;
      const g = ((sd[i00 + 1] * (1 - fx) + sd[i01 + 1] * fx) * (1 - fy) + (sd[i10 + 1] * (1 - fx) + sd[i11 + 1] * fx) * fy) | 0;
      const bl = ((sd[i00 + 2] * (1 - fx) + sd[i01 + 2] * fx) * (1 - fy) + (sd[i10 + 2] * (1 - fx) + sd[i11 + 2] * fx) * fy) | 0;
      dst32[oi] = (255 << 24) | (bl << 16) | (g << 8) | r;   // 小端：ABGR
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

function computeHomography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]); b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]); b.push(dy);
  }
  const h = solveLinear(A, b);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  const x = new Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n];
  return x;
}

function invert3(m) {
  const a = m[0][0], b = m[0][1], c = m[0][2];
  const d = m[1][0], e = m[1][1], f = m[1][2];
  const g = m[2][0], h = m[2][1], i = m[2][2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const id = 1 / det;
  return [
    [A * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [B * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [C * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ];
}

// 识别顺序：AI 视觉大模型（最准）→ 百度结构化 OCR → 本地兜底
async function doOcr(slot, dataUrl) {
  slot.classList.add('ocring');
  toast('AI 正在识别证件…');
  // 1) 大模型视觉识别：多模型链路 + 校验位复核，准确度最高
  try {
    const r = await fetch('/api/ocr-llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, kind: slot.dataset.ocr }),
    });
    const j = await r.json();
    if (j.ok && j.data && Object.keys(j.data).length) {
      fillFields(slot, j.data);
      slot.classList.remove('ocring');
      toast(j.meta && j.meta.verified === false
        ? '已填入，号码未通过校验请仔细核对'
        : '已自动填入并通过校验 ✓');
      return;
    }
  } catch (e) { /* 继续 */ }

  // 2) 百度结构化 OCR（在 config.json 配置百度密钥后生效）
  try {
    const r = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, kind: slot.dataset.ocr }),
    });
    const j = await r.json();
    if (j.ok && j.data && Object.keys(j.data).length) {
      fillFields(slot, j.data);
      slot.classList.remove('ocring');
      toast('已自动填入（云端 OCR）');
      return;
    }
  } catch (e) { /* 继续 */ }

  // 3) 本地 OCR 兜底（无需密钥，精度有限，需联网加载识别库）
  try {
    const data = await ocrLocal(dataUrl, slot.dataset.ocr);
    if (data && Object.keys(data).length) {
      fillFields(slot, data);
      slot.classList.remove('ocring');
      toast('已自动填入（本地识别，精度有限，请核对）');
      return;
    }
  } catch (e) {
    console.log('local ocr err', e);
  }
  slot.classList.remove('ocring');
  toast('未能自动识别，请手动填写');
}

// 身份证号校验位（GB 11643），用于前端即时提示
function checkIdNumber(v) {
  const s = String(v || '').replace(/\s/g, '').toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i];
  return codes[sum % 11] === s[17];
}

// 身份证号合法性（含位数/出生日期/校验位），返回 {ok, reason}
function validateId(v) {
  const s = String(v || '').replace(/\s/g, '').toUpperCase();
  if (!s) return { ok: false, reason: '未填写' };
  if (!/^\d{17}[\dX]$/.test(s)) return { ok: false, reason: '须为18位，末位可为X' };
  const y = +s.slice(6, 10), m = +s.slice(10, 12), d = +s.slice(12, 14);
  if (y < 1900 || y > new Date().getFullYear()) return { ok: false, reason: '出生年份不合理' };
  if (m < 1 || m > 12) return { ok: false, reason: '月份不合理' };
  if (d < 1 || d > 31) return { ok: false, reason: '日期不合理' };
  if (!checkIdNumber(s)) return { ok: false, reason: '校验位不正确' };
  return { ok: true, reason: '' };
}

// 手机号合法性（11位、1[3-9] 开头），返回 {ok, reason}
function validatePhone(v) {
  const s = String(v || '');
  if (!s) return { ok: false, reason: '未填写' };
  if (!/^\d{11}$/.test(s)) return { ok: false, reason: '须为11位数字' };
  if (!/^1[3-9]\d{9}$/.test(s)) return { ok: false, reason: '号段不正确（应为1[3-9]开头）' };
  return { ok: true, reason: '' };
}

function fillFields(slot, data) {
  const fill = JSON.parse(slot.dataset.fill || '{}');
  for (const [k, id] of Object.entries(fill)) {
    const el = document.getElementById(id);
    if (el && data[k] != null && data[k] !== '') {
      el.value = data[k];
      el.classList.add('ocr-filled');
      setTimeout(() => el.classList.remove('ocr-filled'), 1200);
      if (/idNumber/i.test(id) || /IdNumber/.test(id)) markIdCheck(el);
    }
  }
  // 行驶证识别出车辆类型时，同步下拉框
  if (data.vehicleType) {
    const sel = document.getElementById('v_vehicleType');
    if (sel) sel.value = data.vehicleType;
  }
}

// 身份证输入框校验提示
function markIdCheck(el) {
  const v = el.value.trim();
  if (!v) { el.classList.remove('id-bad', 'id-good'); return; }
  const ok = checkIdNumber(v);
  el.classList.toggle('id-bad', !ok);
  el.classList.toggle('id-good', ok);
}

let _tessWorker = null;
async function ocrLocal(dataUrl, kind) {
  if (!window.Tesseract) throw new Error('Tesseract 未加载（需联网）');
  if (!_tessWorker) _tessWorker = Tesseract.createWorker('chi_sim');
  const worker = await _tessWorker;
  const { data } = await worker.recognize(dataUrl);
  return parseLocal(kind, data.text);
}

// 本地 OCR 文本解析（尽力而为）
function parseLocal(kind, text) {
  const d = {};
  const m = (re) => { const x = text.match(re); return x ? (x[1] || x[0]) : ''; };
  const name = m(/姓名[：:\s]*([一-龥]{2,4})/);
  const id = m(/(\d{17}[\dxX])/);
  if (name) { d.name = name; d.licenseName = name; }
  if (id) { d.idNumber = id; d.licenseNo = id; }
  const dates = text.match(/\d{4}[.年\/\-]\d{1,2}[.月\/\-]\d{1,2}/g) || [];
  if (dates.length >= 2) { d.idValidStart = dates[0]; d.idValidEnd = dates[1]; d.licenseValid = dates.join('-'); }
  else if (dates.length === 1) { d.idValidStart = dates[0]; }
  const plate = m(/[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新][A-Z][A-Z0-9]{5,6}/);
  if (plate) d.plate = plate;
  const bm = m(/品牌型号[：:\s]*([一-龥A-Za-z0-9]+)/);
  if (bm) { d.vehicleBrand = bm; d.vehicleModel = bm; }
  return d;
}

function collectPhotos(sectionId) {
  const out = {};
  document.querySelectorAll('#sec-' + sectionId + ' .photo-slot').forEach((slot) => {
    if (slot.dataset.key && slot._dataUrl) out[slot.dataset.key] = slot._dataUrl;
  });
  return out;
}

// ============ 历史信息自动带出 + 新办/续期自动判定 ============
// params: { phone, idNumber, plate } 任一作为查询条件
// map: { 历史记录字段名 -> 输入框 id }；prefer 可指定优先匹配的报备类型
// isNewId 有值时：命中历史→设为“续期(否)”，未命中→设为“新办(是)”（用户可手动改）
// hintId 有值时在该处提示填充结果；overwrite=false 时不覆盖用户已填内容
async function autoFill(params, map, opt) {
  const o = opt || {};
  const has = params.phone || params.idNumber || params.plate;
  if (!has) return false;
  if (o.hintId) hint(o.hintId, '正在查询历史报备…', '');
  try {
    const q = Object.entries(params).filter(([k, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = '/api/lookup?' + q + (o.prefer ? (q ? '&' : '') + 'prefer=' + o.prefer : '');
    const r = await fetch(url);
    const j = await r.json();
    if (!j.found) {
      if (o.hintId) hint(o.hintId, '未查到历史报备，将按【新办】登记', '');
      if (o.isNewId) setVal(o.isNewId, '是');
      return false;
    }
    const filled = [];
    for (const [key, id] of Object.entries(map)) {
      const v = j.record[key];
      if (v == null || v === '') continue;
      const el = document.getElementById(id);
      if (!el) continue;
      if (o.overwrite === false && el.value.trim()) continue;   // 不覆盖已填
      el.value = v;
      el.classList.add('ocr-filled');
      setTimeout(() => el.classList.remove('ocr-filled'), 1400);
      if (/idNumber/i.test(id)) markIdCheck(el);
      filled.push(id);
    }
    if (o.isNewId) setVal(o.isNewId, '否');   // 命中历史 → 续期
    if (filled.length) {
      if (o.hintId) hint(o.hintId, `已带入 ${filled.length} 项历史信息，已判定【续期】，可手动修改`, 'ok');
      else toast('已根据历史自动填入');
    } else if (o.hintId) hint(o.hintId, '查到历史记录，但无可带出信息', '');
    return true;
  } catch (e) {
    if (o.hintId) hint(o.hintId, '', '');
    return false;
  }
}

// 手机号/身份证号/车牌号 格式快速校验
function phoneOk(v) { return /^\d{11}$/.test(v); }
function plateOk(v) {
  return /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新使领警学港澳][A-Z][A-Z0-9]{4,6}$/.test(v);
}

// 必填项 + 关键字段格式校验，返回问题列表（空=通过）
function collectProblems(type) {
  const t = (type === 'material_in' || type === 'material_out') ? 'material' : type;
  const P = [];
  const need = (id, label) => { if (!val(id)) P.push('缺：' + label); };
  const needV = (id, label, validator) => {
    const v = val(id);
    if (!v) P.push('缺：' + label);
    else { const r = validator(v); if (!r.ok) P.push('错：' + label + '（' + r.reason + '）'); }
  };
  const plateV = (v) => ({ ok: plateOk(v), reason: plateOk(v) ? '' : '车牌格式不正确' });
  if (t === 'personnel') {
    need('p_name', '人员姓名');
    needV('p_idNumber', '身份证号', validateId);
    needV('p_phone', '手机号', validatePhone);
    need('p_isNew', '是否新办');
    need('p_carryLaptop', '是否携带笔记本');
    if (val('p_carryLaptop') === '是') need('p_laptopModel', '笔记本型号');
  } else if (t === 'vehicle') {
    need('v_licenseName', '驾驶证姓名');
    need('v_driverIdName', '身份证姓名');
    needV('v_driverIdNumber', '驾驶员身份证号', validateId);
    needV('v_plate', '车牌号', plateV);
    need('v_vehicleType', '车辆类型');
    need('v_vehicleBrand', '车品牌');
    need('v_vehicleModel', '车型号');
    need('v_annualInspection', '行驶证年检是否过期');
    needV('v_phone', '手机号', validatePhone);
    need('v_isNew', '是否新办');
  } else if (t === 'material') {
    need('m_name', '物品名称');
    need('m_unit', '计量单位');
    need('m_qty', '物品数量');
    const isOut = val('m_type') === 'material_out';
    need(isOut ? 'm_out_time' : 'm_in_time', isOut ? '出场日期' : '进厂日期');
    needV('m_driverPhone', '驾驶员电话', validatePhone);
    need('m_driverName', '驾驶员姓名');
    needV('m_driverIdNumber', '驾驶员身份证号', validateId);
    if (isOut) needV('m_phone', '报备手机号', validatePhone);
  }
  return P;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 重名/重号冲突检测：返回错误串（无冲突返回 null）
async function conflictError(type) {
  let idNumber = '', phone = '', name = '';
  if (type === 'personnel') { idNumber = val('p_idNumber'); phone = val('p_phone'); name = val('p_name'); }
  else if (type === 'vehicle') { idNumber = val('v_driverIdNumber'); phone = val('v_phone'); name = val('v_driverIdName'); }
  else if (type === 'material_in' || type === 'material_out') {
    idNumber = val('m_driverIdNumber'); phone = val('m_driverPhone'); name = val('m_driverName');
    if (type === 'material_out' && val('m_phone')) phone = val('m_phone');
  }
  if (!idNumber && !phone) return null;
  if (!name) return null;   // 未填姓名无法判断是否同一人，跳过
  try {
    const q = `idNumber=${encodeURIComponent(idNumber)}&phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`;
    const r = await fetch('/api/check-conflict?' + q);
    const j = await r.json();
    if (j.ok && (j.conflicts.id.length || j.conflicts.phone.length)) {
      const parts = [];
      if (j.conflicts.id.length) parts.push('身份证号已被【' + j.conflicts.id.join('、') + '】使用');
      if (j.conflicts.phone.length) parts.push('手机号已被【' + j.conflicts.phone.join('、') + '】使用');
      return '疑似冒用他人证件：' + parts.join('；') + '。请核对本人实名信息。';
    }
  } catch (e) { /* 忽略，放行由服务端兜底 */ }
  return null;
}

// 提交前确认弹层
let _confirm = null;
async function requestSubmit(type, fields, hintId, extra) {
  const P = collectProblems(type);
  if (P.length) return hint(hintId, '⚠ 无法提交，请先修正：\n' + P.join('；'), 'err');
  const c = await conflictError(type);
  if (c) return hint(hintId, '⚠ 无法提交：' + c, 'err');
  const t = (type === 'material_in' || type === 'material_out') ? 'material' : type;
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<div class="cr"><span>${k}</span><b>${escapeHtml(v)}</b></div>`); };
  if (type === 'personnel' || type === 'vehicle') {
    add('是否新办', fields.isNew || (extra && extra.isRenewal ? '否（续期）' : '是（新办）'));
  }
  if (t === 'personnel') {
    add('姓名', fields.name); add('身份证号', fields.idNumber); add('手机号', fields.phone);
  } else if (t === 'vehicle') {
    add('驾驶证姓名', fields.licenseName); add('身份证姓名', fields.driverIdName); add('身份证号', fields.driverIdNumber);
    add('车牌号', fields.plate); add('品牌/型号', (fields.vehicleBrand + ' ' + fields.vehicleModel).trim()); add('手机号', fields.phone);
  } else if (t === 'material') {
    add('类型', fields.exitTime ? '物资出场' : '物资进场');
    add('物品', fields.itemName + ' ' + fields.qty + fields.unit);
    add('日期', fields.entryTime || fields.exitTime);
    add('驾驶员', fields.driverName + ' ' + fields.driverIdNumber);
    add('车牌号', fields.plate);
  }
  document.getElementById('confirmBody').innerHTML = rows.join('');
  _confirm = { type, fields, hintId, extra };
  document.getElementById('confirmOverlay').classList.add('show');
}

// ============ 提交 ============
async function postReport(type, fields, hintId, extra) {
  const body = Object.assign({ type, fields }, extra || {});
  try {
    const r = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.ok) {
      showResult(j);
      if (hintId) hint(hintId, '', '');
    } else {
      hint(hintId, '提交失败：' + (j.error || '未知错误'), 'err');
    }
  } catch (e) {
    hint(hintId, '网络错误，请重试', 'err');
  }
}

function showResult(j) {
  const main = document.querySelector('main');
  const card = document.createElement('div');
  card.className = 'result-card';
  let meta = j.isRenewal ? '续期报备成功' : '新办报备成功';
  if (j.passExpiry) meta += ` ｜ 通行证到期日：${j.passExpiry}`;
  card.innerHTML =
    `<div>报备成功 ✅</div>` +
    `<div class="code">报备编号：${j.id}</div>` +
    `<div class="meta">${meta}</div>` +
    (j.isRenewal ? '' : `<div class="meta">通行到期日将以向甲方报备结果为准，可在「续期报备」上传通行证延期。</div>`);
  main.insertBefore(card, main.firstChild);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => card.remove(), 8000);
}

function submitPersonnel() {
  const fields = {
    name: val('p_name'), idNumber: val('p_idNumber'),
    idValidStart: val('p_idValidStart'), idValidEnd: val('p_idValidEnd'),
    phone: val('p_phone'), carryLaptop: val('p_carryLaptop'),
    laptopModel: val('p_laptopModel'), laptopQty: val('p_laptopQty'),
    isNew: val('p_isNew'),
  };
  Object.assign(fields, collectPhotos('personnel'));
  requestSubmit('personnel', fields, 'p_hint', { isRenewal: val('p_isNew') === '否' });
}

function submitVehicle() {
  const fields = {
    licenseName: val('v_licenseName'), licenseValid: val('v_licenseValid'),
    driverName: val('v_driverIdName'), driverIdName: val('v_driverIdName'), driverIdNumber: val('v_driverIdNumber'),
    driverIdValidStart: val('v_driverIdValidStart'), driverIdValidEnd: val('v_driverIdValidEnd'),
    plate: val('v_plate'), vehicleType: val('v_vehicleType'),
    vehicleBrand: val('v_vehicleBrand'), vehicleModel: val('v_vehicleModel'),
    annualInspection: val('v_annualInspection'), phone: val('v_phone'),
    isNew: val('v_isNew'),
  };
  Object.assign(fields, collectPhotos('vehicle'));
  requestSubmit('vehicle', fields, 'v_hint', { isRenewal: val('v_isNew') === '否' });
}

function submitMaterial() {
  const isOut = val('m_type') === 'material_out';
  const fields = {
    itemName: val('m_name'), unit: val('m_unit'), qty: val('m_qty'),
    drawingNo: val('m_drawing'), material: val('m_material'), spec: val('m_spec'),
    size: val('m_size'), weight: val('m_weight'), grade: val('m_grade'),
    remark: val('m_remark'), plate: val('m_plate'),
    vehicleBrand: val('m_brand'), vehicleModel: val('m_model'),
    driverName: val('m_driverName'), driverIdNumber: val('m_driverIdNumber'), driverPhone: val('m_driverPhone'),
  };
  if (isOut) {
    fields.exitTime = val('m_out_time');
    fields.phone = val('m_phone');
  } else {
    fields.entryTime = val('m_in_time');
  }
  requestSubmit(isOut ? 'material_out' : 'material_in', fields, 'm_hint', {});
}

// ============ 续期 ============
let renewCtx = null;
async function lookupRenew() {
  const idNumber = val('r_id');
  const phone = val('r_phone');
  if (!idNumber && !phone) return hint('r_lookup_hint', '请输入身份证号或手机号', 'err');
  try {
    const q = `idNumber=${encodeURIComponent(idNumber)}&phone=${encodeURIComponent(phone)}`;
    const r = await fetch('/api/lookup?' + q);
    const j = await r.json();
    if (!j.found) return hint('r_lookup_hint', '未找到历史报备记录', 'err');
    renewCtx = j.record;
    setVal('r_name', j.record.name);
    setVal('r_idNum', j.record.idNumber);
    setVal('r_phone2', j.record.phone);
    setVal('r_passNo', j.record.passNo);
    setVal('r_validUntil', j.record.passExpiry);
    document.getElementById('r_type').value = j.record.type === 'vehicle' ? 'vehicle' : 'personnel';
    document.getElementById('r_form').style.display = 'block';
    hint('r_lookup_hint', '已带入历史信息，请补充通行证/有效期后提交', 'ok');
  } catch (e) {
    hint('r_lookup_hint', '查询失败', 'err');
  }
}

function submitRenew() {
  if (!renewCtx) return hint('r_hint', '请先查询历史记录', 'err');
  const validUntil = val('r_validUntil');
  if (!validUntil) return hint('r_hint', '请填写通行证到期日', 'err');
  const fields = {
    name: val('r_name'), idNumber: val('r_idNum'), phone: val('r_phone2'),
    passNo: val('r_passNo'),
  };
  Object.assign(fields, collectPhotos('renew'));
  postReport(renewCtx.type, fields, 'r_hint', { isRenewal: true, passExpiry: validUntil });
}

// 实时冲突检测配置（重名/重号）
const CONFLICT_CFG = {
  personnel: { ids: ['p_idNumber'], phones: ['p_phone'], name: 'p_name', hint: 'p_hint' },
  vehicle: { ids: ['v_driverIdNumber'], phones: ['v_phone'], name: 'v_driverIdName', hint: 'v_hint' },
  material: { ids: ['m_driverIdNumber'], phones: ['m_driverPhone', 'm_phone'], name: 'm_driverName', hint: 'm_hint' },
};
async function liveConflict(type) {
  const cfg = CONFLICT_CFG[type];
  const idNumber = cfg.ids.map(val).find(Boolean) || '';
  const phone = cfg.phones.map(val).find(Boolean) || '';
  const name = val(cfg.name);
  if ((!idNumber && !phone) || !name) return;     // 信息不全时不误报
  try {
    const q = `idNumber=${encodeURIComponent(idNumber)}&phone=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`;
    const r = await fetch('/api/check-conflict?' + q);
    const j = await r.json();
    const h = document.getElementById(cfg.hint);
    if (j.ok && (j.conflicts.id.length || j.conflicts.phone.length)) {
      const who = j.conflicts.id[0] || j.conflicts.phone[0] || '他人';
      toast('⚠ 该' + (j.conflicts.id.length ? '身份证号' : '手机号') + '已被他人使用，请确认是本人实名');
      if (h) { h.textContent = '⚠ ' + (j.conflicts.id.length ? '身份证号' : '手机号') + '已被【' + who + '】使用，疑似非本人实名'; h.className = 'hint err'; }
    }
  } catch (e) { /* 忽略 */ }
}

// 手机号/身份证号/车牌号 失焦或输满即自动带出历史信息，并自动判定新办/续期
function bindAutoFill() {
  const bind = (ids, paramsFn, map, opt) => {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      let last = '';
      const run = () => {
        const v = val(id);
        if (v === last) return;
        last = v;
        autoFill(paramsFn(v), map, opt);
      };
      el.addEventListener('blur', run);
      // 输满手机号(11)/身份证(18)/车牌 即触发，无需等失焦
      el.addEventListener('input', () => {
        const v = val(id);
        if (/^\d{11}$/.test(v) || /^\d{17}[\dX]$/.test(v) ||
            /^[京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新使领警学港澳][A-Z][A-Z0-9]{4,6}$/.test(v)) {
          run();
        }
      });
    });
  };

  bind(['p_phone', 'p_idNumber'], (v) => ({ phone: v, idNumber: v }), {
    name: 'p_name', idNumber: 'p_idNumber', idValidStart: 'p_idValidStart', idValidEnd: 'p_idValidEnd',
  }, { hintId: 'p_hint', isNewId: 'p_isNew' });

  bind(['v_phone', 'v_driverIdNumber', 'v_plate'], (v) => ({ phone: v, idNumber: v, plate: v }), {
    licenseName: 'v_licenseName', licenseValid: 'v_licenseValid',
    driverName: 'v_driverIdName', driverIdNumber: 'v_driverIdNumber',
    driverIdValidStart: 'v_driverIdValidStart', driverIdValidEnd: 'v_driverIdValidEnd',
    plate: 'v_plate', vehicleBrand: 'v_vehicleBrand', vehicleModel: 'v_vehicleModel',
  }, { prefer: 'vehicle', hintId: 'v_hint', isNewId: 'v_isNew' });

  // 物资：驾驶员电话是入口，带出驾驶员 + 车辆全套信息
  bind(['m_driverPhone'], (v) => ({ phone: v }), {
    driverName: 'm_driverName', driverIdNumber: 'm_driverIdNumber',
    plate: 'm_plate', vehicleBrand: 'm_brand', vehicleModel: 'm_model',
  }, { prefer: 'vehicle', hintId: 'm_fill_hint' });

  bind(['m_phone'], (v) => ({ phone: v }), {
    driverName: 'm_driverName', driverIdNumber: 'm_driverIdNumber',
    plate: 'm_plate', vehicleBrand: 'm_brand', vehicleModel: 'm_model',
  }, { prefer: 'vehicle', overwrite: false, hintId: 'm_fill_hint' });

  // 失焦时做重名/重号实时检测
  const confBind = (type) => {
    const cfg = CONFLICT_CFG[type];
    [...cfg.ids, ...cfg.phones].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('blur', () => liveConflict(type));
    });
  };
  confBind('personnel'); confBind('vehicle'); confBind('material');
}

// 身份证输入框实时校验提示
function bindIdCheck() {
  ['p_idNumber', 'v_driverIdNumber', 'm_driverIdNumber', 'r_idNum'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('blur', () => markIdCheck(el));
  });
}

// 物资进场/出场日期默认填今天，减少操作
function initMaterialDate() {
  const today = new Date();
  const s = today.getFullYear() + '-' +
    String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');
  const a = document.getElementById('m_in_time');
  const b = document.getElementById('m_out_time');
  if (a && !a.value) a.value = s;
  if (b && !b.value) b.value = s;
}

setupPhotos();
initCropper();
bindAutoFill();
bindIdCheck();
initMaterialDate();
loadNotices();   // 加载首页通知横幅

// ============ 提交前确认弹层交互 ============
document.getElementById('confirmCancel').addEventListener('click', () => {
  document.getElementById('confirmOverlay').classList.remove('show');
  _confirm = null;
});
document.getElementById('confirmOk').addEventListener('click', () => {
  const c = _confirm;
  if (!c) return;
  document.getElementById('confirmOverlay').classList.remove('show');
  _confirm = null;
  postReport(c.type, c.fields, c.hintId, c.extra);
});

// ============ 首页通知横幅（超级管理员发布） ============
async function loadNotices() {
  try {
    const r = await fetch('/api/notices');
    const j = await r.json();
    const el = document.getElementById('noticeBanner');
    if (j.ok && j.list && j.list.length) {
      el.style.display = 'block';
      el.innerHTML = j.list.map((n) => `<div class="notice-item">📢 ${escapeHtml(n.text)}</div>`).join('');
    } else {
      el.style.display = 'none';
    }
  } catch (e) { /* 忽略 */ }
}

// ============ 我的报备（凭身份证号+手机号，仅可查看/修改本人） ============
const MINE_TYPE_LABEL = { personnel: '人员报备', vehicle: '车辆/司机报备', material_in: '物资进场', material_out: '物资出场' };
const MINE_FIELDS = {
  personnel: [['name', '姓名'], ['idNumber', '身份证号'], ['phone', '手机号'], ['carryLaptop', '携带笔记本'], ['laptopModel', '笔记本型号']],
  vehicle: [['licenseName', '驾驶证姓名'], ['driverIdName', '身份证姓名'], ['driverIdNumber', '身份证号'], ['plate', '车牌号'], ['vehicleBrand', '车品牌'], ['vehicleModel', '车型号'], ['phone', '手机号'], ['annualInspection', '年检是否过期']],
  material_in: [['itemName', '物品名称'], ['unit', '单位'], ['qty', '数量'], ['driverName', '驾驶员姓名'], ['driverIdNumber', '驾驶员身份证号'], ['driverPhone', '驾驶员电话'], ['entryTime', '进厂日期']],
  material_out: [['itemName', '物品名称'], ['unit', '单位'], ['qty', '数量'], ['driverName', '驾驶员姓名'], ['driverIdNumber', '驾驶员身份证号'], ['driverPhone', '驾驶员电话'], ['phone', '报备手机号'], ['exitTime', '出场日期']],
};

async function loadMine() {
  const idNumber = val('mine_id'), phone = val('mine_phone');
  if (!idNumber || !phone) return hint('mine_hint', '请填写身份证号与手机号', 'err');
  if (!validateId(idNumber).ok) return hint('mine_hint', '身份证号格式不正确', 'err');
  if (!validatePhone(phone).ok) return hint('mine_hint', '手机号格式不正确', 'err');
  try {
    const q = `idNumber=${encodeURIComponent(idNumber)}&phone=${encodeURIComponent(phone)}`;
    const r = await fetch('/api/my?' + q);
    const j = await r.json();
    if (!j.ok) return hint('mine_hint', j.error || '查询失败', 'err');
    renderMine(j.list);
    hint('mine_hint', j.list.length ? `共 ${j.list.length} 条本人报备，仅可修改本人内容` : '未找到您的报备记录', j.list.length ? '' : 'err');
  } catch (e) {
    hint('mine_hint', '网络错误，请重试', 'err');
  }
}

function renderMine(list) {
  const box = document.getElementById('mine_list');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="card">暂无报备记录</div>'; return; }
  list.forEach((rec) => {
    const fields = MINE_FIELDS[rec.type] || [];
    const card = document.createElement('div');
    card.className = 'card mine-card';
    let html = `<h3>${MINE_TYPE_LABEL[rec.type] || rec.type} · 编号 ${rec.id} · ${rec.createdAtStr} ${rec.isRenewal ? '（续期）' : ''}</h3>`;
    fields.forEach(([k, lab]) => {
      const v = rec.fields[k] || '';
      const isDate = /Time$/.test(k);
      html += `<label class="field"><span class="lbl">${lab}</span><input id="mine_${rec.id}_${k}" value="${escapeHtml(v)}" ${isDate ? 'type="date"' : ''} /></label>`;
    });
    html += `<div id="mine_${rec.id}_hint" class="hint"></div>`;
    html += `<button class="btn" type="button" onclick="saveMine('${rec.id}','${rec.type}')">保存修改</button>`;
    card.innerHTML = html;
    box.appendChild(card);
  });
}

async function saveMine(id, type) {
  const fields = MINE_FIELDS[type] || [];
  const obj = {};
  fields.forEach(([k]) => { const el = document.getElementById(`mine_${id}_${k}`); if (el) obj[k] = el.value.trim(); });
  const idNumber = val('mine_id'), phone = val('mine_phone');
  const h = document.getElementById(`mine_${id}_hint`);
  try {
    const r = await fetch('/api/report/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber, phone, fields: obj }),
    });
    const j = await r.json();
    if (j.ok) { h.textContent = '已保存 ✓'; h.className = 'hint ok'; }
    else { h.textContent = '保存失败：' + (j.error || ''); h.className = 'hint err'; }
  } catch (e) {
    h.textContent = '网络错误，请重试'; h.className = 'hint err';
  }
}
