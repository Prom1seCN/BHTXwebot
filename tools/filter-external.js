#!/usr/bin/env node
/**
 * 第三方帖子筛选（同行雷达）—— 规则全部硬编码，不依赖模型判断。
 *
 * 与 qqbot.js 的 parsePublish 的区别：
 *   parsePublish 是给「用户发新行程」用的，要求日期+时间+路线三样齐全，
 *   且会把过期日期推到明年（发布场景合理，筛选历史帖则错误）。
 *   本脚本只复用底层的 matchDate / matchTime / scanLocations，判定逻辑另写。
 *
 * 判定规则（用户 2026-10-01 定）：
 *   1) 必须含拼车意图词
 *   2) 地点库至少命中 1 个（作为目的地）；不用 parseCustomRoute 的宽松兜底
 *   3) 日期或时刻至少一个能解析出来
 *   4) 排除广告类
 *
 * 用法：node tools/filter-external.js <树洞json> <狐友json> <输出json>
 */
const fs = require("fs");
const { matchDate, matchTime, scanLocations } = require("../qqbot");

const [, , SD_PATH, HY_PATH, OUT_PATH] = process.argv;
if (!SD_PATH || !HY_PATH || !OUT_PATH) {
  console.error("用法: node tools/filter-external.js <树洞json> <狐友json> <输出json>");
  process.exit(1);
}

// 拼车意图词（命中其一即可）
const TRIP_KW = /拼车|拼个车|一起拼|顺风车|顺风|搭车|捎我|求带|带我一个|同行|一起去|一起走|有没有人.*(去|回)|有.*拼/;
// 广告/无关（命中即排除）
const AD_KW = /代课|代🉑|代写|接单|价格可议|\d+\s*r\s*一节|元一节|兼职|招聘|出售|转让|出租|收购|求购|家教|跑腿代取/;
// 明显非出行的"捞人/寻物"类
const NOTRIP_KW = /捞一下|捡到|丢失|丢了|寻物|失物|差点被|看到两个|私一下我/;

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.error(`读取失败 ${p}: ${e.message}`); return []; }
}

// 日期解析（以「发帖日」为基准，而不是脚本运行日 —— 历史帖子的"明天"指的是发帖时的明天）
const CN_MAP = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cn2num(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (s === "十") return 10;
  const i = s.indexOf("十");
  if (i === -1) return CN_MAP[s] !== undefined ? CN_MAP[s] : null;
  const a = i > 0 ? CN_MAP[s[0]] : 1;
  const b = i < s.length - 1 ? CN_MAP[s[i + 1]] : 0;
  return (a == null || b == null) ? null : a * 10 + b;
}

function parseDateFrom(text, postedAt) {
  const base = postedAt ? new Date(postedAt) : new Date();
  const cst = new Date(base.getTime() + 8 * 3600 * 1000);   // UTC+8 墙钟
  const day = (n) => new Date(cst.getTime() + n * 86400000).toISOString().slice(0, 10);

  if (/大后天/.test(text)) return day(3);
  if (/后天/.test(text)) return day(2);
  if (/明天|明日|明早|明晚|明儿/.test(text)) return day(1);
  if (/今天|今日|今晚|今早|今晨|今儿/.test(text)) return day(0);

  // 9.30 / 9月30日 / 10-3
  let m = text.match(/(\d{1,2})\s*[月.\-/]\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const mm = +m[1], dd = +m[2];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `${cst.getUTCFullYear()}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }
  // 中文/阿拉伯「日」：三十号 / 一号 / 1号（无月份信息，用发帖月；若早于发帖日，说明是下个月）
  m = text.match(/(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*[号日]/);
  if (m) {
    const dd = cn2num(m[1]);
    if (dd >= 1 && dd <= 31) {
      const y = cst.getUTCFullYear(), mo = cst.getUTCMonth();   // 0-based
      let cand = new Date(Date.UTC(y, mo, dd));
      if (dd < cst.getUTCDate()) cand = new Date(Date.UTC(y, mo + 1, dd));  // 已过 → 下个月
      return cand.toISOString().slice(0, 10);
    }
  }
  return null;
}

const stats = { total: 0, noKw: 0, ad: 0, noLoc: 0, noTime: 0, dup: 0, ok: 0 };
const out = [];
const seen = new Set();

function handle(raw, source, sourceId, postedAt) {
  stats.total++;
  const key = source + ":" + sourceId;
  if (seen.has(key)) { stats.dup++; return; }
  seen.add(key);

  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) { stats.noKw++; return; }

  if (!TRIP_KW.test(text)) { stats.noKw++; return; }
  if (AD_KW.test(text) || NOTRIP_KW.test(text)) { stats.ad++; return; }

  // 地点库扫描（只认已知地点，不做宽松兜底）
  const locs = [];
  for (const f of scanLocations(" " + text + " ")) {
    if (!locs.includes(f.loc)) locs.push(f.loc);
  }
  if (!locs.length) { stats.noLoc++; return; }

  const d = matchDate(text);
  const tm = matchTime(text);
  let date = parseDateFrom(text, postedAt);
  if (!date) date = d.date;
  if (!date && tm) date = postedAt ? new Date(new Date(postedAt).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10) : "";
  if (!date && !tm) { stats.noTime++; return; }

  // 命中：目的地取最后一个地点（"到 X" 通常在后面），起点取第一个
  const to = locs[locs.length - 1];
  const from = locs.length >= 2 ? locs[0] : "";

  stats.ok++;
  out.push({
    source, sourceId,
    from, to,
    date,
    time: (tm && tm.time) || "",
    raw: text,
    postedAt: postedAt || new Date().toISOString()
  });
}

// 树洞：createTime "YYYY-MM-DD HH:mm:ss"
function sdPostedAt(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(" ", "T") + "+08:00");
  return isNaN(d.getTime()) ? null : d.toISOString();
}
// 狐友：score 毫秒时间戳
function hyPostedAt(ms) {
  if (!ms || typeof ms !== "number") return null;
  return new Date(ms).toISOString();
}

for (const x of readJSON(SD_PATH)) handle(x.detail || x.title, "云上校友圈", String(x.id), sdPostedAt(x.createTime));
for (const x of readJSON(HY_PATH)) handle(x.content, "狐友", String(x.feedId), hyPostedAt(x.score));

// 按出发时间排序
out.sort((a, b) => String(a.date + a.time).localeCompare(String(b.date + b.time)));
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 1), "utf8");

console.log(`扫描 ${stats.total} 条`);
console.log(`  无拼车意图词 ${stats.noKw}`);
console.log(`  广告/捞人类   ${stats.ad}`);
console.log(`  无已知地点   ${stats.noLoc}`);
console.log(`  无时间信息   ${stats.noTime}`);
console.log(`  重复         ${stats.dup}`);
console.log(`  ✅ 命中      ${stats.ok}`);
console.log(`\n输出 → ${OUT_PATH}\n`);
console.log("命中明细：");
out.forEach((t) => {
  console.log(`  [${t.source}] ${t.date} ${t.time || "--:--"} | ${t.from || "?"} → ${t.to} | ${t.raw.slice(0, 50)}`);
});

process.exit(0);
