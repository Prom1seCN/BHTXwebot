/* CDP 求值工具（开发用）：加载页面 → 执行表达式 → 打印结果
 * 用法：node tools/eval.js '<表达式>' [url]
 * 表达式的求值结果须可 JSON 序列化（对象请自行 JSON.stringify）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9444;
const expr = process.argv[2] || 'document.title';
const url = process.argv[3] || 'http://localhost:3001/';

const getJSON = (u, m) => new Promise((res, rej) => {
  const r = http.request(u, { method: m || 'GET' }, (resp) => {
    let d = ''; resp.on('data', (c) => { d += c; });
    resp.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  });
  r.on('error', rej); r.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + path.join(os.tmpdir(), 'bhtx-eval-' + Date.now()),
    'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await sleep(250); }
  }
  const target = await getJSON(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });

  let id = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise((resolve) => {
    const i = ++id; pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url });
  await sleep(1800);

  const out = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true
  });
  console.log(JSON.stringify(out.result && 'value' in out.result ? out.result.value : out, null, 2));

  ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
