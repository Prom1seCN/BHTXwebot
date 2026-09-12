/* 数据看板（仅本地管理密钥使用）—— 纯前端渲染，业务数据全部来自 /api/stats/dashboard */

const LS_KEY = 'bhtxweb_admin_key';

const FUNNEL_STEPS = [
  { k: 'auth_code_sent', label: '发送验证码' },
  { k: 'user_login',     label: '登录' },
  { k: 'trip_publish',   label: '发布行程' },
  { k: 'trip_join',      label: '加入行程' },
  { k: 'contact_copy',   label: '复制联系方式' }
];

const SERIES = [
  { k: 'user_login',   label: '登录',       color: '#0080FF', on: true },
  { k: 'trip_publish', label: '发布',       color: '#7C3AED', on: true },
  { k: 'trip_join',    label: '加入',       color: '#0E9F6E', on: true },
  { k: 'contact_copy', label: '复制联系方式', color: '#D92D20', on: false }
];

let days = 30;
let current = null;

function getKey() { return localStorage.getItem(LS_KEY) || ''; }

async function load() {
  const key = getKey();
  if (!key) { showKeyMask(''); return; }
  try {
    const res = await fetch('/api/stats/dashboard?days=' + days + '&key=' + encodeURIComponent(key));
    if (res.status === 403) { showKeyMask('密钥不正确'); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    hideKeyMask();
    current = data;
    renderAll(data);
  } catch (e) {
    document.getElementById('updatedAt').textContent = '加载失败，请重试';
  }
}

function renderAll(d) {
  renderFunnel(d.funnel);
  renderSeriesChips();
  drawChart();
  renderMatch(d.match);
  renderFee(d.fee);
  const t = new Date(d.generatedAt);
  document.getElementById('updatedAt').textContent =
    '更新于 ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
}

/* ===== 转化漏斗 ===== */
function renderFunnel(funnel) {
  const max = Math.max(1, ...FUNNEL_STEPS.map((s) => funnel[s.k] || 0));
  let prev = null;
  const rows = FUNNEL_STEPS.map((s) => {
    const n = funnel[s.k] || 0;
    const conv = prev === null ? '' :
      '<span class="fn-conv">' + (prev > 0 ? Math.round((n / prev) * 100) + '%' : '—') + ' 较上步</span>';
    prev = n;
    return '<div class="fn-row">' +
      '<span class="fn-label">' + s.label + '</span>' +
      '<div class="fn-track"><div class="fn-bar" style="width:' + Math.max(n / max * 100, n > 0 ? 3 : 0) + '%"></div></div>' +
      '<span class="fn-meta"><b>' + n + '</b> 人' + conv + '</span>' +
      '</div>';
  });
  document.getElementById('funnel').innerHTML = rows.join('');
}

/* ===== 每日趋势 ===== */
function renderSeriesChips() {
  const box = document.getElementById('seriesChips');
  box.innerHTML = SERIES.map((s, i) =>
    '<button class="chip' + (s.on ? ' on' : '') + '" data-i="' + i + '" onclick="toggleSeries(' + i + ')">' +
    '<span class="series-dot" style="color:' + s.color + '"></span>' + s.label + '</button>'
  ).join('');
}

function toggleSeries(i) {
  SERIES[i].on = !SERIES[i].on;
  renderSeriesChips();
  drawChart();
}

function drawChart() {
  const box = document.getElementById('chart');
  if (!current || !current.daily || !current.daily.length) return;
  const data = current.daily;
  const vis = SERIES.filter((s) => s.on);
  if (!vis.length) { box.innerHTML = '<div class="chart-empty">在上方选择要展示的指标</div>'; return; }

  const W = Math.max(320, box.clientWidth || box.parentElement.clientWidth);
  const H = window.innerWidth >= 900 ? 280 : 230;
  const padL = 34, padR = 12, padT = 12, padB = 24;
  const n = data.length;

  const rawMax = Math.max(1, ...vis.map((s) => Math.max(...data.map((d) => d[s.k]))));
  const step = Math.ceil(rawMax / 4);
  const maxY = Math.max(step * 4, 4);

  const x = (i) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="每日趋势图">';

  for (let g = 0; g <= 4; g++) {
    const v = (maxY / 4) * g;
    const yy = y(v);
    svg += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="#E7ECF2" stroke-width="1"/>';
    svg += '<text x="' + (padL - 6) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="10" fill="#98A2B3">' + Math.round(v) + '</text>';
  }

  const labelStep = Math.max(1, Math.ceil(n / 6));
  data.forEach((d, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return;
    svg += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="#98A2B3">' + d.date.slice(5) + '</text>';
  });

  vis.forEach((s) => {
    const pts = data.map((d, i) => x(i).toFixed(1) + ',' + y(d[s.k]).toFixed(1)).join(' ');
    svg += '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    data.forEach((d, i) => {
      svg += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(d[s.k]).toFixed(1) + '" r="2.2" fill="' + s.color + '"/>';
    });
  });

  svg += '</svg>';
  box.innerHTML = svg;
}

