/* 用法：node tools/parse-test.js —— 抽取 qqbot.js 自然语言解析区跑回归用例（改动解析层必跑） */
/* 解析层单元测试：从 qqbot.js 抽取「自然语言解析」区，跑别名/自定义/原有用例 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "qqbot.js"), "utf8");
const start = src.indexOf("// ===== 自然语言解析 =====");
const end = src.indexOf("// ===== 会话");
const region = src.slice(start, end);
const factory = new Function(
  "axios", "INTERNAL", "log", "require", "__dirname",
  "const DAY_MS = 86400000;" + region + "; return { parsePublish, parseQuery, scanLocations, parseCustomRoute };"
);
const M = factory(null, { base: "", key: "" }, () => {}, require, path.join(__dirname, ".."));

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + "  got: " + JSON.stringify(got)); }
};

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // CST 日期近似

// —— 别名归一（用户指定的四组）——
let p = M.parsePublish("今天下午11点 万达到地铁站");
ok("万达/地铁站→标准名", p && p.from === "乐多港万达" && p.to === "昌平西山口", p);
p = M.parsePublish("明天下午四点 北京化工大学到北京南站");
ok("北京化工大学→北化北区", p && p.from === "北化北区" && p.to === "北京南站", p);
p = M.parsePublish("明天上午十点 昌平高铁站到北化东区");
ok("昌平高铁站→昌平北站", p && p.from === "昌平北站" && p.to === "北化东区", p);
p = M.parsePublish("明天上午十点 西山口到乐多港万达");
ok("西山口→昌平西山口", p && p.from === "昌平西山口", p);
p = M.parsePublish("明天早上七点 北化到西站");
ok("北化→北化北区 / 西站→北京西站", p && p.from === "北化北区" && p.to === "北京西站", p);

// —— 自定义地点兜底 ——
p = M.parsePublish("明天下午三点 从燕丹村到乐多港万达");
ok("自定义+库 混合", p && p.from === "燕丹村" && p.to === "乐多港万达", p);
p = M.parsePublish("明天下午三点 沙河地铁站到回龙观");
ok("自定义词不被别名拆走", p && p.from === "沙河地铁站" && p.to === "回龙观", p); // 「地铁站」前接「沙河」→ 判为自定义复合词
p = M.parsePublish("明天下午三点 今天心情很好");
ok("无路线→明确报错", p && !!p.error, p);
p = M.parsePublish("明天下午三点 3点到5点都行 从学校到南站");
ok("时间范围不误伤", p && p.from === "北化北区" && p.to === "北京南站", p);

// —— 原有用例防回归 ——
p = M.parsePublish("明天下午四点 北化北区到北京南站");
ok("基础发布", p && p.from === "北化北区" && p.to === "北京南站" && p.time === "16:00", p);
p = M.parsePublish("下午三点 北化北区到万达");
ok("缺日期仍报错", p && p.error && p.error.includes("日期"), p);

// —— 查询 ——
let q = M.parseQuery("有没有周日早上去机场的车");
ok("机场=两机场 toList", q.toList && q.toList.length === 2 && q.date === "2026-09-20", q);
q = M.parseQuery("查 明天 万达");
ok("查询命中别名", q.anyList && q.anyList[0] === "乐多港万达", q);
q = M.parseQuery("查 从地铁站到南站");
ok("查询两侧别名", q.fromList[0] === "昌平西山口" && q.toList[0] === "北京南站", q);
q = M.parseQuery("查 回龙观到昌平北站");
ok("查询1命中→anyList超集", q.anyList && q.anyList[0] === "昌平北站", q);
q = M.parseQuery("查 回龙观到西二旗");
ok("查询纯自定义成对", q.fromList[0] === "回龙观" && q.toList[0] === "西二旗", q);
p = M.parsePublish("明天下午三点 回龙观有没有到昌平北站的");
ok("发布疑问词剥离", p && p.from === "回龙观" && p.to === "昌平北站", p);

// —— 最长匹配重叠 ——
const hits = M.scanLocations("北京化工大学昌平校区到乐多港万达");
ok("最长优先无重复命中", hits.length === 2 && hits[0].loc === "北化北区" && hits[1].loc === "乐多港万达", hits);

// —— mtime 热重载（临时目录隔离，不碰真实文件）——
const os = require("os");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bhtx-loc-"));
fs.mkdirSync(path.join(tmp, "public"));
const tmpFile = path.join(tmp, "public", "locations.json");
const data = { locations: ["北化北区", "昌平西山口"], aliases: { "西山口": "昌平西山口" }, kwGroups: {} };
fs.writeFileSync(tmpFile, JSON.stringify(data));
const M2 = factory(null, { base: "", key: "" }, () => {}, require, tmp);
let r2 = M2.parsePublish("明天下午三点 北化到西山口");
ok("热重载·首读（北化还不是别名）", r2 && r2.from === "北化" && r2.to === "昌平西山口", r2);
data.locations.push("乐多港万达");
data.aliases["北化"] = "乐多港万达";
fs.writeFileSync(tmpFile, JSON.stringify(data));
r2 = M2.parsePublish("明天下午三点 北化到西山口");
ok("热重载·改文件即生效", r2 && r2.from === "乐多港万达" && r2.to === "昌平西山口", r2);
fs.writeFileSync(tmpFile, "{ broken json");
r2 = M2.parsePublish("明天下午三点 北化到西山口");
ok("坏文件沿用上一版", r2 && r2.from === "乐多港万达", r2);
fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n===== PARSE UNIT " + pass + "/" + (pass + fail) + " =====");
process.exit(fail ? 1 : 0);
