/* 截图工具（开发用）
 *
 * 为什么不用 `chrome --screenshot --window-size`：
 *   Windows 上无头 Chrome 有最小窗口宽度（约 520px），设 390 会被撑到 504，
 *   截出来的图右边被裁掉，误判成布局 bug。
 *   本脚本走 CDP 的 Emulation.setDeviceMetricsOverride，可精确模拟手机视口。
 *
 * 用法：
 *   node tools/shot.js '[{"name":"m-hall","url":"/","w":390,"h":844,"mobile":true}]'
 *   可选参数：--dsf=2（设备像素比，默认 2）、--out=shots、--profile=<目录>
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = 9333;
const CHROME = process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const specs = JSON.parse(process.argv[2] || '[]');
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const DSF = Number(arg('dsf', 2));
const OUT = arg('out', 'shots');
const BASE = arg('base', 'http://localhost:3001');
// 每次运行默认用独立 profile，避免上一次的 Chrome 未退出导致 profile 被锁；
// 「首次访问看教程」由注入的 seed 脚本抹掉，因此无需保留 profile。
const PROFILE = arg('profile', path.join(require('os').tmpdir(), 'bhtx-shot-' + Date.now()));
// 预置 localStorage：跳过首次使用教程，直接落在同行大厅
const SEED = arg('noseed', '') ? '' : arg('seed', "try{localStorage.setItem('bhtxweb_guide_seen','1')}catch(e){}");

const getJSON = (url, method) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: method || 'GET' }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.end();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-proxy-server', '--disable-gpu-compositing',
    '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  // 等 CDP 就绪
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); ready = true; }
    catch (e) { await sleep(250); }
  }
  if (!ready) { console.error('CDP 未就绪'); chrome.kill(); process.exit(1); }

  const target = await getJSON(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });

  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });

  await send('Page.enable');
  if (SEED) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: SEED });
  }

  for (const s of specs) {
    const w = s.w || 390, h = s.h || 844;
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h,
      deviceScaleFactor: s.dsf || DSF,
      mobile: s.mobile !== false
    });
    await send('Page.navigate', { url: BASE + (s.url || '/') });
    await sleep(s.wait || 1500);

    // 可选：截图前执行一段 JS（如点击某个元素打开弹层）
    if (s.eval) {
      await send('Runtime.evaluate', { expression: s.eval });
      await sleep(s.afterEval || 700);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, s.name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`${s.name.padEnd(14)} ${w}x${h} @${s.dsf || DSF}x  → ${file}`);
  }

  ws.close();
  chrome.kill();
  process.exit(0);
})();