/* ===== 撮合健康度 ===== */
function humanizeMs(ms) {
  if (ms == null) return '—';
  const min = ms / 60000;
  if (min < 60) return Math.round(min) + '<span class="unit">分钟</span>';
  const h = min / 60;
  if (h < 48) return (Math.round(h * 10) / 10) + '<span class="unit">小时</span>';
  return (Math.round(h / 24 * 10) / 10) + '<span class="unit">天</span>';
}

function renderMatch(m) {
  document.getElementById('matchSamples').textContent = '窗口内发布 ' + m.published + ' 个行程';
  const rate = m.published ? Math.max(m.joinRate, m.withJoiner > 0 ? 2 : 0) : 0;
  document.getElementById('match').innerHTML =
    '<div class="stat-item">' +
      '<span class="stat-label">发布行程</span>' +
      '<span class="stat-value">' + m.published + '<span class="unit">个</span></span>' +
    '</div>' +
    '<div>' +
      '<div class="stat-item">' +
        '<span class="stat-label">被加入占比</span>' +
        '<span class="stat-value">' + m.joinRate + '<span class="unit">%</span></span>' +
      '</div>' +
      '<div class="rate-track"><div class="rate-fill" style="width:' + rate + '%"></div></div>' +
      '<div class="stat-hint">曾有同学加入的行程（含加入后退出）</div>' +
    '</div>' +
    '<div class="stat-item">' +
      '<span class="stat-label">发布 → 首次加入</span>' +
      '<span class="stat-value">' + humanizeMs(m.avgFirstJoinMs) + '</span>' +
    '</div>' +
    '<div class="stat-hint">时长样本 ' + m.samples + ' 个（仅统计被加入的行程）</div>';
}

/* ===== 人均费用 ===== */
function renderFee(fee) {
  document.getElementById('fee').innerHTML =
    '<div class="stat-item">' +
      '<span class="stat-label">预估人均</span>' +
      '<span class="stat-value">' + (fee.avgPerPerson == null ? '—' : fee.avgPerPerson + '<span class="unit">元</span>') + '</span>' +
    '</div>' +
    '<div class="stat-item">' +
      '<span class="stat-label">实际填写均值</span>' +
      '<span class="stat-value">' + (fee.actualAvg == null ? '—' : fee.actualAvg + '<span class="unit">元</span>') + '</span>' +
    '</div>' +
    '<div class="stat-hint">样本 ' + fee.samples + ' 个，其中实际填写 ' + fee.actualSamples + ' 个（未填的按路线预估中值估算）</div>';
}

/* ===== 交互 ===== */
function setDays(n) {
  days = n;
  document.querySelectorAll('#daysChips .chip').forEach((c) => {
    c.classList.toggle('on', Number(c.dataset.days) === n);
  });
  load();
}

function showKeyMask(msg) {
  const err = document.getElementById('keyError');
  err.style.display = msg ? 'block' : 'none';
  err.textContent = msg || '';
  document.getElementById('keyMask').style.display = '';
}

function hideKeyMask() { document.getElementById('keyMask').style.display = 'none'; }

function saveKey() {
  const v = document.getElementById('keyInput').value.trim();
  if (!v) { showKeyMask('请输入密钥'); return; }
  localStorage.setItem(LS_KEY, v);
  load();
}

document.getElementById('keyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveKey();
});

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawChart, 150);
});

load();
