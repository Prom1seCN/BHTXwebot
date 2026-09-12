/**
 * 本地预览服务器 —— 仅供开发预览，不用于生产
 *
 * 作用：在没有 MongoDB 的机器上预览网站界面。
 *      静态资源按原样服务，/api/* 返回示例数据（含一个可直接登录的 mock 账号）。
 *
 * 用法：node dev-preview.js      然后打开 http://localhost:3001
 * 说明：真实业务请用 server.js（需 MongoDB）；本文件不参与线上部署。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const PUB = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function dayStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- 示例数据 ----
function makeTrips() {
  return [
    {
      _id: 'demo1', from: '北化北区', to: '昌平西山口', date: dayStr(0), time: '16:30',
      status: 'active', capacity: 4, headcount: 1, remark: '去地铁站，可带一个箱子',
      tripType: 'scheduled', isFull: false, createdAt: new Date().toISOString()
    },
    {
      _id: 'demo2', from: '北化北区', to: '北京南站', date: dayStr(0), time: '17:00',
      status: 'active', capacity: 5, headcount: 1, remark: '',
      tripType: 'scheduled', isFull: false, createdAt: new Date().toISOString()
    },
    {
      _id: 'demo3', from: '昌平西山口', to: '北化北区', date: dayStr(1), time: '19:30',
      status: 'active', capacity: 3, headcount: 0, remark: '周日返校',
      tripType: 'scheduled', isFull: false, createdAt: new Date().toISOString()
    },
    {
      // 满员：headcount 达到 capacity-1（与后端加入条件一致），显示 3/3
      _id: 'demo4', from: '北化北区', to: '首都机场', date: dayStr(2), time: '07:00',
      status: 'full', capacity: 4, headcount: 2, remark: '早班机',
      tripType: 'scheduled', isFull: true, createdAt: new Date().toISOString()
    }
  ];
}

const TRIPS = makeTrips();
const MEMBERS = {
  demo1: [
    { displayName: '北化校友Kd2m', role: 'organizer', isOrganizer: true, contact: 'wx_demo_01' },
    { displayName: '北化校友9xQa', role: 'passenger', isOrganizer: false, contact: 'demo_second' }
  ]
};

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath.indexOf('/api/') !== 0) return serveStatic(req, res, urlPath);

  // ===== 以下均为示例响应 =====
  const readBody = () => new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
  });

  (async () => {
    const body = req.method === 'GET' ? {} : await readBody();

    if (urlPath === '/api/trips' && req.method === 'GET') return json(res, 200, TRIPS);
    if (urlPath === '/api/trips/my') return json(res, 200, []);
    if (urlPath === '/api/trips/joined') return json(res, 200, []);

    const mMembers = urlPath.match(/^\/api\/trips\/([^/]+)\/members$/);
    if (mMembers) {
      const id = mMembers[1];
      const t = TRIPS.find((x) => x._id === id) || TRIPS[0];
      // 与后端 /api/trips/:id/members 一致：游客/未加入者只能看到「北化校友」且看不到联系方式
      const authed = String(req.headers.authorization || '').startsWith('Bearer ');
      const members = (MEMBERS[id] || []).map((m) => {
        const o = Object.assign({}, m);
        if (!authed) { o.displayName = '北化校友'; o.contact = ''; }
        return o;
      });
      return json(res, 200, { capacity: t.capacity, headcount: t.headcount, members, contact: '' });
    }
    const mTrip = urlPath.match(/^\/api\/trips\/([^/]+)$/);
    if (mTrip && req.method === 'GET') {
      const t = TRIPS.find((x) => x._id === mTrip[1]) || TRIPS[0];
      return json(res, 200, t);
    }

    if (urlPath === '/api/auth/send-code') {
      return json(res, 200, { message: '预览模式：验证码已"发送"（任意 6 位数字均可登录）' });
    }
    if (urlPath === '/api/auth/web-login') {
      return json(res, 200, {
        token: 'preview-token',
        isVerified: true,
        email: `${body.emailPrefix || 'demo'}@buct.edu.cn`,
        displayName: '北化校友preV'
      });
    }

    if (urlPath.indexOf('/join') > -1) return json(res, 200, { message: '已加入（预览）' });
    if (urlPath.indexOf('/leave') > -1) return json(res, 200, { message: '已退出（预览）' });
    if (urlPath === '/api/trips' && req.method === 'POST') return json(res, 200, { message: '发布成功（预览）', trip: TRIPS[0] });
    if (urlPath === '/api/user/display-name') return json(res, 200, { displayName: body.displayName });
    if (urlPath === '/api/user/profile') return json(res, 200, { displayName: '北化校友preV', isVerified: true });

    return json(res, 200, { message: 'ok（预览）' });
  })();
});

server.listen(PORT, () => {
  console.log('预览服务器已启动（仅供界面预览，数据为示例）');
  console.log('请在浏览器打开:  http://localhost:' + PORT);
});
