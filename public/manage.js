/* 管理界面（/manage.html）—— 名录与赞助管理；数据统计在 /dashboard.html */

const LS_KEY = 'bhtxweb_admin_key';

function getKey() { return localStorage.getItem(LS_KEY) || ''; }

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

async function load() {
  const key = getKey();
  if (!key) { showKeyMask(''); return; }
  try {
    const res = await fetch('/api/internal/contributors', { headers: { 'x-admin-key': key } });
    if (res.status === 403) { showKeyMask('密钥不正确'); return; }
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    hideKeyMask();
    loadContributors();
    loadSponsorStatus();
  } catch (e) { /* 静默重试 */ }
}

/* ===== 共建者名录管理 ===== */
let contributorsCache = [];

async function apiContributors(method, path, body) {
  const res = await fetch('/api/internal/contributors' + path, {
    method,
    headers: { 'x-admin-key': getKey(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 403) { showKeyMask('密钥不正确'); throw new Error('403'); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function loadContributors() {
  try {
    contributorsCache = await apiContributors('GET', '');
    renderContributors();
    renderPending(contributorsCache);
  } catch (e) { /* 静默：密钥未输入时不加载 */ }
}

function renderContributors() {
  const box = document.getElementById('contribList');
  if (!contributorsCache.length) {
    box.innerHTML = '<div class="state-sm">暂无共建者，在上方添加</div>';
    return;
  }
  box.innerHTML = contributorsCache.map((p) =>
    '<div class="contrib-row' + (p.hidden ? ' hidden-row' : '') + '" data-id="' + p._id + '">' +
    '<input class="dash-input" value="' + escAttr(p.name) + '" maxlength="20" placeholder="名字">' +
    '<input class="dash-input" value="' + escAttr(p.role) + '" maxlength="30" placeholder="角色">' +
    '<input class="dash-input" value="' + escAttr(p.link) + '" maxlength="200" placeholder="链接">' +
    '<span class="contrib-count">' + (p.hidden ? '已隐藏' : p.order) + '</span>' +
    '<button class="contrib-btn" title="上移" onclick="moveContributor(\'' + p._id + '\',\'up\')">↑</button>' +
    '<button class="contrib-btn" title="下移" onclick="moveContributor(\'' + p._id + '\',\'down\')">↓</button>' +
    '<button class="contrib-btn" onclick="toggleHidden(\'' + p._id + '\',' + (!p.hidden) + ')">' + (p.hidden ? '显示' : '隐藏') + '</button>' +
    '<button class="contrib-btn" onclick="saveContributor(\'' + p._id + '\')">保存</button>' +
    '<button class="contrib-btn del" onclick="deleteContributor(\'' + p._id + '\')">删除</button>' +
    '</div>'
  ).join('');
}

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
}

async function addContributor() {
  const name = document.getElementById('cName').value.trim();
  const role = document.getElementById('cRole').value.trim();
  const link = document.getElementById('cLink').value.trim();
  if (!name) return alert('请输入名字');
  try {
    await apiContributors('POST', '', { name, role, link });
    document.getElementById('cName').value = '';
    document.getElementById('cRole').value = '';
    document.getElementById('cLink').value = '';
    await loadContributors();
  } catch (e) { alert('添加失败'); }
}

function rowInputs(id) {
  const row = document.querySelector('.contrib-row[data-id="' + id + '"]');
  const inputs = row.querySelectorAll('input');
  return { name: inputs[0].value.trim(), role: inputs[1].value.trim(), link: inputs[2].value.trim() };
}

async function saveContributor(id) {
  const b = rowInputs(id);
  if (!b.name) return alert('名字不能为空');
  try {
    await apiContributors('PUT', '/' + id, b);
    await loadContributors();
  } catch (e) { alert('保存失败'); }
}

async function toggleHidden(id, hidden) {
  try {
    await apiContributors('PUT', '/' + id, { hidden });
    await loadContributors();
  } catch (e) { alert('操作失败'); }
}

async function deleteContributor(id) {
  if (!confirm('确认删除该共建者？')) return;
  try {
    await apiContributors('DELETE', '/' + id);
    await loadContributors();
  } catch (e) { alert('删除失败'); }
}

async function moveContributor(id, dir) {
  try {
    await apiContributors('POST', '/' + id + '/move', { dir });
    await loadContributors();
  } catch (e) { alert('操作失败'); }
}

/* ===== 赞助收款码管理 ===== */
async function loadSponsorStatus() {
  try {
    const res = await fetch('/api/internal/sponsor', { headers: { 'x-admin-key': getKey() } });
    if (res.status !== 200) return;
    const st = await res.json();
    for (const t of ["wechat", "alipay"]) {
      const el = document.getElementById('sp-state-' + t);
      if (el) el.textContent = st[t] && st[t].exists ? ('已上传 ' + st[t].mtime) : '未上传';
    }
  } catch (e) { /* 静默 */ }
}

async function uploadSponsor(type, input) {
  const f = input.files[0];
  if (!f) return;
  if (f.size > 3 * 1048576) { alert('图片请小于 3MB'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = String(reader.result).split(',')[1];
    try {
      const res = await fetch('/api/internal/sponsor', {
        method: 'POST',
        headers: { 'x-admin-key': getKey(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data: base64 })
      });
      if (res.status === 413) { alert('图片过大，请压缩到 3MB 内再上传'); }
      else if (res.status !== 200) {
        let msg = '上传失败，请稍后再试';
        try { msg = (await res.json()).message || msg; } catch (e) {}
        alert(msg);
      }
      else { alert('已更新'); }
      loadSponsorStatus();
    } catch (e) { alert('上传失败，请稍后再试'); }
    input.value = '';
  };
  reader.readAsDataURL(f);
}

async function deleteSponsor(type) {
  if (!confirm('确认删除该收款码？关于页将不再显示此入口。')) return;
  try {
    await fetch('/api/internal/sponsor/' + type, {
      method: 'DELETE', headers: { 'x-admin-key': getKey() }
    });
    loadSponsorStatus();
  } catch (e) { alert('删除失败'); }
}

/* ===== 赞助申请审核 ===== */
function renderPending(all) {
  const box = document.getElementById('pendingBox');
  const pending = all.filter((x) => x.pending);
  if (!pending.length) {
    box.innerHTML = '<div class="state-sm">暂无待审核的赞助申请</div>';
    return;
  }
  box.innerHTML = '<div class="pending-box"><div class="pending-head">待审核的赞助申请（' + pending.length + '）</div>' +
    pending.map((p) => {
      const ch = p.channel === 'alipay' ? '支付宝' : p.channel === 'wechat' ? '微信' : '未知渠道';
      return '<div class="pending-item">' +
        '<div class="pending-name">' + escAttr(p.name) + (p.role ? ' — ' + escAttr(p.role) : '') + '</div>' +
        '<div class="pending-meta">渠道：' + ch + (p.ref4 ? ' · 单号后四：' + escAttr(p.ref4) : '') + ' · 提交于 ' + new Date(p.createdAt).toLocaleString('zh-CN') + '</div>' +
        '<div class="pending-actions">' +
        '<button class="btn-ghost" onclick="decideContributor(\'' + p._id + '\',true)">通过，上名录</button>' +
        '<button class="contrib-btn del" onclick="decideContributor(\'' + p._id + '\',false)">拒绝</button>' +
        '</div></div>';
    }).join('') + '</div>';
}

async function decideContributor(id, approve) {
  if (approve) {
    if (!confirm('确认已核实到账，将其展示在共建者名录？')) return;
    try {
      await apiContributors('PUT', '/' + id, { pending: false, hidden: false });
      await loadContributors();
    } catch (e) { alert('操作失败'); }
  } else {
    if (!confirm('确认拒绝并删除该申请？')) return;
    try {
      await apiContributors('DELETE', '/' + id);
      await loadContributors();
    } catch (e) { alert('操作失败'); }
  }
}

// 启动
load();
