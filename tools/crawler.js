#!/usr/bin/env node
/**
 * 同行雷达 · 增量爬虫（VPS 上运行）
 *
 * 设计：
 *   · 游标增量 —— 记录上次爬到的最新位置，下次从那里往前拉，平时 1~2 次请求完事
 *   · 随机调度 —— 由 scheduler.js 控制时段与随机；本脚本只负责「爬一次」
 *   · 原始数据留档 —— 每次抓到的原始帖子按时间戳存 raw/ 目录，供以后挖掘
 *   · 筛选入库 —— 规则引擎筛出行程帖，写 external-trips.json（线上写 MongoDB）
 *   · 全程只读，限速，不碰任何写接口
 *
 * 用法：node tools/crawler.js            （正常运行一次）
 *      node tools/crawler.js --full     （忽略游标，全量重扫）
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { matchTime, scanLocations } = require("../qqbot");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.CRAWLER_DATA || path.join(ROOT, "crawler-data");
const RAW_DIR = path.join(DATA_DIR, "raw");
const CURSOR_FILE = path.join(DATA_DIR, "cursor.json");
const TRIPS_FILE = process.env.CRAWLER_OUT || path.join(ROOT, "external-trips.json");
const LOG_FILE = path.join(DATA_DIR, "crawler.log");

const FULL = process.argv.includes("--full");
const DELAY_MS = 1800;          // 请求间隔，控频防封
const MAX_PAGES = 20;           // 单次最多翻页数（增量时通常 1 页就停）

// ---------- 凭证（VPS 上用环境变量注入；token 含二进制签名，故也支持从文件读） ----------
const SD_COOKIE = process.env.SHUDONG_COOKIE || "";
const HY_TOKEN = process.env.HUYOU_TOKEN || (() => {
  try { return fs.readFileSync(path.join(DATA_DIR, "huyou-token.bin")).toString("latin1"); }
  catch (e) { return ""; }
})();
const HY_APP_KEY = process.env.HUYOU_APP_KEY || "O6318020003Uw2q7";
const HY_CIRCLE = process.env.HUYOU_CIRCLE || "1110317653823792256";
const HY_APPID = "330008";
const HY_VS = "6.22.0";

// 狐友身份头：含账号标识（用户 ID / 邮箱 / openid / 设备号），一律走环境变量，不入库
const HY_IDS = {
  pid:   process.env.HUYOU_PID   || "",
  ppid:  process.env.HUYOU_PPID  || "",
  poid:  process.env.HUYOU_POID  || "",
  poids: process.env.HUYOU_POIDS || "",
  cid:   process.env.HUYOU_CID   || ""
};

fs.mkdirSync(RAW_DIR, { recursive: true });

// ---------- 工具 ----------
function log(msg) {
  const line = `[${new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ")}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCursor() {
  try { return JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")); }
  catch (e) { return { shudong: "", huyou: "" }; }
}
function saveCursor(c) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify(c, null, 1), "utf8");
}

function req(options, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on("error", reject);
    r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    if (body) r.write(body);
    r.end();
  });
}

// ---------- 树洞 ----------
async function fetchShudong(cursor) {
  const out = [];
  let page = 1;
  while (page <= MAX_PAGES) {
    const payload = JSON.stringify({ community_id: "5", page, limit: 20 });
    const res = await req({
      hostname: "ys.qimiaoyuanfen.com", path: "/article/article/lists", method: "POST",
      headers: {
        "Cookie": SD_COOKIE,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF",
        "Referer": "https://servicewechat.com/wxe23b94e06f71e89a/153/page-frame.html"
      }
    }, payload);
    let d;
    try { d = JSON.parse(res.body); } catch (e) { log(`树洞 第${page}页解析失败`); break; }
    if (d.code !== "0000") { log(`树洞 第${page}页失败 code=${d.code}`); break; }
    const list = (d.data && d.data.list) || [];
    if (!list.length) break;

    let hitOld = false;
    for (const x of list) {
      const id = String(x.id);
      if (!FULL && cursor && id === cursor) { hitOld = true; break; }   // 追上上次的位置
      out.push({ source: "云上校友圈", sourceId: id, text: x.detail || x.title || "", postedAt: x.create_time });
    }
    if (hitOld) break;
    page++;
    await sleep(DELAY_MS);
  }
  return out;
}

// ---------- 狐友 ----------
function hySign(params) {
  const p = Object.assign({}, params);
  p.flyer = String(Date.now());
  p.appid = HY_APPID;
  p.app_key_vs = HY_VS;
  const arr = Object.keys(p).filter((k) => p[k] !== undefined && p[k] !== null)
    .map((k) => `${k}=${p[k]}`).sort();
  arr.push(HY_APP_KEY);
  p.sig = crypto.createHash("md5").update(arr.join("")).digest("hex");
  return p;
}

async function fetchHuyou(cursor) {
  const out = [];
  const since = FULL ? 0 : (Number(cursor) || 0);   // 上次爬到的最新时间戳（毫秒）；全量模式忽略游标
  let score = "0";                        // 始终从最新一页开始
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = hySign({
      exposed_hot_feed_ids: "", list_type: "2", circle_id: HY_CIRCLE,
      count: "10", score, tpl: "1,2,3,4,26,27,29",
      stpl: "1,2,3,4,7,9,11,12,13,16", withTop: "1",
      exposed_circle_pos_feed_id: "", extras: "1"
    });
    const qs = Object.keys(params).map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
    const res = await req({
      hostname: "cs-ol.sns.sohu.com", path: `/330008/v8/circle/feed/list?${qs}`, method: "GET",
      headers: {
        "token": HY_TOKEN,
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
        "s-vs": "6.22.0", "s-mvs": "v6.23.1-f", "s-os": "Windows 11 x64", "s-dv": "microsoft",
        "s-hw": "782,415", "p-appid": "110520",
        "s-pid": HY_IDS.pid, "s-ppid": HY_IDS.ppid,
        "s-poid": HY_IDS.poid, "s-poids": HY_IDS.poids,
        "s-cid": HY_IDS.cid,
        "gid": HY_IDS.cid,
        "s-openid": HY_IDS.poid, "xweb_xhr": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF WindowsWechat(0x63090a13) UnifiedPCWindowsWechat(0xf2541f0d) XWEB/25715",
        "referer": "https://servicewechat.com/wx915c6f684ab5b15f/637/page-frame.html"
      }
    });
    let d;
    try { d = JSON.parse(res.body); } catch (e) { log(`狐友 第${page}页解析失败`); break; }
    if (d.status !== 100000) { log(`狐友 第${page}页失败 status=${d.status}`); break; }
    const data = d.data || {}, list = data.feedList || [];
    if (!list.length) break;

    let hitOld = false;
    for (const f of list) {
      const s = f.sourceFeed || f;
      const sc = s.score;
      if (s.isTopFeed === 1) continue;                  // 置顶帖时间戳是旧的，跳过
      if (since && typeof sc === "number" && sc <= since) { hitOld = true; break; }  // 追上上次的位置
      out.push({ source: "狐友", sourceId: String(s.feedId), text: s.content || "", postedAt: sc });
    }
    if (hitOld) break;
    const nxt = (data.pageInfo || {}).score;
    if (!nxt || String(nxt) === String(score)) break;
    score = String(nxt);
    await sleep(DELAY_MS);
  }
  return out;
}

// ---------- 筛选（规则全硬编码） ----------
const TRIP_KW = /拼车|拼个车|一起拼|顺风车|顺风|搭车|捎我|求带|带我一个|同行|一起去|一起走/;
const AD_KW = /代课|代🉑|代写|接单|价格可议|\d+\s*r\s*一节|元一节|兼职|招聘|出售|转让|出租|收购|求购|家教|跑腿代取/;
const NOTRIP_KW = /捞一下|捡到|丢失|丢了|寻物|失物|差点被|看到两个|私一下我/;
const CN_MAP = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cn2num(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === "十") return 10;
  const i = s.indexOf("十");
  if (i === -1) return CN_MAP[s] !== undefined ? CN_MAP[s] : null;
  const a = i > 0 ? CN_MAP[s[0]] : 1, b = i < s.length - 1 ? CN_MAP[s[i + 1]] : 0;
  return (a == null || b == null) ? null : a * 10 + b;
}
function baseDay(postedAt) {
  const t = typeof postedAt === "number" ? postedAt : new Date(String(postedAt).replace(" ", "T") + "+08:00").getTime();
  return new Date(t + 8 * 3600e3);
}
function parseDateFrom(text, postedAt) {
  const cst = baseDay(postedAt);
  const day = (n) => new Date(cst.getTime() + n * 86400e3).toISOString().slice(0, 10);
  if (/大后天/.test(text)) return day(3);
  if (/后天/.test(text)) return day(2);
  if (/明天|明日|明早|明晚|明儿/.test(text)) return day(1);
  if (/今天|今日|今晚|今早|今晨|今儿/.test(text)) return day(0);
  let m = text.match(/(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[号日]?/);
  if (m) {
    const mm = +m[1], dd = +m[2];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)
      return `${cst.getUTCFullYear()}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  m = text.match(/(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*[号日]/);
  if (m) {
    const dd = cn2num(m[1]);
    if (dd >= 1 && dd <= 31) {
      const y = cst.getUTCFullYear(), mo = cst.getUTCMonth();
      let cand = new Date(Date.UTC(y, mo, dd));
      if (dd < cst.getUTCDate()) cand = new Date(Date.UTC(y, mo + 1, dd));
      return cand.toISOString().slice(0, 10);
    }
  }
  return null;
}
function isoTs(postedAt) {
  if (typeof postedAt === "number") return new Date(postedAt).toISOString();
  const d = new Date(String(postedAt).replace(" ", "T") + "+08:00");
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function filterOne(p) {
  const text = String(p.text || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (!TRIP_KW.test(text)) return null;
  if (AD_KW.test(text) || NOTRIP_KW.test(text)) return null;
  const locs = [];
  for (const f of scanLocations(" " + text + " ")) if (!locs.includes(f.loc)) locs.push(f.loc);
  if (!locs.length) return null;
  const tm = matchTime(text);
  let date = parseDateFrom(text, p.postedAt);
  if (!date && tm) date = new Date(baseDay(p.postedAt).getTime()).toISOString().slice(0, 10);
  if (!date && !tm) return null;
  return {
    source: p.source, sourceId: p.sourceId,
    from: locs.length >= 2 ? locs[0] : "",
    to: locs[locs.length - 1],
    date, time: (tm && tm.time) || "",
    raw: text, postedAt: isoTs(p.postedAt)
  };
}

// ---------- 主流程 ----------
(async () => {
  const started = Date.now();
  const cursor = loadCursor();
  log(`开始爬取${FULL ? "（全量）" : "（增量）"} 游标: 树洞=${cursor.shudong || "-"} 狐友=${cursor.huyou || "-"}`);

  let sd = [], hy = [];
  try { sd = await fetchShudong(cursor.shudong); log(`树洞 新帖 ${sd.length} 条`); }
  catch (e) { log(`树洞 失败: ${e.message}`); }
  try { hy = await fetchHuyou(cursor.huyou); log(`狐友 新帖 ${hy.length} 条`); }
  catch (e) { log(`狐友 失败: ${e.message}`); }

  const all = sd.concat(hy);

  // 原始数据留档（只增不删）
  if (all.length) {
    const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    fs.writeFileSync(path.join(RAW_DIR, `raw-${stamp}.json`), JSON.stringify(all, null, 1), "utf8");
  }

  // 筛选 + 并入结果
  const hits = all.map(filterOne).filter(Boolean);
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(TRIPS_FILE, "utf8")); } catch (e) {}
  const seen = new Set(existing.map((x) => `${x.source}:${x.sourceId}`));
  const fresh = hits.filter((x) => !seen.has(`${x.source}:${x.sourceId}`));
  const merged = existing.concat(fresh)
    .sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
  fs.writeFileSync(TRIPS_FILE, JSON.stringify(merged, null, 1), "utf8");

  // 更新游标（全量模式同样更新 —— 否则跑完 --full 会把游标写空，下次又从头拉）
  if (sd.length) cursor.shudong = sd[0].sourceId;
  if (hy.length) cursor.huyou = String(Math.max(...hy.map((x) => Number(x.postedAt) || 0)));
  saveCursor(cursor);

  // 写库（VPS 上由 MONGO_URI 触发；本地无则跳过，只留 JSON）
  if (process.env.MONGO_URI && fresh.length) {
    try {
      const mongoose = require("mongoose");
      const sch = new mongoose.Schema({
        source: String, sourceId: String, from: String, to: String,
        date: String, time: String, raw: String, postedAt: Date
      }, { timestamps: true });
      sch.index({ source: 1, sourceId: 1 }, { unique: true });
      const M = mongoose.models.ExternalTrip || mongoose.model("ExternalTrip", sch);
      await mongoose.connect(process.env.MONGO_URI);
      let n = 0;
      for (const x of fresh) {
        try {
          await M.updateOne({ source: x.source, sourceId: x.sourceId },
            { $setOnInsert: Object.assign({}, x, { postedAt: x.postedAt ? new Date(x.postedAt) : new Date() }) },
            { upsert: true });
          n++;
        } catch (e) { if (e.code !== 11000) log(`写库失败 ${x.sourceId}: ${e.message}`); }
      }
      log(`写库 ${n} 条`);
      await mongoose.disconnect();
    } catch (e) {
      log(`写库异常: ${e.message}`);
    }
  }

  log(`命中 ${hits.length} 条（新增 ${fresh.length}）| 库内共 ${merged.length} 条 | 耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.exit(0);
})();
