/* 验证码防护回归测试（按邮箱维度的限流/锁定/熔断）
 *
 * 跑法：
 *   npm i --no-save mongodb-memory-server     # 只装本地，不进 package.json（首次运行会下载 mongod 二进制）
 *   node tools/guard-test.js
 *
 * 隔离性：测试用内存 Mongo，并 SMTP 指向 127.0.0.1:1（连接必拒），绝不碰线上库与真实 163 账号。
 * 覆盖：60 秒冷却 / 单邮箱 5 次每小时 / 10 次每天 / 锁定期拒发拒登 /
 *       换 IP 绕过 IP 限流后邮箱维度仍然锁死 / 登录成功清零 / 全局小时熔断
 */
const { MongoMemoryServer } = require("mongodb-memory-server");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const http = require("http");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const H = 3600 * 1000, D = 24 * H;

function req(path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = { "Content-Type": "application/json" };
    if (opts.xff) headers["X-Forwarded-For"] = opts.xff;
    const r = http.request(BASE + path, { method: opts.method || "GET", headers }, (res) => {
      let d = "";
      res.on("data", (c) => { d += c; });
      res.on("end", () => { let j = {}; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS | " + name); }
  else { fail++; console.log("FAIL | " + name + "  ::  " + JSON.stringify(detail)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri("bhtxweb");
  console.log("内存 Mongo:", uri);

  const child = spawn(process.execPath, ["server.js"], {
    env: Object.assign({}, process.env, {
      MONGO_URI: uri, JWT_SECRET: "test-secret", PORT: String(PORT),
      // SMTP 指向一个不存在的本地端口：连接立刻被拒，绝不碰真实 163 账号
      SMTP_HOST: "127.0.0.1", SMTP_PORT: "1", SMTP_SECURE: "false", SMTP_PASS: "dummy"
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));

  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await req("/api/trips"); if (r.status === 200) { up = true; break; } } catch (e) {}
    await sleep(250);
  }
  if (!up) { console.log("服务未就绪，日志：\n" + logs.join("")); child.kill(); await mongod.stop(); process.exit(1); }

  const conn = await mongoose.createConnection(uri).asPromise();
  const AG = conn.model("AuthGuard", new mongoose.Schema({ email: String, sends: [Date], fails: Number, failSince: Date, lockedUntil: Date }, { timestamps: true }));
  const AU = conn.model("Auth", new mongoose.Schema({ email: String, code: String, expiresAt: Date, lastSentAt: Date, failCount: Number }, { timestamps: true }));
  const SQ = conn.model("SmtpQuota", new mongoose.Schema({ key: String, count: Number }, { timestamps: true }));
  const now = () => Date.now();

  // ---- S6 60 秒冷却仍在（第一次因 SMTP 不可达返回 500，但已记 lastSentAt）----
  let e = "100000001@buct.edu.cn";
  const a1 = await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000001" } });
  const a2 = await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000001" } });
  check("S6 同邮箱 60 秒内二次发码被拒", a2.status === 429 && /1 分钟/.test(a2.body.message), { a1: a1.status, a2 });
  const g1 = await AG.findOne({ email: e });
  check("S6b 发码已按邮箱记账（AuthGuard.sends +1）", g1 && g1.sends && g1.sends.length === 1, g1);

  // ---- S1 小时配额：预置 5 条近 1 小时内的发码记录 ----
  let e2 = "100000002@buct.edu.cn";
  await AG.create({ email: e2, sends: [1, 2, 3, 4, 5].map((i) => new Date(now() - i * 60 * 1000)) });
  const b = await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000002" } });
  check("S1 单邮箱超 5 次/小时 → 429", b.status === 429 && /本小时/.test(b.body.message), b);

  // ---- S1b 日配额：10 条都在 1 小时之外、24 小时之内 ----
  let e3 = "100000003@buct.edu.cn";
  await AG.create({ email: e3, sends: Array.from({ length: 10 }, (_, i) => new Date(now() - (2 + i) * H)) });
  const c = await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000003" } });
  check("S1b 单邮箱超 10 次/天 → 429", c.status === 429 && /今日/.test(c.body.message), c);

  // ---- S2 锁定：发码与登录都拒 ----
  let e4 = "100000004@buct.edu.cn";
  await AG.create({ email: e4, lockedUntil: new Date(now() + 10 * 60 * 1000) });
  const d1 = await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000004" } });
  const d2 = await req("/api/auth/web-login", { method: "POST", body: { emailPrefix: "100000004", code: "123456" } });
  check("S2 锁定期内拒发码", d1.status === 429 && /分钟后再试/.test(d1.body.message), d1);
  check("S2 锁定期内拒登录", d2.status === 429 && /分钟后再试/.test(d2.body.message), d2);

  // ---- S3 核心：换 IP 绕过 IP 限流，连错 10 次仍被邮箱锁死；中途发新码不清零失败数 ----
  let e5 = "100000005@buct.edu.cn";
  const codes = [];
  for (let i = 1; i <= 10; i++) {
    const r = await req("/api/auth/web-login", { method: "POST", body: { emailPrefix: "100000005", code: "000000" }, xff: "10.0.0." + i });
    codes.push(r.status);
    if (i === 3) {  // 中途要一张新码：旧实现会在这里把错误计数清零
      await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000005" }, xff: "10.0.9." + i });
    }
  }
  const g5 = await AG.findOne({ email: e5 });
  check("S3 换 IP 未触发 IP 限流（证明 IP 键可绕）", codes.every((s) => s === 400), codes);
  check("S3 10 次错误后邮箱被锁定 30 分钟", g5 && g5.lockedUntil && (g5.lockedUntil - now()) > 25 * 60 * 1000 && g5.fails === 0, g5);
  const next = await req("/api/auth/web-login", { method: "POST", body: { emailPrefix: "100000005", code: "000000" }, xff: "10.0.0.99" });
  check("S3 锁定后即便换 IP 也进不去", next.status === 429, next);

  // ---- S4 登录成功清零失败与锁定 ----
  let e6 = "100000006@buct.edu.cn";
  await AG.create({ email: e6, fails: 9, failSince: new Date() });
  await AU.create({ email: e6, code: "654321", expiresAt: new Date(now() + 5 * 60 * 1000), lastSentAt: new Date(now() - 2 * 60 * 1000) });
  const ok = await req("/api/auth/web-login", { method: "POST", body: { emailPrefix: "100000006", code: "654321" } });
  const g6 = await AG.findOne({ email: e6 });
  check("S4 正确验证码登录成功", ok.status === 200 && !!ok.body.token, ok);
  check("S4 成功后失败计数清零", g6 && g6.fails === 0 && !g6.lockedUntil, g6);

  // ---- S5 全局发信熔断 ----
  const hourKey = "smtp-" + new Date().toISOString().slice(0, 13);
  const GUARD_MAX = Number(process.env.SMTP_HOURLY_MAX || 400);   // 与 server.js 的默认口径保持一致
  // 语义：count 自增后 > 上限才拒，即"每小时最多放行 400 封"，第 401 封熔断
  await SQ.updateOne({ key: hourKey }, { $set: { count: GUARD_MAX } }, { upsert: true });
  const f = await req("/api/auth/send-code", { method: "POST", body: { emailPrefix: "100000007" }, xff: "10.1.1.1" });
  check("S5 超全局小时上限 → 停发", f.status === 429 && /系统繁忙/.test(f.body.message), f);

  await conn.close();
  child.kill();
  await mongod.stop();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("测试异常:", err);
  process.exit(2);
});
